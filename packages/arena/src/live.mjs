import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MatchHost, normalizeConfig } from "./index.mjs";
import { createJudge, spawned } from "./judges.mjs";
import { RconClient } from "./rcon.mjs";
import { createReplayRecorder, validateReplay } from "./replay.mjs";
// Mode instructions are prompt text, not a map: keep them small.
export const MAX_PROMPT_BYTES = 32 * 1024;
const validCommands = (list) =>
  Array.isArray(list) &&
  list.every(
    (x) =>
      typeof x?.command === "string" &&
      !!x.command &&
      typeof x.expect === "string" &&
      !!x.expect,
  );
function validateLive(config) {
  const c = normalizeConfig(config);
  if (
    !c.live?.minecraft?.host ||
    !c.live.minecraft.version ||
    !c.live.rcon?.host ||
    !c.live.rcon.passwordEnv
  )
    throw new Error(
      "Live Minecraft version/host and RCON host/passwordEnv required",
    );
  for (const phase of ["prepare", "start", "end"]) {
    const list = c.live.commands?.[phase];
    if (list !== undefined && !validCommands(list))
      throw new Error(
        `Explicit ${phase} command/expected-response pairs required`,
      );
  }
  for (const p of c.participants)
    if (
      !p.username ||
      !p.bridge?.tokenEnv ||
      !Number.isSafeInteger(p.bridge.port)
    )
      throw new Error(`Live username/bridge config required for ${p.id}`);
  validateReplay(c);
  for (const [team, views] of Object.entries(c.live.openingViews ?? {})) {
    if (!c.teams.some((t) => t.id === team))
      throw new Error("Unknown openingViews team");
    for (const box of [
      views.course?.bounds,
      views.course?.entryBounds,
      ...(views.lobby ? [views.lobby.bounds] : []),
    ]) {
      if (
        !box ||
        !["x", "y", "z"].every(
          (a) =>
            Number.isSafeInteger(box.min?.[a]) &&
            Number.isSafeInteger(box.max?.[a]) &&
            box.min[a] <= box.max[a],
        )
      )
        throw new Error(
          "Opening views require integer inclusive bounds and course.entryBounds",
        );
    }
    for (const view of [views.lobby, views.course].filter(Boolean)) {
      const volume = ["x", "y", "z"].reduce(
        (n, a) => n * (view.bounds.max[a] - view.bounds.min[a] + 1),
        1,
      );
      if (volume > 1_000_000)
        throw new Error("Opening view exceeds 1,000,000 cells");
    }
  }
}
export { validateLive };
/**
 * Reads `briefing.promptFile` relative to the config file's directory.
 * Returns null when no prompt file is configured.
 */
export async function loadBriefingPrompt(config, configPath) {
  const file = normalizeConfig(config)?.briefing?.promptFile;
  if (!file) return null;
  const path = resolve(dirname(resolve(configPath)), file);
  if ((await stat(path)).size > MAX_PROMPT_BYTES)
    throw new Error(`briefing.promptFile exceeds ${MAX_PROMPT_BYTES} bytes`);
  return readFile(path, "utf8");
}
const validName = (name) =>
  /^[A-Za-z0-9_]{1,16}$/.test(name ?? "") ? name : null;
/** Uses real RCON lifecycle commands, a judge and one gated bridge per player. */
export async function createLiveMatch(
  rawConfig,
  {
    env = process.env,
    startLiveBridge,
    rconFactory = (options) => new RconClient(options),
    now = Date.now,
    runId,
    resultDir = process.cwd(),
    replayFactory = createReplayRecorder,
    briefingPrompt = null,
  } = {},
) {
  validateLive(rawConfig);
  const config = normalizeConfig(rawConfig);
  if (!startLiveBridge)
    ({ startLiveBridge } = await import("../../mf-bridge/live.mjs"));
  const rcon = rconFactory({
    ...config.live.rcon,
    password: env[config.live.rcon.passwordEnv],
  });
  const bridges = new Map(),
    endedBots = new WeakSet();
  let host,
    timer,
    polling = false,
    eventCounter = 0,
    replay;
  const timeout = config.live.readyTimeoutMs ?? 30000;
  const runCommands = async (phase, list = []) => {
    for (const { command, expect } of list) {
      const response = await rcon.command(command);
      if (!new RegExp(expect).test(response))
        throw new Error(`RCON ${phase} command acknowledgement mismatch`);
    }
  };
  const execute = (phase) => runCommands(phase, config.live.commands?.[phase]);
  const quitBot = async (bot) => {
    if (!bot?.quit || endedBots.has(bot)) return;
    if (!bot.once) {
      bot.quit();
      return;
    }
    await new Promise((resolve, reject) => {
      const onEnd = () => {
        clearTimeout(t);
        endedBots.add(bot);
        resolve();
      };
      const t = setTimeout(() => {
        bot.off("end", onEnd);
        reject(new Error("Bot disconnect acknowledgement timeout"));
      }, config.live.stopTimeoutMs ?? 5000);
      bot.once("end", onEnd);
      try {
        bot.quit();
      } catch (e) {
        clearTimeout(t);
        bot.off("end", onEnd);
        reject(e);
      }
    });
  };
  const judge = createJudge(config, { rcon, host: () => host });
  const cleanup = async (preserveStatus = false) => {
    clearInterval(timer);
    const failures = [];
    for (const b of bridges.values()) {
      for (const fn of [
        () => b.bot.clearControlStates?.(),
        () => b.bot.pathfinder?.setGoal(null),
        () => b.bot.stopDigging?.(),
        () => b.bot.deactivateItem?.(),
        () => (preserveStatus && b.stopGame ? b.stopGame() : b.close()),
        () => quitBot(b.bot),
      ]) {
        try {
          await fn();
        } catch (e) {
          failures.push(e.message);
        }
      }
    }
    if (!preserveStatus) bridges.clear();
    rcon.close();
    if (failures.length)
      throw new Error(`Stop failures: ${failures.join("; ")}`);
  };
  const publicData = () => {
    const merged = { ...config.briefing.public, ...judge.public() };
    return Object.keys(merged).length ? merged : null;
  };
  // The session object each bridge serves at /v1/session.
  const sessionView = (p) => {
    const published = publicData();
    const objectives = Array.isArray(published?.objectives)
      ? published.objectives
      : undefined;
    return {
      kind: config.session.kind,
      sessionId: config.id,
      matchId: config.id,
      runId: host.runId,
      participantId: p.id,
      teamId: p.team ?? null,
      username: validName(p.username),
      teams: config.teams.map((t) => ({ id: t.id })),
      participants: config.participants.map((participant) => ({
        id: participant.id,
        username: validName(participant.username),
        teamId: participant.team ?? null,
      })),
      map: config.map
        ? { id: config.map.id, version: config.map.version }
        : null,
      objectives,
      openingViews: p.team ? config.live.openingViews?.[p.team] : undefined,
      briefing: {
        text: config.briefing.text,
        prompt: briefingPrompt,
        public: published,
      },
      state: host.state,
      startedAt: host.startedAt ?? null,
      durationMs: config.session.durationMs ?? null,
      now: now(),
      elapsedMs:
        host.startedAt === undefined
          ? null
          : Math.max(0, (host.endedAt ?? now()) - host.startedAt),
      winner: host.outcome,
      scores: host.scores ?? null,
    };
  };
  const connector = {
    mode: "live-rcon-mineflayer",
    prepare: async () => {
      try {
        await rcon.connect();
        await replay.prepare();
        await execute("prepare");
        for (const p of config.participants) {
          const token = env[p.bridge.tokenEnv];
          if (!token) throw new Error(`Missing bridge token for ${p.id}`);
          const b = await startLiveBridge({
            minecraft: { ...config.live.minecraft, username: p.username },
            bridge: {
              ...p.bridge,
              token,
              blockMemory: {
                worldId: config.map
                  ? `${config.map.id}@${config.map.version}`
                  : `session:${config.id}`,
                runId: host.runId,
                participantId: p.id,
              },
              host: p.bridge.host ?? "0.0.0.0",
              authorizeAction: () => host.state === "running",
              getMatchState: () => sessionView(p),
            },
          });
          bridges.set(p.id, b);
          await spawned(b.bot, timeout);
          b.bot.on?.("death", () => {
            if (host.state === "running")
              void host
                .ingest(
                  {
                    runId: host.runId,
                    id: `death:${p.id}:${eventCounter++}`,
                    type: "death",
                    participant: p.id,
                  },
                  host.eventToken,
                )
                .catch(() => {});
          });
          b.bot.on?.("end", () => {
            endedBots.add(b.bot);
            if (host.state === "running")
              void host
                .ingest(
                  {
                    runId: host.runId,
                    id: `disconnect:${p.id}:${eventCounter++}`,
                    type: "disconnect",
                    participant: p.id,
                  },
                  host.eventToken,
                )
                // Only the operator ends an open session.
                .then(() => host.kind === "match" && host.end("abandoned"))
                .catch(() => {});
          });
        }
        await judge.afterBridges();
      } catch (e) {
        try {
          await cleanup();
        } catch {}
        throw e;
      }
    },
    start: async () => {
      if ([...bridges.values()].some((b) => endedBots.has(b.bot)))
        throw new Error("Game connection ended before match start");
      await replay.start();
      await execute("start");
      await judge.start();
    },
    stop: async (_runId, reason) => {
      let error;
      const fail = (e) => {
        error = error ? new Error(`${error.message}; ${e.message}`) : e;
      };
      for (const b of bridges.values()) {
        for (const fn of [
          () => b.bot.clearControlStates?.(),
          () => b.bot.pathfinder?.setGoal(null),
          () => b.bot.stopDigging?.(),
          () => b.bot.deactivateItem?.(),
        ]) {
          try {
            await fn();
          } catch (e) {
            error = e;
          }
        }
      }
      try {
        await execute("end");
      } catch (e) {
        error = e;
      }
      try {
        await judge.stop(reason);
      } catch (e) {
        fail(e);
      } finally {
        await replay.requestStop();
        try {
          await cleanup(true);
        } catch (e) {
          fail(e);
        }
      }
      await replay.finish();
      if (error) throw error;
    },
  };
  host = new MatchHost({
    config: rawConfig,
    connector,
    now,
    runId,
    eventToken: env[config.live.eventTokenEnv] ?? "internal-observer-only",
  });
  replay = replayFactory({ config, runId: host.runId, resultDir, rcon });
  host.replay = replay.state;
  const poll = async () => {
    if (polling || host.state !== "running") return;
    polling = true;
    try {
      await judge.poll();
    } catch (e) {
      host.judgeError = e.message;
      await host.end("map-fault");
    } finally {
      polling = false;
    }
  };
  return {
    host,
    bridges,
    judge,
    async prepare() {
      await host.prepare();
    },
    async start() {
      await host.start();
      timer = setInterval(() => void poll(), config.judge.pollMs);
      await poll();
    },
    poll,
    async close(reason = "abandoned") {
      let result;
      if (
        host.transition ||
        ["running", "prepared", "ending", "ended"].includes(host.state)
      )
        result = await host.end(reason);
      await cleanup(false);
      return result;
    },
  };
}
