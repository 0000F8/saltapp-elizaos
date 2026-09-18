/**
 * SALT_POST_CARD: posts a declarative blocks card (CARD_PROTOCOL_SPEC.md)
 * with the message text as a section and each choice as a button. A tap
 * comes back to this identity as a `card_interaction` webhook/socket event
 * (service.ts's handleCardInteractionEnvelope) -- this action does not wait
 * for one (see SALT_ASK_HUMAN for that).
 */

import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import type { CardBlock } from "salt-agent-sdk";
import { extractActionParams } from "./extract";
import { resolveSaltRoom } from "./shared";

/** action_id must be a-z0-9_- and <=40 chars, unique within the card
 *  (CARD_PROTOCOL_SPEC.md's block vocabulary). */
export function slugifyChoice(label: string, index: number, seen: Set<string>): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36) || `choice_${index}`;
  let candidate = base;
  let n = 1;
  while (seen.has(candidate)) {
    candidate = `${base}_${n}`.slice(0, 40);
    n += 1;
  }
  seen.add(candidate);
  return candidate;
}

export function splitChoices(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split("|")
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .slice(0, 5); // CARD_PROTOCOL_SPEC.md: 1-5 buttons per actions block
}

export function buildChoiceCardBlocks(text: string, choices: string[]): CardBlock[] {
  const seen = new Set<string>();
  return [
    { type: "section", text },
    {
      type: "actions",
      elements: choices.map((label, i) => ({ type: "button", action_id: slugifyChoice(label, i, seen), label })),
    },
  ];
}

export const saltPostCardAction: Action = {
  name: "SALT_POST_CARD",
  similes: ["POST_CHOICES", "SALT_SHOW_BUTTONS", "OFFER_CHOICES"],
  description:
    "Post a card with up to 5 buttons into the current Salt chat, e.g. to offer someone a set of choices. The tap does not block this turn -- use SALT_ASK_HUMAN when the agent should wait for the answer.",

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
      "Read the message and pull out the prompt and the choices to offer as buttons.",
      [
        { name: "text", instructions: "the card's own short prompt/question text" },
        { name: "choices", instructions: "the choices, separated by a pipe character |, e.g. Yes|No|Maybe" },
      ]
    );

    const choices = splitChoices(params.choices);
    if (!params.text || choices.length === 0) {
      const text = "I need a short prompt and at least one choice to post a card.";
      await callback?.({ text, actions: ["SALT_POST_CARD"] });
      return { text, success: false };
    }

    const blocks = buildChoiceCardBlocks(params.text, choices);
    await room.service.client.postCard(room.service.saltConfig.apiKey, room.saltChatId, blocks, params.text);

    const text = `Posted a card: "${params.text}" with ${choices.length} choice${choices.length === 1 ? "" : "s"}.`;
    await callback?.({ text, actions: ["SALT_POST_CARD"] });
    return { text, success: true, data: { chatId: room.saltChatId, choices } };
  },

  examples: [
    [
      { name: "{{userName}}", content: { text: "ask them pizza or sushi" } },
      { name: "{{agentName}}", content: { text: 'Posted a card: "pizza or sushi" with 2 choices.', actions: ["SALT_POST_CARD"] } },
    ],
  ],
};
