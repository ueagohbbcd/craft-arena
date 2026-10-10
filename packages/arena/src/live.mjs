import { setTimeout as delay } from "node:timers/promises";
import { MatchHost } from "./index.mjs";
import { RconClient } from "./rcon.mjs";
function validateLive(c) {
  if (
    !c.live?.minecraft?.host ||
    !c.live.minecraft.version ||
    !c.live.rcon?.host ||
    !c.live.rcon.passwordEnv
  )
    throw new Error(
      "Live Minecraft version/host and RCON host/passwordEnv required",
    );
  for (const phase of ["prepare", "start", "end"])
    if (
      !Array.isArray(c.live.commands?.[phase]) ||
      !c.live.commands[phase].length ||
      c.live.commands[phase].some(
        (x) =>
          typeof x.command !== "string" ||
          !x.command ||
          typeof x.expect !== "string" ||
          !x.expect,
      )
    )
      throw new Error(
        `Explicit ${phase} command/expected-response pairs required`,
      );
  for (const p of c.participants)
    if (
      !p.username ||
      !p.bridge?.tokenEnv ||
      !Number.isSafeInteger(p.bridge.port)
    )
      throw new Error(`Live username/bridge config required for ${p.id}`);
  if (!c.live.observer?.username)
    throw new Error("Trusted observer username required");
  for (const team of c.teams)
    for (const objective of c.rules.objectives) {
      const g = c.live.goals?.find(
        (x) => x.team === team.id && x.objective === objective,
      );
      if (
        !g ||
        typeof g.block !== "string" ||
        !g.position ||
        !["x", "y", "z"].every((k) => Number.isSafeInteger(g.position[k]))
      )
        throw new Error(
          `Operator goal block/position required for ${team.id}/${objective}`,
        );
    }
  if (
    new Set(c.live.goals.map((g) => JSON.stringify(g.position))).size !==
    c.live.goals.length
  )
    throw new Error("Goal positions must be distinct");
  if (c.live.goals.length !== c.teams.length * c.rules.objectives.length)
    throw new Error("Exactly one configured goal per team/objective required");
}
export { validateLive };
async function spawned(bot, timeoutMs) {
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
/** Uses real RCON lifecycle commands, real Mineflayer world observation and one gated bridge per player. */
export async function createLiveMatch(
  config,
  {
    env = process.env,
    createBot,
    startLiveBridge,
    rconFactory = (options) => new RconClient(options),
    now = Date.now,
    runId,
  } = {},
) {
  validateLive(config);
  if (!createBot)
    ({ createCompatibleBot: createBot } =
      await import("../../mf-bridge/minecraft-compat.mjs"));
  if (!startLiveBridge)
    ({ startLiveBridge } = await import("../../mf-bridge/live.mjs"));
  const { Vec3 } = await import("vec3");
  const rcon = rconFactory({
    ...config.live.rcon,
    password: env[config.live.rcon.passwordEnv],
  });
  const bridges = new Map(),
    endedBots = new WeakSet();
  let observer,
    host,
    timer,
    polling = false,
    eventCounter = 0;
  const timeout = config.live.readyTimeoutMs ?? 30000;
  const execute = async (phase) => {
    for (const { command, expect } of phase === "observer"
      ? (config.live.observer.commands ?? [])
      : config.live.commands[phase]) {
      const response = await rcon.command(command);
      if (!new RegExp(expect).test(response))
        throw new Error(`RCON ${phase} command acknowledgement mismatch`);
    }
  };
  const read = (g) =>
    observer.blockAt(new Vec3(g.position.x, g.position.y, g.position.z));
  const matches = (g, b) =>
    b?.name === g.block &&
    Object.entries(g.properties ?? {}).every(
      ([k, v]) => b.getProperties?.()[k] === v,
    );
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
    try {
      await quitBot(observer);
    } catch (e) {
      failures.push(e.message);
    }
    rcon.close();
    if (failures.length)
      throw new Error(`Stop failures: ${failures.join("; ")}`);
  };
  const connector = {
    mode: "live-rcon-mineflayer",
    prepare: async () => {
      try {
        await rcon.connect();
        await execute("prepare");
        observer = createBot({
          ...config.live.minecraft,
          ...config.live.observer,
        });
        await spawned(observer, timeout);
        observer.on?.("end", () => {
          endedBots.add(observer);
          if (host.state === "running") void host.end("map-fault");
        });
        observer.on?.("error", () => {
          if (host.state === "running") void host.end("map-fault");
        });
        await execute("observer");
        if (
          observer.registry?.blocksByName &&
          config.live.goals.some(
            (g) => !observer.registry.blocksByName[g.block],
          )
        )
          throw new Error(
            "Configured goal block unknown for selected Minecraft version",
          );
        const deadline = Date.now() + timeout;
        while (config.live.goals.some((g) => !read(g))) {
          if (Date.now() >= deadline)
            throw new Error(
              "Goal chunks unavailable: position trusted observer so all configured monuments are loaded",
            );
          await delay(100);
        }
        if (config.live.goals.some((g) => matches(g, read(g))))
          throw new Error(
            "Reset verification failed: a goal is already complete",
          );
        for (const p of config.participants) {
          const token = env[p.bridge.tokenEnv];
          if (!token) throw new Error(`Missing bridge token for ${p.id}`);
          const b = await startLiveBridge({
            minecraft: { ...config.live.minecraft, username: p.username },
            bridge: {
              ...p.bridge,
              token,
              host: p.bridge.host ?? "0.0.0.0",
              authorizeAction: () => host.state === "running",
              getMatchState: () => ({
                matchId: config.id,
                runId: host.runId,
                participantId: p.id,
                teamId: p.team,
                teams: config.teams.map((t) => ({ id: t.id })),
                game: config.game,
                map: { id: config.map.id, version: config.map.version },
                rules: config.rules,
                objectives:
                  config.live.publicObjectives ?? config.rules.objectives,
                publicGoalPositions:
                  config.live.publishGoalPositions === true
                    ? config.live.goals
                        .filter((g) => g.team === p.team)
                        .map((g) => ({
                          objective: g.objective,
                          position: g.position,
                          block: g.block,
                          properties: g.properties ?? {},
                        }))
                    : undefined,
                briefing:
                  config.live.briefing ??
                  "Complete your team monument objectives by placing the map-required blocks at the map-designated team monuments. All objectives are required. Simultaneous completion within one observer poll is a draw. Participant disconnection abandons the match; deaths do not end it. Use only the scoped game bridge and model gateway.",
                state: host.state,
                startedAt: host.startedAt ?? null,
                durationMs: config.durationMs,
                now: now(),
                elapsedMs:
                  host.startedAt === undefined
                    ? null
                    : Math.max(0, (host.endedAt ?? now()) - host.startedAt),
                winner: host.winner ?? null,
              }),
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
                .then(() => host.end("abandoned"))
                .catch(() => {});
          });
        }
      } catch (e) {
        try {
          await cleanup();
        } catch {}
        throw e;
      }
    },
    start: async () => {
      if (
        endedBots.has(observer) ||
        [...bridges.values()].some((b) => endedBots.has(b.bot))
      )
        throw new Error("Game connection ended before match start");
      await execute("start");
    },
    stop: async () => {
      let error;
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
      } finally {
        try {
          await cleanup(true);
        } catch (e) {
          error = error ? new Error(`${error.message}; ${e.message}`) : e;
        }
      }
      if (error) throw error;
    },
  };
  host = new MatchHost({
    config,
    connector,
    now,
    runId,
    eventToken: env[config.live.eventTokenEnv] ?? "internal-observer-only",
  });
  const poll = async () => {
    if (polling || host.state !== "running") return;
    polling = true;
    try {
      const observations = Object.fromEntries(
        config.teams.map((t) => [t.id, Object.create(null)]),
      );
      for (const goal of config.live.goals) {
        const block = read(goal);
        if (!block)
          throw new Error(
            "Goal observation became unavailable during running match",
          );
        observations[goal.team][goal.objective] = matches(goal, block);
      }
      await host.observe(observations);
    } catch (e) {
      host.observerError = e.message;
      await host.end("map-fault");
    } finally {
      polling = false;
    }
  };
  return {
    host,
    bridges,
    observer: () => observer,
    async prepare() {
      await host.prepare();
    },
    async start() {
      await host.start();
      timer = setInterval(() => void poll(), config.live.pollMs ?? 100);
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
