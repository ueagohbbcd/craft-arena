/**
 * Trusted-side compiler for one deployment (docs/TARGET-ARCHITECTURE.md). Its
 * inputs depend in one direction only: deploy.json → match file → map package;
 * the rules datapacks are mounted beside them and named by nothing but
 * deploy.json. deployment.mjs reads the files and writes the results; this
 * module only checks and combines them.
 *
 * The map package is a directory with map.json, describing one map:
 *
 *   { "save": "which save folder this map is (a note, never checked)",
 *     "server": { "difficulty": "normal", ... },    server.properties
 *     "rules": { ... },          arena:config rules for its datapack (coordinates)
 *     "commands": { "prepare": [...], "start": [...], "stop": [...] },
 *     "briefing": "what the map is like",
 *     "defaults": { "files": [...] },
 *     "agents": { "red1": { "team": "red", "bots": ["arena_red1"], "files": [...] } } }
 *
 * A file is { source, target, mode }: source relative to the map directory;
 * target an absolute path under /arena/config/ or /workspace/; mode "replace"
 * (default) or "once" (workspace only: keep a file the participant already has).
 * An agent's own `files` (and `team`) replace the defaults; they are not merged.
 *
 * The match file is one round on that map:
 *
 *   { "map": "../maps/direct-fire", "sessionId": "df-1", "kind": "match",
 *     "rules": { "durationMs": 1800000 }, "briefing": "", "commands": {...},
 *     "defaults": { "model": "deepseek/deepseek-flash" },
 *     "agents": { "blue1": { "model": "openai/gpt-5.5", "relay": false } } }
 *
 * Teams come from the map's agents; rules merge over the map's; briefings and
 * commands are the map's followed by the match's. Each agent's model settings
 * (`defaults` overlaid by its own entry) are independent knobs:
 *
 *   model     a Pi built-in model, provider/id (required)
 *   relay     true (default): a model relay holds the key, named after the
 *             agent's team (else its id); a string names the relay; false: the
 *             participant calls the model itself with the key in its container
 *   baseUrl   the API base URL instead of Pi's (the relay's upstream, or the
 *             participant's endpoint without a relay)
 *   key       the .env variable holding the key (default <PROVIDER>_API_KEY)
 *   internet  whether the participant container may reach the internet;
 *             default false with a relay, true without (then required)
 *   thinking  Pi's startup thinking level
 *   compactAt context tokens at which Pi compacts the history
 *
 * Each bot runs inside its participant container through its agent's login
 * gate (packages/login-gate), which admits only that agent's characters and
 * serves the session read-only. The participant launcher starts the
 * toolkit's `mf` supervisor for the manifest's characters.
 */
import { chmod, chown, cp, mkdir, stat, writeFile } from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
} from "node:path";
import { piBuiltinModel } from "../../pi-extension/pi-models.mjs";
import { validateServerConfig } from "./server-protocol.mjs";

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const BOT_NAME = /^[A-Za-z0-9_]{3,16}$/;
const RELAY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const ROOTS = ["/arena/config/", "/workspace/"];
const PHASES = ["prepare", "start", "stop"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MAP_KEYS = [
  "save",
  "server",
  "rules",
  "commands",
  "briefing",
  "defaults",
  "agents",
];
const MATCH_KEYS = [
  "map",
  "sessionId",
  "kind",
  "rules",
  "briefing",
  "commands",
  "defaults",
  "agents",
];
const MODEL_KEYS = [
  "model",
  "relay",
  "baseUrl",
  "key",
  "internet",
  "thinking",
  "compactAt",
];

const envName = (value) => value.toUpperCase().replace(/[^A-Z0-9]/g, "_");
const isObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** Teammates share one Git volume; an agent without a team has its own. */
const gitVolume = (agent) =>
  agent.team
    ? `team-${String(agent.team).replace(/[^A-Za-z0-9_.-]/g, "-")}-git`
    : `${agent.id}-git`;

export const gateService = (agentId) => `gate-${agentId.replace(/_/g, "-")}`;

function unknownKeys(value, allowed, where, errors, hints = {}) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      errors.push(`${where}: unknown key ${key}${hints[key] ?? ""}`);
}

function checkFile(file, where, errors) {
  if (!isObject(file)) {
    errors.push(`${where}: a file must be {source, target, mode?}`);
    return;
  }
  const { source, target, mode = "replace" } = file;
  if (
    typeof source !== "string" ||
    !source ||
    isAbsolute(source) ||
    source.split(/[\\/]/).includes("..")
  )
    errors.push(`${where}: source must be a path inside the map directory`);
  if (
    typeof target !== "string" ||
    posix.normalize(target) !== target ||
    !ROOTS.some(
      (root) => target.startsWith(root) && target.length > root.length,
    )
  )
    errors.push(
      `${where}: target ${JSON.stringify(target)} must be a normalized path under ${ROOTS.join(" or ")}`,
    );
  if (!["replace", "once"].includes(mode))
    errors.push(`${where}: mode must be replace or once`);
  else if (mode === "once" && target?.startsWith("/arena/config/"))
    errors.push(
      `${where}: /arena/config is read-only, mode once does not apply`,
    );
}

function checkCommands(commands, where, errors) {
  if (commands === undefined) return;
  if (!isObject(commands)) {
    errors.push(`${where}: commands must be an object`);
    return;
  }
  for (const [phase, list] of Object.entries(commands))
    if (!PHASES.includes(phase))
      errors.push(`${where}: unknown command phase ${phase}`);
    else if (!Array.isArray(list))
      errors.push(`${where}: commands.${phase} must be a list`);
}

/** Errors in a map.json (empty when valid), agents excepted (resolveAgents). */
export function checkMap(map) {
  if (!isObject(map)) return ["map.json must be an object"];
  const errors = [];
  unknownKeys(map, MAP_KEYS, "map.json", errors, {
    datapacks: ": datapacks are chosen by deploy.json",
  });
  if (map.save !== undefined && typeof map.save !== "string")
    errors.push("map.json: save must be a string (a note for the operator)");
  for (const key of ["server", "rules"])
    if (map[key] !== undefined && !isObject(map[key]))
      errors.push(`map.json: ${key} must be an object`);
  if (map.briefing !== undefined && typeof map.briefing !== "string")
    errors.push("map.json: briefing must be a string");
  checkCommands(map.commands, "map.json", errors);
  return errors;
}

/** The map's agent slots with defaults applied; throws on any error. */
export function resolveAgents(map) {
  const errors = [];
  if (!isObject(map)) throw new Error("map.json must be an object");
  const defaults = map.defaults ?? {};
  const agents = map.agents;
  if (!isObject(agents) || !Object.keys(agents).length)
    throw new Error("map.json needs at least one agent in agents");
  const seen = new Map();
  const out = [];
  for (const [id, slot] of Object.entries(agents)) {
    if (!AGENT_ID.test(id))
      errors.push(`agent id ${id} must match ${AGENT_ID}`);
    const agent = { id, ...defaults, ...slot };
    if (
      agent.team !== undefined &&
      (typeof agent.team !== "string" || !agent.team)
    )
      errors.push(`agent ${id}: team must be a non-empty string`);
    if (!Array.isArray(agent.bots) || !agent.bots.length)
      errors.push(`agent ${id}: bots must list at least one bot`);
    else
      for (const bot of agent.bots) {
        if (typeof bot !== "string" || !BOT_NAME.test(bot))
          errors.push(
            `agent ${id}: bot ${JSON.stringify(bot)} is not a valid player name`,
          );
        else if (seen.has(bot.toLowerCase()))
          errors.push(
            `bot ${bot} is used by agents ${seen.get(bot.toLowerCase())} and ${id}`,
          );
        else seen.set(bot.toLowerCase(), id);
      }
    agent.files ??= [];
    if (!Array.isArray(agent.files))
      errors.push(`agent ${id}: files must be a list`);
    else
      agent.files.forEach((file, i) =>
        checkFile(file, `agent ${id} files[${i}]`, errors),
      );
    out.push(agent);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return out;
}

/** Teams for arena:config, in agent order. */
export function teamsOf(agents) {
  const teams = new Map();
  for (const agent of agents)
    if (agent.team) {
      if (!teams.has(agent.team)) teams.set(agent.team, []);
      teams.get(agent.team).push(...agent.bots);
    }
  return [...teams].map(([id, players]) => ({ id, players }));
}

/**
 * Each agent's model access from the match file's `defaults` and `agents`
 * (see the header). Returns { agentId: access }; throws on any error.
 */
export function resolveModels(agents, match) {
  const errors = [];
  const defaults = match.defaults ?? {};
  const own = match.agents ?? {};
  if (!isObject(defaults)) throw new Error("match defaults must be an object");
  if (!isObject(own)) throw new Error("match agents must be an object");
  unknownKeys(defaults, MODEL_KEYS, "match defaults", errors);
  for (const [id, entry] of Object.entries(own)) {
    if (!agents.some((agent) => agent.id === id))
      errors.push(`match agents.${id} is not an agent of the map`);
    else if (!isObject(entry))
      errors.push(`match agents.${id} must be an object`);
    else unknownKeys(entry, MODEL_KEYS, `match agents.${id}`, errors);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  const out = {};
  const relays = new Map();
  for (const agent of agents) {
    const where = `agent ${agent.id}`;
    const spec = { ...defaults, ...own[agent.id] };
    let model;
    try {
      model = piBuiltinModel(spec.model);
    } catch (error) {
      errors.push(`${where}: model ${error.message}`);
      continue;
    }
    if (
      ![undefined, true, false].includes(spec.relay) &&
      !RELAY.test(spec.relay)
    )
      errors.push(
        `${where}: relay must be true, false or a name matching ${RELAY}`,
      );
    const relay =
      spec.relay === false
        ? null
        : typeof spec.relay === "string"
          ? spec.relay
          : (agent.team ?? agent.id);
    if (relay !== null && !RELAY.test(relay))
      errors.push(
        `${where}: relay name ${relay} (from the team) must match ${RELAY}; name one with relay`,
      );
    let baseUrl;
    if (spec.baseUrl !== undefined)
      try {
        const url = new URL(spec.baseUrl);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error();
        baseUrl = String(spec.baseUrl).replace(/\/$/, "");
      } catch {
        errors.push(
          `${where}: baseUrl must be an HTTP(S) URL without credentials, query or fragment`,
        );
      }
    const key = spec.key ?? `${envName(model.provider)}_API_KEY`;
    if (typeof key !== "string" || !ENV_NAME.test(key))
      errors.push(`${where}: key must name a .env variable (A-Z, 0-9, _)`);
    const internet = spec.internet ?? relay === null;
    if (typeof internet !== "boolean")
      errors.push(`${where}: internet must be true or false`);
    else if (relay === null && !internet)
      errors.push(
        `${where}: without a relay the participant reaches the model itself, so it needs internet`,
      );
    if (spec.thinking !== undefined && !THINKING.includes(spec.thinking))
      errors.push(`${where}: thinking must be one of ${THINKING.join(", ")}`);
    if (
      spec.compactAt !== undefined &&
      (!Number.isSafeInteger(spec.compactAt) ||
        spec.compactAt < 1 ||
        spec.compactAt > model.contextWindow - model.maxTokens)
    )
      errors.push(
        `${where}: compactAt must be a positive integer of at most ${model.contextWindow - model.maxTokens} (context window minus output tokens) for ${spec.model}`,
      );
    const access = {
      model: `${model.provider}/${model.id}`,
      relay,
      ...(relay ? { upstream: baseUrl ?? model.baseUrl } : { baseUrl }),
      key,
      internet,
      ...(spec.thinking ? { thinking: spec.thinking } : {}),
      ...(spec.compactAt ? { compactAt: spec.compactAt } : {}),
    };
    if (relay) {
      const first = relays.get(relay);
      if (!first) relays.set(relay, { ...access, agent: agent.id });
      else if (first.upstream !== access.upstream || first.key !== access.key)
        errors.push(
          `${where}: relay ${relay} already forwards to ${first.upstream} with ${first.key} (agent ${first.agent}); give this agent its own relay`,
        );
    }
    out[agent.id] = access;
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return out;
}

const joinText = (...parts) =>
  parts
    .filter((part) => typeof part === "string" && part.trim())
    .map((part) => part.trim())
    .join("\n\n");

/**
 * The operator's `{config, commands}` (cli.mjs prepare/start/stop) for a map
 * and a match file. Throws on any error.
 */
export function compileMatch(map, match, agents) {
  const errors = checkMap(map);
  if (!isObject(match)) errors.push("the match file must be an object");
  else {
    unknownKeys(match, MATCH_KEYS, "match file", errors, {
      teams: ": teams come from the map's agents",
      config:
        ": the match file is flat now (sessionId, rules, briefing at the top)",
      runtime: ": bots always run in native participant hosts",
    });
    if (match.rules !== undefined && !isObject(match.rules))
      errors.push("match file: rules must be an object");
    if (match.briefing !== undefined && typeof match.briefing !== "string")
      errors.push("match file: briefing must be a string");
    checkCommands(match.commands, "match file", errors);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  const briefing = joinText(map.briefing, match.briefing);
  const config = {
    sessionId: match.sessionId,
    kind: match.kind ?? "match",
    teams: teamsOf(agents),
    rules: { ...map.rules, ...match.rules },
    ...(briefing ? { briefing } : {}),
  };
  const configErrors = validateServerConfig(config);
  if (configErrors.length) throw new Error(configErrors.join("\n"));
  const commands = {};
  for (const phase of PHASES) {
    const list = [
      ...(map.commands?.[phase] ?? []),
      ...(match.commands?.[phase] ?? []),
    ];
    if (list.length) commands[phase] = list;
  }
  return { config, commands };
}

/** The user participant containers run as. */
const PARTICIPANT_UID = 1000;

/**
 * Make the participant manifest readable to its container user. Windows has
 * no POSIX owners.
 */
export async function shareWithParticipant(
  file,
  uid = process.getuid?.() ?? null,
  ops = { chown, chmod },
) {
  if (uid === null || uid === PARTICIPANT_UID) return;
  if (uid === 0) {
    try {
      await ops.chown(file, PARTICIPANT_UID, PARTICIPANT_UID);
    } catch (error) {
      // Some mounted filesystems do not implement chown. The manifest has no
      // credentials, so readable mode still lets the participant start its
      // native host.
      if (!["EPERM", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
      await ops.chmod(file, 0o644);
    }
  } else await ops.chmod(file, 0o644);
}

/**
 * The whole Compose project (plain data): the Minecraft server with the
 * datapacks mounted read-only, the operator tool, and per agent a login gate,
 * a participant and, for agents with one, its model relay. Paths in volumes
 * are relative to the deployment directory, where compose.yaml is written.
 *
 * `datapacks` are absolute directories; `limits` {cpus, memory, pids,
 * minecraftMemory}; `source` the repository the images build from.
 */
export function deploymentCompose({
  name,
  agents,
  models,
  mapId,
  datapacks = [],
  limits = {},
  source,
}) {
  const common = {
    user: `${PARTICIPANT_UID}:${PARTICIPANT_UID}`,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    init: true,
    pids_limit: limits.pids ?? 256,
    mem_limit: limits.memory ?? "2g",
    cpus: limits.cpus ?? 2,
    restart: "no",
  };
  const trustedImage = `craft-arena-trusted:${name}`;
  const rcon = "${MC_RCON_PASSWORD:?Set MC_RCON_PASSWORD in .env}";
  const services = {
    minecraft: {
      ...common,
      build: "./server",
      image: `craft-arena-minecraft:${name}`,
      mem_limit: limits.minecraftMemory ?? "3g",
      // Login gates connect after the server accepts players (cold start).
      healthcheck: {
        test: ["CMD", "bash", "-c", "echo > /dev/tcp/127.0.0.1/25565"],
        interval: "5s",
        timeout: "3s",
        retries: 60,
        start_period: "20s",
      },
      networks: ["backend"],
      volumes: [
        "./minecraft-data:/data",
        "./results:/results",
        "./replay-config:/data/config/ServerReplay",
        // Beside the save, never copied into it: a reset keeps them.
        ...datapacks.map((dir) => ({
          type: "bind",
          source: dir,
          target: `/data/world/datapacks/${basename(dir)}`,
          read_only: true,
        })),
      ],
      stop_grace_period: "180s",
    },
    // Operator commands for the rules datapack (packages/arena/src/cli.mjs).
    arena: {
      ...common,
      profiles: ["tools"],
      image: trustedImage,
      entrypoint: ["node", "packages/arena/src/cli.mjs"],
      environment: { MC_RCON_HOST: "minecraft", MC_RCON_PASSWORD: rcon },
      networks: ["backend"],
      volumes: ["./generated/match.json:/config/match.json:ro"],
    },
  };
  const networks = { backend: { internal: true } };
  const volumes = {};
  for (const [i, agent] of agents.entries()) {
    const net = `agent-${agent.id}`;
    networks[net] = { internal: true };
    services[gateService(agent.id)] = {
      ...common,
      image: trustedImage,
      // The first login gate carries the trusted image's build.
      ...(i
        ? {}
        : {
            build: { context: source, dockerfile: "infra/Dockerfile.trusted" },
          }),
      command: ["node", "packages/login-gate/cli.mjs"],
      depends_on: { minecraft: { condition: "service_healthy" } },
      environment: {
        GATE_USERNAMES: agent.bots.join(","),
        GATE_UPSTREAM_HOST: "minecraft",
        GATE_RCON_HOST: "minecraft",
        GATE_RCON_PASSWORD: rcon,
      },
      networks: ["backend", net],
    };
  }
  const relays = new Map();
  for (const agent of agents) {
    const access = models[agent.id];
    if (!access.relay) continue;
    if (!relays.has(access.relay))
      relays.set(access.relay, { access, ids: [] });
    relays.get(access.relay).ids.push(agent.id);
  }
  for (const [relay, { access, ids }] of relays) {
    // Its own way out: a participant with internet never shares a network
    // with another team's relay.
    networks[`egress-${relay}`] = {};
    services[`model-${relay}`] = {
      ...common,
      profiles: ["agents"],
      image: trustedImage,
      command: ["node", "packages/model-relay/cli.mjs"],
      environment: {
        MODEL_RELAY_UPSTREAM: access.upstream,
        MODEL_RELAY_API_KEY: `\${${access.key}:?Set ${access.key} in .env}`,
      },
      extra_hosts: ["host.docker.internal:host-gateway"],
      networks: [...ids.map((id) => `agent-${id}`), `egress-${relay}`],
    };
  }
  let participantBuilt = false;
  for (const agent of agents) {
    const access = models[agent.id];
    const own = [`agent-${agent.id}`];
    if (access.internet) {
      networks[`internet-${agent.id}`] = {};
      own.push(`internet-${agent.id}`);
    }
    services[`participant-${agent.id}`] = {
      ...common,
      profiles: ["agents"],
      image: `craft-arena-participant:${name}`,
      ...(participantBuilt
        ? {}
        : {
            build: {
              context: source,
              dockerfile: "infra/Dockerfile.participant",
            },
          }),
      environment: {
        ARENA_MINECRAFT_HOST: gateService(agent.id),
        ARENA_SESSION_URL: `http://${gateService(agent.id)}:8080/v1/session`,
        MC_VERSION: "1.21.1",
        ARENA_WORLD_ID: mapId,
        ARENA_PARTICIPANT_ID: agent.id,
        ARENA_BOT: agent.bots[0],
        ARENA_WORLD_MEMORY_MODE: "${ARENA_WORLD_MEMORY_MODE:-off}",
        ARENA_PROVISION_DIR: "/arena/provision",
        ARENA_PI_MODEL: access.model,
        ...(access.relay
          ? { ARENA_PI_BASE_URL: `http://model-${access.relay}:8080` }
          : {
              ...(access.baseUrl ? { ARENA_PI_BASE_URL: access.baseUrl } : {}),
              ARENA_PI_API_KEY: `\${${access.key}:?Set ${access.key} in .env}`,
            }),
        ...(access.thinking ? { ARENA_PI_THINKING: access.thinking } : {}),
        ...(access.compactAt
          ? { ARENA_PI_COMPACT_AT: String(access.compactAt) }
          : {}),
        ARENA_COST_PER_HOUR: "${MODEL_COST_PER_HOUR:-}",
        TEAM_GIT_DIR: "/team-git",
        ARENA_START_TIMEOUT_MS: "86400000",
      },
      ...(access.internet
        ? { extra_hosts: ["host.docker.internal:host-gateway"] }
        : {}),
      networks: own,
      volumes: [
        `${agent.id}-work:/workspace`,
        `${gitVolume(agent)}:/team-git`,
        `./generated/agents/${agent.id}:/arena/provision:ro`,
        `./generated/agents/${agent.id}/config:/arena/config:ro`,
      ],
      tmpfs: ["/tmp:rw,nosuid,size=256m"],
    };
    participantBuilt = true;
    volumes[`${agent.id}-work`] = {};
    volumes[gitVolume(agent)] = {};
  }
  return { name, services, networks, volumes };
}

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
 * Write `agents/<id>/` (manifest.json, config/, files/) under `outDir`, which
 * must not hold one yet. Mounted read-only at /arena/provision.
 */
export async function writeAgents({ agents, mapDir, outDir }) {
  mapDir = resolve(mapDir);
  for (const agent of agents)
    for (const file of agent.files) {
      const source = resolve(mapDir, file.source);
      if (relative(mapDir, source).startsWith(".."))
        throw new Error(`${file.source} is outside the map directory`);
      if (!(await exists(source)))
        throw new Error(
          `agent ${agent.id}: ${file.source} not found in the map`,
        );
    }
  if (await exists(join(outDir, "agents")))
    throw new Error(`${join(outDir, "agents")} already exists`);
  for (const agent of agents) {
    const dir = join(outDir, "agents", agent.id);
    await mkdir(join(dir, "config"), { recursive: true });
    const workspace = [];
    for (const [n, file] of agent.files.entries()) {
      const source = resolve(mapDir, file.source);
      if (file.target.startsWith("/arena/config/"))
        await cp(
          source,
          join(dir, "config", file.target.slice("/arena/config/".length)),
          { recursive: true },
        );
      else {
        const stored = `files/${n}-${basename(file.source)}`;
        await mkdir(join(dir, "files"), { recursive: true });
        await cp(source, join(dir, stored), { recursive: true });
        workspace.push({
          source: stored,
          target: file.target,
          mode: file.mode ?? "replace",
        });
      }
    }
    await writeFile(
      join(dir, "manifest.json"),
      `${JSON.stringify(
        {
          agent: agent.id,
          ...(agent.team ? { team: agent.team } : {}),
          teammates: agents
            .filter(
              (other) =>
                agent.team && other.team === agent.team && other !== agent,
            )
            .map((other) => other.id),
          bots: agent.bots.map((bot) => ({ name: bot })),
          files: workspace,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await shareWithParticipant(join(dir, "manifest.json"));
  }
}
