import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startLiveBridge } from "./live.mjs";

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
    allowChat: env.BRIDGE_ALLOW_CHAT !== "false",
    blockMemory: env.BRIDGE_BLOCK_MEMORY === "false" ? false : {},
  };
  const kind = env.BRIDGE_SESSION;
  if (kind !== undefined && kind !== "" && kind !== "open")
    throw new Error("BRIDGE_SESSION must be open when set");
  if (kind === "open") {
    let prompt = null;
    if (env.BRIDGE_PROMPT_FILE) {
      const bytes = readPrompt(resolve(cwd, env.BRIDGE_PROMPT_FILE));
      const size =
        typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.length;
      if (size > MAX_SESSION_PROMPT_BYTES)
        throw new Error(
          `BRIDGE_PROMPT_FILE exceeds ${MAX_SESSION_PROMPT_BYTES} bytes`,
        );
      prompt = String(
        typeof bytes === "string" ? bytes : bytes.toString("utf8"),
      );
    }
    const startedAt = now();
    let sessionUsername = username;
    bridge.getMatchState = openSession({
      sessionId: env.BRIDGE_SESSION_ID || `open-${startedAt}`,
      username: () => sessionUsername,
      startedAt,
      briefing: env.BRIDGE_BRIEFING || null,
      prompt,
      now,
    });
    return {
      minecraft,
      bridge,
      session: {
        setUsername(name) {
          if (typeof name === "string" && name) sessionUsername = name;
        },
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
  console.log(`Capability bridge listening at ${service.url}`);
  service.bot.on("error", (error) =>
    console.error("Minecraft bot error:", error.message),
  );
  service.bot.on("end", (reason) => {
    console.error("Minecraft bot ended:", reason);
    // An open session would otherwise keep reporting `running` with no bot;
    // exit so the gateway refuses model calls until the operator restarts.
    if (options.session) process.exit(1);
  });
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      try {
        await service.close();
        process.exit(0);
      } catch (error) {
        console.error(error.message);
        process.exit(1);
      }
    });
}
