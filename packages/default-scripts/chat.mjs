#!/usr/bin/env node
// Default chat listener. The runtime starts this ordinary script at session
// start; it forwards in-game chat to the inbox. Stop it with task_cancel, or
// run your own copy to filter or summarize chat differently.
// ARENA_CHAT_WAKE=mention|all posts matching chat as urgent, which wakes an
// idle model; the default (none) never wakes it.
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
// Resolve the toolkit from ARENA_TOOLKIT_ROOT so a copy saved in your working
// directory still runs; fall back to this file's own location.
const toolkit = (path) =>
  process.env.ARENA_TOOLKIT_ROOT
    ? pathToFileURL(`${process.env.ARENA_TOOLKIT_ROOT}/${path}`).href
    : new URL(`../../${path}`, import.meta.url).href;
const { InboxClient } = await import(toolkit("packages/inbox/index.mjs"));

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a chat line should wake the model. `mention`: the text names the bot
 * (case-insensitive, whole word) or is a whisper to it; `all`: any line. The
 * bot's own chat and whispers never wake.
 */
export function chatWakes(text, { mode = "none", username } = {}) {
  if (mode !== "mention" && mode !== "all") return false;
  const name =
    typeof username === "string" && username ? escape(username) : null;
  // Outgoing whispers ("You whisper to x: ...") are always the bot's own.
  if (/^You whisper to /i.test(text)) return false;
  // Vanilla "<name> text" and "[name -> x]" are the bot's own chat.
  if (name && new RegExp(`^(?:<${name}>|\\[${name} -> )`, "i").test(text))
    return false;
  if (mode === "all") return true;
  if (!name) return false;
  // Vanilla "x whispers to you: ..." and the common "[x -> me] ..." format.
  if (
    /^\S+ whispers to you:? /i.test(text) ||
    new RegExp(`^\\[\\S+ -> (?:me|${name})\\]`, "i").test(text)
  )
    return true;
  return new RegExp(`(?<![\\w])${name}(?![\\w])`, "i").test(text);
}

/** Username of this bot from the session, or undefined when unavailable. */
async function sessionUsername(url, token, signal) {
  for (const path of ["/v1/session", "/v1/match"]) {
    const response = await fetch(`${url.replace(/\/$/, "")}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const { result } = await response.json();
    if (typeof result?.username === "string" && result.username)
      return result.username;
    const self = Array.isArray(result?.participants)
      ? result.participants.find((p) => p?.id === result.participantId)
      : undefined;
    return typeof self?.username === "string" ? self.username : undefined;
  }
  return undefined;
}

/** Chat only: no world mirror or action calls; wakes the model only when asked. */
export function startChatForwarder({
  url = process.env.ARENA_BRIDGE_URL,
  token = process.env.ARENA_BRIDGE_TOKEN,
  inbox,
  retryMs = 1000,
  wake = process.env.ARENA_CHAT_WAKE || "none",
  username = process.env.ARENA_CHAT_USERNAME || undefined,
}) {
  if (!["none", "mention", "all"].includes(wake))
    throw new Error("ARENA_CHAT_WAKE must be none, mention or all");
  const controller = new AbortController();
  const { signal } = controller;
  // The session names this bot; the env value is used until (or unless) it answers.
  let sessionName;
  let sessionRead = false;
  const learnUsername = async () => {
    if (wake === "none" || sessionRead) return;
    try {
      sessionName = await sessionUsername(url, token, signal);
      sessionRead = true;
    } catch {
      /* Retried on the next reconnect. */
    }
  };
  function accept(frame) {
    const payload = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!payload) return;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (
      signal.aborted ||
      event.type !== "event" ||
      event.data?.name !== "messagestr"
    )
      return;
    const args = event.data.args;
    if (!Array.isArray(args) || typeof args[0] !== "string") return;
    if (args[1] === "game_info") return;
    const metadata = args[5] ?? {};
    const urgent = chatWakes(args[0], {
      mode: wake,
      username: sessionName ?? username,
    });
    inbox
      .post(
        {
          type: "game.chat",
          source: "minecraft",
          trusted: false,
          text: args[0],
          position: args[1] ?? null,
          senderUUID: args[3] ?? null,
          verified: args[4] ?? null,
          observedAt: metadata.observedAt ?? Date.now(),
          truncated: metadata.truncated === true,
        },
        urgent ? { priority: "urgent" } : {},
      )
      .catch(() => {
        /* The inbox may be closing; chat is not replayed. */
      });
  }
  const done = (async () => {
    while (!signal.aborted) {
      try {
        await learnUsername();
        const response = await fetch(`${url.replace(/\/$/, "")}/v1/chat`, {
          headers: { authorization: `Bearer ${token}` },
          signal,
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error("Chat stream unavailable");
        }
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          // SSE accepts CRLF as well as LF, even across chunk boundaries.
          buffer = buffer.replace(/\r\n/g, "\n");
          let end;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            accept(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
          }
        }
      } catch {
        // A disconnected bridge may return; no historical messages are replayed.
      }
      if (!signal.aborted) {
        try {
          await delay(retryMs, undefined, { signal });
        } catch {
          break;
        }
      }
    }
  })();
  return {
    async close() {
      controller.abort();
      await done;
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // The inbox marks this as a program message; the data stays marked untrusted.
  const chat = startChatForwarder({ inbox: new InboxClient() });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => chat.close().then(() => process.exit(0)));
}
