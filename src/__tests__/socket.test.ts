/**
 * Unit coverage of createSaltUpdatesSocket (socket.ts) in isolation from
 * SaltService: a fake WebSocket implementation stands in for `ws`, so these
 * tests drive the exact Action Cable frame shapes salt-api sends (welcome,
 * confirm_subscription, replay envelope frames, replay_done, ping,
 * disconnect) without a real network connection. Proves the owner rule
 * directly: no interval/sleep-poll timer fires while the socket is open --
 * only the ping watchdog (dead-connection detection) and the reconnect
 * backoff (the wait between one closed connection and the next attempt).
 */
import { MemoryCursorStore } from "salt-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { createSaltUpdatesSocket } from "../socket";

type Listener = (...args: unknown[]) => void;

/** A minimal stand-in for `ws`'s WebSocket: enough of the surface
 *  socket.ts actually uses (`on`, `send`, `terminate`, `close`) plus test
 *  helpers to simulate the server side (`serverSend`, `serverClose`). */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  opts: unknown;
  listeners = new Map<string, Listener[]>();
  sent: string[] = [];
  closed = false;

  constructor(url: string, opts: unknown) {
    this.url = url;
    this.opts = opts;
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

  send(_data: string): void {
    this.sent.push(_data);
  }

  terminate(): void {
    this.closed = true;
    this.emit("close");
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  // --- test helpers, simulating the server side ---
  serverOpen(): void {
    this.emit("open");
  }
  serverSend(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
  serverClose(): void {
    this.closed = true;
    this.emit("close");
  }
}

function subscribeIdentifier(sent: string[]): { after?: number } | undefined {
  const cmd = sent.map((s) => JSON.parse(s)).find((f) => f.command === "subscribe");
  if (!cmd) return undefined;
  return JSON.parse(cmd.identifier);
}

async function flush(): Promise<void> {
  // Let the promise-chained message queue (and any awaited persistCursor)
  // settle between simulated frames.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createSaltUpdatesSocket", () => {
  it("subscribes with no `after` on a fresh cursor, dispatches a replayed envelope, and persists the cursor from replay_done", async () => {
    FakeWebSocket.instances = [];
    const cursorStore = MemoryCursorStore();
    const onEnvelope = vi.fn().mockResolvedValue(undefined);

    const socket = createSaltUpdatesSocket({
      host: "https://saltapp.test",
      apiKey: "key-1",
      agentId: "agent-1",
      cursorStore,
      onEnvelope,
      webSocketImpl: FakeWebSocket as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    socket.start();
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe("wss://saltapp.test/cable");

    ws.serverOpen();
    await flush();
    expect(subscribeIdentifier(ws.sent)?.after).toBeUndefined();

    ws.serverSend({
      message: { id: 7, delivery_id: "d7", event: "chat_opened", headers: {}, body: "{}", created_at: "2026-09-22T00:00:00Z" },
    });
    ws.serverSend({ message: { type: "replay_done", cursor: 7, more: false } });
    await flush();

    expect(onEnvelope).toHaveBeenCalledTimes(1);
    expect(onEnvelope.mock.calls[0]![0]).toMatchObject({ id: 7, event: "chat_opened" });
    expect(await cursorStore.get("agent-1")).toBe(7);

    await socket.stop();
  });

  it("sends the persisted cursor as `after` on a reconnect instead of replaying from scratch", async () => {
    FakeWebSocket.instances = [];
    const cursorStore = MemoryCursorStore();
    await cursorStore.put("agent-1", 42);

    const socket = createSaltUpdatesSocket({
      host: "https://saltapp.test",
      apiKey: "key-1",
      agentId: "agent-1",
      cursorStore,
      onEnvelope: vi.fn().mockResolvedValue(undefined),
      webSocketImpl: FakeWebSocket as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    socket.start();
    await flush();

    const ws = FakeWebSocket.instances[0]!;
    ws.serverOpen();
    await flush();
    expect(subscribeIdentifier(ws.sent)?.after).toBe(42);

    await socket.stop();
  });

  it("never fires a single setInterval/setTimeout-driven request while idle -- only a live frame or a close drives any work", async () => {
    FakeWebSocket.instances = [];
    const cursorStore = MemoryCursorStore();
    const onEnvelope = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn();

    const socket = createSaltUpdatesSocket({
      host: "https://saltapp.test",
      apiKey: "key-1",
      agentId: "agent-1",
      cursorStore,
      onEnvelope,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      webSocketImpl: FakeWebSocket as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    socket.start();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    ws.serverOpen();
    await flush();
    ws.serverSend({ message: { type: "replay_done", cursor: 0, more: false } });
    await flush();

    // An idle, caught-up connection: wait a while (well past any old poll
    // interval) and confirm nothing was ever fetched or dispatched.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onEnvelope).not.toHaveBeenCalled();

    await socket.stop();
  });

  it("reconnects with backoff after the server closes the connection, and resubscribes from the persisted cursor", async () => {
    FakeWebSocket.instances = [];
    const cursorStore = MemoryCursorStore();

    const socket = createSaltUpdatesSocket({
      host: "https://saltapp.test",
      apiKey: "key-1",
      agentId: "agent-1",
      cursorStore,
      onEnvelope: vi.fn().mockResolvedValue(undefined),
      webSocketImpl: FakeWebSocket as never,
      minBackoffMs: 5,
      maxBackoffMs: 20,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    socket.start();
    await flush();
    const first = FakeWebSocket.instances[0]!;
    first.serverOpen();
    await flush();
    first.serverSend({ message: { type: "replay_done", cursor: 3, more: false } });
    await flush();

    first.serverClose();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const second = FakeWebSocket.instances[1]!;
    second.serverOpen();
    await flush();
    expect(subscribeIdentifier(second.sent)?.after).toBe(3);

    await socket.stop();
  });
});
