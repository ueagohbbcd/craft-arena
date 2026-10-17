import { parseStorageReply, serializeSnbt } from "./snbt.mjs";

/**
 * Server protocol v1 (docs/GAME-MODES.md): the platform talks to the rules
 * datapack or plugin only through these RCON commands. Shared by the
 * operator CLI (cli.mjs), bridges in server mode and
 * scripts/verify-server-protocol.mjs.
 */
const PROTOCOL_VERSION = 1;
// Optional arena:config keys, removed before each write so none is left over.
const OPTIONAL_KEYS = ["durationMs", "briefing", "runId"];

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

const id = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x);

/**
 * Errors in an `arena:config` value (empty when valid): `sessionId`, optional
 * `runId`, `kind` (`match` or `open`), `teams` [{id, players}], optional
 * positive `durationMs`, and an optional `briefing` text the bridges serve.
 */
export function validateServerConfig(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return ["arena:config must be an object"];
  if (!id(value.sessionId))
    errors.push("sessionId must match [A-Za-z0-9_-]{1,64}");
  if (value.runId !== undefined && !id(value.runId))
    errors.push("runId must match [A-Za-z0-9_-]{1,64}");
  if (!["match", "open"].includes(value.kind ?? "match"))
    errors.push("kind must be match or open");
  if (
    value.durationMs !== undefined &&
    (!Number.isSafeInteger(value.durationMs) || value.durationMs <= 0)
  )
    errors.push("durationMs must be a positive integer");
  if (value.briefing !== undefined && typeof value.briefing !== "string")
    errors.push("briefing must be a string");
  const teams = value.teams ?? [];
  if (!Array.isArray(teams)) errors.push("teams must be a list");
  else {
    const seen = new Set();
    const players = new Set();
    for (const team of teams) {
      if (!id(team?.id) || team.id === "draw")
        errors.push(
          `team id ${JSON.stringify(team?.id)} is invalid or reserved`,
        );
      else if (seen.has(team.id))
        errors.push(`team ${team.id} is listed twice`);
      seen.add(team?.id);
      if (
        !Array.isArray(team?.players) ||
        team.players.some((p) => typeof p !== "string" || !p)
      )
        errors.push(`team ${team?.id} players must be a list of usernames`);
      else
        for (const player of team.players) {
          if (players.has(player))
            errors.push(`player ${player} is in more than one team`);
          players.add(player);
        }
    }
  }
  return errors;
}

/** Writes `arena:config` (see validateServerConfig), adding the protocol version. */
export async function writeServerConfig(rcon, config) {
  const errors = validateServerConfig(config);
  if (errors.length)
    throw new Error(`Invalid arena:config: ${errors.join("; ")}`);
  const value = {
    version: PROTOCOL_VERSION,
    kind: "match",
    teams: [],
    ...config,
  };
  // `data modify` needs a path, so the root cannot be replaced in one
  // command: drop the optional keys a previous session may have left, then
  // merge (lists and scalars in the merge replace the old values).
  for (const key of OPTIONAL_KEYS)
    await rcon.command(`data remove storage arena:config ${key}`);
  await rcon.command(`data merge storage arena:config ${serializeSnbt(value)}`);
  // Vanilla RCON shares one output buffer between clients, so the merge
  // reply may carry a bridge's text; read the storage back instead.
  const written = JSON.parse(JSON.stringify(value));
  const stored = (await readConfig(rcon)) ?? {};
  const wrong = [
    ...new Set([...Object.keys(written), ...OPTIONAL_KEYS]),
  ].filter((key) => !same(stored[key], written[key]));
  if (wrong.length)
    throw new Error(`arena:config was not written: ${wrong.join(", ")} differ`);
}

/** Deep equality of parsed SNBT and JSON values, ignoring key order. */
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
  );
}

/**
 * Vanilla RCON shares one output buffer between clients: while bridges read
 * the session storage, a command's own reply can come back empty or as their
 * storage text. Such a reply says nothing about the command, so `expect`
 * does not fail on it.
 */
const lostReply = (reply) =>
  !String(reply ?? "").trim() ||
  /^Storage [\w.:/-]+ has the following contents:/.test(String(reply));

/**
 * Runs operator commands in order. Each is a string or `{command, expect}`;
 * with `expect` (a regular expression) a reply that does not match throws,
 * unless the reply was lost to another RCON client (see `lostReply`).
 * Returns the replies.
 */
export async function runCommands(rcon, list = []) {
  const replies = [];
  for (const item of list) {
    const { command, expect } =
      typeof item === "string" ? { command: item } : (item ?? {});
    if (typeof command !== "string" || !command)
      throw new Error("Each command must be a non-empty string");
    const reply = await rcon.command(command);
    if (
      expect !== undefined &&
      !new RegExp(expect).test(reply) &&
      !lostReply(reply)
    )
      throw new Error(
        `Unexpected reply to "${command}": ${String(reply).slice(0, 200)}`,
      );
    replies.push(reply);
  }
  return replies;
}

/**
 * Runs `#arena:<phase>`; throws when no datapack provides it. Other error
 * text is not checked: with several RCON clients it may be another client's.
 */
export async function runPhase(rcon, phase) {
  const reply = String(await rcon.command(`function #arena:${phase}`));
  // 1.21.1 answers "Can't find any functions for name arena:<phase>".
  if (
    reply.includes(`Can't find any functions for name arena:${phase}`) ||
    reply.includes(`Unknown function #arena:${phase}`)
  )
    throw new Error(
      `Server has no #arena:${phase} function tag; install the arena datapack`,
    );
}

/**
 * Reads a storage, trying up to three times: vanilla RCON clears its shared
 * output buffer for each client's command, so another client can empty a
 * reply before it is sent.
 */
async function readStorage(rcon, id, parse) {
  for (let attempt = 1; ; attempt++) {
    try {
      return parse(await rcon.command(`data get storage ${id}`));
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

/** The validated `arena:session` (see readServerSession). */
export function readSession(rcon) {
  return readStorage(rcon, "arena:session", readServerSession);
}

/** The `arena:config` compound, or null when nobody wrote one. */
export function readConfig(rcon) {
  return readStorage(rcon, "arena:config", (reply) =>
    parseStorageReply(reply, "arena:config"),
  );
}
