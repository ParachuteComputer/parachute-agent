# parachute-channel

Messaging gateway for Claude Code. Telegram today, anything tomorrow.

## Architecture

Two components — daemon and bridge — connected by SSE:

```
Telegram API
    ↕ getUpdates / sendMessage / etc.
daemon (port 1941, long-running, one per machine)
    ↕ SSE for inbound, HTTP for outbound
bridge (stdio MCP, spawned per-session by Claude Code)
    ↕ stdio MCP notifications + tools
Claude Code session
```

The **daemon** is the only process that touches the Telegram API. It owns the getUpdates long-poll exclusively — no multi-consumer races by construction. Multiple bridges can connect simultaneously.

The **bridge** is a stateless MCP server that Claude Code spawns as a subprocess. It declares `claude/channel` capability so Claude Code registers a notification listener. It connects to the daemon's SSE `/events` stream and forwards each event as a `notifications/claude/channel` MCP notification. Outbound tool calls (reply, react, edit, download) proxy to the daemon's HTTP API.

## Why not the official telegram plugin?

The official plugin has a known bug (anthropics/claude-code#38098, open): every Claude Code session with the plugin enabled at any scope auto-spawns a Telegram poller child, even without `--channels`. This causes multi-consumer races that drop ~50% of messages. The plugin system's `enabledPlugins` resolution is session-global and can't be scoped to one session. This gateway solves the problem by design: one daemon, any number of bridges.

## Running

### Daemon (start once, runs forever)

```bash
bun src/daemon.ts
# or via launchd — see below
```

Telegram channels carry a per-channel bot token in `channels.json` config — the daemon does NOT read a global `TELEGRAM_BOT_TOKEN`. Define channels via the admin UI at `/channel/admin` (or by writing `~/.parachute/channel/channels.json` directly).

### Bridge (registered in .mcp.json, Claude Code spawns it)

Registered in `~/UnforcedAGI/.mcp.json`:
```json
{
  "mcpServers": {
    "parachute-channel": {
      "command": "bun",
      "args": ["<path>/src/bridge.ts"],
      "env": { "PARACHUTE_CHANNEL_URL": "http://127.0.0.1:1941" }
    }
  }
}
```

Launch Claude Code with:
```bash
claude --dangerously-load-development-channels=server:parachute-channel
```

The `=` binding is load-bearing. Space-separating the value (`--dangerously-load-development-channels server:parachute-channel`) works in `--print` mode but in interactive mode the parser swallows `server:parachute-channel` as the initial-prompt positional, leaving the flag with an empty channels list. At runtime this surfaces as `"server:parachute-channel · no MCP server configured with that name"`, which points operators at the wrong suspect (the MCP config is fine; the flag-parser is what dropped the value). Always use the `=` form — it's unambiguous in every mode. See [#8](https://github.com/ParachuteComputer/parachute-channel/issues/8).

If you hit an adjacent issue:
- The bridge now warns on stderr if the capability isn't registered, so this misconfig surfaces immediately instead of looking like everything is fine until a message arrives — see [#9](https://github.com/ParachuteComputer/parachute-channel/issues/9).
- A cosmetic `/mcp` display warning may appear even with the correct flag — expected, ignore. See [#10](https://github.com/ParachuteComputer/parachute-channel/issues/10).

## Sessions (launcher scripts)

The module is now a **fabric**: one daemon hosts named channels (each bound to a
transport — `telegram`, `http-ui`, …), and each Claude Code session runs a bridge
subscribed to one channel by name (`PARACHUTE_CHANNEL_NAME`). Full design + status:
[`PLAN.md`](./PLAN.md).

Spin a session up wired to a channel with one command:

```bash
./scripts/launch-session.sh <name> <channel>   # e.g. aaron aaron
./scripts/list-sessions.sh                      # running sessions + per-channel client counts
./scripts/stop-session.sh <name>
```

`launch-session.sh` is idempotent, writes the session's `.mcp.json` + a reinforcing
`CLAUDE.md` (so it always replies via the `reply` tool), auto-accepts the first-launch
prompts (folder-trust + dev-channels), and waits for the bridge to attach. Override the
daemon with `PARACHUTE_CHANNEL_URL` (default `http://127.0.0.1:1941`). `<name>`/`<channel>`
must be slugs (alphanumeric/dash/underscore).

**Note:** launched sessions run `claude --dangerously-skip-permissions` — the session has
full machine access. Acceptable for an owner-operated, trusted-network box today;
hub-scoped JWT auth (for the UI) and VM/Docker session isolation (for the session itself)
are the planned hardening steps.

## Hub integration

Channel self-registers into `~/.parachute/services.json` at boot and ships
`.parachute/module.json`, so hub lists it in the portal and reverse-proxies
`<expose>/channel/*` → the loopback daemon (`stripPrefix:true`; SSE survives the proxy).
The built-in chat UI is reachable at `<hub-origin>/channel/ui` over the expose, and at
`http://127.0.0.1:1941/ui` locally.

## Connecting a session over HTTP MCP (primary)

A Claude Code session connects to a channel as a **pure HTTP MCP server** — by URL +
OAuth, exactly like adding the vault. No local `.mcp.json` pointing at `bun src/bridge.ts`,
no machine-local file: the session adds `<hub-origin>/channel/mcp/<channel>` and the daemon
serves a stateful Streamable-HTTP MCP endpoint (`src/mcp-http.ts`) that pushes the idle-wake
`notifications/claude/channel` onto the session's SSE stream.

```bash
claude mcp add --transport http channel <hub-origin>/channel/mcp/<channel>
```

It prompts for OAuth the first time (like the vault). Discovery is RFC 9728 + RFC 8414, in
the **path-insertion** form a Claude Code HTTP-MCP client probes (mirrors vault's
`src/oauth-discovery.ts`), served PUBLIC (no auth) by the daemon:

- `GET /.well-known/oauth-protected-resource/mcp/<channel>` → `resource` (the public MCP
  URL, built from `X-Forwarded-Host`), `authorization_servers: [<hub-origin>]`,
  `scopes_supported: ["channel:read","channel:write"]`, `bearer_methods_supported: ["header"]`.
- `GET /.well-known/oauth-authorization-server/mcp/<channel>` → forwarder pointing
  `authorization_endpoint` / `token_endpoint` / `registration_endpoint` / `jwks_uri` at the hub.
- A no/invalid-bearer `POST /mcp/<channel>` returns **401 + `WWW-Authenticate: Bearer
  resource_metadata="…/.well-known/oauth-protected-resource/mcp/<channel>"`** — the signal a
  spec OAuth client follows to start the flow. (Only `/mcp/*` carries the challenge; `/events`
  + `/api/*` stay plain 401.)

The built-in chat UI's "Connect a session" panel now shows this one-liner (computed from
`window.location.origin` so it's the hub origin over the expose). `scripts/launch-session.sh`
writes the session's `.mcp.json` as an HTTP server config (`{ "type": "http", "url": …,
"headers": { "Authorization": "Bearer <minted-token>" } }`) for the headless/local launch —
the minted token is the header; remote/manual users go through OAuth.

The stdio `bridge.ts` over `/events` + `/api/*` still works (Layer 1 below) — the HTTP MCP
endpoint is **additive**, and is now the path the UI + launcher steer toward.

## Auth

**Layer 1 — session↔channel (done).** The bridge-facing daemon endpoints (`GET /events`,
`POST /api/{reply,react,edit,permission,download}`) require a hub-issued JWT (`aud: channel`,
scope `channel:read`/`channel:write`), validated via `@openparachute/scope-guard` against the
hub's JWKS — exactly like a vault MCP client. The launcher mints the token
(`parachute auth mint-token --scope "channel:read channel:write"`) and injects it as
`PARACHUTE_CHANNEL_TOKEN`; the bridge presents it as a Bearer. Any session on any machine
connects this way — no loopback trust.

The daemon **must** have `PARACHUTE_HUB_ORIGIN` set to the hub's *public* origin (the hub stamps
that as the token `iss`); the loopback fallback is dev-only. Hub-as-supervisor sets this when it
starts the module; a manually-run daemon on an exposed box needs it in the environment.

**Layer 2 — human↔UI (done).** The chat-UI traffic endpoints (`POST /api/channels/<name>/send`
→ scope `channel:send`; `GET /ui/events` → scope `channel:read`) require a hub-issued JWT,
validated the same way as Layer 1 (shared `requireScope` in `src/auth.ts`). The token comes from
a hub endpoint — `GET <hub-origin>/admin/channel-token` (cookie-gated to the logged-in portal
operator), returning `{ token, expires_at, scopes }` with `aud:channel` + `channel:read channel:send`,
~10min TTL. The chat page fetches it on load (`credentials: "include"`) and attaches it: a Bearer
header on the send POST, and a `?token=` query param on the `/ui/events` EventSource (which can't
set headers). On a 401/SSE-error it re-fetches once and retries. `/ui`, `/health`, and
`/.parachute/config[/schema]` stay OPEN — the page must load to bootstrap its token fetch, and the
config listing is non-sensitive.

## Vault integration (Stage 2) — channels backed by `#channel-message` notes

A `vault` transport backs a channel with notes in a Parachute vault, so messages
are durable, queryable, and a vault surface can render them. Multiple channels per
vault: the note's `channel` metadata routes it.

**Note shape** — TWO tags per note, carried literally (two orthogonal axes):
- the parent `#channel-message` — the QUERYABLE membership tag. A UI lists a channel's
  whole transcript (both directions) with one `tag: "#channel-message"` + `metadata.channel`
  query, because the parent is literally on every note.
- a directional child — the trigger DISCRIMINATOR: `#channel-message/inbound` (human→session)
  or `#channel-message/outbound` (session reply).

**The slash is a namespace, NOT query inheritance.** In a Parachute vault a slash in a tag
NAME is a namespace convention only — `query-notes { tag: "#channel-message" }` matches
descendants by the `tags.parent_names` graph (declared via `update-tag`), NOT by name-prefix.
A note tagged ONLY `#channel-message/inbound` is INVISIBLE to a `tag: "#channel-message"`
query unless that inheritance was separately declared — so we tag BOTH the parent and the
child and don't depend on per-vault schema setup.

Content = the message text; metadata: `{ channel, direction: "inbound"|"outbound", sender,
in_reply_to (outbound), ts }`. Loop avoidance lives in the TAG, not metadata: the trigger
fires on the inbound child tag only (exact match), which an outbound note never carries, so a
reply never wakes its own session. **Inbound notes MUST carry BOTH `#channel-message` (parent,
makes it queryable) AND `#channel-message/inbound` (child, fires the trigger), with the channel
name in `metadata.channel`.** Outbound notes carry `#channel-message` + `#channel-message/outbound`.

**Flow.** INBOUND (human→session): a new `#channel-message` + `#channel-message/inbound` note →
a vault **trigger** POSTs a webhook → the channel daemon's `POST /api/vault/inbound` → routes by
`note.metadata.channel` → `ctx.emit` wakes the session (fans to SSE bridges + HTTP-MCP sessions
alike). OUTBOUND (session→human): the session's `reply` writes a `#channel-message` +
`#channel-message/outbound` note via the vault REST API (`POST <vaultUrl>/vault/<vault>/api/notes`,
Bearer `vault:<name>:write`).

**channels.json** (the channel side):
```json
{ "name": "eng", "transport": "vault",
  "config": { "vault": "default", "vaultUrl": "http://127.0.0.1:1940",
              "token": "<vault:default:write JWT>", "webhookSecret": "<shared secret>" } }
```

**Vault side** (operator config — activates the inbound trigger):
1. (Optional, for indexed queries) declare the `#channel-message` tag schema with
   indexed `channel`/`direction`/`sender` fields (`update-tag`).
2. Add a trigger to the vault's `config.yaml` that fires on new inbound notes and
   webhooks the channel daemon. Loop avoidance is by tag: the vault predicate does
   EXACT tag membership, so firing on the inbound CHILD tag (`#channel-message/inbound`)
   never matches an outbound (reply) note — which carries `#channel-message/outbound`,
   not the inbound child — so no `missing_metadata` clause is needed. (Both directions
   also carry the parent `#channel-message`, but the trigger keys on the child only.)
   ```yaml
   triggers:
     - name: channel_inbound
       events: ["created"]
       when:
         tags: ["#channel-message/inbound"]
         has_metadata: ["channel"]
         missing_metadata: ["channel_inbound_rendered_at"]
       action:
         webhook: "http://127.0.0.1:1941/api/vault/inbound?secret=<shared secret>"
         send: "json"
   ```
   The shared secret rides in the URL — vault doesn't sign webhooks yet; a hub-JWT
   auth block on the trigger is a follow-up. The daemon defends in depth too:
   `ingestInbound` drops any note tagged `#channel-message/outbound`, so a reply can
   never wake its own session.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | (unset) | **Highest-priority port input** — the hub supervisor injects this from the module's services.json `entry.port` (the canonical pattern vault/scribe follow). The daemon binds AND self-registers this port, so the supervisor's readiness probe + `/channel/*` proxy target agree (channel#41). Empty/non-numeric falls through. |
| `PARACHUTE_CHANNEL_PORT` | `1941` | Daemon HTTP port — back-compat override for a daemon run *outside* the supervisor. Used only when `PORT` is unset. |
| `PARACHUTE_CHANNEL_URL` | `http://127.0.0.1:1941` | Bridge → daemon URL |
| `PARACHUTE_CHANNEL_STATE_DIR` | `~/.parachute/channel` | Token, access config, inbox |
| `PARACHUTE_HUB_ORIGIN` | `http://127.0.0.1:1939` | **Daemon:** hub's public origin for JWT `iss` validation. Required on an exposed deployment (the loopback default is dev-only); hub-as-supervisor sets it. |
| `PARACHUTE_CHANNEL_TOKEN` | (none) | **Bridge:** hub-issued channel JWT presented as Bearer. The launcher mints + injects it; unset = no auth header (dev only). Default mint TTL is the hub's non-ephemeral default (~90d); re-launch re-mints. |

## State directory

`~/.parachute/channel/`:
- `channels.json` — the channel registry. Each telegram channel carries its own bot token in `config.token` (created via the admin UI or written directly).
- `.env` — optional generic env vars (e.g. `PARACHUTE_HUB_ORIGIN`). The daemon no longer consumes `TELEGRAM_BOT_TOKEN` here.
- `access.json` — allowlist (compatible with the official plugin's format)
- `inbox/` — downloaded attachments
- `delivery-state.json` — per-channel last-delivered high-water-mark (`{ "<channel>": "<iso-ts>" }`), the spine of the no-silent-loss guarantee (below). Cheap, monotonic, write-through; losing it only costs a bounded re-replay.

## No silent message loss (delivery high-water-mark + backlog replay)

A connected vault-backed session used to go silently deaf after a daemon restart: MCP sessions drop on restart and only reconnect on the next interaction, and an inbound that lands with **zero** live subscribers reaches no one — yet the vault trigger acks success and stamps `..._rendered_at`, so it never re-fires. The message stays durable in the vault but is lost from the live wake.

The fix (`src/delivery-state.ts`):
- **Per-channel high-water-mark** — the ISO `ts` of the last inbound we actually delivered to ≥1 live subscriber. `contextFor.emit` advances it ONLY on a real delivery (SSE client count + MCP session count > 0); a 0-subscriber emit deliberately leaves the mark behind so the message replays later. Monotonic (never rewinds), persisted to `delivery-state.json`. A channel with no persisted mark defaults to the **daemon boot time** — so a first connect never replays ancient history, only the genuine deaf-window gap.
- **Backlog replay on (re)connect** (`replayBacklog`, VAULT channels only) — when an MCP session registers or an SSE bridge reopens `/events`, the daemon loads the channel transcript (reusing the index-free `loadTranscript`), replays the inbound messages newer than the mark — oldest-first, capped at the newest 50 — to **that one new subscriber only** (a per-session MCP push / a write to that one SSE stream, so existing subscribers aren't re-woken), then advances the mark.

`markSeen` (the webhook idempotency dedup that prevents the N-trigger fan-out from double-waking) is unchanged and orthogonal — the backlog path is gated by the mark, not by `markSeen`.

## Access control (`access.json`)

Schema is compatible with the official Telegram plugin, plus one parachute-channel extension: `allowInChats`.

| Field | Type | Description |
|---|---|---|
| `dmPolicy` | `"open" \| "pairing" \| "allowlist"` | `"open"` disables all gating. Anything else requires `allowFrom`. |
| `allowFrom` | `string[]` | User-ID allowlist. Matches `msg.from.id` / `cq.from.id`. |
| `allowInChats` | `string[]` (optional) | **Optional** chat-ID allowlist. For DMs, it's an AND gate with `allowFrom`. For **groups** (negative chat_id), inclusion grants entry to any group member — `allowFrom` is bypassed so shared spaces don't need every participant enumerated. |
| `groups`, `pending` | — | Used by the official plugin's pairing flow; read but not otherwise acted on here. |

### `allowInChats` semantics

- **Absent** → behave as today (user-allowlist only, no per-chat gating). Backwards-compatible.
- **Present with entries** →
  - **DMs** (positive chat_id, equals user_id): require BOTH `allowFrom` AND `allowInChats` to include the id.
  - **Groups** (negative chat_id): inclusion in `allowInChats` grants entry to any group member. `allowFrom` is bypassed. This is the intended way to let the bot participate in shared spaces without enumerating every member.
- **Present but empty (`[]`)** → **fail-closed**: no chats allowed. If you want user-only gating, omit the field rather than setting it to `[]`.

Private DMs to the bot have `chat.id === user_id` (Telegram convention). To permit a user's DM while gating groups, list their user ID in `allowInChats` too:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["1190596288"],
  "allowInChats": ["1190596288", "-1003765557903"],
  "groups": {},
  "pending": {}
}
```

## MCP tools exposed to Claude

| Tool | Description |
|---|---|
| `reply` | Send text + file attachments to a chat. Images → photos, .ogg → voice, others → documents. |
| `react` | Add emoji reaction to a message |
| `edit_message` | Edit a previously sent message |
| `download_attachment` | Download a Telegram file by file_id, returns local path |

## Testing

```bash
# Health check
curl http://127.0.0.1:1941/health

# Send a test message
curl -X POST http://127.0.0.1:1941/api/reply \
  -H "content-type: application/json" \
  -d '{"chat_id":"<CHAT_ID>","text":"hello from parachute-channel"}'
```

## Future

The daemon + bridge split makes adding new backends straightforward:
- Discord: add `src/discord/` with a Discord gateway poller, register alongside telegram
- SMS/iMessage: same pattern
- Custom web frontend: same pattern — the bridge doesn't change

The bridge's MCP contract (`notifications/claude/channel` + tool surface) stays the same regardless of backend.

## Post-merge hygiene

When a PR is merged, locally:

```
git checkout main && git pull
```

Channel's steward does this already — captured here so it's durable and matches the convention now documented across every Parachute repo. Caught 2026-04-21 across vault/lens/scribe/cli where it wasn't being done.
