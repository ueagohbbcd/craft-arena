import test from "node:test";
import assert from "node:assert/strict";
import { BotFacade, Vector } from "../packages/bot-sdk/index.mjs";
const token = "history-bounds-fixture-token";

test("legacy sampled history iterator respects requested bounds and labels stale entries", () => {
  const bot = new BotFacade({
    url: "http://unused",
    token,
    loadRegistry: false,
  });
  bot.hasColumnMirror = true;
  bot._rememberBlock(
    { position: new Vector(1, 0, 1), name: "stone" },
    Date.now(),
  );
  bot._rememberBlock(
    { position: new Vector(500, 0, 500), name: "dirt" },
    Date.now(),
  );
  const result = [
    ...bot.knownBlocksIn({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 2, y: 0, z: 2 },
    }),
  ];
  assert.equal(result.length, 1);
  assert.equal(result[0].block.name, "stone");
  assert.equal(result[0].stale, true);
});
