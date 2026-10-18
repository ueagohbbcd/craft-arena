import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Inbox, InboxClient } from "../packages/inbox/index.mjs";
import { watchdog } from "../packages/bot-sdk/watchdog.mjs";
import { socketInbox } from "./helpers/inbox-socket.mjs";

function fakeBot() {
  const bot = new EventEmitter();
  bot.entity = { position: { x: 0, y: 64, z: 0 } };
  bot.controlState = {};
  bot.inventory = new EventEmitter();
  return bot;
}

test("the arena watchdog posts findings and sends a blocked loop as urgent", async (t) => {
  const inbox = new Inbox({ sessionId: "session" });
  const { socketPath } = await socketInbox(t, inbox);
  const client = new InboxClient({ socketPath, sessionId: "session" });
  const bot = fakeBot();
  const dog = watchdog(bot, {
    inbox: client,
    stuckMs: 100,
    checkMs: 20,
    blockedMs: 300,
  });
  t.after(() => dog.close());
  bot.controlState.forward = true;
  await delay(300);
  let messages = inbox.drain().messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "event");
  assert.equal(messages[0].data.watchdog, "stuck");
  bot.controlState.forward = false;
  const until = Date.now() + 1500;
  while (Date.now() < until) {} // A synchronous loop.
  for (let i = 0; i < 100 && !inbox.pending; i++) await delay(20);
  messages = inbox.drain().messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].priority, "urgent");
  assert.equal(messages[0].data.watchdog, "blocked");
});
