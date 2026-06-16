/**
 * Per-channel Claude OAuth credential store (design §6).
 *
 * The Claude `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, the documented
 * 1-year headless/CI auth path) is the credential a launched agent session runs
 * on — injected into the sandbox at launch as the session's auth (NEVER
 * `ANTHROPIC_API_KEY`, which would silently route onto API billing; see
 * `spawn-agent.ts`). This module persists that secret, following the SAME
 * file-store discipline `registry.ts` uses for per-channel transport tokens:
 * a read-modify-write JSON file, written 0600 and `chmod`-ed 0600 unconditionally
 * (so an existing file created under a looser umask is tightened on every write).
 *
 * Two principal levels (design §6 — "default one operator token; per-channel
 * override"):
 *
 *   - a **default / operator-level** token, used when a channel has no override,
 *   - a **per-channel override**, the multi-principal seam (multi-user isn't a
 *     rewrite — just populating per-channel, eventually per-principal, tokens).
 *
 * Resolution (`resolveClaudeCredential`): channel override ?? default ?? error.
 *
 * The secret lives in its OWN file (`credentials.json`), separate from
 * `channels.json`: the default/operator token isn't tied to any single channel,
 * and the credential lifecycle (set the operator token once, override per
 * channel) is distinct from the channel-registry lifecycle. The file is
 * NAMESPACED by credential type (`{ claude: { ... } }`) so a future credential
 * type can coexist without a schema migration.
 *
 * Redaction discipline: the raw token is NEVER returned by the listing/inspection
 * helper (`describeClaudeCredentials`) and NEVER logged — exactly the posture the
 * config API + transports already keep for `config.token` / `webhookSecret`.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { defaultStateDir } from "./registry.ts";

/** The Claude-credential slice of the store. */
export interface ClaudeCredentialStore {
  /** Default / operator-level OAuth token, used when a channel has no override. */
  default?: string;
  /** Per-channel overrides, keyed by channel name. */
  channels?: Record<string, string>;
}

/**
 * The generic per-channel ENVIRONMENT-VARIABLE slice (`env`). Same two-principal
 * shape as the Claude slice (an operator-level default layer + per-channel
 * overrides), but each layer is a NAME→VALUE map rather than a single token: an
 * operator scopes a channel's spawned agent a `GH_TOKEN`, `CLOUDFLARE_API_TOKEN`,
 * etc. {@link resolveChannelEnv} flattens the two layers into one map (channel
 * wins) at spawn time, and {@link buildAgentChildEnv} (spawn-agent.ts) merges that
 * into the sandboxed child's env so the agent's `gh`/`git`/build tooling sees the
 * tokens — while Claude's own auth (`CLAUDE_CODE_OAUTH_TOKEN`) stays untouched.
 */
export interface ChannelEnvStore {
  /** Operator-level default env vars, used by every channel (lowest precedence). */
  default?: Record<string, string>;
  /** Per-channel env overrides, keyed by channel name (wins over the default). */
  channels?: Record<string, Record<string, string>>;
}

/** The on-disk `credentials.json` shape (namespaced by credential type). */
export interface CredentialsFile {
  claude?: ClaudeCredentialStore;
  /** Generic per-channel env-var injection (the GH_TOKEN/CLOUDFLARE_* slice). */
  env?: ChannelEnvStore;
}

/**
 * Env-var names that MUST NEVER be settable through the env store — they'd break
 * the module's two load-bearing guarantees:
 *
 *   - `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` would route the spawned session onto
 *     METERED API billing instead of the interactive subscription (the exact thing
 *     `buildAgentChildEnv` deliberately scrubs — see spawn-agent.ts §6).
 *   - `CLAUDE_CODE_OAUTH_TOKEN` is the session's MANAGED auth, resolved per-channel
 *     from the Claude slice; letting the generic env store override it would let an
 *     operator (or a future less-trusted caller) silently swap the session's
 *     identity out from under the credential resolver.
 *
 * The setters REJECT these (throw {@link DenylistedEnvError}); the injection step
 * (`buildAgentChildEnv`) ALSO drops them defensively, so even a hand-edited
 * credentials.json can't smuggle one through.
 *
 * `PATH`/`HOME` are deliberately NOT denylisted: `buildAgentChildEnv` layers the
 * resolved channel env UNDER its own structural passthrough + the seeded-HOME
 * overrides, so a channel-set PATH/HOME can't clobber the sandbox's own (the
 * passthrough copies the real PATH/HOME after, and seedAgentHome's CLAUDE_CONFIG_DIR
 * /XDG/TMP win last). Rejecting them would only deny a harmless no-op; allowing
 * them keeps the denylist focused on the keys that actually matter (the Claude-auth
 * trio). See the layering comment in `buildAgentChildEnv`.
 */
export const DENYLISTED_ENV: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

/** A basic POSIX-ish env-var name guard (letters/digits/underscore, no leading digit). */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Thrown when a setter is asked to set/override a denylisted env-var name. */
export class DenylistedEnvError extends Error {
  constructor(name: string) {
    super(
      `env var "${name}" is not settable here: it controls Claude auth / billing ` +
        `(ANTHROPIC_API_KEY, CLAUDE_API_KEY, CLAUDE_CODE_OAUTH_TOKEN are reserved by ` +
        `the managed subscription-billing path). Set the Claude credential via ` +
        `POST /api/credentials/claude instead.`,
    );
    this.name = "DenylistedEnvError";
  }
}

/** The default credential reference an unspecified spec resolves against. */
export const DEFAULT_CREDENTIAL_REF = "operator" as const;

/** Absolute path to the credentials.json store in a state dir. */
export function credentialsFilePath(stateDir?: string): string {
  return join(stateDir ?? defaultStateDir(), "credentials.json");
}

/**
 * Read `credentials.json` as a plain `CredentialsFile`. Returns an empty `{}` if
 * the file is absent. Mirrors `registry.readChannelsFile` — the read half of the
 * read-modify-write the setters use.
 */
export function readCredentialsFile(stateDir?: string): CredentialsFile {
  const file = credentialsFilePath(stateDir);
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8")) as CredentialsFile;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`credentials: ${file} must be a JSON object`);
  }
  return parsed;
}

/**
 * Persist the store back to `credentials.json` with 0600 perms — the file holds
 * the Claude OAuth secret. Creates the state dir if needed. `chmod`s 0600
 * unconditionally (writeFileSync's `mode` only applies on CREATE, so an existing
 * file created under a looser umask is tightened on every write) — the exact
 * discipline `registry.upsertChannelEntry` keeps for the secret-bearing
 * channels.json.
 */
function writeCredentialsFile(file: CredentialsFile, stateDir?: string): void {
  const dir = stateDir ?? defaultStateDir();
  mkdirSync(dir, { recursive: true });
  const path = credentialsFilePath(dir);
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Set the default / operator-level Claude OAuth token. Used by any channel that
 * has no per-channel override. Read-modify-write so existing per-channel
 * overrides are preserved.
 */
export function setDefaultClaudeCredential(token: string, stateDir?: string): void {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("credentials: a non-empty token is required");
  }
  const file = readCredentialsFile(stateDir);
  const claude = file.claude ?? {};
  claude.default = token;
  file.claude = claude;
  writeCredentialsFile(file, stateDir);
}

/**
 * Set a per-channel Claude OAuth override. Wins over the default for that channel.
 * Read-modify-write so the default + other channels' overrides are preserved.
 */
export function setChannelClaudeCredential(
  channel: string,
  token: string,
  stateDir?: string,
): void {
  if (typeof channel !== "string" || channel.length === 0) {
    throw new Error("credentials: a channel name is required");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("credentials: a non-empty token is required");
  }
  const file = readCredentialsFile(stateDir);
  const claude = file.claude ?? {};
  const channels = claude.channels ?? {};
  channels[channel] = token;
  claude.channels = channels;
  file.claude = claude;
  writeCredentialsFile(file, stateDir);
}

/**
 * Remove a per-channel override (the channel falls back to the default after
 * this). Returns true if an override existed, false if there was nothing to
 * remove. The default token is untouched.
 */
export function removeChannelClaudeCredential(channel: string, stateDir?: string): boolean {
  const file = readCredentialsFile(stateDir);
  const channels = file.claude?.channels;
  if (!channels || !(channel in channels)) return false;
  delete channels[channel];
  writeCredentialsFile(file, stateDir);
  return true;
}

/** Thrown when neither a per-channel override nor a default token is configured. */
export class CredentialNotConfiguredError extends Error {
  constructor(channel: string) {
    super(
      `no Claude credential for channel "${channel}": set a per-channel override or the ` +
        `default/operator token (POST /api/credentials/claude). Get one with ` +
        `\`claude setup-token\`.`,
    );
    this.name = "CredentialNotConfiguredError";
  }
}

/**
 * Resolve the Claude OAuth token a session on `channel` should run on:
 *
 *   channel override ?? default ?? throw CredentialNotConfiguredError
 *
 * Read at resolve time (not cached) so a token set/rotated via the config API
 * takes effect on the next spawn without a daemon restart — the dynamic-read
 * discipline. Throwing (rather than returning empty) means a misconfigured
 * install fails loud BEFORE a session launches with no auth.
 */
export function resolveClaudeCredential(channel: string, stateDir?: string): string {
  const claude = readCredentialsFile(stateDir).claude;
  const override = claude?.channels?.[channel];
  if (override) return override;
  const fallback = claude?.default;
  if (fallback) return fallback;
  throw new CredentialNotConfiguredError(channel);
}

/**
 * Describe the credential store for an operator-facing read WITHOUT leaking the
 * secret: whether a default is set, and which channels carry an override (names
 * only). The raw token is never returned — same redaction posture the config
 * API keeps for transport tokens. (`GET /api/credentials/claude`.)
 */
export function describeClaudeCredentials(
  stateDir?: string,
): { defaultSet: boolean; channels: string[] } {
  const claude = readCredentialsFile(stateDir).claude;
  return {
    defaultSet: Boolean(claude?.default),
    channels: Object.keys(claude?.channels ?? {}).sort(),
  };
}

// ---------------------------------------------------------------------------
// Generic per-channel env-var store (the GH_TOKEN / CLOUDFLARE_API_TOKEN slice).
//
// Mirrors the Claude helpers exactly: read-modify-write JSON, 0600 + unconditional
// chmod, sibling-preserving, dynamic-read-at-resolve. A `null`/`undefined` channel
// targets the operator-level DEFAULT layer; a channel name targets that channel's
// override layer. Every setter enforces DENYLISTED_ENV (the Claude-auth trio) so
// the subscription-billing guarantee can't be subverted via this surface.
// ---------------------------------------------------------------------------

/** Validate an env-var NAME for the setters: non-denylisted + a sane shape. */
function assertSettableEnvName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("credentials: an env var name is required");
  }
  if (DENYLISTED_ENV.has(name)) throw new DenylistedEnvError(name);
  if (!ENV_NAME_RE.test(name)) {
    throw new Error(
      `credentials: env var name "${name}" is invalid (letters, digits, underscore; no leading digit)`,
    );
  }
}

/**
 * Set ONE env var on the operator-level default layer (`channel` is null/undefined)
 * or on a specific channel's override layer. Read-modify-write so the Claude slice,
 * the other layer, and other vars are preserved. Rejects denylisted names
 * ({@link DenylistedEnvError}) and an empty value.
 */
export function setChannelEnvVar(
  channel: string | null | undefined,
  name: string,
  value: string,
  stateDir?: string,
): void {
  assertSettableEnvName(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("credentials: a non-empty env var value is required");
  }
  const file = readCredentialsFile(stateDir);
  const env = file.env ?? {};
  if (channel === null || channel === undefined || channel === "") {
    const def = env.default ?? {};
    def[name] = value;
    env.default = def;
  } else {
    const channels = env.channels ?? {};
    const forChannel = channels[channel] ?? {};
    forChannel[name] = value;
    channels[channel] = forChannel;
    env.channels = channels;
  }
  file.env = env;
  writeCredentialsFile(file, stateDir);
}

/**
 * Remove ONE env var from the operator-level default layer (`channel` null/undefined)
 * or a channel's override layer. Returns true if it existed, false if there was
 * nothing to remove. Prunes an emptied channel map so a removed-everything channel
 * doesn't linger as `{}`. Read-modify-write; the Claude slice + other vars untouched.
 */
export function removeChannelEnvVar(
  channel: string | null | undefined,
  name: string,
  stateDir?: string,
): boolean {
  const file = readCredentialsFile(stateDir);
  const env = file.env;
  if (!env) return false;
  if (channel === null || channel === undefined || channel === "") {
    if (!env.default || !(name in env.default)) return false;
    delete env.default[name];
    if (Object.keys(env.default).length === 0) delete env.default;
  } else {
    const forChannel = env.channels?.[channel];
    if (!forChannel || !(name in forChannel)) return false;
    delete forChannel[name];
    if (Object.keys(forChannel).length === 0) delete env.channels![channel];
    if (env.channels && Object.keys(env.channels).length === 0) delete env.channels;
  }
  writeCredentialsFile(file, stateDir);
  return true;
}

/**
 * Resolve the FLATTENED env a session on `channel` should run with:
 *
 *   { ...env.default, ...env.channels[channel] }   (the channel layer wins)
 *
 * Read at resolve time (not cached), like the Claude resolver — so a var set via the
 * config API takes effect on the next spawn (or per-session restart) without a daemon
 * restart. Defensively SKIPS any denylisted key that somehow landed on disk (a
 * hand-edited file): the setter blocks them, but the resolver never returns one
 * either, so `buildAgentChildEnv`'s own denylist drop is a belt to this suspenders.
 * Returns an empty map when nothing is configured (a channel with no env is fine).
 */
export function resolveChannelEnv(channel: string, stateDir?: string): Record<string, string> {
  const env = readCredentialsFile(stateDir).env;
  const merged: Record<string, string> = { ...(env?.default ?? {}), ...(env?.channels?.[channel] ?? {}) };
  for (const k of Object.keys(merged)) {
    if (DENYLISTED_ENV.has(k)) delete merged[k];
  }
  return merged;
}

/**
 * Describe the env store for an operator-facing read WITHOUT leaking values: the
 * NAMES set on the default layer, and the names set per channel. The raw values are
 * NEVER returned (`GET /api/credentials/env`) — same redaction posture as
 * `describeClaudeCredentials`.
 */
export function describeChannelEnv(
  stateDir?: string,
): { default: string[]; channels: Record<string, string[]> } {
  const env = readCredentialsFile(stateDir).env;
  const channels: Record<string, string[]> = {};
  for (const [ch, vars] of Object.entries(env?.channels ?? {})) {
    channels[ch] = Object.keys(vars).sort();
  }
  return {
    default: Object.keys(env?.default ?? {}).sort(),
    channels,
  };
}
