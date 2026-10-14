import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { startBridge } from "../packages/mf-bridge/index.mjs";

const token = "backpressure-test-token";
const budget = 4 * 1024 * 1024;
function fixture() {
  return Object.assign(new EventEmitter(), {
    version: "1.21.1",
    username: "backpressure",
    entity: { id: 1, position: { x: 0.5, y: 1, z: 0.5 } },
    entities: {},
    inventory: { slots: [] },
    game: { minY: -64, height: 384, dimension: "overworld" },
    health: 20,
    world: {
      getColumns: () => [
        { chunkX: 0, chunkZ: 0 },
        { chunkX: 100, chunkZ: -100 },
      ],
    },
    blockAt: (position) => ({
      position,
      stateId: 1,
      type: 1,
      name: "polished_blackstone_brick_stairs",
      light: 0,
      skyLight: 15,
      hardness: 3.5,
      diggable: true,
      shapes: [
        [0, 0, 0, 1, 0.5, 1],
        [0, 0.5, 0.5, 1, 1, 1],
      ],
      boundingBox: "block",
    }),
  });
}

async function setup(t) {
  const bot = fixture();
  const bridge = await startBridge({
    bot,
    token,
    snapshotRadius: 24,
    getMatchState: () => ({ state: "running" }),
  });
  t.after(() => bridge.close());
  const responses = [];
  bridge.server.on("request", (req, res) => {
    if (req.url === "/v1/events") responses.push(res);
  });
  const response = await new Promise((resolve, reject) => {
    const request = http.get(`${bridge.url}/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    request.once("error", reject);
    request.once("response", resolve);
    t.after(() => request.destroy());
  });
  // This is a real HTTP client with a stopped receive window, not a mocked
  // writableLength or write() return value.
  response.pause();
  response.on("error", () => {});
  const serverResponse = responses[0];
  assert.equal(response.statusCode, 200);
  assert.equal(
    serverResponse.destroyed,
    false,
    "the large reset stays connected",
  );
  assert.ok(serverResponse.writableNeedDrain);
  assert.ok(serverResponse.writableLength > budget);
  return { bot, bridge, response, serverResponse };
}

function frameReader(response) {
  let pending = "",
    failure,
    notify;
  const frames = [];
  response.setEncoding("utf8");
  response.on("error", (error) => {
    failure = error;
    notify?.();
  });
  response.on("end", () => {
    failure = new Error("SSE ended before marker");
    notify?.();
  });
  response.on("data", (chunk) => {
    try {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const text = pending.slice(0, end);
        pending = pending.slice(end + 2);
        assert.ok(text.startsWith("data: "));
        frames.push(JSON.parse(text.slice(6)));
      }
    } catch (error) {
      failure = error;
    }
    notify?.();
  });
  response.resume();
  return async (marker) => {
    for (;;) {
      if (failure) throw failure;
      const index = frames.findIndex(
        (frame) =>
          frame.data?.name === "messagestr" && frame.data.args[0] === marker,
      );
      if (index >= 0) return frames.splice(0, index + 1);
      await new Promise((resolve) => {
        notify = resolve;
      });
    }
  };
}

test(
  "large initial reset drains intact and queued snapshots/events recover in sequence",
  { timeout: 10000 },
  async (t) => {
    const { bot, response, serverResponse } = await setup(t);
    // Let the real 20 Hz timer queue its next full terrain sample and updates
    // behind the >4 MiB initial reset while the client is not reading.
    await delay(200);
    assert.equal(serverResponse.destroyed, false);
    assert.ok(serverResponse.writableNeedDrain);
    bot.health = 15;
    bot.emit("health");
    bot.emit("messagestr", "before-second-health", "chat");
    bot.health = 14;
    bot.emit("health");
    bot.emit("messagestr", "read-complete", "chat");

    const readThrough = frameReader(response);
    const frames = await readThrough("read-complete");
    assert.equal(frames[0].type, "reset");
    assert.ok(Buffer.byteLength(JSON.stringify(frames[0])) > budget);
    assert.equal(frames[0].data.blocks.length, 49 * 9 * 49);
    assert.deepEqual(frames[0].data.columns, [
      { x: 0, z: 0 },
      { x: 100, z: -100 },
    ]);
    assert.ok(
      frames.some(
        (frame) => frame.type === "snapshot" && frame.data.replaceBlocks,
      ),
    );
    for (let i = 1; i < frames.length; i++) {
      assert.equal(frames[i].epoch, frames[0].epoch);
      assert.equal(frames[i].sequence, frames[i - 1].sequence + 1);
    }
    const observations = [];
    let health;
    for (const frame of frames) {
      if (frame.type === "snapshot" || frame.type === "reset")
        health = frame.data.health;
      if (frame.data?.name === "health") observations.push(["health", health]);
      if (frame.data?.name === "messagestr")
        observations.push([frame.data.args[0], health]);
    }
    assert.deepEqual(observations, [
      ["health", 15],
      ["before-second-health", 15],
      ["health", 14],
      ["read-complete", 14],
    ]);
    assert.equal(serverResponse.destroyed, false);

    // Reading can continue on the same stream after the backlog has drained.
    const next = readThrough("live-again");
    bot.emit("messagestr", "live-again", "chat");
    const resumed = await next;
    assert.equal(resumed[0].sequence, frames.at(-1).sequence + 1);
    assert.equal(resumed.at(-1).data.args[0], "live-again");
  },
);

test(
  "a continuously stalled reader stays bounded and only that connection is closed",
  { timeout: 10000 },
  async (t) => {
    const { bot, bridge, response, serverResponse } = await setup(t);
    const errors = [];
    bridge.server.on("clientError", (error, socket) => {
      errors.push(error);
      socket.destroy();
    });
    // Unicode makes byte accounting differ from JavaScript string length.
    const payload = "雪".repeat((64 * 1024) / 4);
    let published = 0;
    while (!serverResponse.destroyed && published < 200) {
      bot.emit("messagestr", `${published++}:${payload}`, "chat");
    }
    assert.ok(published > 70, "ordinary queued events fit within the budget");
    assert.ok(
      published < 100,
      "backlog bytes, rather than character count, are bounded",
    );
    assert.equal(serverResponse.destroyed, true);
    await delay(20);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "ERR_BRIDGE_BACKPRESSURE");
    assert.equal(serverResponse.listenerCount("drain"), 0);
    response.destroy();
    const healthy = await fetch(`${bridge.url}/v1/session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.deepEqual(await healthy.json(), {
      ok: true,
      result: { state: "running" },
    });
  },
);

test(
  "default overload handling and shutdown remove stalled drain listeners",
  { timeout: 10000 },
  async (t) => {
    const { bot, bridge, response, serverResponse } = await setup(t);
    // No clientError/error listener is installed on the server or its response:
    // destroying an over-budget response must not become an unhandled error.
    for (let i = 0; i < 100 && !serverResponse.destroyed; i++)
      bot.emit("messagestr", "x".repeat(64 * 1024), "chat");
    assert.equal(serverResponse.destroyed, true);
    await delay(20);
    assert.equal(serverResponse.listenerCount("drain"), 0);
    response.destroy();

    const stalled = await setup(t);
    stalled.bot.emit("messagestr", "queued at shutdown", "chat");
    const closed = once(stalled.serverResponse, "close");
    await stalled.bridge.close();
    await closed;
    assert.equal(stalled.serverResponse.destroyed, true);
    assert.equal(stalled.serverResponse.listenerCount("drain"), 0);
    stalled.response.destroy();
    assert.equal(bridge.server.listening, true);
  },
);
