/**
 * Trusted-side compiler from a map package and a match file to what one
 * deployment runs (docs/TARGET-ARCHITECTURE.md):
 *
 *   OUT/match.json             the match file, with teams derived from the map's agents
 *   OUT/compose.agents.yaml    one bridge per bot, one model relay per relay
 *                              name, one participant container per agent
 *   OUT/agents.env             a fresh bridge token per bot, for Compose
 *   OUT/agents/<id>/           mounted read-only at /arena/provision:
 *     manifest.json            agent, team, bots (name, url, token), workspace files
 *     model.json               the model descriptor for this agent's relay
 *     config/                  mounted at /arena/config (agents.d, skills, ...)
 *     files/<n>                sources of files the launcher copies into /workspace
 *
 * The map package is a directory with map.json:
 *
 *   { "defaults": { "files": [...] },
 *     "agents": { "red1": { "team": "red", "bots": ["arena_red1"], "files": [...] } } }
 *
 * A file is { source, target, mode }: source relative to the map directory;
 * target an absolute path under /arena/config/ or /workspace/; mode "replace"
 * (default) or "once" (workspace only: keep a file the participant already has).
 * An agent's own `files` (and `team`) replace the defaults; they are not merged.
 *
 * The match file may add "agents": { "red1": { "relay": "red", "model": "model.red.json" } };
 * the relay defaults to the agent's team (else its id) and the model to
 * model.<relay>.json next to the match file.
 */
import { randomBytes } from "node:crypto";
import {
  chmod,
  chown,
  cp,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
} from "node:path";
import { validateServerConfig } from "./server-protocol.mjs";

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const BOT_NAME = /^[A-Za-z0-9_]{3,16}$/;
const RELAY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ROOTS = ["/arena/config/", "/workspace/"];

const envName = (value) => value.toUpperCase().replace(/[^A-Z0-9]/g, "_");
/** Teammates share one Git volume; an agent without a team has its own. */
const gitVolume = (agent) =>
  agent.team
    ? `team-${String(agent.team).replace(/[^A-Za-z0-9_.-]/g, "-")}-git`
    : `${agent.id}-git`;

export const tokenVariable = (bot) => `BRIDGE_TOKEN_${envName(bot)}`;
// Service names double as host names, which take no underscores.
export const bridgeService = (bot) =>
  `bridge-${bot.toLowerCase().replace(/_/g, "-")}`;

function checkFile(file, where, errors) {
  if (!file || typeof file !== "object") {
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

/** The map's agent slots with defaults applied; throws on any error. */
export function resolveAgents(map) {
  const errors = [];
  if (!map || typeof map !== "object" || Array.isArray(map))
    throw new Error("map.json must be an object");
  const defaults = map.defaults ?? {};
  const agents = map.agents;
  if (!agents || typeof agents !== "object" || !Object.keys(agents).length)
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

/** The user participant containers run as. */
const PARTICIPANT_UID = 1000;

/**
 * The manifest holds the agent's bridge tokens: private to its owner, and
 * that owner must be the container user. As root, hand it over; as another
 * user (who cannot chown), let it be read and rely on the deployment
 * directory's own permissions. Windows has no POSIX owners.
 */
export async function shareWithParticipant(
  file,
  uid = process.getuid?.() ?? null,
  ops = { chown, chmod },
) {
  if (uid === null || uid === PARTICIPANT_UID) return;
  if (uid === 0) await ops.chown(file, PARTICIPANT_UID, PARTICIPANT_UID);
  else await ops.chmod(file, 0o644);
}

/** The Compose services, networks and volumes for the agents (plain data). */
export function agentsCompose(agents, { mapId, relays }) {
  const common = {
    user: `${PARTICIPANT_UID}:${PARTICIPANT_UID}`,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    init: true,
    pids_limit: "${ARENA_PIDS_LIMIT:-256}",
    mem_limit: "${ARENA_MEMORY_LIMIT:-2g}",
    cpus: "${ARENA_CPU_LIMIT:-2.0}",
    restart: "no",
  };
  const services = {},
    networks = { "model-egress": {} },
    volumes = {};
  let built = false;
  const trusted = () => ({
    image: "craft-arena-trusted:local",
    ...(built
      ? {}
      : {
          build: {
            context: "${ARENA_SOURCE_DIR}",
            dockerfile: "infra/Dockerfile.trusted",
          },
        }),
  });
  for (const agent of agents) {
    const net = `agent-${agent.id}`;
    networks[net] = { internal: true };
    for (const bot of agent.bots) {
      services[bridgeService(bot)] = {
        ...common,
        ...trusted(),
        command: ["node", "packages/mf-bridge/cli.mjs"],
        depends_on: { minecraft: { condition: "service_healthy" } },
        environment: {
          MF_HOST: "minecraft",
          MF_VERSION: "${MC_VERSION:-1.21.1}",
          MF_USERNAME: bot,
          BRIDGE_HOST: "0.0.0.0",
          BRIDGE_PORT: "8080",
          BRIDGE_TOKEN: `\${${tokenVariable(bot)}}`,
          BRIDGE_SESSION: "server",
          BRIDGE_RCON_HOST: "minecraft",
          BRIDGE_RCON_PASSWORD: "${MC_RCON_PASSWORD}",
          BRIDGE_WORLD_ID: mapId,
          BRIDGE_PARTICIPANT_ID: agent.id,
        },
        networks: ["backend", net],
      };
      built = true;
    }
  }
  for (const [relay, ids] of relays) {
    services[`model-${relay}`] = {
      ...common,
      profiles: ["agents"],
      image: "craft-arena-trusted:local",
      command: ["node", "packages/model-relay/cli.mjs"],
      environment: {
        MODEL_RELAY_UPSTREAM: `\${${envName(relay)}_MODEL_URL:?Set ${envName(relay)}_MODEL_URL in .env}`,
        MODEL_RELAY_API_KEY: `\${${envName(relay)}_MODEL_KEY:-}`,
      },
      extra_hosts: ["host.docker.internal:host-gateway"],
      networks: [...ids.map((id) => `agent-${id}`), "model-egress"],
    };
  }
  let participantBuilt = false;
  for (const agent of agents) {
    const main = agent.bots[0];
    services[`participant-${agent.id}`] = {
      ...common,
      profiles: ["agents"],
      image: "craft-arena-participant:local",
      ...(participantBuilt
        ? {}
        : {
            build: {
              context: "${ARENA_SOURCE_DIR}",
              dockerfile: "infra/Dockerfile.participant",
            },
          }),
      environment: {
        ARENA_BRIDGE_URL: `http://${bridgeService(main)}:8080`,
        ARENA_BRIDGE_TOKEN: `\${${tokenVariable(main)}}`,
        ARENA_BOT: main,
        ARENA_PROVISION_DIR: "/arena/provision",
        OPENAI_BASE_URL: `http://model-${agent.relay}:8080`,
        ARENA_COST_PER_HOUR: "${MODEL_COST_PER_HOUR:-}",
        ARENA_MODEL_CONFIG: "/arena/provision/model.json",
        TEAM_GIT_DIR: "/team-git",
        ARENA_START_TIMEOUT_MS: "86400000",
      },
      networks: [`agent-${agent.id}`],
      volumes: [
        `${agent.id}-work:/workspace`,
        `${gitVolume(agent)}:/team-git`,
        `./agents/${agent.id}:/arena/provision:ro`,
        `./agents/${agent.id}/config:/arena/config:ro`,
      ],
      tmpfs: ["/tmp:rw,nosuid,size=256m"],
    };
    participantBuilt = true;
    volumes[`${agent.id}-work`] = {};
    volumes[gitVolume(agent)] = {};
  }
  return { services, networks, volumes };
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
 * Compile `mapDir` + `matchPath` into `outDir`. outDir may exist (a
 * deployment being assembled), but none of the outputs may.
 * Returns { agents, teams, files } for printing.
 */
export async function provision({
  mapDir,
  matchPath,
  outDir,
  // Where the default `model.<relay>.json` descriptors live; a `model` the
  // match file names is relative to the match file.
  modelDir = dirname(matchPath),
  token = () => randomBytes(32).toString("hex"),
}) {
  mapDir = resolve(mapDir);
  for (const name of [
    "match.json",
    "compose.agents.yaml",
    "agents.env",
    "agents",
  ])
    if (await exists(join(outDir, name)))
      throw new Error(`${join(outDir, name)} already exists`);
  const map = JSON.parse(await readFile(join(mapDir, "map.json"), "utf8"));
  const agents = resolveAgents(map);
  const match = JSON.parse(await readFile(matchPath, "utf8"));
  const matchAgents = match.agents ?? {};
  for (const id of Object.keys(matchAgents))
    if (!agents.some((agent) => agent.id === id))
      throw new Error(`match.json agents.${id} is not an agent of the map`);
  const teams = teamsOf(agents);
  const config = { ...match.config };
  if (config.teams === undefined) config.teams = teams;
  else if (JSON.stringify(config.teams) !== JSON.stringify(teams))
    throw new Error(
      `match.json config.teams differs from the map's agents; leave it out to use ${JSON.stringify(teams)}`,
    );
  const errors = validateServerConfig(config);
  if (errors.length) throw new Error(errors.join("\n"));
  const relays = new Map();
  for (const agent of agents) {
    const own = matchAgents[agent.id] ?? {};
    agent.relay = own.relay ?? agent.team ?? agent.id;
    if (!RELAY.test(agent.relay))
      throw new Error(
        `agent ${agent.id}: relay ${agent.relay} must match ${RELAY}`,
      );
    agent.model = own.model
      ? resolve(dirname(matchPath), own.model)
      : resolve(modelDir, `model.${agent.relay}.json`);
    if (!(await exists(agent.model)))
      throw new Error(
        `agent ${agent.id}: model descriptor ${agent.model} not found`,
      );
    if (!relays.has(agent.relay)) relays.set(agent.relay, []);
    relays.get(agent.relay).push(agent.id);
  }
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

  await mkdir(outDir, { recursive: true });
  const tokens = new Map(
    agents.flatMap((a) => a.bots.map((bot) => [bot, token()])),
  );
  for (const agent of agents) {
    const dir = join(outDir, "agents", agent.id);
    await mkdir(join(dir, "config"), { recursive: true });
    await cp(agent.model, join(dir, "model.json"));
    const workspace = [];
    for (const [n, file] of agent.files.entries()) {
      const source = resolve(mapDir, file.source);
      if (file.target.startsWith("/arena/config/"))
        await cp(
          source,
          join(dir, "config", file.target.slice("/arena/config/".length)),
          {
            recursive: true,
          },
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
          bots: agent.bots.map((bot) => ({
            name: bot,
            url: `http://${bridgeService(bot)}:8080`,
            token: tokens.get(bot),
          })),
          files: workspace,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await shareWithParticipant(join(dir, "manifest.json"));
  }
  const { agents: _agents, ...rest } = match;
  await writeFile(
    join(outDir, "match.json"),
    `${JSON.stringify({ ...rest, config }, null, 2)}\n`,
  );
  await writeFile(
    join(outDir, "agents.env"),
    [...tokens]
      .map(([bot, value]) => `${tokenVariable(bot)}=${value}\n`)
      .join(""),
    { mode: 0o600 },
  );
  const compose = agentsCompose(agents, {
    mapId: basename(mapDir),
    relays,
  });
  // JSON is valid YAML; Compose merges this file over the deployment's base file.
  await writeFile(
    join(outDir, "compose.agents.yaml"),
    `# Generated by cli.mjs provision from ${basename(mapDir)}/map.json; do not edit.\n${JSON.stringify(compose, null, 2)}\n`,
  );
  return {
    agents: agents.map(({ id, team, bots, relay }) => ({
      id,
      team,
      bots,
      relay,
    })),
    teams,
  };
}
