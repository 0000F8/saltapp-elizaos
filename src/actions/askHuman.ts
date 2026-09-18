/**
 * SALT_ASK_HUMAN: posts a choices card like SALT_POST_CARD, then blocks this
 * turn on the matching `card_interaction` event (service.ts's
 * waitForCardTap/handleCardInteractionEnvelope) up to
 * SALT_ASK_HUMAN_TIMEOUT_SECONDS. This is the one action in this plugin that
 * deliberately holds the turn open -- see README.md's note on why that's
 * safe here (one card, one resolver, a bounded timeout) and not a general
 * pattern for every action.
 */

import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { extractActionParams } from "./extract";
import { buildChoiceCardBlocks, splitChoices } from "./postCard";
import { resolveSaltRoom } from "./shared";

interface PostCardResponse {
  resource_id?: string;
  resource?: { id?: string };
}

export const saltAskHumanAction: Action = {
  name: "SALT_ASK_HUMAN",
  similes: ["WAIT_FOR_HUMAN", "SALT_ASK_AND_WAIT", "GET_HUMAN_CHOICE"],
  description:
    "Post a card with choices into the current Salt chat and WAIT for someone to tap one before continuing. Use only when the agent genuinely cannot proceed without the answer -- otherwise use SALT_POST_CARD, which does not block.",

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
      "Read the message and pull out the question and the choices to wait for an answer to.",
      [
        { name: "text", instructions: "the question to ask" },
        { name: "choices", instructions: "the choices, separated by a pipe character |, e.g. Approve|Reject" },
      ]
    );

    const choices = splitChoices(params.choices);
    if (!params.text || choices.length === 0) {
      const text = "I need a question and at least one choice to ask and wait.";
      await callback?.({ text, actions: ["SALT_ASK_HUMAN"] });
      return { text, success: false };
    }

    const blocks = buildChoiceCardBlocks(params.text, choices);
    const response = (await room.service.client.postCard(room.service.saltConfig.apiKey, room.saltChatId, blocks, params.text)) as PostCardResponse;
    const cardId = response.resource_id ?? response.resource?.id;
    if (!cardId) {
      const text = "I posted the card but couldn't tell which one it was, so I can't wait on it.";
      await callback?.({ text, actions: ["SALT_ASK_HUMAN"] });
      return { text, success: false };
    }

    const tap = await room.service.waitForCardTap(cardId, room.service.saltConfig.askHumanTimeoutSeconds);
    if (!tap) {
      const text = `Nobody has tapped "${params.text}" yet.`;
      await callback?.({ text, actions: ["SALT_ASK_HUMAN"] });
      return { text, success: false, data: { chatId: room.saltChatId, cardId, timedOut: true } };
    }

    const text = `${tap.userDisplayName} chose "${tap.actionId}"${tap.value && tap.value !== tap.actionId ? ` (${tap.value})` : ""}.`;
    await callback?.({ text, actions: ["SALT_ASK_HUMAN"] });
    return { text, success: true, data: { chatId: room.saltChatId, cardId, choice: tap.actionId, value: tap.value, userId: tap.userId } };
  },

  examples: [
    [
      { name: "{{userName}}", content: { text: "check with them whether to ship it, then tell me" } },
      { name: "{{agentName}}", content: { text: 'Ada chose "ship_it".', actions: ["SALT_ASK_HUMAN"] } },
    ],
  ],
};
