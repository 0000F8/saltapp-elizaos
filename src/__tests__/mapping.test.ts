import { describe, expect, it } from "vitest";
import {
  SaltEnvelopeParseError,
  isGroupChat,
  looksLikePgpMessage,
  parseCardInteractionEventBody,
  parseChatOpenedEventBody,
  parseDeliveredBecause,
  parseMessageEventBody,
} from "../mapping";

describe("parseMessageEventBody", () => {
  it("parses a real Message#formatted_message-shaped body", () => {
    const body = JSON.stringify({
      chat: { id: "chat-1", name: null, public: false, managed: false, active_agent_id: "agent-1" },
      message: {
        chat_id: "chat-1",
        message: "-----BEGIN PGP MESSAGE-----\n...\n-----END PGP MESSAGE-----",
        message_id: 42,
        seq: 7,
        message_type: "User",
        version: 1,
        user: { id: "user-1", username: "ada", display_name: "Ada", account_type: "User" },
        created_at: "2026-09-18T00:00:00Z",
      },
    });
    const parsed = parseMessageEventBody(body);
    expect(parsed.chat.id).toBe("chat-1");
    expect(parsed.message.message_id).toBe(42);
    expect(parsed.message.user.username).toBe("ada");
  });

  it("throws SaltEnvelopeParseError on invalid JSON", () => {
    expect(() => parseMessageEventBody("not json")).toThrow(SaltEnvelopeParseError);
  });

  it("throws when chat or message is missing", () => {
    expect(() => parseMessageEventBody(JSON.stringify({ chat: { id: "1" } }))).toThrow(SaltEnvelopeParseError);
    expect(() => parseMessageEventBody(JSON.stringify({ message: {} }))).toThrow(SaltEnvelopeParseError);
  });
});

describe("parseCardInteractionEventBody", () => {
  it("parses a CardInteractionJob-shaped body", () => {
    const body = JSON.stringify({
      type: "card_interaction",
      card_id: "card-1",
      owner_id: "agent-1",
      chat_id: "chat-1",
      action_id: "approve",
      value: "approve",
      state: {},
      user: { id: "user-1", username: "ada", display_name: "Ada", account_type: "User" },
    });
    const parsed = parseCardInteractionEventBody(body);
    expect(parsed.card_id).toBe("card-1");
    expect(parsed.action_id).toBe("approve");
  });

  it("throws when card_id or chat_id is missing", () => {
    expect(() => parseCardInteractionEventBody(JSON.stringify({ chat_id: "1" }))).toThrow(SaltEnvelopeParseError);
  });
});

describe("parseChatOpenedEventBody", () => {
  it("parses a ChatOpenedWebhookJob-shaped body", () => {
    const body = JSON.stringify({
      type: "chat_opened",
      chat: { id: "chat-1" },
      opened_by: { id: "user-1", username: "ada", display_name: "Ada", account_type: "User" },
      members: [
        { id: "user-1", username: "ada", display_name: "Ada", account_type: "User" },
        { id: "agent-1", username: "bot", display_name: "Bot", account_type: "Agent" },
      ],
      opened_at: "2026-09-18T00:00:00Z",
    });
    const parsed = parseChatOpenedEventBody(body);
    expect(parsed.members).toHaveLength(2);
  });

  it("throws when members is not an array", () => {
    expect(() => parseChatOpenedEventBody(JSON.stringify({ chat: { id: "1" } }))).toThrow(SaltEnvelopeParseError);
  });
});

describe("looksLikePgpMessage", () => {
  it("recognizes an armored PGP message", () => {
    expect(looksLikePgpMessage("-----BEGIN PGP MESSAGE-----\nfoo")).toBe(true);
  });
  it("rejects plaintext", () => {
    expect(looksLikePgpMessage("hello")).toBe(false);
    expect(looksLikePgpMessage(null)).toBe(false);
    expect(looksLikePgpMessage(undefined)).toBe(false);
  });
});

describe("isGroupChat", () => {
  it("treats exactly 2 members as a 1:1", () => {
    expect(isGroupChat(2)).toBe(false);
  });
  it("treats more than 2 members as a group", () => {
    expect(isGroupChat(3)).toBe(true);
  });
  it("defaults unknown member counts to a group (the safer gate)", () => {
    expect(isGroupChat(undefined)).toBe(true);
  });
});

describe("parseDeliveredBecause", () => {
  it("accepts every known value", () => {
    for (const v of ["mention", "reply", "keyword", "all"]) {
      expect(parseDeliveredBecause(v)).toBe(v);
    }
  });
  it("narrows an unrecognized string to undefined", () => {
    expect(parseDeliveredBecause("some-future-kind")).toBeUndefined();
  });
  it("narrows a missing/non-string value to undefined", () => {
    expect(parseDeliveredBecause(undefined)).toBeUndefined();
    expect(parseDeliveredBecause(null)).toBeUndefined();
    expect(parseDeliveredBecause(42)).toBeUndefined();
  });
});
