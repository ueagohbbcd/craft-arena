import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startLiveBridge } from "./live.mjs";
import { sessionObject } from "./session-object.mjs";
import { serverSession } from "./session-source.mjs";

export const MAX_SESSION_PROMPT_BYTES = 32 * 1024;

/**
 * Standalone open session: no rules datapack, no time limit, no winner. The bridge
 * serves it at /v1/session so the participant runtime sees a running session.
 * `username` may be a function: the in-game name is only known after login.
 */
export function openSession({
  sessionId,
  username,
  briefing = null,
  prompt = null,
  now = Date.now,
}) {
  return () => {
    const name = typeof username === "function" ? username() : username;
    return sessionObject({
      kind: "open",
      state: "running",
      sessionId,
      participantId: name,
      username: name,
      participants: [{ id: name, username: name, teamId: null }],
      now: now(),
      briefing: { text: briefing, prompt },
    });
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
  if (![undefined, "", "open", "server"].includes(kind))
    throw new Error("BRIDGE_SESSION must be open or server when set");
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
    bridge.getSessionState = openSession({
      sessionId: env.BRIDGE_SESSION_ID || `open-${now()}`,
      username: () => sessionUsername,
      briefing: env.BRIDGE_BRIEFING || null,
      prompt,
      now,
    });
    return { minecraft, bridge, session: { kind, setUsername } };
  }
  if (kind === "server") {
    const intervalMs = Number(env.BRIDGE_SESSION_POLL_MS ?? 250);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 50)
      throw new Error("BRIDGE_SESSION_POLL_MS must be an integer >= 50");
    const session = serverSession({
      rcon: {
        host: required("BRIDGE_RCON_HOST"),
        port: port("BRIDGE_RCON_PORT", 25575),
        password: required("BRIDGE_RCON_PASSWORD"),
      },
      intervalMs,
      username: () => sessionUsername,
      sessionId: env.BRIDGE_SESSION_ID || `server-${now()}`,
      briefing: env.BRIDGE_BRIEFING || null,
      prompt,
      now,
    });
    bridge.getSessionState = session.getSessionState;
    bridge.authorizeAction = session.authorizeAction;
    return { minecraft, bridge, session: { ...session, kind, setUsername } };
  }
  return { minecraft, bridge };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const options = cliOptions();
  const service = await startLiveBridge(options);
  // With MF_AUTH=microsoft the in-game name is only known after login.
  const refreshUsername = () =>
    options.session?.setUsername(service.bot.username);
  refreshUsername();
  service.bot.once?.("login", refreshUsername);
  service.bot.once?.("spawn", refreshUsername);
  await options.session?.start?.(service);
  console.log(`Capability bridge listening at ${service.url}`);
  service.bot.on("error", (error) =>
    console.error("Minecraft bot error:", error.message),
  );
  service.bot.on("end", (reason) => {
    console.error("Minecraft bot ended:", reason);
    // A session would otherwise keep reporting `running` with no bot; exit
    // so the participant stops being prompted until the operator restarts.
    if (options.session) process.exit(1);
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
