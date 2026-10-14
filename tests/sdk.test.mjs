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
