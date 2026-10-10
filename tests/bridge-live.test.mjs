import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startLiveBridge } from "../packages/mf-bridge/live.mjs";
function botFixture({ emitEnd = true } = {}) {
  const b = new EventEmitter();
  b.calls = [];
  for (const method of [
    "clearControlStates",
    "stopDigging",
    "deactivateItem",
    "quit",
    "end",
  ])
    b[method] = () => {
      b.calls.push(method);
      if (method === "quit" && emitEnd)
        setTimeout(() => b.emit("end", "closed"), 5);
    };
  return b;
}
const config = {
  minecraft: {
    host: "isolated-fixture.invalid",
    username: "fixture",
    version: "1.21.1",
  },
  bridge: { token: "fixture-secret-token", snapshotRadius: 1 },
  closeTimeoutMs: 40,
};
test("live bridge close quits only owned bot and awaits end, idempotently", async () => {
  const b = botFixture();
  const live = await startLiveBridge({ ...config, createBot: () => b });
  let ended = false;
  b.on("end", () => {
    ended = true;
  });
  await Promise.all([live.close(), live.close()]);
  assert.equal(ended, true);
  assert.deepEqual(b.calls, [
    "clearControlStates",
    "stopDigging",
    "deactivateItem",
    "quit",
  ]);
  assert.equal(live.server.listening, false);
});
test("live cleanup reports timeout and invokes bounded force end", async () => {
  const b = botFixture({ emitEnd: false });
  const live = await startLiveBridge({ ...config, createBot: () => b });
  await assert.rejects(live.close(), /Live bridge cleanup failed/);
  assert.ok(b.calls.includes("quit"));
  assert.ok(b.calls.includes("end"));
  assert.equal(live.server.listening, false);
});
