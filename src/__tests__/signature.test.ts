import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyEnvelopeSignature } from "../signature";

const SECRET = "test-webhook-secret";

function sign(body: string, t: number, secret = SECRET): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("verifyEnvelopeSignature", () => {
  const body = JSON.stringify({ hello: "world" });
  const now = () => 1_700_000_000_000; // fixed clock for deterministic tests
  const t = Math.floor(now() / 1000);

  it("accepts a correctly signed, fresh envelope", () => {
    const headers = { "X-Salt-Signature": sign(body, t) };
    const result = verifyEnvelopeSignature({ headers, body, secret: SECRET, now });
    expect(result).toEqual({ ok: true });
  });

  it("is case-insensitive on the header name", () => {
    const headers = { "x-salt-signature": sign(body, t) };
    const result = verifyEnvelopeSignature({ headers, body, secret: SECRET, now });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing signature header", () => {
    const result = verifyEnvelopeSignature({ headers: {}, body, secret: SECRET, now });
    expect(result).toEqual({ ok: false, reason: "missing signature" });
  });

  it("rejects a malformed signature", () => {
    const result = verifyEnvelopeSignature({ headers: { "X-Salt-Signature": "not-a-real-signature" }, body, secret: SECRET, now });
    expect(result).toEqual({ ok: false, reason: "malformed signature" });
  });

  it("rejects a stale signature outside the tolerance window", () => {
    const staleT = t - 3600; // one hour old
    const headers = { "X-Salt-Signature": sign(body, staleT) };
    const result = verifyEnvelopeSignature({ headers, body, secret: SECRET, now, toleranceSeconds: 300 });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/stale signature/);
  });

  it("rejects when no signing secret is configured", () => {
    const headers = { "X-Salt-Signature": sign(body, t) };
    const result = verifyEnvelopeSignature({ headers, body, secret: "", now });
    expect(result).toEqual({ ok: false, reason: "no signing key configured" });
  });

  it("rejects a signature computed with the wrong secret", () => {
    const headers = { "X-Salt-Signature": sign(body, t, "a-different-secret") };
    const result = verifyEnvelopeSignature({ headers, body, secret: SECRET, now });
    expect(result).toEqual({ ok: false, reason: "bad signature" });
  });

  it("rejects when the body was tampered with after signing", () => {
    const headers = { "X-Salt-Signature": sign(body, t) };
    const tamperedBody = JSON.stringify({ hello: "attacker" });
    const result = verifyEnvelopeSignature({ headers, body: tamperedBody, secret: SECRET, now });
    expect(result).toEqual({ ok: false, reason: "bad signature" });
  });
});
