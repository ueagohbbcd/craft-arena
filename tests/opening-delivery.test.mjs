import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createOpeningViews } from "../packages/pi-extension/opening-views.mjs";
const bounds = (min, max) => ({
  min: { x: min, y: 0, z: 0 },
  max: { x: max, y: 2, z: 2 },
});
const host = {
  openingViews: {
    lobby: { bounds: bounds(10, 12) },
    course: { bounds: bounds(0, 9), entryBounds: bounds(0, 9) },
  },
};
function fixture(x, failing = false) {
  const bot = new EventEmitter();
  bot.entity = { position: { x, y: 1, z: 1 } };
  bot.version = "1.21";
  bot.blockAt = () => ({ name: "air", stateId: 0 });
  let closes = 0,
    renders = 0;
  bot.closeBridge = () => closes++;
  const views = createOpeningViews({
    connect: async () => bot,
    render: async (snapshot, options) => {
      renders++;
      if (failing) throw new Error("fixture unavailable");
      return {
        png: Buffer.from("fixture"),
        metadata: { layout: options.layout, bounds: snapshot.bounds },
      };
    },
  });
  return { bot, views, counts: () => ({ closes, renders }) };
}
test("lobby image precedes one course image, including death back to lobby", async () => {
  const f = fixture(11);
  const initial = await f.views.capture(host, true);
  assert.match(initial.message, /Lobby/);
  assert.equal(initial.images[0].type, "image");
  assert.equal(await f.views.capture(host), undefined);
  f.bot.entity.position.x = 8;
  assert.match((await f.views.capture(host)).message, /course/);
  f.bot.entity.position.x = 11;
  assert.equal(await f.views.capture(host), undefined);
  assert.deepEqual(f.counts(), { closes: 1, renders: 2 });
});
test("skipping lobby still attaches course image to initial user prompt", async () => {
  const f = fixture(5);
  assert.match((await f.views.capture(host, true)).message, /course/);
  assert.equal(await f.views.capture(host), undefined);
  assert.deepEqual(f.counts(), { closes: 1, renders: 1 });
});
test("renderer failure permits text startup and bounded course retries", async () => {
  const f = fixture(5, true);
  const initial = await f.views.capture(host, true);
  assert.equal(initial.images, undefined);
  for (let i = 0; i < 5; i++) await f.views.capture(host);
  assert.deepEqual(f.counts(), { closes: 1, renders: 3 });
});
test("unconfigured maps do not open a mirror", async () => {
  const f = fixture(5);
  assert.equal(await f.views.capture({}, true), undefined);
  assert.deepEqual(f.counts(), { closes: 0, renders: 0 });
});
