import { generateKeypair, decrypt, encryptFor } from "salt-agent-sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SaltService } from "../service";
import type { SaltPluginConfig } from "../types";
import { createFakeRuntime } from "./testUtils";

let agentKeys: Awaited<ReturnType<typeof generateKeypair>>;
let humanKeys: Awaited<ReturnType<typeof generateKeypair>>;

beforeAll(async () => {
  agentKeys = await generateKeypair("agent-passphrase");
  humanKeys = await generateKeypair("human-passphrase");
});

function baseConfig(overrides: Partial<SaltPluginConfig> = {}): SaltPluginConfig {
  return {
    host: "https://saltapp.test",
    appId: "agent-1",
    apiKey: "test-api-key",
    publicKey: agentKeys.publicKey,
    privateKey: agentKeys.privateKey,
    passphrase: "agent-passphrase",
    mode: "socket",
    webhookPort: 5100,
    pollTimeoutSeconds: 25,
    pollLimit: 50,
    verifySignatures: true,
    autoReply: true,
    askHumanTimeoutSeconds: 5,
    stateDir: "/tmp/saltapp-elizaos-test-state",
    subscriptionKeywords: [],
    ...overrides,
  };
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getChatMembers: vi.fn().mockResolvedValue([
      { id: "agent-1", username: "bot", display_name: "Bot", account_type: "Agent", public_key: agentKeys.publicKey },
      { id: "user-1", username: "ada", display_name: "Ada", account_type: "User", public_key: humanKeys.publicKey },
    ]),
    postMessage: vi.fn().mockResolvedValue({}),
    postPlainMessage: vi.fn().mockResolvedValue({}),
    setChatSubscription: vi.fn().mockResolvedValue({}),
    whoAmI: vi.fn().mockResolvedValue({ agent_id: "agent-1", webhook_secret: "test-secret" }),
    ...overrides,
  };
}

async function encryptedMessageBody(text: string, opts: { messageId?: number; senderId?: string; chatId?: string } = {}): Promise<string> {
  const ciphertext = await encryptFor(text, [agentKeys.publicKey]);
  return JSON.stringify({
    chat: { id: opts.chatId ?? "chat-1", name: null },
    message: {
      chat_id: opts.chatId ?? "chat-1",
      message: ciphertext,
      message_id: opts.messageId ?? 1,
      version: 1,
      user: { id: opts.senderId ?? "user-1", username: "ada", display_name: "Ada", account_type: "User" },
      created_at: "2026-09-18T00:00:00Z",
    },
  });
}

describe("SaltService.handleMessageEnvelope", () => {
  it("decrypts the message and drives ensureConnection + messageService.handleMessage with the plaintext", async () => {
    const { runtime, fake } = createFakeRuntime();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig();
    service.client = fakeClient() as never;

    const body = await encryptedMessageBody("hello from Ada");
    await service.handleMessageEnvelope(body);

    expect(fake.ensureConnection).toHaveBeenCalledTimes(1);
    expect(fake.messageService?.handleMessage).toHaveBeenCalledTimes(1);
    const [, coreMessage] = fake.messageService!.handleMessage.mock.calls[0]!;
    expect(coreMessage.content.text).toBe("hello from Ada");
  });

  it("encrypts the agent's reply for the real chat members and posts it", async () => {
    const { runtime, fake } = createFakeRuntime();
    const client = fakeClient();
    fake.messageService!.handleMessage.mockImplementation(async (_rt, _msg, callback) => {
      await callback({ text: "hi Ada!" });
      return { didRespond: true, responseMessages: [] };
    });
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig();
    service.client = client as never;

    await service.handleMessageEnvelope(await encryptedMessageBody("hello from Ada"));

    expect(client.postMessage).toHaveBeenCalledTimes(1);
    const [, chatId, message, senderMessage] = client.postMessage.mock.calls[0]!;
    expect(chatId).toBe("chat-1");
    const decryptedForHuman = await decrypt(message, humanKeys.privateKey, "human-passphrase");
    expect(decryptedForHuman).toBe("hi Ada!");
    const decryptedForSelf = await decrypt(senderMessage, agentKeys.privateKey, "agent-passphrase");
    expect(decryptedForSelf).toBe("hi Ada!");
  });

  it("stores the memory but never calls messageService when SALT_AUTO_REPLY is off", async () => {
    const { runtime, fake } = createFakeRuntime();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig({ autoReply: false });
    service.client = fakeClient() as never;

    await service.handleMessageEnvelope(await encryptedMessageBody("quiet please"));

    expect(fake.createMemory).toHaveBeenCalledTimes(1);
    expect(fake.emitEvent).toHaveBeenCalledTimes(1);
    expect(fake.messageService?.handleMessage).not.toHaveBeenCalled();
  });

  it("ignores a message from its own identity", async () => {
    const { runtime, fake } = createFakeRuntime();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig();
    service.client = fakeClient() as never;

    await service.handleMessageEnvelope(await encryptedMessageBody("echo", { senderId: "agent-1" }));

    expect(fake.ensureConnection).not.toHaveBeenCalled();
  });
});

describe("SaltService.routeEnvelope signature gating", () => {
  it("rejects an envelope with a bad signature before it reaches handleMessageEnvelope", async () => {
    const { runtime, fake } = createFakeRuntime();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig({ verifySignatures: true });
    service.client = fakeClient() as never;
    service.webhookSecret = "the-real-secret";

    const body = await encryptedMessageBody("should never decrypt");
    await service.routeEnvelope({
      id: 1,
      delivery_id: "d1",
      event: "message",
      headers: { "X-Salt-Signature": "t=1,v1=deadbeef" },
      body,
      created_at: "2026-09-18T00:00:00Z",
    });

    expect(fake.ensureConnection).not.toHaveBeenCalled();
  });

  it("accepts and routes an envelope with a valid signature", async () => {
    const { createHmac } = await import("node:crypto");
    const { runtime, fake } = createFakeRuntime();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig({ verifySignatures: true });
    service.client = fakeClient() as never;
    service.webhookSecret = "the-real-secret";

    const body = await encryptedMessageBody("should decrypt fine");
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", "the-real-secret").update(`${t}.${body}`).digest("hex");
    await service.routeEnvelope({
      id: 2,
      delivery_id: "d2",
      event: "message",
      headers: { "X-Salt-Signature": `t=${t},v1=${v1}` },
      body,
      created_at: "2026-09-18T00:00:00Z",
    });

    expect(fake.ensureConnection).toHaveBeenCalledTimes(1);
  });
});

describe("SaltService.routeEnvelope delivery-id dedupe", () => {
  it("dispatches an envelope only once even if routeEnvelope is called twice with the same delivery_id", async () => {
    const { runtime, fake } = createFakeRuntime();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig({ verifySignatures: false });
    service.client = fakeClient() as never;

    const body = await encryptedMessageBody("hello once");
    const envelope = { id: 1, delivery_id: "dup-1", event: "message", headers: {}, body, created_at: "2026-09-18T00:00:00Z" };

    await service.routeEnvelope(envelope);
    await service.routeEnvelope(envelope); // a redelivered/retried row -- Salt's own guarantee, not an edge case

    expect(fake.ensureConnection).toHaveBeenCalledTimes(1);
  });

  it("shares the dedupe set across a simulated restart when the SAME persistent store is reused", async () => {
    const { FileDedupeStore } = await import("salt-agent-sdk");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "saltapp-elizaos-dedupe-"));
    try {
      const store = FileDedupeStore(dir);
      const body = await encryptedMessageBody("hello across restarts");
      const envelope = { id: 1, delivery_id: "restart-dup", event: "message", headers: {}, body, created_at: "2026-09-18T00:00:00Z" };

      const { runtime: r1, fake: f1 } = createFakeRuntime();
      const s1 = new SaltService(r1, { dedupeStore: store });
      s1.saltConfig = baseConfig({ verifySignatures: false });
      s1.client = fakeClient() as never;
      await s1.routeEnvelope(envelope);
      expect(f1.ensureConnection).toHaveBeenCalledTimes(1);

      // A fresh process/service instance ("restart"), same on-disk store.
      const { runtime: r2, fake: f2 } = createFakeRuntime();
      const s2 = new SaltService(r2, { dedupeStore: store });
      s2.saltConfig = baseConfig({ verifySignatures: false });
      s2.client = fakeClient() as never;
      await s2.routeEnvelope(envelope);
      expect(f2.ensureConnection).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SaltService cursor persistence", () => {
  it("survives a simulated restart via a shared FileCursorStore instead of replaying from 0", async () => {
    const { FileCursorStore } = await import("salt-agent-sdk");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "saltapp-elizaos-cursor-"));
    try {
      const store = FileCursorStore(dir);
      await store.put("agent-1", 77);

      const restored = await store.get("agent-1");
      expect(restored).toBe(77);

      // A fresh store instance pointed at the same directory ("restart")
      // reads back the same cursor rather than starting from 0.
      const storeAfterRestart = FileCursorStore(dir);
      expect(await storeAfterRestart.get("agent-1")).toBe(77);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SaltService card interactions", () => {
  it("resolves a pending SALT_ASK_HUMAN wait when the matching card_interaction arrives", async () => {
    const { runtime } = createFakeRuntime();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig();
    service.client = fakeClient() as never;

    const waitPromise = service.waitForCardTap("card-1", 5);
    await service.handleCardInteractionEnvelope(
      JSON.stringify({
        type: "card_interaction",
        card_id: "card-1",
        owner_id: "agent-1",
        chat_id: "chat-1",
        action_id: "approve",
        value: "approve",
        state: {},
        user: { id: "user-1", username: "ada", display_name: "Ada", account_type: "User" },
      })
    );

    const result = await waitPromise;
    expect(result).toEqual({ actionId: "approve", value: "approve", userDisplayName: "Ada", userId: "user-1" });
  });

  it("records an unwaited tap as a memory instead of dropping it", async () => {
    const { runtime, fake } = createFakeRuntime();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig();
    service.client = fakeClient() as never;

    await service.handleCardInteractionEnvelope(
      JSON.stringify({
        type: "card_interaction",
        card_id: "card-unwaited",
        owner_id: "agent-1",
        chat_id: "chat-1",
        action_id: "no_thanks",
        value: "no_thanks",
        state: {},
        user: { id: "user-1", username: "ada", display_name: "Ada", account_type: "User" },
      })
    );

    expect(fake.createMemory).toHaveBeenCalledTimes(1);
  });
});

function plainMessageBody(text: string, opts: { messageId?: number; senderId?: string; chatId?: string; deliveredBecause?: string; chatEncrypted?: boolean } = {}): string {
  return JSON.stringify({
    chat: { id: opts.chatId ?? "chat-1", name: null, encrypted: opts.chatEncrypted ?? false },
    message: {
      chat_id: opts.chatId ?? "chat-1",
      message: text,
      encrypted: false,
      ...(opts.deliveredBecause ? { delivered_because: opts.deliveredBecause } : {}),
      message_id: opts.messageId ?? 1,
      version: 1,
      user: { id: opts.senderId ?? "user-1", username: "ada", display_name: "Ada", account_type: "User" },
      created_at: "2026-09-18T00:00:00Z",
    },
  });
}

describe("SaltService.handleMessageEnvelope open rooms", () => {
  it("passes an open-room message straight through with no decrypt, and marks the memory unencrypted", async () => {
    const { runtime, fake } = createFakeRuntime();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig();
    service.client = fakeClient() as never;

    await service.handleMessageEnvelope(plainMessageBody("hello from the open room"));

    expect(fake.ensureConnection).toHaveBeenCalledTimes(1);
    const [, coreMessage] = fake.messageService!.handleMessage.mock.calls[0]!;
    expect(coreMessage.content.text).toBe("hello from the open room");
    expect(coreMessage.content.encrypted).toBe(false);
  });

  it("threads delivered_because onto the memory content when salt-api sends it", async () => {
    const { runtime, fake } = createFakeRuntime();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig();
    service.client = fakeClient() as never;

    await service.handleMessageEnvelope(plainMessageBody("bot, what's the weather", { deliveredBecause: "keyword" }));

    const [, coreMessage] = fake.messageService!.handleMessage.mock.calls[0]!;
    expect(coreMessage.content.deliveredBecause).toBe("keyword");
  });

  it("marks an ordinary encrypted-chat memory's content.encrypted true (no delivered_because)", async () => {
    const { runtime, fake } = createFakeRuntime();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig();
    service.client = fakeClient() as never;

    await service.handleMessageEnvelope(await encryptedMessageBody("hello from Ada"));

    const [, coreMessage] = fake.messageService!.handleMessage.mock.calls[0]!;
    expect(coreMessage.content.encrypted).toBe(true);
    expect(coreMessage.content.deliveredBecause).toBeUndefined();
  });

  it("posts a reply into an open room via client.postPlainMessage, never PGP-encrypted", async () => {
    const { runtime, fake } = createFakeRuntime();
    const client = fakeClient({ postPlainMessage: vi.fn().mockResolvedValue({}) });
    fake.messageService!.handleMessage.mockImplementation(async (_rt, _msg, callback) => {
      await callback({ text: "the weather here is sunny" });
      return { didRespond: true, responseMessages: [] };
    });
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig();
    service.client = client as never;

    await service.handleMessageEnvelope(plainMessageBody("bot, what's the weather"));

    expect(client.postPlainMessage).toHaveBeenCalledTimes(1);
    expect(client.postPlainMessage).toHaveBeenCalledWith("test-api-key", "chat-1", "the weather here is sunny");
    expect(client.postMessage).not.toHaveBeenCalled();
  });

  it("ignores a plaintext message addressed (by X-Salt-Agent-Id) to a different identity", async () => {
    const { runtime, fake } = createFakeRuntime();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig();
    service.client = fakeClient() as never;

    await service.handleMessageEnvelope(plainMessageBody("not for me"), "some-other-agent-id");

    expect(fake.ensureConnection).not.toHaveBeenCalled();
  });
});

describe("SaltService interests (open-room subscription)", () => {
  function chatOpenedBody(opts: { chatEncrypted: boolean }): string {
    return JSON.stringify({
      type: "chat_opened",
      chat: { id: "chat-open-1", name: null, encrypted: opts.chatEncrypted },
      opened_by: { id: "user-1", username: "ada", display_name: "Ada", account_type: "User" },
      members: [
        { id: "agent-1", username: "bot", display_name: "Bot", account_type: "Agent", public_key: "pub" },
        { id: "user-1", username: "ada", display_name: "Ada", account_type: "User", public_key: "pub2" },
      ],
      opened_at: "2026-09-22T00:00:00Z",
    });
  }

  it("calls setChatSubscription when this identity is added to an open room and a non-default mode is configured", async () => {
    const { runtime } = createFakeRuntime();
    const client = fakeClient({ setChatSubscription: vi.fn().mockResolvedValue({}) });
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig({ subscriptionMode: "keywords", subscriptionKeywords: ["weather", "price"] });
    service.client = client as never;

    await service.handleChatOpenedEnvelope(chatOpenedBody({ chatEncrypted: false }));

    expect(client.setChatSubscription).toHaveBeenCalledWith("test-api-key", "chat-open-1", {
      mode: "keywords",
      keywords: ["weather", "price"],
    });
  });

  it("never calls setChatSubscription for an ordinary encrypted chat", async () => {
    const { runtime } = createFakeRuntime();
    const client = fakeClient({ setChatSubscription: vi.fn().mockResolvedValue({}) });
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig({ subscriptionMode: "keywords", subscriptionKeywords: ["weather"] });
    service.client = client as never;

    await service.handleChatOpenedEnvelope(chatOpenedBody({ chatEncrypted: true }));

    expect(client.setChatSubscription).not.toHaveBeenCalled();
  });

  it("never calls setChatSubscription when no subscriptionMode is configured (the default)", async () => {
    const { runtime } = createFakeRuntime();
    const client = fakeClient({ setChatSubscription: vi.fn().mockResolvedValue({}) });
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig();
    service.client = client as never;

    await service.handleChatOpenedEnvelope(chatOpenedBody({ chatEncrypted: false }));

    expect(client.setChatSubscription).not.toHaveBeenCalled();
  });
});
