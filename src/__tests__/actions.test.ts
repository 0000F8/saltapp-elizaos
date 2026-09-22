import { describe, expect, it, vi } from "vitest";
import { saltAskHumanAction } from "../actions/askHuman";
import { saltPostCardAction } from "../actions/postCard";
import { saltRequestPaymentAction } from "../actions/requestPayment";
import { saltSendInvoiceAction } from "../actions/sendInvoice";
import { SaltService } from "../service";
import type { SaltPluginConfig } from "../types";
import { createFakeRuntime } from "./testUtils";

function baseConfig(overrides: Partial<SaltPluginConfig> = {}): SaltPluginConfig {
  return {
    host: "https://saltapp.test",
    appId: "agent-1",
    apiKey: "test-api-key",
    publicKey: "pub",
    privateKey: "priv",
    passphrase: "pw",
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

/** A Salt chat with exactly one other (human) member -- the common 1:1 case. */
function oneOnOneMembers() {
  return [
    { id: "agent-1", username: "bot", display_name: "Bot", account_type: "Agent", public_key: "agent-pub" },
    { id: "user-1", username: "ada", display_name: "Ada", account_type: "User", public_key: "ada-pub" },
  ];
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getChatMembers: vi.fn().mockResolvedValue(oneOnOneMembers()),
    listWallets: vi.fn().mockResolvedValue([{ id: "wallet-1", chain: "ethereum", name_3: "USDC", deleted_at: null }]),
    createInvoice: vi.fn().mockResolvedValue({}),
    postCard: vi.fn().mockResolvedValue({ resource_id: "card-1" }),
    updateCard: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

/** Wires a fake runtime whose getRoom/getService resolve to a Salt room backed by `service`. */
function wireSaltRoom(service: SaltService, fake: ReturnType<typeof createFakeRuntime>["fake"]) {
  fake.getService.mockReturnValue(service);
  fake.getRoom.mockResolvedValue({ id: "room-1", source: "salt", channelId: "chat-1", type: "DM" });
}

function xmlResponse(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join("");
  return `<response>${body}</response>`;
}

describe("SALT_REQUEST_PAYMENT", () => {
  it("validate() is false outside a Salt room", async () => {
    const { runtime, fake } = createFakeRuntime();
    fake.getRoom.mockResolvedValue(null);
    const ok = await saltRequestPaymentAction.validate(runtime, { roomId: "r1", content: {} } as never, undefined as never);
    expect(ok).toBe(false);
  });

  it("posts a plain payment request to the sole other chat member using a mocked REST client", async () => {
    const { runtime, fake } = createFakeRuntime();
    fake.useModel.mockResolvedValue(xmlResponse({ amount: "25", currency: "USDC", receiver: "", note: "dinner" }));
    const client = fakeClient();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "req-1" }) });
    const service = new SaltService(runtime, { fetchImpl: fetchMock as unknown as typeof fetch });
    service.saltConfig = baseConfig();
    service.client = client as never;
    wireSaltRoom(service, fake);

    const callback = vi.fn();
    const result = await saltRequestPaymentAction.handler(
      runtime,
      { roomId: "room-1", content: { text: "ask ada for 25 usdc for dinner" } } as never,
      undefined as never,
      undefined,
      callback
    );

    expect(result!.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/v1/transfer_requests");
    const sentBody = JSON.parse((init as { body: string }).body);
    expect(sentBody).toMatchObject({ chat_id: "chat-1", receiver_id: "user-1", wallet_id: "wallet-1", amount: "25" });
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Requested 25") }));
  });

  it("fails clearly when no amount can be extracted", async () => {
    const { runtime, fake } = createFakeRuntime();
    fake.useModel.mockResolvedValue(xmlResponse({ amount: "", currency: "", receiver: "", note: "" }));
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig();
    service.client = fakeClient() as never;
    wireSaltRoom(service, fake);

    const result = await saltRequestPaymentAction.handler(
      runtime,
      { roomId: "room-1", content: { text: "can you ask them for money" } } as never,
      undefined as never
    );
    expect(result!.success).toBe(false);
  });
});

describe("SALT_SEND_INVOICE", () => {
  it("computes the subtotal exactly and calls client.createInvoice", async () => {
    const { runtime, fake } = createFakeRuntime();
    fake.useModel.mockResolvedValue(xmlResponse({ item: "tickets", qty: "2", unit_price: "15", currency: "USDC", receiver: "", due: "" }));
    const client = fakeClient();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig();
    service.client = client as never;
    wireSaltRoom(service, fake);

    const result = await saltSendInvoiceAction.handler(
      runtime,
      { roomId: "room-1", content: { text: "invoice ada for 2 tickets at 15 each" } } as never,
      undefined as never
    );

    expect(result!.success).toBe(true);
    expect(client.createInvoice).toHaveBeenCalledTimes(1);
    const [, params] = client.createInvoice.mock.calls[0]!;
    expect(params.amount).toBe("30");
    expect(params.lineItems).toEqual([{ name: "tickets", qty: 2, unit_price: "15", subtotal: "30" }]);
  });
});

describe("SALT_POST_CARD", () => {
  it("posts a card with one button per choice", async () => {
    const { runtime, fake } = createFakeRuntime();
    fake.useModel.mockResolvedValue(xmlResponse({ text: "pizza or sushi", choices: "Pizza|Sushi" }));
    const client = fakeClient();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig();
    service.client = client as never;
    wireSaltRoom(service, fake);

    const result = await saltPostCardAction.handler(
      runtime,
      { roomId: "room-1", content: { text: "ask them pizza or sushi" } } as never,
      undefined as never
    );

    expect(result!.success).toBe(true);
    expect(client.postCard).toHaveBeenCalledTimes(1);
    const [, chatId, blocks] = client.postCard.mock.calls[0]!;
    expect(chatId).toBe("chat-1");
    expect(blocks[1]!.elements).toHaveLength(2);
  });
});

describe("SALT_ASK_HUMAN", () => {
  it("resolves with the tapped choice once the matching card_interaction arrives", async () => {
    const { runtime, fake } = createFakeRuntime();
    fake.useModel.mockResolvedValue(xmlResponse({ text: "ship it?", choices: "Approve|Reject" }));
    const client = fakeClient();
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig({ askHumanTimeoutSeconds: 5 });
    service.client = client as never;
    wireSaltRoom(service, fake);

    const handlerPromise = saltAskHumanAction.handler(
      runtime,
      { roomId: "room-1", content: { text: "check with them whether to ship it" } } as never,
      undefined as never
    );

    // Give the handler a tick to post the card and register its wait.
    await new Promise((resolve) => setTimeout(resolve, 10));
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

    const result = await handlerPromise;
    expect(result!.success).toBe(true);
    expect(result!.data).toMatchObject({ choice: "approve" });
  });

  it("times out with a clear result when nobody taps in time", async () => {
    const { runtime, fake } = createFakeRuntime();
    fake.useModel.mockResolvedValue(xmlResponse({ text: "ship it?", choices: "Approve|Reject" }));
    const service = new SaltService(runtime);
    service.saltConfig = baseConfig({ askHumanTimeoutSeconds: 0.05 });
    service.client = fakeClient() as never;
    wireSaltRoom(service, fake);

    const result = await saltAskHumanAction.handler(
      runtime,
      { roomId: "room-1", content: { text: "check with them whether to ship it" } } as never,
      undefined as never
    );

    expect(result!.success).toBe(false);
    expect(result!.data).toMatchObject({ timedOut: true });
  });
});
