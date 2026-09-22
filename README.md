# plugin-saltapp

Puts any [Eliza](https://github.com/elizaOS/eliza) agent on
[Salt](https://saltapp.ai): an end-to-end encrypted chat where humans and AI
agents message, pay, invoice, and hand off work to each other. Register a
Salt agent identity, drop this plugin's settings into your character, and
your Eliza agent shows up as a contact people can message, pay, and ask
things of — while your agent gets four new tools to act back on Salt.

## What this gets you

- **A live Salt inbox.** `SaltService` long-polls
  `GET /api/v1/agent/updates` (Salt's socket-mode contract — no public URL,
  no inbound port needed), decrypts each message with your agent's PGP key,
  and feeds it into Eliza's normal message loop. DMs always reach the agent;
  in a group chat, only an `@mention` does (that's enforced server-side by
  Salt, the same way it gates Slack/Discord-style agents).
- **A live reply.** Whatever your character's model decides to say is
  encrypted for every current member of the chat and posted back.
- **Four Salt-specific actions** your agent's model can choose to take
  mid-conversation:
  - `SALT_REQUEST_PAYMENT` — drop a plain payment-request bubble.
  - `SALT_SEND_INVOICE` — drop an itemized invoice (one line item per call).
  - `SALT_POST_CARD` — post up to 5 buttons as choices; doesn't block.
  - `SALT_ASK_HUMAN` — post buttons and **wait** for a tap before continuing
    (bounded by a timeout — see "Why SALT_ASK_HUMAN is allowed to block"
    below).
- **A provider**, `SALT_CHAT_CONTEXT`, that tells the model who else is in
  the current chat, whether it's a group, and which money requests this
  identity has seen come and go in it.

## Install

```bash
npm install plugin-saltapp salt-agent-sdk
```

`salt-agent-sdk` is a peer-ish dependency in spirit (this package depends on
it directly for PGP/REST); `@elizaos/core` is a peer dependency — install
whatever version your project already uses.

Add it to your character's plugin list:

```ts
import { saltappPlugin } from "plugin-saltapp";

export const character = {
  // ...
  plugins: [saltappPlugin],
  settings: {
    SALT_HOST: "https://saltapp.ai",
    SALT_APP_ID: process.env.SALT_APP_ID,
    SALT_API_KEY: process.env.SALT_API_KEY,
    SALT_APP_PUBLIC_KEY: process.env.SALT_APP_PUBLIC_KEY,
    SALT_APP_PRIVATE_KEY: process.env.SALT_APP_PRIVATE_KEY,
    SALT_PGP_PASSPHRASE: process.env.SALT_PGP_PASSPHRASE,
  },
};
```

### Getting a Salt agent identity

You need a PGP keypair and a Salt api-key before this plugin can do anything.
The quickest path is `salt-agent-sdk`'s own quickstart (its README has the
full snippet): generate a keypair, then `POST /api/v1/agents` with a human's
api-key to register the agent. Capture `SALT_APP_ID` (the new agent's id) and
`SALT_API_KEY` (rides on that one response only — Salt stores just a digest,
so if you lose it you rotate, you don't re-read it) alongside the keypair.

This plugin runs your agent in **socket mode** by default — it never needs a
public URL or an inbound port; the whole thing is a short-poll loop, adaptively
paced (about once a second right after activity, backing off to about once
every five seconds while idle — Action Cable is the real push path server-side,
this is the fallback/catch-up), so it runs fine on a laptop, a CI box, or
anywhere outbound HTTPS works. The poll cursor and processed-delivery set
persist to `SALT_STATE_DIR` (default `./data/salt/<SALT_APP_ID>`) so a
restart resumes where it left off instead of replaying the retained outbox.

## Settings

| Setting | Required | Default | Description |
| --- | --- | --- | --- |
| `SALT_HOST` | yes | `https://saltapp.ai` | Salt API base URL. |
| `SALT_APP_ID` | yes | — | This agent's Salt account id. |
| `SALT_API_KEY` | yes | — | This agent's api-key. |
| `SALT_APP_PUBLIC_KEY` | yes | — | Armored PGP public key registered with Salt. |
| `SALT_APP_PRIVATE_KEY` | yes | — | Armored PGP private key. See **Custody** below. |
| `SALT_PGP_PASSPHRASE` | yes | — | Passphrase protecting the private key. |
| `SALT_MODE` | no | `socket` | `socket` (short-poll + Action Cable) is the only mode this `Service` runs — see **Webhook mode**. |
| `SALT_AUTO_REPLY` | no | `true` | `false` stores inbound messages as memories but never replies — an observe-only identity. |
| `SALT_ASK_HUMAN_TIMEOUT_SECONDS` | no | `300` | How long `SALT_ASK_HUMAN` waits for a tap. |
| `SALT_VERIFY_SIGNATURES` | no | `true` | Verify the `X-Salt-Signature` HMAC on every delivered update. Disable only against a local dev `salt-api`. |
| `SALT_POLL_TIMEOUT_SECONDS` | no | `2` | Short-poll wait per request, clamped server-side to 0–2s. |
| `SALT_POLL_LIMIT` | no | `50` | Max updates per poll request (1–100). |
| `SALT_STATE_DIR` | no | `./data/salt/<SALT_APP_ID>` | Where the poll cursor and delivery-id dedupe set persist across restarts. |

Values may also be set via env vars of the same name; the character
`settings` block wins (see `@elizaos/core`'s own precedence rules).

## Custody

**Whoever runs this plugin holds the agent's PGP private key, and can
therefore read every chat that agent is in.** That is the same trust model
every Salt agent integration has (`salt-agent-sdk`, `salt-claude-agent`, the
Express `salt-app-example`) — Salt itself never sees plaintext, but your host
does, because decrypting on the agent's behalf is the whole point. Don't run
this plugin somewhere you wouldn't trust with the conversations it's in.

## Why `SALT_ASK_HUMAN` is allowed to block

Every other action in this plugin returns as soon as it's made its one Salt
API call. `SALT_ASK_HUMAN` is the one exception: it posts a card and then
awaits a `Promise` that only resolves when the matching `card_interaction`
event arrives (or `SALT_ASK_HUMAN_TIMEOUT_SECONDS` elapses). That's safe here
specifically because the contract is narrow — one card, one resolver, one
bounded timeout, tracked in `SaltService.cardWaiters` — not because holding a
turn open is generally fine. If you're building a new action, don't reach
for this pattern by default.

A tap that arrives with **no** pending `SALT_ASK_HUMAN` call waiting on it
(the `SALT_POST_CARD` case, or a stale/duplicate delivery) is recorded as a
memory but does not itself trigger a fresh agent turn — see HANDOFF.md.

## Webhook mode

`SALT_MODE=webhook` is accepted by the settings schema (so a character can
declare the intent) but `SaltService` only implements the socket long-poll
loop; setting it throws at connect time. To run a webhook-mode agent today,
run `salt-agent-sdk`'s own `createWebhookServer` alongside this plugin (or
instead of `SaltService`) — see that package's README. Wiring
`createWebhookServer`'s callbacks into the same `runtime.messageService`
bridge this plugin uses is a reasonable follow-up; it wasn't done here to
keep one plugin's `Service` to one transport.

## Development

```bash
npm install
npm install ../salt-agent-sdk   # salt-agent-sdk 0.7.1 isn't on npm yet (only 0.1.0 is) --
                                 # see HANDOFF.md. Use --no-save so package.json keeps
                                 # the intended "^0.7.1" registry range.
npm run typecheck
npm run build
npm test
```

Tests (`src/__tests__/`, Vitest, the same runner the elizaOS plugin
templates use) cover: signature verification (missing/malformed/stale/wrong-
secret/tampered-body rejection), message-envelope parsing, the exact-decimal
invoice math, the card-block/slug builders, each action's `validate`/
`handler` against a mocked `SaltClient` and a mocked `fetch`, and
`SaltService`'s message handling end-to-end through **real** PGP
encrypt/decrypt (not mocked) so a change to the wire shape shows up as a
failing test rather than a silent drop in production.

## Getting listed in the elizaOS registry

See `HANDOFF.md` for the exact PR steps and what elizaOS's maintainers
require.
