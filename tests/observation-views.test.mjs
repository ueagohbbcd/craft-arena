import test from "node:test";
import assert from "node:assert/strict";
import { Vector } from "../packages/bot-sdk/index.mjs";
import { observe } from "../packages/observation/observe.mjs";
import { registerObserveTool } from "../packages/pi-extension/observe-tool.mjs";
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
test("observe returns current state and observation time", async () => {
  const result = await observe(fakeBot());
  assert.equal(result.state.self.health, 20);
  assert.equal(result.state.inventory.items[0].count, 3);
  assert.equal(result.metadata.sequence, 17);
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
