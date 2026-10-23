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
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  createRequestRecovery,
  observeRpcOutput,
} from "./request-recovery.mjs";
import { createSessionReader } from "./platform-messages.mjs";
import { modelRateOptions } from "./model-rate.mjs";
import {
  briefingFields,
  briefingOf,
  createSessionFiles,
  listRuleFiles,
} from "./session-files.mjs";
import {
  applyProvisionFiles,
  profileAcceptsImages,
  provisionTeammates,
  readParticipantConfig,
} from "./participant-config.mjs";
import { botNames, startMf } from "./mf-supervisor.mjs";

const extensionPath = fileURLToPath(new URL("./index.mjs", import.meta.url));
const projectRoot = resolve(dirname(extensionPath), "../..");
const positiveInteger = (value, fallback) => {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error("Runtime delays must be positive integers");
  return n;
};

/**
 * Append each system prompt file (the agents.d fragments, including the
 * arena's own participant/agents.d/10-arena.md) once, without disabling Pi's
 * own discovery of user/project context files: a file Pi already loads as a
 * context file is not appended again. The repository's root AGENTS.md is the
 * developer guide, not a participant prompt.
 */
export async function systemPromptArgs({ cwd, agentDir, args = [], files }) {
  const loaded = new Set();
  if (!args.includes("--no-context-files") && !args.includes("-nc")) {
    const { loadProjectContextFiles } =
      await import("@earendil-works/pi-coding-agent");
    // A spawned Node process reports the physical cwd, even when its caller used
    // a symlink. Match that discovery scope and compare file identity, not text.
    for (const file of loadProjectContextFiles({
      cwd: await realpath(cwd),
      agentDir,
    }))
      loaded.add(await realpath(file.path).catch(() => null));
  }
  const out = [];
  for (const file of files)
    if (!loaded.has(await realpath(file)))
      out.push("--append-system-prompt", file);
  return out;
}

/**
 * Opening prompt with the session briefing: public session fields, briefing
 * text, public data and the mode instructions, all from the login gate's session snapshot (the game server).
 * `sessionFiles` are the copies in the session directory and `ruleFiles` the
 * operator's rule files; both are listed so the model can re-read them.
 */
export function openingPromptText(
  initialPrompt,
  host,
  { sessionFiles = [], ruleFiles = [] } = {},
) {
  let message = initialPrompt;
  if (host) {
    const briefing = briefingOf(host);
    message += `\n\nSession briefing (configuration data):\n${JSON.stringify(briefingFields(host))}`;
    if (typeof briefing.text === "string" && briefing.text)
      message += `\n\nSession briefing text (from the trusted game server):\n${briefing.text}`;
    if (briefing.public && typeof briefing.public === "object")
      message += `\n\nPublic session data (from the trusted game server):\n${JSON.stringify(briefing.public)}`;
    if (typeof briefing.prompt === "string" && briefing.prompt.trim())
      message += `\n\nMode instructions (from the trusted game server; they describe this session's mode and rules):\n${briefing.prompt.trim()}`;
  }
  if (sessionFiles.length)
    message += `\n\nSession files (copies of this briefing written by the launcher; public.json is rewritten when the host changes public data; read them again when you need the exact text):\n${sessionFiles.join("\n")}`;
  if (ruleFiles.length)
    message += `\n\nRule files from the operator (read-only):\n${ruleFiles.join("\n")}`;
  return message;
}

/**
 * Model access for Pi. With OPENAI_BASE_URL, write a private Pi profile whose
 * one provider, `arena`, points at that endpoint (usually the model relay) and
 * whose model comes from ARENA_MODEL_CONFIG; the key is stored as the reference
 * `${OPENAI_API_KEY}`, never its value. Without OPENAI_BASE_URL, Pi runs on the
 * operator's own profile (PI_CODING_AGENT_DIR, else ~/.pi/agent) unchanged:
 * provider logins, API keys and settings are whatever the operator put there.
 */
async function modelProfile({ env, directory, cwd }) {
  const limited = modelRateOptions(env);
  if (!env.OPENAI_BASE_URL) {
    if (env.ARENA_MODEL_CONFIG)
      throw new Error(
        "ARENA_MODEL_CONFIG describes the model behind OPENAI_BASE_URL; set both, or neither to use the Pi profile as configured",
      );
    return {
      agentDir: env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
      generated: false,
    };
  }
  if (!env.ARENA_MODEL_CONFIG)
    throw new Error(
      "OPENAI_BASE_URL needs ARENA_MODEL_CONFIG, the model served there",
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
      "OPENAI_BASE_URL must be an HTTP(S) URL without embedded credentials, query or fragment",
    );
  const model = JSON.parse(
    await readFile(resolve(cwd, env.ARENA_MODEL_CONFIG), "utf8"),
  );
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  if (
    typeof model.id !== "string" ||
    !model.id ||
    typeof model.api !== "string" ||
    !model.api ||
    !positive(model.contextWindow) ||
    !positive(model.maxOutputTokens)
  )
    throw new Error(
      "ARENA_MODEL_CONFIG needs id and api strings and positive integer contextWindow and maxOutputTokens",
    );
  const price = (value) => typeof value === "number" && value >= 0;
  const cost = model.cost ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  if (
    !["input", "output", "cacheRead", "cacheWrite"].every((key) =>
      price(cost[key]),
    )
  )
    throw new Error(
      "ARENA_MODEL_CONFIG cost needs input, output, cacheRead and cacheWrite (USD per million tokens)",
    );
  if (limited && !(cost.input > 0 || cost.output > 0))
    throw new Error(
      "ARENA_COST_PER_HOUR needs list prices: add cost to ARENA_MODEL_CONFIG",
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
  if (maxTokens >= contextWindow)
    throw new Error(
      "ARENA_MODEL_CONFIG maxOutputTokens must be smaller than contextWindow",
    );
  if (
    typeof compaction.enabled !== "boolean" ||
    !positive(compaction.reserveTokens) ||
    !Number.isSafeInteger(compaction.keepRecentTokens) ||
    compaction.keepRecentTokens < 0 ||
    compaction.reserveTokens + compaction.keepRecentTokens >= contextWindow
  )
    throw new Error(
      "ARENA_MODEL_CONFIG compaction needs a boolean enabled, positive integer reserveTokens, nonnegative integer keepRecentTokens, and room for history within contextWindow",
    );
  if (compaction.enabled && compaction.reserveTokens < maxTokens)
    throw new Error(
      "ARENA_MODEL_CONFIG compaction.reserveTokens must cover maxOutputTokens",
    );
  const agentDir = directory || (await mkdtemp(join(tmpdir(), "arena-pi-")));
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const models = {
    providers: {
      arena: {
        baseUrl: base.toString().replace(/\/$/, ""),
        api: model.api,
        // A relay that holds the real key ignores this one.
        apiKey: env.OPENAI_API_KEY ? "${OPENAI_API_KEY}" : "unused",
        models: [
          {
            id: model.id,
            name: model.id,
            reasoning: model.reasoning ?? false,
            input: model.input ?? ["text", "image"],
            contextWindow,
            maxTokens,
            cost: {
              input: cost.input,
              output: cost.output,
              cacheRead: cost.cacheRead,
              cacheWrite: cost.cacheWrite,
            },
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
  return { agentDir, generated: true, modelId: model.id, models };
}

/** Model access plus the arena extensions and toolkit links in the workspace. */
export async function preparePiProfile({
  env = process.env,
  directory,
  cwd = process.cwd(),
} = {}) {
  const profile = await modelProfile({ env, directory, cwd });
  const extras = (env.ARENA_EXTRA_EXTENSIONS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  // A mounted participant workspace resolves official dependencies through the installed toolkit.
  if (resolve(cwd) !== projectRoot)
    for (const name of [
      "node_modules",
      "examples",
      "participant",
      "packages",
      "docs",
    ]) {
      const link = join(cwd, name);
      try {
        await lstat(link);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await symlink(join(projectRoot, name), link, "dir");
      }
    }
  return { ...profile, extensions: [extensionPath, ...extras] };
}

async function launchPi({
  env = process.env,
  args = process.argv.slice(2),
  cwd = process.cwd(),
} = {}) {
  const entry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const packageRoot = resolve(dirname(entry), "..");
  const resident = args.length === 0;
  // This container runs its own characters, under the toolkit's `mf`.
  const native = Boolean(env.ARENA_MINECRAFT_HOST);
  let hosts;
  // The first character names the session the login gate reports.
  if (native) env = { ...env, ARENA_BOT: (await botNames(env))[0] };
  const sessionUrl =
    env.ARENA_SESSION_URL && env.ARENA_BOT
      ? `${env.ARENA_SESSION_URL}${env.ARENA_SESSION_URL.includes("?") ? "&" : "?"}username=${encodeURIComponent(env.ARENA_BOT)}`
      : undefined;
  // Wait for the gate's authoritative session before sending the opening prompt.
  const waitForMatch = resident && Boolean(sessionUrl);
  const startTimeoutMs = positiveInteger(env.ARENA_START_TIMEOUT_MS, 600000);
  const profile = await preparePiProfile({ env, cwd });
  const sessionDir =
    env.PI_CODING_AGENT_SESSION_DIR || join(cwd, ".pi", "sessions");
  // Copies of the trusted briefing for the model to re-read after compaction.
  const ownSessionFilesDir = resident && !env.ARENA_SESSION_DIR;
  let guidanceArgs, sessionFiles, config, teammates;
  try {
    await applyProvisionFiles(env.ARENA_PROVISION_DIR, { workspace: cwd });
    teammates = await provisionTeammates(env.ARENA_PROVISION_DIR);
    config = await readParticipantConfig(env.ARENA_CONFIG_DIR, {
      env,
      builtinAgentsDir: [
        join(projectRoot, "participant", "agents.d"),
        // The character runs in this container: in-process runs, fair play.
        ...(native
          ? [join(projectRoot, "participant", "agents.native.d")]
          : []),
      ],
    });
    guidanceArgs = await systemPromptArgs({
      cwd,
      agentDir: profile.agentDir,
      args,
      files: config.systemPromptFiles,
    });
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    sessionFiles = resident
      ? createSessionFiles({
          directory:
            env.ARENA_SESSION_DIR ||
            (await mkdtemp(join(tmpdir(), "arena-session-"))),
        })
      : undefined;
    if (native) {
      hosts = await startMf({
        env,
        cwd,
        defaultScripts: config.defaultScripts,
      });
      env = { ...env, ...hosts.env };
    }
  } catch (error) {
    // The exit cleanup below is not reached yet; drop the generated profile.
    hosts?.close();
    if (profile.generated)
      await rm(profile.agentDir, { recursive: true, force: true });
    throw error;
  }
  const initialPrompt =
    config.firstMessage ||
    env.ARENA_PROMPT ||
    "Play the Minecraft session by writing Node programs and running them with bash, as your system prompt describes. Reports from your programs and the default scripts reach you as inbox reports. Follow the session briefing if there is one, and keep going until its goal is complete or the session ends.";
  const cliArgs = [
    ...(profile.generated
      ? ["--provider", "arena", "--model", profile.modelId]
      : []),
    ...(args.includes("--mode") ? [] : ["--mode", resident ? "rpc" : "json"]),
    ...guidanceArgs,
    "--skill",
    join(projectRoot, "participant/skills"),
    // Team work only matters with teammates; a team of one does not see it.
    ...(teammates.length
      ? ["--skill", join(projectRoot, "participant/skills-team")]
      : []),
    ...(config.skillsDir ? ["--skill", config.skillsDir] : []),
    ...profile.extensions.flatMap((path) => ["-e", path]),
    ...args,
  ];
  const childEnv = {
    ...env,
    ARENA_TOOLKIT_ROOT: projectRoot,
    PI_OFFLINE: "1", // Capabilities and extensions are installed locally; skip unrelated startup network.
    ...(profile.generated ? { PI_CODING_AGENT_DIR: profile.agentDir } : {}),
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    ...(sessionFiles ? { ARENA_SESSION_DIR: sessionFiles.directory } : {}),
  };
  let images = config.images;
  if (images.length && !profileAcceptsImages(profile)) {
    process.stderr.write(
      `Config images: the model does not declare image input; ${images.length} image(s) not sent\n`,
    );
    images = [];
  }
  const child = spawn(
    process.execPath,
    [join(packageRoot, "dist/bundle/cli.js"), ...cliArgs],
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
  let startupTimedOut = false;
  let runtimeFailed = false;
  let recovery;
  let detachRpc;
  const startupAt = Date.now();
  const shutdown = (signal) => {
    if (stopping || child.exitCode !== null) return;
    stopping = true;
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
    // Shared validated reader of the login gate's read-only session endpoint.
    const readSession = createSessionReader({
      url: sessionUrl,
      cacheMs: 0,
      timeoutMs: 1000,
    });
    if (sessionUrl) {
      recovery = createRequestRecovery({
        send(command) {
          if (stopping || child.stdin.destroyed)
            throw new Error("Resident RPC input unavailable");
          child.stdin.write(`${JSON.stringify(command)}\n`);
        },
        async getSessionState() {
          const host = await readSession();
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
      detachRpc = observeRpcOutput(
        child.stdout,
        (event) => recovery.receive(event),
        undefined,
        (error) => {
          process.stderr.write(`Arena RPC handler failed: ${error.message}\n`);
          runtimeFailed = true;
          shutdown();
        },
      );
    }
    child.stdout.pipe(process.stdout, { end: false });
    const sendInitial = async (host) => {
      if (initialSent || stopping) return;
      initialSent = true;
      if (host) {
        const fresh = await readSession();
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
      let written = [];
      if (host)
        written = await sessionFiles.write(host).catch((error) => {
          process.stderr.write(`Session files: ${error.message}\n`);
          return [];
        });
      const ruleFiles = await listRuleFiles(env.ARENA_RULES_DIR).catch(
        (error) => {
          process.stderr.write(`Rule files: ${error.message}\n`);
          return [];
        },
      );
      if (stopping) return;
      const message = openingPromptText(initialPrompt, host, {
        sessionFiles: written,
        ruleFiles,
      });
      child.stdin.write(
        `${JSON.stringify({
          id: "arena-initial-prompt",
          type: "prompt",
          message,
          ...(images.length ? { images } : {}),
        })}\n`,
      );
    };
    if (!waitForMatch) {
      // Matches without the wait start at once with no briefing, as before. An
      // open session is already running, so include its briefing when the
      // login gate answers promptly.
      if (sessionUrl)
        readSession()
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
    if (sessionUrl) {
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
          const host = await readSession();
          if (host) {
            if (host.state === "ended") {
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
            else if (host.state === "running" && initialSent)
              await sessionFiles.updatePublic(host).catch((error) => {
                process.stderr.write(`Session files: ${error.message}\n`);
              });
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
    hosts?.close();
    recovery?.close();
    detachRpc?.();
    clearInterval(matchTimer);
    clearTimeout(forceTimer);
    clearTimeout(killTimer);
    process.off("SIGTERM", term);
    process.off("SIGINT", interrupt);
    if (profile.generated)
      await rm(profile.agentDir, { recursive: true, force: true });
    if (ownSessionFilesDir)
      await rm(sessionFiles.directory, { recursive: true, force: true });
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
