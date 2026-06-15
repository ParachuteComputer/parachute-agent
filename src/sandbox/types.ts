/**
 * Agent-spec + Sandbox contract types.
 *
 * The **agent spec** (design §4.1) is the single declaration of everything an
 * arm may reach: its MCP surface (channels + vault), its network egress, and its
 * filesystem view. Scope and isolation are both read off this one object, so
 * there is exactly one place that says "what is this arm allowed to touch."
 *
 *   design/2026-06-14-sandboxed-agent-sessions.md §4.1, §4.4, §4.5
 *
 * The Sandbox **contract** (design §3.1) is held constant; the **mechanism**
 * varies by platform (Seatbelt on macOS, bubblewrap on Linux) behind it. v1
 * ships one backend (Anthropic's sandbox-runtime); the escalation rung (§3.4 —
 * gVisor / full VM) is a second backend added later without touching callers.
 */

/** Read/write mode for a declared mount. */
export type MountMode = "ro" | "rw";

/**
 * A filesystem bind beyond the implicit workspace + runtime/config. Each entry
 * binds a host path to a mount path at `ro` or `rw` (design §4.5).
 *
 * On macOS the sandbox profile is glob-capable, so `hostPath` may contain glob
 * patterns; on Linux it must be a literal path (the runtime does not glob there).
 * For v1 we bind the host path directly (`mountPath` is recorded for the future
 * bubblewrap bind-remap and for the spec→mandate seam, §4.6 — it does not change
 * the v1 Seatbelt path, which has no path-remapping layer).
 */
export interface AgentMount {
  /** Path on the host to expose into the session. */
  hostPath: string;
  /** Path the session sees it at. Recorded for the future bind-remap; see note above. */
  mountPath: string;
  /** Read-only or read-write. */
  mode: MountMode;
  /**
   * Opt-in cross-session share by name (design §4.5). A deliberate hole in
   * session-to-session isolation — honored here, but the trust caveat (prefer
   * shared-`ro` from the producer, never shared-`rw` across a trust boundary) is
   * doc-level for v1. Plumbed through so a future use is a considered decision.
   */
  shared?: string;
}

/** The vault binding for an arm: which vault, what access, optionally tag-scoped. */
export interface AgentVaultSpec {
  /** Vault instance name (e.g. "default"). */
  name: string;
  /** Access verb minted into the vault token. */
  access: "read" | "write" | "admin";
  /**
   * Optional tag scope — narrows the minted vault token to these tags via the
   * `permissions.scoped_tags` claim (e.g. `["#channel-message"]`). Omitted = the
   * verb's full scope across the vault.
   */
  tags?: string[];
}

/** An additional MCP server to wire in, by URL (design §4.1 `otherMcps`). */
export interface OtherMcpSpec {
  /** Entry key in the generated `mcpServers` object. */
  name: string;
  /** Streamable-HTTP MCP URL. */
  url: string;
  /**
   * Scope to mint a token for, if this MCP is hub-gated. Omitted = no token
   * (an unauthenticated / externally-authenticated MCP).
   */
  scope?: string;
  /** Audience to mint the token under. Defaults to inferred from scope by the hub. */
  audience?: string;
}

/**
 * An agent spec — the complete least-privilege envelope for one launched arm
 * (design §4.1). `egress` and `mounts` are additive to a non-removable base; the
 * spec only ever *adds*.
 */
/**
 * A channel binding for an arm. A bare string is shorthand for `{ name, access:
 * "write" }` (back-compat — the common read+write resident session); the object
 * form scopes a channel read-only so an arm that only *watches* a channel mints
 * `channel:read` and never `channel:write` (the "scope an arm to channel X
 * read-only" use case).
 */
export interface AgentChannelSpec {
  /** Channel name (the `/mcp/<channel>` segment). */
  name: string;
  /**
   * Channel access. `"write"` (default) mints `channel:read channel:write`;
   * `"read"` mints `channel:read` only — the arm can be woken + read the channel
   * but cannot reply.
   */
  access?: "read" | "write";
}

/** A channel entry: a bare name (= write access) or the scoped object form. */
export type AgentChannel = string | AgentChannelSpec;

export interface AgentSpec {
  /** Human-readable arm name; used as the tmux session + workspace slug. */
  name: string;
  /**
   * Channels to attach (one MCP entry each). Each entry is a bare name (read+write,
   * back-compat) or `{ name, access: "read" }` to scope a channel read-only.
   */
  channels: AgentChannel[];
  /** Optional vault binding. */
  vault?: AgentVaultSpec;
  /** Additional MCP servers, by URL. */
  otherMcps?: OtherMcpSpec[];
  /**
   * Isolation posture — the single knob that sets BOTH the read scope and the
   * network egress, matched to the trust gradient:
   *
   *   - `"trusted"` (DEFAULT): the operator's own self-spawned agent on a flat
   *     trust gradient. Reads are BROAD (the runtime default — claude reads its
   *     binary, the system, the operator's files without per-path binds) and the
   *     network is OPEN. Writes are still confined to the per-session workspace
   *     (which holds the agent's private HOME), so it can't corrupt the operator's
   *     real config or escape its workspace. This is what makes the sandbox STABLE
   *     for running claude — claude's own runtime never collides with a deny.
   *
   *   - `"confined"`: for an agent fed FOREIGN/untrusted input. Reads are SCOPED
   *     (home tree denied, re-allowed to workspace + the claude runtime + declared
   *     mounts) and egress is RESTRICTED to the non-removable base
   *     (`{ Anthropic API, hub/vault }`) UNIONed with `egress[]`. The real
   *     isolation surface — only turn it on when the agent processes input you
   *     don't trust.
   *
   * Defaults to `"trusted"` (owner-operated). The per-session writable HOME +
   * temp + onboarding seed are provided in BOTH postures (claude must always be
   * able to run); `isolation` only governs reach BEYOND claude's own runtime.
   */
  isolation?: "trusted" | "confined";
  /**
   * Network egress hosts ADDITIVE to the non-removable base — only meaningful
   * under `isolation: "confined"` (in `"trusted"` the network is fully open, so
   * this is ignored). A confined code-building agent opens exactly the
   * package/source hosts it needs here.
   */
  egress?: string[];
  /**
   * Filesystem mounts — ADDITIVE to the default private per-session workspace
   * (rw) + the implicit runtime/claude-config (ro). Reads are scoped to declared
   * binds, NOT broad (design §4.5).
   */
  mounts?: AgentMount[];
  /**
   * Which stored Claude credential to inject (design §6). Default = "operator".
   * This stream injects the credential as a passed-in param/placeholder; Stream 3
   * builds the real per-channel secret store.
   */
  credentialRef?: string;
}

/**
 * The default workspace + runtime binds the contract always grants, independent
 * of any spec. The caller supplies the concrete paths (resolved against the
 * session's state dir + the runtime/config location) — keeping this module
 * free of filesystem-layout assumptions and test-sandboxable.
 */
export interface BaseBinds {
  /** Private per-session workspace (rw). */
  workspace: string;
  /**
   * Read-only runtime/claude-config paths the session needs to run `claude`
   * (e.g. the claude config dir). Always bound `ro`.
   */
  runtimeReadOnly: string[];
}

/** Platform the Sandbox config is being built for. */
export type SandboxPlatform = "darwin" | "linux";

/**
 * Normalize a channel entry (bare name or object) to `{ name, access }`. A bare
 * string defaults to `write` (back-compat); the object form defaults to `write`
 * when `access` is omitted.
 */
export function normalizeChannel(ch: AgentChannel): { name: string; access: "read" | "write" } {
  if (typeof ch === "string") return { name: ch, access: "write" };
  return { name: ch.name, access: ch.access ?? "write" };
}
