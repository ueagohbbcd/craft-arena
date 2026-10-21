#!/usr/bin/env node
import { createCompatibleBot } from "./minecraft-compat.mjs";
import { attachWorldMemory } from "./world-memory.mjs";
import { resolve } from "node:path";
import { startRunner } from "./runner.mjs";
import { sessionObject } from "./session.mjs";

const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};
const username = required("MF_USERNAME");
const sessionUrl = process.env.ARENA_SESSION_URL
  ? `${process.env.ARENA_SESSION_URL}${process.env.ARENA_SESSION_URL.includes("?") ? "&" : "?"}username=${encodeURIComponent(username)}`
  : null;
const bot = createCompatibleBot({
  host: required("ARENA_MINECRAFT_HOST"),
  port: Number(process.env.ARENA_MINECRAFT_PORT ?? 25565),
  version: process.env.MC_VERSION ?? "1.21.1",
  username,
  auth: process.env.MF_AUTH ?? "offline",
  ...(process.env.MF_AUTH === "microsoft" && process.env.MF_PROFILES_DIR
    ? { profilesFolder: resolve(process.env.MF_PROFILES_DIR) }
    : {}),
});

let session;
let sessionFailure;
async function readSession() {
  if (!sessionUrl) {
    const now = Date.now();
    return sessionObject({
      kind: "open",
      state: "running",
      sessionId: `open-${now}`,
      participantId: bot.username ?? username,
      username: bot.username ?? username,
      participants: [
        {
          id: bot.username ?? username,
          username: bot.username ?? username,
          teamId: null,
        },
      ],
      now,
    });
  }
  const response = await fetch(sessionUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(3000),
  });
  const body = await response.json();
  if (!response.ok || !body?.ok || !body.result)
    throw new Error(`Session read failed: ${response.status}`);
  return body.result;
}
bot.getSessionState = async () => {
  if (session) return session;
  return readSession();
};

let runner;
let memory;
let closing = false;
const stop = async (code = 0) => {
  if (closing) return;
  closing = true;
  try {
    await runner?.close();
  } catch {}
  try {
    await memory?.dispose();
  } catch {}
  try {
    bot.quit("Bot host stopping");
  } catch {}
  process.exitCode = code;
};

bot.once("spawn", async () => {
  try {
    memory = await attachWorldMemory(bot, process.env);
    if (sessionUrl) {
      try {
        session = await readSession();
      } catch (error) {
        sessionFailure = error;
      }
      const pollMs = Number(process.env.ARENA_SESSION_POLL_MS ?? 1000);
      setInterval(async () => {
        try {
          const previous = session;
          session = await readSession();
          sessionFailure = undefined;
          if (previous?.state === "running" && session.state !== "running") {
            bot.clearControlStates?.();
            bot.pathfinder?.stop?.();
            bot.pvp?.stop?.();
          }
        } catch (error) {
          sessionFailure = error;
        }
      }, pollMs).unref();
    }
    runner = await startRunner({
      bot,
      socketPath: required("ARENA_RUN_SOCKET"),
      readSession: async () => session ?? readSession(),
      cancellationGraceMs: Number(process.env.ARENA_CANCEL_GRACE_MS ?? 5000),
    });
    process.stdout.write(`Bot host ready: ${bot.username}\n`);
  } catch (error) {
    process.stderr.write(`Bot host startup failed: ${error.stack ?? error}\n`);
    await stop(1);
  }
});
bot.on("end", () => {
  if (!closing) void stop(1);
});
bot.on("error", (error) =>
  process.stderr.write(`Minecraft bot: ${error.message}\n`),
);
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
