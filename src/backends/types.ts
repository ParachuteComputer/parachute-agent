/**
 * The `AgentBackend` seam (design 2026-06-16-pluggable-agent-backend.md).
 *
 * A channel agent is "driven" in one of two ways, and the way is a swappable
 * choice behind ONE interface:
 *
 *   - **Interactive** (today's path): an idle interactive `claude` in a tmux pane,
 *     fed inbound messages by pushing onto a subscribed MCP "development channel."
 *     `start` = the tmux spawn (`spawnAgent`); `deliver` = a push onto the MCP GET
 *     stream. This backend carries the whole deaf-on-restart fragility class
 *     (no-loss high-water-mark + backlog replay #67, per-session restart #68, the
 *     dev-channels consent-gate auto-confirm #70/#71).
 *
 *   - **Programmatic** (this seam's first new implementor — `ProgrammaticBackend`):
 *     run ONE sandboxed `claude -p` turn per inbound message and capture the reply.
 *     There is no idle session, so there is nothing to go deaf, nothing to
 *     reconnect, no backlog to replay, no TUI gate to answer. `deliver` is a direct
 *     turn into a fresh `claude -p` invocation that resumes the channel's prior
 *     conversation (`--resume <session_id>`). The daemon turns the returned reply
 *     into an outbound `#agent/message/outbound` note (the wiring follow-up).
 *
 * Everything ABOVE this seam is backend-agnostic: the vault message transport
 * (`#agent/message/{inbound,outbound}`), the chat UI, the sandbox/isolation
 * envelope, and the per-channel env/credential injection. Only the
 * "drive-the-agent" layer differs.
 *
 * ── The asymmetric delivery guarantee (design's load-bearing caveat) ────────────
 * The interactive `deliver` (push onto the MCP GET stream) can SILENTLY fail if
 * the session is deaf — it is `void` there only because the #67 high-water-mark +
 * backlog replay catches the gap out-of-band. The programmatic `deliver` is a
 * direct turn into a fresh invocation, so failure is observable INLINE. To stop the
 * interactive side's silent-loss footgun leaking into the programmatic contract,
 * `deliver` returns a {@link DeliverResult} discriminated union — the programmatic
 * backend reports `{ ok: false, error }` rather than swallowing a failure, and a
 * future interactive retrofit reports `{ ok: true }` once the push is enqueued
 * (its real durability staying in the #67 machinery, as today).
 *
 * NOTE: this PR defines the contract and ships the PROGRAMMATIC implementor only.
 * The interactive spawn (`spawnAgent`) is NOT refactored to implement this
 * interface here — that retrofit is the wiring follow-up. The shape is deliberately
 * chosen to fit both: `start(spec)` maps to either the tmux spawn or "open a
 * programmatic session," and `deliver(handle, message)` maps to either a push or a
 * `claude -p` turn.
 */

import type { AgentSpec } from "../sandbox/types.ts";
import type { InterimTurnEvent } from "./stream-json.ts";
import type { InboundAttachment } from "../transport.ts";

export type { InboundAttachment } from "../transport.ts";

export type { InterimTurnEvent } from "./stream-json.ts";

/**
 * A sink for interim turn progress (the streaming view, design
 * 2026-06-16-channel-architecture-post-programmatic.md build item #1). The backend
 * calls this as a turn runs — assistant text chunks, which tool the agent is using,
 * the session-establishing init — so the daemon can push live progress to the chat
 * UI WHILE the turn is in flight. It is ADDITIVE: the durable record is still the
 * final {@link DeliverResult} the backend returns. Optional on `deliver` — a backend
 * that can't stream (or a caller that doesn't want live progress) omits it and the
 * turn behaves exactly as before. MUST NOT throw (a throw would abort the drain);
 * the daemon's implementation swallows dead-stream errors.
 */
export type InterimSink = (event: InterimTurnEvent) => void;

/**
 * The Claude session UUID for ONE turn, RESOLVED BY THE CALLER (the registry) and
 * handed to the backend. The daemon owns the session UUID — it lives on the durable
 * `#agent/thread` note (`metadata.session`), NOT in a backend-private store — so the
 * caller decides, per turn, whether to CONTINUE a prior conversation or CREATE a new
 * one, and the backend just runs the turn it's handed:
 *  - `resume: true`  → `claude --resume <id> -p "…"` — continue a prior conversation
 *    (single-threaded turn 2+: the thread note already carries a session).
 *  - `resume: false` → `claude --session-id <id> -p "…"` — CREATE a session with this
 *    uuid (single-threaded first turn, or every multi-threaded fresh-per-fire turn).
 * `id` MUST be a valid UUID (the caller mints it via `crypto.randomUUID()` when there
 * is no prior session to resume).
 */
export interface TurnSession {
  /** The Claude session UUID for this turn. */
  id: string;
  /** true → --resume <id> (continue a prior conversation); false → --session-id <id> (create a new one). */
  resume: boolean;
}

/**
 * An opaque handle to a started agent, returned by {@link AgentBackend.start} and
 * passed back to `deliver`/`stop`/`status`. The only field the seam itself depends
 * on is `channel` (the wake channel a turn/push targets) + the backend's own
 * `backend` tag; a backend may carry additional private fields it needs.
 */
export interface AgentHandle {
  /** Which backend produced this handle (so a multiplexer can route correctly). */
  backend: string;
  /** The wake channel this agent serves (the first channel of its spec). */
  channel: string;
  /** The agent's slug name (the spec name). */
  name: string;
  /**
   * The spec the agent was started from. The programmatic backend reproduces each
   * turn (its mint scope + sandbox policy) from this; a backend that keeps a
   * resident process (interactive) need not read it. Optional so the seam doesn't
   * force every backend to round-trip the whole spec on its handle.
   */
  spec?: AgentSpec;
}

/**
 * Token usage for one turn, surfaced for observability (cost/quota awareness — the
 * programmatic backend draws on the operator's subscription quota, a real capacity
 * limit per the design). Shape mirrors what `claude -p`'s `result` event reports;
 * fields are optional because a backend may not have them.
 */
export interface DeliverUsage {
  inputTokens?: number;
  outputTokens?: number;
  /**
   * The `result` event's `total_cost_usd` — an EQUIVALENT-cost figure on the
   * subscription path (NOT a charge; the turn draws on the subscription, design §1
   * of the pluggable-backend doc). Surfaced for observability only.
   */
  totalCostUsd?: number;
}

/**
 * One file the turn wrote into its PRIVATE session workspace `outbox/` dir (Phase 2:
 * outbound file attachments). Swept by the backend after a successful turn + surfaced
 * on the {@link DeliverResult} so the daemon's outbound write uploads it to the vault
 * + links it onto the outbound note. UNTRUSTED filename (the agent chose it) — the
 * backend already reduced it to a safe basename, but the downstream vault upload
 * re-derives the storage filename + validates the extension server-side.
 */
export interface OutboxFile {
  /** Absolute path to the swept file on disk (inside the private session `outbox/`). */
  absPath: string;
  /** A SAFE basename (no path components, no traversal) — the display name + ext source. */
  basename: string;
}

/**
 * The result of delivering one message — a discriminated union so a failure is
 * always observable inline (never a silent drop). On success the daemon turns
 * `reply` into an outbound `#agent/message/outbound` note (the wiring follow-up).
 */
export type DeliverResult =
  | {
      ok: true;
      /** The agent's reply text (the `result` event's `result` field). */
      reply: string;
      /**
       * The session id this turn ran under — captured + persisted so the NEXT turn
       * resumes the same conversation (`--resume <sessionId>`). Absent if the turn
       * produced no id (degenerate output).
       */
      sessionId?: string;
      /** Optional token/cost usage for observability. */
      usage?: DeliverUsage;
      /**
       * OUTBOUND FILE ATTACHMENTS (Phase 2): files the turn wrote into its PRIVATE
       * session workspace `outbox/` dir. After a successful turn the backend sweeps
       * that dir and surfaces the swept files here (absolute path + a safe basename);
       * the daemon's outbound write uploads each to the vault + links it onto the
       * outbound `#agent/message/outbound` note so a surface renders it. Absent/empty
       * → a text-only reply (today's behavior). Surfaced ONLY on a successful turn
       * (an outbox from a failed turn is discarded with the workspace).
       */
      outboxFiles?: OutboxFile[];
    }
  | {
      ok: false;
      /** A human-readable failure reason (does NOT throw — failure is a value). */
      error: string;
      /**
       * The session id, if one was captured before the failure — so a follow-up
       * turn can still resume (a turn can fail AFTER establishing a session).
       */
      sessionId?: string;
    };

/** The live/health status of a started agent (for `/health`). */
export interface AgentStatus {
  live: boolean;
}

/**
 * The pluggable agent-driving seam. A channel chooses a backend; the daemon calls
 * this interface and stays strategy-agnostic.
 */
export interface AgentBackend {
  /** A stable identifier for the backend kind (e.g. "programmatic", "interactive"). */
  readonly kind: string;

  /**
   * Bring an agent up for a channel from its spec. For the programmatic backend
   * this is lightweight (there is no resident process to launch — and no session to
   * pre-establish: the session uuid is resolved per turn by the caller and lives on
   * the durable `#agent/thread` note); for the interactive backend it is the tmux
   * spawn. Returns an opaque handle the other methods take.
   */
  start(spec: AgentSpec): Promise<AgentHandle>;

  /**
   * Hand the agent one inbound message and get its reply. Returns a
   * {@link DeliverResult} — a failure is a value (`{ ok: false, error }`), NEVER a
   * throw, so the caller always learns the outcome inline (the asymmetric-guarantee
   * fix). The daemon serializes deliveries per channel (one turn at a time).
   *
   * `session` is the {@link TurnSession} the CALLER resolved for this turn — the
   * daemon owns the session UUID (it lives on the durable `#agent/thread` note, not a
   * backend store), so the caller decides resume-existing (`resume: true` →
   * `--resume <id>`) vs create-new (`resume: false` → `--session-id <id>`). The
   * backend just runs the turn with that uuid; it no longer reads or writes any
   * session store. The captured/echoed id still comes back on the
   * {@link DeliverResult} (`sessionId`) so the caller can persist it onto the note.
   *
   * `onInterim` (optional) is the streaming-view sink: the backend calls it with
   * interim progress (assistant text chunks + tool_use) AS the turn runs, so the
   * daemon can render "watch it work" live in the chat UI. ADDITIVE — when omitted,
   * the turn behaves exactly as before; the final {@link DeliverResult} is the
   * durable record either way. (Only the programmatic backend streams today; an
   * interactive retrofit may ignore it.)
   *
   * `attachments` (optional, Phase 1) are files attached to the inbound message. The
   * programmatic backend stages each into the agent's PRIVATE session workspace (under
   * a safe basename) before the turn and appends a workspace-relative pointer to the
   * prompt, so the `claude -p` turn can `Read` them. ADDITIVE — absent/empty → no
   * staging, the turn behaves exactly as before.
   *
   * OUTBOUND attachments (Phase 2) are the symmetric inverse: the backend tells the turn
   * to write any reply attachments into its private `outbox/` dir, then — on a SUCCESSFUL
   * turn — sweeps that dir and surfaces the files on the result's `outboxFiles`, which the
   * daemon uploads to the vault + links onto the outbound note. ADDITIVE — no outbox files
   * → an unchanged text-only reply.
   */
  deliver(
    handle: AgentHandle,
    message: string,
    session: TurnSession,
    onInterim?: InterimSink,
    attachments?: InboundAttachment[],
  ): Promise<DeliverResult>;

  /**
   * Tear the agent down. For the programmatic backend this is a NO-OP — there is no
   * resident process to kill and no session store to clear (the session lives on the
   * durable `#agent/thread` note), so stop does NOT reset conversation continuity; the
   * interactive backend kills the tmux session.
   */
  stop(handle: AgentHandle): Promise<void>;

  /** Report whether the agent is live (for `/health`). */
  status(handle: AgentHandle): Promise<AgentStatus>;
}
