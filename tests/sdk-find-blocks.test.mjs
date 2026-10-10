import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { BotFacade, Vector } from "../packages/bot-sdk/index.mjs";

function fixture() {
  const bot = new BotFacade({ url: "http://fixture", loadRegistry: false });
  bot.entity = { position: new Vector() };
  bot.hasColumnMirror = true;
  return bot;
}

test("findBlocks filters lazily and preserves nearest matches and stable ties", () => {
  const bot = fixture();
  let checked = 0;
  const entries = [
    [9, 1],
    [1, 2],
    [-3, 1],
    [3, 1],
    [2, 1],
    [81, 1],
  ];
  bot._blocksInBounds = function* () {
    yield null;
    for (const [x, type] of entries) {
      yield { position: new Vector(x, 0, 0), type };
      if (Math.abs(x) <= 80) assert.equal(checked > 0, true);
      checked = 0;
    }
  };
  const result = bot.findBlocks({
    maxDistance: 80,
    count: 3,
    matching: (block) => {
      checked++;
      return block.type === 1;
    },
  });
  assert.deepEqual(
    result.map((p) => p.x),
    [2, -3, 3],
  );
  bot.hasColumnMirror = false;
  bot.blocks = new Map(
    entries.map(([x, type], i) => [i, { position: new Vector(x, 0, 0), type }]),
  );
  assert.deepEqual(
    bot
      .findBlocks({ matching: [1], count: 2, maxDistance: 80 })
      .map((p) => p.x),
    [2, -3],
  );
});

test("findBlocks scans a large lazy iterator within a small heap", () => {
  const moduleUrl = new URL("../packages/bot-sdk/index.mjs", import.meta.url)
    .href;
  const result = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=48",
      "--input-type=module",
      "-e",
      `
    import { BotFacade, Vector } from ${JSON.stringify(moduleUrl)};
    const bot = new BotFacade({url: 'http://fixture', loadRegistry: false});
    bot.entity = {position: new Vector()};
    bot.hasColumnMirror = true;
    bot._blocksInBounds = function* () {
      for (let i = 150000; i > 0; i--)
        yield {position: new Vector(i % 80, 0, 0), type: i % 2, payload: Array(128).fill(i)};
    };
    const positions = bot.findBlocks({matching: 1, maxDistance: 80, count: 3});
    if (positions.length !== 3 || positions.some(p => p.x !== 1)) process.exit(1);
  `,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
