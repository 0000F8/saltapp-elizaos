# HANDOFF — lane `elizaos`

New repository: `/Users/z1ggy/projects/salt/saltapp-elizaos` (git-initialized,
committed locally on `main`; no GitHub repo created, nothing pushed,
nothing published, per the lane's instructions).

## What changed

Built `plugin-saltapp` from scratch: an elizaOS third-party plugin that puts
any Eliza agent on Salt (saltapp.ai). Everything under `src/` is new.

### Files

```
package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts
.gitignore, .npmignore, LICENSE
README.md, AGENTS.md, HANDOFF.md (this file), registry-entry.json
src/
  index.ts, service.ts, config.ts, signature.ts, mapping.ts, rest.ts, money.ts, types.ts
  actions/{extract,shared,requestPayment,sendInvoice,postCard,askHuman,index}.ts
  providers/{chatContext,index}.ts
  __tests__/{signature,mapping,money,postCard,service,actions}.test.ts, testUtils.ts
```

### What it does

- `SaltService` (`src/service.ts`): long-polls
  `GET /api/v1/agent/updates?after=&timeout=&limit=` with the agent's
  api-key (LANES.md's socket-mode contract, K2), verifies each envelope's
  `X-Salt-Signature` HMAC, PGP-decrypts a `message` event's ciphertext,
  bridges it into elizaOS's normal message loop
  (`ensureConnection` → `Memory` → `runtime.messageService.handleMessage`
  with a `HandlerCallback` that PGP-encrypts the reply for every current
  chat member and posts it — the same connector pattern
  `plugins/plugin-matrix/src/service.ts`'s `dispatchToAgent` uses), and
  handles `card_interaction` (resolves a pending `SALT_ASK_HUMAN` wait, or
  records the tap as a memory) and `chat_opened` (warms the per-chat member
  cache) events.
- Four actions (`src/actions/`): `SALT_REQUEST_PAYMENT`, `SALT_SEND_INVOICE`,
  `SALT_POST_CARD`, `SALT_ASK_HUMAN`.
- One provider (`src/providers/chatContext.ts`): `SALT_CHAT_CONTEXT`.
- `registry-entry.json`: the elizaOS community-registry source entry for
  this package, ready to copy into `packages/registry/entries/third-party/`
  in a PR (see "Getting listed" below).

### Migrations

None — this is a new, independent repository with no database and no
existing consumers.

## How to test

```bash
cd /Users/z1ggy/projects/salt/saltapp-elizaos
npm install
npm install ../salt-agent-sdk --no-save   # see "salt-agent-sdk isn't published at 0.7.1" below
npm run typecheck   # tsc --noEmit -p tsconfig.json  -> clean
npm run build       # tsc -p tsconfig.build.json     -> dist/, clean
npm test            # vitest run                      -> 50/50 passing
```

Actually run and green as of this writing:

```
Test Files  6 passed (6)
     Tests  50 passed (50)
```

Coverage by file: `signature.test.ts` (8 — missing/malformed/stale/no-secret/
wrong-secret/tampered-body rejection, plus header-case-insensitivity and the
happy path); `mapping.test.ts` (12 — the three event-body parsers against
real Rails-job-shaped payloads, `isGroupChat`, `looksLikePgpMessage`);
`money.test.ts` (7 — exact decimal multiply, including the classic
`0.1 * 3` float-drift case); `postCard.test.ts` (8 — slug/split/card-block
builders); `actions.test.ts` (7 — each action's `validate`/`handler` against
a mocked `SaltClient` and a mocked `fetch`, including the `SALT_ASK_HUMAN`
resolve-and-timeout paths); `service.test.ts` (8 — `SaltService` end to end,
using **real** PGP encrypt/decrypt via `salt-agent-sdk`, not mocked crypto).

## The `CLAUDE.md` paragraph this would add

(Not added — this repo is intentionally outside the `salt-*` workspace, and
the lane rules say not to edit the workspace `CLAUDE.md`. If the coordinator
wants a pointer to it added under a future "Integrations" section, this is
the paragraph:)

> **elizaOS** (`github.com/0000F8/saltapp-elizaos`, unscoped npm
> `plugin-saltapp` — `@saltapp` scope not registered yet): a third-party
> elizaOS plugin so any Eliza agent can live on Salt. `SaltService`
> long-polls `GET /api/v1/agent/updates` (socket mode, no public URL needed),
> bridging Salt messages into elizaOS's normal message loop the same way
> `plugin-matrix`/`plugin-discord` do; four actions
> (`SALT_REQUEST_PAYMENT`/`SALT_SEND_INVOICE`/`SALT_POST_CARD`/
> `SALT_ASK_HUMAN`) and a `SALT_CHAT_CONTEXT` provider. Built against the
> socket-mode contract in `design-fleet/runs/2026-09-17-distribution/LANES.md`
> ahead of that endpoint shipping in `salt-api` — never run against a live
> deployment; verify the wire shapes once the socket lane ships before
> announcing it publicly.

## User-facing "what's new" candidate

**Internal only** — this is a developer-facing plugin for third-party
framework integration, not a change to saltapp.ai's own product surfaces.
Nothing for `salt-fe/src/whatsNew.js`.

## UAT steps

This can't be fully exercised yet — the socket-mode endpoint it depends on
(`GET /api/v1/agent/updates`, `PATCH /api/v1/agents/delivery`) doesn't exist
in `salt-api` at the time of this handoff (confirmed by checking the
`.worktrees/socket` lane's checkout directly: no diff from `origin/main`,
i.e. that lane hadn't started writing server code yet either). Once it
ships:

1. Register a real Salt agent (a human's api-key against
   `POST /api/v1/agents`, or `salt-agent-sdk`'s quickstart) — capture
   `SALT_APP_ID`/`SALT_API_KEY`/the PGP keypair. Name it `SALT-elizaos-test`
   with a `salt-elizaos-test@example.test`-style contact per the workspace's
   test-account convention.
2. `npm install plugin-saltapp` into a real elizaOS project (or point at
   this checkout), add it to a character's `plugins`/`settings`, and boot
   the agent. Confirm the process logs a successful `whoAmI` call and starts
   polling (no error, no crash loop).
3. From a second Salt account, open a 1:1 with the agent and send a message.
   Confirm: the agent replies (auto-reply on by default), the reply renders
   as ordinary chat ciphertext (not garbled, not double-encrypted), and it
   decrypts correctly on the human's side.
4. In a group chat with the agent and at least one other human, send a
   message WITHOUT `@mentioning` the agent — confirm it stays silent (Salt's
   own server-side gate, not this plugin) — then `@mention` it and confirm
   it replies.
5. Ask the agent (in conversation) to request a specific amount from you.
   Confirm a real payment-request bubble appears with the right amount,
   currency, and receiver.
6. Ask it to invoice you for "2 widgets at $5 each" and confirm the invoice
   bubble shows a $10 total with one correct line item.
7. Ask it to "ask me pizza or sushi" (`SALT_POST_CARD`) and confirm a card
   with two buttons appears; tapping one should NOT change the agent's
   behavior (this action doesn't wait).
8. Ask it something that should make it wait for your answer (a phrasing
   that maps to `SALT_ASK_HUMAN` — e.g. "check with me before you do X, then
   continue") and confirm the turn visibly pauses until you tap a button,
   then the agent's next message reflects your choice. Also test the
   timeout path by not tapping anything and confirming it eventually gives
   up gracefully rather than hanging forever.
9. Kill and restart the process; confirm it resumes polling from a sane
   cursor rather than either re-processing very old messages or losing ones
   sent while it was down. **Fixed 2026-09-22** (salt-agent-sdk 0.8
   alignment pass): the cursor and the processed-delivery-id set both now
   persist to `SALT_STATE_DIR` (`salt-agent-sdk`'s `FileCursorStore`/
   `FileDedupeStore`, default `./data/salt/<SALT_APP_ID>`), so a restart
   resumes from where it left off instead of replaying the outbox — see
   "Left undone" item 2 below, which this closes.

## What's left undone

Ranked roughly by how soon it matters:

1. **Never run against a live `salt-api`.** The single biggest open risk.
   `GET /api/v1/agent/updates` and `PATCH /api/v1/agents/delivery` are
   specified in LANES.md but weren't implemented server-side as of this
   handoff. Every wire shape here (`types.ts`, `signature.ts`) was cross-
   checked against the actual Rails jobs that produce the equivalent
   webhook payload (`webhook_job.rb`, `card_interaction_job.rb`,
   `chat_opened_webhook_job.rb`, `application_job.rb`'s signing code) and
   against LANES.md's own written contract for the new endpoint — but
   nobody has pointed a real long-poll request at a real server yet. Once
   the socket lane ships, run the UAT steps above for real before telling
   anyone this plugin works.
2. ~~**No cursor persistence.**~~ **FIXED 2026-09-22.** `SaltService` now
   persists the cursor and delivery-id dedupe set via `salt-agent-sdk`
   0.8's `FileCursorStore`/`FileDedupeStore` (default directory
   `SALT_STATE_DIR`, `./data/salt/<SALT_APP_ID>`; inject `MemoryCursorStore()`/
   `MemoryDedupeStore()` via `SaltServiceDeps` to opt out). `fetchAgentUpdates`
   also now omits `after` entirely on a fresh cursor (0) so salt-api's own
   server-side ack applies rather than sending `after=0` — see LANES.md's
   round-3/4 socket contract. Polling is now adaptive
   (`ACTIVE_POLL_DELAY_MS`/`IDLE_POLL_DELAY_MS` from `salt-agent-sdk`,
   ~1s/~5s) and `SALT_POLL_TIMEOUT_SECONDS` defaults to and clamps at 2s
   (was 25s, a pre-round-4 long-poll assumption salt-api's short-poll
   endpoint now rejects anyway by clamping server-side).
3. **`SALT_MODE=webhook` is accepted by settings but not implemented.**
   `SaltService.connect()` throws if you set it. `salt-agent-sdk` already
   has a complete `createWebhookServer` (signature verification, dedup,
   GACM-style silence rules, hand-off/consult/mediator gating) — wiring
   ITS callbacks into the same `ensureConnection`/`messageService.handleMessage`
   bridge this plugin already has for socket mode is the natural way to add
   it, but it's a second Service (or a mode switch inside this one) and
   wasn't attempted here to keep scope bounded.
4. **`SALT_SEND_INVOICE` extracts exactly one line item per call.**
   elizaOS's `Action` type has no structured-args slot (see AGENTS.md), so
   parameter extraction goes through a flat `<response>` XML shape
   (`actions/extract.ts`) that doesn't naturally represent a list of line
   items. A real "$5 widget, $3 gadget, and $2 shipping" invoice needs
   either a richer extraction prompt/parser or a second model call that
   returns a JSON array. Multiple calls to `SALT_SEND_INVOICE` in the same
   turn currently create multiple separate invoices, not one multi-item one.
5. **An unwaited `card_interaction` doesn't reach the model.** `SALT_POST_CARD`
   taps, or a `SALT_ASK_HUMAN` tap that arrives after its timeout already
   fired, are recorded as a memory (`handleCardInteractionEnvelope`'s "no
   waiter" branch) but don't drive a fresh `messageService.handleMessage`
   turn. Routing them through the same bridge `handleMessageEnvelope` uses
   is a reasonable follow-up — deliberately left out to keep
   `card_interaction`'s contract (one card, one resolution) simple to reason
   about while nothing has been proven against a live server yet.
6. **`SALT_CHAT_CONTEXT`'s "pending requests" is whatever this identity has
   observed live since it started**, not a real query against Salt's
   `transfer_requests` for the chat. Backfilling it would mean either a new
   SDK client method or scanning `getChatMessages` for `resource_type:
   "TransferRequest"` rows — neither was in scope here.
7. **Group-vs-1:1 detection is a member-count heuristic** (`isGroupChat`:
   more than 2 members = group), because the message-event webhook body
   carries no explicit flag and observer memberships (Salt's silent
   delegation-observer pattern) aren't distinguished from real members in
   `getChatMembers`'s response shape as used here. Good enough for the
   provider's own text; don't rely on it for anything that needs to be exactly
   right about who's "really" in a chat.
8. **No live-model trajectory has been captured.** Every test here mocks
   `runtime.useModel`; nobody has watched a real model choose one of these
   four actions from a live conversation. Worth doing once there's a real
   `salt-api` to test against — a static XML-extraction prompt tested only
   against canned strings is a much weaker guarantee than watching Claude/
   GPT/whatever actually pick `SALT_REQUEST_PAYMENT` unprompted.
9. **`salt-agent-sdk` isn't published at `0.7.1`.** npm has only `0.1.0`
   (see the Salt workspace's own research notes); local is `0.7.1`,
   unpublished. `package.json` correctly declares `"salt-agent-sdk":
   "^0.7.1"` (the intended, forward-looking range), but that means a plain
   `npm install` in this repo will fail against the real registry today.
   For local development: `npm install ../salt-agent-sdk --no-save` (the
   `--no-save` matters — without it, npm rewrites `package.json`'s
   dependency to `file:../salt-agent-sdk`, which is wrong to ship). This
   resolves itself the moment `salt-agent-sdk` 0.7.1+ is actually published.

## Getting listed in the elizaOS registry

Confirmed by reading `packages/registry/README.md` and
`packages/elizaos/CLAUDE.md` in a fresh clone of `elizaOS/eliza` — this
replaced the old, separate `elizaos-plugins/registry` repo
(elizaOS/eliza#8173); there is no other registry to submit to.

1. **Publish `plugin-saltapp` to npm first.** The registry only lists
   already-published packages; it doesn't host code.
2. From this repo (with the CLI installed, `npx elizaos` or a global
   install): `elizaos plugins submit . --dry-run` — this should print
   metadata matching `registry-entry.json` (package, repository, kind,
   description, tags), generated from `package.json`. If it doesn't match,
   trust the CLI's own output over this file and update `registry-entry.json`
   to match — it drifted if the two disagree.
3. Fork `elizaOS/eliza`, add `registry-entry.json`'s content as
   `packages/registry/entries/third-party/plugin-saltapp.json` (the
   filename convention: `/` → `__`, `@` dropped — this package has neither,
   so the filename is just the package name).
4. Regenerate the wire format and validate, from the fork:
   ```bash
   bun run --cwd packages/registry validate
   bun run --cwd packages/registry generate
   ```
   Commit both the new entry file AND the regenerated
   `generated-registry.json` — the maintainers' own doc is explicit that the
   generated file is never hand-edited and should ride along in the same PR.
5. Open the PR against `elizaOS/eliza`'s `develop` branch (the repo's root
   `CLAUDE.md`: features/fixes target `develop`, never a direct push).
   `elizaos plugins submit . --registry <owner>/<repo>` can open this PR
   for you non-interactively once you have `gh` configured, but doing it by
   hand via fork + PR works identically.
6. **What the maintainers require** (`packages/registry/README.md`, "Adding
   a third-party plugin"): the package must already be published under its
   own scope or an unscoped `elizaos-plugin-*`-or-similar name (the
   `@elizaos/*` scope is rejected by the validator); community entries are
   "reviewed for security, functionality, and documentation quality before
   merge" — this repo's README (setup, settings table, the custody note)
   and AGENTS.md (architecture, where the ground truth for every wire shape
   came from) are written with that review in mind.
7. Note for whoever does this: the registry is CURATION, not a hard
   requirement to run the plugin (`README.md`: "The runtime auto-discovers
   any npm package whose `keywords` include `elizaos`" — already set in
   this repo's `package.json`). Skipping the registry PR entirely doesn't
   stop anyone from `npm install plugin-saltapp`ing this today, once it's
   published.

## Security notes

- **Signature verification is the actual security boundary for
  `card_interaction`/`chat_opened` events** — a decrypted `message` event
  fails safe on its own (forged ciphertext never decrypts to anything
  meaningful), but `card_interaction`/`chat_opened` bodies are plaintext
  metadata Salt already legitimately has, so a forged envelope without a
  valid HMAC could otherwise make this plugin believe a card was tapped, or
  that a chat opened, when neither happened. `SALT_VERIFY_SIGNATURES`
  defaults to `true`; the "disable only against a local dev salt-api" note
  in the settings table is load-bearing, not decoration.
- **This process holds the agent's PGP private key** (see README's Custody
  section) — treat `SALT_APP_PRIVATE_KEY`/`SALT_PGP_PASSPHRASE`/`SALT_API_KEY`
  the way you'd treat any other credential that can read and act as a real
  Salt account: not in a committed file, not logged, rotated via
  `salt-agent-sdk`'s `rotateAgentApiKey`/`rotateWebhookSecret` if ever
  exposed.
- No secrets are committed to this repository. `.gitignore` excludes `.env`.
