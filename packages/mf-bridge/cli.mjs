import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RconClient } from "../arena/src/rcon.mjs";
import { startLiveBridge } from "./live.mjs";
import {
  hostSessionReader,
  polledSession,
  serverSessionReader,
} from "./session-source.mjs";

export const MAX_SESSION_PROMPT_BYTES = 32 * 1024;

/**
 * Standalone open session: no arena host, no time limit, no winner. The bridge
 * serves it at /v1/session so the participant runtime sees a running session.
 * `username` may be a function: the in-game name is only known after login.
 */
export function openSession({
  sessionId,
  username,
  startedAt,
  briefing = null,
  prompt = null,
  now = Date.now,
}) {
  return () => {
    const at = now();
    const name = typeof username === "function" ? username() : username;
    return {
      kind: "open",
      state: "running",
      sessionId,
      matchId: sessionId,
      runId: sessionId,
      participantId: name,
      teamId: null,
      username: name,
      teams: [],
      participants: [{ id: name, username: name, teamId: null }],
      map: null,
      now: at,
      startedAt,
      durationMs: null,
      elapsedMs: Math.max(0, at - startedAt),
      winner: null,
      scores: null,
      briefing: { text: briefing, prompt, public: null },
    };
  };
}

/**
 * Build startLiveBridge options from the environment without connecting.
 * `readPrompt` returns the bytes of BRIDGE_PROMPT_FILE (read once at start).
 * With BRIDGE_SESSION=open the result also has `session.setUsername(name)`:
 * with MF_AUTH=microsoft, MF_USERNAME is the account, not the in-game name.
 */
export function cliOptions(
  env = process.env,
  {
    now = Date.now,
    readPrompt = (path) => readFileSync(path),
    cwd = process.cwd(),
  } = {},
) {
  const required = (name) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const port = (name, fallback) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > 65535)
      throw new Error(`${name} must be a port`);
    return n;
  };
  const auth = env.MF_AUTH || "offline";
  if (auth !== "offline" && auth !== "microsoft")
    throw new Error("MF_AUTH must be offline or microsoft");
  const username = required("MF_USERNAME");
  const minecraft = {
    host: required("MF_HOST"),
    port: port("MF_PORT", 25565),
    username,
    version: required("MF_VERSION"),
    auth,
    ...(auth === "microsoft" && env.MF_PROFILES_DIR
      ? { profilesFolder: resolve(cwd, env.MF_PROFILES_DIR) }
      : {}),
  };
  const bridge = {
    host: env.BRIDGE_HOST ?? "127.0.0.1",
    port: port("BRIDGE_PORT", 8080),
    token: required("BRIDGE_TOKEN"),
    ...(env.BRIDGE_STATUS_TOKEN
      ? { statusToken: env.BRIDGE_STATUS_TOKEN }
      : {}),
    allowChat: env.BRIDGE_ALLOW_CHAT !== "false",
    blockMemory: env.BRIDGE_BLOCK_MEMORY === "false" ? false : {},
  };
  const kind = env.BRIDGE_SESSION;
  if (![undefined, "", "open", "host", "server"].includes(kind))
    throw new Error("BRIDGE_SESSION must be open, host or server when set");
  if (env.BRIDGE_WORLD_ID || env.BRIDGE_PARTICIPANT_ID)
    bridge.blockMemory = {
      ...(env.BRIDGE_WORLD_ID ? { worldId: env.BRIDGE_WORLD_ID } : {}),
      ...(env.BRIDGE_PARTICIPANT_ID
        ? { participantId: env.BRIDGE_PARTICIPANT_ID }
        : {}),
    };
  let prompt = null;
  if (env.BRIDGE_PROMPT_FILE) {
    const bytes = readPrompt(resolve(cwd, env.BRIDGE_PROMPT_FILE));
    const size =
      typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.length;
    if (size > MAX_SESSION_PROMPT_BYTES)
      throw new Error(
        `BRIDGE_PROMPT_FILE exceeds ${MAX_SESSION_PROMPT_BYTES} bytes`,
      );
    prompt = String(typeof bytes === "string" ? bytes : bytes.toString("utf8"));
  }
  let sessionUsername = username;
  const setUsername = (name) => {
    if (typeof name === "string" && name) sessionUsername = name;
  };
  if (kind === "open") {
    const startedAt = now();
    bridge.getMatchState = openSession({
      sessionId: env.BRIDGE_SESSION_ID || `open-${startedAt}`,
      username: () => sessionUsername,
      startedAt,
      briefing: env.BRIDGE_BRIEFING || null,
      prompt,
      now,
    });
    return { minecraft, bridge, session: { kind, setUsername } };
  }
  if (kind === "host" || kind === "server") {
    const intervalMs = Number(env.BRIDGE_SESSION_POLL_MS ?? 250);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 50)
      throw new Error("BRIDGE_SESSION_POLL_MS must be an integer >= 50");
    let rcon;
    if (kind === "host") {
      required("BRIDGE_HOST_URL");
      required("BRIDGE_HOST_TOKEN");
    } else
      rcon = {
        host: required("BRIDGE_RCON_HOST"),
        port: port("BRIDGE_RCON_PORT", 25575),
        password: required("BRIDGE_RCON_PASSWORD"),
      };
    let service;
    const polled = polledSession({
      intervalMs,
      read:
        kind === "host"
          ? hostSessionReader({
              url: env.BRIDGE_HOST_URL,
              token: env.BRIDGE_HOST_TOKEN,
            })
          : () => serverRead(),
      // A host session is one match: when it ends, stop the game but keep
      // serving the final state. A stale "ended" read at startup is not an
      // end. Server sessions can run round after round, so the bot stays and
      // only actions are refused between rounds.
      onChange: async (next, previous) => {
        if (
          kind === "host" &&
          next.state === "ended" &&
          previous &&
          previous.state !== "ended"
        )
          await service?.stopGame().catch(() => {});
      },
    });
    let serverRead;
    bridge.getMatchState = () => polled.getMatchState();
    bridge.authorizeAction = () => polled.authorizeAction();
    return {
      minecraft,
      bridge,
      session: {
        kind,
        setUsername,
        ended: () => {
          try {
            return kind === "host" && polled.getMatchState().state === "ended";
          } catch {
            return false;
          }
        },
        async start(started, { createRcon = (o) => new RconClient(o) } = {}) {
          service = started;
          if (rcon) {
            const client = createRcon(rcon);
            await client.connect();
            serverRead = serverSessionReader({
              rcon: client,
              username: () => sessionUsername,
              sessionId: env.BRIDGE_SESSION_ID || `server-${now()}`,
              briefing: env.BRIDGE_BRIEFING || null,
              prompt,
              now,
            });
            const close = polled.close;
            polled.close = () => {
              close();
              client.close();
            };
          }
          await polled.start();
        },
        poll: () => polled.poll(),
        close: () => polled.close(),
      },
    };
  }
  return { minecraft, bridge };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const options = cliOptions();
  const service = await startLiveBridge(options);
  options.session?.setUsername(service.bot.username);
  await options.session?.start?.(service);
  console.log(`Capability bridge listening at ${service.url}`);
  service.bot.on("error", (error) =>
    console.error("Minecraft bot error:", error.message),
  );
  service.bot.on("end", (reason) => {
    console.error("Minecraft bot ended:", reason);
    // A session would otherwise keep reporting `running` with no bot; exit
    // so the gateway refuses model calls until the operator restarts. After
    // the session ended the bridge stays up to serve the final state.
    if (options.session && !options.session.ended?.()) process.exit(1);
  });
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      try {
        options.session?.close?.();
        await service.close();
        process.exit(0);
      } catch (error) {
        console.error(error.message);
        process.exit(1);
      }
    });
}
