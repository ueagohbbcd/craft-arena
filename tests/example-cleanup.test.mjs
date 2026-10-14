import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Inbox } from "../packages/inbox/index.mjs";
import { TaskManager } from "../packages/tasks/index.mjs";

const fixture = fileURLToPath(
  new URL("./fixtures/example-process.mjs", import.meta.url),
);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const events = (output) =>
  output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

async function cancelExample(t, name, args, env = {}) {
  const tasks = new TaskManager({ inbox: new Inbox() });
  t.after(() => tasks.close());
  const filename = fileURLToPath(
    new URL(`../examples/${name}`, import.meta.url),
  );
  const id = tasks.start(
    `exec ${[process.execPath, fixture, filename, ...args].map(quote).join(" ")}`,
    { env },
  );
  const deadline = Date.now() + 10000;
  while (!tasks.get(id).stdout.toString().includes('"type":"ready"')) {
    assert.equal(tasks.get(id).status, "running");
    assert.ok(Date.now() < deadline, "example must start its action");
    await sleep(10);
  }
  const request = tasks.cancel(id);
  assert.equal(request.status, "cancelling");
  assert.equal(tasks.get(id).status, "running", "request is not exit evidence");
  const result = await tasks.wait(id, { timeoutMs: 3000 });
  assert.equal(result.status, "completed", result.stderr);
  assert.equal(
    result.signal,
    null,
    "cleanup must finish before forced SIGKILL",
  );
  assert.equal(result.exitCode, name === "entity-radar.mjs" ? 0 : 143);
  assert.equal(result.stderr, "");
  const trace = events(result.stdout);
  const closed = trace.at(-1);
  assert.equal(closed.type, "closed");
  assert.equal(
    closed.pending,
    0,
    "release RPCs must settle before bridge close",
  );
  assert.equal(closed.healthListeners, 0);
  assert.equal(closed.pathListeners, 0);
  return { trace, closed };
}

test("managed SIGTERM stops the actual navigation CLI and flushes controls before exit", async (t) => {
  const { trace, closed } = await cancelExample(t, "navigate.mjs", [
    "10",
    "1",
    "0",
  ]);
  assert.equal(closed.controls.forward, false);
  assert.equal(
    closed.controls.sprint,
    false,
    "late old press cannot outlive release",
  );
  assert.ok(trace.some((event) => event.type === "goal.cleared"));
  assert.ok(trace.some((event) => event.type === "controls.released"));
  assert.equal(trace.at(-2).type, "flush.completed");
  assert.ok(!trace.some((event) => event.type === "deferred.stop"));
  assert.ok(!trace.some((event) => event.type === "inbox.post"));
});

for (const slowEquip of [false, true]) {
  test(`managed SIGTERM during ${slowEquip ? "equip" : "eating"} cancels queued build work without changing movement`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "example-cleanup-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const plan = join(directory, "plan.json");
    await writeFile(
      plan,
      JSON.stringify({
        material: "cobblestone",
        steps: [{ against: { x: 0, y: 0, z: 0 }, face: { x: 0, y: 1, z: 0 } }],
      }),
    );
    const { trace, closed } = await cancelExample(
      t,
      "build-with-autoeat.mjs",
      [plan],
      { EXAMPLE_SLOW_EQUIP: slowEquip ? "1" : "0" },
    );
    assert.equal(closed.usingItem, false);
    assert.equal(closed.controls.right, true, "independent movement survives");
    assert.ok(!trace.some((event) => event.type === "controls.released"));
    assert.ok(!trace.some((event) => event.type === "placed"));
    assert.equal(
      trace.filter((event) => event.type === "equipped").length,
      1,
      "queued material equip must never start after cancellation",
    );
    assert.equal(
      trace.filter((event) => event.type === "item.released").length,
      slowEquip ? 0 : 1,
      "release only this program's active use-item action",
    );
    assert.equal(trace.at(-2).type, "flush.completed");
  });
}

test("cancelling the actual read-only radar CLI leaves unrelated movement untouched", async (t) => {
  const { trace, closed } = await cancelExample(t, "entity-radar.mjs", [
    "32",
    "1000",
  ]);
  assert.equal(closed.controls.forward, true);
  assert.ok(!trace.some((event) => event.type === "controls.released"));
  assert.ok(!trace.some((event) => event.type === "goal.cleared"));
});
