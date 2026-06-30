/**
 * Tests for the agent-side hub-JWT adapter. Two layers:
 *
 *  1. Pure / no-JWKS cases — hub-origin resolution (env precedence →
 *     expose-state self-heal → loopback fallback), the audience constants, the
 *     re-exported pure helpers (`looksLikeJwt`), and `parseHubOrigins`.
 *  2. Live-JWKS cases — the multi-origin iss-set (hub#692). These spin up a fake
 *     JWKS endpoint with a known RSA keypair, sign JWTs locally, and assert the
 *     hub's legitimate-origin SET (`PARACHUTE_HUB_ORIGINS`) is honored: a token
 *     whose `iss` is in the set (but ≠ the canonical origin) validates, an `iss`
 *     outside the set is rejected, and an UNSET env var collapses to the single
 *     canonical origin (byte-identical to before). This mirrors vault's
 *     `hub-jwt.test.ts` multi-origin block. The signature verify runs FIRST and
 *     unconditionally in scope-guard; the issuer set is only an additive
 *     membership check layered on top.
 *
 *     IMPORTANT (mock isolation): these cases build a guard from the REAL
 *     `createScopeGuard` (scope-guard is never mocked) wired EXACTLY as
 *     `hub-jwt.ts` wires its module guard — `allowedIssuers: () =>
 *     parseHubOrigins(process.env.PARACHUTE_HUB_ORIGINS)`, with the real
 *     (never-mocked) `parseHubOrigins`. We deliberately do NOT route through the
 *     module's `validateHubJwt`/`getHubOrigin` exports here: a dozen daemon test
 *     files `mock.module("./hub-jwt.ts", …)` PROCESS-WIDE (Bun merges the factory
 *     over the real exports), replacing `validateHubJwt` with a canned stub and
 *     `getHubOrigin` with a loopback constant. Exercising the real guard wiring
 *     against scope-guard directly is immune to that leak; the module's own
 *     `validateHubJwt` wrapper (dual-accept aud) is covered by the audience
 *     constants below + the standalone `bun test ./src/hub-jwt.test.ts` run.
 *
 * Audience constants (channel→agent rename, rule 1): the daemon now mints/
 * validates `aud: "agent"` (`AGENT_AUDIENCE`); the pre-rename `aud: "channel"`
 * (`CHANNEL_AUDIENCE`, deprecated) still validates during the dual-accept window
 * via `ACCEPTED_AUDIENCES`. We assert all three constants here; the live-JWKS
 * cases sign with `aud: "agent"`.
 *
 * The self-heal reads `<PARACHUTE_HOME>/expose-state.json`. Every case here
 * points `PARACHUTE_HOME` at a fresh temp dir so the operator's real
 * `~/.parachute/expose-state.json` can't leak into the loopback assertions.
 */
import {
  describe,
  test,
  expect,
  afterEach,
  beforeEach,
  beforeAll,
  afterAll,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createScopeGuard } from "@openparachute/scope-guard";
import {
  getHubOrigin,
  parseHubOrigins,
  AGENT_AUDIENCE,
  CHANNEL_AUDIENCE,
  ACCEPTED_AUDIENCES,
  looksLikeJwt,
  HubJwtError,
} from "./hub-jwt.ts";

const savedOrigin = process.env.PARACHUTE_HUB_ORIGIN;
const savedOrigins = process.env.PARACHUTE_HUB_ORIGINS;
const savedHome = process.env.PARACHUTE_HOME;

let home: string;

// --- Live-JWKS fixture (multi-origin iss-set cases) ------------------------
// A fake hub JWKS endpoint with a known RSA keypair; tokens are signed locally
// so the ONLY variable under test is whether the token's `iss` is in the
// accepted set. Mirrors vault's `startJwksFixture` / `signJwt`.

interface Keypair {
  privateKey: CryptoKey;
  publicJwk: { kty: string; n: string; e: string; kid: string; alg: string; use: string };
  kid: string;
}

async function makeKeypair(kid: string): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk: { kty: "RSA", n: jwk.n!, e: jwk.e!, kid, alg: "RS256", use: "sig" },
    kid,
  };
}

interface JwksFixture {
  origin: string;
  stop: () => void;
}

function startJwksFixture(keys: Keypair[]): JwksFixture {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/jwks.json") {
        return Response.json({ keys: keys.map((k) => k.publicJwk) });
      }
      // scope-guard consults the revocation list on every jti-bearing token;
      // serve an empty list so these cases aren't fail-closed by a 404.
      if (url.pathname === "/.well-known/parachute-revocation.json") {
        return Response.json({ generated_at: new Date().toISOString(), jtis: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function signAgentJwt(
  kp: Keypair,
  opts: { iss: string; aud?: string; jti?: string },
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  // The agent enforces ACCEPTED_AUDIENCES, so default to the canonical `agent` aud.
  return await new SignJWT({ scope: "agent:read agent:write", client_id: "test-client" })
    .setProtectedHeader({ alg: "RS256", kid: kp.kid })
    .setIssuer(opts.iss)
    .setSubject("user-1")
    .setAudience(opts.aud ?? AGENT_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 60)
    .setJti(opts.jti ?? "jti-1")
    .sign(kp.privateKey);
}

/**
 * A guard built EXACTLY as `hub-jwt.ts` builds its module guard — same
 * `allowedIssuers` wiring against the real (never-mocked) `parseHubOrigins`. The
 * `hubOrigin` resolver inlines the env read rather than calling the module's
 * `getHubOrigin` (which the daemon tests mock to a loopback constant
 * process-wide), so the iss/JWKS origin here is the live fixture under test.
 * Fresh per call so the JWKS cache never carries across cases. This exercises
 * the genuine multi-origin behavior immune to the process-wide mock.module leak.
 */
function makeAgentGuard() {
  return createScopeGuard({
    hubOrigin: () => (process.env.PARACHUTE_HUB_ORIGIN ?? "").replace(/\/$/, ""),
    allowedIssuers: () => parseHubOrigins(process.env.PARACHUTE_HUB_ORIGINS),
  });
}

let fixture: JwksFixture;
let kp: Keypair;

beforeAll(async () => {
  kp = await makeKeypair("k1");
  fixture = startJwksFixture([kp]);
});

afterAll(() => {
  fixture.stop();
});

beforeEach(() => {
  // Isolated, empty ecosystem root — no expose-state.json unless a case writes one.
  home = mkdtempSync(join(tmpdir(), "agent-hubjwt-"));
  process.env.PARACHUTE_HOME = home;
  // Default each case to the single-origin (env-unset) world so the multi-origin
  // iss-set is opt-in per test — unrelated cases stay byte-identical to before.
  delete process.env.PARACHUTE_HUB_ORIGINS;
});

afterEach(() => {
  if (savedOrigin === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = savedOrigin;
  if (savedOrigins === undefined) delete process.env.PARACHUTE_HUB_ORIGINS;
  else process.env.PARACHUTE_HUB_ORIGINS = savedOrigins;
  if (savedHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = savedHome;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

function writeExposeState(obj: Record<string, unknown>): void {
  writeFileSync(join(home, "expose-state.json"), JSON.stringify(obj));
}

describe("getHubOrigin — env precedence", () => {
  test("uses the env value when set", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "https://hub.example.com";
    expect(getHubOrigin()).toBe("https://hub.example.com");
  });

  test("strips a single trailing slash for a canonical form", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "https://hub.example.com/";
    expect(getHubOrigin()).toBe("https://hub.example.com");
  });

  test("env wins over expose-state (highest precedence)", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "https://env.example.com";
    writeExposeState({ hubOrigin: "https://exposed.example.com" });
    expect(getHubOrigin()).toBe("https://env.example.com");
  });
});

describe("getHubOrigin — expose-state self-heal (agent#34)", () => {
  test("reads expose-state.hubOrigin when env is unset", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    writeExposeState({ hubOrigin: "https://exposed.example.com" });
    expect(getHubOrigin()).toBe("https://exposed.example.com");
  });

  test("reads expose-state.hubOrigin when env is empty", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "";
    writeExposeState({ hubOrigin: "https://exposed.example.com" });
    expect(getHubOrigin()).toBe("https://exposed.example.com");
  });

  test("synthesizes https://<canonicalFqdn> for older state files lacking hubOrigin", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    writeExposeState({ canonicalFqdn: "box.taildf9ce2.ts.net" });
    expect(getHubOrigin()).toBe("https://box.taildf9ce2.ts.net");
  });

  test("strips a trailing slash off the expose-state origin", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    writeExposeState({ hubOrigin: "https://exposed.example.com/" });
    expect(getHubOrigin()).toBe("https://exposed.example.com");
  });

  test("never self-heals to a loopback expose-state origin", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    writeExposeState({ hubOrigin: "http://127.0.0.1:1939" });
    expect(getHubOrigin()).toBe("http://127.0.0.1:1939"); // loopback default, not a self-heal
  });
});

describe("getHubOrigin — loopback fallback", () => {
  test("falls back to loopback when env unset AND no expose-state file", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    expect(getHubOrigin()).toBe("http://127.0.0.1:1939");
  });

  test("falls back to loopback when env empty AND no expose-state file", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "";
    expect(getHubOrigin()).toBe("http://127.0.0.1:1939");
  });

  test("falls back to loopback when expose-state has no usable origin", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    writeExposeState({ layer: "tailnet" }); // neither hubOrigin nor canonicalFqdn
    expect(getHubOrigin()).toBe("http://127.0.0.1:1939");
  });

  test("falls back to loopback when expose-state is malformed JSON", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    writeFileSync(join(home, "expose-state.json"), "{ not json");
    expect(getHubOrigin()).toBe("http://127.0.0.1:1939");
  });
});

describe("audience constants (channel→agent dual-accept, rule 1)", () => {
  test("AGENT_AUDIENCE is the literal 'agent' (what the hub mints aud as now)", () => {
    expect(AGENT_AUDIENCE).toBe("agent");
  });

  test("CHANNEL_AUDIENCE is the deprecated legacy literal 'channel' (pre-rename tokens)", () => {
    expect(CHANNEL_AUDIENCE).toBe("channel");
  });

  test("ACCEPTED_AUDIENCES carries BOTH — new 'agent' + legacy 'channel' (the dual-accept set)", () => {
    // The resource-server backstop: a token whose aud is neither (e.g. minted for
    // a vault) is rejected; both transitional forms validate until live re-mint.
    expect([...ACCEPTED_AUDIENCES]).toEqual(["agent", "channel"]);
    expect(ACCEPTED_AUDIENCES).toContain(AGENT_AUDIENCE);
    expect(ACCEPTED_AUDIENCES).toContain(CHANNEL_AUDIENCE);
  });
});

describe("re-exported helpers", () => {
  test("looksLikeJwt recognizes the eyJ prefix", () => {
    expect(looksLikeJwt("eyJhbGciOiJSUzI1NiJ9.payload.sig")).toBe(true);
    expect(looksLikeJwt("opaque-shared-secret")).toBe(false);
  });

  test("HubJwtError is the scope-guard error class", () => {
    const err = new HubJwtError("issuer", "bad iss");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("issuer");
  });
});

describe("parseHubOrigins — multi-origin iss-set (hub#692)", () => {
  test("undefined → [] (back-compat: env unset collapses to single hubOrigin)", () => {
    expect(parseHubOrigins(undefined)).toEqual([]);
  });

  test("empty string → []", () => {
    expect(parseHubOrigins("")).toEqual([]);
  });

  test("splits, trims, strips trailing slash, drops empties, dedupes", () => {
    // "a,b/, ,a" → [a, b]: trailing slash off b, blank entry dropped, dup a collapsed.
    expect(parseHubOrigins("https://a.example,https://b.example/, ,https://a.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  test("whitespace-only entries are dropped", () => {
    expect(parseHubOrigins("  ,  ,  ")).toEqual([]);
  });
});

describe("multi-origin iss-set — guard wiring (hub#692)", () => {
  // A second + third origin that are NOT the canonical PARACHUTE_HUB_ORIGIN.
  // Every token is signed by the SAME published key (`kp`), so the signature
  // always verifies — the ONLY variable under test is whether the token's `iss`
  // is in the accepted set. JWKS + revocation are served by `fixture`, reached
  // as both the iss origin (PARACHUTE_HUB_ORIGIN) and the JWKS host (the agent
  // fetches keys from the same origin it validates `iss` against — no split).
  // `makeAgentGuard()` reproduces hub-jwt.ts's exact `allowedIssuers` wiring; see
  // its doc comment for why we don't route through the (mocked) module export.
  const SECOND = "https://second.example";
  const THIRD = "https://third.example";

  test("token issued by a SECOND origin validates when that origin is in PARACHUTE_HUB_ORIGINS", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = fixture.origin; // canonical (also JWKS host)
    process.env.PARACHUTE_HUB_ORIGINS = `${fixture.origin},${SECOND}`;
    const token = await signAgentJwt(kp, { iss: SECOND });
    const claims = await makeAgentGuard().validateHubJwt(token);
    expect(claims.sub).toBe("user-1");
    expect(claims.aud).toBe(AGENT_AUDIENCE);
  });

  test("the canonical origin still validates when PARACHUTE_HUB_ORIGINS lists a different second origin", async () => {
    // The resolved hubOrigin is always added to the set, so a token minted under
    // the canonical origin keeps validating even when the env names only others.
    process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
    process.env.PARACHUTE_HUB_ORIGINS = SECOND; // env need not include the canonical
    const token = await signAgentJwt(kp, { iss: fixture.origin });
    const claims = await makeAgentGuard().validateHubJwt(token);
    expect(claims.sub).toBe("user-1");
  });

  test("token issued by a THIRD, unlisted origin is rejected even with PARACHUTE_HUB_ORIGINS set", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
    process.env.PARACHUTE_HUB_ORIGINS = `${fixture.origin},${SECOND}`;
    const token = await signAgentJwt(kp, { iss: THIRD });
    await expect(makeAgentGuard().validateHubJwt(token)).rejects.toThrow(/verification failed/);
  });

  test("back-compat: with PARACHUTE_HUB_ORIGINS UNSET only the canonical origin validates; a second origin is rejected", async () => {
    delete process.env.PARACHUTE_HUB_ORIGINS;
    process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
    // canonical iss → accepted
    const ok = await signAgentJwt(kp, { iss: fixture.origin });
    expect((await makeAgentGuard().validateHubJwt(ok)).sub).toBe("user-1");
    // the same SECOND origin that WOULD pass when listed → rejected when unset
    const bad = await signAgentJwt(kp, { iss: SECOND });
    await expect(makeAgentGuard().validateHubJwt(bad)).rejects.toThrow(/verification failed/);
  });
});
