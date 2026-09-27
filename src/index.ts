/**
 * plugin-saltapp: puts an Eliza agent on Salt (saltapp.ai), an end-to-end
 * encrypted chat where humans and AI agents message, pay, invoice, and hand
 * off work to each other. Registers SaltService (the connector: socket-mode
 * long-poll, PGP, and the core message-loop bridge -- see service.ts), the
 * SALT_CHAT_CONTEXT provider, and four Salt-specific actions
 * (SALT_REQUEST_PAYMENT, SALT_SEND_INVOICE, SALT_POST_CARD, SALT_ASK_HUMAN).
 *
 * See README.md for setup and the custody note, and HANDOFF.md for what's
 * left undone in this first cut.
 */

import type { Plugin } from "@elizaos/core";
import { loadSaltPluginConfig, validateSaltPluginConfig } from "./config.js";
import { SaltService } from "./service.js";
import { saltActions } from "./actions/index.js";
import { saltProviders } from "./providers/index.js";

export * from "./config.js";
export * from "./mapping.js";
export * from "./money.js";
export * from "./rest.js";
export * from "./service.js";
export * from "./signature.js";
export * from "./socket.js";
export * from "./types.js";
export * from "./actions/index.js";
export * from "./providers/index.js";

export const saltappPlugin: Plugin = {
  name: "plugin-saltapp",
  description: "Live on Salt (saltapp.ai): end-to-end encrypted messages, payment requests, invoices, and interactive cards with humans and other agents.",

  async init(_config, runtime) {
    // Fail loudly here rather than let a half-configured identity start
    // anyway and long-poll into a 401 forever. Deliberately reads through
    // runtime.getSetting() only (character secrets/settings, never
    // process.env -- see @elizaos/core's CLAUDE.md on why getSetting() is
    // per-agent): the host is responsible for folding this plugin's own
    // config block into what getSetting() resolves, same as any other
    // plugin's settings.
    const resolved = loadSaltPluginConfig(runtime);
    const missing = validateSaltPluginConfig(resolved);
    if (missing.length > 0) {
      throw new Error(`plugin-saltapp: missing required configuration: ${missing.join(", ")}`);
    }
  },

  // Published @elizaos/core (1.7.2 as of this writing) has no plugin-level
  // `dispose` hook -- the runtime calls each registered Service's own
  // `stop()` directly on shutdown/unload, which is where SaltService closes
  // its poll loop and clears any pending SALT_ASK_HUMAN waiters.
  services: [SaltService],
  actions: saltActions,
  providers: saltProviders,
};

export default saltappPlugin;
