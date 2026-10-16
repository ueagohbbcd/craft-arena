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
 *     limit from arena:config.durationMs, and no limit without it;
 *   - live (unless --skip-live): two bridge processes in BRIDGE_SESSION=server
 *     mode with real Mineflayer bots, a round run by packages/arena/src/cli.mjs
 *     from a match file; the red bot places its wool through the SDK and the
 *     datapack must declare red the winner;
 *   - server-mode bridge: follows a round run with plain RCON commands, gates
 *     actions by its state and releases held keys when it ends.
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
import { join, resolve } from "node:path";
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
/** Starts packages/mf-bridge/cli.mjs as its own process. */
function spawnBridge(env, stdout = "ignore") {
  return spawn(process.execPath, [join(root, "packages/mf-bridge/cli.mjs")], {
    env: {
      ...process.env,
      MF_HOST: "127.0.0.1",
      MF_PORT: String(PORTS.game),
      MF_VERSION: "1.21.1",
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_BLOCK_MEMORY: "false",
      ...env,
    },
    stdio: ["ignore", stdout, "inherit"],
  });
}
const log = (text) => console.log(text);
const PASSWORD = "verify-protocol-rcon";
const PORTS = {
  game: 25565,
  rcon: 25575,
  red: 18080,
  blue: 18082,
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
  durationMs: 60000,
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
  await ready({ ...twoTeams, durationMs: 1000 });
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
  // Without durationMs there is no limit.
  const { durationMs, ...unlimited } = twoTeams;
  await ready(unlimited);
  await rcon.command("function #arena:start");
  await delay(1500);
  assert.equal((await readSession(rcon)).state, "running");
  await rcon.command("function #arena:stop");
  log(
    "ok race-of-wool: durationMs ends the match as a draw; none means no limit",
  );
  return map;
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
  // A stone floor under the monuments so the bot can place its wool.
  await rcon.command(`forceload add ${x0} ${z0} ${x1} ${z1}`);
  await rcon.command(
    `fill ${x0} ${y - 1} ${z0} ${x1} ${y - 1} ${z1} minecraft:stone`,
  );
  await rcon.command("forceload remove all");

  // The shipped Direct Fire match file, with start commands for this world.
  const match = JSON.parse(
    await readFile(
      join(root, "infra/windows-local/match.direct-fire.json"),
      "utf8",
    ),
  );
  match.config.sessionId = "verify-live";
  match.config.durationMs = 120000;
  const stand = (goal) => `${goal.x + 0.5} ${goal.y} ${goal.z + 3.5}`;
  match.commands.start = [
    { command: `tp arena_red1 ${stand(red[1])}`, expect: "Teleported" },
    ...red.map((g) => ({
      command: `give arena_red1 ${g.block} 1`,
      expect: "Gave",
    })),
  ];
  const matchPath = join(dir, "match.json");
  await writeFile(matchPath, JSON.stringify(match));

  const tokens = {
    red: "verify-red-bridge-token",
    blue: "verify-blue-bridge-token",
  };
  const bridges = [
    ["arena_red1", PORTS.red, tokens.red],
    ["arena_blue1", PORTS.blue, tokens.blue],
  ].map(([username, port, token]) =>
    spawnBridge({
      MF_USERNAME: username,
      BRIDGE_PORT: String(port),
      BRIDGE_TOKEN: token,
      BRIDGE_SESSION: "server",
      BRIDGE_RCON_HOST: "127.0.0.1",
      BRIDGE_RCON_PORT: String(PORTS.rcon),
      BRIDGE_RCON_PASSWORD: PASSWORD,
    }),
  );
  const session = async () =>
    (
      await (
        await fetch(`http://127.0.0.1:${PORTS.red}/v1/session`, {
          headers: { authorization: `Bearer ${tokens.red}` },
        })
      ).json()
    ).result;
  try {
    await waitFor(
      async () => {
        for (const bridge of bridges)
          if (bridge.exitCode !== null) throw new Error("bridge exited");
        const list = await rcon.command("list");
        return /arena_red1/.test(list) && /arena_blue1/.test(list);
      },
      60000,
      () => "bots did not join",
    );
    await arenaCli("prepare", matchPath);
    await waitFor(
      async () => (await session().catch(() => null))?.state === "waiting",
      5000,
      () => "bridge did not see the prepared round",
    );
    assert.equal((await session()).briefing.text, match.config.briefing);
    await arenaCli("start", matchPath);
    const { connectBot, Vector } =
      await import("../packages/bot-sdk/index.mjs");
    const bot = await connectBot({
      url: `http://127.0.0.1:${PORTS.red}`,
      token: tokens.red,
    });
    try {
      await waitFor(
        async () => (await bot.getSessionState()).state === "running",
        5000,
        () => "bridge did not see the start",
      );
      const state = await bot.getSessionState();
      const mine = state.briefing.public.goals.filter(
        (g) => g.team === state.teamId,
      );
      await delay(1000);
      // Right-clicking a bed by day sets the respawn point. Record where the
      // receipt arrives: a chat line reaches the chat inbox, an action-bar
      // line (game_info) does not.
      const messages = [];
      bot.on("messagestr", (text, position) =>
        messages.push({ text, position }),
      );
      const bed = { x: red[1].x + 2, y, z: red[1].z + 3 };
      await rcon.command("time set day");
      await rcon.command(
        `setblock ${bed.x} ${bed.y} ${bed.z - 1} minecraft:red_bed[facing=north,part=head]`,
      );
      await rcon.command(
        `setblock ${bed.x} ${bed.y} ${bed.z} minecraft:red_bed[facing=north,part=foot]`,
      );
      await waitFor(
        () => bot.blockAt(new Vector(bed.x, bed.y, bed.z))?.name === "red_bed",
        5000,
        () => "bot did not see the bed",
      );
      await bot.activateBlock(bot.blockAt(new Vector(bed.x, bed.y, bed.z)));
      await waitFor(
        () => messages.some((m) => /respawn point set/i.test(m.text)),
        5000,
        () => `no respawn receipt; saw ${JSON.stringify(messages)}`,
      );
      await delay(500);
      log(`ok bed: messages after right-click ${JSON.stringify(messages)}`);
      await rcon.command(`setblock ${bed.x} ${bed.y} ${bed.z} minecraft:air`);
      await rcon.command(
        `setblock ${bed.x} ${bed.y} ${bed.z - 1} minecraft:air`,
      );
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
    await waitFor(
      async () => (await arenaCli("status")).state === "ended",
      10000,
      () => "datapack did not end the match",
    );
    assert.equal((await arenaCli("status")).winner, "red");
    await waitFor(
      async () => (await session()).winner === "red",
      5000,
      () => "bridge did not serve the verdict",
    );
    await arenaCli("stop", matchPath);
    log(
      "ok live: cli.mjs + two server-mode bridges with real bots, SDK placement, datapack verdict",
    );
  } finally {
    for (const bridge of bridges) bridge.kill("SIGTERM");
    await delay(1000);
  }
}

async function hostless(rcon) {
  // A bridge reading the session straight from the server: the operator
  // (here RCON, in-game the same commands) runs the rounds.
  const token = "verify-hostless-bridge-token";
  const bridge = spawnBridge(
    {
      MF_USERNAME: "arena_red1",
      BRIDGE_PORT: String(PORTS.red),
      BRIDGE_TOKEN: token,
      BRIDGE_SESSION: "server",
      BRIDGE_RCON_HOST: "127.0.0.1",
      BRIDGE_RCON_PORT: String(PORTS.rcon),
      BRIDGE_RCON_PASSWORD: PASSWORD,
    },
    "pipe",
  );
  let output = "";
  bridge.stdout.on("data", (c) => (output += c));
  const headers = { authorization: `Bearer ${token}` };
  const url = `http://127.0.0.1:${PORTS.red}`;
  const state = async () => {
    await delay(700);
    const session = await (
      await fetch(`${url}/v1/session`, { headers })
    ).json();
    const action = await fetch(`${url}/v1/action`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ action: "look", args: { yaw: 0, pitch: 0 } }),
    });
    return { session: session.result, action: action.status };
  };
  try {
    await waitFor(
      () => output.includes("listening") || bridge.exitCode !== null,
      60000,
      () => "bridge did not start",
    );
    assert.equal(bridge.exitCode, null, "bridge started");
    await writeConfig(rcon, twoTeams);
    await rcon.command("function #arena:prepare");
    let s = await state();
    assert.equal(s.session.state, "waiting");
    assert.equal(s.session.teamId, "red");
    assert.equal(s.action, 403);
    await rcon.command("function #arena:start");
    s = await state();
    assert.equal(s.session.state, "running");
    assert.equal(s.action, 200);
    // Hold forward without a client id (no disconnect lease), then end the
    // round: the bridge must release it while the bot stays online.
    const press = await fetch(`${url}/v1/action`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        action: "setControlState",
        args: { control: "forward", state: true },
      }),
    });
    assert.equal(press.status, 200);
    await rcon.command("function #arena:stop");
    s = await state();
    assert.equal(s.session.state, "ended");
    assert.equal(s.action, 403);
    const position = async () =>
      (await rcon.command("data get entity arena_red1 Pos")).replace(
        /^.*?: /,
        "",
      );
    const before = await position();
    await delay(1000);
    assert.equal(await position(), before, "bot stopped when the round ended");
    // The bot stays for the next round.
    assert.match(await rcon.command("list"), /arena_red1/);
    log(
      "ok server-mode bridge: gates actions and releases held keys across a round",
    );
  } finally {
    bridge.kill("SIGTERM");
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
  if (!args.includes("--skip-live")) await live(rcon, dir, map);
  await hostless(rcon);
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
