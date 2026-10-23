import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import waitForChat, { control } from "../examples/wait-for-chat.mjs";

const botNamed = (username) => Object.assign(new EventEmitter(), { username });

test("ends on a line that names the character, not on other chat or its own", async () => {
  const bot = botNamed("arena_red1");
  const done = waitForChat(bot, { signal: new AbortController().signal });
  bot.emit("chat", "arena_red1", "talking about arena_red1 myself");
  bot.emit("chat", "steve", "anyone seen my sheep?");
  bot.emit("chat", "steve", "Arena_Red1, come here please");
  assert.deepEqual(await done, {
    heard: {
      channel: "chat",
      sender: "steve",
      text: "Arena_Red1, come here please",
      trusted: false,
    },
  });
  assert.equal(bot.listenerCount("chat"), 0);
  assert.equal(bot.listenerCount("whisper"), 0);
  assert.equal(control, false);
});

test("a whisper ends it; all mode takes any line; cancelling removes the listeners", async () => {
  const bot = botNamed("arena_red1");
  const whisper = waitForChat(bot, { signal: new AbortController().signal });
  bot.emit("whisper", "alex", "psst");
  assert.equal((await whisper).heard.channel, "whisper");

  const any = waitForChat(bot, {
    args: ["all"],
    signal: new AbortController().signal,
  });
  bot.emit("chat", "alex", "hello world");
  assert.equal((await any).heard.text, "hello world");

  const controller = new AbortController();
  const cancelled = waitForChat(bot, { signal: controller.signal });
  controller.abort(new Error("Run cancelled"));
  await assert.rejects(cancelled, /Run cancelled/);
  assert.equal(bot.listenerCount("chat"), 0);
});
