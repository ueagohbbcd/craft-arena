import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startChatForwarder } from "../packages/default-scripts/chat.mjs";

function nativeBot(username = "arena_red1") {
  return Object.assign(new EventEmitter(), { username });
}

function inboxRecorder() {
  const messages = [];
  return {
    messages,
    async post(message, options) {
      messages.push({ message, options });
    },
  };
}

test("native Mineflayer chat and whispers are forwarded as untrusted inbox messages", async () => {
  const bot = nativeBot();
  const inbox = inboxRecorder();
  const subscription = startChatForwarder({ bot, inbox });

  bot.emit("chat", "player", "same");
  bot.emit("chat", "player", "same");
  bot.emit("whisper", "player", "secret");
  await Promise.resolve();

  assert.deepEqual(
    inbox.messages.map(({ message }) => message.text),
    ["same", "same", "secret"],
  );
  for (const { message } of inbox.messages) {
    assert.equal(message.type, "game.chat");
    assert.equal(message.source, "minecraft");
    assert.equal(message.trusted, false);
    assert.equal(message.sender, "player");
    assert.equal(typeof message.observedAt, "number");
  }

  await subscription.close();
  bot.emit("chat", "player", "after close");
  assert.equal(inbox.messages.length, 3);
  assert.equal(bot.listenerCount("chat"), 0);
  assert.equal(bot.listenerCount("whisper"), 0);
});

test("mention wake rules handle bot names, whispers, self messages, and regex characters", async () => {
  const bot = nativeBot("arena.red");
  const inbox = inboxRecorder();
  const subscription = startChatForwarder({
    bot,
    inbox,
    wake: "mention",
  });

  bot.emit("chat", "player", "hello arena.red!");
  bot.emit("chat", "player", "hello arenaXred");
  bot.emit("whisper", "player", "arena.red, private message");
  bot.emit("chat", "arena.red", "<arena.red> arena.red says hello");
  bot.emit("chat", "player", "You whisper to someone: arena.red");
  await Promise.resolve();

  assert.deepEqual(
    inbox.messages.map(({ options }) => options?.priority ?? "normal"),
    ["urgent", "normal", "urgent", "normal", "normal"],
  );
  await subscription.close();
});

test("aborting the native chat subscription removes its Mineflayer listeners", async () => {
  const bot = nativeBot();
  const inbox = inboxRecorder();
  const controller = new AbortController();
  const subscription = startChatForwarder({
    bot,
    inbox,
    signal: controller.signal,
  });

  assert.equal(bot.listenerCount("chat"), 1);
  assert.equal(bot.listenerCount("whisper"), 1);
  controller.abort();
  await subscription.done;
  await subscription.close();

  assert.equal(bot.listenerCount("chat"), 0);
  assert.equal(bot.listenerCount("whisper"), 0);
});
