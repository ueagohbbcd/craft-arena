import test from "node:test";
import assert from "node:assert/strict";
import { BotFacade } from "../packages/bot-sdk/index.mjs";
test("out of order frames force reset rather than silent desynchronization", async () => {
  const b = new BotFacade({
    url: "http://unused",
    token: "x",
    loadRegistry: false,
  });
  b.epoch = "a";
  b.sequence = 4;
  await assert.rejects(
    b.accept({
      epoch: "a",
      sequence: 6,
      type: "event",
      data: { name: "physicsTick", args: [] },
    }),
    /sequence gap/,
  );
});
test("local plugin functions stay local", () => {
  const b = new BotFacade({
    url: "http://unused",
    token: "x",
    loadRegistry: false,
  });
  let loaded = 0;
  const plugin = (bot) => {
    loaded++;
    bot.localGoal = { isEnd: (n) => n.x === 3 };
  };
  b.loadPlugin(plugin);
  b.loadPlugin(plugin);
  assert.equal(loaded, 1);
  assert.equal(b.localGoal.isEnd({ x: 3 }), true);
});
test("explored cells retain timestamps with bounded cache while unknown remains null", () => {
  const b = new BotFacade({
    url: "http://unused",
    token: "x",
    loadRegistry: false,
  });
  b.maxKnownBlocks = 2;
  b._rememberBlock({ position: { x: 0, y: 0, z: 0 }, name: "stone" }, 100);
  b._rememberBlock({ position: { x: 1, y: 0, z: 0 }, name: "air" }, 200);
  assert.equal(b.knownBlockAt({ x: 0, y: 0, z: 0 }).stale, true);
  assert.equal(b.blockAt({ x: 0, y: 0, z: 0 }), null);
  b._rememberBlock({ position: { x: 2, y: 0, z: 0 }, name: "stone" }, 300);
  assert.equal(b.knownBlockAt({ x: 0, y: 0, z: 0 }), null);
  assert.equal(b.knownBlocks.size, 2);
});
