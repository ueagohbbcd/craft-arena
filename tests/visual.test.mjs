import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderMinimap,
  renderOblique,
  materialColor,
  normalizeSnapshot,
  snapshotFromBot,
  saveRender,
  UNKNOWN_COLOR,
  AIR_COLOR,
} from "../packages/world-visual/index.mjs";
import { fixtureWorld } from "../examples/fixture-world.mjs";
function pixels(png) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20),
    chunks = [];
  for (let i = 8; i < png.length;) {
    const n = png.readUInt32BE(i),
      type = png.subarray(i + 4, i + 8).toString();
    if (type === "IDAT") chunks.push(png.subarray(i + 8, i + 8 + n));
    i += n + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  assert.equal(raw.length, height * (width * 4 + 1));
  return {
    width,
    height,
    at: (x, y) => [
      ...raw.subarray(
        y * (width * 4 + 1) + 1 + x * 4,
        y * (width * 4 + 1) + 1 + x * 4 + 3,
      ),
    ],
  };
}
test("minimap is deterministic PNG with requested dimensions and explicit unknown coverage", () => {
  const a = renderMinimap(fixtureWorld(), { width: 160, height: 160 }),
    b = renderMinimap(fixtureWorld(), { width: 160, height: 160 });
  assert.deepEqual(a.png, b.png);
  const p = pixels(a.png);
  assert.equal(p.width, 160);
  assert.equal(p.height, 160);
  assert.deepEqual(p.at(150, 150), UNKNOWN_COLOR);
  assert.equal(a.metadata.columns.unknown, 16);
  assert.equal(a.metadata.knownFraction, 240 / 256);
  assert.equal(a.metadata.sequence, 1);
  assert.match(a.metadata.source, /SYNTHETIC/);
});
test("surface takes highest non-air material, never lower hidden blocks", () => {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 2, z: 0 } };
  const render = renderMinimap(
    {
      bounds,
      blocks: [
        { x: 0, y: 0, z: 0, name: "blue_wool" },
        { x: 0, y: 1, z: 0, name: "red_wool" },
        { x: 0, y: 2, z: 0, name: "air" },
      ],
    },
    { width: 16, height: 16 },
  );
  const c = pixels(render.png).at(7, 7);
  assert.ok(c[0] > c[2] * 2);
  assert.equal(render.metadata.columns.partialAboveSurface, 0);
});
test("known air and missing cells differ; missing above surface is flagged", () => {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 0 } };
  const r = renderMinimap(
    {
      bounds,
      blocks: [
        { x: 0, y: 0, z: 0, name: "air" },
        { x: 0, y: 1, z: 0, name: "air" },
        { x: 1, y: 0, z: 0, name: "stone" },
      ],
    },
    { width: 48, height: 16 },
  );
  const p = pixels(r.png);
  assert.deepEqual(p.at(5, 5), AIR_COLOR);
  assert.deepEqual(p.at(40, 5), UNKNOWN_COLOR);
  assert.equal(r.metadata.columns.partialAboveSurface, 1);
  assert.equal(r.metadata.columns.knownClear, 1);
  assert.equal(r.metadata.columns.unknown, 1);
});
test("material palette distinguishes wool goals and known-unclassified material", () => {
  assert.deepEqual(
    materialColor("minecraft:red_wool"),
    materialColor("red_wool"),
  );
  assert.notDeepEqual(materialColor("red_wool"), materialColor("blue_wool"));
  assert.notDeepEqual(materialColor("unknown_mod_block"), UNKNOWN_COLOR);
});
test("bounds validate, filter out-of-box blocks, and cap memory", () => {
  assert.throws(
    () =>
      normalizeSnapshot({
        blocks: [],
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: -1, z: 1 } },
      }),
    RangeError,
  );
  assert.throws(
    () => renderMinimap(fixtureWorld(), { width: 8192, height: 8192 }),
    RangeError,
  );
  assert.throws(
    () =>
      normalizeSnapshot({
        blocks: [],
        bounds: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: 1000, y: 1000, z: 1000 },
        },
      }),
    RangeError,
  );
  const s = fixtureWorld();
  s.blocks.push({ x: 99, y: 0, z: 0, name: "stone" });
  assert.equal(normalizeSnapshot(s).voxels.size, 2160);
});
test("oblique structural PNG includes opaque faces and labels geometry limitations", () => {
  const r = renderOblique(fixtureWorld(), { width: 320, height: 240 }),
    p = pixels(r.png);
  assert.equal(p.width, 320);
  assert.equal(p.height, 240);
  assert.ok(r.metadata.renderedBlocks > 200);
  assert.equal(r.metadata.unknownColumns, 16);
  assert.equal(r.metadata.kind, "oblique-voxel-structural-view");
  assert.match(r.metadata.notes.join(" "), /not the Mineflayer/);
  assert.ok(r.png.length > 2000);
});
test("snapshot helper uses synchronous local blockAt, retains air and unknown", () => {
  let calls = 0;
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 0, z: 0 } };
  const snapshot = snapshotFromBot(
    {
      version: "1.20.4",
      sequence: 9,
      blockAt: (p) => {
        calls++;
        return p.x === 2
          ? null
          : { name: p.x ? "air" : "stone", stateId: p.x ? 0 : 1 };
      },
    },
    { bounds },
  );
  assert.equal(calls, 3);
  assert.equal(snapshot.blocks.length, 2);
  assert.equal(snapshot.sequence, 9);
  assert.equal(snapshot.blocks[1].name, "air");
});
test("saveRender writes bare PNG and separate machine-readable metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-test-"));
  try {
    const r = await saveRender(renderMinimap(fixtureWorld()), join(dir, "map"));
    assert.equal(pixels(await readFile(r.imagePath)).width, 512);
    assert.equal(
      JSON.parse(await readFile(r.metadataPath, "utf8")).kind,
      "top-down-schematic-minimap",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("explored snapshot retains observation ages and visibly declares stale data", async () => {
  const { snapshotFromExplored } =
    await import("../packages/world-visual/index.mjs");
  const block = { name: "stone", stateId: 1, position: { x: 0, y: 0, z: 0 } },
    bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const bot = {
    knownBlocks: new Map([["0,0,0", { block, observedAt: 1000, epoch: "a" }]]),
    blockAt: () => null,
    sequence: 2,
    version: "1.20.4",
  };
  const snapshot = snapshotFromExplored(bot, { bounds, now: 3000 });
  assert.equal(snapshot.blocks[0].ageMs, 2000);
  assert.equal(snapshot.blocks[0].stale, true);
  assert.equal(renderMinimap(snapshot).metadata.staleVoxels, 1);
  assert.equal(
    snapshotFromExplored(bot, { bounds, now: 3000, maxAgeMs: 1000 }).blocks
      .length,
    0,
  );
});
test("Pi render returns a bare native image and separate metadata in the same result", async () => {
  const { renderForModel } =
    await import("../packages/world-visual/pi-extension.mjs");
  const { writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "visual-pi-"));
  try {
    const path = join(dir, "snapshot.json");
    await writeFile(path, JSON.stringify(fixtureWorld()));
    const result = await renderForModel("world_minimap", {
      snapshotPath: path,
      width: 64,
      height: 64,
    });
    assert.equal(result.content[0].type, "image");
    assert.equal(result.content[0].mimeType, "image/png");
    assert.equal(
      pixels(Buffer.from(result.content[0].data, "base64")).width,
      64,
    );
    assert.equal(result.content[1].type, "text");
    assert.equal(JSON.parse(result.content[1].text).columns.unknown, 16);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("positive image sizes use a total pixel budget instead of arbitrary side limits", () => {
  for (const renderer of [renderMinimap, renderOblique]) {
    for (const [width, height] of [
      [1, 1],
      [8, 12],
      [5000, 16],
    ]) {
      const r = renderer(fixtureWorld(), { width, height });
      const p = pixels(r.png);
      assert.equal(p.width, width);
      assert.equal(p.height, height);
      assert.ok(r.metadata.pixelsPerBlock > 0);
    }
  }
  for (const dimensions of [
    { width: 0, height: 5 },
    { width: Infinity, height: 5 },
    { width: 8192, height: 8192 },
  ])
    assert.throws(() => renderMinimap(fixtureWorld(), dimensions), RangeError);
});
test("explicit unknown entries need no invented block name", () => {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const render = renderMinimap(
    { bounds, blocks: [{ x: 0, y: 0, z: 0, known: false }] },
    { width: 1, height: 1 },
  );
  assert.equal(render.metadata.knownVoxels, 0);
  assert.deepEqual(pixels(render.png).at(0, 0), UNKNOWN_COLOR);
});
test("Pi accepts an already connected bot without requiring duplicate environment credentials", async () => {
  const { renderForModel } =
    await import("../packages/world-visual/pi-extension.mjs");
  const result = await renderForModel(
    "world_minimap",
    {
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      width: 4097,
      height: 1,
    },
    { bot: { version: "1.21.1", blockAt: () => null } },
  );
  assert.equal(
    pixels(Buffer.from(result.content[0].data, "base64")).width,
    4097,
  );
  assert.equal(result.details.metadata.knownVoxels, 0);
});
