import { randomUUID, timingSafeEqual } from "node:crypto";
export function validateMatchConfig(c) {
  const errors = [],
    id = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x);
  if (!c || typeof c !== "object") return ["config must be an object"];
  if (!id(c.id)) errors.push("id must be a stable identifier");
  if (c.game !== "race-of-wool") errors.push("game must be race-of-wool");
  if (
    !c.map?.id ||
    !c.map?.version ||
    !c.map?.sha256 ||
    !/^[a-f0-9]{64}$/i.test(c.map.sha256)
  )
    errors.push("operator map id, version and SHA-256 are required");
  if (!Number.isSafeInteger(c.durationMs) || c.durationMs <= 0)
    errors.push("durationMs must be positive integer");
  const teams = Array.isArray(c.teams) ? c.teams : [],
    participants = Array.isArray(c.participants) ? c.participants : [];
  if (
    teams.length < 2 ||
    teams.some((t) => !id(t.id)) ||
    new Set(teams.map((t) => t.id)).size !== teams.length
  )
    errors.push("at least two unique teams required");
  if (
    !participants.length ||
    participants.some(
      (p) => !id(p.id) || !teams.some((t) => t.id === p.team),
    ) ||
    new Set(participants.map((p) => p.id)).size !== participants.length
  )
    errors.push("unique participants with known teams required");
  if (teams.some((t) => !participants.some((p) => p.team === t.id)))
    errors.push("each team needs participants");
  const objectives = c.rules?.objectives;
  if (
    !Array.isArray(objectives) ||
    !objectives.length ||
    objectives.some((x) => !id(x)) ||
    new Set(objectives).size !== objectives.length
  )
    errors.push("rules.objectives requires unique objective IDs");
  if (c.rules?.winner !== "first-team-all-objectives")
    errors.push("supported winner rule: first-team-all-objectives");
  if (!["draw", "most-objectives"].includes(c.rules?.onTimeout))
    errors.push("onTimeout must be draw or most-objectives");
  if (!c.versions?.participantImage || !c.versions?.bridge)
    errors.push("participantImage and bridge versions required");
  return errors;
}
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
    this.config = structuredClone(config);
    this.connector = connector;
    this.now = now;
    this.eventToken = eventToken;
    this.onEnding = onEnding;
    this.state = "created";
    this.runId = runId;
    this.seen = new Set();
    this.events = [];
    this.progress = Object.fromEntries(config.teams.map((t) => [t.id, []]));
    this.metrics = { deaths: {}, disconnects: {} };
    this.transition = false;
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
    if (this.now() >= this.startedAt + this.config.durationMs) {
      await this.checkTimeout();
      return { late: true };
    }
    if (event.type === "objective" || event.type === "objective-lost") {
      if (
        !Object.hasOwn(this.progress, event.team) ||
        !this.config.rules.objectives.includes(event.objective)
      )
        throw new Error("Unknown team/objective");
      if (event.type === "objective-lost")
        this.progress[event.team] = this.progress[event.team].filter(
          (x) => x !== event.objective,
        );
      else if (!this.progress[event.team].includes(event.objective))
        this.progress[event.team].push(event.objective);
    } else if (["death", "disconnect"].includes(event.type)) {
      if (!this.config.participants.some((p) => p.id === event.participant))
        throw new Error("Unknown participant");
      const bucket =
        this.metrics[event.type === "death" ? "deaths" : "disconnects"];
      bucket[event.participant] = (bucket[event.participant] ?? 0) + 1;
    } else throw new Error("Unsupported authoritative event");
    this.seen.add(event.id);
    this.events.push({ ...structuredClone(event), receivedAt: this.now() });
    if (event.type === "objective") await this.#finishObjectives();
    return { accepted: true };
  }
  /** Trusted full observation round. All teams are judged after one atomic update. */
  async observe(observations) {
    if (this.state !== "running") throw new Error("Match is not running");
    const receivedAt = this.now();
    if (receivedAt >= this.startedAt + this.config.durationMs) {
      await this.checkTimeout();
      return { late: true };
    }
    const next = Object.fromEntries(this.config.teams.map((t) => [t.id, []]));
    const events = [];
    for (const { id: team } of this.config.teams) {
      for (const objective of this.config.rules.objectives) {
        const complete = observations[team]?.[objective];
        // A missing observation must never silently clear a scored objective.
        if (typeof complete !== "boolean")
          throw new Error("A full observation round is required");
        if (complete) next[team].push(objective);
        if (complete === this.progress[team].includes(objective)) continue;
        events.push({
          id: randomUUID(),
          runId: this.runId,
          type: complete ? "objective" : "objective-lost",
          team,
          objective,
          receivedAt,
        });
      }
    }
    this.progress = next;
    for (const event of events) {
      this.seen.add(event.id);
      this.events.push(event);
    }
    await this.#finishObjectives();
    return { accepted: true };
  }
  async #finishObjectives() {
    const winners = this.config.teams.filter(
      (t) => this.progress[t.id].length === this.config.rules.objectives.length,
    );
    if (winners.length > 1)
      return this.#finish("simultaneous-objectives", null);
    if (winners.length === 1)
      return this.#finish("objectives-complete", winners[0].id);
  }
  async checkTimeout() {
    if (
      this.state !== "running" ||
      this.now() < this.startedAt + this.config.durationMs
    )
      return false;
    let winner = null;
    if (this.config.rules.onTimeout === "most-objectives") {
      const scores = Object.entries(this.progress).sort(
        (a, b) => b[1].length - a[1].length,
      );
      if (scores[0][1].length > scores[1][1].length) winner = scores[0][0];
    }
    await this.#finish("timeout", winner);
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
    if (
      ![
        "abandoned",
        "map-fault",
        "runtime-fault",
        "timeout",
        "objectives-complete",
        "simultaneous-objectives",
      ].includes(reason)
    )
      throw new Error("Invalid end reason");
    if (winner !== null && !Object.hasOwn(this.progress, winner))
      throw new Error("Invalid winner");
    if (
      reason === "objectives-complete" &&
      (!winner ||
        this.progress[winner].length !== this.config.rules.objectives.length)
    )
      throw new Error("Objective completion not established");
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
        await this.connector.stop(this.runId);
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
  result() {
    if (this.state !== "ended") throw new Error("Result is not final");
    return structuredClone({
      matchId: this.config.id,
      runId: this.runId,
      mode: this.connector.mode ?? "external",
      state: this.state,
      reason: this.reason,
      winner: this.winner,
      startedAt: this.startedAt ?? null,
      endedAt: this.endedAt,
      elapsedMs:
        this.startedAt === undefined ? 0 : this.endedAt - this.startedAt,
      progress: this.progress,
      metrics: this.metrics,
      events: this.events,
      map: this.config.map,
      versions: this.config.versions,
      stopConfirmed: this.stopConfirmed,
      stopError: this.stopError,
      observerError: this.observerError,
      runtimeError: this.runtimeError,
      stateReportError: this.stateReportError,
      ...(this.replay ? { replay: this.replay } : {}),
    });
  }
}
