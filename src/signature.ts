/**
 * Verifies the HMAC salt-api stamps on every agent delivery -- socket-mode
 * envelopes carry the exact `X-Salt-*` headers a webhook POST would have
 * carried (LANES.md's socket-mode contract, K2), signed the same way
 * (application_job.rb: `X-Salt-Signature: t=<unix>,v1=<hex hmac-sha256>`
 * over `"${t}.${rawBody}"`, keyed by this agent's own webhook secret).
 * Ported from salt-agent-sdk's webhook.ts `rejectionReason` so a relayed
 * envelope can't be forged by anyone who doesn't hold that secret.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SignatureCheckInput {
  /** Header map exactly as delivered (case preserved; lookup is case-insensitive). */
  headers: Record<string, string>;
  /** The exact JSON body string the signature was computed over. */
  body: string;
  /** This agent's own webhook signing secret (client.getWebhookSecret). */
  secret: string;
  /** Reject a signature older than this many seconds. Defaults to 300 (5 min). */
  toleranceSeconds?: number;
  /** Injectable for tests; defaults to Date.now(). */
  now?: () => number;
}

export type SignatureCheckResult = { ok: true } | { ok: false; reason: string };

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

export function verifyEnvelopeSignature(input: SignatureCheckInput): SignatureCheckResult {
  const signature = getHeader(input.headers, "X-Salt-Signature");
  if (!signature) return { ok: false, reason: "missing signature" };

  const tMatch = /t=(\d+)/.exec(signature);
  const v1Match = /v1=([0-9a-f]+)/.exec(signature);
  const t = tMatch?.[1];
  const v1 = v1Match?.[1];
  if (!t || !v1) return { ok: false, reason: "malformed signature" };

  const tolerance = input.toleranceSeconds ?? 300;
  const now = input.now ?? Date.now;
  const age = Math.abs(Math.floor(now() / 1000) - Number(t));
  if (age > tolerance) return { ok: false, reason: `stale signature (${age}s old)` };

  if (!input.secret) return { ok: false, reason: "no signing key configured" };

  const expected = createHmac("sha256", input.secret).update(`${t}.${input.body}`).digest("hex");
  const a = Buffer.from(v1, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };

  return { ok: true };
}
