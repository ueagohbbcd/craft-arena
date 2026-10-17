import test from "node:test";
import assert from "node:assert/strict";
import { createTrendWatch } from "../packages/observation/trend-watch.mjs";

const run = (watch, seconds, at) => {
  const found = [];
  for (let s = 0; s <= seconds; s++) found.push(...watch.sample(at(s)));
  return found;
};

test("standing still for minutes is reported once, and walking off re-arms it", () => {
  const watch = createTrendWatch();
  const still = run(watch, 400, (s) => ({
    t: s * 1000,
    position: { x: 0.2 * Math.sin(s), y: 64, z: 0 },
    inventory: "1:1",
  }));
  assert.deepEqual(
    still.map((f) => f.type),
    ["no_progress"],
  );
  assert.equal(still[0].urgent, false);
  const walked = run(watch, 30, (s) => ({
    t: (401 + s) * 1000,
    position: { x: s * 4, y: 64, z: 0 },
    inventory: "1:1",
  }));
  assert.deepEqual(walked, []);
});

test("an inventory change or a dig counts as progress", () => {
  const watch = createTrendWatch();
  const found = run(watch, 400, (s) => {
    if (s % 100 === 50)
      watch.dig({ t: s * 1000, position: { x: s, y: 60, z: 0 } });
    return {
      t: s * 1000,
      position: { x: 0, y: 64, z: 0 },
      inventory: `1:${Math.floor(s / 120)}`,
    };
  });
  assert.deepEqual(found, []);
});

test("walking far over a few cells is circling; walking into a wall is reported", () => {
  const circling = createTrendWatch();
  const found = run(circling, 200, (s) => ({
    t: s * 1000,
    position: { x: 2 * Math.cos(s), y: 64, z: 2 * Math.sin(s) },
  }));
  assert.ok(found.some((f) => f.type === "circling"));
  const wall = createTrendWatch();
  const pressed = run(wall, 25, (s) => ({
    t: s * 1000,
    position: { x: 10, y: 64, z: 10 },
    moving: true,
    collided: true,
  }));
  assert.deepEqual(
    pressed.map((f) => f.type),
    ["against_wall"],
  );
});

test("repeated deaths in one place are urgent; repeated digs and chat are not", () => {
  const watch = createTrendWatch();
  assert.deepEqual(watch.death({ t: 0, position: { x: 0, y: 60, z: 0 } }), []);
  const deaths = watch.death({ t: 60_000, position: { x: 5, y: 60, z: 3 } });
  assert.equal(deaths[0].type, "repeat_death");
  assert.equal(deaths[0].urgent, true);
  assert.deepEqual(
    watch.death({ t: 70_000, position: { x: 500, y: 60, z: 0 } }),
    [],
  );
  const block = { x: 1.5, y: 63, z: 2.5 };
  watch.dig({ t: 0, position: block });
  watch.dig({ t: 1000, position: block });
  assert.equal(watch.dig({ t: 2000, position: block })[0].type, "repeat_dig");
  assert.deepEqual(watch.dig({ t: 3000, position: block }), [], "once");
  watch.chat({ t: 0, text: "help" });
  watch.chat({ t: 1, text: "help" });
  const chat = watch.chat({ t: 2, text: "help" });
  assert.equal(chat[0].type, "repeat_chat");
  assert.equal(chat[0].urgent, false);
});

test("the default watchdog script reports through the inbox", async (t) => {
  const { EventEmitter } = await import("node:events");
  const { startTrendWatchdog } =
    await import("../packages/default-scripts/watchdog.mjs");
  const bot = new EventEmitter();
  bot.username = "arena_red1";
  bot.entity = { position: { x: 0, y: 64, z: 0 } };
  bot.inventory = { items: () => [] };
  const sent = [];
  const inbox = {
    post: async (data) => sent.push(["post", data]),
    requestJudgment: async (data) => sent.push(["urgent", data]),
  };
  const running = startTrendWatchdog({ bot, inbox, sampleMs: 60_000 });
  t.after(() => running.close());
  bot.emit("death");
  bot.emit("death");
  bot.emit("chat", "someone", "hi");
  for (let i = 0; i < 3; i++) bot.emit("chat", "arena_red1", "wool?");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    sent.map(([how, data]) => [how, data.watchdog]),
    [
      ["urgent", "repeat_death"],
      ["post", "repeat_chat"],
    ],
  );
});
