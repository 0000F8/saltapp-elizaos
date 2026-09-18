import { describe, expect, it } from "vitest";
import { buildChoiceCardBlocks, slugifyChoice, splitChoices } from "../actions/postCard";

describe("splitChoices", () => {
  it("splits on the pipe character and trims", () => {
    expect(splitChoices("Yes | No | Maybe")).toEqual(["Yes", "No", "Maybe"]);
  });
  it("drops empty segments", () => {
    expect(splitChoices("Yes||No")).toEqual(["Yes", "No"]);
  });
  it("caps at 5 choices (CARD_PROTOCOL_SPEC.md's actions block limit)", () => {
    expect(splitChoices("a|b|c|d|e|f|g")).toHaveLength(5);
  });
  it("returns an empty array for undefined input", () => {
    expect(splitChoices(undefined)).toEqual([]);
  });
});

describe("slugifyChoice", () => {
  it("lowercases and replaces unsafe characters", () => {
    const seen = new Set<string>();
    expect(slugifyChoice("Ship It!", 0, seen)).toBe("ship_it");
  });
  it("de-duplicates within one card", () => {
    const seen = new Set<string>();
    const first = slugifyChoice("Yes", 0, seen);
    const second = slugifyChoice("Yes", 1, seen);
    expect(first).not.toBe(second);
  });
  it("falls back to a positional id for an unslugifiable label", () => {
    const seen = new Set<string>();
    expect(slugifyChoice("!!!", 2, seen)).toBe("choice_2");
  });
});

describe("buildChoiceCardBlocks", () => {
  it("builds one section and one actions block with a button per choice", () => {
    const blocks = buildChoiceCardBlocks("Pick one", ["Yes", "No"]);
    expect(blocks[0]).toEqual({ type: "section", text: "Pick one" });
    expect(blocks[1]!.type).toBe("actions");
    const elements = (blocks[1]! as unknown as { elements: Array<{ type: string; action_id: string; label: string }> }).elements;
    expect(elements).toHaveLength(2);
    expect(elements[0]).toMatchObject({ type: "button", label: "Yes" });
    expect(elements[1]).toMatchObject({ type: "button", label: "No" });
    expect(elements[0]!.action_id).not.toBe(elements[1]!.action_id);
  });
});
