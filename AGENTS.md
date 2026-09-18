# AGENTS.md

Repository guide for an agent (or a person) working on `plugin-saltapp`.
Read this before changing anything, then read `README.md` for the
user-facing contract and `HANDOFF.md` for what this first cut deliberately
left undone.

## What this is

An elizaOS third-party plugin (unscoped package `plugin-saltapp` — the
`@saltapp` npm org doesn't exist yet, see "Naming" below) that lets any Eliza
agent live on Salt (https://saltapp.ai), an end-to-end encrypted chat where
humans and AI agents message, pay, invoice, and hand off work to each other.
It is its own standalone repository (not a subdirectory of the elizaOS
monorepo or of the `salt-*` workspace) so it can be published to npm and
submitted to elizaOS's community registry independently.

## Layout

```
src/
  index.ts            The Plugin export (saltappPlugin): init, services, actions, providers
  service.ts           SaltService: the long-poll loop, signature check, PGP decrypt,
                        ensureConnection + messageService.handleMessage bridge, the
                        per-chat context cache, and the SALT_ASK_HUMAN wait registry
  config.ts            Reads settings off IAgentRuntime.getSetting() (never process.env)
  signature.ts          HMAC verification for a socket-mode envelope (pure, unit-tested)
  mapping.ts            Pure JSON-body parsing for message/card_interaction/chat_opened
  rest.ts               The few REST calls salt-agent-sdk's client doesn't cover yet
                        (long-poll fetch, delivery-mode PATCH, a plain payment request,
                        wallet/receiver resolution helpers)
  money.ts              Exact (BigInt-backed) decimal multiply for invoice line items
  actions/
    extract.ts          Shared "ask a small model to fill named XML fields" helper
    shared.ts            resolveSaltRoom / loadChatMembers (room.channelId -> Salt chat id)
    requestPayment.ts    SALT_REQUEST_PAYMENT
    sendInvoice.ts        SALT_SEND_INVOICE
    postCard.ts           SALT_POST_CARD (+ the choice/card-block builders SALT_ASK_HUMAN reuses)
    askHuman.ts           SALT_ASK_HUMAN
  providers/
    chatContext.ts        SALT_CHAT_CONTEXT
  types.ts              Wire and settings types (mirrors salt-api's webhook payload shapes)
  __tests__/            Vitest, mirroring the elizaOS plugin templates' own test runner
```

## Where the ground truth lives

This plugin was built by reading, not guessing, three sources:

1. **`/Users/z1ggy/projects/salt/CLAUDE.md`** (the Salt workspace guide) —
   the sections on Agents, Webhook delivery, Cards, Commerce, and the socket
   mode contract in `design-fleet/runs/2026-09-17-distribution/LANES.md`.
2. **`salt-api`'s own source** (a sibling checkout, not part of this repo) —
   `app/jobs/webhook_job.rb`, `card_interaction_job.rb`,
   `chat_opened_webhook_job.rb`, `app/jobs/application_job.rb` (the exact
   `X-Salt-Signature` scheme), and `app/controllers/api/v1/{transfer_requests,cards}_controller.rb`.
   `types.ts`'s payload shapes and `signature.ts`'s HMAC construction are
   ported from there, not invented.
3. **`salt-agent-sdk`** (also a sibling checkout; this plugin's one real
   runtime dependency) — its `client.ts`, `webhook.ts`, and `crypto.ts` are
   the reference for every REST call and every crypto operation this plugin
   doesn't hand-roll itself. `rest.ts` exists ONLY for what that client
   doesn't cover (see its file header).
4. **elizaOS's own source** (`packages/core`, `plugins/plugin-matrix`,
   `packages/elizaos/templates/plugin`) — `plugin-matrix`'s
   `dispatchToAgent` is the load-bearing reference for the
   `ensureConnection` → `Memory` → `runtime.messageService.handleMessage`
   bridge `service.ts` mirrors; `Room.channelId` is how `actions/shared.ts`
   recovers a Salt chat id from an elizaOS (hashed) `roomId`.

**The socket-mode long-poll endpoint (`GET /api/v1/agent/updates`) did not
exist in salt-api at the time this plugin was built.** It's specified in
LANES.md (a shared, in-progress build-lanes contract another lane owns
implementing server-side) and this plugin was built against that written
spec, with the wire shapes verified against the actual Rails jobs that
produce the equivalent webhook payload. It has never been run against a live
`salt-api`. See `HANDOFF.md`.

## Commands

```bash
npm install
npm install ../salt-agent-sdk --no-save   # local checkout; see HANDOFF.md on why
npm run typecheck    # tsc --noEmit
npm run build        # tsc -p tsconfig.build.json -> dist/
npm test             # vitest run
npm run test:watch   # vitest
```

## Naming (decided, and why)

- **npm package name: `plugin-saltapp`** (unscoped). elizaOS's own
  convention (`packages/elizaos/templates/min-plugin/SCAFFOLD.md`): "Scope
  under `@elizaos/plugin-` for first-party plugins, otherwise pick a
  sensible scope (`@user/plugin-foo`)." The Salt project's own naming
  decision (see the Salt workspace's `LANES.md`) is unscoped `saltapp-*`
  names because the `@saltapp` npm org doesn't exist yet. elizaOS's
  community registry (`packages/registry/README.md`) accepts and commonly
  lists unscoped `plugin-*` names for exactly this reason (several existing
  third-party entries — `plugin-x402-finance`, `plugin-wallettriage`,
  `plugin-gblin` — follow the same pattern), so `plugin-saltapp` satisfies
  both conventions at once. **Rename to `@saltapp/plugin-saltapp` once that
  npm org exists**, and re-submit the registry entry under the new name (a
  scope change is a new package as far as the registry is concerned).
- **Public author identity**: `0x0000F8 <0000F8@proton.me>`, GitHub org
  `0000F8`, homepage `https://saltapp.ai` — the Salt project's own decided
  public identity for its tooling repos (matches `salt-agent-sdk` and
  `salt-mcp`'s existing `github.com/0000F8/...` org).

## Conventions specific to this repo

- **`config` collides with `@elizaos/core`'s `Service.config?: Metadata`.**
  `SaltService` calls its own resolved settings `saltConfig`, not `config` —
  don't rename it back; it breaks `Service` structural compatibility (and
  `getService<SaltService>`) the way it did the first time this was written.
- **`runtime.getSetting()` only, never `process.env`.** `config.ts` mirrors
  `@elizaos/core`'s own stated reason (see that package's guide): a
  multi-tenant host runs several agents in one process, and falling through
  to `process.env` would leak one agent's Salt credentials into every other
  agent sharing the box. Don't add a `process.env` fallback here.
- **`ensureConnection`'s exact param list is whatever the installed
  `@elizaos/core` publishes, not whatever the elizaOS monorepo's HEAD has.**
  This bit once already: the monorepo's unreleased HEAD has grown
  `roomName`/`serverId` params that published `1.7.2` doesn't have yet, and
  `Plugin` in `1.7.2` has no `dispose` hook. Check
  `node_modules/@elizaos/core/dist/*.d.ts` directly before adding a field to
  an `ensureConnection` call or a top-level `Plugin` key; don't trust a
  memory of the monorepo source.
- **Every REST/crypto call goes through `salt-agent-sdk` or `rest.ts`,
  never a fresh `fetch` inline in an action or in `service.ts`.** If
  `salt-agent-sdk`'s client is missing something you need, add it to
  `rest.ts` with a comment saying which controller/endpoint it targets and
  why the SDK doesn't have it — don't duplicate a call the SDK already
  exposes.
- **Action parameter extraction goes through `actions/extract.ts`.**
  elizaOS's `Action` type has no JSON-schema/tool-args slot (see that
  package's `types/components.ts`) — parameters come out of the message via
  a small model call and `parseKeyValueXml`'s `<response>...</response>`
  convention, the same shape the planner's own output uses. Don't invent a
  second extraction mechanism for a new action; extend `extract.ts` if the
  flat key-value shape genuinely doesn't fit (e.g. a real multi-line-item
  invoice — see HANDOFF.md).
- **Tests that touch PGP use real `salt-agent-sdk` crypto (`generateKeypair`/
  `encryptFor`/`decrypt`), not a mocked crypto layer.** `SaltClient` and
  `fetch` are the things to mock; the wire-format and crypto correctness are
  exactly what a mock would hide a regression in.

## Before you change a public surface

- Changing `service.ts`'s event-body field names? Re-check them against the
  actual Rails job in `salt-api` (see "Where the ground truth lives" above),
  not against this file's comments — the comments describe the source as of
  when they were written, and salt-api moves independently of this repo.
- Changing an action's `name`/`similes`? Registry entries, README, and any
  character config a user already wrote reference the exact string; treat a
  rename as a breaking change and call it out in `HANDOFF.md`.
- Adding a fifth action? Follow the four existing ones' shape: `validate`
  resolves the Salt room and returns a boolean, `handler` extracts params
  via `extract.ts`, calls exactly one Salt-side effect through the SDK
  client or `rest.ts`, calls `callback` with the same text it returns, and
  never throws — a failure is a `{success: false, text: "..."}` result, not
  an unhandled rejection into the planner.
