/**
 * Tests for `buildJobAlertNotify` — the Telegram-delivery half of the runner's
 * job-failure/-recovery alert (agent's risk register R1: a scheduled job's fire
 * failing used to write `lastStatus: "error: ..."` on its `#agent/job` note and
 * NOTHING else happened; every outage to date was found by hand).
 *
 * The transition/throttle DECISION logic (when to alert at all) is Runner-internal
 * and transport-agnostic — see runner.test.ts. This file covers only how the daemon
 * wires that decision to an actual send: env-var config resolution (both set / one
 * set / neither set) and the reply() call against a real `TelegramTransport` (network
 * stubbed via `globalThis.fetch`, mirroring jobs.test.ts / daemon-vault-chat.test.ts).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJobAlertNotify } from "./daemon.ts";
import { TelegramTransport } from "./transports/telegram.ts";
import type { Channel } from "./registry.ts";
import type { Job } from "./jobs.ts";
import type { JobAlertEvent } from "./runner.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: "morning-weave",
    channel: "uni-dev",
    message: "run the weave",
    schedule: { cron: "0 4 * * *", tz: "America/Los_Angeles" },
    enabled: true,
    createdAt: "2026-06-17T00:00:00.000Z",
    noteId: "Jobs/uni-dev/morning-weave",
    ...over,
  };
}

/** A live "ops" telegram channel backed by a REAL TelegramTransport (network stubbed
 *  per-test via globalThis.fetch). Caller must rmSync the returned dir afterward. */
function telegramChannel(name: string): { channel: Channel; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-alert-test-"));
  const transport = new TelegramTransport({ token: "test-token", name, stateDir: dir });
  return {
    channel: { name, transport, entry: { name, transport: "telegram", config: { token: "test-token" } } },
    dir,
  };
}

describe("buildJobAlertNotify — config resolution", () => {
  test("both env vars unset → undefined (the out-of-the-box, silent-skip state)", () => {
    expect(buildJobAlertNotify(new Map(), {})).toBeUndefined();
  });

  test("only PARACHUTE_AGENT_ALERT_CHANNEL set → undefined (partial config)", () => {
    expect(buildJobAlertNotify(new Map(), { PARACHUTE_AGENT_ALERT_CHANNEL: "ops" })).toBeUndefined();
  });

  test("only PARACHUTE_AGENT_ALERT_CHAT_ID set → undefined (partial config)", () => {
    expect(buildJobAlertNotify(new Map(), { PARACHUTE_AGENT_ALERT_CHAT_ID: "12345" })).toBeUndefined();
  });

  test("both set → a notify function is returned", () => {
    const notify = buildJobAlertNotify(new Map(), {
      PARACHUTE_AGENT_ALERT_CHANNEL: "ops",
      PARACHUTE_AGENT_ALERT_CHAT_ID: "12345",
    });
    expect(typeof notify).toBe("function");
  });
});

describe("buildJobAlertNotify — delivery", () => {
  test("the named channel isn't live/telegram → drops silently, never throws", async () => {
    const notify = buildJobAlertNotify(new Map(), {
      PARACHUTE_AGENT_ALERT_CHANNEL: "ops",
      PARACHUTE_AGENT_ALERT_CHAT_ID: "12345",
    })!;
    const event: JobAlertEvent = { job: makeJob(), previousStatus: "ok", newStatus: "error: boom", kind: "error" };
    await expect(notify(event)).resolves.toBeUndefined();
  });

  test("an error event sends via reply() to the configured chat_id, with job/agent/cron/error/note", async () => {
    const { channel, dir } = telegramChannel("ops");
    try {
      const channels = new Map<string, Channel>([["ops", channel]]);
      const notify = buildJobAlertNotify(channels, {
        PARACHUTE_AGENT_ALERT_CHANNEL: "ops",
        PARACHUTE_AGENT_ALERT_CHAT_ID: "999888777",
      })!;

      let sentBody: Record<string, unknown> | undefined;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).includes("/sendMessage")) throw new Error(`unexpected fetch: ${url}`);
        sentBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as typeof fetch;

      const job = makeJob();
      await notify({ job, previousStatus: "ok", newStatus: "error: vault unreachable", kind: "error" });

      expect(sentBody?.chat_id).toBe("999888777");
      const text = String(sentBody?.text);
      expect(text).toContain(job.id);
      expect(text).toContain(job.channel);
      expect(text).toContain(job.schedule.cron);
      expect(text).toContain("error: vault unreachable");
      expect(text).toContain(job.noteId!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a recovery event sends a short recovered line with no error/note detail", async () => {
    const { channel, dir } = telegramChannel("ops");
    try {
      const channels = new Map<string, Channel>([["ops", channel]]);
      const notify = buildJobAlertNotify(channels, {
        PARACHUTE_AGENT_ALERT_CHANNEL: "ops",
        PARACHUTE_AGENT_ALERT_CHAT_ID: "999888777",
      })!;

      let sentText: string | undefined;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).includes("/sendMessage")) throw new Error(`unexpected fetch: ${url}`);
        sentText = JSON.parse(String(init?.body)).text;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }), { status: 200 });
      }) as typeof fetch;

      await notify({ job: makeJob(), previousStatus: "error: down", newStatus: "ok", kind: "recovery" });

      expect(sentText).toMatch(/Recovered/i);
      expect(sentText).not.toMatch(/error:/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a reply() failure (e.g. Telegram API down) propagates — the caller (runner) is what swallows it", async () => {
    const { channel, dir } = telegramChannel("ops");
    try {
      const channels = new Map<string, Channel>([["ops", channel]]);
      const notify = buildJobAlertNotify(channels, {
        PARACHUTE_AGENT_ALERT_CHANNEL: "ops",
        PARACHUTE_AGENT_ALERT_CHAT_ID: "999888777",
      })!;
      globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response("boom", { status: 500 })) as typeof fetch;

      await expect(
        notify({ job: makeJob(), previousStatus: "ok", newStatus: "error: x", kind: "error" }),
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
