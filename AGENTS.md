# AGENTS.md

Repository guide for an agent (or a person) working on `plugin-saltapp`.
Read this before changing anything, then read `README.md` for the
user-facing contract and `HANDOFF.md` for what this first cut deliberately
left undone.

## What this is

An elizaOS third-party plugin (unscoped package `plugin-saltapp` — the
`@saltapp` npm org doesn't exist yet, see "Naming" below) that lets any Eliza
agent live on Salt (https://saltapp.ai), an end-to-end encrypted chat where
humans and AI agents are equal contacts: they message, pay, invoice, and
hand off work to each other. It is its own standalone repository (not a
subdirectory of the elizaOS monorepo or of the `salt-*` workspace) so it can
be published to npm independently. **Not published to npm yet** (`npm view
plugin-saltapp` 404s as of this writing) — install from this checkout per
README.md's "Development" section until it is. elizaOS retired its
community plugin registry entirely on 2026-09-23
(`elizaOS/eliza#32219`, closed) — see "Naming" below and README.md's "The
elizaOS registry" section — so registry submission is no longer part of
this plan.

## Layout

```
src/
  index.ts            The Plugin export (saltappPlugin): init, services, actions, providers
  service.ts           SaltService: consumes socket.ts's live connection, verifies each
                        envelope's signature, PGP-decrypts (or passes through an open
                        room's plaintext), the ensureConnection +
                        messageService.handleMessage bridge, the per-chat context cache,
                        and the SALT_ASK_HUMAN wait registry (cardWaiters)
  socket.ts             createSaltUpdatesSocket: the live Action Cable websocket to
                        salt-api (via salt-agent-sdk) -- subscribe/replay/replay_done/
                        reconnect framing, so an idle, caught-up agent makes zero
                        requests. This is the real transport now; see "Where the ground
                        truth lives" below on how this superseded the long-poll design
                        this plugin started from.
  config.ts            Reads settings off IAgentRuntime.getSetting() (never process.env)
  signature.ts          HMAC verification for a socket-mode envelope (pure, unit-tested)
  mapping.ts            Pure JSON-body parsing for message/card_interaction/chat_opened
  rest.ts               The few REST calls salt-agent-sdk's client doesn't cover yet
                        (fetchAgentUpdates -- now only a backfill fetch for when Action
                        Cable's replay cap truncates the backlog, not the primary
                        transport -- delivery-mode PATCH, a plain payment request,
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

This plugin was built by reading, not guessing, four sources:

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

Since then, `salt-api` shipped both that poll endpoint and a live Action
Cable channel (`AgentUpdatesChannel`) for the same feed; this plugin's
`socket.ts` now holds that channel open as the primary transport (see
"Layout" above), with `rest.ts`'s `fetchAgentUpdates` kept only as a
backfill fallback. The "never run against a live `salt-api`" caveat above
still holds (`HANDOFF.md`'s open item 1 isn't marked fixed) — `socket.ts`
is unit-tested against a fake `WebSocket` (`socket.test.ts`,
`socketConnect.test.ts`), not a real server.

5. **Live references for ongoing work** (current, not build-time sources —
   check these against anything this file says; they win on conflict): the
   OpenAPI spec at https://saltapp.ai/api/openapi.json, the agent-facing
   overview at https://saltapp.ai/agents.md, the hosted MCP server at
   https://mcp.saltapp.ai/mcp (a second, protocol-native way to reach the
   same API this plugin calls directly via `salt-agent-sdk`/`rest.ts`), and
   the sibling `salt-mcp` repo's `docs/CLIENTS.md` (client-integration
   patterns across many frameworks — useful background even though this
   plugin talks REST/websocket directly rather than through MCP).

## Rules that bite

Cross-repo facts about Salt's actual server contract. This plugin's own
`SALT_ASK_HUMAN`/card code already gets these right — keep any new
card/session code in step with them, and don't reintroduce the mistake
when adding a new REST call:

- **A pending `SALT_ASK_HUMAN` wait resolves only from a live
  `card_interaction` event on this identity's own connection**
  (`SaltService.cardWaiters`, `handleCardInteractionEnvelope` in
  `service.ts`) — never by polling `GET /api/v1/agent/updates` (or
  `socket.ts`'s Action Cable equivalent) to find out if a card was tapped.
  That outbox has exactly ONE forward-only cursor per agent; any
  `after=`/ack sent against it permanently advances THIS agent's own
  server-side cursor, so a second reader of the same feed (a debug script,
  a second process sharing this agent's api-key) silently cuts off
  whatever backlog this service hasn't consumed yet. `rest.ts`'s
  `fetchAgentUpdates` exists only as a backfill for when Action Cable's own
  replay cap truncates the backlog — see its doc comment on why `after` is
  omitted rather than sent as `0`. Waiting on one specific card instead is
  `GET /api/v1/cards/:id`, a different endpoint entirely.
- **`POST /api/v1/cards` responds referencing the chat MESSAGE it
  created — `message_id`/`resource_id` — never a top-level `id`.**
  `askHuman.ts`'s `PostCardResponse` (`resource_id ?? response.resource?.id`)
  and `postCard.ts` already read it this way; keep any new card-response
  read in step with that shape.
- **A chat's `encrypted` flag doesn't nest the same way in every shape.**
  This plugin's own wire bodies put it directly on `chat.encrypted`
  (`SaltChatMeta.encrypted` in `types.ts`, delivered on `message`/
  `chat_opened` events) — but salt-api's `GET /api/v1/chats/:id`
  (`chats#show`, not called anywhere in this repo today) nests it under
  `session.encrypted` instead. Don't assume a future REST call to that
  endpoint matches this repo's existing `chat.encrypted` reads.
- **Since salt-api 0.98.1, an encrypted chat refuses a non-PGP-armored
  message body (and a plain/open chat refuses an armored one).**
  `service.ts`'s `sendChatMessage` already branches on the inbound
  message's own `encrypted` flag for exactly this reason (plaintext via
  `client.postPlainMessage`, otherwise `encryptFor` + `client.postMessage`)
  — never post a reply without checking that flag first.
- **Test fakes must model salt-api's ACTUAL controller response shape, not
  the calling code's assumption** — assuming a card-create response has a
  top-level `id` (instead of `resource_id`/`resource.id`) shipped
  identically in five downstream adapters elsewhere in this project.
  `actions.test.ts`'s `client.postCard` mock (`{ resource_id: "card-1" }`)
  is the pattern to keep copying; don't shortcut a new mock to whatever
  shape makes the calling code pass.

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
- **Update, 2026-09-23**: elizaOS retired its community plugin registry
  entirely (`elizaOS/eliza#32219`, closed; `packages/registry` removed
  from the monorepo) — see README.md's "The elizaOS registry" section.
  The unscoped-name rationale above still holds for the npm package
  itself, but there is no registry left to submit to or rename an entry
  in; `HANDOFF.md`'s "Getting listed in the elizaOS registry" walkthrough
  is accordingly historical, not a live TODO.

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
