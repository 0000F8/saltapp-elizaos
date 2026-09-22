/**
 * The Salt connector service. Holds a live Action Cable websocket to
 * salt-api (socket.ts) so this agent needs no public URL and never polls;
 * verifies each envelope's HMAC, PGP-decrypts message bodies (or passes an
 * open room's plaintext straight through), and drives the same connector
 * pattern plugin-matrix/plugin-discord use: ensureConnection, a core
 * Memory, and runtime.messageService.handleMessage with a HandlerCallback
 * that encrypts the reply for every current chat member (or posts it
 * plain, for an open room) and posts it back. See README.md's "Custody"
 * section: this process holds the agent's PGP private key and can read
 * everything it decrypts.
 */

import {
  ChannelType,
  EventType,
  Service,
  createUniqueUuid,
  logger,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";
import {
  createSaltClient,
  decrypt,
  encryptFor,
  FileCursorStore,
  FileDedupeStore,
  MemoryCursorStore,
  MemoryDedupeStore,
  type CursorStore,
  type DedupeStore,
  type SaltClient,
  type SaltUser,
} from "salt-agent-sdk";
import { loadSaltPluginConfig, validateSaltPluginConfig } from "./config";
import {
  isGroupChat,
  looksLikePgpMessage,
  parseCardInteractionEventBody,
  parseChatOpenedEventBody,
  parseMessageEventBody,
} from "./mapping";
import { setDeliveryMode } from "./rest";
import { verifyEnvelopeSignature } from "./signature";
import { createSaltUpdatesSocket, type SaltSocket } from "./socket";
import type {
  PendingCardWait,
  SaltCardTapResult,
  SaltChatContextEntry,
  SaltPluginConfig,
  SaltUpdateEnvelope,
} from "./types";

export const SALT_SOURCE = "salt";

export interface SaltServiceDeps {
  fetchImpl?: typeof fetch;
  /** Override where the resume cursor persists (default: salt-agent-sdk's
   *  FileCursorStore(saltConfig.stateDir), resolved once connect() knows
   *  the config). Tests pass MemoryCursorStore() to opt out of disk I/O. */
  cursorStore?: CursorStore;
  /** Override where processed delivery ids persist (default:
   *  FileDedupeStore(saltConfig.stateDir)). Same reasoning as cursorStore. */
  dedupeStore?: DedupeStore;
  /** Override the WebSocket implementation socket.ts connects with
   *  (default: `ws`'s own WebSocket). Tests pass a fake to drive Action
   *  Cable frames without a real connection -- see socket.test.ts. */
  webSocketImpl?: Parameters<typeof createSaltUpdatesSocket>[0]["webSocketImpl"];
}

export class SaltService extends Service {
  static serviceType = "salt";
  capabilityDescription =
    "Connects this agent to a Salt (saltapp.ai) account: end-to-end encrypted messages, payment requests, invoices, and interactive cards.";

  saltConfig!: SaltPluginConfig;
  client!: SaltClient;
  /** Not `private`: tests inject this directly rather than driving a full connect(). */
  webhookSecret: string | undefined;
  private running = false;
  /** Persists the resume cursor across restarts/reconnects (salt-agent-sdk's
   *  FileCursorStore, keyed under saltConfig.stateDir) -- see connect().
   *  Not `private`: tests inject MemoryCursorStore() directly. */
  cursorStore: CursorStore = MemoryCursorStore();
  /** Persists processed delivery ids across restarts, same reasoning as
   *  cursorStore -- a lost/never-loaded cursor used to replay up to 7 days
   *  of outbox on every restart and re-answer old messages (see HANDOFF.md). */
  dedupeStore: DedupeStore = MemoryDedupeStore();
  /** The live Action Cable connection (socket.ts) -- not `private`: tests
   *  may want to reach in, and stop() needs it. */
  socket: SaltSocket | undefined;
  /** Public so action handlers (rest.ts helpers) reuse the same injected fetch in tests. */
  readonly fetchImpl: typeof fetch;
  private readonly deps: SaltServiceDeps;

  /** roomId (elizaOS UUID) -> chat context, read by SALT_CHAT_CONTEXT and the money actions. */
  readonly chatContext = new Map<UUID, SaltChatContextEntry>();
  /** cardId -> a SALT_ASK_HUMAN call waiting on exactly one tap. */
  readonly cardWaiters = new Map<string, PendingCardWait>();

  constructor(runtime?: IAgentRuntime, deps: SaltServiceDeps = {}) {
    super(runtime);
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.deps = deps;
    if (deps.cursorStore) this.cursorStore = deps.cursorStore;
    if (deps.dedupeStore) this.dedupeStore = deps.dedupeStore;
  }

  static async start(runtime: IAgentRuntime): Promise<SaltService> {
    const service = new SaltService(runtime);
    await service.connect();
    return service;
  }

  async connect(): Promise<void> {
    this.saltConfig = loadSaltPluginConfig(this.runtime);
    const missing = validateSaltPluginConfig(this.saltConfig);
    if (missing.length > 0) {
      throw new Error(`plugin-saltapp: missing required settings: ${missing.join(", ")}`);
    }
    this.client = createSaltClient({ host: this.saltConfig.host, fetchImpl: this.fetchImpl });

    const who = await this.client.whoAmI(this.saltConfig.apiKey);
    this.webhookSecret = who?.webhook_secret;
    if (this.saltConfig.verifySignatures && !this.webhookSecret) {
      logger.warn("plugin-saltapp: no webhook secret returned by whoAmI; signature verification will reject everything until it is available");
    }

    if (this.saltConfig.mode === "socket") {
      try {
        await setDeliveryMode(this.fetchImpl, this.saltConfig.host, this.saltConfig.apiKey, "socket");
      } catch (err) {
        // error-policy:J6 best-effort: an agent with a blank callback already
        // behaves as socket server-side, and this endpoint may not be
        // deployed yet (this plugin was built against LANES.md's contract).
        logger.warn(`plugin-saltapp: PATCH /api/v1/agents/delivery failed (continuing; a blank callback already defaults to socket mode): ${err instanceof Error ? err.message : String(err)}`);
      }
      // Blocking follow-up fixed here: on restart this used to long-poll
      // from an in-memory cursor of 0 and replay up to 7 days of outbox,
      // re-answering old messages (see HANDOFF.md). File-backed by default
      // so a restart resumes where this identity left off; a caller that
      // passed its own cursorStore/dedupeStore via SaltServiceDeps (tests,
      // or a host with its own persistence convention) keeps that instead.
      this.cursorStore = this.deps.cursorStore ?? FileCursorStore(this.saltConfig.stateDir);
      this.dedupeStore = this.deps.dedupeStore ?? FileDedupeStore(this.saltConfig.stateDir);
      this.running = true;
      // Owner rule (2026-09-22): "DO NOT USE POLLING as a mechanic EVER."
      // This holds a live Action Cable websocket open (socket.ts) and pushes
      // every envelope -- replayed backlog, then live -- through
      // routeEnvelope, the exact same entry point the old poll loop used.
      // No setInterval/sleep loop anywhere in this class any more; socket.ts's
      // own timers are a ping watchdog and reconnect backoff only.
      this.socket = createSaltUpdatesSocket({
        host: this.saltConfig.host,
        apiKey: this.saltConfig.apiKey,
        agentId: this.saltConfig.appId,
        cursorStore: this.cursorStore,
        fetchImpl: this.fetchImpl,
        backfillLimit: this.saltConfig.pollLimit,
        webSocketImpl: this.deps.webSocketImpl,
        onEnvelope: (envelope) => this.routeEnvelope(envelope),
      });
      this.socket.start();
    } else {
      throw new Error(
        "plugin-saltapp: SALT_MODE=webhook is not implemented by this Service (it only runs the socket connection). Run salt-agent-sdk's createWebhookServer alongside this plugin instead, or set SALT_MODE=socket."
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const waiter of this.cardWaiters.values()) clearTimeout(waiter.timer);
    this.cardWaiters.clear();
    if (this.socket) await this.socket.stop().catch(() => undefined);
  }

  /** Verifies the envelope's signature and skips an already-processed
   *  delivery, then dispatches by event name. Public for tests. */
  async routeEnvelope(envelope: SaltUpdateEnvelope): Promise<void> {
    if (this.saltConfig.verifySignatures) {
      const check = verifyEnvelopeSignature({ headers: envelope.headers, body: envelope.body, secret: this.webhookSecret ?? "" });
      if (!check.ok) {
        logger.warn(`plugin-saltapp: rejected envelope ${envelope.id} (${envelope.event}): ${check.reason}`);
        return;
      }
    }
    if (envelope.delivery_id) {
      const alreadySeen = await this.dedupeStore.has(this.saltConfig.appId, envelope.delivery_id).catch((err) => {
        logger.warn(`plugin-saltapp: dedupe lookup for delivery ${envelope.delivery_id} failed: ${err instanceof Error ? err.message : String(err)}`);
        return false; // fail open -- a lookup failure must not block real delivery
      });
      if (alreadySeen) {
        logger.debug(`plugin-saltapp: skipping already-processed delivery ${envelope.delivery_id}`);
        return;
      }
    }
    await this.dispatchEnvelope(envelope);
    if (envelope.delivery_id) {
      await this.dedupeStore.add(this.saltConfig.appId, envelope.delivery_id).catch((err) => {
        logger.warn(`plugin-saltapp: recording dedupe for delivery ${envelope.delivery_id} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  private async dispatchEnvelope(envelope: SaltUpdateEnvelope): Promise<void> {
    switch (envelope.event) {
      case "message":
        return this.handleMessageEnvelope(envelope.body, envelope.headers?.["X-Salt-Agent-Id"]);
      case "card_interaction":
        return this.handleCardInteractionEnvelope(envelope.body);
      case "chat_opened":
        return this.handleChatOpenedEnvelope(envelope.body);
      default:
        // billing / handoff / call / anything future: recorded, not acted on
        // yet -- see HANDOFF.md's "left for a follow-up" list.
        logger.debug(`plugin-saltapp: no handler for event "${envelope.event}" (delivery ${envelope.delivery_id}); ignoring`);
    }
  }

  // --- message events ---------------------------------------------------

  /** Public for tests: parses, decrypts (or passes plaintext straight
   *  through, for an open room), and dispatches one "message" envelope
   *  body. `headerAgentId` is the envelope's own X-Salt-Agent-Id header --
   *  only consulted for an open-room delivery, where there is no
   *  ciphertext to trial-decrypt against, so it's the only way to confirm
   *  this delivery was meant for this identity (see salt-agent-sdk's
   *  webhook.ts handleMessage for the same reasoning). */
  async handleMessageEnvelope(rawBody: string, headerAgentId?: string): Promise<void> {
    const body = parseMessageEventBody(rawBody);
    const { chat, message } = body;

    // Never re-ingest this identity's own reply (Salt posts a sender_message
    // copy encrypted to the sender's own key too, but the sender field still
    // names this agent) or a system/event row (calls, tombstones, etc).
    if (String(message.user.id) === String(this.saltConfig.appId)) return;
    if (message.event_type) return;

    // Open rooms (salt-api 0.8x): a plain chat delivers `encrypted: false`
    // and `message.message` is the text itself, not a PGP blob -- see
    // README.md's "Open rooms" section. There is nothing to trial-decrypt,
    // so the header naming this identity is the only confirmation this
    // delivery was actually addressed here.
    const isPlaintext = message.encrypted === false;
    let text: string;
    if (isPlaintext) {
      if (headerAgentId && String(headerAgentId) !== String(this.saltConfig.appId)) {
        logger.debug(`plugin-saltapp: plaintext message ${message.message_id} addressed to a different identity (${headerAgentId}); ignoring`);
        return;
      }
      text = message.message;
    } else {
      const ciphertext = message.message;
      if (!looksLikePgpMessage(ciphertext)) {
        logger.debug(`plugin-saltapp: message ${message.message_id} has no decryptable ciphertext for this identity; skipping`);
        return;
      }
      text = await decrypt(ciphertext, this.saltConfig.privateKey, this.saltConfig.passphrase);
    }

    const saltChatId = chat.id;
    const entityId = createUniqueUuid(this.runtime, message.user.id);
    const roomId = createUniqueUuid(this.runtime, saltChatId);
    const worldId = createUniqueUuid(this.runtime, saltChatId);

    const cached = this.chatContext.get(roomId);
    const memberCount = cached?.members.length;
    const channelType = isGroupChat(memberCount) ? ChannelType.GROUP : ChannelType.DM;

    await this.runtime.ensureConnection({
      entityId,
      roomId,
      userName: message.user.username,
      name: message.user.display_name,
      source: SALT_SOURCE,
      channelId: saltChatId,
      type: channelType,
      worldId,
      worldName: chat.name ?? undefined,
      userId: message.user.id as UUID,
      metadata: { accountType: message.user.account_type, laneKind: chat.lane_kind ?? null },
    });

    await this.refreshChatContext(roomId, saltChatId);

    const coreMessage: Memory = {
      id: createUniqueUuid(this.runtime, String(message.message_id)),
      entityId,
      agentId: this.runtime.agentId,
      roomId,
      content: {
        text,
        source: SALT_SOURCE,
        channelType,
        // Open rooms (see README.md): `encrypted: false` means this text
        // came straight off the wire with no PGP decrypt attempted.
        // `deliveredBecause` says why an open-room message was delivered
        // to this identity at all ("mention" | "reply" | "keyword" | "all"
        // -- see client.setChatSubscription) when Salt sends it; absent for
        // an ordinary encrypted chat, and absent until salt-api's own
        // open-rooms rollout starts sending it on the wire.
        encrypted: !isPlaintext,
        ...(message.delivered_because ? { deliveredBecause: message.delivered_because } : {}),
        ...(message.reply_to_message_id ? { inReplyTo: createUniqueUuid(this.runtime, String(message.reply_to_message_id)) } : {}),
      },
      createdAt: Date.parse(message.created_at) || Date.now(),
    };

    if (!this.saltConfig.autoReply) {
      await this.runtime.createMemory(coreMessage, "messages").catch((err) => logger.warn(`plugin-saltapp: persist inbound memory failed: ${err instanceof Error ? err.message : String(err)}`));
      await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, { runtime: this.runtime, message: coreMessage, source: SALT_SOURCE });
      return;
    }

    if (!this.runtime.messageService) {
      logger.error("plugin-saltapp: runtime.messageService is unavailable; cannot process inbound message");
      return;
    }

    const callback: HandlerCallback = async (response: Content) => {
      const replyText = typeof response.text === "string" ? response.text.trim() : "";
      if (!replyText) return [];
      await this.sendChatMessage(saltChatId, replyText, isPlaintext);
      const outbound: Memory = {
        id: createUniqueUuid(this.runtime, `${saltChatId}:reply:${Date.now()}`),
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId,
        content: { text: replyText, source: SALT_SOURCE, channelType, encrypted: !isPlaintext, inReplyTo: coreMessage.id },
        createdAt: Date.now(),
      };
      await this.runtime.createMemory(outbound, "messages").catch((err) => logger.warn(`plugin-saltapp: persist outbound memory failed: ${err instanceof Error ? err.message : String(err)}`));
      return [outbound];
    };

    await this.runtime.messageService.handleMessage(this.runtime, coreMessage, callback);
  }

  /**
   * Posts a reply into `saltChatId`. `plaintext` (default false) means this
   * is an open room: `text` rides the wire and is stored as plain text, via
   * `client.postPlainMessage` -- salt-api refuses a PGP-encrypted post
   * against a plain chat and a plaintext post against an encrypted one the
   * same way (see README.md's "Open rooms" section), so this never guesses.
   * Otherwise encrypts `text` for every current member (and this identity's
   * own copy) and posts it.
   */
  async sendChatMessage(saltChatId: string, text: string, plaintext = false): Promise<void> {
    if (plaintext) {
      await this.client.postPlainMessage(this.saltConfig.apiKey, saltChatId, text);
      return;
    }
    const members = await this.client.getChatMembers(this.saltConfig.apiKey, saltChatId);
    const others = members.filter((m) => String(m.id) !== String(this.saltConfig.appId) && !!m.public_key);
    const selfKey = members.find((m) => String(m.id) === String(this.saltConfig.appId))?.public_key ?? this.saltConfig.publicKey;
    const message = others.length > 0 ? await encryptFor(text, others.map((m) => m.public_key as string)) : await encryptFor(text, [selfKey]);
    const senderMessage = await encryptFor(text, [selfKey]);
    await this.client.postMessage(this.saltConfig.apiKey, saltChatId, message, senderMessage);
  }

  // --- card_interaction events -------------------------------------------

  /** Public for tests. */
  async handleCardInteractionEnvelope(rawBody: string): Promise<void> {
    const body = parseCardInteractionEventBody(rawBody);
    const waiter = this.cardWaiters.get(body.card_id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.cardWaiters.delete(body.card_id);
      const result: SaltCardTapResult = {
        actionId: body.action_id,
        value: body.value,
        userDisplayName: body.user.display_name,
        userId: body.user.id,
      };
      waiter.resolve(result);
      return;
    }
    // No SALT_ASK_HUMAN call is waiting on this card -- record the tap as an
    // ordinary memory so it's visible in history, but don't drive a fresh
    // agent turn from it yet. See HANDOFF.md: routing an unwaited tap through
    // the full message loop is a reasonable follow-up, deliberately left out
    // of this first cut to keep card_interaction's contract (one card, one
    // resolution) simple to reason about.
    const roomId = createUniqueUuid(this.runtime, body.chat_id);
    const entityId = createUniqueUuid(this.runtime, body.user.id);
    const memory: Memory = {
      id: createUniqueUuid(this.runtime, `${body.card_id}:${body.action_id}:${Date.now()}`),
      entityId,
      agentId: this.runtime.agentId,
      roomId,
      content: {
        text: `[card tap] ${body.user.display_name} chose "${body.action_id}"${body.value ? ` (${body.value})` : ""} on card ${body.card_id}`,
        source: SALT_SOURCE,
      },
      createdAt: Date.now(),
    };
    await this.runtime.createMemory(memory, "messages").catch((err) => logger.warn(`plugin-saltapp: persist card_interaction memory failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Registers a wait for exactly one tap on `cardId`, resolved by handleCardInteractionEnvelope or the timeout. */
  waitForCardTap(cardId: string, timeoutSeconds: number): Promise<SaltCardTapResult | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.cardWaiters.delete(cardId);
        resolve(null);
      }, timeoutSeconds * 1000);
      this.cardWaiters.set(cardId, { resolve: (r) => resolve(r), timer });
    });
  }

  // --- chat_opened events ------------------------------------------------

  /** Public for tests. */
  async handleChatOpenedEnvelope(rawBody: string): Promise<void> {
    const body = parseChatOpenedEventBody(rawBody);
    const saltChatId = body.chat.id;
    const roomId = createUniqueUuid(this.runtime, saltChatId);
    const worldId = createUniqueUuid(this.runtime, saltChatId);
    const nonObserverMembers = body.members.filter((m) => !m.observer);

    await this.runtime.ensureConnection({
      entityId: createUniqueUuid(this.runtime, body.opened_by.id),
      roomId,
      userName: body.opened_by.display_name,
      name: body.opened_by.display_name,
      source: SALT_SOURCE,
      channelId: saltChatId,
      type: isGroupChat(nonObserverMembers.length) ? ChannelType.GROUP : ChannelType.DM,
      worldId,
      worldName: body.chat.name ?? undefined,
      userId: body.opened_by.id as UUID,
    });

    this.chatContext.set(roomId, {
      saltChatId,
      chatName: body.chat.name,
      isGroup: isGroupChat(nonObserverMembers.length),
      members: body.members.map((m) => ({ id: m.id, username: m.username, displayName: m.display_name, accountType: m.account_type, publicKey: m.public_key })),
      pendingRequests: this.chatContext.get(roomId)?.pendingRequests ?? [],
      updatedAt: Date.now(),
    });

    // Interests (open rooms, salt-api 0.8x): declares what this identity
    // wants delivered from a room it isn't necessarily @mentioned in every
    // time -- "keywords" (follow SALT_SUBSCRIPTION_KEYWORDS) or "all"
    // (every message). Only meaningful for a plain chat (an encrypted chat
    // already gates delivery server-side the same way "addressed" does),
    // and only when this character actually configured a non-default
    // preference -- see config.ts's loadSaltPluginConfig. Applied the
    // moment this identity is added to a room rather than once at service
    // start, since that's the only point this plugin learns a given room
    // exists at all.
    if (this.saltConfig.subscriptionMode && this.saltConfig.subscriptionMode !== "addressed" && body.chat.encrypted === false) {
      try {
        await this.client.setChatSubscription(this.saltConfig.apiKey, saltChatId, {
          mode: this.saltConfig.subscriptionMode,
          keywords: this.saltConfig.subscriptionKeywords,
        });
      } catch (err) {
        logger.warn(`plugin-saltapp: setChatSubscription for ${saltChatId} failed (continuing; this identity keeps its default delivery): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // --- shared chat-context cache -----------------------------------------

  /** Refreshes the cached member list for a chat by asking Salt directly. */
  private async refreshChatContext(roomId: UUID, saltChatId: string): Promise<void> {
    const existing = this.chatContext.get(roomId);
    if (existing && Date.now() - existing.updatedAt < 60_000) return; // 1 min cache
    try {
      const members = await this.client.getChatMembers(this.saltConfig.apiKey, saltChatId);
      this.chatContext.set(roomId, {
        saltChatId,
        chatName: existing?.chatName,
        isGroup: isGroupChat(members.length),
        members: members.map((m: SaltUser) => ({ id: String(m.id), username: m.username, displayName: m.display_name, accountType: m.account_type, publicKey: m.public_key })),
        pendingRequests: existing?.pendingRequests ?? [],
        updatedAt: Date.now(),
      });
    } catch (err) {
      logger.warn(`plugin-saltapp: could not refresh chat members for ${saltChatId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
