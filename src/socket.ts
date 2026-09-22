/**
 * The real transport for socket mode: a persistent Action Cable websocket
 * to salt-api's `AgentUpdatesChannel`, replacing the old adaptive short-poll
 * of `GET /api/v1/agent/updates` (owner rule, 2026-09-22: "DO NOT USE
 * POLLING as a mechanic EVER" -- salt-agent-sdk 0.10.0 dropped
 * `ACTIVE_POLL_DELAY_MS`/`IDLE_POLL_DELAY_MS` and ships its own
 * `createSocketClient` built on this exact wire protocol, see that
 * package's socket.ts header comment for the canonical description).
 *
 * This module deliberately does NOT reuse salt-agent-sdk's
 * `createSocketClient`: that client wraps `createDispatcher` end to end --
 * signature verification, PGP decrypt/open-room detection, and dispatch --
 * and hands a consumer only the fully-resolved `MessageContext`/
 * `CardInteractionContext`/`ChatOpenedContext` shapes. SaltService needs the
 * exact same envelope shape its already-tested routeEnvelope/
 * dispatchEnvelope/handleMessageEnvelope pipeline already consumes (an
 * `SaltUpdateEnvelope` with the raw `headers`/`body`), both so that pipeline
 * (and its test coverage) didn't need to be rewritten around a different
 * context shape, and so a field salt-api adds to the raw JSON body ahead of
 * the SDK's own typed `MessageContext` (this launch's `delivered_because`,
 * for one -- absent from salt-agent-sdk 0.10.0's `MessageContext` as of this
 * writing) is still visible to `parseMessageEventBody` here instead of being
 * silently dropped by a dispatcher that doesn't know about it yet.
 *
 * WIRE PROTOCOL: identical to salt-agent-sdk's socket.ts header comment --
 * connect to `wss://<host>/cable` with the identity's own api-key on the
 * handshake header, subscribe to `AgentUpdatesChannel` with `after: cursor`
 * (omitted when there is no local cursor yet), receive a replay of the
 * backlog followed by `{message: {type: "replay_done", cursor, more?}}`,
 * then live envelope frames in the same `{message: {id, delivery_id,
 * event, headers, body, created_at}}` shape a poll row used to arrive in.
 * `{type: "ping"}` arrives roughly every 3s; 30s of silence means the
 * connection is dead. `{type: "disconnect"}` just precedes an ordinary
 * `close` event -- always reconnect.
 *
 * SIMPLIFICATION vs salt-agent-sdk's own implementation: when
 * `replay_done.more` is true (the backlog exceeded AgentUpdatesChannel's
 * own replay cap), this client pages `GET /api/v1/agent/updates` to finish
 * the backfill INLINE, as part of the same ordered frame-handling chain --
 * a live frame that arrives mid-backfill simply waits its turn in that
 * chain rather than being buffered and drained separately the way
 * salt-agent-sdk's own client does. That costs a little latency on the
 * rare connection that needs backfill at all; it does not cost correctness
 * (frames are still handled in id order, and DedupeStore makes any overlap
 * between a backfilled row and a live frame harmless either way) -- and a
 * plugin's own socket-mode identity, unlike a shared multi-tenant host, is
 * not latency-sensitive enough to justify carrying that extra machinery
 * twice, independently maintained, in a repo that isn't the SDK itself.
 */

import { RECONNECT_MAX_DELAY_MS, RECONNECT_MIN_DELAY_MS, PING_TIMEOUT_MS, type CursorStore } from "salt-agent-sdk";
import { WebSocket as WS, type RawData } from "ws";
import { fetchAgentUpdates } from "./rest";
import type { SaltUpdateEnvelope } from "./types";

export interface SaltSocketLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

export interface SaltSocketOptions {
  host: string;
  apiKey: string;
  agentId: string;
  cursorStore: CursorStore;
  /** Called once per envelope, in order, for every replay/backfill/live
   *  frame -- the same shape SaltService.routeEnvelope already accepts. */
  onEnvelope: (envelope: SaltUpdateEnvelope) => Promise<void>;
  fetchImpl?: typeof fetch;
  webSocketImpl?: typeof WS;
  /** Rows per backfill page (only used when replay_done.more is true). */
  backfillLimit?: number;
  pingTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  logger?: SaltSocketLogger;
}

export interface SaltSocket {
  start(): void;
  stop(): Promise<void>;
}

const consoleLogger: SaltSocketLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
  debug: (m) => console.debug(m),
};

interface ReplayDoneFrame {
  type: "replay_done";
  cursor?: number;
  more?: boolean;
}

function jitter(ms: number): number {
  return Math.round(ms / 2 + Math.random() * (ms / 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drains this identity's socket-mode outbox by holding an Action Cable
 * connection open and pushing every arriving envelope through
 * `onEnvelope`. No `setInterval`/sleep-poll anywhere in this file -- the
 * only timers are the ping watchdog (detects a half-open connection) and
 * the reconnect backoff (the wait between one dropped connection and the
 * next attempt, never a wait between requests on a live one).
 */
export function createSaltUpdatesSocket(options: SaltSocketOptions): SaltSocket {
  const logger = options.logger ?? consoleLogger;
  const host = options.host.replace(/\/$/, "");
  const wsHost = host.replace(/^http/, "ws");
  const fetchImpl = options.fetchImpl ?? fetch;
  const WSImpl = options.webSocketImpl ?? WS;
  const { cursorStore, agentId, apiKey, onEnvelope } = options;
  const backfillLimit = options.backfillLimit ?? 100;
  const pingTimeoutMs = options.pingTimeoutMs ?? PING_TIMEOUT_MS;
  const minBackoffMs = options.minBackoffMs ?? RECONNECT_MIN_DELAY_MS;
  const maxBackoffMs = options.maxBackoffMs ?? RECONNECT_MAX_DELAY_MS;

  let stopped = true;
  let loopPromise: Promise<void> | null = null;
  let currentSocket: WS | null = null;

  async function persistCursor(cursor: number): Promise<void> {
    try {
      await cursorStore.put(agentId, cursor);
    } catch (err) {
      logger.error(`[salt-socket ${agentId}] persisting cursor ${cursor} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Pages GET /api/v1/agent/updates from `cursor` until a page comes back
   *  empty -- only reached when replay_done.more says the backlog exceeded
   *  the channel's own replay cap. */
  async function backfillFrom(cursor: number): Promise<void> {
    let after = cursor;
    for (;;) {
      if (stopped) return;
      let res: Awaited<ReturnType<typeof fetchAgentUpdates>>;
      try {
        res = await fetchAgentUpdates(fetchImpl, host, apiKey, { after, timeout: 0, limit: backfillLimit });
      } catch (err) {
        logger.error(`[salt-socket ${agentId}] backfill request failed: ${err instanceof Error ? err.message : String(err)}`);
        return; // the next reconnect's replay will pick this back up
      }
      for (const row of res.updates) {
        await onEnvelope(row as unknown as SaltUpdateEnvelope).catch((err) => {
          logger.error(`[salt-socket ${agentId}] envelope ${row.id} (${row.event}) failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      after = typeof res.cursor === "number" ? res.cursor : Number(res.cursor) || after;
      await persistCursor(after);
      if (res.updates.length === 0) return; // caught up
    }
  }

  function runConnection(): Promise<{ subscribed: boolean }> {
    return new Promise((resolveConn) => {
      (async () => {
        let localCursor = 0;
        try {
          localCursor = await cursorStore.get(agentId);
        } catch (err) {
          logger.error(`[salt-socket ${agentId}] loading cursor failed, starting from 0: ${err instanceof Error ? err.message : String(err)}`);
        }

        let settled = false;
        let subscribed = false;
        let pingTimer: ReturnType<typeof setTimeout> | null = null;
        // Every frame is handled strictly in arrival order: each 'message'
        // event only appends to this chain, never awaits work directly, so
        // a slow handler (e.g. inline backfill) can't let a later frame
        // jump ahead of an earlier one.
        let queue: Promise<void> = Promise.resolve();

        function clearPingTimer(): void {
          if (pingTimer) {
            clearTimeout(pingTimer);
            pingTimer = null;
          }
        }
        function armPingWatchdog(): void {
          clearPingTimer();
          pingTimer = setTimeout(() => {
            logger.error(`[salt-socket ${agentId}] no ping for ${pingTimeoutMs}ms; treating the connection as dead`);
            try {
              socket.terminate();
            } catch {
              // already gone
            }
          }, pingTimeoutMs);
        }

        function finish(): void {
          if (settled) return;
          settled = true;
          clearPingTimer();
          currentSocket = null;
          queue.finally(() => resolveConn({ subscribed }));
        }

        const socket = new WSImpl(`${wsHost}/cable`, { headers: { "api-key": apiKey } });
        currentSocket = socket;

        async function handleEnvelopeRow(row: SaltUpdateEnvelope): Promise<void> {
          await onEnvelope(row).catch((err) => {
            logger.error(`[salt-socket ${agentId}] envelope ${row.id} (${row.event}) failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }

        async function handleReplayDone(frame: ReplayDoneFrame): Promise<void> {
          const serverCursor = typeof frame.cursor === "number" ? frame.cursor : localCursor;
          await persistCursor(serverCursor);
          if (frame.more) {
            await backfillFrom(serverCursor);
          }
        }

        async function handleFrame(raw: RawData): Promise<void> {
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(raw.toString());
          } catch (err) {
            logger.error(`[salt-socket ${agentId}] unparseable frame: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }

          const type = frame.type as string | undefined;
          if (type === "ping" || type === "welcome") {
            armPingWatchdog();
            return;
          }
          if (type === "confirm_subscription") {
            subscribed = true;
            logger.info(`[salt-socket ${agentId}] subscribed (cursor ${localCursor})`);
            return;
          }
          if (type === "reject_subscription") {
            logger.error(`[salt-socket ${agentId}] subscription rejected; reconnecting`);
            try {
              socket.close();
            } catch {
              // already gone
            }
            return;
          }
          if (type === "disconnect") {
            logger.info(`[salt-socket ${agentId}] server requested disconnect${frame.reason ? ` (${frame.reason})` : ""}`);
            return; // the 'close' event that follows drives reconnect
          }

          const payload = frame.message as Record<string, unknown> | undefined;
          if (!payload || typeof payload !== "object") return;
          if (payload.type === "replay_done") {
            await handleReplayDone(payload as unknown as ReplayDoneFrame);
            return;
          }
          if (typeof payload.id !== "number") return;
          await handleEnvelopeRow(payload as unknown as SaltUpdateEnvelope);
        }

        socket.on("open", () => {
          const identifier =
            localCursor > 0
              ? JSON.stringify({ channel: "AgentUpdatesChannel", after: localCursor })
              : JSON.stringify({ channel: "AgentUpdatesChannel" });
          socket.send(JSON.stringify({ command: "subscribe", identifier }));
        });

        socket.on("message", (raw: RawData) => {
          queue = queue.then(() => handleFrame(raw)).catch((err) => {
            logger.error(`[salt-socket ${agentId}] error handling frame: ${err instanceof Error ? err.message : String(err)}`);
          });
        });

        socket.on("close", () => finish());
        socket.on("error", (err: Error) => {
          logger.error(`[salt-socket ${agentId}] websocket error: ${err.message}`);
          // 'close' normally follows in the ws library; finish() runs there.
        });
      })();
    });
  }

  async function loop(): Promise<void> {
    let backoff = minBackoffMs;
    logger.info(`[salt-socket ${agentId}] connecting to ${wsHost}/cable`);
    while (!stopped) {
      let outcome: { subscribed: boolean };
      try {
        outcome = await runConnection();
      } catch (err) {
        logger.error(`[salt-socket ${agentId}] connection failed: ${err instanceof Error ? err.message : String(err)}`);
        outcome = { subscribed: false };
      }
      if (stopped) break;
      if (outcome.subscribed) backoff = minBackoffMs; // a clean connection resets the failure backoff
      const waitMs = jitter(backoff);
      logger.error(`[salt-socket ${agentId}] reconnecting in ${waitMs}ms`);
      await sleep(waitMs);
      backoff = Math.min(backoff * 2, maxBackoffMs);
    }
  }

  return {
    start() {
      if (loopPromise) return;
      stopped = false;
      loopPromise = loop().catch((err) => logger.error(`[salt-socket ${agentId}] loop exited unexpectedly: ${err instanceof Error ? err.message : String(err)}`));
    },
    async stop() {
      stopped = true;
      if (currentSocket) {
        try {
          currentSocket.terminate();
        } catch {
          // already gone
        }
      }
      await loopPromise;
      loopPromise = null;
    },
  };
}
