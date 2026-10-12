import test from "node:test";
import assert from "node:assert/strict";
test("Arena exposes the same optional tree query for ordinary control code", async () => {
  const sharedQueries = await import("mineflayer-world-memory/queries.mjs");
  const queries = await import("../packages/observation/queries.mjs");
  assert.equal(queries.queryTreeCandidate, sharedQueries.queryTreeCandidate);
  const result = queries.queryTreeCandidate({
    blockAt: ({ x, y, z }) => ({
      name: x === 0 && y === 0 && z === 0 ? "oak_log" : "air",
    }),
    seed: { x: 0, y: 0, z: 0 },
  });
  assert.equal(result.status, "candidate");
  assert.equal(result.logs.length, 1);
  assert.ok(
    result.uncertainty.some(
      (item) => item.code === "artificial_structure_possible",
    ),
  );
});
