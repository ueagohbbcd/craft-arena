import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { EventEmitter, once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { startLiveBridge } from "../packages/mf-bridge/live.mjs";
import { createCompatibleBot } from "../packages/mf-bridge/minecraft-compat.mjs";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { loadSelectedPlugins } from "../packages/bot-sdk/plugins.mjs";
import {
  sampleObservation,
  watchObservation,
} from "../packages/observation/index.mjs";
import { observe } from "../packages/observation/observe.mjs";
import { snapshotFromBot } from "../packages/world-visual/index.mjs";
import { startPerceptionRuntime } from "../packages/pi-extension/perception-runtime.mjs";
import { Inbox } from "../packages/inbox/queue.mjs";
// Opt-in only: this script is never part of npm test. It starts an official
// offline loopback server and mutates a NEW test world, never the existing world.
// The operator must provide a stopped isolated QA installation that has already
// accepted its EULA. No downloads, logins, or EULA acceptance are performed.
const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith("--"))
    throw Error(name + " needs a value");
  return args[at + 1];
}
const usage =
  "node scripts/validate-observation-live.mjs --server-dir /path/to/ISOLATED-QA --confirm-isolated-test-server [--port 25591] [--evidence-dir /path/to/output] [--java /path/to/java] [--manual-decision]";
if (args.includes("--help")) {
  console.log(usage);
  process.exit(0);
}
if (!option("--server-dir") || !args.includes("--confirm-isolated-test-server"))
  throw Error(
    usage +
      "\nThis changes a new test world in the selected QA installation. Never select a production server.",
  );
const root = fileURLToPath(new URL("..", import.meta.url));
const serverDir = resolve(option("--server-dir"));
const port = Number(option("--port", "25591"));
assert(
  Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 25565,
  "Use a dedicated non-default test port",
);
const run = new Date().toISOString().replace(/[:.]/g, "-");
const worldName = "observation-validation-" + run;
const out = resolve(
  option("--evidence-dir", join(tmpdir(), "craft-arena-observation-" + run)),
);
mkdirSync(out, { recursive: true });
let originalProperties,
  propertiesChanged = false;
const sourceFiles = [
  "packages/mf-bridge/index.mjs",
  "packages/mf-bridge/minecraft-compat.mjs",
  "packages/bot-sdk/index.mjs",
  "packages/observation/index.mjs",
  "packages/observation/observe.mjs",
  "packages/pi-extension/perception-runtime.mjs",
  "packages/world-visual/index.mjs",
  "packages/world-visual/surface-textures.mjs",
  "packages/world-visual/prismarine.mjs",
  "scripts/validate-observation-live.mjs",
];
const sourceHashes = Object.fromEntries(
  sourceFiles.map((name) => [
    name,
    createHash("sha256")
      .update(readFileSync(join(root, name)))
      .digest("hex"),
  ]),
);
const commit =
  spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout?.trim() || null;

const report = {
  run,
  minecraftVersion: "1.21.1",
  host: "127.0.0.1",
  serverPort: port,
  worldName,
  source: {
    commit,
    files: sourceHashes,
    harness: "scripts/validate-observation-live.mjs",
  },
  tests: [],
  events: [],
  actionRequests: [],
  observationRequests: [],
  limitations: [],
  shutdown: {},
};
const safeJSON = (x) =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const save = () => writeFileSync(out + "/report.json", safeJSON(report));
const log = (type, data = {}) => {
  const event = { at: Date.now(), type, ...data };
  report.events.push(event);
  appendFileSync(out + "/events.jsonl", JSON.stringify(event) + "\n");
};
let server,
  bridge,
  action,
  perception,
  observer,
  companion,
  paused = false,
  resume,
  serial = 0,
  objectiveWatcher,
  pluginApi;
const lines = new EventEmitter();
let interrupted;
const checkInterrupted = () => {
  if (interrupted)
    throw Error(`Interrupted by ${interrupted}; cleaning up isolated test`);
};
const interrupt = (signal) => {
  interrupted = signal;
  log("interrupted", { signal });
  lines.emit("cancel");
  if (server?.exitCode === null && server.stdin.writable)
    server.stdin.write("stop\n");
};
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
async function waitFor(fn, ms = 12000, label = "condition") {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    checkInterrupted();
    const v = await fn();
    if (v) return v;
    await delay(30);
  }
  throw Error("Timed out: " + label);
}
function waitLine(text, ms = 20000) {
  checkInterrupted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      lines.off("line", receive);
      lines.off("cancel", cancel);
      reject(Error("Server timeout: " + text));
    }, ms);
    function cancel() {
      clearTimeout(timer);
      lines.off("line", receive);
      lines.off("cancel", cancel);
      reject(Error(`Interrupted by ${interrupted}`));
    }
    function receive(line) {
      if (line.includes(text)) {
        clearTimeout(timer);
        lines.off("line", receive);
        lines.off("cancel", cancel);
        resolve(line);
      }
    }
    lines.on("line", receive);
    lines.on("cancel", cancel);
  });
}
async function command(text) {
  checkInterrupted();
  const mark = "PERCEPTION_QA_" + ++serial;
  const pending = waitLine(mark);
  log("server_fixture", { command: text });
  server.stdin.write(text + "\nsay " + mark + "\n");
  await pending;
  await delay(100);
}
async function test(name, fn) {
  checkInterrupted();
  const t = Date.now();
  try {
    const detail = await fn();
    report.tests.push({
      name,
      passed: true,
      durationMs: Date.now() - t,
      detail,
    });
    console.log("PASS", name, safeJSON(detail));
  } catch (error) {
    report.tests.push({
      name,
      passed: false,
      durationMs: Date.now() - t,
      error: error.stack,
    });
    console.log("FAIL", name, error.stack);
    if (interrupted) throw error;
  }
  save();
}
function count(snapshot, name) {
  return (snapshot.inventory.items ?? [])
    .filter((x) => x.name === name)
    .reduce((sum, x) => sum + x.count, 0);
}
const eventOf = (type) =>
  report.events.filter(
    (x) => x.type === "inbox" && x.message.data.type === type,
  );
const NAME = "PerceptionQA",
  OTHER = "ObservedPlayer";
async function main() {
  const actual = createHash("sha1")
    .update(readFileSync(serverDir + "/server-1.21.1.jar"))
    .digest("hex");
  assert.equal(
    actual,
    "59353fb40c36d304f2035d51e7d6e6baa98dc05c",
    "Expected the official Minecraft 1.21.1 server jar",
  );
  const accepted = readFileSync(serverDir + "/eula.txt", "utf8");
  assert.match(accepted, /eula=true/);
  report.eula =
    "Operator supplied an existing eula=true installation; no terms accepted or EULA file changed by this script.";
  report.serverSha1 = actual;
  originalProperties = readFileSync(serverDir + "/server.properties", "utf8");
  assert.match(
    originalProperties,
    /^server-ip=127\.0\.0\.1\s*$/m,
    "Only an existing loopback QA installation is accepted",
  );
  assert.match(
    originalProperties,
    /^online-mode=false\s*$/m,
    "Only an existing offline QA installation is accepted",
  );

  await new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => s.close(resolve));
  });
  const overrides = {
    "server-ip": "127.0.0.1",
    "server-port": port,
    "online-mode": "false",
    "level-name": worldName,
    "level-type": "minecraft:flat",
    "generator-settings": "",
    "generate-structures": "false",
    "allow-nether": "false",
    gamemode: "survival",
    difficulty: "normal",
    "max-players": 2,
    "view-distance": 3,
    "simulation-distance": 3,
    "spawn-protection": 0,
    "spawn-monsters": "false",
    "spawn-animals": "false",
    "spawn-npcs": "false",
    "enable-rcon": "false",
    "enable-query": "false",
    "enforce-secure-profile": "false",
    "white-list": "false",
    "enforce-whitelist": "false",
    "max-tick-time": 60000,
    "resource-pack": "",
    "resource-pack-prompt": "",
    "require-resource-pack": "false",
  };
  const keys = new Set(Object.keys(overrides));
  const kept = originalProperties
    .split(/\r?\n/)
    .filter((line) => !keys.has(line.split("=")[0].trim()));
  writeFileSync(
    serverDir + "/server.properties",
    [...kept, ...Object.entries(overrides).map(([k, v]) => k + "=" + v)].join(
      "\n",
    ) + "\n",
  );
  propertiesChanged = true;
  console.log(
    "ISOLATED TEST: new world " +
      worldName +
      " on 127.0.0.1:" +
      port +
      "; original properties restored after shutdown. Evidence: " +
      out,
  );
  server = spawn(
    option("--java", process.env.JAVA_BIN ?? "java"),
    ["-Xms256M", "-Xmx1024M", "-jar", "server-1.21.1.jar", "nogui"],
    { cwd: serverDir, stdio: ["pipe", "pipe", "pipe"] },
  );
  for (const stream of [server.stdout, server.stderr]) {
    let buf = "";
    stream.on("data", (chunk) => {
      appendFileSync(out + "/server.log", chunk);
      buf += chunk;
      let n;
      while ((n = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, n);
        buf = buf.slice(n + 1);
        lines.emit("line", line);
      }
    });
  }
  server.on("error", (e) => log("server_error", { error: e.message }));
  await waitLine("Done (", 60000);
  console.log("SERVER READY", out);
  for (const cmd of [
    "gamerule doMobSpawning false",
    "gamerule doDaylightCycle false",
    "gamerule naturalRegeneration false",
    "gamerule keepInventory true",
    "time set day",
    "kill @e[type=!player]",
    "fill -20 62 -20 20 63 20 minecraft:stone",
    "fill -20 64 -20 20 76 20 minecraft:air",
    "setworldspawn 0 64 0",
  ])
    await command(cmd);
  const token = randomBytes(24).toString("hex");
  bridge = await startLiveBridge({
    minecraft: {
      host: "127.0.0.1",
      port,
      username: NAME,
      version: "1.21.1",
      auth: "offline",
      respawn: true,
    },
    bridge: {
      host: "127.0.0.1",
      port: 0,
      token,
      snapshotRadius: 8,
      authorizeAction: (request) => {
        report.actionRequests.push({ at: Date.now(), action: request.action });
        return true;
      },
    },
  });
  bridge.bot.on("error", (e) => log("native_error", { error: e.message }));
  bridge.bot.on("kicked", (reason) => log("native_kicked", { reason }));
  await waitFor(
    () => bridge.bot.entity && bridge.bot.health > 0,
    30000,
    "initial bot spawn",
  );
  for (const cmd of [
    `tp ${NAME} 0.5 64 0.5 0 0`,
    `spawnpoint ${NAME} 0 64 0`,
    `clear ${NAME}`,
    `effect clear ${NAME}`,
    `effect give ${NAME} minecraft:instant_health 1 10 true`,
    `item replace entity ${NAME} hotbar.0 with minecraft:iron_pickaxe[minecraft:damage=7]`,
    `item replace entity ${NAME} hotbar.1 with minecraft:cobblestone 64`,
    `item replace entity ${NAME} inventory.0 with minecraft:cobblestone 9`,
    `item replace entity ${NAME} hotbar.2 with minecraft:bread 5`,
    `item replace entity ${NAME} armor.head with minecraft:iron_helmet`,
    `item replace entity ${NAME} weapon.offhand with minecraft:shield`,
    `setblock 2 64 0 minecraft:chest{Items:[{Slot:0b,id:"minecraft:diamond",count:12},{Slot:1b,id:"minecraft:iron_ingot",count:64},{Slot:2b,id:"minecraft:iron_ingot",count:7}]}`,
    `setblock 1 64 2 minecraft:oak_sign{front_text:{messages:['{"text":"QA GOAL EAST"}','{"text":"Walk to x=8"}','{"text":"Keep terrain intact"}','{"text":""}']}}`,
  ])
    await command(cmd);
  await delay(1000);
  const inbox = new Inbox({
    sessionId: "live-" + run,
    maxItems: 1024,
    maxBytes: 1048576,
  });
  inbox.on("message", (message) => log("inbox", { message }));
  perception = startPerceptionRuntime({
    url: bridge.url,
    token,
    inbox,
    connectTimeoutMs: 8000,
    sampleTimeoutMs: 1500,
    report: (message) => log("perception_warning", { message }),
    fetchImpl: async (input, init = {}) => {
      report.observationRequests.push({
        at: Date.now(),
        path: new URL(input).pathname,
        method: init.method ?? "GET",
      });
      const response = await fetch(input, init);
      if (!String(input).endsWith("/v1/events")) return response;
      const reader = response.body.getReader();
      return new Response(
        new ReadableStream({
          async pull(controller) {
            const item = await reader.read();
            if (item.done) {
              controller.close();
              return;
            }
            if (paused)
              await new Promise((r) => {
                resume = r;
              });
            controller.enqueue(item.value);
          },
          cancel() {
            return reader.cancel();
          },
        }),
        { status: response.status, headers: response.headers },
      );
    },
  });
  observer = await waitFor(
    () => perception.getBot().catch(() => false),
    20000,
    "passive observer connect",
  );
  await delay(350);
  await test("passive_default_snapshot_and_exact_quantities", async () => {
    const before = report.actionRequests.length,
      p = bridge.bot.entity.position.clone();
    const s = await perception.sample();
    writeFileSync(out + "/initial-snapshot.json", safeJSON(s));
    assert.equal(s.freshness.stale, false);
    assert.equal(s.self.health, 20);
    assert.equal(count(s, "cobblestone"), 73);
    assert.equal(count(s, "bread"), 5);
    assert.equal(s.equipment.head.name, "iron_helmet");
    assert.equal(s.equipment.offhand.name, "shield");
    assert.equal(s.heldItem.name, "iron_pickaxe");
    assert.equal(s.heldItem.durability.used, 7);
    assert.equal(s.window, null);
    for (let i = 0; i < 12; i++) await perception.sample();
    await delay(1000);
    assert.equal(report.actionRequests.length, before);
    assert(bridge.bot.entity.position.distanceTo(p) < 0.01);
    assert(report.observationRequests.every((x) => x.method === "GET"));
    assert.equal(observer.pathfinder, undefined);
    return {
      counts: { cobblestone: 73, bread: 5 },
      equipment: s.equipment,
      heldItem: s.heldItem,
      passivePosts: 0,
      position: s.self.position,
      freshness: s.freshness,
      local: s.local,
    };
  });
  action = await connectBot({ url: bridge.url, token });
  action.on("error", (e) => log("sdk_error", { error: e.message }));
  await test("real_chest_inspection_and_transfer_through_sdk", async () => {
    const chest = action.blockAt(new action.Vec3(2, 64, 0));
    assert.equal(chest.name, "chest");
    const win = await action.openContainer(chest);
    await waitFor(() => observer.currentWindow, 5000, "observer window");
    const before = await perception.sample();
    assert.equal(
      before.window.containerItems.find((x) => x.name === "diamond").count,
      12,
    );
    assert.equal(
      before.window.containerItems.find((x) => x.name === "iron_ingot").count,
      71,
    );
    assert.equal(count(before, "cobblestone"), 73);
    await win.withdraw(action.registry.itemsByName.diamond.id, null, 3);
    writeFileSync(
      out + "/chest-after-withdraw.json",
      safeJSON({
        snapshot: await perception.sample(),
        rawMain: bridge.bot.inventory.items(),
        rawWindow: bridge.bot.currentWindow.items(),
      }),
    );
    await waitFor(
      () => count(sampleObservation(observer), "diamond") === 3,
      5000,
      "diamond receipt",
    );
    const after = await perception.sample();
    assert.equal(
      after.window.containerItems.find((x) => x.name === "diamond").count,
      9,
    );
    await win.close();
    await waitFor(() => !observer.currentWindow, 5000, "window closed");
    return {
      containerBefore: before.window.containerItems,
      containerAfter: after.window.containerItems,
      playerDiamonds: count(after, "diamond"),
      windowPosition: before.window.position,
    };
  });
  await test("real_walk_and_plugin_goal_arrival", async () => {
    const start = action.entity.position.clone();
    await action.look(-Math.PI / 2, 0, true);
    action.setControlState("forward", true);
    await action.flush();
    await delay(650);
    action.clearControlStates();
    await action.flush();
    await delay(700);
    const walked = action.entity.position.clone();
    assert(walked.distanceTo(start) > 1);
    const { Movements, goals } = (pluginApi ??= loadSelectedPlugins(action, {
      pvp: false,
    }));
    const moves = new Movements(action);
    moves.canDig = false;
    action.pathfinder.setMovements(moves);
    await Promise.race([
      action.pathfinder.goto(new goals.GoalBlock(8, 64, 0)),
      delay(25000).then(() => {
        throw Error("Pathfinder arrival timeout");
      }),
    ]);
    action.pathfinder.setGoal(null);
    action.clearControlStates();
    await action.flush();
    await delay(1000);
    const s = await perception.sample();
    assert.equal(Math.floor(s.self.position.x), 8);
    assert.equal(Math.floor(s.self.position.y), 64);
    assert.equal(Math.floor(s.self.position.z), 0);
    assert(Object.values(s.self.controlFlags).every((x) => x === false));
    return {
      start,
      walked,
      walkedDistance: walked.distanceTo(start),
      arrived: s.self.position,
      controls: s.self.controlFlags,
    };
  });
  await test("observed_player_and_block_update", async () => {
    companion = createCompatibleBot({
      host: "127.0.0.1",
      port,
      username: OTHER,
      version: "1.21.1",
      auth: "offline",
    });
    companion.on("error", (e) => log("companion_error", { error: e.message }));
    await waitFor(() => companion.entity, 20000, "other player spawn");
    await command(`tp ${OTHER} 10.5 64 2.5`);
    await waitFor(
      () =>
        sampleObservation(observer).players.some((p) => p.username === OTHER),
      10000,
      "player mirror",
    );
    await command("setblock 8 64 2 minecraft:gold_block");
    await waitFor(
      () =>
        observer.blockAt(new observer.Vec3(8, 64, 2))?.name === "gold_block",
      5000,
      "block update mirror",
    );
    const s = await perception.sample();
    assert.equal(
      s.players.find((p) => p.username === OTHER).relation,
      "unknown",
    );
    assert.equal(
      observer.blockAt(new observer.Vec3(1000000, 64, 1000000)),
      null,
    );
    return {
      players: s.players,
      updatedBlock: observer.blockAt(new observer.Vec3(8, 64, 2)).name,
      unknownFarBlock: null,
    };
  });
  await test("real_world_views_and_unknown_crop", async () => {
    const started = Date.now();
    writeFileSync(
      out + "/render-snapshot.json",
      safeJSON(
        snapshotFromBot(observer, {
          bounds: { min: { x: -4, y: 61, z: -8 }, max: { x: 16, y: 70, z: 8 } },
        }),
      ),
    );
    const v = await observe(observer, {
      views: ["overview", "local", "3d"],
      viewRadius: 6,
    });
    for (const view of v.views) {
      assert.equal(view.metadata.status, "ready", safeJSON(view.metadata));
      assert(view.png?.length > 100);
      writeFileSync(out + "/" + view.name + ".png", view.png);
    }
    writeFileSync(
      out + "/view-metadata.json",
      safeJSON({
        metadata: v.metadata,
        views: v.views.map(({ name, metadata }) => ({ name, metadata })),
      }),
    );
    const unknown = await observe(observer, {
      views: ["local"],
      localBounds: {
        min: { x: 1000000, y: 63, z: 1000000 },
        max: { x: 1000002, y: 65, z: 1000002 },
      },
    });
    assert.equal(unknown.views[0].metadata.knownFraction, 0);
    assert.equal(unknown.views[0].metadata.columns.unknown, 9);
    writeFileSync(out + "/unknown.png", unknown.views[0].png);
    return {
      durationMs: Date.now() - started,
      views: v.views.map(({ name, png, metadata }) => ({
        name,
        bytes: png?.length,
        metadata,
      })),
      unknown: unknown.views[0].metadata,
    };
  });
  if (args.includes("--manual-decision"))
    await test("single_model_steered_route_from_observations", async () => {
      await command("fill 0 64 -6 0 66 6 minecraft:bricks");
      await command("fill 0 64 3 0 65 4 minecraft:air");
      await command("setblock -8 64 0 minecraft:gold_block");
      await delay(500);
      const v = await observe(observer, {
        views: ["overview", "local", "3d"],
        viewRadius: 12,
        overviewBounds: {
          min: { x: -12, y: 62, z: -10 },
          max: { x: 14, y: 70, z: 10 },
        },
        structureBounds: {
          min: { x: -12, y: 62, z: -10 },
          max: { x: 14, y: 68, z: 10 },
        },
      });
      writeFileSync(out + "/decision-state.json", safeJSON(v.state));
      writeFileSync(
        out + "/decision-view-metadata.json",
        safeJSON(v.views.map(({ name, metadata }) => ({ name, metadata }))),
      );
      writeFileSync(
        out + "/decision-render-snapshot.json",
        safeJSON(
          snapshotFromBot(observer, {
            bounds: {
              min: { x: -12, y: 62, z: -10 },
              max: { x: 14, y: 68, z: 10 },
            },
          }),
        ),
      );
      for (const w of v.views)
        if (w.png) writeFileSync(out + "/decision-" + w.name + ".png", w.png);
      console.log(
        "MODEL DECISION REQUEST",
        out,
        "Reach a block adjacent to the western gold marker, preserve wall, use observed geometry. Write decision.json with reason and waypoints [{x,y,z}].",
      );
      await waitFor(
        () => existsSync(out + "/decision.json"),
        180000,
        "model route choice",
      );
      const decision = JSON.parse(readFileSync(out + "/decision.json"));
      assert(
        Array.isArray(decision.waypoints) && decision.waypoints.length > 0,
      );
      const { Movements, goals } = (pluginApi ??= loadSelectedPlugins(action, {
        pvp: false,
      }));
      const moves = new Movements(action);
      moves.canDig = false;
      action.pathfinder.setMovements(moves);
      const actual = [];
      for (const p of decision.waypoints) {
        await Promise.race([
          action.pathfinder.goto(new goals.GoalBlock(p.x, p.y, p.z)),
          delay(15000).then(() => {
            throw Error("Chosen waypoint timeout");
          }),
        ]);
        actual.push({ ...action.entity.position });
      }
      action.pathfinder.setGoal(null);
      action.clearControlStates();
      await action.flush();
      await delay(700);
      const after = await perception.sample();
      writeFileSync(out + "/decision-arrival.json", safeJSON(after));
      assert(
        Math.abs(after.self.position.x - -7.5) < 2 &&
          Math.abs(after.self.position.z - 0.5) < 2,
      );
      assert.equal(
        observer.blockAt(new observer.Vec3(0, 64, 0)).name,
        "bricks",
      );
      return {
        decision,
        actual,
        arrived: after.self.position,
        wallPreserved: true,
        claim:
          "One model-mediated tool-output interpretation demonstration; not a benchmark or general comprehension proof",
      };
    });
  await test("health_loss_critical_death_and_respawn_events", async () => {
    const before = report.actionRequests.length;
    await command(`damage ${NAME} 15 minecraft:out_of_world`);
    await waitFor(
      () => eventOf("observation.critical_health").length,
      6000,
      "critical event",
    );
    await delay(400);
    const low = await perception.sample();
    assert.equal(low.self.health, 5);
    assert.equal(
      eventOf("observation.critical_health").at(-1).message.priority,
      "urgent",
    );
    assert(eventOf("observation.health_loss").length);
    assert.equal(report.actionRequests.length, before);
    await command(`kill ${NAME}`);
    await waitFor(
      () => eventOf("observation.death").length,
      6000,
      "death event",
    );
    await waitFor(
      () => eventOf("observation.respawn").length,
      12000,
      "respawn event",
    );
    await delay(1200);
    const s = await perception.sample();
    assert.equal(s.self.health, 20);
    assert.equal(report.actionRequests.length, before);
    return {
      lowHealth: low.self.health,
      afterRespawn: s.self,
      eventTypes: report.events
        .filter((e) => e.type === "inbox")
        .map((e) => ({
          type: e.message.data.type,
          priority: e.message.priority,
          data: e.message.data,
        })),
      observerAddedActions: 0,
      nativeRespawn: "Mineflayer default auto-respawn; observer did not act",
    };
  });
  await test("actual_paused_transport_stale_then_restored", async () => {
    paused = true;
    await delay(6200);
    const stale = await perception.sample();
    writeFileSync(out + "/stale-snapshot.json", safeJSON(stale));
    assert.equal(stale.freshness.stale, true);
    assert.equal(stale.freshness.status, "stale");
    assert(eventOf("observation.stale").length);
    paused = false;
    resume?.();
    resume = undefined;
    await waitFor(
      async () => !(await perception.sample()).freshness.stale,
      8000,
      "fresh after transport resumed",
    );
    const fresh = await perception.sample();
    assert(eventOf("observation.restored").length);
    return { stale: stale.freshness, restored: fresh.freshness };
  });
  await test("actual_minecraft_disconnect_marks_snapshot", async () => {
    bridge.bot.quit("Isolated perception QA complete");
    await waitFor(
      () => eventOf("observation.disconnected").length,
      8000,
      "disconnect event",
    );
    const s = await perception.sample();
    writeFileSync(out + "/disconnected-snapshot.json", safeJSON(s));
    assert.equal(s.freshness.stale, true);
    assert.equal(s.freshness.disconnected, true);
    assert.equal(s.freshness.status, "disconnected");
    return {
      freshness: s.freshness,
      event: eventOf("observation.disconnected").at(-1).message,
    };
  });
  report.observerActions = report.observationRequests.filter(
    (r) => r.method !== "GET",
  );
  assert.equal(report.observerActions.length, 0);
  report.limitations.push(
    "Deterministic integration tests; optional external manual-decision demonstration only when explicitly selected. No paid model invocation or statistical evidence of general model game comprehension.",
  );
}
try {
  await main();
} catch (error) {
  report.fatal = error.stack;
  console.error("FATAL", error.stack);
  process.exitCode = 1;
} finally {
  paused = false;
  resume?.();
  try {
    objectiveWatcher?.close();
    await perception?.close();
    report.shutdown.perceptionClosed = true;
  } catch (e) {
    report.shutdown.perceptionError = e.message;
  }
  try {
    if (action) {
      action.pathfinder?.setGoal(null);
      action.closeBridge();
    }
    report.shutdown.actionClosed = true;
  } catch (e) {
    report.shutdown.actionError = e.message;
  }
  try {
    companion?.quit("QA complete");
    await bridge?.close();
    report.shutdown.bridgeClosed = true;
  } catch (e) {
    report.shutdown.bridgeError = e.message;
  }
  if (server && server.exitCode === null) {
    server.stdin.write("stop\n");
    await Promise.race([once(server, "exit"), delay(18000)]);
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([once(server, "exit"), delay(5000)]);
    }
  }
  report.shutdown.serverExitCode = server?.exitCode;
  report.shutdown.serverStopped =
    !server || server.exitCode !== null || server.signalCode !== null;
  report.passed =
    !report.fatal &&
    report.tests.length > 0 &&
    report.tests.every((t) => t.passed) &&
    report.shutdown.serverStopped;
  if (propertiesChanged && report.shutdown.serverStopped) {
    writeFileSync(serverDir + "/server.properties", originalProperties);
    report.shutdown.originalPropertiesRestored = true;
  } else if (propertiesChanged) {
    report.shutdown.originalPropertiesRestored = false;
    report.limitations.push(
      "Server did not stop: original properties were not restored. Stop the isolated test server before changing its configuration.",
    );
  }
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  save();
  console.log("REPORT", out + "/report.json");
  console.log("RESULT", report.passed ? "PASS" : "FAIL");
  if (!report.passed) process.exitCode = 1;
}
