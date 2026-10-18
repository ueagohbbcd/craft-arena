import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { compatibleMinecraftOptions } from "../packages/bot-host/minecraft-compat.mjs";
const require = createRequire(import.meta.url);
const loadData = require("minecraft-data");
const originalProtocol = structuredClone(loadData("1.21").protocol);

test("protocol 767 recipe serializer IDs decode without obsolete banner recipe", () => {
  const options = compatibleMinecraftOptions({ version: "1.21" });
  assert.deepEqual(loadData("1.21").protocol, originalProtocol);
  const {
    createDeserializer,
  } = require("minecraft-protocol/src/transforms/serializer");
  // Shield decoration (11), smelting (15), decorated pot (22).
  const packet = Buffer.from([
    0x77, 3, 1, 97, 11, 0, 1, 98, 15, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 99, 22, 0,
  ]);
  const parsed = createDeserializer({
    state: "play",
    ...options,
  }).parsePacketBuffer(packet);
  assert.equal(parsed.metadata.size, packet.length);
  assert.deepEqual(
    parsed.data.params.recipes.map((recipe) => recipe.type),
    [
      "minecraft:crafting_special_shielddecoration",
      "minecraft:smelting",
      "minecraft:crafting_decorated_pot",
    ],
  );
  const secondOptions = compatibleMinecraftOptions({ version: "1.21" });
  const second = createDeserializer({
    state: "play",
    ...secondOptions,
  }).parsePacketBuffer(packet);
  assert.deepEqual(second.data, parsed.data);
  assert.equal(second.metadata.size, packet.length);
});

test("compatibility leaves other versions, corrected schemas and explicit overrides unchanged", () => {
  const other = { version: "1.21.2" };
  assert.equal(compatibleMinecraftOptions(other), other);
  const explicit = {
    version: "1.21",
    customPackets: {
      1.21: {
        play: { toClient: { types: { packet_declare_recipes: ["void"] } } },
      },
    },
  };
  assert.equal(compatibleMinecraftOptions(explicit), explicit);
  const data = loadData("1.21");
  const fixed = {
    version: data.version,
    protocol: structuredClone(originalProtocol),
  };
  const mapper =
    fixed.protocol.play.toClient.types.packet_declare_recipes[1][0].type[1]
      .type[1][1].type[1].mappings;
  delete mapper[11];
  const options = { version: "1.21" };
  assert.equal(
    compatibleMinecraftOptions(options, () => fixed),
    options,
  );
});

test("explicit 1.21.1 alias gets the exact protocol-767 correction before parser caching", () => {
  // Each process has an independent minecraft-protocol parser cache. A previous
  // 1.21 test must not mask the real 1.21.1 startup regression.
  const source = `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { compatibleMinecraftOptions } from "./packages/bot-host/minecraft-compat.mjs";
    const require = createRequire(import.meta.url);
    const loadData = require("minecraft-data");
    const original = structuredClone(loadData("1.21.1").protocol);
    const options = compatibleMinecraftOptions({version:"1.21.1"});
    assert.equal(options.version, "1.21.1");
    assert(options.customPackets["1.21"].play.toClient.types.arenaRecipeSerializer767);
    assert.deepEqual(loadData("1.21.1").protocol, original);
    const {createDeserializer} = require("minecraft-protocol/src/transforms/serializer");
    const packet = Buffer.from([0x77,3,1,97,11,0,1,98,15,0,0,0,0,0,0,0,0,1,1,99,22,0]);
    const parsed = createDeserializer({state:"play", ...options}).parsePacketBuffer(packet);
    assert.equal(parsed.metadata.size, packet.length);
    assert.deepEqual(parsed.data.params.recipes.map(recipe=>recipe.type), [
      "minecraft:crafting_special_shielddecoration", "minecraft:smelting", "minecraft:crafting_decorated_pot"
    ]);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: new URL("..", import.meta.url),
    stdio: "pipe",
  });
});
