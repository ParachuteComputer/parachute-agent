/**
 * Boot-time dependency PREFLIGHT tests (agent#156).
 *
 * A fresh box can't run a programmatic `claude -p` turn until bwrap/rg/socat + the
 * claude CLI are on PATH. `checkProgrammaticDeps` resolves each required binary via
 * an injectable `which` and reports exactly what's missing + a ready-to-log warning,
 * so the daemon can surface it ONCE at boot (and on /health) instead of letting each
 * gap surface as a separate failed turn.
 */

import { describe, test, expect } from "bun:test";
import { checkProgrammaticDeps, runBootPreflight, REQUIRED_DEPS, type WhichFn } from "./preflight.ts";

/** A `which` that resolves only the named bins (returns a fake abs path), null otherwise. */
function whichWith(present: string[]): WhichFn {
  const set = new Set(present);
  return (bin) => (set.has(bin) ? `/usr/bin/${bin}` : null);
}

describe("checkProgrammaticDeps", () => {
  test("ALL present → ok, no missing, no warning", () => {
    const result = checkProgrammaticDeps(whichWith(REQUIRED_DEPS.map((d) => d.bin)));
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.warning).toBeNull();
  });

  test("checks exactly bwrap, rg, socat, and claude", () => {
    expect(REQUIRED_DEPS.map((d) => d.bin)).toEqual(["bwrap", "rg", "socat", "claude"]);
  });

  test("a missing sandbox dep is reported with its install hint", () => {
    // bwrap absent, the rest present (the fresh-Ubuntu step-1 reproduction).
    const result = checkProgrammaticDeps(whichWith(["rg", "socat", "claude"]));
    expect(result.ok).toBe(false);
    expect(result.missing.map((d) => d.bin)).toEqual(["bwrap"]);
    expect(result.warning).toContain("bubblewrap");
    expect(result.warning).toContain("apt install bubblewrap");
  });

  test("a missing claude CLI is reported with the native-install one-liner", () => {
    const result = checkProgrammaticDeps(whichWith(["bwrap", "rg", "socat"]));
    expect(result.missing.map((d) => d.bin)).toEqual(["claude"]);
    expect(result.warning).toContain("claude.ai/install.sh");
  });

  test("a completely fresh box (nothing installed) lists ALL deps", () => {
    const result = checkProgrammaticDeps(whichWith([]));
    expect(result.ok).toBe(false);
    expect(result.missing.map((d) => d.bin)).toEqual(["bwrap", "rg", "socat", "claude"]);
    // The warning frames it as "programmatic turns will fail" — NOT a fatal error.
    expect(result.warning).toContain("Programmatic-backend turns will FAIL");
    expect(result.warning).toContain("attached-backend agents are unaffected");
  });

  test("a which() that throws treats the dep as missing (never swallows a gap)", () => {
    const throwingWhich: WhichFn = (bin) => {
      if (bin === "claude") throw new Error("which blew up");
      return `/usr/bin/${bin}`;
    };
    const result = checkProgrammaticDeps(throwingWhich);
    expect(result.missing.map((d) => d.bin)).toEqual(["claude"]);
  });
});

describe("runBootPreflight", () => {
  test("logs the warning when deps are missing + returns the result", () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
    try {
      const result = runBootPreflight(whichWith(["bwrap", "rg", "socat"])); // claude missing
      expect(result.ok).toBe(false);
      expect(warnings.some((w) => w.includes("PREFLIGHT") && w.includes("claude"))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  test("logs NOTHING when all deps are present", () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
    try {
      const result = runBootPreflight(whichWith(REQUIRED_DEPS.map((d) => d.bin)));
      expect(result.ok).toBe(true);
      expect(warnings).toEqual([]);
    } finally {
      console.warn = orig;
    }
  });
});
