#!/usr/bin/env node
/**
 * One deployment on one machine, Linux or Windows (Docker Compose):
 *
 *   node packages/arena/src/deployment.mjs deploy DIR [--accept-eula] [--replace-save] [--refresh-server]
 *   node packages/arena/src/deployment.mjs build|up|start|stop|status|logs|reset DIR
 *
 * DIR holds the operator's deploy.json (and usually the match file):
 *
 *   { "name": "craft-arena-df",            Compose project and image tag
 *     "match": "match.json",               the match file (provision.mjs)
 *     "save": "C:/saves/direct-fire",      a Minecraft world folder (level.dat)
 *     "datapacks": ["C:/src/craft-arena/infra/datapacks/race-of-wool"],
 *     "server": { "view-distance": 8 },    server.properties over the map's
 *     "serverDownload": "...", "serverJar": "...",
 *     "limits": { "cpus": 2, "memory": "2g", "pids": 256, "minecraftMemory": "3g" } }
 *
 * Paths are relative to deploy.json. Datapacks are directories with
 * pack.mcmeta, mounted read-only into the world beside the save; nothing else
 * names them. `deploy` writes compose.yaml, generated/ (match.json, agents/),
 * minecraft-data/server.properties and server/ (the checked server build);
 * .env gets a random MC_RCON_PASSWORD the first time and is never rewritten.
 * The save is copied to map-original/world (and minecraft-data/world) the
 * first time, or again with --replace-save. Running `deploy` again after
 * editing any input is the upgrade: generated files are rewritten, while
 * .env, volumes, the live world and history/ stay.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { prepareMinecraftServer } from "../../../scripts/prepare-minecraft-server.mjs";
import {
  compileMatch,
  deploymentCompose,
  resolveAgents,
  resolveModels,
  writeAgents,
} from "./provision.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const DEPLOY_KEYS = [
  "name",
  "match",
  "save",
  "datapacks",
  "server",
  "serverDownload",
  "serverJar",
  "limits",
];
const LIMIT_KEYS = ["cpus", "memory", "pids", "minecraftMemory"];
// The platform needs these; neither the map nor deploy.json changes them.
const FIXED_PROPERTIES = {
  "level-name": "world",
  "server-port": 25565,
  "enable-rcon": true,
  "rcon.port": 25575,
  "online-mode": false,
  "enforce-secure-profile": false,
  "enable-command-block": false,
};
const DEFAULT_PROPERTIES = {
  gamemode: "survival",
  difficulty: "normal",
  pvp: true,
  "allow-flight": true,
  "spawn-protection": 0,
  "view-distance": 8,
  "simulation-distance": 6,
  "max-players": 10,
  motd: "Craft Arena",
  "max-tick-time": 120000,
};

const isObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const readJson = async (path, what) => {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${what} ${path} not found`);
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} ${path}: ${error.message}`);
  }
};

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Refuse a symbolic link (on Windows also a junction) at `path`, in any of its
 * parents or, with `tree`, anywhere below it: world data is moved and copied,
 * and must never follow a link out of place.
 */
export async function assertNoLinks(path, { tree = false } = {}) {
  let cursor = resolve(path);
  for (;;) {
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new Error(`Refusing to follow a link: ${cursor}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!tree || !(await exists(path))) return;
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error(
          `Refusing a link inside ${path}: ${join(dir, entry.name)}`,
        );
      if (entry.isDirectory()) await walk(join(dir, entry.name));
    }
  };
  await walk(path);
}

/** KEY=VALUE lines; single or double quotes around a value are removed. */
export function parseDotEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(
      line,
    );
    if (!m || line.trim().startsWith("#")) continue;
    let value = m[2];
    if (/^'.*'$|^".*"$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

/** server.properties text: defaults, then the map's, then deploy.json's. */
export function serverProperties({ map = {}, deploy = {}, rconPassword }) {
  const errors = [];
  for (const [where, values] of [
    ["map.json server", map],
    ["deploy.json server", deploy],
  ])
    for (const [key, value] of Object.entries(values)) {
      if (Object.hasOwn(FIXED_PROPERTIES, key) || key === "rcon.password")
        errors.push(`${where}: ${key} is set by the platform`);
      else if (!/^[a-z0-9.-]+$/.test(key))
        errors.push(`${where}: ${key} is not a server.properties key`);
      else if (
        !["string", "number", "boolean"].includes(typeof value) ||
        /[\r\n]/.test(String(value))
      )
        errors.push(
          `${where}: ${key} must be one line of text, a number or a boolean`,
        );
    }
  if (errors.length) throw new Error(errors.join("\n"));
  const values = {
    ...DEFAULT_PROPERTIES,
    ...map,
    ...deploy,
    ...FIXED_PROPERTIES,
    "rcon.password": rconPassword,
  };
  // Java properties: `:` and `=` in a value are escaped (level-type=minecraft\:flat).
  return `${Object.entries(values)
    .map(
      ([key, value]) => `${key}=${String(value).replace(/([:=\\])/g, "\\$1")}`,
    )
    .join("\n")}\n`;
}

/** deploy.json plus everything it names, checked; nothing is written. */
export async function loadDeployment(dir) {
  dir = resolve(dir);
  const deploy = await readJson(join(dir, "deploy.json"), "deploy.json");
  if (!isObject(deploy)) throw new Error("deploy.json must be an object");
  const errors = [];
  for (const key of Object.keys(deploy))
    if (!DEPLOY_KEYS.includes(key))
      errors.push(`deploy.json: unknown key ${key}`);
  const name =
    deploy.name ??
    `craft-arena-${basename(dir)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")}`.replace(/-+$/, "");
  if (typeof name !== "string" || !NAME.test(name))
    errors.push(
      "deploy.json: name must be lowercase letters, digits, - and _, starting with a letter or digit (at most 63)",
    );
  if (!Array.isArray(deploy.datapacks))
    errors.push(
      "deploy.json: datapacks must list the rules datapack directories (local paths; may be empty)",
    );
  if (deploy.server !== undefined && !isObject(deploy.server))
    errors.push("deploy.json: server must be an object");
  if (deploy.limits !== undefined) {
    if (!isObject(deploy.limits))
      errors.push("deploy.json: limits must be an object");
    else
      for (const key of Object.keys(deploy.limits))
        if (!LIMIT_KEYS.includes(key))
          errors.push(
            `deploy.json: unknown limit ${key} (${LIMIT_KEYS.join(", ")})`,
          );
  }
  for (const key of ["match", "save", "serverDownload", "serverJar"])
    if (
      deploy[key] !== undefined &&
      (typeof deploy[key] !== "string" || !deploy[key])
    )
      errors.push(`deploy.json: ${key} must be a path`);
  if (errors.length) throw new Error(errors.join("\n"));
  const path = (value) =>
    value === undefined ? undefined : resolve(dir, value);

  const matchPath = path(deploy.match ?? "match.json");
  const match = await readJson(matchPath, "Match file");
  if (typeof match?.map !== "string" || !match.map)
    throw new Error(`${matchPath}: map must be the path of the map package`);
  const mapDir = resolve(dirname(matchPath), match.map);
  const map = await readJson(join(mapDir, "map.json"), "Map package");
  const agents = resolveAgents(map);
  const models = resolveModels(agents, match);
  const compiled = compileMatch(map, match, agents);
  // Validated here so a bad value fails before anything is written.
  serverProperties({
    map: map.server,
    deploy: deploy.server,
    rconPassword: "-",
  });

  const datapacks = [];
  const names = new Set();
  for (const entry of deploy.datapacks) {
    if (typeof entry !== "string" || !entry)
      throw new Error("deploy.json: each datapack is a directory path");
    const pack = path(entry);
    if (!(await exists(join(pack, "pack.mcmeta"))))
      throw new Error(`Datapack ${pack} has no pack.mcmeta`);
    if (names.has(basename(pack)))
      throw new Error(`Two datapacks are named ${basename(pack)}`);
    names.add(basename(pack));
    datapacks.push(pack);
  }
  return {
    dir,
    name,
    deploy,
    matchPath,
    mapDir,
    map,
    agents,
    models,
    compiled,
    datapacks,
    save: path(deploy.save),
    serverDownload:
      path(deploy.serverDownload) ??
      join(repoRoot, "infra/minecraft-download.json"),
    serverJar: path(deploy.serverJar),
  };
}

/**
 * Start a deployment directory (absent or empty) with deploy.json and
 * match.json for the shipped Direct Fire map, using this checkout's map
 * package and race-of-wool datapack; edit both before `deploy` as needed.
 */
export async function init(dir, { save, name } = {}) {
  dir = resolve(dir);
  if (!save) throw new Error("init needs --save, the world folder to copy");
  if ((await exists(dir)) && (await readdir(dir)).length)
    throw new Error(`${dir} is not empty`);
  await mkdir(dir, { recursive: true });
  const example = JSON.parse(
    await readFile(
      join(repoRoot, "infra/deploy/match.direct-fire.json"),
      "utf8",
    ),
  );
  await writeFile(
    join(dir, "match.json"),
    `${JSON.stringify({ ...example, map: join(repoRoot, "infra/maps/direct-fire") }, null, 2)}\n`,
  );
  await writeFile(
    join(dir, "deploy.json"),
    `${JSON.stringify(
      {
        ...(name ? { name } : {}),
        match: "match.json",
        save: resolve(save),
        datapacks: [join(repoRoot, "infra/datapacks/race-of-wool")],
      },
      null,
      2,
    )}\n`,
  );
  return { directory: dir, files: ["deploy.json", "match.json"] };
}

/** Environment variables compose.yaml reads from .env. */
function neededEnv(models) {
  const names = new Set(["MC_RCON_PASSWORD"]);
  for (const access of Object.values(models)) names.add(access.key);
  return [...names];
}

/**
 * Generate or upgrade the deployment in `dir` (see the header). Returns a
 * summary for printing.
 */
export async function deploy(
  dir,
  {
    acceptEula = false,
    replaceSave = false,
    refreshServer = false,
    prepareServer = prepareMinecraftServer,
  } = {},
) {
  const d = await loadDeployment(dir);
  dir = d.dir;
  await assertNoLinks(dir);
  const original = join(dir, "map-original", "world");
  const live = join(dir, "minecraft-data", "world");
  const firstSave = !(await exists(original));
  if (firstSave || replaceSave) {
    if (!d.save)
      throw new Error(
        "deploy.json: save (the world folder to copy) is required",
      );
    if (!(await exists(join(d.save, "level.dat"))))
      throw new Error(
        `save ${d.save} must be a Minecraft world folder containing level.dat`,
      );
    const inside = relative(d.save, dir);
    if (!inside || (!inside.startsWith("..") && !isAbsolute(inside)))
      throw new Error("The deployment directory must not be inside the save");
    await assertNoLinks(d.save, { tree: true });
  }
  const eula = join(dir, "minecraft-data", "eula.txt");
  if (!(await exists(eula)) && !acceptEula)
    throw new Error(
      "Pass --accept-eula after reading https://www.minecraft.net/eula to accept the Minecraft EULA",
    );

  // .env: only secrets; created once, then the operator's.
  const envPath = join(dir, ".env");
  let envText = (await exists(envPath)) ? await readFile(envPath, "utf8") : "";
  let env = parseDotEnv(envText);
  if (!env.MC_RCON_PASSWORD) {
    envText += `${envText && !envText.endsWith("\n") ? "\n" : ""}MC_RCON_PASSWORD=${randomBytes(32).toString("hex")}\n`;
    await writeFile(envPath, envText, { mode: 0o600 });
    env = parseDotEnv(envText);
  }

  // The checked server build: downloaded again only when its manifest changed.
  const serverDir = join(dir, "server");
  const manifest = JSON.parse(await readFile(d.serverDownload, "utf8"));
  if (manifest.minecraftVersion !== "1.21.1")
    throw new Error(
      "The arena runs Minecraft 1.21.1; serverDownload must match",
    );
  const built = await readFile(join(serverDir, "download.json"), "utf8").catch(
    () => null,
  );
  if (
    refreshServer ||
    !built ||
    JSON.stringify(JSON.parse(built)) !== JSON.stringify(manifest)
  ) {
    const fresh = join(dir, `.server-${randomUUID()}`);
    await prepareServer({
      destination: fresh,
      manifestPath: d.serverDownload,
      serverJar: d.serverJar,
    });
    await rm(serverDir, { recursive: true, force: true });
    await rename(fresh, serverDir);
  }

  // Generated files: assembled aside, then swapped in.
  const stage = join(dir, `.generated-${randomUUID()}`);
  await mkdir(stage);
  try {
    await writeFile(
      join(stage, "match.json"),
      `${JSON.stringify(d.compiled, null, 2)}\n`,
    );
    await writeAgents({ agents: d.agents, mapDir: d.mapDir, outDir: stage });
    await rm(join(dir, "generated"), { recursive: true, force: true });
    await rename(stage, join(dir, "generated"));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  const compose = deploymentCompose({
    name: d.name,
    agents: d.agents,
    models: d.models,
    mapId: basename(d.mapDir),
    datapacks: d.datapacks,
    limits: d.deploy.limits,
    source: repoRoot.replace(/[\\/]$/, ""),
  });
  // JSON is valid YAML.
  await writeFile(
    join(dir, "compose.yaml"),
    `# Generated by deployment.mjs deploy from deploy.json; edit the inputs and deploy again.\n${JSON.stringify(compose, null, 2)}\n`,
  );

  for (const sub of ["minecraft-data", "results", "replay-config", "history"])
    await mkdir(join(dir, sub), { recursive: true });
  await writeFile(
    join(dir, "minecraft-data", "server.properties"),
    serverProperties({
      map: d.map.server,
      deploy: d.deploy.server,
      rconPassword: env.MC_RCON_PASSWORD,
    }),
  );
  if (!(await exists(eula))) await writeFile(eula, "eula=true\n");
  if (firstSave || replaceSave) {
    if (!firstSave)
      await rename(
        dirname(original),
        join(dir, "history", `${stamp()}-map-original`),
      );
    await cp(d.save, original, { recursive: true });
  }
  if (!(await exists(live))) await cp(original, live, { recursive: true });

  return {
    name: d.name,
    directory: dir,
    agents: d.agents.map(({ id, team, bots }) => ({
      id,
      team,
      bots,
      model: d.models[id].model,
      relay: d.models[id].relay,
      internet: d.models[id].internet,
    })),
    teams: d.compiled.config.teams,
    datapacks: d.datapacks,
    missingEnv: neededEnv(d.models).filter((name) => !env[name]),
  };
}

const stamp = () =>
  `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")}-${randomUUID().slice(0, 8)}`;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const execFileAsync = promisify(execFile);

/** Docker Compose for the deployment in `dir`: run, capture and arena commands. */
export function composeRunner(
  dir,
  { docker = process.env.DOCKER || "docker" } = {},
) {
  const base = [
    "compose",
    "--project-directory",
    dir,
    "-f",
    join(dir, "compose.yaml"),
    "--profile",
    "agents",
  ];
  const run = (args, { quiet = false } = {}) =>
    new Promise((done, fail) => {
      const child = spawn(docker, [...base, ...args], {
        stdio: quiet ? "ignore" : "inherit",
      });
      child.once("error", fail);
      child.once("exit", (code) =>
        code === 0
          ? done()
          : fail(new Error(`docker compose ${args[0]} failed (${code})`)),
      );
    });
  const capture = async (args) =>
    (await execFileAsync(docker, [...base, ...args], { maxBuffer: 16 << 20 }))
      .stdout;
  return {
    run,
    capture,
    services: async () =>
      (await capture(["config", "--services"])).split(/\r?\n/).filter(Boolean),
    /** packages/arena/src/cli.mjs against the server; its JSON output. */
    arena: async (...args) => {
      const out = await capture([
        "--profile",
        "tools",
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "arena",
        ...args,
      ]);
      // Compose may print container progress around the command's JSON line.
      const line = out
        .split(/\r?\n/)
        .filter((text) => text.trim().startsWith("{"))
        .at(-1);
      if (!line) throw new Error(`cli.mjs ${args[0]} printed no JSON: ${out}`);
      return JSON.parse(line);
    },
  };
}

/** The operator commands after `deploy`; returns what to print. */
export async function operate(
  action,
  dir,
  compose = composeRunner(resolve(dir)),
) {
  dir = resolve(dir);
  if (!(await exists(join(dir, "compose.yaml"))))
    throw new Error(`${dir} has no compose.yaml: run deploy first`);
  const services = await compose.services();
  const named = (prefix) => services.filter((name) => name.startsWith(prefix));
  const state = async () => {
    try {
      return (await compose.arena("status")).state;
    } catch {
      return "";
    }
  };
  const stopAll = async () => {
    // End the round first (best effort) so the datapack records the scores.
    if ((await state()) === "running")
      await compose.arena("stop", "/config/match.json");
    await compose.run([
      "stop",
      "-t",
      "20",
      ...services.filter((name) => name !== "minecraft"),
    ]);
    await compose.run(["stop", "minecraft"]);
  };
  switch (action) {
    case "status": {
      await compose.run(["ps", "-a"]);
      try {
        return await compose.arena("status");
      } catch {
        return null;
      }
    }
    case "logs":
      await compose.run(["logs", "--tail", "80"]);
      return null;
    case "build":
      await compose.run(["build"]);
      return null;
    case "up": {
      await compose.run(["up", "-d", "minecraft"]);
      let ready = false;
      for (let i = 0; i < 180 && !ready; i++) {
        try {
          await compose.run(
            [
              "exec",
              "-T",
              "minecraft",
              "bash",
              "-c",
              "echo > /dev/tcp/127.0.0.1/25575",
            ],
            { quiet: true },
          );
          ready = true;
        } catch {
          await delay(2000);
        }
      }
      if (!ready) throw new Error("Minecraft RCON readiness timed out");
      // #arena:prepare writes arena:session, which a login gate reads as soon
      // as it starts; the characters join later, from the participants.
      await compose.arena("prepare", "/config/match.json");
      await compose.run(["up", "-d", ...named("gate-")]);
      for (const participant of named("participant-"))
        await compose.run([
          "run",
          "--rm",
          "--no-deps",
          participant,
          "sh",
          "-c",
          "test -d /team-git/project.git || git init --bare /team-git/project.git",
        ]);
      await compose.run(["up", "-d"]);
      const { config } = JSON.parse(
        await readFile(join(dir, "generated", "match.json"), "utf8"),
      );
      const players = config.teams.flatMap((team) => team.players);
      let reply = "";
      for (let i = 0; i < 180; i++) {
        ({ reply } = await compose.arena("command", "list"));
        if (players.every((name) => new RegExp(`\\b${name}\\b`).test(reply)))
          return {
            prepared: true,
            online: players,
            note: "Participants wait for start.",
          };
        await delay(2000);
      }
      throw new Error(
        `The characters did not all join the server; inspect the login-gate and participant logs. Last list: ${reply}`,
      );
    }
    case "start":
      if ((await state()) !== "waiting")
        throw new Error(
          "Run up and wait for the prepared (waiting) state before start",
        );
      await compose.arena("start", "/config/match.json");
      return {
        started: true,
        note: "The datapack ends the match at the time limit or on a win.",
      };
    case "stop":
      await stopAll();
      return { stopped: true };
    case "reset": {
      const original = join(dir, "map-original", "world");
      const world = join(dir, "minecraft-data", "world");
      if (!(await exists(join(original, "level.dat"))))
        throw new Error("The original world (map-original/world) is missing");
      await assertNoLinks(original, { tree: true });
      await assertNoLinks(world);
      const archiveId = stamp();
      const archive = join(dir, "history", archiveId);
      await stopAll();
      for (const participant of named("participant-"))
        await compose.run([
          "run",
          "--rm",
          "--no-deps",
          participant,
          "node",
          "/opt/arena/scripts/archive-participant-state.mjs",
          archiveId,
        ]);
      await mkdir(archive, { recursive: true });
      if (await exists(world)) await rename(world, join(archive, "world"));
      await cp(original, world, { recursive: true });
      // Containers, not volumes: fresh gates and relays; code and archives stay.
      await compose.run([
        "rm",
        "-f",
        ...services.filter((name) => /^(participant|model|gate)-/.test(name)),
      ]);
      return {
        reset: true,
        previousWorld: archive,
        note: `Participant sessions moved to .arena-history/${archiveId} in each work volume; code and team Git stay. Run up next.`,
      };
    }
    default:
      throw new Error(`Unknown action ${action}`);
  }
}

const USAGE =
  "Usage: deployment.mjs init DIR --save WORLD [--name NAME] | deploy DIR [--accept-eula] [--replace-save] [--refresh-server] | build|up|start|stop|status|logs|reset DIR";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [action, dir, ...flags] = process.argv.slice(2);
  try {
    if (!action || !dir) throw new Error(USAGE);
    let result;
    if (action === "init") {
      const options = {};
      for (let i = 0; i < flags.length; i += 2) {
        const key = { "--save": "save", "--name": "name" }[flags[i]];
        if (!key || !flags[i + 1]) throw new Error(USAGE);
        options[key] = flags[i + 1];
      }
      result = await init(dir, options);
    } else if (action === "deploy") {
      const known = ["--accept-eula", "--replace-save", "--refresh-server"];
      const unknown = flags.find((flag) => !known.includes(flag));
      if (unknown) throw new Error(`Unknown option ${unknown}\n${USAGE}`);
      result = await deploy(dir, {
        acceptEula: flags.includes("--accept-eula"),
        replaceSave: flags.includes("--replace-save"),
        refreshServer: flags.includes("--refresh-server"),
      });
    } else {
      if (flags.length) throw new Error(USAGE);
      result = await operate(action, dir);
    }
    if (result) console.log(JSON.stringify(result, null, 2));
    if (result?.missingEnv?.length)
      console.error(
        `Set ${result.missingEnv.join(", ")} in ${join(resolve(dir), ".env")} before up.`,
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
