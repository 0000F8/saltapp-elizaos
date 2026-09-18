/**
 * The Salt connector service. Long-polls GET /api/v1/agent/updates (LANES.md's
 * socket-mode contract, K2) so this agent needs no public URL; verifies each
 * envelope's HMAC, PGP-decrypts message bodies, and drives the same
 * connector pattern plugin-matrix/plugin-discord use: ensureConnection, a
 * core Memory, and runtime.messageService.handleMessage with a
 * HandlerCallback that encrypts the reply for every current chat member and
 * posts it back. See README.md's "Custody" section: this process holds the
 * agent's PGP private key and can read everything it decrypts.
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
import { createSaltClient, decrypt, encryptFor, type SaltClient, type SaltUser } from "salt-agent-sdk";
import { loadSaltPluginConfig, validateSaltPluginConfig } from "./config";
import {
  isGroupChat,
  looksLikePgpMessage,
  parseCardInteractionEventBody,
  parseChatOpenedEventBody,
  parseMessageEventBody,
} from "./mapping";
import { fetchAgentUpdates, setDeliveryMode } from "./rest";
import { verifyEnvelopeSignature } from "./signature";
import type {
  PendingCardWait,
  SaltCardTapResult,
  SaltChatContextEntry,
  SaltPluginConfig,
  SaltUpdateEnvelope,
} from "./types";

export const SALT_SOURCE = "salt";

/** How long a signature-verification/decrypt failure or a transient poll
 *  error backs off before the next poll attempt. */
const ERROR_BACKOFF_MS = 3000;

export interface SaltServiceDeps {
  fetchImpl?: typeof fetch;
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
  private cursor: number | string = 0;
  private pollAbort: AbortController | undefined;
  private loopPromise: Promise<void> | undefined;
  /** Public so action handlers (rest.ts helpers) reuse the same injected fetch in tests. */
  readonly fetchImpl: typeof fetch;

  /** roomId (elizaOS UUID) -> chat context, read by SALT_CHAT_CONTEXT and the money actions. */
  readonly chatContext = new Map<UUID, SaltChatContextEntry>();
  /** cardId -> a SALT_ASK_HUMAN call waiting on exactly one tap. */
  readonly cardWaiters = new Map<string, PendingCardWait>();

  constructor(runtime?: IAgentRuntime, deps: SaltServiceDeps = {}) {
    super(runtime);
    this.fetchImpl = deps.fetchImpl ?? fetch;
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
      this.running = true;
      this.loopPromise = this.pollLoop();
    } else {
      throw new Error(
        "plugin-saltapp: SALT_MODE=webhook is not implemented by this Service (it only runs the socket long-poll loop). Run salt-agent-sdk's createWebhookServer alongside this plugin instead, or set SALT_MODE=socket."
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();
    for (const waiter of this.cardWaiters.values()) clearTimeout(waiter.timer);
    this.cardWaiters.clear();
    if (this.loopPromise) await this.loopPromise.catch(() => undefined);
  }

  // --- the long-poll loop ---------------------------------------------

  private async pollLoop(): Promise<void> {
    while (this.running) {
      this.pollAbort = new AbortController();
      try {
        const res = await fetchAgentUpdates(this.fetchImpl, this.saltConfig.host, this.saltConfig.apiKey, {
          after: this.cursor,
          timeout: this.saltConfig.pollTimeoutSeconds,
          limit: this.saltConfig.pollLimit,
          signal: this.pollAbort.signal,
        });
        for (const envelope of res.updates) {
          await this.routeEnvelope(envelope).catch((err) => {
            logger.error(`plugin-saltapp: envelope ${envelope.id} (${envelope.event}) failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        this.cursor = res.cursor;
      } catch (err) {
        if (!this.running) return;
        logger.warn(`plugin-saltapp: poll failed, retrying: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  }

  /** Verifies the envelope's signature, then dispatches by event name. Public for tests. */
  async routeEnvelope(envelope: SaltUpdateEnvelope): Promise<void> {
    if (this.saltConfig.verifySignatures) {
      const check = verifyEnvelopeSignature({ headers: envelope.headers, body: envelope.body, secret: this.webhookSecret ?? "" });
      if (!check.ok) {
        logger.warn(`plugin-saltapp: rejected envelope ${envelope.id} (${envelope.event}): ${check.reason}`);
        return;
      }
    }
    switch (envelope.event) {
      case "message":
        return this.handleMessageEnvelope(envelope.body);
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

  /** Public for tests: parses, decrypts, and dispatches one "message" envelope body. */
  async handleMessageEnvelope(rawBody: string): Promise<void> {
    const body = parseMessageEventBody(rawBody);
    const { chat, message } = body;

    // Never re-ingest this identity's own reply (Salt posts a sender_message
    // copy encrypted to the sender's own key too, but the sender field still
    // names this agent) or a system/event row (calls, tombstones, etc).
    if (String(message.user.id) === String(this.saltConfig.appId)) return;
    if (message.event_type) return;

    const ciphertext = message.message;
    if (!looksLikePgpMessage(ciphertext)) {
      logger.debug(`plugin-saltapp: message ${message.message_id} has no decryptable ciphertext for this identity; skipping`);
      return;
    }
    const text = await decrypt(ciphertext, this.saltConfig.privateKey, this.saltConfig.passphrase);

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
      await this.sendChatMessage(saltChatId, replyText);
      const outbound: Memory = {
        id: createUniqueUuid(this.runtime, `${saltChatId}:reply:${Date.now()}`),
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId,
        content: { text: replyText, source: SALT_SOURCE, channelType, inReplyTo: coreMessage.id },
        createdAt: Date.now(),
      };
      await this.runtime.createMemory(outbound, "messages").catch((err) => logger.warn(`plugin-saltapp: persist outbound memory failed: ${err instanceof Error ? err.message : String(err)}`));
      return [outbound];
    };

    await this.runtime.messageService.handleMessage(this.runtime, coreMessage, callback);
  }

  /** Encrypts `text` for every current member (and this identity's own copy) and posts it. */
  async sendChatMessage(saltChatId: string, text: string): Promise<void> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
