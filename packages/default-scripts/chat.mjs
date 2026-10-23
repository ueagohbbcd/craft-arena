#!/usr/bin/env node
// Forwards native Mineflayer chat events through the normal InboxClient.
import { once } from "node:events";
import { InboxClient } from "../inbox/index.mjs";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a chat line from another player should wake the model. `mention`:
 * the text names the bot (case-insensitive, whole word); `all`: any line.
 * Whispers to the bot wake in both modes (see startChatForwarder).
 */
export function chatWakes(text, { mode = "none", username } = {}) {
  if (mode !== "mention" && mode !== "all") return false;
  if (mode === "all") return true;
  if (typeof username !== "string" || !username) return false;
  return new RegExp(`(?<![\\w])${escape(username)}(?![\\w])`, "i").test(text);
}

/**
 * Forward chat without changing its untrusted status: other players' chat
 * and whispers (Mineflayer `chat`/`whisper`: sender and body) and server
 * system lines such as "Respawn point set" (`messagestr` with position
 * `system`; action-bar `game_info` lines are left out). The bot's own lines
 * are not forwarded. System lines never wake the model.
 */
export function startChatForwarder({
  bot,
  inbox,
  signal,
  wake = process.env.ARENA_CHAT_WAKE || "none",
}) {
  if (!["none", "mention", "all"].includes(wake))
    throw new Error("ARENA_CHAT_WAKE must be none, mention or all");
  const post = (channel, sender, text, urgent) =>
    void inbox
      .post(
        {
          type: "game.chat",
          source: "minecraft",
          trusted: false,
          channel,
          text,
          sender,
          observedAt: Date.now(),
        },
        urgent ? { priority: "urgent" } : {},
      )
      .catch(() => {});
  const onChat = (username, message) => {
    if (username === bot.username) return;
    const text = String(message ?? "");
    post(
      "chat",
      username ?? null,
      text,
      chatWakes(text, { mode: wake, username: bot.username }),
    );
  };
  const onWhisper = (username, message) => {
    if (username === bot.username) return;
    post("whisper", username ?? null, String(message ?? ""), wake !== "none");
  };
  const onMessage = (text, position) => {
    if (position === "system") post("system", null, String(text ?? ""), false);
  };
  bot.on("chat", onChat);
  bot.on("whisper", onWhisper);
  bot.on("messagestr", onMessage);
  const done = signal
    ? once(signal, "abort").then(() => {})
    : new Promise(() => {});
  return {
    done,
    async close() {
      bot.off("chat", onChat);
      bot.off("whisper", onWhisper);
      bot.off("messagestr", onMessage);
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
