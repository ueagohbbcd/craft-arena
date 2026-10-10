import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  servePrismarineSnapshot,
  capturePrismarineSnapshot,
} from "../packages/world-visual/prismarine.mjs";
import { fixtureWorld } from "../examples/fixture-world.mjs";
const require = createRequire(import.meta.url);
let deps = true;
try {
  require.resolve("prismarine-viewer");
  require.resolve("socket.io-client");
} catch {
  deps = false;
}
test(
  "genuine viewer serves local assets and actual selected chunk state over socket",
  { skip: !deps },
  async () => {
    const server = await servePrismarineSnapshot(fixtureWorld());
    let socket;
    try {
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:/);
      const meta = await (
        await fetch(server.url + "snapshot-metadata.json")
      ).json();
      assert.equal(meta.knownFraction, 240 / 256);
      assert.match(await (await fetch(server.url)).text(), /Prismarine Viewer/);
      const { io } = require("socket.io-client");
      socket = io(server.url, {
        autoConnect: false,
        transports: ["websocket"],
      });
      const chunk = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("chunk not received")),
          5000,
        );
        socket.once("loadChunk", (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      socket.connect();
      const c = await chunk;
      assert.equal(c.x, 0);
      assert.equal(c.z, 0);
      assert.ok(c.chunk);
      const Chunk = require("prismarine-chunk")("1.20.4"),
        { Vec3 } = require("vec3"),
        mcData = require("minecraft-data")("1.20.4");
      const decoded = Chunk.fromJson(c.chunk);
      assert.equal(
        mcData.blocksByStateId[decoded.getBlockStateId(new Vec3(3, 5, 4))].name,
        "yellow_wool",
      );
    } finally {
      socket?.disconnect();
      await server.close();
    }
  },
);
test(
  "genuine viewer rejects mismatched block IDs and missing version",
  { skip: !deps },
  async () => {
    await assert.rejects(
      servePrismarineSnapshot({ ...fixtureWorld(), version: null }),
      /version/,
    );
    const snapshot = fixtureWorld();
    snapshot.blocks[0].stateId = 0;
    await assert.rejects(servePrismarineSnapshot(snapshot), /Invalid stateId/);
  },
);
test(
  "actual Chromium textured PNG capture (opt-in environment with Chromium process permissions)",
  { skip: !deps || process.env.MC_TEST_CHROMIUM !== "1" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "visual-chromium-"));
    try {
      const result = await capturePrismarineSnapshot(fixtureWorld(), {
        outputPath: join(dir, "view.png"),
        width: 320,
        height: 240,
      });
      const png = await readFile(result.imagePath);
      assert.equal(png.readUInt32BE(16), 320);
      assert.equal(png.readUInt32BE(20), 240);
      assert.ok(png.length > 3000);
      assert.equal(result.metadata.kind, "prismarine-viewer-textured-snapshot");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("textured capture shares the pixel resource budget before starting Chromium", async () => {
  await assert.rejects(
    capturePrismarineSnapshot(fixtureWorld(), {
      outputPath: "unused.png",
      width: 8192,
      height: 8192,
    }),
    /16,777,216 pixels/,
  );
});
