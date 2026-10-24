import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTextureLoader } from "../packages/world-visual/viewer-texture.mjs";

const createCanvas = () => ({ toBuffer: () => Buffer.from("png") });

test("a missing viewer texture resolves to a transparent placeholder", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arena-viewer-texture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fallbackPath = join(dir, "fallback.png");
  const seen = [];
  const warnings = [];
  const loadImage = async (source) => {
    seen.push(source);
    if (source === fallbackPath) return { fallback: true };
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const load = createTextureLoader({
    loadImage,
    createCanvas,
    fallbackPath,
    warn: (line) => warnings.push(line),
  });

  assert.deepEqual(await load("/missing/a.png"), { fallback: true });
  assert.deepEqual(await load("/missing/a.png"), { fallback: true });
  assert.deepEqual(await load("/missing/b.png"), { fallback: true });
  assert.equal(warnings.length, 2, "one warning per distinct missing source");
  assert.match(warnings[0], /missing\/a\.png/);
  assert.match(warnings[1], /missing\/b\.png/);
  assert.deepEqual(seen, [
    "/missing/a.png",
    fallbackPath,
    "/missing/a.png",
    fallbackPath,
    "/missing/b.png",
    fallbackPath,
  ]);
});

test("existing textures load without the placeholder", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arena-viewer-texture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const warnings = [];
  const load = createTextureLoader({
    loadImage: async (source) => ({ source }),
    createCanvas,
    fallbackPath: join(dir, "fallback.png"),
    warn: (line) => warnings.push(line),
  });

  assert.deepEqual(await load("/tex/entity/steve.png"), {
    source: "/tex/entity/steve.png",
  });
  assert.equal(warnings.length, 0);
});
