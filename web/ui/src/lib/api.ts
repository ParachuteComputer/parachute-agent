/**
 * HTTP client for the agent SPA. All calls hit the daemon's JSON API, gated by
 * the hub-minted `agent:admin` Bearer (`lib/auth.ts:getAgentToken`).
 *
 * The list endpoints (Phase 2) surface the three Phase-1 reads and merge them
 * into one agent-centric view; the write paths layer on top: create (Phase 3) and
 * — Phase 4a — edit/delete a def + add/remove a def-vault.
 *
 *   - `GET /agent/api/agents`        — every agent across ALL backends
 *     (interactive / programmatic / channel), with live status.
 *   - `GET /agent/api/agent-defs`    — the vault-native `#agent/definition`
 *     records (the durable defs that instantiate agents).
 *   - `GET /agent/api/agent-vaults`  — the module-level def-vault list
 *     (`agent-vaults.json` — which vaults the module reads defs from).
 *
 * ## API base path
 *
 * The daemon's API lives at the `/agent/api/*` proxied path (the hub strips the
 * `/agent` prefix; the daemon sees `/api/*`). The SPA serves under
 * `import.meta.env.BASE_URL` = `/agent/app/`, so its sibling API is `/agent/api`
 * — derived by swapping the trailing `app/` segment for `api`. In stand-alone
 * dev (`BASE_URL=/`), we fall back to `/agent/api`, which the dev proxy in
 * vite.config.ts forwards to the loopback daemon.
 */
import { clearCachedToken, getAgentToken } from "./auth.ts";

/** Status code carried alongside the message so callers can branch numerically. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Resolve the daemon API base from the SPA mount. `/agent/app/` → `/agent/api`;
 * anything else (dev at origin root) → `/agent/api`, which the vite dev proxy
 * forwards. Origin-absolute, so it resolves correctly regardless of the
 * react-router basename.
 */
export function apiBase(): string {
  const base = import.meta.env.BASE_URL || "/";
  // `/agent/app/` → `/agent/api`. Strip a trailing `app/` (or `app`) and append
  // `api`; if the mount doesn't end in `app`, fall back to the canonical path.
  const m = base.match(/^(.*\/)app\/?$/);
  if (m) return `${m[1]}api`;
  return "/agent/api";
}

/**
 * `fetch` with the agent Bearer attached + a single re-mint-and-retry on 401 —
 * the SPA mirror of `src/ui-kit.ts:authedFetch`. On a clean 401 we drop the
 * cached token, re-mint once, and retry; a persistent 401 surfaces as an
 * `HttpError`.
 */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAgentToken();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status !== 401) return res;
  // Re-mint once and retry. The first mint may have been stale/absent.
  clearCachedToken();
  const fresh = await getAgentToken();
  if (!fresh) return res; // no session — let the caller surface the 401
  const retryHeaders = new Headers(init.headers);
  retryHeaders.set("accept", "application/json");
  retryHeaders.set("authorization", `Bearer ${fresh}`);
  return fetch(path, { ...init, headers: retryHeaders });
}

/** Pull the server `error` (or text) off a non-2xx response for an HttpError. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? "";
  } catch {
    return await res.text().catch(() => "");
  }
}

/** GET a JSON endpoint with the Bearer, throwing HttpError on a non-2xx. */
async function getJson<T>(suffix: string): Promise<T> {
  const res = await authedFetch(`${apiBase()}${suffix}`);
  if (!res.ok) {
    throw new HttpError(res.status, (await errorDetail(res)) || `${suffix} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * POST a JSON body to an endpoint with the Bearer + the same single 401
 * re-mint-and-retry as `getJson`, throwing HttpError on a non-2xx. Used by the
 * Phase-3 create flow (the first write path the SPA carries).
 */
async function postJson<T>(suffix: string, body: unknown): Promise<T> {
  return bodyJson<T>("POST", suffix, body);
}

/**
 * PATCH a JSON body to an endpoint with the Bearer + the same single 401
 * re-mint-and-retry, throwing HttpError on a non-2xx. The Phase-4a def-edit path.
 */
async function patchJson<T>(suffix: string, body: unknown): Promise<T> {
  return bodyJson<T>("PATCH", suffix, body);
}

/**
 * DELETE an endpoint with the Bearer + the same single 401 re-mint-and-retry,
 * throwing HttpError on a non-2xx. No body. The Phase-4a def-delete + def-vault
 * remove paths.
 */
async function deleteJson<T>(suffix: string): Promise<T> {
  const res = await authedFetch(`${apiBase()}${suffix}`, { method: "DELETE" });
  if (!res.ok) {
    throw new HttpError(res.status, (await errorDetail(res)) || `${suffix} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Shared body-bearing-method helper (POST/PATCH) — Bearer + 401 retry + HttpError. */
async function bodyJson<T>(method: "POST" | "PATCH", suffix: string, body: unknown): Promise<T> {
  const res = await authedFetch(`${apiBase()}${suffix}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new HttpError(res.status, (await errorDetail(res)) || `${suffix} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Wire types — mirror the daemon's Phase-1 JSON shapes (snake/camel as the
// daemon emits them; the daemon uses camelCase for these endpoints).
// ---------------------------------------------------------------------------

/** The backend that drives an agent. The primary axis of the v2 view. */
export type AgentBackend = "interactive" | "programmatic" | "channel";

/** Execution-lifecycle mode — the top-level branch. Rides in `metadata.mode`. */
export type AgentMode = "single-threaded" | "multi-threaded";

/**
 * One entry from `GET /agent/api/agents` — the merged all-backends list.
 * Mirrors `AgentInfo` in `src/agents.ts`. Interactive agents carry
 * `attached`/`hasWorkspace`; programmatic/channel agents carry a live `status`
 * and (when vault-native) a `channel` + `vault`.
 */
export interface AgentRow {
  name: string;
  session: string;
  attached: boolean;
  workspace: string;
  hasWorkspace: boolean;
  backend: AgentBackend;
  /** Live status — `idle` | `working` | `queued:N`. Absent for interactive. */
  status?: string;
  /** The wake channel this agent serves (channel-backend; agent == channel). */
  channel?: string;
  /** The def-vault backing this agent's conversation, when known. */
  vault?: string;
  systemPromptMode?: "append" | "replace";
  workingDir?: string;
}

export interface AgentsResponse {
  agents: AgentRow[];
}

/** The resolved liveness of a vault-native def. Mirrors `AgentDefStatus`. */
export type AgentDefStatus = "enabled" | "pending" | "error" | string;

/**
 * One entry from `GET /agent/api/agent-defs` — a vault-native
 * `#agent/definition` record. Mirrors `AgentDefDetail` in `src/agent-defs.ts`.
 */
export interface AgentDefRow {
  /** The vault note id (the create/edit/delete key). */
  noteId: string;
  name: string;
  backend: "programmatic" | "channel";
  /** The execution-lifecycle mode the def declared. */
  mode: AgentMode;
  vault: string;
  status: AgentDefStatus;
  /** Declared connections still pending approval (empty when none). */
  pending: string[];
  /** First ~200 chars of the system prompt — a preview, NOT the full text. */
  systemPromptPreview: string;
  /** Structured `wants:` connection keys (empty when own-vault only). */
  wants: string[];
  /** The wake channel inbound routes to this agent on (== name). */
  channel: string;
}

export interface AgentDefsResponse {
  defs: AgentDefRow[];
}

/**
 * One entry from `GET /agent/api/agent-vaults` — a def-vault binding.
 * `tokenPresent` is a boolean, NEVER the token value.
 */
export interface AgentVaultRow {
  vault: string;
  url: string;
  tokenPresent: boolean;
}

export interface AgentVaultsResponse {
  vaults: AgentVaultRow[];
}

/** List every agent across all backends. */
export function listAgents(): Promise<AgentsResponse> {
  return getJson<AgentsResponse>("/agents");
}

/** List the vault-native agent definitions. */
export function listAgentDefs(): Promise<AgentDefsResponse> {
  return getJson<AgentDefsResponse>("/agent-defs");
}

/** List the module's def-vaults (read-only display). */
export function listAgentVaults(): Promise<AgentVaultsResponse> {
  return getJson<AgentVaultsResponse>("/agent-vaults");
}

// ---------------------------------------------------------------------------
// Create flow (Agent UI v2 — Phase 3). `POST /api/agent-defs` writes a vault-
// native `#agent/definition` note (body = system prompt, metadata = config) and
// auto-instantiates the agent + its channel routing — so the create flow is JUST
// this one call; there is NO separate channel-provisioning step.
// ---------------------------------------------------------------------------

/** The backend selectable in the create flow. `interactive` is RETIRED — not offered. */
export type CreatableBackend = "programmatic" | "channel";

/**
 * The `POST /api/agent-defs` request body. Mirrors the daemon handler at
 * `src/daemon.ts` ~2755-2789. The MODE is NOT a top-level field — it rides in
 * `metadata.mode`; `metadata` is an object of strings (the daemon coerces).
 * `wants` is a comma-separated string (the daemon's `wants:` shape), optional.
 */
export interface CreateAgentDefBody {
  vault: string;
  name: string;
  backend: CreatableBackend;
  systemPrompt: string;
  wants?: string;
  metadata: Record<string, string>;
}

/** `POST /api/agent-defs` 201 response — the created def in the detail shape. */
export interface CreateAgentDefResponse {
  ok: boolean;
  def: AgentDefRow;
}

/**
 * Create a vault-native agent definition. Auto-instantiates the agent + (for a
 * channel backend) its channel inbound routing — one call, no separate channel
 * POST. Throws `HttpError` on a non-2xx (e.g. 400 "no def-vaults configured",
 * 409 name collision) so the form surfaces the daemon's message inline.
 */
export function createAgentDef(body: CreateAgentDefBody): Promise<CreateAgentDefResponse> {
  return postJson<CreateAgentDefResponse>("/agent-defs", body);
}

// ---------------------------------------------------------------------------
// Edit / delete a def (Agent UI v2 — Phase 4a). The list endpoint returns only a
// ~200-char `systemPromptPreview`, which can't pre-fill an edit; `getAgentDef`
// fetches the FULL editable def from `GET /api/agent-defs/<noteId>`. `editAgentDef`
// PATCHes the changed fields (the MODE rides in `metadata.mode`, mirroring create);
// `deleteAgentDef` DELETEs the note (+ deregisters the agent daemon-side).
// ---------------------------------------------------------------------------

/**
 * The FULL editable def `GET /api/agent-defs/<noteId>` returns — mirrors
 * `AgentDefFull` in `src/agent-defs.ts`. Carries the FULL `systemPrompt` (the whole
 * note body, NOT the list's truncated preview) so the edit form pre-fills correctly.
 */
export interface AgentDefFull {
  noteId: string;
  name: string;
  backend: "programmatic" | "channel";
  vault: string;
  mode: AgentMode;
  /** Structured `wants:` connection keys (empty when own-vault only). */
  wants: string[];
  /** The FULL system prompt — the whole note body (NOT truncated). */
  systemPrompt: string;
  status: AgentDefStatus;
}

/** `GET /api/agent-defs/<noteId>` response — the full def under `def`. */
export interface AgentDefFullResponse {
  def: AgentDefFull;
}

/**
 * The `PATCH /api/agent-defs/<noteId>` request body. Mirrors the daemon handler
 * (`src/daemon.ts` PATCH branch): `systemPrompt?` (note body), `wants?` (the
 * comma-separated `wants:` string), `metadata?` (an object of strings — the MODE
 * rides in `metadata.mode`, same as create). Only the provided fields are sent.
 */
export interface EditAgentDefBody {
  systemPrompt?: string;
  wants?: string;
  metadata?: Record<string, string>;
}

/** `PATCH /api/agent-defs/<noteId>` 200 response — the updated def in the detail shape. */
export interface EditAgentDefResponse {
  ok: boolean;
  def: AgentDefRow;
}

/** `DELETE /api/agent-defs/<noteId>` 200 response. */
export interface DeleteAgentDefResponse {
  ok: boolean;
  vault: string;
  name: string;
  removed: boolean;
}

/**
 * Fetch ONE def's FULL editable view (the whole system-prompt body + mode + wants)
 * for the edit form's pre-fill. The noteId is URL-encoded (it may be a path like
 * `Agents/uni-dev`). Throws `HttpError` (404 when the note isn't a live def).
 */
export function getAgentDef(noteId: string): Promise<AgentDefFullResponse> {
  return getJson<AgentDefFullResponse>(`/agent-defs/${encodeURIComponent(noteId)}`);
}

/**
 * Edit a vault-native agent definition: PATCH the changed fields + re-instantiate
 * live. The MODE rides in `metadata.mode` (mirroring create). The noteId is
 * URL-encoded. Throws `HttpError` on a non-2xx (404 unknown, 502 re-instantiate fail).
 */
export function editAgentDef(noteId: string, body: EditAgentDefBody): Promise<EditAgentDefResponse> {
  return patchJson<EditAgentDefResponse>(`/agent-defs/${encodeURIComponent(noteId)}`, body);
}

/**
 * Delete a vault-native agent definition: removes the note + deregisters the agent.
 * The noteId is URL-encoded. Throws `HttpError` on a non-2xx (404 when not a live def).
 */
export function deleteAgentDef(noteId: string): Promise<DeleteAgentDefResponse> {
  return deleteJson<DeleteAgentDefResponse>(`/agent-defs/${encodeURIComponent(noteId)}`);
}

// ---------------------------------------------------------------------------
// Add / remove a def-vault (Agent UI v2 — Phase 4a). `POST /api/agent-vaults`
// mints the vault's write token + persists + loads its defs live; `DELETE
// /api/agent-vaults/<name>` drops it + deregisters its agents. Removing a def-vault
// deregisters every agent defined in it.
// ---------------------------------------------------------------------------

/** The `POST /api/agent-vaults` request body. `url` is optional (defaults to loopback). */
export interface AddAgentVaultBody {
  vault: string;
  url?: string;
}

/** `POST /api/agent-vaults` 201 response — the added vault (no token value). */
export interface AddAgentVaultResponse {
  ok: boolean;
  vault: AgentVaultRow;
}

/** `DELETE /api/agent-vaults/<name>` 200 response. */
export interface RemoveAgentVaultResponse {
  ok: boolean;
  vault: string;
  removed: boolean;
}

/**
 * Add a def-vault the module reads `#agent/definition` notes from. Mints the vault's
 * write token + persists `agent-vaults.json` + loads its defs live. Throws `HttpError`
 * on a non-2xx (400 duplicate / bad slug, 502 mint failure) so the form surfaces it.
 */
export function addAgentVault(body: AddAgentVaultBody): Promise<AddAgentVaultResponse> {
  return postJson<AddAgentVaultResponse>("/agent-vaults", body);
}

/**
 * Remove a def-vault — deregisters every agent defined in it. The name is a path
 * segment (URL-encoded). Throws `HttpError` on a non-2xx (400 when it's the only
 * def-vault, which would orphan the module's vault-native path).
 */
export function removeAgentVault(name: string): Promise<RemoveAgentVaultResponse> {
  return deleteJson<RemoveAgentVaultResponse>(`/agent-vaults/${encodeURIComponent(name)}`);
}

/**
 * The `claude mcp add` one-liner a channel-backend agent's operator runs to
 * connect their own Claude Code session to the channel's MCP endpoint. Mirrors
 * the daemon's server-rendered snippet (`src/daemon.ts:1194-1196`): the channel
 * MCP mounts at `<origin><MOUNT>/mcp/<name>`, where MOUNT is the agent module's
 * proxy prefix (`/agent` over the hub expose, derived from the API base by
 * dropping the trailing `/api`). The agent name IS its channel.
 */
export function connectSessionCommand(name: string, origin: string): string {
  const mount = apiBase().replace(/\/api$/, "");
  // Server-name is `agent-<name>` to match the chat UI's connect snippet
  // (src/daemon.ts ~1194: `var name = "agent-" + ch`), so an operator who connects
  // the same channel from either surface registers ONE consistently-named MCP server.
  // The URL path is the bare channel name (`/mcp/<name>`).
  return `claude mcp add --transport http --scope user agent-${name} ${origin}${mount}/mcp/${name}`;
}
