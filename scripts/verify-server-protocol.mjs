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
 *     and removed blocks, a win, a same-tick draw, and #arena:stop;
 *   - live (unless --skip-live): live-cli.mjs with two real Mineflayer bots;
 *     the red bot places its wool through the SDK and the datapack must
 *     declare red the winner.
 * Needs Java 21 on PATH. Exits non-zero on the first failed check.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RconClient } from "../packages/arena/src/rcon.mjs";
import {
  readServerSession,
  serverConfig,
} from "../packages/arena/src/judges.mjs";
import { parseSnbt, serializeSnbt } from "../packages/arena/src/snbt.mjs";
import { verifyDownload } from "./prepare-minecraft-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (text) => console.log(text);
const PASSWORD = "verify-protocol-rcon";
const PORTS = { game: 25565, rcon: 25575, red: 18080, blue: 18082 };

async function serverJar(dir) {
  if (option("--jar")) return resolve(option("--jar"));
  const manifest = JSON.parse(
    await readFile(join(root, "infra/minecraft-download.json"), "utf8"),
  );
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

async function rconSession(rcon) {
  return readServerSession(
    await rcon.command("data get storage arena:session"),
  );
}

async function writeConfig(rcon, config) {
  await rcon.command("data remove storage arena:config durationMs");
  await rcon.command(
    `data merge storage arena:config ${serializeSnbt(serverConfig(config, "verify"))}`,
  );
}

const twoTeams = {
  id: "verify",
  session: { kind: "match", durationMs: 60000 },
  teams: [{ id: "red" }, { id: "blue" }],
  participants: [
    { username: "arena_red1", team: "red" },
    { username: "arena_blue1", team: "blue" },
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
  assert.equal((await rconSession(rcon)).state, "waiting");
  await rcon.command("function #arena:start");
  assert.equal((await rconSession(rcon)).state, "running");
  await rcon.command("scoreboard players add red arena_points 3");
  await delay(300);
  const s = await rconSession(rcon);
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
  const ready = async () => {
    await writeConfig(rcon, twoTeams);
    await rcon.command("function #arena:prepare");
  };
  const scores = async () => (await rconSession(rcon)).scores;

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
  assert.deepEqual((await rconSession(rcon)).public.objectives, map.objectives);
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
  let s = await rconSession(rcon);
  assert.equal(s.state, "ended");
  assert.equal(s.winner, "red");
  assert.match(await rcon.command("forceload query"), /No force loaded/);
  log("ok race-of-wool: reset, scores follow blocks, win, chunks released");

  await ready();
  for (const goal of map.goals) await place(goal);
  await rcon.command("function #arena:start");
  await delay(300);
  s = await rconSession(rcon);
  assert.equal(s.winner, "draw");
  log("ok race-of-wool: same-tick completion is a draw");

  await ready();
  await rcon.command("function #arena:start");
  await place(goals("blue")[0]);
  await delay(200);
  await rcon.command("function #arena:stop");
  s = await rconSession(rcon);
  assert.equal(s.state, "ended");
  assert.equal(s.winner, null);
  assert.equal(s.scores.blue, 1);
  log("ok race-of-wool: #arena:stop records held objectives");
  return map;
}

async function live(rcon, dir, map) {
  const red = map.goals.filter((g) => g.team === "red");
  const xs = map.goals.map((g) => g.x),
    zs = map.goals.map((g) => g.z),
    y = red[0].y;
  const box = `${Math.min(...xs) - 4} ${y - 1} ${Math.min(...zs) - 4} ${Math.max(...xs) + 4} ${y - 1} ${Math.max(...zs) + 4}`;
  await rcon.command(
    `forceload add ${Math.min(...xs) - 4} ${Math.min(...zs) - 4} ${Math.max(...xs) + 4} ${Math.max(...zs) + 4}`,
  );
  await rcon.command(`fill ${box} minecraft:stone`);
  await rcon.command("forceload remove all");

  const config = JSON.parse(
    await readFile(
      join(root, "infra/windows-local/match.direct-fire.json"),
      "utf8",
    ),
  );
  config.id = "verify-live";
  config.session.durationMs = 120000;
  config.live.minecraft.host = "127.0.0.1";
  config.live.minecraft.port = PORTS.game;
  config.live.rcon = {
    host: "127.0.0.1",
    port: PORTS.rcon,
    passwordEnv: "MC_RCON_PASSWORD",
  };
  config.live.replay = { enabled: false };
  config.live.startSignalFile = join(dir, "control/start");
  const stand = (goal) => `${goal.x + 0.5} ${goal.y} ${goal.z + 3.5}`;
  config.live.commands = {
    start: [
      { command: `tp arena_red1 ${stand(red[1])}`, expect: "Teleported" },
      ...red.map((g) => ({
        command: `give arena_red1 ${g.block} 1`,
        expect: "Gave",
      })),
    ],
  };
  config.participants[0].bridge = {
    host: "127.0.0.1",
    port: PORTS.red,
    tokenEnv: "RED1_BRIDGE_TOKEN",
  };
  config.participants[1].bridge = {
    host: "127.0.0.1",
    port: PORTS.blue,
    tokenEnv: "BLUE1_BRIDGE_TOKEN",
  };
  await mkdir(join(dir, "control"), { recursive: true });
  const configPath = join(dir, "match.json"),
    resultPath = join(dir, "result.json");
  await writeFile(configPath, JSON.stringify(config));
  const env = {
    ...process.env,
    MC_RCON_PASSWORD: PASSWORD,
    RED1_BRIDGE_TOKEN: "verify-red-bridge-token",
    BLUE1_BRIDGE_TOKEN: "verify-blue-bridge-token",
  };
  const host = spawn(
    process.execPath,
    [join(root, "packages/arena/src/live-cli.mjs"), configPath, resultPath],
    { env, stdio: ["ignore", "pipe", "inherit"] },
  );
  let output = "";
  host.stdout.on("data", (c) => (output += c));
  const until = async (pattern, ms = 60000) => {
    const end = Date.now() + ms;
    while (!pattern.test(output)) {
      if (Date.now() > end || host.exitCode !== null)
        throw new Error(`arena host never reported ${pattern}:\n${output}`);
      await delay(100);
    }
  };
  try {
    await until(/waiting-for-operator-start/);
    await writeFile(config.live.startSignalFile, "");
    await until(/"state":"running"/);
    const { connectBot, Vector } =
      await import("../packages/bot-sdk/index.mjs");
    const bot = await connectBot({
      url: `http://127.0.0.1:${PORTS.red}`,
      token: env.RED1_BRIDGE_TOKEN,
    });
    try {
      const session = await bot.getSessionState();
      const mine = session.briefing.public.goals.filter(
        (g) => g.team === session.teamId,
      );
      await delay(1000);
      for (const goal of mine) {
        const name = goal.block.replace("minecraft:", "");
        const item = bot.inventory.items().find((i) => i.name === name);
        assert.ok(item, `bot holds ${name}`);
        await bot.equip(item, "hand");
        await bot.placeBlock(
          bot.blockAt(new Vector(goal.x, goal.y - 1, goal.z)),
          new Vector(0, 1, 0),
        );
      }
    } finally {
      bot.closeBridge();
    }
    await until(/"state":"ended"/);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.reason, "judge-decision");
    assert.equal(result.winner, "red");
    assert.equal(result.stopConfirmed, true);
    log("ok live: arena host + two real bots, SDK placement, datapack verdict");
  } finally {
    host.kill("SIGTERM");
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
