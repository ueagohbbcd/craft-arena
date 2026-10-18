import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createMotionProbe } from "../packages/bot-host/motion-probe.mjs";

test("the motion probe keys native status position and inventory", async (t) => {
  let bot;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      assert.equal(request.type, "status");
      socket.end(`${JSON.stringify({ type: "status", bot })}\n`);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const probe = createMotionProbe({
    socketPath: { host: "127.0.0.1", port: server.address().port },
    intervalMs: 10,
  });
  t.after(() => probe.close());

  const waitForKey = async (previous) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const key = probe.key();
      if (key && key !== previous) return key;
      await delay(10);
    }
    assert.fail("motion probe did not observe the updated native status");
  };

  assert.equal(probe.key(), undefined);
  bot = {
    position: { x: 10, y: 64, z: 0 },
    inventory: "empty",
    health: 20,
    food: 20,
  };
  const first = await waitForKey();

  bot.position.x = 10.4;
  await delay(30);
  assert.equal(probe.key(), first, "small moves do not count");

  bot.position.x = 13;
  const moved = await waitForKey(first);
  assert.notEqual(moved, first);

  bot.inventory = "slot 1: 3 items";
  const inventoryChanged = await waitForKey(moved);
  assert.notEqual(inventoryChanged, moved, "an inventory change counts");
});
