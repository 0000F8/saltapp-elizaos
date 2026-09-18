/**
 * Pure parsing of the JSON bodies salt-api's webhook jobs (and the
 * equivalent socket-mode outbox rows) send -- no crypto, no runtime, no I/O,
 * so message-shape regressions show up as unit-test failures instead of a
 * silent drop in the poll loop. See types.ts for the field-level contract
 * and CLAUDE.md's Message#formatted_message / WebhookJob#user_send for the
 * source of truth this mirrors.
 */

import type {
  SaltCardInteractionEventBody,
  SaltChatOpenedEventBody,
  SaltMessageEventBody,
} from "./types";

export class SaltEnvelopeParseError extends Error {
  constructor(event: string, cause: unknown) {
    super(`Could not parse a Salt "${event}" envelope body: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SaltEnvelopeParseError";
  }
}

function parseJson(event: string, body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new SaltEnvelopeParseError(event, err);
  }
}

export function parseMessageEventBody(body: string): SaltMessageEventBody {
  const parsed = parseJson("message", body) as Partial<SaltMessageEventBody>;
  if (!parsed || typeof parsed !== "object" || !parsed.chat || !parsed.message) {
    throw new SaltEnvelopeParseError("message", "missing chat or message");
  }
  return parsed as SaltMessageEventBody;
}

export function parseCardInteractionEventBody(body: string): SaltCardInteractionEventBody {
  const parsed = parseJson("card_interaction", body) as Partial<SaltCardInteractionEventBody>;
  if (!parsed || typeof parsed !== "object" || !parsed.card_id || !parsed.chat_id) {
    throw new SaltEnvelopeParseError("card_interaction", "missing card_id or chat_id");
  }
  return parsed as SaltCardInteractionEventBody;
}

export function parseChatOpenedEventBody(body: string): SaltChatOpenedEventBody {
  const parsed = parseJson("chat_opened", body) as Partial<SaltChatOpenedEventBody>;
  if (!parsed || typeof parsed !== "object" || !parsed.chat || !Array.isArray(parsed.members)) {
    throw new SaltEnvelopeParseError("chat_opened", "missing chat or members");
  }
  return parsed as SaltChatOpenedEventBody;
}

/** True when `text` starts with an armored PGP message block. */
export function looksLikePgpMessage(text: string | null | undefined): boolean {
  return typeof text === "string" && text.startsWith("-----BEGIN PGP MESSAGE");
}

/**
 * A group chat's member-count-derived heuristic: exactly the sender plus this
 * agent is a 1:1; anything past that is a group. Salt's message webhook body
 * carries no explicit "is this a group" flag (only chat_opened's `members`
 * does) -- callers without a live member list should treat unknown as a
 * group (the safer default: gate replies on an explicit @mention instead of
 * replying unprompted into an unknown-size room).
 */
export function isGroupChat(memberCount: number | undefined): boolean {
  if (memberCount === undefined) return true;
  return memberCount > 2;
}
