import test from "node:test";
import assert from "node:assert/strict";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { fakeBot } from "./bridge.test.mjs";

const token = "test-token-long-enough";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const released = (b, control) =>
  b.calls.some(
    ([name, c, state]) =>
      name === "setControlState" && c === control && state === false,
  );

async function setup(t, options = {}) {
  const b = fakeBot();
  const service = await startBridge({
    bot: b,
    token,
    snapshotRadius: 1,
    controlReleaseMs: 50,
    ...options,
  });
  t.after(() => service.close());
  const connect = () =>
    connectBot({ url: service.url, token, loadRegistry: false });
  return { b, service, connect };
}

test("a client that dies holding a control has it released", async (t) => {
  const { b, connect } = await setup(t);
  const controller = await connect();
  const listener = await connect();
  t.after(() => listener.closeBridge());
  controller.setControlState("forward", true);
  controller.setControlState("jump", true);
  controller.setControlState("jump", false);
  await controller.flush();
  controller.closeBridge(); // as if the process was killed
  await delay(200);
  assert.ok(released(b, "forward"));
  // Another client's open stream does not keep the dead client's lease.
  assert.equal(listener.closed, false);
});

test("controls stay pressed while the client is connected or reconnects in time", async (t) => {
  const { b, connect } = await setup(t, { controlReleaseMs: 300 });
  const bot = await connect();
  t.after(() => bot.closeBridge());
  bot.setControlState("forward", true);
  await bot.flush();
  await delay(100);
  // Drop the stream like a backpressure disconnect; the SDK reconnects after
  // reconnectDelay (250 ms) with the same client id.
  bot.abort.abort();
  await delay(450);
  assert.equal(released(b, "forward"), false);
});

test("another client's newer press and clearControlStates take the lease", async (t) => {
  const { b, connect } = await setup(t);
  const first = await connect();
  const second = await connect();
  t.after(() => second.closeBridge());
  first.setControlState("forward", true);
  first.setControlState("left", true);
  await first.flush();
  second.setControlState("forward", true);
  await second.flush();
  first.closeBridge();
  await delay(200);
  assert.equal(released(b, "forward"), false);
  assert.ok(released(b, "left"));

  const third = await connect();
  third.setControlState("back", true);
  await third.flush();
  second.clearControlStates();
  await second.flush();
  third.closeBridge();
  const before = b.calls.length;
  await delay(200);
  assert.equal(
    b.calls.slice(before).some(([name]) => name === "setControlState"),
    false,
  );
});

test("requests without a client id keep the old behaviour", async (t) => {
  const { b, service } = await setup(t);
  const res = await fetch(`${service.url}/v1/action`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action: "setControlState",
      args: { control: "forward", state: true },
    }),
  });
  assert.equal(res.status, 200);
  await delay(200);
  assert.equal(released(b, "forward"), false);
});
