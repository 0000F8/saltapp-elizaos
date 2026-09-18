/**
 * Shared parameter extraction for every SALT_* action. elizaOS's Action
 * contract has no JSON-schema/tool-args slot (see @elizaos/core's Action
 * type) -- an action's handler is expected to read what it needs out of the
 * message/state itself. This asks a small model to fill named XML fields
 * from the conversation, then parses the reply with core's own
 * `parseKeyValueXml` (the same `<response>...</response>` convention the
 * planner's own output uses), so a field the model didn't answer comes back
 * absent rather than guessed.
 */

import { ModelType, parseKeyValueXml, type IAgentRuntime, type Memory, type State } from "@elizaos/core";

export interface ExtractFieldSpec {
  name: string;
  instructions: string;
  required?: boolean;
}

/**
 * Returns a plain object of the requested fields (missing/blank fields are
 * simply absent), or throws if the model produced no parseable response at
 * all -- callers decide what a missing *required* field means for their own
 * action (usually: ask the human to be specific, don't guess a receiver or
 * an amount).
 */
export async function extractActionParams(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  taskDescription: string,
  fields: ExtractFieldSpec[]
): Promise<Record<string, string | undefined>> {
  const fieldLines = fields.map((f) => `<${f.name}>${f.instructions}</${f.name}>`).join("\n");
  const prompt = [
    taskDescription,
    "",
    `Conversation context:\n${state?.text ?? ""}`,
    "",
    `Message to read:\n${message.content.text ?? ""}`,
    "",
    "Reply with EXACTLY one XML block, this shape, leaving a field empty if the message doesn't say:",
    "<response>",
    fieldLines,
    "</response>",
  ].join("\n");

  const raw = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const parsed = parseKeyValueXml<Record<string, string>>(text);
  const result: Record<string, string | undefined> = {};
  for (const f of fields) {
    const value = parsed?.[f.name];
    result[f.name] = typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  }
  return result;
}
