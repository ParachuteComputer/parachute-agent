# parachute-agent

Vault-native agents for Claude Code. A `#agent/definition` note in a Parachute vault
defines an agent; an inbound message (chat / vault note / scheduled job) becomes a turn;
the reply flows back as an `#agent/message/outbound` note. Telegram today, anything
tomorrow. **Experimental preview (L3)** — near-zero users, breaking changes OK.

## The model: agents + two backends

An agent is a `#agent/definition` note (body = system prompt, metadata = config). Its
**backend** is the axis, and there are exactly two
(design [`2026-06-18-channel-backend.md`](./design/2026-06-18-channel-backend.md)):

- **`programmatic`** (the default) — the daemon runs each turn headless via
  `claude -p --resume` (sandboxed, always-on); the reply is written as an outbound note.
- **`attached`** — turns go to a Claude Code session **you run yourself** (your
  machine/creds, unsandboxed), connected to the channel's MCP endpoint. Inbound notes
  accumulate as a durable queue; your session pulls, works, and replies via MCP tools.

The `interactive` (tmux) backend is retired — `attached` supersedes it (design
[`2026-06-19-retire-interactive-backend.md`](./design/2026-06-19-retire-interactive-backend.md));
the PTY spawner is parked, unmaintained, at
[`src/_parked/interactive-spawn.ts`](./src/_parked/interactive-spawn.ts).

## Architecture

The **daemon** (port 1941, one per machine) is the only process that touches a
transport's external API (e.g. Telegram's getUpdates long-poll — exclusive, no
multi-consumer races). It owns the channel registry, routes inbound by backend
(`programmatic` → `ProgrammaticAgentRegistry`'s serial worker; `attached` →
`AttachedQueueRegistry`'s durable queue), and writes outbound notes. New transports
implement the `Transport` contract in `src/transports/<name>.ts`; the session-facing
MCP contract is unchanged.

A session connects two ways:

- **HTTP MCP (primary)** — add `<hub>/agent/mcp/<channel>` as an HTTP MCP server
  (URL + OAuth, exactly like the vault). `src/mcp-http.ts` serves it and resolves the
  tool surface by the channel's backend: push tools (reply/react/edit/download) or, for
  `attached`, the pull surface (`pending` / `next-message` / `reply` / `release`).
  Tool schemas + the OAuth discovery contract (RFC 9728/8414 path-insertion, mirroring
  vault): read `src/mcp-http.ts`.
- **stdio bridge** (`src/bridge.ts`) — subscribes to the daemon's SSE `/events`,
  forwards events as MCP notifications, proxies tool calls to `/api/*`. Still
  supported; the SPA + launcher steer toward HTTP MCP.

## Why not the official Telegram plugin?

Known upstream bug (anthropics/claude-code#38098, open): every session with the plugin
enabled at any scope auto-spawns a Telegram poller child, even without `--channels` —
the multi-consumer races drop ~50% of messages, and `enabledPlugins` resolution is
session-global, unscopeable. This gateway fixes it by design: one daemon polls, any
number of sessions subscribe.

## Running

- Daemon: `bun src/daemon.ts` (or via the hub supervisor / launchd). It self-registers
  into `~/.parachute/services.json` at boot; hub reverse-proxies `<expose>/agent/*` to
  it; admin SPA at `<hub-origin>/agent/app/` (locally `http://127.0.0.1:1941/agent/app/`).
- Telegram bot tokens are **per-channel** in `~/.parachute/agent/channels.json`
  (written via the SPA or directly) — the daemon does NOT read a global
  `TELEGRAM_BOT_TOKEN`.
- Connect an `attached` session:
  `claude mcp add --transport http agent <hub-origin>/agent/mcp/<channel>` (OAuth
  prompts on first use), then run the pull loop: `pending` → `next-message` (claims the
  oldest inbound, returns the agent's system prompt) → work → `reply { inReplyTo, text }`.
  Claims auto-release after a TTL, so a crashed session never strands the queue.
- Env vars are documented by the code that reads them (grep `process.env` in
  `src/daemon.ts` and friends).

### The `=`-binding flag trap (bridge launch)

`claude --dangerously-load-development-channels=server:parachute-agent` — the `=` is
load-bearing. The space form appears to work in `--print` mode, but in interactive mode
the parser silently swallows the value as the initial-prompt positional and later
surfaces `"server:parachute-agent · no MCP server configured with that name"` — blaming
the wrong suspect (the MCP config is fine; the flag lost its value). Always use the `=`
form ([#8](https://github.com/ParachuteComputer/parachute-agent/issues/8)). A cosmetic
`/mcp` display warning can appear even with the correct flag — expected, ignore (#10).

## Auth

Daemon endpoints take hub-issued JWTs (`aud: agent`, scopes `agent:read/write/send/admin`)
validated via `@openparachute/scope-guard` against the hub's JWKS — shared `requireScope`
in `src/auth.ts`. The bridge presents the launcher-minted `PARACHUTE_AGENT_TOKEN`; the
chat UI bootstraps a short-TTL token from the hub (`GET <hub-origin>/admin/agent-token`,
cookie-gated). Browser SSE streams authenticate with a single-use ~60s ticket
(`src/ui-ticket.ts`) so the JWT never rides a URL; the legacy `?token=` SSE path is gone.

**Gotcha:** on any exposed box the daemon must have `PARACHUTE_HUB_ORIGIN` set to the
hub's *public* origin (token-`iss` validation; the loopback fallback is dev-only).
Hub-as-supervisor sets it — and `PARACHUTE_HUB_ORIGINS` for multi-origin boxes.

### Step-up PIN — hard rules (agent#80)

The dangerous actions require a **step-up token** IN ADDITION to `agent:admin`:
**set-credentials** (`/api/credentials/*` — can exfiltrate vault/channel/Claude tokens),
the **terminal** WebSocket (raw host shell), and the **`filesystem: "full"` spawn**
(whole-disk read). Ordinary sandboxed spawns and all reads stay frictionless.

- The gate (`requireStepUp`, `src/auth.ts`) is enforced SERVER-side. A miss returns
  `403 { error: "step_up_required", reason: "setup"|"token" }` — distinct from a plain
  401 — so the SPA prompts (first-time setup vs PIN entry) instead of re-authing.
- The PIN (4–12 digits, convenience-grade by design) is argon2id-hashed
  (`Bun.password`) in `~/.parachute/agent/step-up.json`, mode 0600 (`src/step-up.ts`).
  `POST /api/step-up { pin }` is rate-limited (5 wrong → 5-min lockout) and mints an
  opaque CSPRNG nonce (~5-min TTL, server-side map, reusable within its window).
- The token rides `X-Step-Up-Token` (`?step_up=` only for the terminal WS, which can't
  set headers). It NEVER widens scope — a second factor on top of `agent:admin`, never
  a substitute. The PIN is never logged or returned.
- Fresh upgrade: no PIN exists yet, so the first gated action returns
  `403 (reason: "setup")` — set one via the admin UI or `POST /api/step-up/pin { newPin }`.

## Vault-backed channels (Stage 2)

A `vault` transport backs channels with notes in the module-owned `#agent/*` namespace;
the routing key is `metadata.agent` (post channel→agent rename, #133). Trap: a slash in
a tag name is a namespace convention, NOT query inheritance — every message note carries
BOTH the parent `#agent/message` (queryable) and a directional child, and the vault
trigger fires on `#agent/message/inbound` only, so an outbound reply can never wake its
own session. Full protocol (note shape, trigger YAML, webhook flow):
[`design/2026-06-17-vault-native-agents.md`](./design/2026-06-17-vault-native-agents.md)
+ `src/transports/vault.ts`.

## `#agent/thread` — the thread record

Unified model: `definition → thread → message`. Every completed turn materializes an
`#agent/thread` note — body is a rolling summary, metadata is the thread state including
the Claude `session` UUID (the thread note IS the session record; there is no separate
session store). `single-threaded` upserts one deterministic note per channel;
`multi-threaded` writes one per fire. The note carries `['#agent/thread']` EXACTLY —
never a message tag — so it can never wake a session. Detail:
[`design/2026-06-18-agent-ui-v2-and-reactivity.md`](./design/2026-06-18-agent-ui-v2-and-reactivity.md).

## No silent message loss (the high-water-mark rule)

MCP sessions drop on daemon restart, and an inbound that lands with zero live
subscribers reaches no one — yet the vault trigger acks and never re-fires. The
guarantee (`src/delivery-state.ts`): a per-channel high-water-mark (persisted in
`~/.parachute/agent/delivery-state.json`) advances ONLY on a real delivery (≥1 live
subscriber) — a 0-subscriber emit deliberately leaves it behind — and on (re)connect the
daemon replays inbound newer than the mark (vault channels, oldest-first, capped at 50)
to that one new subscriber. The mark is monotonic; a channel with no persisted mark
defaults to daemon boot time, so a first connect never replays ancient history. When
touching emit/delivery paths, preserve this invariant. (`markSeen` webhook dedup is
orthogonal — it prevents double-wakes, not loss.)

## Access control (`access.json`)

Schema-compatible with the official plugin, plus the `allowInChats` extension. DMs
(positive chat_id, `chat.id === user_id`) require BOTH `allowFrom` AND `allowInChats`
(when present — list a user's id in both to allow their DM). Groups (negative chat_id)
listed in `allowInChats` admit ANY member — `allowFrom` is bypassed, by design for
shared spaces. **An empty `allowInChats: []` is fail-closed** (no chats allowed); omit
the field for user-allowlist-only gating.
