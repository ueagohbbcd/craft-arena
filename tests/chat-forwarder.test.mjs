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

test("mention wake rules: names, whispers, own lines and regex characters", async () => {
  const bot = nativeBot("arena.red");
  const inbox = inboxRecorder();
  const subscription = startChatForwarder({
    bot,
    inbox,
    wake: "mention",
  });

  // Mineflayer passes the sender and the body without the "<name>" prefix.
  bot.emit("chat", "player", "hello arena.red!");
  bot.emit("chat", "player", "hello arenaXred");
  bot.emit("whisper", "player", "private message");
  bot.emit("chat", "arena.red", "arena.red says hello");
  bot.emit("whisper", "arena.red", "to myself");
  await Promise.resolve();

  assert.deepEqual(
    inbox.messages.map(({ message, options }) => [
      message.channel,
      message.text,
      options?.priority ?? "normal",
    ]),
    [
      ["chat", "hello arena.red!", "urgent"],
      ["chat", "hello arenaXred", "normal"],
      ["whisper", "private message", "urgent"],
    ],
  );
  await subscription.close();
});

test("system lines are forwarded without waking; action-bar lines are not", async () => {
  const bot = nativeBot("arena.red");
  const inbox = inboxRecorder();
  const subscription = startChatForwarder({ bot, inbox, wake: "all" });

  bot.emit("messagestr", "Respawn point set", "system");
  bot.emit("messagestr", "You may not rest now", "game_info");
  bot.emit("messagestr", "<player> hi", "chat");
  await Promise.resolve();

  assert.deepEqual(
    inbox.messages.map(({ message, options }) => [
      message.channel,
      message.text,
      message.sender,
      options?.priority ?? "normal",
    ]),
    [["system", "Respawn point set", null, "normal"]],
  );
  await subscription.close();
  assert.equal(bot.listenerCount("messagestr"), 0);
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
