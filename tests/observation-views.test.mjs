import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { Vector } from "../packages/bot-sdk/index.mjs";
import {
  observe,
  observationViewBounds,
  surfaceSnapshotFromBot,
} from "../packages/observation/observe.mjs";
import {
  observeForModel,
  registerObserveTool,
} from "../packages/observation/pi-extension.mjs";
import {
  renderSurfaceMinimap,
  renderOblique,
  UNKNOWN_COLOR,
  AIR_COLOR,
} from "../packages/world-visual/index.mjs";

function fakeBot() {
  const bot = {
    version: "1.20.4",
    epoch: "before",
    sequence: 17,
    sampledAt: 1000,
    username: "observer",
    health: 20,
    food: 18,
    entity: { id: 1, position: new Vector(0.5, 2, 0.5), onGround: true },
    game: { minY: 0, height: 16, dimension: "overworld" },
    inventory: {
      items: () => [{ name: "red_wool", type: 10, count: 3, slot: 9 }],
    },
    columns: new Map([
      ["0,0", {}],
      ["2,0", {}],
    ]),
    entities: {},
    players: {},
    blockAt(p) {
      if (p.x < 0 || p.x >= 16 || p.z < 0 || p.z >= 16 || p.y < 0 || p.y >= 16)
        return null;
      return {
        name: p.y < 2 ? "red_wool" : "air",
        position: new Vector(p.x, p.y, p.z),
        boundingBox: p.y < 2 ? "block" : "empty",
      };
    },
  };
  return bot;
}
function pixels(png) {
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20),
    chunks = [];
  for (let i = 8; i < png.length;) {
    const n = png.readUInt32BE(i);
    if (png.subarray(i + 4, i + 8).toString() === "IDAT")
      chunks.push(png.subarray(i + 8, i + 8 + n));
    i += n + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  return {
    width,
    height,
    at: (x, y) => [
      ...raw.subarray(
        y * (width * 4 + 1) + x * 4 + 1,
        y * (width * 4 + 1) + x * 4 + 4,
      ),
    ],
  };
}
const smallBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 3, z: 3 } };

test("no-argument observe returns useful state without image acquisition or browser work", async () => {
  const result = await observe(
    fakeBot(),
    {},
    { captureTextured: () => assert.fail("unexpected render") },
  );
  assert.equal(result.state.self.health, 20);
  assert.equal(result.state.inventory.items[0].count, 3);
  assert.equal(result.state.freshness.sequence, 17);
  assert.deepEqual(result.views, []);
  assert.deepEqual(result.metadata.views, []);
});

test("overview is full loaded extent, while near-feet layer and structure use independent crops", () => {
  const bot = fakeBot();
  const selected = observationViewBounds(bot);
  assert.deepEqual(selected.overview.bounds, {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 47, y: 15, z: 15 },
  });
  assert.deepEqual(selected.local.bounds, {
    min: { x: -12, y: 1, z: -12 },
    max: { x: 12, y: 4, z: 12 },
  });
  assert.equal(selected["3d"].bounds.min.y, 0);
  assert.equal(selected["3d"].requestedBounds.min.y, -6);
  const publicMapBounds = {
    min: { x: 100, y: 20, z: 100 },
    max: { x: 120, y: 60, z: 150 },
  };
  const configured = observationViewBounds(bot, { publicMapBounds });
  assert.deepEqual(configured.overview.bounds, publicMapBounds);
  assert.deepEqual(configured.local.bounds, selected.local.bounds);
  assert.match(configured.overview.mode, /public map/);
});

test("teleport beyond old loaded extents keeps local crop centered at the actual new player", () => {
  const bot = fakeBot();
  bot.entity.position = new Vector(100.5, 14, -50.25);
  const selected = observationViewBounds(bot, { viewRadius: 2 });
  assert.equal(selected.overview.bounds.max.x, 47);
  assert.deepEqual(selected.local.bounds, {
    min: { x: 98, y: 13, z: -53 },
    max: { x: 102, y: 15, z: -49 },
  });
  assert.equal(selected.local.requestedBounds.max.y, 16);
});

test("surface scan distinguishes known air, unknown cells and unknown above a known surface", () => {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 0 } };
  const bot = {
    blockAt: ({ x, y }) =>
      x === 0 ? { name: "air" } : x === 1 && y === 0 ? { name: "stone" } : null,
  };
  const snapshot = surfaceSnapshotFromBot(bot, bounds);
  assert.equal(snapshot.columns[0].known, 2);
  assert.equal(snapshot.columns[1].unknownAbove, true);
  assert.equal(snapshot.columns[2].known, 0);
  const result = renderSurfaceMinimap(snapshot, { width: 48, height: 16 });
  const p = pixels(result.png);
  assert.deepEqual(p.at(5, 5), AIR_COLOR);
  assert.deepEqual(p.at(40, 5), UNKNOWN_COLOR);
  assert.equal(result.metadata.knownVoxels, 3);
  assert.equal(result.metadata.columns.partialAboveSurface, 1);
  assert.equal(result.metadata.columns.unknown, 1);
});

test("full loaded-map overview above old voxel acquisition limits retains the entire extent", async () => {
  const bot = fakeBot();
  bot.game = { minY: -64, height: 384 };
  bot.hasColumnMirror = true;
  bot.columns = new Map();
  for (let x = 0; x < 8; x++)
    for (let z = 0; z < 8; z++)
      bot.columns.set(`${x},${z}`, {
        chunk: { minY: -64, worldHeight: 384, getBlockStateId: () => 1 },
      });
  let calls = 0;
  bot.blockAt = (p) => {
    calls++;
    return { name: "stone", position: p, boundingBox: "block" };
  };
  const result = await observe(bot, {
    views: ["overview"],
    width: 128,
    height: 128,
  });
  assert.equal(result.views[0].metadata.status, "ready");
  assert.equal(result.views[0].metadata.totalVoxels, 128 * 128 * 384);
  assert.equal(result.views[0].metadata.knownFraction, 1);
  assert.equal(result.views[0].metadata.bounds.max.x, 127);
  assert.ok(
    calls < 17_000,
    "full columns establish coverage without allocating millions of air voxels",
  );
});

test("player marker pixels and coordinate sidecar agree with actual X/Z without crop stretching", async () => {
  const bot = fakeBot();
  bot.entity.position = new Vector(1.5, 2, 2.5);
  const result = await observe(bot, {
    views: ["local"],
    localBounds: smallBounds,
    width: 80,
    height: 40,
  });
  const view = result.views[0],
    p = pixels(view.png);
  assert.deepEqual(view.metadata.viewport, {
    x: 20,
    y: 0,
    width: 40,
    height: 40,
  });
  assert.deepEqual(view.metadata.player.pixel, { x: 35, y: 25 });
  assert.deepEqual(p.at(35, 25), [255, 255, 255]);
  assert.deepEqual(p.at(41, 25), [0, 0, 0]);
  assert.equal(view.metadata.coordinateTransform.pixelsPerBlock, 10);
  assert.match(view.metadata.notes.join(" "), /above the slice are omitted/);
});

test("one native tool result preserves frozen state and selected image source stamps across asynchronous rendering", async () => {
  const bot = fakeBot();
  const result = await observeForModel(
    bot,
    {
      views: ["3d", "local", "overview"],
      structureBounds: smallBounds,
      localBounds: smallBounds,
      overviewBounds: smallBounds,
      width: 80,
      height: 80,
    },
    {
      async captureTextured(snapshot, options) {
        assert.equal(snapshot.sequence, 17);
        bot.epoch = "after";
        bot.sequence = 18;
        bot.health = 1;
        bot.entity.position = new Vector(30, 10, 30);
        bot.blockAt = () => ({ name: "blue_wool" });
        await Promise.resolve();
        return renderOblique(snapshot, options);
      },
    },
  );
  assert.equal(result.content.length, 4);
  assert.equal(result.content[0].type, "text");
  for (const image of result.content.slice(1)) {
    assert.equal(image.type, "image");
    assert.equal(image.mimeType, "image/png");
    assert.equal(Buffer.from(image.data, "base64").readUInt32BE(16), 80);
  }
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.state.self.health, 20);
  assert.equal(payload.state.freshness.sequence, 17);
  for (const [i, view] of payload.views.entries()) {
    assert.equal(view.sequence, 17);
    assert.equal(view.epoch, "before");
    assert.equal(view.contentIndex, i + 1);
    assert.deepEqual(view.position, { x: 0.5, y: 2, z: 0.5 });
  }
  const topDown = pixels(Buffer.from(result.content[2].data, "base64"));
  const [red, , blue] = topDown.at(60, 60);
  assert.ok(
    red > blue * 2,
    "surface snapshot must remain old red wool after live mirror turns blue",
  );
  assert.deepEqual(
    result.structuredContent.content,
    result.content,
    "codemode forwarding retains native image blocks",
  );
  assert.deepEqual(result.structuredContent.state, payload.state);
});

test("failed real renderer produces an explicitly labeled schematic fallback and optional strict view failure", async () => {
  const dependencies = {
    captureTextured: async () => {
      throw new Error("Chromium unavailable");
    },
  };
  const options = {
    views: ["3d"],
    structureBounds: smallBounds,
    width: 80,
    height: 60,
  };
  const result = await observe(fakeBot(), options, dependencies);
  assert.ok(result.views[0].png);
  assert.equal(result.views[0].metadata.kind, "oblique-voxel-structural-view");
  assert.deepEqual(result.views[0].metadata.renderer, {
    requested: "prismarine-textured",
    actual: "schematic",
    fallback: true,
    reason: "Chromium unavailable",
  });
  assert.match(
    result.views[0].metadata.notes.join(" "),
    /not a Minecraft texture capture/,
  );
  const strict = await observeForModel(
    fakeBot(),
    { ...options, fallback: "error" },
    dependencies,
  );
  assert.equal(strict.content.length, 1);
  assert.equal(strict.details.views[0].status, "unavailable");
  assert.equal(strict.details.views[0].contentIndex, null);
  assert.equal(strict.details.state.self.health, 20);
});

test("schema registers only observe and can reuse runtime context and task state", async () => {
  const definitions = [],
    ctx = { marker: "runtime context" },
    bot = fakeBot();
  let connections = 0;
  const pi = { registerTool: (tool) => definitions.push(tool) };
  registerObserveTool(pi, {
    getBot: async (passed) => {
      assert.equal(passed, ctx);
      connections++;
      return bot;
    },
    sampleOptions: async (passed) => {
      assert.equal(passed, ctx);
      return { tasks: [{ taskId: "running-job", status: "running" }] };
    },
  });
  assert.deepEqual(
    definitions.map((tool) => tool.name),
    ["observe"],
  );
  const result = await definitions[0].execute(
    "id",
    {},
    undefined,
    undefined,
    ctx,
  );
  assert.equal(connections, 1);
  assert.equal(result.details.state.tasks[0].taskId, "running-job");
  assert.equal(result.content.length, 1);
});

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
let hasTextureAssets = true;
try {
  require.resolve("prismarine-viewer/package.json");
} catch {
  hasTextureAssets = false;
}

test(
  "CPU surface uses real atlas pixels and selects state-dependent log top versus side",
  { skip: !hasTextureAssets },
  async () => {
    const { renderTexturedSurface, decodeTextureAtlas } =
      await import("../packages/world-visual/surface-textures.mjs");
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const root = dirname(require.resolve("prismarine-viewer/package.json"));
    const states = JSON.parse(
      readFileSync(join(root, "public/blocksStates/1.21.1.json"), "utf8"),
    );
    const atlas = decodeTextureAtlas(
      readFileSync(join(root, "public/textures/1.21.1.png")),
    );
    const Block = require("prismarine-block")("1.21.1");
    const columns = [
      { name: "red_wool" },
      {
        name: "oak_log",
        stateId: Block.fromProperties("oak_log", { axis: "y" }, 0).stateId,
      },
      {
        name: "oak_log",
        stateId: Block.fromProperties("oak_log", { axis: "x" }, 0).stateId,
      },
      { name: "crafting_table" },
      { name: "chest" },
    ].map((top, x) => ({
      x,
      z: 0,
      known: 1,
      unknownAbove: false,
      top: { ...top, x, y: 0, z: 0 },
    }));
    const snapshot = {
      version: "1.21.1",
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 0, z: 0 } },
      columns,
    };
    const result = renderTexturedSurface(snapshot, { width: 96, height: 16 });
    const p = pixels(result.png);
    const redModel = states.red_wool.variants[""];
    const face = (Array.isArray(redModel) ? redModel[0] : redModel).model
      .elements[0].faces.up.texture;
    const px = Math.floor((face.u + (face.su * 5) / 16) * atlas.width),
      py = Math.floor((face.v + (face.sv * 9) / 16) * atlas.height);
    assert.deepEqual(p.at(5, 9), [
      ...atlas.data.subarray(
        (py * atlas.width + px) * 4,
        (py * atlas.width + px) * 4 + 3,
      ),
    ]);
    const verticalLog = [],
      horizontalLog = [];
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        verticalLog.push(...p.at(16 + x, y));
        horizontalLog.push(...p.at(32 + x, y));
      }
    assert.notDeepEqual(
      verticalLog,
      horizontalLog,
      "rotated log state needs bark overhead instead of exposed end grain",
    );
    assert.deepEqual(p.at(90, 9), UNKNOWN_COLOR);
    assert.equal(result.metadata.kind, "top-down-minecraft-texture-surface");
    assert.equal(result.metadata.renderer.texturedColumns, 4);
    assert.equal(result.metadata.renderer.schematicFallbackColumns, 1);
    assert.match(
      result.metadata.renderer.specialBlockFallbacks[0].reason,
      /chest/,
    );
    assert.match(result.metadata.notes.join(" "), /not a browser screenshot/);
  },
);

test("texture asset failure is an explicit schematic fallback rather than a claimed real render", async () => {
  const { renderTexturedSurface } =
    await import("../packages/world-visual/surface-textures.mjs");
  const snapshot = surfaceSnapshotFromBot(
    { blockAt: () => ({ name: "stone" }) },
    smallBounds,
  );
  const result = renderTexturedSurface(snapshot, { width: 32, height: 32 });
  assert.equal(result.metadata.renderer.actual, "schematic-surface");
  assert.equal(result.metadata.renderer.fallback, true);
  assert.match(result.metadata.renderer.reason, /version is required/);
  assert.match(result.metadata.notes[0], /schematic/);
});

test("full chunk air scan uses raw state IDs without converting every known air block", () => {
  let converted = 0;
  const bot = fakeBot();
  bot.game = { minY: -64, height: 384 };
  bot.registry = {
    blocksByStateId: { 0: { name: "air" }, 1: { name: "stone" } },
  };
  bot.columns = new Map([
    [
      "0,0",
      {
        chunk: {
          minY: -64,
          worldHeight: 384,
          getBlockStateId: (p) => (p.y === 1 ? 1 : 0),
        },
      },
    ],
  ]);
  bot.blockAt = (p) => {
    converted++;
    return { name: "stone", position: p };
  };
  const result = surfaceSnapshotFromBot(bot, {
    min: { x: 0, y: -64, z: 0 },
    max: { x: 0, y: 319, z: 0 },
  });
  assert.equal(converted, 1);
  assert.equal(result.columns[0].known, 384);
  assert.equal(result.columns[0].top.y, 1);
});

test("readable heading marker uses Mineflayer yaw and fixed screen size rather than block size", async () => {
  const bot = fakeBot();
  bot.entity.position = new Vector(1.5, 2, 2.5);
  bot.entity.yaw = 0; // Mineflayer zero yaw looks north (-Z).
  const result = await observe(bot, {
    views: ["local"],
    localBounds: smallBounds,
    width: 80,
    height: 40,
  });
  const { player } = result.views[0].metadata;
  assert.equal(player.markerSizePixels, 12);
  assert.match(player.marker, /heading arrow/);
  assert.equal(player.heading.z, -1);
  assert.equal(Math.abs(player.heading.x), 0);
  const p = pixels(result.views[0].png);
  assert.deepEqual(p.at(35, 22), [255, 255, 255]);
  assert.deepEqual(p.at(35, 19), [0, 0, 0]);
  bot.entity.yaw = Math.PI / 2;
  const west = await observe(bot, {
    views: ["local"],
    localBounds: smallBounds,
    width: 80,
    height: 40,
  });
  assert.equal(west.views[0].metadata.player.heading.x, -1);
  assert.deepEqual(pixels(west.views[0].png).at(32, 25), [255, 255, 255]);
});

test("full-height overview retains overhead roof while local current-Y slice reveals lower layer", async () => {
  const bot = fakeBot();
  bot.entity.position.y = 3;
  bot.blockAt = (p) => ({
    name: p.y === 9 ? "blue_wool" : p.y === 2 ? "red_wool" : "air",
    position: p,
  });
  const selected = observationViewBounds(bot, { viewRadius: 2 });
  const overview = surfaceSnapshotFromBot(bot, selected.overview.bounds);
  const local = surfaceSnapshotFromBot(bot, selected.local.bounds);
  assert.equal(overview.columns[0].top.name, "blue_wool");
  assert.equal(local.columns[0].top.name, "red_wool");
  assert.equal(selected.overview.bounds.max.y, 15);
  assert.equal(selected.local.bounds.max.y, 5);
  const result = await observe(bot, {
    views: ["overview", "local"],
    viewRadius: 2,
    width: 96,
    height: 32,
  });
  assert.match(result.views[0].metadata.selection.mode, /full loaded/);
  assert.match(result.views[1].metadata.selection.mode, /current layer/);
  assert.match(
    result.views[1].metadata.notes.join(" "),
    /above the slice are omitted/,
  );
});

test("requested views without a valid player position preserve available state and report each view unavailable", async () => {
  for (const entity of [undefined, {}, { position: new Vector(NaN, 2, 0) }]) {
    const bot = fakeBot();
    bot.entity = entity;
    const result = await observeForModel(
      bot,
      { views: ["overview", "local", "3d"] },
      {
        captureTextured: () =>
          assert.fail("unavailable position must not start a renderer"),
      },
    );
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.state.self.health, 20);
    assert.equal(payload.state.self.position, null);
    assert.equal(payload.state.inventory.items[0].count, 3);
    assert.equal(payload.state.freshness.sequence, 17);
    assert.deepEqual(
      payload.views.map((view) => view.name),
      ["overview", "local", "3d"],
    );
    for (const view of payload.views) {
      assert.equal(view.status, "unavailable");
      assert.equal(view.selection, null);
      assert.equal(view.contentIndex, null);
      assert.equal(view.sequence, 17);
      assert.match(view.error, /known player position/);
    }
  }
});

test("missing live position does not mask invalid observation view parameters", async () => {
  const bot = fakeBot();
  delete bot.entity;
  for (const options of [
    { views: ["invalid"] },
    {
      views: ["overview"],
      overviewBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: -1, y: 0, z: 0 } },
    },
    { views: ["overview"], localBounds: null },
    { views: ["overview"], viewRadius: -1 },
    { views: ["overview"], width: 0 },
    { views: ["3d"], viewDirection: "invalid" },
    { views: ["overview"], textured: "true" },
    { views: ["overview"], fallback: "invalid" },
  ])
    await assert.rejects(
      observe(bot, options),
      (error) => error instanceof TypeError || error instanceof RangeError,
    );
});
