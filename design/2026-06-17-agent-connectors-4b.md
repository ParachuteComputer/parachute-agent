# Agent connectors — approval-gated grants (Phase 4b)

**Status:** design (2026-06-17, decided with Aaron in a design conversation). Builds on
[`2026-06-17-vault-native-agents.md`](./2026-06-17-vault-native-agents.md) (4a, shipped).
4a gives an agent its OWN def-vault. **4b lets an agent reach beyond it** — other vaults
(local or remote), remote MCP servers, and external services (GitHub, Cloudflare) — every
extra reach **operator-approved**, every secret **local**, every state **visible**.

## The one invariant
**A vault note can only REQUEST; it can never GRANT.** The `#agent/definition` note
declares what the agent *wants*; the operator approves in the **hub**; the secret is
minted/obtained + stored **on the local filesystem**; the agent module injects it at
spawn. So a note written by anyone can't escalate itself — worst case it sits `pending`.
This is what makes "define agents from any chat" safe even as agents gain real reach.

## Decisions locked (Aaron, 2026-06-17)
- **Approval lives in the HUB**, not in surfaces. Surfaces stay least-privilege (only what
  the hub grants them). The hub's existing **Connections engine** generalizes from
  "event→action triggers" to also **approval-gated resource grants**.
- **Hub becomes a proper OAuth CLIENT** for remote MCPs (it speaks the server side of these
  RFCs already; the client side reuses that). → slice 2.
- **Service creds support BOTH injection shapes** — one stored secret (e.g. a GitHub token),
  injected as an **env var** (for `git`/`gh` in the agent's shell) AND/OR as the service's
  **MCP server** (structured tools). The declaration picks which; the credential is shared.
- **Per-connection approval** (approve `research:read` without approving a remote write).
- **Vault tag-scope is in** — a grant can be narrowed to tags (`vault:research:read` over
  `#published` only), riding the vault's existing tag-scoped tokens (`scoped_tags`).
- **Auto-renew (my call):** OAuth access tokens auto-refresh silently (refresh-token path,
  no re-prompt); grants are durable-until-revoked by default; an optional approval-TTL knob
  (re-prompt after N days) is a later nicety, off by default.
- **Declaration in vault metadata** (give it a shot; iterate if it chafes).

## Noted, NOT built now
- **Asymmetric read/write tag-scope** ("read almost anything, write only `#x`"). The vault's
  tokens can't yet split read vs write by tag — that's a real change in the vault, separate
  work. 4b's model is designed so this slots in later (a connection can name read-tags vs
  write-tags); for now a vault grant's tag-scope applies to its verb uniformly.
- **Scope-in-the-remote-MCP-URL** (Aaron's curiosity) — parked; standard MCP OAuth
  discovery handles auth without it for now.

## The connection declaration (`wants:`)
A comma-separated list in the `#agent/definition` note metadata. Each spec:
- `vault:<name>:<read|write>` — a LOCAL vault (other than the def-vault). Optional tag-scope
  suffix: `vault:research:read#published` (one or more `#tag`). Grant = a hub-minted
  `vault:<name>:<verb>` token (with `scoped_tags` if tags given).
- `mcp:<url>` — a remote MCP (incl. a **remote vault**, which is just a remote MCP). Grant =
  an OAuth token (slice 2) or a named API token. Injected as an MCP server in the agent's
  `--mcp-config`.
- `env:<service>` and/or `mcp:<service>` — a service credential (`github`, `cloudflare`).
  `env:github` → `GITHUB_TOKEN` in the agent's env; `mcp:github` → the GitHub MCP server in
  its `--mcp-config`. Both resolve to the ONE approved credential for that service.

(The own def-vault is implicit — never declared, always granted, scoped to itself.)

If the flat string gets too cramped for the richness (tag lists, inject-modes), fall back to
a JSON array in the metadata value — same fields, more room. Start with the flat string.

## The flow (slice 1 — local vaults + service creds, no OAuth)
1. **Declare** — the note's `wants:` lists connections.
2. **Request** — on (re)instantiate, the agent module resolves each want: own-vault auto;
   each other → register a **pending grant request** with the hub (a grants API on the
   Connections engine), keyed by `(agent, connection)`. Note `status: pending`, `pending:[…]`.
3. **Approve (operator, in hub admin)** — per-connection. On approve, the hub:
   - local vault → **mints** `vault:<name>:<verb>` (+ `scoped_tags`), stores it in the hub's
     grant store (on disk);
   - service cred → stores the operator-provided **API token** (paste) in the grant store;
   - (slice 2) remote MCP → runs the **OAuth consent** + stores access+refresh.
4. **Resolve + inject (at spawn)** — the agent module fetches the agent's APPROVED grants
   from the hub (authenticated with its operator/hub credential) and injects them into the
   per-turn spawn: vault/MCP grants → entries in the agent's `--mcp-config` (`{type:"http",
   url, headers:{Authorization:"Bearer …"}}`); service env creds → env vars. Same 0600
   per-spawn injection path 4a already uses for the Claude token.
5. **Status** — module stamps the note `enabled` once every declared connection is granted,
   else `pending` with the outstanding list. (Uses the 4a `force:true` PATCH.)
6. **Revoke** — operator revokes a grant in hub admin → token dropped from the store → the
   agent loses it on its next spawn; note flips back to `pending` for that connection.

## Grant storage (where the secrets live)
The **hub's** local store holds granted tokens (the hub is the issuer/authority — it minted
or obtained them). The agent module **fetches at spawn** and writes them into the ephemeral
per-spawn `--mcp-config` + env (0600), never into a vault note. So: hub = authority + store;
module = consumer/injector; vault note = declarative request + status. This matches the
hub-module boundary (hub owns identity/issuance; module owns lifecycle).

## Slice 2 — hub as OAuth client (remote vaults / remote MCPs)
The headless problem is only the *one-time consent*. Pattern: **consent once → headless
thereafter.**
- The operator approves a `mcp:<remote-url>` connection in hub admin → the hub, acting as an
  OAuth **client**, runs the auth-code flow against the remote MCP's issuer (RFC 8414/9728
  discovery, RFC 7591 dynamic client registration), with the operator's browser for consent.
- The hub stores the **access + refresh** token in the grant store; **auto-refreshes** before
  expiry (no re-prompt). The agent module injects the current access token at spawn.
- `claude -p` never does an interactive OAuth dance — it just gets a valid Bearer in its
  `--mcp-config`.

## Phasing
- **4b-1 (hub-light, most value):** local-vault grants (tag-scoped) + service-cred grants
  (env + MCP) + per-connection approval in hub admin + the grants API/store + the agent-side
  declare/request/fetch/inject/status. Cross-vault + GitHub/Cloudflare working, no OAuth.
- **4b-2 (the rad one):** hub-as-OAuth-client for remote vaults/MCPs (consent-once + refresh).

## Build coordination
Each slice spans **hub** (Connections→grants, approval surface, mint/obtain/store, grants
API — Aaron merges) and the **agent module** (declare-parse, request, fetch-at-spawn, inject,
status — I merge), aligned by **the wire contract above** (the `wants:` syntax + the grants
API shape). Built in parallel against the contract, integrated + **verified END-TO-END
against the real hub+vault** (4a's lesson: mocked tests miss real-path bugs like the PATCH
428 + the state-dir collision — every slice gets a live grant→inject→use check), reviewer-gated.

## Open / iterate later
- `wants:` flat-string vs JSON-in-metadata (start flat).
- Optional approval-TTL / re-prompt cadence (off by default).
- Asymmetric read/write tag-scope (needs the vault change; model leaves room).
