#!/usr/bin/env node
/**
 * Real-server check of server protocol v1 and the shipped rule datapacks.
 *
 *   node scripts/verify-server-protocol.mjs [--dir DIR] [--jar server.jar] [--skip-live]
 *
 * Downloads the pinned vanilla server.jar from infra/minecraft-download.json
 * (or uses --jar), creates a flat offline world in DIR (default: a temporary
 * directory) with every datapack in infra/datapacks, starts it with RCON and
 * runs:
 *   - arena-example: config write, prepare/start, server-declared winner, and
 *     the reply for a missing function tag;
 *   - race-of-wool: monument reset and force-loading, scores following placed
 *     and removed blocks, a win, a same-tick draw, #arena:stop, the time
 *     limit from arena:config.rules.durationMs, and no limit without it; starts
 *     with the listed players offline;
 *   - live (unless --skip-live): a login gate and both characters under the
 *     toolkit's `mf` supervisor, a module run with `mf run` and a datapack
 *     verdict.
 * Needs Java 21 on PATH. Exits non-zero on the first failed check.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RconClient } from "../packages/arena/src/rcon.mjs";
import {
  readSession,
  writeServerConfig,
} from "../packages/arena/src/server-protocol.mjs";
import { parseSnbt } from "../packages/arena/src/snbt.mjs";
import {
  validateServerDownload,
  verifyDownload,
} from "./prepare-minecraft-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `check` until it is truthy; throws `message` after `ms`. */
async function waitFor(check, ms, message) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(message());
    await delay(150);
  }
}
const toolkitRuntime = dirname(
  fileURLToPath(
    import.meta.resolve("mineflayer-world-memory/runtime/supervisor.mjs"),
  ),
);
/** The toolkit's `mf` with the given environment; resolves to its exit code. */
function mf(env, ...mfArgs) {
  const child = spawn(
    process.execPath,
    [join(toolkitRuntime, "bin/mf.mjs"), ...mfArgs],
    {
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
}
const log = (text) => console.log(text);
const PASSWORD = "verify-protocol-rcon";
const PORTS = {
  game: 25565,
  gate: 25566,
  rcon: 25575,
  session: 18080,
};

async function serverJar(dir) {
  if (option("--jar")) return resolve(option("--jar"));
  const manifest = JSON.parse(
    await readFile(join(root, "infra/minecraft-download.json"), "utf8"),
  );
  validateServerDownload(manifest);
  const path = join(dir, "server.jar");
  try {
    verifyDownload(await readFile(path), manifest);
    return path;
  } catch {}
  log(`Downloading Minecraft ${manifest.minecraftVersion} server.jar`);
  const response = await fetch(manifest.url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyDownload(bytes, manifest);
  await writeFile(path, bytes);
  return path;
}

async function prepareWorld(dir) {
  await writeFile(join(dir, "eula.txt"), "eula=true\n");
  await writeFile(
    join(dir, "server.properties"),
    [
      "online-mode=false",
      "enable-rcon=true",
      `rcon.port=${PORTS.rcon}`,
      `rcon.password=${PASSWORD}`,
      `server-port=${PORTS.game}`,
      "level-type=minecraft\\:flat",
      "spawn-protection=0",
      "difficulty=peaceful",
      "",
    ].join("\n"),
  );
  const packs = join(dir, "world/datapacks");
  await mkdir(packs, { recursive: true });
  for (const name of await readdir(join(root, "infra/datapacks")))
    await cp(join(root, "infra/datapacks", name), join(packs, name), {
      recursive: true,
    });
}

function startServer(dir, jar) {
  const child = spawn("java", ["-Xmx2G", "-jar", jar, "nogui"], {
    cwd: dir,
    stdio: ["pipe", "pipe", "inherit"],
  });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("RCON running")) resolve();
    });
    child.once("exit", (code) =>
      reject(new Error(`Server exited (${code}):\n${output.slice(-2000)}`)),
    );
  });
  return { child, ready };
}

const writeConfig = writeServerConfig;

const twoTeams = {
  sessionId: "verify",
  kind: "match",
  rules: { durationMs: 60000 },
  teams: [
    { id: "red", players: ["arena_red1"] },
    { id: "blue", players: ["arena_blue1"] },
  ],
};

async function useOnly(rcon, pack) {
  for (const name of ["arena-example", "race-of-wool"])
    await rcon.command(
      `datapack ${name === pack ? "enable" : "disable"} "file/${name}"`,
    );
  await delay(500);
}

async function arenaExample(rcon) {
  await useOnly(rcon, "arena-example");
  await writeConfig(rcon, twoTeams);
  assert.match(
    await rcon.command("function #arena:prepare"),
    /Running function/,
  );
  assert.equal((await readSession(rcon)).state, "waiting");
  await rcon.command("function #arena:start");
  assert.equal((await readSession(rcon)).state, "running");
  await rcon.command("scoreboard players add red arena_points 3");
  await delay(300);
  const s = await readSession(rcon);
  assert.equal(s.state, "ended");
  assert.equal(s.winner, "red");
  assert.match(
    await rcon.command("function #arena:missing"),
    /Can't find any functions for name arena:missing/,
  );
  log("ok arena-example: prepare, start, server verdict, missing tag reply");
}

async function raceOfWool(rcon) {
  await useOnly(rcon, "race-of-wool");
  const map = parseSnbt(
    (
      await readFile(
        join(
          root,
          "infra/datapacks/race-of-wool/data/race_of_wool/function/map.mcfunction",
        ),
        "utf8",
      )
    ).match(/^data merge storage race_of_wool:map (\{.*\})$/m)[1],
  );
  const goals = (team) => map.goals.filter((g) => g.team === team);
  const place = async (goal, block = goal.block) =>
    rcon.command(`setblock ${goal.x} ${goal.y} ${goal.z} ${block}`);
  const ready = async (config = twoTeams) => {
    await writeConfig(rcon, config);
    await rcon.command("function #arena:prepare");
  };
  const scores = async () => (await readSession(rcon)).scores;

  // A dirty monument is cleared by prepare.
  const [first] = goals("red");
  await rcon.command(`forceload add ${first.x} ${first.z}`);
  await place(first);
  await ready();
  assert.match(
    await rcon.command(
      `execute if block ${first.x} ${first.y} ${first.z} minecraft:air`,
    ),
    /Test passed/,
  );
  assert.deepEqual((await readSession(rcon)).public.objectives, map.objectives);
  assert.match(await rcon.command("forceload query"), /force loaded chunks/);

  await rcon.command("function #arena:start");
  const red = goals("red");
  await place(red[0]);
  await place(red[1]);
  await delay(200);
  assert.equal((await scores()).red, 2);
  await place(red[1], "minecraft:air");
  await delay(200);
  assert.equal((await scores()).red, 1);
  for (const goal of red) await place(goal);
  await delay(300);
  let s = await readSession(rcon);
  assert.equal(s.state, "ended");
  assert.equal(s.winner, "red");
  assert.match(await rcon.command("forceload query"), /No force loaded/);
  log("ok race-of-wool: reset, scores follow blocks, win, chunks released");

  await ready();
  for (const goal of map.goals) await place(goal);
  await rcon.command("function #arena:start");
  await delay(300);
  s = await readSession(rcon);
  assert.equal(s.winner, "draw");
  log("ok race-of-wool: same-tick completion is a draw");

  await ready();
  await rcon.command("function #arena:start");
  await place(goals("blue")[0]);
  await delay(200);
  await rcon.command("function #arena:stop");
  s = await readSession(rcon);
  assert.equal(s.state, "ended");
  assert.equal(s.winner, null);
  assert.equal(s.scores.blue, 1);
  log("ok race-of-wool: #arena:stop records held objectives");

  // One second (20 ticks) limit: the datapack ends the match as a draw.
  await ready({ ...twoTeams, rules: { durationMs: 1000 } });
  await rcon.command("function #arena:start");
  await place(goals("red")[0]);
  await waitFor(
    async () => (await readSession(rcon)).state === "ended",
    5000,
    () => "time limit did not end the match",
  );
  s = await readSession(rcon);
  assert.equal(s.winner, "draw");
  assert.equal(s.message, "time limit reached");
  assert.equal(s.scores.red, 1);
  // Without rules.durationMs there is no limit.
  const { rules, ...unlimited } = twoTeams;
  await ready(unlimited);
  await rcon.command("function #arena:start");
  await delay(1500);
  assert.equal((await readSession(rcon)).state, "running");
  await rcon.command("function #arena:stop");
  log(
    "ok race-of-wool: rules.durationMs ends the match as a draw; none means no limit",
  );
  return map;
}

/**
 * A 7x7 stone floor under each map start, so a bot moved there does not fall,
 * even after the hostless round walks it forward a little.
 */
async function startPads(rcon, map) {
  for (const start of map.starts) {
    const [x, y, z] = [start.x, start.y - 1, start.z].map(Math.floor);
    const area = `${x - 3} ${z - 3} ${x + 3} ${z + 3}`;
    await rcon.command(`forceload add ${area}`);
    await rcon.command(
      `fill ${x - 3} ${y} ${z - 3} ${x + 3} ${y} ${z + 3} minecraft:stone`,
    );
    await rcon.command(`forceload remove ${area}`);
  }
}

/** `Pos` or `Rotation` of an online player, or null on a lost reply. */
async function entityList(rcon, name, path) {
  const reply = await rcon.command(`data get entity ${name} ${path}`);
  const m = reply.match(/has the following entity data: (\[[^\]]*\])/);
  return m ? parseSnbt(m[1]) : null;
}

/** Runs packages/arena/src/cli.mjs; resolves its parsed output. */
function arenaCli(...args) {
  return new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [join(root, "packages/arena/src/cli.mjs"), ...args],
      {
        env: {
          ...process.env,
          MC_RCON_HOST: "127.0.0.1",
          MC_RCON_PORT: String(PORTS.rcon),
          MC_RCON_PASSWORD: PASSWORD,
        },
      },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`cli.mjs ${args[0]}: ${stderr || error.message}`))
          : resolve(JSON.parse(stdout)),
    ),
  );
}

async function live(rcon, dir, map) {
  const red = map.goals.filter((g) => g.team === "red");
  const xs = map.goals.map((g) => g.x),
    zs = map.goals.map((g) => g.z),
    y = red[0].y;
  const [x0, z0, x1, z1] = [
    Math.min(...xs) - 4,
    Math.min(...zs) - 4,
    Math.max(...xs) + 4,
    Math.max(...zs) + 4,
  ];
  await rcon.command(`forceload add ${x0} ${z0} ${x1} ${z1}`);
  await rcon.command(
    `fill ${x0} ${y - 1} ${z0} ${x1} ${y - 1} ${z1} minecraft:stone`,
  );
  await rcon.command("forceload remove all");
  const match = JSON.parse(
    await readFile(
      join(root, "infra/windows-local/match.direct-fire.json"),
      "utf8",
    ),
  );
  match.config.sessionId = "verify-live";
  match.config.rules = { ...match.config.rules, durationMs: 120000 };
  match.commands.start = [
    ...(match.commands.start ?? []),
    ...red.map((g) => ({
      command: `give arena_red1 ${g.block} 1`,
      expect: "Gave",
    })),
  ];
  const matchPath = join(dir, "match.json");
  await writeFile(matchPath, JSON.stringify(match));
  const runDir = join(dir, "native-hosts");
  await mkdir(runDir, { recursive: true });
  const gate = spawn(
    process.execPath,
    [join(root, "packages/login-gate/cli.mjs")],
    {
      env: {
        ...process.env,
        GATE_HOST: "127.0.0.1",
        GATE_PORT: String(PORTS.gate),
        GATE_USERNAMES: "arena_red1,arena_blue1",
        GATE_UPSTREAM_HOST: "127.0.0.1",
        GATE_UPSTREAM_PORT: String(PORTS.game),
        GATE_SESSION_PORT: String(PORTS.session),
        GATE_RCON_HOST: "127.0.0.1",
        GATE_RCON_PORT: String(PORTS.rcon),
        GATE_RCON_PASSWORD: PASSWORD,
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  // Both characters under one `mf` supervisor, as in a participant container.
  const mfState = {
    MF_USERNAMES: "arena_red1,arena_blue1",
    MF_HOST: "127.0.0.1",
    MF_PORT: String(PORTS.gate),
    MC_VERSION: "1.21.1",
    MF_AUTH: "offline",
    MF_STATE_DIR: join(runDir, ".mf"),
    MF_DEFAULT_SCRIPTS: "",
    ARENA_SESSION_URL: `http://127.0.0.1:${PORTS.session}/v1/session`,
  };
  const supervisor = spawn(
    process.execPath,
    [join(toolkitRuntime, "supervisor.mjs")],
    {
      env: { ...process.env, ...mfState },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const session = async () => {
    const response = await fetch(
      `http://127.0.0.1:${PORTS.session}/v1/session?username=arena_red1`,
    );
    const body = await response.json();
    if (!response.ok || !body.ok)
      throw new Error("Login gate session read failed");
    return body.result;
  };
  const stop = async (child) => {
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  try {
    await waitFor(
      async () => {
        if (gate.exitCode !== null) throw new Error("login gate exited");
        if (supervisor.exitCode !== null)
          throw new Error("mf supervisor exited");
        const list = await rcon.command("list");
        return /arena_red1/.test(list) && /arena_blue1/.test(list);
      },
      60000,
      () => "native bots did not join through the login gate",
    );
    await arenaCli("prepare", matchPath);
    await waitFor(
      async () => (await session().catch(() => null))?.state === "waiting",
      5000,
      () => "native host did not see prepared round",
    );
    assert.equal((await session()).briefing.text, match.config.briefing);
    await arenaCli("start", matchPath);
    for (const team of match.config.teams) {
      const start = map.starts.find((item) => item.team === team.id);
      for (const name of team.players) {
        let pos, rotation;
        await waitFor(
          async () => {
            pos = await entityList(rcon, name, "Pos");
            rotation = await entityList(rcon, name, "Rotation");
            return (
              pos &&
              rotation &&
              Math.abs(pos[0] - start.x) < 0.3 &&
              Math.abs(pos[1] - start.y) < 0.3 &&
              Math.abs(pos[2] - start.z) < 0.3 &&
              Math.abs(rotation[0] - start.yaw) < 1
            );
          },
          5000,
          () => `${name} not at ${JSON.stringify(start)}`,
        );
      }
    }
    await rcon.command(
      `tp arena_red1 ${red[1].x + 0.5} ${red[1].y} ${red[1].z + 3.5}`,
    );
    const modulePath = join(runDir, "place-goals.mjs");
    await writeFile(
      modulePath,
      `import { Vec3 } from "vec3";\nexport default async function(bot) {\n  await bot.waitForChunksToLoad();\n  for (const goal of ${JSON.stringify(red)}) {\n    const item = bot.inventory.items().find((entry) => entry.name === goal.block.replace("minecraft:", ""));\n    if (bot.blockAt(new Vec3(goal.x, goal.y, goal.z))?.name === goal.block.replace("minecraft:", "")) continue;\n    if (!item) throw new Error("Missing " + goal.block);\n    await bot.equip(item, "hand");\n    await bot.placeBlock(bot.blockAt(new Vec3(goal.x, goal.y - 1, goal.z)), new Vec3(0, 1, 0));\n  }\n}\n`,
    );
    // prepare and start change the session, and the character notices each
    // change within a second. Like the model: read the inbox, run, and after
    // not_started (75) or an interruption (130) read again and rerun; the
    // module skips goals already placed. The last placement itself ends the
    // match, which may interrupt the module before it returns.
    let runExit;
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal(await mf(mfState, "inbox"), 0, "mf inbox");
      runExit = await mf(mfState, "run", "--bot", "arena_red1", modulePath);
      if (runExit === 0 || (await arenaCli("status")).state === "ended") break;
      assert.ok(
        [75, 130].includes(runExit),
        `module run ended with ${runExit}`,
      );
      await delay(1500);
    }
    await waitFor(
      async () => (await arenaCli("status")).state === "ended",
      10000,
      () => "datapack did not declare a winner after native placement",
    );
    assert.equal((await arenaCli("status")).winner, "red");
    // The gate polls RCON every 250 ms, so its copy can lag the CLI's read.
    await waitFor(
      async () => (await session()).winner === "red",
      5000,
      () => "login gate session did not report the winner",
    );
    log("ok live: login gate + mf characters, module run, datapack verdict");
  } finally {
    await stop(supervisor);
    await stop(gate);
    await delay(1000);
  }
}

const dir = resolve(
  option("--dir") ?? (await mkdtemp(join(tmpdir(), "arena-protocol-"))),
);
await mkdir(dir, { recursive: true });
const jar = await serverJar(dir);
await prepareWorld(dir);
const server = startServer(dir, jar);
let rcon;
try {
  await server.ready;
  rcon = new RconClient({
    host: "127.0.0.1",
    port: PORTS.rcon,
    password: PASSWORD,
  });
  await rcon.connect();
  await arenaExample(rcon);
  const map = await raceOfWool(rcon);
  await startPads(rcon, map);
  if (!args.includes("--skip-live")) await live(rcon, dir, map);
  log("All server protocol checks passed.");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  try {
    await rcon?.command("stop");
  } catch {}
  rcon?.close();
  const exited = new Promise((r) => server.child.once("exit", r));
  await Promise.race([exited, delay(30000)]);
  server.child.kill("SIGKILL");
}
