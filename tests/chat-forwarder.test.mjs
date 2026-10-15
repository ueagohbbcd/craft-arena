import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { Inbox, localInboxClient } from "../packages/inbox/index.mjs";
import { startChatForwarder } from "../packages/default-scripts/chat.mjs";
import extension from "../packages/pi-extension/index.mjs";
const token = "chat-inbox-test-token";
async function until(fn, timeout = 2000) {
  for (let i = 0; i < timeout / 10; i++) {
    if (fn()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for chat");
}
async function bridge(t) {
  const bot = new EventEmitter();
  bot.inventory = { slots: [] };
  bot.entities = {};
  bot.blockAt = () => assert.fail("Chat must not sample blocks");
  const b = await startBridge({ bot, token });
  let connections = 0;
  let active = 0;
  b.server.on("request", (req, res) => {
    if (req.url === "/v1/chat") {
      connections++;
      if (res.statusCode === 200) {
        active++;
        res.on("close", () => active--);
      }
    }
  });
  t.after(() => b.close());
  return { b, bot, connections: () => connections, active: () => active };
}
function message(bot, text, position = "chat") {
  bot.emit("chat", "player", text, null);
  bot.emit("messagestr", text, position, {}, "sender-uuid", true);
}
test("authenticated chat stream retains ordinary/system/repeated messages without world sampling", async (t) => {
  const { b, bot, connections, active } = await bridge(t);
  assert.equal((await fetch(`${b.url}/v1/chat`)).status, 401);
  const inbox = new Inbox({ sessionId: "chat" });
  const subscription = startChatForwarder({
    url: b.url,
    token,
    inbox: localInboxClient(inbox),
  });
  t.after(() => subscription.close());
  await until(() => connections() === 2);
  message(bot, "same");
  message(bot, "same");
  message(bot, "system notice", "system");
  message(bot, "action bar", "game_info");
  message(bot, "unknown", null);
  message(bot, "x".repeat(270000));
  await until(() => inbox.totalDropped.overflow === 1);
  const batch = inbox.drain();
  assert.deepEqual(
    batch.messages.map((m) => m.data.text),
    ["same", "same", "system notice", "unknown"],
  );
  for (const m of batch.messages) {
    assert.equal(m.priority, "normal");
    assert.equal(m.source, "program");
    assert.equal(m.data.trusted, false);
    assert.equal(m.data.source, "minecraft");
    assert.equal(m.data.senderUUID, "sender-uuid");
    assert.equal(typeof m.data.observedAt, "number");
    assert.equal(m.data.username, undefined);
  }
  await subscription.close();
  await until(() => active() === 0);
  message(bot, "after close");
  await delay(40);
  assert.equal(inbox.pending, false);
});
test("chat reconnects after disconnect and close cancels retry", async (t) => {
  let count = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/v1/chat");
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    count++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"connected"}\n\n');
    if (count === 1) {
      res.end();
      return;
    }
    res.write(
      'data: {"type":"event","data":{"name":"messagestr","args":["reconnected","system"]}}\n\n',
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const inbox = new Inbox({ sessionId: "reconnect" });
  const subscription = startChatForwarder({
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    inbox: localInboxClient(inbox),
    retryMs: 15,
  });
  t.after(() => subscription.close());
  await until(() => inbox.items.length === 1);
  assert.equal(count, 2);
  await subscription.close();
  await delay(60);
  assert.equal(count, 2);
});
test("Pi starts the default chat script per session and replaces it on session switch", async (t) => {
  const { b, bot, connections, active } = await bridge(t);
  const saved = { ...process.env };
  Object.assign(process.env, {
    ARENA_BRIDGE_URL: b.url,
    ARENA_BRIDGE_TOKEN: token,
    ARENA_DEFAULT_SCRIPTS: "chat",
    MC_INBOX_TRANSPORT: "http",
    MC_INBOX_TOKEN: token,
  });
  delete process.env.MC_INBOX_SOCKET;
  const handlers = new Map();
  const sent = [];
  extension({
    on: (n, f) => handlers.set(n, f),
    registerTool() {},
    // Count only messages that start turns; passive platform updates are separate.
    sendMessage: (...a) => a[0].customType === "arena-platform" || sent.push(a),
  });
  t.after(async () => {
    await handlers.get("session_shutdown")();
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  let session = "first";
  const cwd = await mkdtemp(join(tmpdir(), "chat-forwarder-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const ctx = {
    // Task files go to ARENA_TASK_DIR or <cwd>/.arena; keep them out of the repo.
    cwd,
    sessionManager: { getSessionId: () => session },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
  // The chat script is a child process: poll a boundary until its IPC post lands.
  const chatsAt = async (boundary) => {
    for (let i = 0; i < 150; i++) {
      const batch = await boundary();
      const texts = (batch?.messages ?? [])
        .filter((m) => m.data.type === "game.chat")
        .map((m) => m.data.text);
      if (texts.length) return { batch, texts };
      await delay(20);
    }
    return { texts: [] };
  };
  const toolBoundary = async () => {
    const result = await handlers.get("tool_result")({ content: [] }, ctx);
    const text = result?.content.at(-1).text ?? "";
    return text.startsWith("Participant inbox")
      ? JSON.parse(text.slice(text.indexOf("\n") + 1))
      : undefined;
  };
  const turnBoundary = async () =>
    (
      await handlers.get("turn_end")({ entries: [], outcome: "stop" }, ctx)
    )?.entries.at(-1).details;

  await handlers.get("session_start")({}, ctx);
  await until(() => connections() === 1, 10000);
  message(bot, "first");
  const first = await chatsAt(toolBoundary);
  assert.deepEqual(first.texts, ["first"]);
  const chat = first.batch.messages.find((m) => m.data.type === "game.chat");
  assert.equal(chat.source, "program", "an ordinary script, not the runtime");
  assert.equal(chat.data.trusted, false);

  message(bot, "old pending");
  await delay(100);
  session = "second";
  await handlers.get("session_start")({}, ctx);
  await until(() => connections() === 2, 10000);
  await until(() => active() === 1, 10000);
  message(bot, "second");
  const second = await chatsAt(turnBoundary);
  assert.equal(second.batch.sessionId, "second");
  assert.deepEqual(second.texts, ["second"]);
  assert.equal(sent.length, 0);
  await handlers.get("session_shutdown")();
  await until(() => active() === 0, 10000);
});
