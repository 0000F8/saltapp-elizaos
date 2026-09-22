/**
 * Reads this plugin's settings off the elizaOS runtime (character secrets/
 * settings, per runtime.getSetting's own precedence -- never process.env
 * directly, so a multi-tenant host never leaks one agent's Salt identity into
 * another). Mirrors salt-agent-sdk's config.ts field set so a person moving
 * between a bare salt-agent-sdk host and this plugin recognizes the names.
 */

import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import type { SaltDeliveryMode, SaltPluginConfig } from "./types";

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function boolSetting(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() !== "false";
}

/**
 * Env values may carry armored PGP blocks on one line with literal "\n"
 * (the common .env convention -- most secrets tooling mangles real
 * newlines). Normalise back so openpgp can parse them.
 */
export function unescapeArmor(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

export function loadSaltPluginConfig(runtime: IAgentRuntime): SaltPluginConfig {
  const get = (key: string): string | undefined => {
    const v = runtime.getSetting(key);
    return v === undefined || v === null ? undefined : String(v);
  };

  const modeRaw = (get("SALT_MODE") ?? "socket").toLowerCase();
  const mode: SaltDeliveryMode = modeRaw === "webhook" ? "webhook" : "socket";
  const appId = get("SALT_APP_ID") ?? "";

  return {
    host: (get("SALT_HOST") ?? "https://saltapp.ai").replace(/\/$/, ""),
    appId,
    apiKey: get("SALT_API_KEY") ?? "",
    publicKey: unescapeArmor(get("SALT_APP_PUBLIC_KEY")) ?? "",
    privateKey: unescapeArmor(get("SALT_APP_PRIVATE_KEY")) ?? "",
    passphrase: get("SALT_PGP_PASSPHRASE") ?? "",
    mode,
    webhookPort: clampInt(get("SALT_WEBHOOK_PORT"), 5100, 1, 65535),
    webhookPublicUrl: get("SALT_WEBHOOK_PUBLIC_URL"),
    // Round-4 socket contract (LANES.md K2, revised 2026-09-18): salt-api
    // clamps `timeout` server-side to 0..2s regardless of what's sent --
    // the old 25s default was a pre-H1 long-poll assumption. Sending a
    // higher value isn't rejected, just wasted on the wire and misleading
    // to read in logs, so this clamps to what the server will actually
    // honor rather than relying on the server alone to correct it.
    pollTimeoutSeconds: clampInt(get("SALT_POLL_TIMEOUT_SECONDS"), 2, 0, 2),
    pollLimit: clampInt(get("SALT_POLL_LIMIT"), 50, 1, 100),
    verifySignatures: boolSetting(runtime.getSetting("SALT_VERIFY_SIGNATURES"), true),
    autoReply: boolSetting(runtime.getSetting("SALT_AUTO_REPLY"), true),
    askHumanTimeoutSeconds: clampInt(get("SALT_ASK_HUMAN_TIMEOUT_SECONDS"), 300, 5, 3600),
    // Where the poll cursor and delivery-id dedupe set persist across
    // restarts (salt-agent-sdk's FileCursorStore/FileDedupeStore, see
    // service.ts). Same process.cwd()-relative "data/" convention
    // salt-agent-sdk's own identities.ts default uses, namespaced by this
    // identity's own appId so two characters run from the same directory
    // never share (or clobber) one another's cursor/dedupe files.
    stateDir: get("SALT_STATE_DIR") ?? path.join(process.cwd(), "data", "salt", appId || "default"),
  };
}

/** Returns the names of any required settings that are missing. */
export function validateSaltPluginConfig(config: SaltPluginConfig): string[] {
  const missing: string[] = [];
  if (!config.host) missing.push("SALT_HOST");
  if (!config.appId) missing.push("SALT_APP_ID");
  if (!config.apiKey) missing.push("SALT_API_KEY");
  if (!config.publicKey) missing.push("SALT_APP_PUBLIC_KEY");
  if (!config.privateKey) missing.push("SALT_APP_PRIVATE_KEY");
  if (!config.passphrase) missing.push("SALT_PGP_PASSPHRASE");
  if (config.mode === "webhook" && !config.webhookPublicUrl) missing.push("SALT_WEBHOOK_PUBLIC_URL");
  return missing;
}
