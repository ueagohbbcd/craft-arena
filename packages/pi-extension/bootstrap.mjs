#!/usr/bin/env node
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  lstat,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  createRequestRecovery,
  observeRpcOutput,
} from "./request-recovery.mjs";
import { createOpeningViews } from "./opening-views.mjs";
import { createMatchReader } from "./platform-messages.mjs";

const extensionPath = fileURLToPath(new URL("./index.mjs", import.meta.url));
const projectRoot = resolve(dirname(extensionPath), "../..");
const positiveInteger = (value, fallback) => {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error("Runtime delays must be positive integers");
  return n;
};

/**
 * Append the participant prompt (examples/PROMPT.md) once, without disabling
 * Pi's own discovery of user/project context files. The repository's root
 * AGENTS.md is the developer guide, not this prompt.
 */
export async function arenaGuidanceArgs({ cwd, agentDir, args = [] }) {
  const guidance = join(projectRoot, "examples", "PROMPT.md");
  if (!args.includes("--no-context-files") && !args.includes("-nc")) {
    const { loadProjectContextFiles } =
      await import("@earendil-works/pi-coding-agent");
    // A spawned Node process reports the physical cwd, even when its caller used
    // a symlink. Match that discovery scope and compare file identity, not text.
    const files = loadProjectContextFiles({
      cwd: await realpath(cwd),
      agentDir,
    });
    const target = await realpath(guidance);
    for (const file of files)
      if ((await realpath(file.path).catch(() => null)) === target) return [];
  }
  return ["--append-system-prompt", guidance];
}

const briefingKeys = [
  "kind",
  "sessionId",
  "matchId",
  "participantId",
  "teamId",
  "username",
  "teams",
  "game",
  "map",
  "rules",
  "objectives",
  "publicGoalPositions",
  "startedAt",
  "durationMs",
];

/**
 * Opening prompt with the session briefing: public session fields, briefing
 * text, public data and the mode instructions, all from the trusted host.
 * A legacy host sends `briefing` as a plain string; treat it as the text.
 */
export function openingPromptText(initialPrompt, host) {
  if (!host) return initialPrompt;
  const fields = Object.fromEntries(
    briefingKeys
      .filter((key) => host[key] !== undefined)
      .map((key) => [key, host[key]]),
  );
  const briefing =
    typeof host.briefing === "string"
      ? { text: host.briefing }
      : host.briefing && typeof host.briefing === "object"
        ? host.briefing
        : {};
  let message = `${initialPrompt}\n\nTrusted host session briefing (configuration data):\n${JSON.stringify(fields)}`;
  if (typeof briefing.text === "string" && briefing.text)
    message += `\n\nSession briefing text (from the trusted session host):\n${briefing.text}`;
  if (briefing.public && typeof briefing.public === "object")
    message += `\n\nPublic session data (from the trusted session host):\n${JSON.stringify(briefing.public)}`;
  if (typeof briefing.prompt === "string" && briefing.prompt.trim())
    message += `\n\nMode instructions (from the trusted session host; they describe this session's mode and rules):\n${briefing.prompt.trim()}`;
  return message;
}

/** Generate a private Pi profile containing an environment reference, never the bearer token. */
export async function preparePiProfile({
  env = process.env,
  directory,
  cwd = process.cwd(),
} = {}) {
  if (!env.ARENA_MODEL_CONFIG || !env.OPENAI_BASE_URL || !env.OPENAI_API_KEY)
    throw new Error(
      "ARENA_MODEL_CONFIG, OPENAI_BASE_URL, and participant-scoped OPENAI_API_KEY are required",
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
  // The gateway and Pi read the same public capability description. Pi validates
  // its generated model profile; do not duplicate its capability policy here.
  const model = JSON.parse(
    await readFile(resolve(cwd, env.ARENA_MODEL_CONFIG), "utf8"),
  );
  const { contextWindow, maxOutputTokens: maxTokens } = model;
  const compaction = {
    enabled: true,
    reserveTokens: Math.min(
      Math.floor(contextWindow / 2),
      Math.max(maxTokens * 2, Math.floor(contextWindow / 4)),
    ),
    keepRecentTokens: Math.floor(contextWindow / 4),
    ...model.compaction,
  };
  const agentDir = directory || (await mkdtemp(join(tmpdir(), "arena-pi-")));
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const models = {
    providers: {
      arena: {
        baseUrl: base.toString().replace(/\/$/, ""),
        api: model.api,
        apiKey: "${OPENAI_API_KEY}",
        models: [
          {
            id: model.id,
            name: model.id,
            reasoning: model.reasoning ?? false,
            input: model.input ?? ["text", "image"],
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
        defaultModel: model.id,
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
    modelId: model.id,
    models,
    extensions: [extensionPath, ...extras],
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
  const resident = args.length === 0;
  const waitForMatch = resident && env.ARENA_WAIT_FOR_MATCH === "1";
  const bridgeUrl = env.ARENA_BRIDGE_URL;
  const token = env.ARENA_BRIDGE_TOKEN;
  const startTimeoutMs = positiveInteger(env.ARENA_START_TIMEOUT_MS, 600000);
  if (waitForMatch && (!bridgeUrl || !token))
    throw new Error(
      "ARENA_WAIT_FOR_MATCH requires authenticated ARENA_BRIDGE_URL and ARENA_BRIDGE_TOKEN",
    );
  const profile = await preparePiProfile({ env, cwd });
  const guidanceArgs = await arenaGuidanceArgs({
    cwd,
    agentDir: profile.agentDir,
    args,
  });
  const initialPrompt =
    env.ARENA_PROMPT ||
    "Participate in the Minecraft session using the local bridge and your available tools. Write and run your own programs as useful. Use the participant inbox for observations and urgent judgment. Follow the session briefing and keep going until its goal is complete or the host ends the session.";
  const cliArgs = [
    "--provider",
    "arena",
    "--model",
    profile.modelId,
    ...(args.includes("--mode") ? [] : ["--mode", resident ? "rpc" : "json"]),
    ...guidanceArgs,
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
    PI_OFFLINE: "1", // Capabilities and extensions are installed locally; skip unrelated startup network.
    PI_CODING_AGENT_DIR: profile.agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    ...(resident
      ? {
          ARENA_WAKE_ON_URGENT: env.ARENA_WAKE_ON_URGENT ?? "1",
          ARENA_CONTINUOUS_SESSION: "1",
        }
      : {}),
  };
  const child = spawn(
    process.execPath,
    [
      "--import",
      new URL("./gateway-transport.mjs", import.meta.url).href,
      join(packageRoot, "dist/bundle/cli.js"),
      ...cliArgs,
    ],
    {
      cwd,
      env: childEnv,
      stdio: resident ? ["pipe", "pipe", "inherit"] : "inherit",
    },
  );
  let stopping = false;
  let forceTimer;
  let killTimer;
  let matchTimer;
  let checkingMatch = false;
  let initialSent = false;
  // Without the wait, the first prompt is already on its way; the poll must not send it.
  let initialQueued = !waitForMatch;
  let preparedOpening;
  let openingPrepared = false;
  let pendingCourseView;
  let startupTimedOut = false;
  let runtimeFailed = false;
  let recovery;
  let detachRpc;
  const openingViews = createOpeningViews({
    url: bridgeUrl,
    token,
    report: (message) => process.stderr.write(`${message}\n`),
  });
  const startupAt = Date.now();
  const shutdown = (signal) => {
    if (stopping || child.exitCode !== null) return;
    stopping = true;
    openingViews.close();
    recovery?.close();
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
    // Shared validated reader: /v1/session with the /v1/match fallback.
    const readMatch = createMatchReader({
      url: bridgeUrl,
      token,
      cacheMs: 0,
      timeoutMs: 1000,
    });
    if (bridgeUrl && token) {
      recovery = createRequestRecovery({
        send(command) {
          if (stopping || child.stdin.destroyed)
            throw new Error("Resident RPC input unavailable");
          child.stdin.write(`${JSON.stringify(command)}\n`);
        },
        async getMatchState() {
          const host = await readMatch();
          if (host?.state === "ended") shutdown();
          return host?.state;
        },
        report(message) {
          process.stderr.write(`${message}\n`);
        },
        onFatal() {
          runtimeFailed = true;
          shutdown();
        },
        retryDelayMs: positiveInteger(env.ARENA_RETRY_DELAY_MS, 2000),
        maxRetryDelayMs: positiveInteger(env.ARENA_RETRY_MAX_DELAY_MS, 60000),
      });
      detachRpc = observeRpcOutput(child.stdout, (event) =>
        recovery.receive(event),
      );
    }
    child.stdout.pipe(process.stdout, { end: false });
    const sendInitial = async (host) => {
      if (initialSent || stopping) return;
      initialSent = true;
      let message = openingPromptText(initialPrompt, host);
      const view = openingPrepared
        ? preparedOpening
        : await openingViews.capture(host, true);
      if (host) {
        preparedOpening = view;
        openingPrepared = true;
        const fresh = await readMatch();
        if (fresh?.state === "ended") {
          shutdown();
          return;
        }
        if (fresh?.state !== "running") {
          initialSent = false;
          return;
        }
      }
      if (stopping) return;
      if (view) message += `\n\n${view.message}`;
      child.stdin.write(
        `${JSON.stringify({ id: "arena-initial-prompt", type: "prompt", message, images: view?.images })}\n`,
      );
    };
    if (!waitForMatch) {
      // Matches without the wait start at once with no briefing, as before. An
      // open session is already running, so include its briefing when the
      // bridge answers promptly.
      if (bridgeUrl && token)
        readMatch()
          .then((host) =>
            sendInitial(
              host?.kind === "open" && host.state === "running"
                ? host
                : undefined,
            ),
          )
          .finally(() => {
            initialQueued = false;
          });
      else sendInitial();
    }
    if (bridgeUrl && token) {
      const checkMatch = async () => {
        if (stopping || checkingMatch) return;
        if (!initialSent && Date.now() - startupAt >= startTimeoutMs) {
          startupTimedOut = true;
          process.stderr.write(
            "Arena start wait timed out before a running session was observed.\n",
          );
          shutdown();
          return;
        }
        checkingMatch = true;
        try {
          const host = await readMatch();
          if (host) {
            if (
              host.state === "prepared" &&
              host.openingViews &&
              !openingPrepared
            ) {
              preparedOpening = await openingViews.capture(host, true);
              openingPrepared = true;
            } else if (host.state === "ended") {
              if (!initialSent)
                process.stderr.write(
                  "Arena ended before the initial prompt was submitted.\n",
                );
              shutdown();
            } else if (
              host.state === "running" &&
              !initialSent &&
              !initialQueued
            )
              await sendInitial(host);
            else if (host.state === "running" && initialSent) {
              pendingCourseView ??= await openingViews.capture(host);
              if (
                pendingCourseView &&
                !stopping &&
                (await readMatch())?.state === "running"
              ) {
                child.stdin.write(
                  `${JSON.stringify({
                    id: "arena-course-view",
                    type: "prompt",
                    streamingBehavior: "steer",
                    ...pendingCourseView,
                  })}\n`,
                );
                pendingCourseView = undefined;
              }
            }
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
          startupTimedOut || runtimeFailed
            ? 1
            : (code ?? (signal === "SIGINT" ? 130 : 143)),
        ),
      );
    });
  } finally {
    openingViews.close();
    recovery?.close();
    detachRpc?.();
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
