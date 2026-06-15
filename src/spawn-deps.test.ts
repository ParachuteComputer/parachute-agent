/**
 * Tests for `resolveSpawnDeps` (`src/spawn-deps.ts`) — the real-dep resolver
 * shared by the CLI and the web spawn endpoint.
 *
 * The load-bearing regression guard here is the claude config binding: the
 * sandboxed `claude` MUST get `~/.claude.json` bound read-only, or it runs
 * first-run onboarding whose connectivity check is FATAL under the restricted
 * egress proxy and the tmux session dies instantly ("An unknown error occurred").
 * That bug shipped once; this test ensures the binding stays.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveSpawnDeps, SpawnDepsError } from "./spawn-deps.ts";

const savedHome = process.env.PARACHUTE_HOME;
let tmp: string | undefined;

afterEach(() => {
  if (savedHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = savedHome;
  if (tmp) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    tmp = undefined;
  }
});

describe("resolveSpawnDeps", () => {
  test("throws SpawnDepsError when there's no operator token", () => {
    tmp = mkdtempSync(join(tmpdir(), "spawn-deps-empty-"));
    process.env.PARACHUTE_HOME = tmp; // no operator.token inside
    expect(() => resolveSpawnDeps()).toThrow(SpawnDepsError);
  });

  test("binds the claude binary (confined reads) but NOT the operator's ~/.claude", () => {
    tmp = mkdtempSync(join(tmpdir(), "spawn-deps-"));
    process.env.PARACHUTE_HOME = tmp;
    writeFileSync(join(tmp, "operator.token"), "fake-operator-bearer");
    const deps = resolveSpawnDeps();
    // The agent's config/onboarding now lives in its own per-session HOME
    // (seedAgentHome), so we no longer expose the operator's real config.
    expect(deps.runtimeReadOnly).not.toContain(resolve(homedir(), ".claude.json"));
    expect(deps.runtimeReadOnly).not.toContain(resolve(homedir(), ".claude"));
    // The claude BINARY is still bound (needed under confined/scoped reads) when
    // resolvable on PATH — and claudeBin is set to its absolute path.
    const bin = Bun.which("claude");
    if (bin) {
      expect(deps.claudeBin).toBe(bin);
      expect(deps.runtimeReadOnly).toContain(bin);
    }
  });
});
