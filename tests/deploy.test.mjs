import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deploy,
  init,
  operate,
  parseDotEnv,
  serverProperties,
} from "../packages/arena/src/deployment.mjs";
import {
  deploymentCompose,
  resolveAgents,
  resolveModels,
} from "../packages/arena/src/provision.mjs";
import { configCommands } from "../packages/arena/src/server-protocol.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const shippedMap = JSON.parse(
  await readFile(join(repo, "infra/maps/direct-fire/map.json"), "utf8"),
);

/** Stands in for prepare-minecraft-server.mjs, which downloads the server. */
const fakeServer = (calls = []) =>
  async function prepareServer({ destination, manifestPath }) {
    calls.push(destination);
    await mkdir(destination);
    await writeFile(
      join(destination, "download.json"),
      await readFile(manifestPath, "utf8"),
    );
  };

async function shipped(t) {
  const root = await mkdtemp(join(tmpdir(), "arena-deploy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const save = join(root, "save");
  await mkdir(join(save, "region"), { recursive: true });
  await writeFile(join(save, "level.dat"), "original world");
  const dir = join(root, "deploy");
  await init(dir, { save, name: "craft-arena-test" });
  return { root, save, dir };
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const readCompose = async (dir) =>
  JSON.parse(
    (await readFile(join(dir, "compose.yaml"), "utf8")).replace(/^#.*\n/, ""),
  );

test("init and deploy turn the shipped Direct Fire files into a whole deployment", async (t) => {
  const { dir, save } = await shipped(t);
  await assert.rejects(
    deploy(dir, { prepareServer: fakeServer() }),
    /--accept-eula/,
  );
  const result = await deploy(dir, {
    acceptEula: true,
    prepareServer: fakeServer(),
  });
  assert.deepEqual(result.teams, [
    { id: "red", players: ["arena_red1"] },
    { id: "blue", players: ["arena_blue1"] },
  ]);
  // The shipped match file relays DeepSeek: the key lives in .env only.
  assert.deepEqual(result.missingEnv, ["DEEPSEEK_API_KEY"]);

  const { config, commands } = await readJson(
    join(dir, "generated/match.json"),
  );
  assert.deepEqual(config.teams, result.teams);
  assert.equal(config.rules.durationMs, 1800000);
  assert.deepEqual(config.rules.goals, shippedMap.rules.goals);
  assert.equal(config.briefing, shippedMap.briefing);
  assert.deepEqual(commands, shippedMap.commands);
  // Longer than one RCON command: written in parts.
  assert.ok(configCommands({ version: 1, ...config }).length > 1);

  const compose = await readCompose(dir);
  assert.equal(compose.name, "craft-arena-test");
  assert.deepEqual(Object.keys(compose.services).sort(), [
    "arena",
    "gate-blue1",
    "gate-red1",
    "minecraft",
    "model-blue",
    "model-red",
    "participant-blue1",
    "participant-red1",
  ]);
  const minecraft = compose.services.minecraft;
  assert.equal(minecraft.image, "craft-arena-minecraft:craft-arena-test");
  assert.deepEqual(minecraft.volumes.at(-1), {
    type: "bind",
    source: join(repo, "infra/datapacks/race-of-wool"),
    target: "/data/world/datapacks/race-of-wool",
    read_only: true,
  });
  const relay = compose.services["model-red"];
  assert.equal(
    relay.environment.MODEL_RELAY_UPSTREAM,
    "https://api.deepseek.com",
  );
  assert.equal(
    relay.environment.MODEL_RELAY_API_KEY,
    "${DEEPSEEK_API_KEY:?Set DEEPSEEK_API_KEY in .env}",
  );
  assert.deepEqual(relay.networks, ["agent-red1", "egress-red"]);
  const red = compose.services["participant-red1"];
  assert.equal(red.environment.ARENA_PI_MODEL, "deepseek/deepseek-flash");
  assert.equal(red.environment.ARENA_PI_BASE_URL, "http://model-red:8080");
  assert.equal(red.environment.ARENA_PI_API_KEY, undefined);
  assert.deepEqual(red.networks, ["agent-red1"]);
  assert.ok(
    red.volumes.includes("./generated/agents/red1/config:/arena/config:ro"),
  );
  assert.equal(
    await readFile(
      join(dir, "generated/agents/red1/config/agents.d/20-race-of-wool.md"),
      "utf8",
    ),
    await readFile(
      join(repo, "infra/maps/direct-fire/agents.d/20-race-of-wool.md"),
      "utf8",
    ),
  );

  const env = parseDotEnv(await readFile(join(dir, ".env"), "utf8"));
  assert.match(env.MC_RCON_PASSWORD, /^[0-9a-f]{64}$/);
  const properties = await readFile(
    join(dir, "minecraft-data/server.properties"),
    "utf8",
  );
  assert.match(
    properties,
    new RegExp(`^rcon.password=${env.MC_RCON_PASSWORD}$`, "m"),
  );
  assert.match(properties, /^online-mode=false$/m);
  assert.match(properties, /^difficulty=normal$/m);
  assert.equal(
    await readFile(join(dir, "minecraft-data/eula.txt"), "utf8"),
    "eula=true\n",
  );
  for (const world of ["map-original/world", "minecraft-data/world"])
    assert.equal(
      await readFile(join(dir, world, "level.dat"), "utf8"),
      "original world",
    );
  // The save itself stays untouched; datapacks are never copied into it.
  assert.deepEqual((await readdir(save)).sort(), ["level.dat", "region"]);
  await assert.rejects(stat(join(dir, "map-original/world/datapacks")), {
    code: "ENOENT",
  });
});

test("deploying again upgrades generated files and keeps .env, worlds and the server build", async (t) => {
  const { dir, save } = await shipped(t);
  const calls = [];
  await deploy(dir, { acceptEula: true, prepareServer: fakeServer(calls) });
  const envBefore = await readFile(join(dir, ".env"), "utf8");
  await writeFile(join(dir, ".env"), `${envBefore}DEEPSEEK_API_KEY=sk-x\n`);
  await writeFile(join(dir, "minecraft-data/world/level.dat"), "played");
  await writeFile(join(save, "level.dat"), "edited save");
  const match = await readJson(join(dir, "match.json"));
  match.agents.blue1 = { model: "openai/gpt-4.1", relay: false };
  await writeFile(join(dir, "match.json"), JSON.stringify(match));

  const result = await deploy(dir, { prepareServer: fakeServer(calls) });
  assert.equal(
    calls.length,
    1,
    "an unchanged server manifest is not fetched again",
  );
  assert.deepEqual(result.missingEnv, ["OPENAI_API_KEY"]);
  assert.match(
    await readFile(join(dir, ".env"), "utf8"),
    /DEEPSEEK_API_KEY=sk-x/,
  );
  assert.equal(
    await readFile(join(dir, "minecraft-data/world/level.dat"), "utf8"),
    "played",
  );
  assert.equal(
    await readFile(join(dir, "map-original/world/level.dat"), "utf8"),
    "original world",
  );
  const compose = await readCompose(dir);
  assert.equal(compose.services["model-blue"], undefined);
  const blue = compose.services["participant-blue1"];
  assert.equal(blue.environment.ARENA_PI_MODEL, "openai/gpt-4.1");
  assert.equal(blue.environment.ARENA_PI_BASE_URL, undefined);
  assert.equal(
    blue.environment.ARENA_PI_API_KEY,
    "${OPENAI_API_KEY:?Set OPENAI_API_KEY in .env}",
  );
  assert.deepEqual(blue.networks, ["agent-blue1", "internet-blue1"]);
  assert.deepEqual(compose.networks["internet-blue1"], {});
  assert.deepEqual(compose.networks["agent-blue1"], { internal: true });

  // --replace-save copies the save again; the old copy goes to history/.
  await deploy(dir, { replaceSave: true, prepareServer: fakeServer(calls) });
  assert.equal(
    await readFile(join(dir, "map-original/world/level.dat"), "utf8"),
    "edited save",
  );
  const [old] = await readdir(join(dir, "history"));
  assert.match(old, /-map-original$/);
  assert.equal(
    await readFile(join(dir, "history", old, "world/level.dat"), "utf8"),
    "original world",
  );
});

test("deploy refuses bad inputs before writing anything", async (t) => {
  const { root, dir } = await shipped(t);
  const deployJson = await readJson(join(dir, "deploy.json"));
  const attempt = async (change, error) => {
    await writeFile(
      join(dir, "deploy.json"),
      JSON.stringify(change(structuredClone(deployJson))),
    );
    await assert.rejects(
      deploy(dir, { acceptEula: true, prepareServer: fakeServer() }),
      error,
    );
    assert.deepEqual((await readdir(dir)).sort(), [
      "deploy.json",
      "match.json",
    ]);
  };
  await attempt((d) => ({ ...d, name: "Bad Name" }), /name must be lowercase/);
  await attempt(({ datapacks, ...d }) => d, /datapacks must list/);
  await attempt((d) => ({ ...d, datapacks: [root] }), /has no pack.mcmeta/);
  await attempt((d) => ({ ...d, save: root }), /containing level.dat/);
  await attempt(
    (d) => ({ ...d, server: { "online-mode": true } }),
    /online-mode is set by the platform/,
  );
  await attempt((d) => ({ ...d, teams: [] }), /unknown key teams/);
  const link = join(root, "linked-save");
  await symlink(join(root, "save"), link, "dir");
  await attempt((d) => ({ ...d, save: link }), /Refusing to follow a link/);
});

test("model knobs: relays per team, shared relays, direct access and errors", () => {
  const agents = resolveAgents({
    agents: {
      red1: { team: "red", bots: ["arena_red1"] },
      red2: { team: "red", bots: ["arena_red2"] },
      solo: { bots: ["arena_solo"] },
    },
  });
  const models = resolveModels(agents, {
    defaults: { model: "deepseek/deepseek-flash" },
    agents: {
      solo: {
        model: "anthropic/claude-sonnet-4-5",
        relay: false,
        baseUrl: "http://host.docker.internal:8317/",
        key: "SOLO_KEY",
        thinking: "low",
        compactAt: 100000,
      },
    },
  });
  assert.equal(models.red1.relay, "red");
  assert.equal(models.red2.relay, "red");
  assert.equal(models.red1.internet, false);
  assert.equal(models.red1.key, "DEEPSEEK_API_KEY");
  assert.deepEqual(models.solo, {
    model: "anthropic/claude-sonnet-4-5",
    relay: null,
    baseUrl: "http://host.docker.internal:8317",
    key: "SOLO_KEY",
    internet: true,
    thinking: "low",
    compactAt: 100000,
  });
  const compose = deploymentCompose({
    name: "t",
    agents,
    models,
    mapId: "m",
    source: "/src",
  });
  assert.deepEqual(compose.services["model-red"].networks, [
    "agent-red1",
    "agent-red2",
    "egress-red",
  ]);
  const solo = compose.services["participant-solo"].environment;
  assert.equal(solo.ARENA_PI_BASE_URL, "http://host.docker.internal:8317");
  assert.equal(solo.ARENA_PI_THINKING, "low");
  assert.equal(solo.ARENA_PI_COMPACT_AT, "100000");
  // Only the first participant builds the shared image.
  assert.ok(compose.services["participant-red1"].build);
  assert.equal(compose.services["participant-red2"].build, undefined);

  const fails = (match, error) =>
    assert.throws(() => resolveModels(agents, match), error);
  fails({}, /model "?undefined"? is not a Pi built-in model/);
  fails(
    { defaults: { model: "deepseek/nothing" } },
    /is not a Pi built-in model/,
  );
  fails(
    {
      defaults: {
        model: "deepseek/deepseek-flash",
        relay: false,
        internet: false,
      },
    },
    /needs internet/,
  );
  fails(
    {
      defaults: { model: "deepseek/deepseek-flash" },
      agents: { red2: { baseUrl: "https://elsewhere.example/v1" } },
    },
    /relay red already forwards to https:\/\/api.deepseek.com/,
  );
  fails(
    { defaults: { model: "deepseek/deepseek-flash", compactAt: 900000 } },
    /compactAt must be a positive integer of at most 616000/,
  );
  fails(
    { defaults: { model: "deepseek/deepseek-flash", upstream: "x" } },
    /unknown key upstream/,
  );
  fails(
    { defaults: { model: "deepseek/deepseek-flash" }, agents: { blue9: {} } },
    /blue9 is not an agent of the map/,
  );
});

test("server.properties: platform keys win, the map's values, then the deployment's", () => {
  const text = serverProperties({
    map: { difficulty: "hard", "level-type": "minecraft:flat" },
    deploy: { difficulty: "peaceful", "view-distance": 12 },
    rconPassword: "secret",
  });
  assert.match(text, /^difficulty=peaceful$/m);
  assert.match(text, /^view-distance=12$/m);
  assert.match(text, /^level-type=minecraft\\:flat$/m);
  assert.match(text, /^enable-rcon=true$/m);
  assert.match(text, /^rcon.password=secret$/m);
  assert.throws(
    () => serverProperties({ map: { "rcon.password": "x" } }),
    /set by the platform/,
  );
});

test("operator commands drive Compose: prepare before the gates, then wait for the characters", async (t) => {
  const { dir } = await shipped(t);
  await deploy(dir, { acceptEula: true, prepareServer: fakeServer() });
  const log = [];
  let listed = 0;
  const compose = {
    services: async () => Object.keys((await readCompose(dir)).services),
    run: async (args) => log.push(["compose", ...args].join(" ")),
    arena: async (...args) => {
      log.push(["arena", ...args].join(" "));
      if (args[0] === "command")
        return { reply: ++listed > 1 ? "arena_red1, arena_blue1" : "" };
      if (args[0] === "status") return { state: "waiting" };
      return {};
    },
  };
  t.mock.method(globalThis, "setTimeout", (fn) => fn());
  await operate("up", dir, compose);
  const at = (prefix) => log.findIndex((line) => line.startsWith(prefix));
  assert.ok(at("compose up -d minecraft") < at("arena prepare"));
  assert.ok(at("arena prepare") < at("compose up -d gate-red1 gate-blue1"));
  assert.ok(at("compose up -d gate-") < log.indexOf("compose up -d"));
  assert.ok(log.indexOf("compose up -d") < at("arena command list"));
  log.length = 0;
  await operate("start", dir, compose);
  assert.deepEqual(log, ["arena status", "arena start /config/match.json"]);

  // reset: the live world moves to history/, the original comes back.
  await writeFile(join(dir, "minecraft-data/world/level.dat"), "played");
  log.length = 0;
  const reset = await operate("reset", dir, compose);
  assert.equal(
    await readFile(join(reset.previousWorld, "world/level.dat"), "utf8"),
    "played",
  );
  assert.equal(
    await readFile(join(dir, "minecraft-data/world/level.dat"), "utf8"),
    "original world",
  );
  assert.ok(log.some((line) => line.includes("archive-participant-state.mjs")));
  assert.ok(log.at(-1).startsWith("compose rm -f gate-red1 gate-blue1"));
});
