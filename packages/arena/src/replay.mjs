import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
export function validateReplay(config) {
  const replay = config.live?.replay;
  if (
    replay !== undefined &&
    (!replay || typeof replay !== "object" || Array.isArray(replay))
  )
    throw new Error("live.replay must be an object");
  if (replay?.enabled !== undefined && typeof replay.enabled !== "boolean")
    throw new Error("live.replay.enabled must be boolean");
  if (replay?.enabled === false) return;
  if (
    config.participants.some(
      (p) => !/^[A-Za-z0-9_]{1,16}$/.test(p.username ?? ""),
    ) ||
    new Set(config.participants.map((p) => p.username)).size !==
      config.participants.length
  )
    throw new Error("Replay requires unique Minecraft participant usernames");
  for (const key of ["configPath", "serverResultsDir"])
    if (
      replay?.[key] !== undefined &&
      (typeof replay[key] !== "string" || !replay[key])
    )
      throw new Error(`live.replay.${key} must be a path`);
  if (
    replay?.saveTimeoutMs !== undefined &&
    (!Number.isSafeInteger(replay.saveTimeoutMs) || replay.saveTimeoutMs <= 0)
  )
    throw new Error("live.replay.saveTimeoutMs must be a positive integer");
}

/** Read basic ZIP/ReplayMod metadata; deep verification is an operator-only opt-in. */
export async function inspectReplay(
  path,
  minecraftVersion,
  { signal, verify = false } = {},
) {
  const { stdout: listing } = await exec("unzip", ["-Z1", path], { signal });
  const entries = listing.trim().split(/\r?\n/);
  for (const required of ["metaData.json", "recording.tmcpr"])
    if (!entries.includes(required))
      throw new Error(`Replay missing ${required}`);
  const { stdout } = await exec("unzip", ["-p", path, "metaData.json"], {
    signal,
  });
  const metadata = JSON.parse(stdout);
  if (
    metadata.mcversion !== minecraftVersion ||
    !/^ServerReplay v/.test(metadata.generator ?? "") ||
    !Number.isFinite(metadata.duration) ||
    metadata.duration < 0
  )
    throw new Error(
      "Replay metadata does not match the configured Minecraft server",
    );
  const { size } = await stat(path);
  const result = {
    bytes: size,
    durationMs: metadata.duration,
    minecraftVersion: metadata.mcversion,
    generator: metadata.generator,
  };
  if (!verify) return result;
  await exec("unzip", ["-tqq", path], { signal });
  // Drain packet bytes without buffering a potentially multi-gigabyte recording.
  const packetBytes = await new Promise((resolve, reject) => {
    const child = spawn("unzip", ["-p", path, "recording.tmcpr"], {
      stdio: ["ignore", "pipe", "ignore"],
      signal,
    });
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(bytes)
        : reject(new Error("Could not read replay packets")),
    );
  });
  if (!packetBytes) throw new Error("Replay packet recording is empty");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal }))
    hash.update(chunk);
  return { ...result, packetBytes, sha256: hash.digest("hex") };
}

/** Trusted-only recorder controller, using the same results/runs/<runId> archive. */
export function createReplayRecorder({
  config,
  runId,
  resultDir,
  rcon,
  inspect = inspectReplay,
}) {
  const options = config.live.replay ?? {};
  const enabled = options.enabled !== false;
  const relativeDir = posix.join("runs", runId, "replays");
  const directory = resolve(resultDir, relativeDir);
  const serverDirectory = posix.join(
    options.serverResultsDir ?? "/results",
    relativeDir,
  );
  const configPath = options.configPath ?? "/replay-config/config.json";
  const state = {
    enabled,
    status: enabled ? "pending" : "disabled",
    files: [],
  };
  let startAttempted = false;
  let stopRequested = false;
  let startError;
  const command = async (text, expect) => {
    const response = await rcon.command(text);
    if (!expect.test(response))
      throw new Error(`ServerReplay acknowledgement mismatch: ${text}`);
  };
  const failed = (error) => {
    state.status = "failed";
    state.error = error.message;
  };
  async function scan() {
    const files = [];
    let pending = false;
    for (const participant of config.participants) {
      const folder = join(directory, participant.username);
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") {
          if (!startError) pending = true;
          continue;
        }
        throw error;
      }
      const archives = entries.filter(
        (entry) => entry.isFile() && entry.name.endsWith(".mcpr"),
      );
      if (!archives.length && !startError) pending = true;
      // ReplayStudio removes its .cache only after final ZIP close.
      if (entries.some((entry) => entry.name.endsWith(".cache")))
        pending = true;
      for (const entry of archives)
        files.push({
          participantId: participant.id,
          username: participant.username,
          path: posix.join(relativeDir, participant.username, entry.name),
        });
    }
    return { files, pending };
  }
  return {
    state,
    async prepare() {
      if (!enabled) return;
      try {
        // Dedicated match server: stop stale/manual recorders before changing paths.
        await command(
          "replay disable",
          /ServerReplay is (?:now disabled! Stopped all recordings\.|already disabled!)/,
        );
        await command(
          "replay stop all",
          /Successfully stopped all recordings\./,
        );
        await mkdir(dirname(directory), { recursive: true });
        await mkdir(directory); // Refuse to mingle recordings from reused run IDs.
        await mkdir(dirname(configPath), { recursive: true });
        let existing = {};
        try {
          existing = JSON.parse(await readFile(configPath, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const replayConfig = {
          ...existing,
          enabled: false,
          world_name: config.map.id,
          server_name: `Craft Arena ${config.id} ${runId}`,
          player_recording_path: serverDirectory,
          player_recording_name: "{username}",
          player_predicate: {
            type: "has_name",
            names: config.participants.map((p) => p.username),
          },
          chunks: [],
          allow_downloading_replays: false,
          record_voice_chat: false,
          ignore_light_packets: false,
          max_file_size: "0GB",
          max_duration: "0s",
          include_compressed_in_status: false,
        };
        const temporary = `${configPath}.${runId}.tmp`;
        await writeFile(temporary, JSON.stringify(replayConfig, null, 2));
        await rename(temporary, configPath);
        await command("replay reload", /Successfully reloaded config\./);
        state.status = "ready";
        state.directory = relativeDir;
      } catch (error) {
        failed(error);
        throw error;
      }
    },
    async start() {
      if (!enabled) return;
      startAttempted = true;
      state.startRequested = true;
      try {
        // Keep the global auto-record flag false even through server autosaves.
        // This host ends on disconnect, so it does not need auto-rejoin recording.
        for (const { username } of config.participants) {
          await command(
            `replay start players ${username}`,
            /Successfully started 1 recordings/,
          );
          await command(
            `replay marker add players ${username} "arena:${runId}:start"`,
            /Successfully marked 1 recordings/,
          );
        }
        state.status = "recording";
      } catch (error) {
        startError = error;
        failed(error);
        throw error;
      }
    },
    async requestStop() {
      if (!enabled || !startAttempted || stopRequested) return;
      stopRequested = true;
      const errors = [];
      for (const [text, expect] of [
        [
          "replay disable",
          /ServerReplay is (?:now disabled! Stopped all recordings\.|already disabled!)/,
        ],
        ["replay stop all", /Successfully stopped all recordings\./],
      ]) {
        try {
          await command(text, expect);
        } catch (error) {
          errors.push(error.message);
        }
      }
      if (errors.length) failed(new Error(errors.join("; ")));
      else state.status = "saving";
    },
    async finish() {
      if (!enabled || !startAttempted) return;
      if (state.status === "failed") return;
      try {
        const deadline = Date.now() + (options.saveTimeoutMs ?? 120000);
        let snapshot;
        do {
          snapshot = await scan();
          if (!snapshot.pending) break;
          if (Date.now() >= deadline)
            throw new Error(
              "ServerReplay save timed out; keep Minecraft running and inspect this run's replay files/caches before reset",
            );
          await delay(100);
        } while (true);
        for (const file of snapshot.files) {
          const path = resolve(resultDir, file.path);
          state.files.push({
            ...file,
            ...(await inspect(path, config.live.minecraft.version, {
              signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
            })),
          });
        }
        if (startError) throw startError;
        state.status = "saved";
      } catch (error) {
        failed(error);
      }
    },
  };
}
