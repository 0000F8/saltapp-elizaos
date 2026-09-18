/**
 * SALT_SEND_INVOICE: posts an itemized invoice on the TransferRequest rail
 * (salt-agent-sdk's client.createInvoice, request_type: "invoice"). This
 * first cut extracts a single line item per call -- a real multi-line-item
 * invoice from one free-text message is a reasonable follow-up (see
 * HANDOFF.md) but needs a richer extraction shape than the flat
 * `<response>` key-value XML every other action uses.
 */

import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { resolveReceiver, resolveWallet, type SaltWallet } from "../rest";
import { extractActionParams } from "./extract";
import { multiplyDecimalByInt } from "../money";
import { loadChatMembers, resolveSaltRoom } from "./shared";

export const saltSendInvoiceAction: Action = {
  name: "SALT_SEND_INVOICE",
  similes: ["SEND_BILL", "INVOICE_SOMEONE", "SALT_CREATE_INVOICE"],
  description:
    "Send an itemized invoice to someone in the current Salt chat: one line item (name, quantity, unit price), rendered as an Invoice bubble with a due date. Use for a billed item, not a bare amount (use SALT_REQUEST_PAYMENT for that).",

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
    if (!room) return { text: "This isn't a Salt chat.", success: false };

    const params = await extractActionParams(
      runtime,
      message,
      state,
      "Read the message and pull out the single item being invoiced.",
      [
        { name: "item", instructions: "the name of what's being billed, <=120 chars" },
        { name: "qty", instructions: "quantity, a whole number -- default to 1 if not said" },
        { name: "unit_price", instructions: "price per unit, a human-decimal number, e.g. 19.99" },
        { name: "currency", instructions: "the wallet ticker to receive into if named, e.g. USDC -- else empty" },
        { name: "receiver", instructions: "the @handle or name to bill, if named -- else empty" },
        { name: "due", instructions: "an ISO-8601 due date if one was named -- else empty" },
      ]
    );

    const qty = params.qty ? Number.parseInt(params.qty, 10) : 1;
    if (!params.item || !params.unit_price || Number.isNaN(Number(params.unit_price)) || Number.isNaN(qty) || qty < 1) {
      const text = "I need an item name, a quantity, and a unit price to send an invoice.";
      await callback?.({ text, actions: ["SALT_SEND_INVOICE"] });
      return { text, success: false };
    }

    const members = await loadChatMembers(room);
    const receiver = resolveReceiver(members, room.service.saltConfig.appId, params.receiver);
    if (!receiver) {
      const text = params.receiver ? `I couldn't find "${params.receiver}" in this chat.` : "Who should this invoice go to?";
      await callback?.({ text, actions: ["SALT_SEND_INVOICE"] });
      return { text, success: false };
    }

    const wallets = (await room.service.client.listWallets(room.service.saltConfig.apiKey)) as SaltWallet[];
    const wallet = resolveWallet(wallets, params.currency);
    if (!wallet) {
      const text = params.currency ? `I don't have a ${params.currency} wallet to receive that into.` : "I don't have an active wallet set up to receive a payment yet.";
      await callback?.({ text, actions: ["SALT_SEND_INVOICE"] });
      return { text, success: false };
    }

    const subtotal = multiplyDecimalByInt(params.unit_price, qty);
    await room.service.client.createInvoice(room.service.saltConfig.apiKey, {
      chatId: room.saltChatId,
      receiverId: String(receiver.id),
      walletId: wallet.id,
      amount: subtotal,
      lineItems: [{ name: params.item, qty, unit_price: params.unit_price, subtotal }],
      message: params.item,
      dueAt: params.due,
    });

    const text = `Sent an invoice to @${receiver.username}: ${qty} x ${params.item} @ ${params.unit_price} = ${subtotal}${wallet.name_3 ? ` ${wallet.name_3}` : ""}.`;
    await callback?.({ text, actions: ["SALT_SEND_INVOICE"] });
    return { text, success: true, data: { chatId: room.saltChatId, receiverId: receiver.id, amount: subtotal, walletId: wallet.id } };
  },

  examples: [
    [
      { name: "{{userName}}", content: { text: "invoice them for 2 tickets at 15 each" } },
      { name: "{{agentName}}", content: { text: "Sent an invoice to @them: 2 x tickets @ 15 = 30.", actions: ["SALT_SEND_INVOICE"] } },
    ],
  ],
};
