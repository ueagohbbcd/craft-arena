import { parseStorageReply, serializeSnbt } from "./snbt.mjs";

/**
 * Server protocol v1 (docs/GAME-MODES.md): the platform talks to the rules
 * datapack or plugin only through these RCON commands. Shared by the
 * datapack judge, host-less bridges and scripts/verify-server-protocol.mjs.
 */
export const PROTOCOL_VERSION = 1;
// Consecutive unreadable polls tolerated before the match ends `map-fault`.
export const MAX_FAILED_POLLS = 3;
export const REJECTED =
  /Unknown or incomplete command|Incorrect argument|Unknown function|Unknown storage|Expected |Invalid |Can't |Cannot |Could not /i;

/** Validated `arena:session` contents, or an error for a malformed one. */
export function readServerSession(reply) {
  const value = parseStorageReply(reply, "arena:session");
  if (!value) throw new Error("arena:session is empty");
  if (value.version !== PROTOCOL_VERSION)
    throw new Error(`Unsupported arena:session version ${value.version}`);
  if (!["waiting", "running", "ended"].includes(value.state))
    throw new Error(`Invalid arena:session state ${value.state}`);
  for (const key of ["winner", "message"])
    if (value[key] !== undefined && typeof value[key] !== "string")
      throw new Error(`arena:session ${key} must be a string`);
  if (
    value.scores !== undefined &&
    (!value.scores ||
      typeof value.scores !== "object" ||
      Array.isArray(value.scores) ||
      Object.values(value.scores).some((n) => typeof n !== "number"))
  )
    throw new Error("arena:session scores must map names to numbers");
  if (
    value.public !== undefined &&
    (!value.public ||
      typeof value.public !== "object" ||
      Array.isArray(value.public))
  )
    throw new Error("arena:session public must be a compound");
  return {
    state: value.state,
    winner: value.winner || null,
    scores: value.scores ?? null,
    public: value.public ?? null,
    message: value.message || null,
  };
}

/** The `arena:config` value written before `#arena:prepare`. */
export function serverConfig(config, runId) {
  const value = {
    version: PROTOCOL_VERSION,
    sessionId: config.id,
    runId,
    kind: config.session.kind,
    teams: config.teams.map((t) => ({
      id: t.id,
      players: config.participants
        .filter((p) => p.team === t.id)
        .map((p) => p.username),
    })),
  };
  if (config.session.durationMs != null)
    value.durationMs = config.session.durationMs;
  return value;
}

/** Writes `arena:config` (see serverConfig). */
export async function writeServerConfig(rcon, config, runId) {
  // `data modify` needs a path, so the root cannot be replaced in one
  // command: drop the optional key a previous session may have left, then
  // merge (lists and scalars in the merge replace the old values).
  await rcon.command("data remove storage arena:config durationMs");
  const reply = await rcon.command(
    `data merge storage arena:config ${serializeSnbt(serverConfig(config, runId))}`,
  );
  if (REJECTED.test(reply))
    throw new Error(
      `Server rejected arena:config: ${String(reply).slice(0, 200)}`,
    );
}

/** Runs `#arena:<phase>`; throws when no datapack provides it. */
export async function runPhase(rcon, phase) {
  const reply = await rcon.command(`function #arena:${phase}`);
  // 1.21.1 answers "Can't find any functions for name arena:<phase>".
  if (/Unknown function|Can't find any functions/i.test(reply))
    throw new Error(
      `Server has no #arena:${phase} function tag; install the arena datapack`,
    );
  if (REJECTED.test(reply))
    throw new Error(`Server rejected #arena:${phase}: ${reply.slice(0, 200)}`);
}

/** The validated `arena:session` (see readServerSession). */
export async function readSession(rcon) {
  return readServerSession(
    await rcon.command("data get storage arena:session"),
  );
}

/** The `arena:config` compound, or null when nobody wrote one. */
export async function readConfig(rcon) {
  return parseStorageReply(
    await rcon.command("data get storage arena:config"),
    "arena:config",
  );
}
