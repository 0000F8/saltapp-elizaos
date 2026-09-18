/**
 * SALT_REQUEST_PAYMENT: drop a plain payment request bubble into the current
 * Salt chat (transfer_requests_controller#create with no `request_type`,
 * distinct from SALT_SEND_INVOICE's itemized rail). The request receives
 * INTO one of this agent's own active wallets -- Salt requires naming one
 * (see rest.ts's resolveWallet, same by-ticker rule a card's own "pay"
 * button uses).
 */

import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { createPaymentRequest, resolveReceiver, resolveWallet, type SaltWallet } from "../rest";
import { extractActionParams } from "./extract";
import { loadChatMembers, resolveSaltRoom } from "./shared";

export const saltRequestPaymentAction: Action = {
  name: "SALT_REQUEST_PAYMENT",
  similes: ["REQUEST_MONEY", "ASK_FOR_PAYMENT", "SALT_REQUEST_MONEY", "BILL_SOMEONE"],
  description:
    "Request a payment from someone in the current Salt chat: posts a real payment-request bubble with an amount, currency, and note. Use when asked to request, bill, or ask for money -- not for an itemized invoice (use SALT_SEND_INVOICE for that).",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    return (await resolveSaltRoom(runtime, message)) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const room = await resolveSaltRoom(runtime, message);
    if (!room) {
      return { text: "This isn't a Salt chat.", success: false };
    }

    const params = await extractActionParams(
      runtime,
      message,
      state,
      "Read the message and pull out the payment request being asked for.",
      [
        { name: "amount", instructions: "the human-decimal amount to request, digits only, e.g. 25 or 12.50" },
        { name: "currency", instructions: "the wallet ticker to receive into if named, e.g. ETH, USDC, BTC -- else empty" },
        { name: "receiver", instructions: "the @handle or name of who to request from, if named -- else empty" },
        { name: "note", instructions: "a short note for the request, e.g. what it's for -- else empty" },
      ]
    );

    if (!params.amount || Number.isNaN(Number(params.amount))) {
      const text = "I need a specific amount to request -- how much, and in what currency?";
      await callback?.({ text, actions: ["SALT_REQUEST_PAYMENT"] });
      return { text, success: false };
    }

    const members = await loadChatMembers(room);
    const receiver = resolveReceiver(members, room.service.saltConfig.appId, params.receiver);
    if (!receiver) {
      const text = params.receiver
        ? `I couldn't find "${params.receiver}" in this chat.`
        : "This chat has more than one other person -- who should I request the payment from?";
      await callback?.({ text, actions: ["SALT_REQUEST_PAYMENT"] });
      return { text, success: false };
    }

    const wallets = (await room.service.client.listWallets(room.service.saltConfig.apiKey)) as SaltWallet[];
    const wallet = resolveWallet(wallets, params.currency);
    if (!wallet) {
      const text = params.currency
        ? `I don't have a ${params.currency} wallet to receive that into.`
        : "I don't have an active wallet set up to receive a payment yet.";
      await callback?.({ text, actions: ["SALT_REQUEST_PAYMENT"] });
      return { text, success: false };
    }

    await createPaymentRequest(room.service.fetchImpl, room.service.saltConfig.host, room.service.saltConfig.apiKey, {
      chatId: room.saltChatId,
      receiverId: String(receiver.id),
      walletId: wallet.id,
      amount: params.amount,
      message: params.note,
    });

    const currencyLabel = wallet.name_3 ? `${wallet.name_3} ` : "";
    const text = `Requested ${params.amount} ${currencyLabel}from @${receiver.username}${params.note ? ` for "${params.note}"` : ""}.`;
    await callback?.({ text, actions: ["SALT_REQUEST_PAYMENT"] });
    return { text, success: true, data: { chatId: room.saltChatId, receiverId: receiver.id, amount: params.amount, walletId: wallet.id } };
  },

  examples: [
    [
      { name: "{{userName}}", content: { text: "can you ask them for 20 USDC for the tickets" } },
      { name: "{{agentName}}", content: { text: "Requested 20 USDC from @them for \"tickets\".", actions: ["SALT_REQUEST_PAYMENT"] } },
    ],
  ],
};
