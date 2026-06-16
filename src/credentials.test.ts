/**
 * Per-channel Claude OAuth credential store (design §6).
 *
 * Covers: store/retrieve round-trip, 0600 on the secret file, redaction (the
 * raw token never appears in the inspection helper / serialized output), and
 * default-vs-override resolution (override wins, falls back to default, errors
 * when neither). All hermetic under a throwaway state dir.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  setDefaultClaudeCredential,
  setChannelClaudeCredential,
  removeChannelClaudeCredential,
  resolveClaudeCredential,
  describeClaudeCredentials,
  readCredentialsFile,
  credentialsFilePath,
  CredentialNotConfiguredError,
  setChannelEnvVar,
  removeChannelEnvVar,
  resolveChannelEnv,
  describeChannelEnv,
  DenylistedEnvError,
  DENYLISTED_ENV,
} from "./credentials.ts";

const DEFAULT_TOKEN = "oat_DEFAULT-OPERATOR-TOKEN-SECRET";
const OVERRIDE_TOKEN = "oat_PER-CHANNEL-OVERRIDE-SECRET";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "channel-creds-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("store / retrieve round-trip", () => {
  test("default token: set then resolve returns it", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    expect(resolveClaudeCredential("any-channel", dir)).toBe(DEFAULT_TOKEN);
  });

  test("per-channel override: set then resolve returns it for that channel", () => {
    setChannelClaudeCredential("aaron-dev", OVERRIDE_TOKEN, dir);
    expect(resolveClaudeCredential("aaron-dev", dir)).toBe(OVERRIDE_TOKEN);
  });

  test("setting one slice preserves the other (read-modify-write)", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    setChannelClaudeCredential("aaron-dev", OVERRIDE_TOKEN, dir);
    setChannelClaudeCredential("ops", "oat_OPS", dir);
    const file = readCredentialsFile(dir);
    expect(file.claude!.default).toBe(DEFAULT_TOKEN);
    expect(file.claude!.channels!["aaron-dev"]).toBe(OVERRIDE_TOKEN);
    expect(file.claude!.channels!["ops"]).toBe("oat_OPS");
  });

  test("empty token is rejected (never persists a blank credential)", () => {
    expect(() => setDefaultClaudeCredential("", dir)).toThrow(/non-empty token/);
    expect(() => setChannelClaudeCredential("c", "", dir)).toThrow(/non-empty token/);
    expect(existsSync(credentialsFilePath(dir))).toBe(false);
  });
});

describe("0600 on the secret file", () => {
  test("the credentials file is written 0600 (holds a secret)", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    const file = credentialsFilePath(dir);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a subsequent write keeps it 0600 (chmod is unconditional)", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    // Loosen perms behind the store's back, then write again → must re-tighten.
    const fs = require("fs") as typeof import("fs");
    fs.chmodSync(credentialsFilePath(dir), 0o644);
    setChannelClaudeCredential("c", OVERRIDE_TOKEN, dir);
    expect(statSync(credentialsFilePath(dir)).mode & 0o777).toBe(0o600);
  });
});

describe("redaction — the raw token never leaks via the inspection helper", () => {
  test("describeClaudeCredentials reports presence + channel names, NOT the token", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    setChannelClaudeCredential("aaron-dev", OVERRIDE_TOKEN, dir);
    setChannelClaudeCredential("ops", "oat_OPS", dir);
    const desc = describeClaudeCredentials(dir);
    expect(desc.defaultSet).toBe(true);
    expect(desc.channels).toEqual(["aaron-dev", "ops"]); // sorted, names only
    const serialized = JSON.stringify(desc);
    expect(serialized).not.toContain(DEFAULT_TOKEN);
    expect(serialized).not.toContain(OVERRIDE_TOKEN);
    expect(serialized).not.toContain("oat_OPS");
  });

  test("describe on an empty store: defaultSet false, no channels", () => {
    const desc = describeClaudeCredentials(dir);
    expect(desc).toEqual({ defaultSet: false, channels: [] });
  });
});

describe("default-vs-override resolution", () => {
  test("override WINS over the default for its channel", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    setChannelClaudeCredential("aaron-dev", OVERRIDE_TOKEN, dir);
    expect(resolveClaudeCredential("aaron-dev", dir)).toBe(OVERRIDE_TOKEN);
    // A different channel with no override falls back to the default.
    expect(resolveClaudeCredential("other", dir)).toBe(DEFAULT_TOKEN);
  });

  test("falls back to the default when the channel has no override", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    expect(resolveClaudeCredential("never-configured", dir)).toBe(DEFAULT_TOKEN);
  });

  test("ERRORS when neither an override nor a default is set", () => {
    expect(() => resolveClaudeCredential("ghost", dir)).toThrow(CredentialNotConfiguredError);
    expect(() => resolveClaudeCredential("ghost", dir)).toThrow(/no Claude credential for channel "ghost"/);
  });

  test("removing an override falls back to the default; removing a missing one is a no-op", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    setChannelClaudeCredential("aaron-dev", OVERRIDE_TOKEN, dir);
    expect(removeChannelClaudeCredential("aaron-dev", dir)).toBe(true);
    expect(resolveClaudeCredential("aaron-dev", dir)).toBe(DEFAULT_TOKEN); // back to default
    expect(removeChannelClaudeCredential("aaron-dev", dir)).toBe(false); // already gone
    // The default is untouched by an override removal.
    expect(readCredentialsFile(dir).claude!.default).toBe(DEFAULT_TOKEN);
  });

  test("resolution is read dynamically — a rotate takes effect on the next resolve", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    expect(resolveClaudeCredential("c", dir)).toBe(DEFAULT_TOKEN);
    setDefaultClaudeCredential("oat_ROTATED", dir);
    expect(resolveClaudeCredential("c", dir)).toBe("oat_ROTATED");
  });
});

// ===========================================================================
// Generic per-channel env store (GH_TOKEN / CLOUDFLARE_API_TOKEN / …)
// ===========================================================================
const GH = "ghp_GITHUB-TOKEN-SECRET";
const CF = "cf_CLOUDFLARE-TOKEN-SECRET";

describe("env store — set / resolve / channel-over-default merge", () => {
  test("default var: set with null channel, resolves for any channel", () => {
    setChannelEnvVar(null, "GH_TOKEN", GH, dir);
    expect(resolveChannelEnv("anything", dir)).toEqual({ GH_TOKEN: GH });
    // An empty-string channel also targets the default layer.
    setChannelEnvVar("", "CF_TOKEN", CF, dir);
    expect(resolveChannelEnv("anything", dir)).toEqual({ GH_TOKEN: GH, CF_TOKEN: CF });
  });

  test("per-channel override WINS over the default for that channel; others see only the default", () => {
    setChannelEnvVar(null, "GH_TOKEN", "ghp_DEFAULT", dir);
    setChannelEnvVar("aaron-dev", "GH_TOKEN", "ghp_AARON", dir);
    setChannelEnvVar("aaron-dev", "CLOUDFLARE_API_TOKEN", CF, dir);
    // channel layer wins on GH_TOKEN, plus its own CF token, plus inherits nothing extra.
    expect(resolveChannelEnv("aaron-dev", dir)).toEqual({ GH_TOKEN: "ghp_AARON", CLOUDFLARE_API_TOKEN: CF });
    // a different channel falls back to the default only.
    expect(resolveChannelEnv("other", dir)).toEqual({ GH_TOKEN: "ghp_DEFAULT" });
  });

  test("resolves to {} when nothing is configured (env injection is optional)", () => {
    expect(resolveChannelEnv("ghost", dir)).toEqual({});
  });

  test("setting an env var preserves the Claude slice (independent namespaces)", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    setChannelEnvVar(null, "GH_TOKEN", GH, dir);
    const file = readCredentialsFile(dir);
    expect(file.claude!.default).toBe(DEFAULT_TOKEN); // untouched
    expect(file.env!.default!.GH_TOKEN).toBe(GH);
  });

  test("read dynamically — a value change takes effect on the next resolve", () => {
    setChannelEnvVar("c", "GH_TOKEN", "ghp_OLD", dir);
    expect(resolveChannelEnv("c", dir).GH_TOKEN).toBe("ghp_OLD");
    setChannelEnvVar("c", "GH_TOKEN", "ghp_NEW", dir);
    expect(resolveChannelEnv("c", dir).GH_TOKEN).toBe("ghp_NEW");
  });

  test("the env store file is written 0600 (holds secrets)", () => {
    setChannelEnvVar(null, "GH_TOKEN", GH, dir);
    expect(statSync(credentialsFilePath(dir)).mode & 0o777).toBe(0o600);
  });
});

describe("env store — remove", () => {
  test("remove a default var; remove a missing one is a no-op (false)", () => {
    setChannelEnvVar(null, "GH_TOKEN", GH, dir);
    setChannelEnvVar(null, "CF_TOKEN", CF, dir);
    expect(removeChannelEnvVar(null, "GH_TOKEN", dir)).toBe(true);
    expect(resolveChannelEnv("any", dir)).toEqual({ CF_TOKEN: CF });
    expect(removeChannelEnvVar(null, "GH_TOKEN", dir)).toBe(false); // already gone
  });

  test("remove a channel override; the default for that name re-emerges", () => {
    setChannelEnvVar(null, "GH_TOKEN", "ghp_DEFAULT", dir);
    setChannelEnvVar("aaron-dev", "GH_TOKEN", "ghp_AARON", dir);
    expect(removeChannelEnvVar("aaron-dev", "GH_TOKEN", dir)).toBe(true);
    expect(resolveChannelEnv("aaron-dev", dir)).toEqual({ GH_TOKEN: "ghp_DEFAULT" }); // back to default
  });

  test("removing the last var of a channel prunes the empty channel map", () => {
    setChannelEnvVar("c", "GH_TOKEN", GH, dir);
    removeChannelEnvVar("c", "GH_TOKEN", dir);
    const file = readCredentialsFile(dir);
    // The channel (and the now-empty channels map) is pruned, not left as {}.
    expect(file.env?.channels).toBeUndefined();
  });
});

describe("env store — redaction (describeChannelEnv returns NAMES only)", () => {
  test("describe reports names per layer, never the values", () => {
    setChannelEnvVar(null, "GH_TOKEN", GH, dir);
    setChannelEnvVar("aaron-dev", "CLOUDFLARE_API_TOKEN", CF, dir);
    setChannelEnvVar("aaron-dev", "GH_TOKEN", "ghp_AARON", dir);
    const desc = describeChannelEnv(dir);
    expect(desc.default).toEqual(["GH_TOKEN"]);
    expect(desc.channels["aaron-dev"]).toEqual(["CLOUDFLARE_API_TOKEN", "GH_TOKEN"]); // sorted
    const serialized = JSON.stringify(desc);
    expect(serialized).not.toContain(GH);
    expect(serialized).not.toContain(CF);
    expect(serialized).not.toContain("ghp_AARON");
  });

  test("describe on an empty store: no default, no channels", () => {
    expect(describeChannelEnv(dir)).toEqual({ default: [], channels: {} });
  });
});

describe("env store — denylist (the Claude-auth trio is never settable)", () => {
  test("the denylist is exactly the Claude-auth vars", () => {
    expect([...DENYLISTED_ENV].sort()).toEqual(
      ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].sort(),
    );
  });

  test("setter REJECTS each denylisted name (default + channel), nothing persisted", () => {
    for (const name of DENYLISTED_ENV) {
      expect(() => setChannelEnvVar(null, name, "x", dir)).toThrow(DenylistedEnvError);
      expect(() => setChannelEnvVar("c", name, "x", dir)).toThrow(DenylistedEnvError);
    }
    expect(existsSync(credentialsFilePath(dir))).toBe(false);
  });

  test("setter rejects a malformed name + an empty value", () => {
    expect(() => setChannelEnvVar(null, "9BAD", "x", dir)).toThrow(/invalid/);
    expect(() => setChannelEnvVar(null, "has space", "x", dir)).toThrow(/invalid/);
    expect(() => setChannelEnvVar(null, "GH_TOKEN", "", dir)).toThrow(/non-empty/);
    expect(existsSync(credentialsFilePath(dir))).toBe(false);
  });

  test("resolve defensively STRIPS a denylisted key planted by a hand-edited file", () => {
    // Plant a denylisted key directly on disk (bypassing the setter), then prove
    // resolveChannelEnv never returns it — the injection defense's first line.
    setChannelEnvVar(null, "GH_TOKEN", GH, dir);
    const fs = require("fs") as typeof import("fs");
    const file = JSON.parse(fs.readFileSync(credentialsFilePath(dir), "utf8")) as {
      env: { default: Record<string, string> };
    };
    file.env.default.ANTHROPIC_API_KEY = "sk-ant-SMUGGLED";
    fs.writeFileSync(credentialsFilePath(dir), JSON.stringify(file));
    const resolved = resolveChannelEnv("any", dir);
    expect(resolved.GH_TOKEN).toBe(GH);
    expect(resolved.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
