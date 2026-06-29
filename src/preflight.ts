/**
 * Boot-time dependency PREFLIGHT (agent#156).
 *
 * A freshly-provisioned box can't run a programmatic `claude -p` turn until the
 * sandbox deps (`bwrap`, `rg`, `socat`) AND the `claude` CLI are installed — but
 * pre-#156 each missing piece surfaced ONLY as a failed *turn*, one at a time, so
 * an operator discovered them serially (install bwrap → next turn fails on rg →
 * install rg → next turn fails on claude → …).
 *
 * This lifts the check to DAEMON BOOT: resolve each required binary on PATH ONCE
 * and log a single clear warning naming exactly what's missing + the one-liner to
 * fix it. It is a WARNING, never a crash — the daemon may run only `attached`-backend
 * agents (which don't spawn `claude -p` and need no sandbox/claude), so a missing
 * dep means "programmatic turns will fail until …", not "the daemon can't start."
 *
 * Deliberately NOT a full doctor framework — a focused boot preflight + clear log is
 * the whole of #156. (`spawn-deps.ts`'s turn-time check still stands as the last line
 * of defence for a dep removed AFTER boot.)
 */

/**
 * One required external binary the programmatic backend needs on PATH, with the
 * one-liner that installs it on a fresh Debian/Ubuntu box (the #156 reproduction).
 */
interface RequiredDep {
  /** The binary name resolved on PATH (`Bun.which`). */
  bin: string;
  /** Human label for the warning. */
  label: string;
  /** The install hint shown when it's missing. */
  hint: string;
}

/**
 * The deps a programmatic `claude -p` turn needs. The first three are the Linux
 * sandbox deps the runtime shells out to (`spawn-deps.ts` / the sandbox runtime —
 * bubblewrap is the containment, ripgrep does the deny-path scan, socat bridges the
 * egress proxy); `claude` is the CLI the turn actually runs. On macOS the sandbox
 * uses Seatbelt (built in) so `bwrap`/`socat` aren't required there — but the check
 * is cheap and the warning is advisory, so we report them uniformly and let the
 * operator judge (the live turn's own dep check is platform-accurate). `claude` is
 * required on every platform.
 */
export const REQUIRED_DEPS: readonly RequiredDep[] = [
  { bin: "bwrap", label: "bubblewrap (bwrap)", hint: "apt install bubblewrap" },
  { bin: "rg", label: "ripgrep (rg)", hint: "apt install ripgrep" },
  { bin: "socat", label: "socat", hint: "apt install socat" },
  {
    bin: "claude",
    label: "Claude Code CLI (claude)",
    hint: "curl -fsSL https://claude.ai/install.sh | bash  (native build — no node/npm needed)",
  },
] as const;

/** A resolver from binary name → absolute path (or null when not on PATH). Injectable for tests. */
export type WhichFn = (bin: string) => string | null;

/** The default resolver — Bun.which against the daemon's PATH. */
export const realWhich: WhichFn = (bin) => Bun.which(bin);

/** The outcome of {@link checkProgrammaticDeps}: which required deps are missing + a ready-to-log warning. */
export interface PreflightResult {
  /** The deps NOT resolvable on PATH (empty = all present). */
  missing: RequiredDep[];
  /** True when every required dep resolved (nothing to warn about). */
  ok: boolean;
  /**
   * The formatted multi-line warning to log, or null when nothing is missing. Lists
   * each missing dep + its install one-liner, framed as "programmatic turns will fail
   * until …" (attached-backend agents are unaffected).
   */
  warning: string | null;
}

/**
 * PURE check: resolve each {@link REQUIRED_DEPS} binary via `which` and build the
 * missing-deps result + warning text. No I/O beyond the injected `which`; no logging
 * (the caller logs). Cheap + idempotent — safe to call at boot.
 */
export function checkProgrammaticDeps(which: WhichFn = realWhich): PreflightResult {
  const missing = REQUIRED_DEPS.filter((d) => {
    try {
      return !which(d.bin);
    } catch {
      // A which() fault is treated as "can't confirm it's present" → report it missing
      // (better a spurious advisory than silently swallowing a real gap).
      return true;
    }
  });
  if (missing.length === 0) return { missing: [], ok: true, warning: null };
  const lines = missing.map((d) => `    - ${d.label}: ${d.hint}`);
  const warning =
    `parachute-agent: PREFLIGHT — ${missing.length} dependency/dependencies for programmatic ` +
    `(claude -p) turns is/are NOT on PATH. Programmatic-backend turns will FAIL until installed ` +
    `(attached-backend agents are unaffected):\n${lines.join("\n")}`;
  return { missing, ok: false, warning };
}

/**
 * Run the boot preflight: check the deps and LOG the warning once (via `console.warn`)
 * when anything is missing. Returns the {@link PreflightResult} so the caller can also
 * surface the missing-deps state elsewhere (e.g. `/health`). Never throws — the daemon
 * keeps booting regardless.
 */
export function runBootPreflight(which: WhichFn = realWhich): PreflightResult {
  let result: PreflightResult;
  try {
    result = checkProgrammaticDeps(which);
  } catch (err) {
    // Defensive: the preflight must never break boot. Treat an unexpected fault as "ok"
    // (the turn-time check in spawn-deps.ts remains the real guard).
    console.error(`parachute-agent: boot preflight errored (continuing): ${(err as Error).message}`);
    return { missing: [], ok: true, warning: null };
  }
  if (result.warning) console.warn(result.warning);
  return result;
}
