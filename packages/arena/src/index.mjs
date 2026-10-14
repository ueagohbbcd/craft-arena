import { randomUUID, timingSafeEqual } from "node:crypto";
const id = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x);
const plainObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);

function briefingBlock(briefing) {
  const b = plainObject(briefing) ? briefing : {};
  return {
    text: typeof b.text === "string" ? b.text : null,
    promptFile: typeof b.promptFile === "string" ? b.promptFile : null,
    public: plainObject(b.public) ? b.public : null,
  };
}

/** Returns a copy with session, judge and briefing defaults filled in. Never throws. */
export function normalizeConfig(config) {
  if (!plainObject(config)) return config;
  const c = structuredClone(config);
  c.teams = Array.isArray(c.teams) ? c.teams : [];
  const kind = c.session?.kind ?? "match";
  c.session = {
    ...c.session,
    kind,
    durationMs: c.session?.durationMs ?? null,
    onTimeout: kind === "open" ? null : (c.session?.onTimeout ?? "draw"),
  };
  const type = c.judge?.type ?? (kind === "open" ? "none" : "datapack");
  c.judge = {
    ...c.judge,
    type,
    pollMs: c.judge?.pollMs ?? 500,
  };
  c.briefing = briefingBlock(c.briefing);
  return c;
}

function validateSession(c, errors) {
  const kind = c.session?.kind ?? "match";
  if (!plainObject(c.session) || !["match", "open"].includes(kind))
    errors.push("session.kind must be match or open");
  const duration = c.session?.durationMs ?? null,
    type = c.judge?.type ?? (kind === "open" ? "none" : "datapack"),
    onTimeout = c.session?.onTimeout;
  if (c.judge !== undefined && !plainObject(c.judge))
    errors.push("judge must be an object");
  if (
    c.judge?.pollMs !== undefined &&
    (!Number.isSafeInteger(c.judge.pollMs) || c.judge.pollMs <= 0)
  )
    errors.push("judge.pollMs must be positive integer");
  if (kind === "open") {
    if (duration !== null)
      errors.push("open sessions have no durationMs (use null)");
    if (onTimeout !== undefined && onTimeout !== null)
      errors.push("open sessions have no onTimeout");
    if (!["none", "datapack"].includes(type))
      errors.push("open sessions use judge none or datapack");
  } else {
    if (!Number.isSafeInteger(duration) || duration <= 0)
      errors.push("session.durationMs must be positive integer");
    if (type !== "datapack") errors.push("matches use judge datapack");
    if (onTimeout !== undefined && !["draw", "most-score"].includes(onTimeout))
      errors.push("onTimeout must be draw or most-score");
  }
}

function validateBriefing(b, errors) {
  if (b === undefined) return;
  if (!plainObject(b)) {
    errors.push("briefing must be an object");
    return;
  }
  if (b.text != null && typeof b.text !== "string")
    errors.push("briefing.text must be a string");
  if (
    b.promptFile != null &&
    (typeof b.promptFile !== "string" || !b.promptFile)
  )
    errors.push("briefing.promptFile must be a path");
  if (b.public != null && !plainObject(b.public))
    errors.push("briefing.public must be an object");
}

export function validateMatchConfig(c) {
  const errors = [];
  if (!plainObject(c)) return ["config must be an object"];
  if (!id(c.id)) errors.push("id must be a stable identifier");
  const open = c.session?.kind === "open";
  if (
    (!open || c.map != null) &&
    (!c.map?.id ||
      !c.map?.version ||
      !c.map?.sha256 ||
      !/^[a-f0-9]{64}$/i.test(c.map.sha256))
  )
    errors.push("operator map id, version and SHA-256 are required");
  // Pre-datapack race-of-wool configs: rules now live on the server.
  if (["game", "rules", "durationMs"].some((k) => k in c) || c.live?.goals)
    errors.push(
      "game, rules, durationMs and live.goals are no longer supported: use session/judge and a server datapack (infra/datapacks/race-of-wool)",
    );
  validateSession(c, errors);
  validateBriefing(c.briefing, errors);
  const teams = Array.isArray(c.teams) ? c.teams : [],
    participants = Array.isArray(c.participants) ? c.participants : [];
  if (
    (open
      ? c.teams !== undefined && !Array.isArray(c.teams)
      : teams.length < 2) ||
    teams.some((t) => !id(t.id)) ||
    new Set(teams.map((t) => t.id)).size !== teams.length
  )
    errors.push(
      open ? "teams must be unique" : "at least two unique teams required",
    );
  if (
    !participants.length ||
    participants.some(
      (p) =>
        !id(p.id) ||
        (open && !teams.length
          ? p.team !== undefined && p.team !== null
          : !teams.some((t) => t.id === p.team)),
    ) ||
    new Set(participants.map((p) => p.id)).size !== participants.length
  )
    errors.push("unique participants with known teams required");
  if (!open && teams.some((t) => !participants.some((p) => p.team === t.id)))
    errors.push("each team needs participants");
  if (!c.versions?.participantImage || !c.versions?.bridge)
    errors.push("participantImage and bridge versions required");
  return errors;
}
const END_REASONS = [
  "abandoned",
  "map-fault",
  "runtime-fault",
  "timeout",
  "judge-decision",
];
// Ends without a winner that still count as a draw rather than no result.
const DRAW_REASONS = ["timeout", "judge-decision"];
const validScores = (scores) =>
  plainObject(scores) &&
  Object.values(scores).every((v) => typeof v === "number" && isFinite(v));
/** Trusted orchestration only. No participant-facing method may submit scoring events. */
export class MatchHost {
  constructor({
    config,
    connector,
    now = Date.now,
    eventToken,
    runId = randomUUID(),
    onEnding = () => {},
  }) {
    const errors = validateMatchConfig(config);
    if (errors.length) throw new Error(errors.join("; "));
    if (
      !connector ||
      !["prepare", "start", "stop"].every(
        (k) => typeof connector[k] === "function",
      )
    )
      throw new Error("Trusted connector required");
    if (typeof eventToken !== "string" || !eventToken.length)
      throw new Error("Operator-provided event token required");
    this.config = normalizeConfig(config);
    this.connector = connector;
    this.now = now;
    this.eventToken = eventToken;
    this.onEnding = onEnding;
    this.state = "created";
    this.runId = runId;
    this.seen = new Set();
    this.events = [];
    this.teamIds = new Set(this.config.teams.map((t) => t.id));
    this.metrics = { deaths: {}, disconnects: {} };
    this.scores = null;
    this.transition = false;
  }
  get kind() {
    return this.config.session.kind;
  }
  get deadline() {
    const duration = this.config.session.durationMs;
    return duration == null || this.startedAt === undefined
      ? Infinity
      : this.startedAt + duration;
  }
  async prepare() {
    if (this.state !== "created" || this.transition)
      throw new Error("prepare requires created");
    this.transition = true;
    let finish;
    this.phaseDone = new Promise((r) => {
      finish = r;
    });
    try {
      await this.connector.prepare(structuredClone(this.config), this.runId);
      if (this.state !== "created")
        throw new Error("Prepare cancelled by match end");
      this.state = "prepared";
    } finally {
      this.transition = false;
      finish();
    }
    return this.state;
  }
  async start() {
    if (this.state !== "prepared" || this.transition)
      throw new Error("start requires prepared");
    this.transition = true;
    let finish;
    this.phaseDone = new Promise((r) => {
      finish = r;
    });
    try {
      await this.connector.start(this.runId);
      if (this.state !== "prepared")
        throw new Error("Start cancelled by match end");
      this.startedAt = this.now();
      this.state = "running";
    } finally {
      this.transition = false;
      finish();
    }
    return this.state;
  }
  authenticated(token) {
    return (
      typeof token === "string" &&
      Buffer.byteLength(token) === Buffer.byteLength(this.eventToken) &&
      timingSafeEqual(Buffer.from(token), Buffer.from(this.eventToken))
    );
  }
  async ingest(event, token) {
    if (!this.authenticated(token))
      throw new Error("Unauthorized scoring source");
    if (event.runId !== this.runId || typeof event.id !== "string" || !event.id)
      throw new Error("Invalid event identity");
    if (this.seen.has(event.id)) return { duplicate: true };
    if (this.state !== "running") throw new Error("Match is not running");
    if (this.now() >= this.deadline) {
      await this.checkTimeout();
      return { late: true };
    }
    if (["death", "disconnect"].includes(event.type)) {
      if (!this.config.participants.some((p) => p.id === event.participant))
        throw new Error("Unknown participant");
      const bucket =
        this.metrics[event.type === "death" ? "deaths" : "disconnects"];
      bucket[event.participant] = (bucket[event.participant] ?? 0) + 1;
    } else throw new Error("Unsupported authoritative event");
    this.seen.add(event.id);
    this.events.push({ ...structuredClone(event), receivedAt: this.now() });
    return { accepted: true };
  }
  /** Records the server judge's current scores and note without ending. */
  report({ scores, message } = {}) {
    if (!["prepared", "running", "ending"].includes(this.state))
      throw new Error("Match is not active");
    if (scores != null) {
      if (!validScores(scores)) throw new Error("Scores must be numbers");
      this.scores = structuredClone(scores);
    }
    if (typeof message === "string" && message) this.message = message;
  }
  /**
   * The server judge declared the end. `winner` is a team ID, "draw", or
   * empty/null (no winner, recorded as a draw). A verdict read at or after
   * the deadline ends as timeout instead.
   */
  async verdict({ winner = null, scores, message } = {}) {
    if (this.state !== "running") throw new Error("Match is not running");
    this.report({ scores, message });
    if (this.now() >= this.deadline) {
      await this.checkTimeout();
      return { late: true };
    }
    const team = winner === "draw" || winner === "" ? null : winner;
    if (team !== null && !this.teamIds.has(team))
      throw new Error(`Judge named unknown winner ${winner}`);
    await this.#finish("judge-decision", team);
    return { accepted: true };
  }
  /**
   * Final judge reading taken while ending (after `#arena:stop`). Scores and
   * message are recorded; on timeout a server winner overrides `onTimeout`.
   */
  conclude({ winner = null, scores, message } = {}) {
    if (this.state !== "ending") return;
    this.report({ scores, message });
    if (this.reason !== "timeout") return;
    if (winner === "draw") this.winner = null;
    else if (winner && this.teamIds.has(winner)) this.winner = winner;
    else this.winner = this.#timeoutWinner();
  }
  #timeoutWinner() {
    const ranked =
      this.config.session.onTimeout === "most-score" && this.scores
        ? this.config.teams.map((t) => [t.id, this.scores[t.id]])
        : [];
    const valid = ranked
      .filter(([, n]) => typeof n === "number")
      .sort((a, b) => b[1] - a[1]);
    if (!valid.length) return null;
    return valid.length === 1 || valid[0][1] > valid[1][1] ? valid[0][0] : null;
  }
  async checkTimeout() {
    if (this.state !== "running" || this.now() < this.deadline) return false;
    await this.#finish("timeout", this.#timeoutWinner());
    return true;
  }
  async end(reason = "abandoned", winner = null) {
    if (this.state === "ended") return this.result();
    if (this.state === "ending") return this.ending;
    if (
      !["running", "prepared"].includes(this.state) &&
      !(this.state === "created" && this.transition)
    )
      throw new Error("Cannot end this state");
    if (!END_REASONS.includes(reason)) throw new Error("Invalid end reason");
    if (winner !== null && !this.teamIds.has(winner))
      throw new Error("Invalid winner");
    return this.#finish(reason, winner);
  }
  async failRuntime(fault) {
    if (!["prepared", "running"].includes(this.state)) return;
    if (fault.runId !== this.runId)
      throw new Error("Runtime fault belongs to another run");
    this.runtimeError = structuredClone(fault);
    return this.end("runtime-fault");
  }
  async #finish(reason, winner) {
    const pendingPhase = this.transition ? this.phaseDone : null;
    this.state = "ending";
    this.endedAt = this.now();
    this.reason = reason;
    this.winner = winner;
    // Fail closed even when connector shutdown fails. Operator must ensure actual bots are stopped.
    this.ending = (async () => {
      // Publish "ending" before game shutdown makes participant runtimes exit.
      try {
        await this.onEnding(this);
      } catch (error) {
        this.stateReportError = error.message;
      }
      try {
        if (pendingPhase) await pendingPhase;
        await this.connector.stop(this.runId, reason);
        this.stopConfirmed = true;
      } catch (e) {
        this.stopConfirmed = false;
        this.stopError = e.message;
      }
      this.state = "ended";
      return this.result();
    })();
    return this.ending;
  }
  /** Session winner: a team ID, "draw", or null (no result or not ended). */
  get outcome() {
    if (!["ending", "ended"].includes(this.state)) return null;
    if (this.winner) return this.winner;
    return DRAW_REASONS.includes(this.reason) ? "draw" : null;
  }
  result() {
    if (this.state !== "ended") throw new Error("Result is not final");
    return structuredClone({
      matchId: this.config.id,
      runId: this.runId,
      kind: this.kind,
      judge: this.config.judge.type,
      mode: this.connector.mode ?? "external",
      state: this.state,
      reason: this.reason,
      winner: this.winner,
      draw: this.outcome === "draw",
      startedAt: this.startedAt ?? null,
      endedAt: this.endedAt,
      elapsedMs:
        this.startedAt === undefined ? 0 : this.endedAt - this.startedAt,
      scores: this.scores,
      message: this.message,
      metrics: this.metrics,
      events: this.events,
      map: this.config.map,
      versions: this.config.versions,
      stopConfirmed: this.stopConfirmed,
      stopError: this.stopError,
      judgeError: this.judgeError,
      runtimeError: this.runtimeError,
      stateReportError: this.stateReportError,
      ...(this.replay ? { replay: this.replay } : {}),
    });
  }
}
