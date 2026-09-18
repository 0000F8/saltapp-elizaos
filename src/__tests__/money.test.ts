import { describe, expect, it } from "vitest";
import { multiplyDecimalByInt } from "../money";

describe("multiplyDecimalByInt", () => {
  it("multiplies a simple decimal", () => {
    expect(multiplyDecimalByInt("19.99", 3)).toBe("59.97");
  });

  it("multiplies a whole number with no decimal point", () => {
    expect(multiplyDecimalByInt("5", 4)).toBe("20");
  });

  it("multiplies by 1 unchanged", () => {
    expect(multiplyDecimalByInt("12.50", 1)).toBe("12.50");
  });

  it("never drifts the way float multiplication can", () => {
    // 0.1 * 3 famously isn't exactly 0.3 in IEEE-754 float math.
    expect(multiplyDecimalByInt("0.1", 3)).toBe("0.3");
  });

  it("preserves the unit price's decimal scale even when the fraction is zero", () => {
    expect(multiplyDecimalByInt("99.99", 0)).toBe("0.00");
  });

  it("handles many decimal places exactly", () => {
    expect(multiplyDecimalByInt("0.00000001", 100000000)).toBe("1.00000000");
  });

  it("handles a negative amount, preserving decimal scale", () => {
    expect(multiplyDecimalByInt("-2.5", 2)).toBe("-5.0");
  });
});
