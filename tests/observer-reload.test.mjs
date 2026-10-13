import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "../packages/inbox/index.mjs";
import { startPerceptionRuntime } from "../packages/pi-extension/perception-runtime.mjs";

test("workspace observer replacement preserves events, retires old state and survives failed reload", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "arena-observer-"));
  const key = `observer-test-${Date.now()}`;
  const instances = (globalThis[key] = []);
  const inbox = new Inbox({ sessionId: key });
  const runtime = startPerceptionRuntime({
    cwd,
    inbox,
    report() {},
    recentBlocks: { enabled: false },
    tasks: {
      tasks: new Map([
        ["work", { id: "work", status: "running", startedAt: Date.now() }],
      ]),
    },
  });
  t.after(async () => {
    await runtime.close();
    delete globalThis[key];
    await rm(cwd, { recursive: true, force: true });
  });
  const entry = join(cwd, "perception.mjs");
  async function install(marker, throwingClose = false) {
    await writeFile(
      entry,
      `export function createObserver(context) {
      const record = { context, closed: false };
      globalThis[${JSON.stringify(key)}].push(record);
      return {
        sample() { return { marker: ${JSON.stringify(marker)} }; },
        close() { record.closed = true; ${throwingClose ? 'throw new Error("cleanup failed");' : ""} }
      };
    }`,
    );
    return runtime.reload();
  }
  assert.equal((await runtime.sample()).observer.source, "preinstalled");
  await install("first", true);
  const old = instances.at(-1);
  old.context.post({
    kind: "state",
    key: "custom",
    data: { marker: "old-state" },
  });
  old.context.post({ kind: "event", data: { marker: "past-event" } });
  await install("second");
  assert.equal(old.closed, true);
  old.context.post({ kind: "event", data: { marker: "leaked-old-event" } });
  const data = inbox.drain().messages.map((message) => message.data.marker);
  assert.deepEqual(data, ["past-event"]);
  assert.equal((await runtime.sample()).marker, "second");

  await writeFile(
    entry,
    "export function createObserver() { throw new Error('bad module'); }",
  );
  assert.match((await runtime.reload()).error, /bad module/);
  assert.equal((await runtime.sample()).marker, "second");
  assert.equal(instances.at(-1).closed, false);

  await writeFile(
    entry,
    "export function createObserver() { return { sample() {}, close() {}, attachBot() { throw new Error('bad attach'); } }; }",
  );
  assert.match((await runtime.reload()).error, /bad attach/);
  assert.equal((await runtime.sample()).marker, "second");

  await writeFile(
    join(cwd, "perception.json"),
    JSON.stringify({ observer: { enabled: false } }),
  );
  await install("manual-only");
  instances
    .at(-1)
    .context.post({ kind: "event", data: { marker: "disabled" } });
  assert.equal(inbox.drain().messages.length, 0);
  assert.equal((await runtime.sample()).marker, "manual-only");
  const automatic = await runtime.sample({ automatic: true });
  assert.equal(automatic.marker, undefined);
  assert.equal(automatic.tasks[0].taskId, "work");

  await rm(entry);
  await rm(join(cwd, "perception.json"));
  assert.deepEqual(await runtime.reload(), {
    source: "preinstalled",
    reportsEnabled: true,
  });
});
