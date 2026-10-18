#!/usr/bin/env node
// Forwards native Mineflayer chat events through the normal InboxClient.
import { once } from "node:events";
import { InboxClient } from "../inbox/index.mjs";

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

/** Forward chat without changing its untrusted status. */
export function startChatForwarder({
  bot,
  inbox,
  signal,
  wake = process.env.ARENA_CHAT_WAKE || "none",
}) {
  if (!["none", "mention", "all"].includes(wake))
    throw new Error("ARENA_CHAT_WAKE must be none, mention or all");
  const forward = (username, message) => {
    const text = String(message ?? "");
    const urgent = chatWakes(text, { mode: wake, username: bot.username });
    void inbox
      .post(
        {
          type: "game.chat",
          source: "minecraft",
          trusted: false,
          text,
          sender: username ?? null,
          observedAt: Date.now(),
        },
        urgent ? { priority: "urgent" } : {},
      )
      .catch(() => {});
  };
  bot.on("chat", forward);
  bot.on("whisper", forward);
  const done = signal
    ? once(signal, "abort").then(() => {})
    : new Promise(() => {});
  return {
    done,
    async close() {
      bot.off("chat", forward);
      bot.off("whisper", forward);
    },
  };
}

export default async function chatScript(bot, { signal }) {
  const chat = startChatForwarder({ bot, inbox: new InboxClient(), signal });
  try {
    await chat.done;
  } finally {
    await chat.close();
  }
}
