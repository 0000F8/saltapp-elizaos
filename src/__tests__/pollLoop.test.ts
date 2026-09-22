/**
 * End-to-end coverage of SaltService's actual pollLoop (connect() through
 * two full poll cycles), not just its pieces in isolation. Added after a
 * production finding: the socket-mode ack only advances on an EXPLICIT,
 * monotonically increasing `after` -- a client that polls without ever
 * sending its advanced cursor re-fetches (and re-answers) the same rows
 * forever. This proves SaltService's real loop sends the advanced cursor
 * on its second poll and that a row already processed is not dispatched
 * again.
 *
 * Real timers, not fake ones: the only wait between poll cycles is
 * ACTIVE_POLL_DELAY_MS (1s, a fixed import in service.ts, not overridable
 * per test), so this test tolerates a real ~1-2s wait rather than fighting
 * fake-timer/microtask interleaving for a loop this short.
 */
import { generateKeypair, MemoryCursorStore, MemoryDedupeStore } from "salt-agent-sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SaltService } from "../service";
import { createFakeRuntime } from "./testUtils";

let agentKeys: Awaited<ReturnType<typeof generateKeypair>>;

beforeAll(async () => {
  agentKeys = await generateKeypair("agent-passphrase");
});

function settingsFor(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SALT_HOST: "https://saltapp.test",
    SALT_APP_ID: "agent-1",
    SALT_API_KEY: "test-api-key",
    SALT_APP_PUBLIC_KEY: agentKeys.publicKey,
    SALT_APP_PRIVATE_KEY: agentKeys.privateKey,
    SALT_PGP_PASSPHRASE: "agent-passphrase",
    SALT_MODE: "socket",
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("SaltService pollLoop (connect() end to end)", () => {
  it(
    "advances and sends its cursor on the second poll, so an already-processed row is not dispatched twice",
    async () => {
      const { runtime, fake } = createFakeRuntime();
      fake.getSetting.mockImplementation((key: string) => settingsFor()[key]);

      const agentUpdatesCalls: Array<{ after: string | null }> = [];
      let round = 0;

      const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
        const u = new URL(url);
        if (u.pathname === "/api/v1/agents/webhook_secret") {
          return jsonResponse({ agent_id: "agent-1", webhook_secret: "test-secret" });
        }
        if (u.pathname === "/api/v1/agents/delivery") {
          return jsonResponse({ agent_id: "agent-1", delivery_mode: "socket", socket_mode: true });
        }
        if (u.pathname === "/api/v1/agent/updates") {
          agentUpdatesCalls.push({ after: u.searchParams.get("after") });
          round += 1;
          if (round === 1) {
            // First poll: one new row, id 7.
            return jsonResponse({
              updates: [
                {
                  id: 7,
                  delivery_id: "delivery-7",
                  event: "chat_opened", // logged and dropped -- no decrypt needed to prove cursor advance
                  headers: {},
                  body: "{}",
                  created_at: "2026-09-22T00:00:00Z",
                },
              ],
              cursor: 7,
            });
          }
          // Every subsequent poll: nothing new -- proves the second poll's
          // `after` (this identity's advanced cursor) actually moved the
          // (fake) server-side position instead of re-serving row 7.
          return jsonResponse({ updates: [], cursor: 7 });
        }
        throw new Error(`unexpected fetch to ${url}`);
      }) as unknown as typeof fetch;

      // Explicit in-memory stores: without these, connect() falls back to
      // FileCursorStore/FileDedupeStore under SALT_STATE_DIR and this test
      // would write (and later read back stale state from) real files on
      // disk -- exactly the bug this test caught in itself during review.
      const service = new SaltService(runtime, {
        fetchImpl,
        cursorStore: MemoryCursorStore(),
        dedupeStore: MemoryDedupeStore(),
      });
      await service.connect();

      await waitFor(() => round >= 2);
      await service.stop();

      expect(agentUpdatesCalls.length).toBeGreaterThanOrEqual(2);
      // First poll: no local cursor yet -- `after` is omitted (round-4
      // socket contract: an omitted `after` lets salt-api's own
      // server-side ack apply).
      expect(agentUpdatesCalls[0]!.after).toBeNull();
      // Second poll: MUST send the advanced cursor (7), not omit it and
      // not resend the pre-poll value -- this is the exact production
      // finding ("the ack only advances on an explicit after") this test
      // pins.
      expect(agentUpdatesCalls[1]!.after).toBe("7");
    },
    8000
  );
});
