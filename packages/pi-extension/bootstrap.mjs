#!/usr/bin/env node
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const extensionPath = fileURLToPath(new URL("./index.mjs", import.meta.url));
const projectRoot = resolve(dirname(extensionPath), "../..");
const positiveInteger = (value, fallback) => {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error("Model limits must be positive integers");
  return n;
};

/** Generate a private Pi profile containing an environment reference, never the bearer token. */
export async function preparePiProfile({
  env = process.env,
  directory,
  cwd = process.cwd(),
} = {}) {
  if (!env.MODEL_ID || !env.OPENAI_BASE_URL || !env.OPENAI_API_KEY)
    throw new Error(
      "MODEL_ID, OPENAI_BASE_URL, and participant-scoped OPENAI_API_KEY are required",
    );
  const base = new URL(env.OPENAI_BASE_URL);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error(
      "OPENAI_BASE_URL must be an HTTP(S) gateway URL without embedded credentials",
    );
  const contextWindow = positiveInteger(env.PI_CONTEXT_WINDOW, 32768);
  const maxTokens = positiveInteger(env.PI_MAX_TOKENS, 2048);
  const reserveTokens = positiveInteger(
    env.PI_COMPACTION_RESERVE_TOKENS,
    Math.min(
      Math.floor(contextWindow / 2),
      Math.max(maxTokens * 2, Math.floor(contextWindow / 4)),
    ),
  );
  const keepRecentTokens = positiveInteger(
    env.PI_COMPACTION_KEEP_RECENT_TOKENS,
    Math.min(Math.floor(contextWindow / 4), contextWindow - reserveTokens - 1),
  );
  if (
    maxTokens >= contextWindow ||
    reserveTokens < maxTokens ||
    reserveTokens >= contextWindow ||
    keepRecentTokens >= contextWindow - reserveTokens
  )
    throw new Error(
      "Compaction settings must leave response reserve and a smaller recent-history window within PI_CONTEXT_WINDOW",
    );
  const compaction = { enabled: true, reserveTokens, keepRecentTokens };
  const modelApi = env.PI_MODEL_API ?? "openai-completions";
  if (!["openai-completions", "pi-messages"].includes(modelApi))
    throw new Error("PI_MODEL_API must be openai-completions or pi-messages");
  const agentDir = directory || (await mkdtemp(join(tmpdir(), "arena-pi-")));
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const models = {
    providers: {
      arena: {
        baseUrl: base.toString().replace(/\/$/, ""),
        api: modelApi,
        apiKey: "${OPENAI_API_KEY}",
        models: [
          {
            id: env.MODEL_ID,
            name: env.MODEL_ID,
            reasoning: env.PI_REASONING === "1",
            input: env.PI_MODEL_VISION === "0" ? ["text"] : ["text", "image"],
            contextWindow,
            maxTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify(models, null, 2),
    { mode: 0o600 },
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify(
      {
        defaultProvider: "arena",
        defaultModel: env.MODEL_ID,
        retry: { enabled: false },
        compaction,
        cacheWarming: "off",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const extras = (env.ARENA_EXTRA_EXTENSIONS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const path of extras)
    if (!isAbsolute(path))
      throw new Error("ARENA_EXTRA_EXTENSIONS paths must be absolute");
  // A mounted participant workspace resolves official dependencies through the installed toolkit.
  if (resolve(cwd) !== projectRoot)
    for (const name of ["node_modules", "examples", "packages", "docs"]) {
      const link = join(cwd, name);
      try {
        await lstat(link);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await symlink(join(projectRoot, name), link, "dir");
      }
    }
  return {
    agentDir,
    models,
    extensions: [
      extensionPath,
      join(projectRoot, "packages/world-visual/pi-extension.mjs"),
      ...extras,
    ],
  };
}

export async function launchPi({
  env = process.env,
  args = process.argv.slice(2),
  cwd = process.cwd(),
} = {}) {
  const entry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const packageRoot = resolve(dirname(entry), "..");
  const pkg = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (pkg.version !== "1.1.0")
    throw new Error(`This integration requires Pi 1.1.0; found ${pkg.version}`);
  const resident = args.length === 0;
  const waitForMatch = resident && env.ARENA_WAIT_FOR_MATCH === "1";
  const bridgeUrl = env.ARENA_BRIDGE_URL || env.MC_BRIDGE_URL;
  const token = env.ARENA_BRIDGE_TOKEN || env.MC_BRIDGE_TOKEN;
  const startTimeoutMs = positiveInteger(env.ARENA_START_TIMEOUT_MS, 600000);
  if (waitForMatch && (!bridgeUrl || !token))
    throw new Error(
      "ARENA_WAIT_FOR_MATCH requires authenticated ARENA_BRIDGE_URL and ARENA_BRIDGE_TOKEN",
    );
  const profile = await preparePiProfile({ env, cwd });
  const initialPrompt =
    env.ARENA_PROMPT ||
    "Participate in the Minecraft arena using the local bridge and your available tools. Write and run your own programs as useful. Use the participant inbox for observations and urgent judgment. Continue pursuing the arena objective until it is complete or the host ends the match.";
  const cliArgs = [
    "--provider",
    "arena",
    "--model",
    env.MODEL_ID,
    ...(args.includes("--mode") ? [] : ["--mode", resident ? "rpc" : "json"]),
    ...(args.includes("--tools") ? [] : ["--tools", "+codemode"]),
    "--append-system-prompt",
    join(projectRoot, "AGENTS.md"),
    "--skill",
    join(projectRoot, "examples/SKILL.md"),
    ...profile.extensions.flatMap((path) => ["-e", path]),
    ...args,
  ];
  const sessionDir =
    env.PI_CODING_AGENT_SESSION_DIR || join(cwd, ".pi", "sessions");
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const childEnv = {
    ...env,
    ARENA_TOOLKIT_ROOT: projectRoot,
    PI_CODING_AGENT_DIR: profile.agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    ...(resident
      ? {
          MC_INBOX_IDLE_URGENT: env.MC_INBOX_IDLE_URGENT ?? "1",
          ARENA_RUNTIME_RESIDENT: "1",
        }
      : {}),
  };
  const child = spawn(
    process.execPath,
    [join(packageRoot, "dist/bundle/cli.js"), ...cliArgs],
    {
      cwd,
      env: childEnv,
      stdio: resident ? ["pipe", "inherit", "inherit"] : "inherit",
    },
  );
  let stopping = false;
  let forceTimer;
  let killTimer;
  let matchTimer;
  let checkingMatch = false;
  let initialSent = false;
  let startupTimedOut = false;
  const startupAt = Date.now();
  const shutdown = (signal) => {
    if (stopping || child.exitCode !== null) return;
    stopping = true;
    clearInterval(matchTimer);
    if (resident) child.stdin.end();
    else child.kill(signal || "SIGTERM");
    forceTimer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    }, 5000);
  };
  const term = () => shutdown("SIGTERM");
  const interrupt = () => shutdown("SIGINT");
  process.on("SIGTERM", term);
  process.on("SIGINT", interrupt);
  if (resident) {
    child.stdin.on("error", () => {}); // Startup failure is reported by the child error/exit event.
    const sendInitial = (host) => {
      if (initialSent || stopping) return;
      initialSent = true;
      const briefing = host
        ? Object.fromEntries(
            [
              "matchId",
              "participantId",
              "teamId",
              "teams",
              "game",
              "map",
              "rules",
              "objectives",
              "publicGoalPositions",
              "briefing",
              "startedAt",
              "durationMs",
            ]
              .filter((key) => host[key] !== undefined)
              .map((key) => [key, host[key]]),
          )
        : undefined;
      const message = briefing
        ? `${initialPrompt}\n\nTrusted host match briefing (configuration data):\n${JSON.stringify(briefing)}`
        : initialPrompt;
      child.stdin.write(
        `${JSON.stringify({ id: "arena-initial-prompt", type: "prompt", message })}\n`,
      );
    };
    if (!waitForMatch) sendInitial();
    if (bridgeUrl && token) {
      const checkMatch = async () => {
        if (stopping || checkingMatch) return;
        if (!initialSent && Date.now() - startupAt >= startTimeoutMs) {
          startupTimedOut = true;
          process.stderr.write(
            "Arena start wait timed out before a running match was observed.\n",
          );
          shutdown();
          return;
        }
        checkingMatch = true;
        try {
          const response = await fetch(
            `${bridgeUrl.replace(/\/$/, "")}/v1/match`,
            {
              headers: { authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(1000),
            },
          );
          if (response.ok) {
            const body = await response.json();
            if (body.ok && body.result?.state === "ended") {
              if (!initialSent)
                process.stderr.write(
                  "Arena ended before the initial prompt was submitted.\n",
                );
              shutdown();
            } else if (
              body.ok &&
              body.result?.state === "running" &&
              !initialSent
            )
              sendInitial(body.result);
          }
        } catch {
          /* The host remains authoritative; temporary unavailability does not invent a match end. */
        } finally {
          checkingMatch = false;
        }
      };
      matchTimer = setInterval(checkMatch, 2000);
      void checkMatch();
    }
  }
  try {
    return await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        resolveExit(
          startupTimedOut ? 1 : (code ?? (signal === "SIGINT" ? 130 : 143)),
        ),
      );
    });
  } finally {
    clearInterval(matchTimer);
    clearTimeout(forceTimer);
    clearTimeout(killTimer);
    process.off("SIGTERM", term);
    process.off("SIGINT", interrupt);
    await rm(profile.agentDir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = await launchPi();
  } catch (error) {
    process.stderr.write(`Pi startup: ${error.message}\n`);
    process.exitCode = 1;
  }
}
