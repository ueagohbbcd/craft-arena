import { setTimeout as delay } from "node:timers/promises";
import { parseStorageReply, serializeSnbt } from "./snbt.mjs";

/**
 * Judges decide the match outcome for the live runner. Every judge has the
 * same shape:
 *
 * - `beforeBridges()`: prepare work before participant bots join.
 * - `afterBridges()`: prepare work once every participant bot has spawned.
 * - `start()`: release the match on the judge's side.
 * - `poll()`: one reading while running; throws to end the match `map-fault`.
 * - `stop(reason)`: freeze and read the final state while the host is ending.
 * - `close()`: release judge-owned connections.
 * - `lost()`: true when a judge connection ended before the start.
 * - `public()`: latest public data the server published, or null.
 */
export function createJudge(config, context) {
  const type = config.judge.type;
  if (type === "monument-blocks") return monumentBlocksJudge(config, context);
  if (type === "datapack") return datapackJudge(config, context);
  if (type === "none") return noJudge(context);
  throw new Error(`Unknown judge type ${type}`);
}

export async function spawned(bot, timeoutMs) {
  if (bot.entity) return;
  await new Promise((resolve, reject) => {
    const done = (e) => {
      clearTimeout(timer);
      bot.off("spawn", onSpawn);
      bot.off("error", onError);
      bot.off("end", onEnd);
      e ? reject(e) : resolve();
    };
    const onSpawn = () => done(),
      onError = (e) => done(e),
      onEnd = () => done(new Error("Minecraft disconnected before ready"));
    const timer = setTimeout(
      () => done(new Error("Minecraft spawn timeout")),
      timeoutMs,
    );
    bot.once("spawn", onSpawn);
    bot.once("error", onError);
    bot.once("end", onEnd);
  });
}

/** No judging: the session runs until the operator stops it. */
function noJudge({ host }) {
  return {
    type: "none",
    async beforeBridges() {},
    async afterBridges() {},
    async start() {},
    async poll() {
      await host().checkTimeout();
    },
    async stop() {},
    async close() {},
    lost: () => false,
    public: () => null,
  };
}

/**
 * The trusted referee bot reads each configured goal block every poll and
 * reports one full observation round to the host.
 */
function monumentBlocksJudge(
  config,
  { createBot, Vec3, host, timeoutMs, runCommands, quitBot, endedBots },
) {
  const { goals, observer: observerConfig } = config.judge;
  let observer;
  const read = (g) =>
    observer.blockAt(new Vec3(g.position.x, g.position.y, g.position.z));
  const matches = (g, b) =>
    b?.name === g.block &&
    Object.entries(g.properties ?? {}).every(
      ([k, v]) => b.getProperties?.()[k] === v,
    );
  return {
    type: "monument-blocks",
    observer: () => observer,
    async beforeBridges() {
      observer = createBot({ ...config.live.minecraft, ...observerConfig });
      await spawned(observer, timeoutMs);
      observer.on?.("end", () => {
        endedBots.add(observer);
        if (host().state === "running") void host().end("map-fault");
      });
      observer.on?.("error", () => {
        if (host().state === "running") void host().end("map-fault");
      });
      await runCommands("observer", observerConfig.commands ?? []);
      if (
        observer.registry?.blocksByName &&
        goals.some((g) => !observer.registry.blocksByName[g.block])
      )
        throw new Error(
          "Configured goal block unknown for selected Minecraft version",
        );
      const deadline = Date.now() + timeoutMs;
      while (goals.some((g) => !read(g))) {
        if (Date.now() >= deadline)
          throw new Error(
            "Goal chunks unavailable: position trusted observer so all configured monuments are loaded",
          );
        await delay(100);
      }
      if (goals.some((g) => matches(g, read(g))))
        throw new Error(
          "Reset verification failed: a goal is already complete",
        );
    },
    async afterBridges() {},
    async start() {},
    async poll() {
      const observations = Object.fromEntries(
        config.teams.map((t) => [t.id, Object.create(null)]),
      );
      for (const goal of goals) {
        const block = read(goal);
        if (!block)
          throw new Error(
            "Goal observation became unavailable during running match",
          );
        observations[goal.team][goal.objective] = matches(goal, block);
      }
      await host().observe(observations);
    },
    async stop() {},
    async close() {
      await quitBot(observer);
    },
    lost: () => !!observer && endedBots.has(observer),
    public: () => null,
  };
}

export const PROTOCOL_VERSION = 1;
// Consecutive unreadable polls tolerated before the match ends `map-fault`.
export const MAX_FAILED_POLLS = 3;
const REJECTED =
  /Unknown or incomplete command|Incorrect argument|Unknown function|Unknown storage|Expected |Invalid |Can't |Cannot |Could not /i;

/** Validated `arena:session` contents, or an error for a malformed one. */
export function readServerSession(reply) {
  const value = parseStorageReply(reply, "arena:session");
  if (!value) throw new Error("arena:session is empty");
  if (value.version !== PROTOCOL_VERSION)
    throw new Error(`Unsupported arena:session version ${value.version}`);
  if (!["waiting", "running", "ended"].includes(value.state))
    throw new Error(`Invalid arena:session state ${value.state}`);
  for (const key of ["winner", "message"])
    if (value[key] !== undefined && typeof value[key] !== "string")
      throw new Error(`arena:session ${key} must be a string`);
  if (
    value.scores !== undefined &&
    (!value.scores ||
      typeof value.scores !== "object" ||
      Array.isArray(value.scores) ||
      Object.values(value.scores).some((n) => typeof n !== "number"))
  )
    throw new Error("arena:session scores must map names to numbers");
  if (
    value.public !== undefined &&
    (!value.public ||
      typeof value.public !== "object" ||
      Array.isArray(value.public))
  )
    throw new Error("arena:session public must be a compound");
  return {
    state: value.state,
    winner: value.winner || null,
    scores: value.scores ?? null,
    public: value.public ?? null,
    message: value.message || null,
  };
}

/** The `arena:config` value written before `#arena:prepare`. */
export function serverConfig(config, runId) {
  const value = {
    version: PROTOCOL_VERSION,
    sessionId: config.id,
    runId,
    kind: config.session.kind,
    teams: config.teams.map((t) => ({
      id: t.id,
      players: config.participants
        .filter((p) => p.team === t.id)
        .map((p) => p.username),
    })),
  };
  if (config.session.durationMs != null)
    value.durationMs = config.session.durationMs;
  return value;
}

/**
 * Server protocol v1 over RCON: write `arena:config`, run the `#arena:*`
 * function tags and poll `arena:session` (see docs/GAME-MODES.md).
 */
function datapackJudge(config, { rcon, host }) {
  let failures = 0,
    published = null,
    prepared = false;
  const run = async (phase) => {
    const reply = await rcon.command(`function #arena:${phase}`);
    if (/Unknown function/i.test(reply))
      throw new Error(
        `Server has no #arena:${phase} function tag; install the arena datapack`,
      );
    if (REJECTED.test(reply))
      throw new Error(
        `Server rejected #arena:${phase}: ${reply.slice(0, 200)}`,
      );
  };
  const read = async () => {
    const session = readServerSession(
      await rcon.command("data get storage arena:session"),
    );
    if (session.public) published = session.public;
    return session;
  };
  return {
    type: "datapack",
    async beforeBridges() {},
    async afterBridges() {
      // `data modify` needs a path, so the root cannot be replaced in one
      // command: drop the optional key a previous session may have left, then
      // merge (lists and scalars in the merge replace the old values).
      await rcon.command("data remove storage arena:config durationMs");
      const reply = await rcon.command(
        `data merge storage arena:config ${serializeSnbt(serverConfig(config, host().runId))}`,
      );
      if (REJECTED.test(reply))
        throw new Error(
          `Server rejected arena:config: ${String(reply).slice(0, 200)}`,
        );
      await run("prepare");
      prepared = true;
      // Pick up public data published at prepare for the opening briefing.
      try {
        await read();
      } catch {}
    },
    async start() {
      await run("start");
    },
    async poll() {
      if (await host().checkTimeout()) return;
      // Only the operator ends an open session: the server there only
      // publishes data, so read failures and "ended" are recorded, not final.
      const open = config.session.kind === "open";
      let session;
      try {
        session = await read();
        failures = 0;
      } catch (e) {
        failures++;
        if (open) host().judgeError = `arena:session unreadable: ${e.message}`;
        else if (failures > MAX_FAILED_POLLS)
          throw new Error(`Server session unreadable: ${e.message}`);
        return;
      }
      if (host().state !== "running") return;
      if (session.state === "ended" && !open) await host().verdict(session);
      else host().report(session);
    },
    async stop(reason) {
      // A server-declared end is already final; anything else is frozen here.
      if (!prepared || reason === "judge-decision") return;
      let error;
      try {
        await run("stop");
      } catch (e) {
        error = e;
      }
      try {
        host().conclude(await read());
      } catch (e) {
        host().judgeError = `Final arena:session read failed: ${e.message}`;
        host().conclude({});
      }
      if (error) throw error;
    },
    async close() {},
    lost: () => false,
    public: () => published,
  };
}
