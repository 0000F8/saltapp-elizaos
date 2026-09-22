/**
 * End-to-end coverage of SaltService's actual connect() (through the real
 * Action Cable transport in socket.ts, not just its pieces in isolation).
 * Replaces the old poll-cycle test after the 2026-09-22 transport swap
 * (owner rule: "DO NOT USE POLLING as a mechanic EVER" -- salt-agent-sdk
 * 0.10.0 dropped the short-poll constants this service used to pace
 * itself with). A fake WebSocket implementation (see socket.test.ts for
 * the same fake) stands in for `ws`, so this proves connect() actually
 * holds a live socket -- subscribes, receives a replayed envelope,
 * persists the advanced cursor -- with no HTTP polling anywhere.
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

type Listener = (...args: unknown[]) => void;

/** Stands in for `ws`'s WebSocket -- see socket.test.ts for the fuller
 *  version of this fake with more server-side helpers. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  listeners = new Map<string, Listener[]>();
  sent: string[] = [];

  constructor(url: string, _opts: unknown) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  terminate(): void {
    this.emit("close");
  }
  close(): void {
    this.emit("close");
  }
  serverOpen(): void {
    this.emit("open");
  }
  serverSend(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
}

function subscribeIdentifier(sent: string[]): { after?: number } | undefined {
  const cmd = sent.map((s) => JSON.parse(s)).find((f) => f.command === "subscribe");
  if (!cmd) return undefined;
  return JSON.parse(cmd.identifier);
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SaltService.connect (Action Cable end to end)", () => {
  it("holds a live socket instead of polling: whoAmI + delivery-mode are the only HTTP calls connect() makes", async () => {
    FakeWebSocket.instances = [];
    const { runtime, fake } = createFakeRuntime();
    fake.getSetting.mockImplementation((key: string) => settingsFor()[key]);

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/agents/webhook_secret") {
        return jsonResponse({ agent_id: "agent-1", webhook_secret: "test-secret" });
      }
      if (u.pathname === "/api/v1/agents/delivery") {
        return jsonResponse({ agent_id: "agent-1", delivery_mode: "socket", socket_mode: true });
      }
      throw new Error(`unexpected HTTP request to ${url} -- an idle, caught-up socket connection never polls or backfills`);
    }) as unknown as typeof fetch;

    const service = new SaltService(runtime, {
      fetchImpl,
      cursorStore: MemoryCursorStore(),
      dedupeStore: MemoryDedupeStore(),
      webSocketImpl: FakeWebSocket as never,
    });
    await service.connect();
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe("wss://saltapp.test/cable");
    ws.serverOpen();
    await flush();
    ws.serverSend({ message: { type: "replay_done", cursor: 0, more: false } });
    await flush();

    await service.stop();

    // Exactly the two one-time setup calls -- no /api/v1/agent/updates poll.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("subscribes with the persisted cursor, dispatches a replayed envelope exactly once through routeEnvelope, and persists the advanced cursor", async () => {
    FakeWebSocket.instances = [];
    const { runtime, fake } = createFakeRuntime();
    fake.getSetting.mockImplementation((key: string) => settingsFor()[key]);

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/agents/webhook_secret") return jsonResponse({ agent_id: "agent-1", webhook_secret: "test-secret" });
      if (u.pathname === "/api/v1/agents/delivery") return jsonResponse({ agent_id: "agent-1" });
      throw new Error(`unexpected HTTP request to ${url}`);
    }) as unknown as typeof fetch;

    const cursorStore = MemoryCursorStore();
    const service = new SaltService(runtime, {
      fetchImpl,
      cursorStore,
      dedupeStore: MemoryDedupeStore(),
      webSocketImpl: FakeWebSocket as never,
    });
    const routeSpy = vi.spyOn(service, "routeEnvelope");
    await service.connect();
    await flush();

    const ws = FakeWebSocket.instances[0]!;
    ws.serverOpen();
    await flush();
    ws.serverSend({
      message: { id: 9, delivery_id: "d9", event: "chat_opened", headers: {}, body: "{}", created_at: "2026-09-22T00:00:00Z" },
    });
    ws.serverSend({ message: { type: "replay_done", cursor: 9, more: false } });
    await flush();

    expect(routeSpy).toHaveBeenCalledTimes(1);
    expect(routeSpy.mock.calls[0]![0]).toMatchObject({ id: 9, event: "chat_opened" });
    expect(await cursorStore.get("agent-1")).toBe(9);

    await service.stop();

    // A second connection (simulating a restart with the same persisted
    // cursor) must resubscribe from 9, not replay from scratch.
    FakeWebSocket.instances = [];
    const service2 = new SaltService(runtime, {
      fetchImpl,
      cursorStore,
      dedupeStore: MemoryDedupeStore(),
      webSocketImpl: FakeWebSocket as never,
    });
    await service2.connect();
    await flush();
    const ws2 = FakeWebSocket.instances[0]!;
    ws2.serverOpen();
    await flush();
    expect(subscribeIdentifier(ws2.sent)?.after).toBe(9);
    await service2.stop();
  });
});
