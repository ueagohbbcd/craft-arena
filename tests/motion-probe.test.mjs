import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createMotionProbe } from "../packages/pi-extension/motion-probe.mjs";

test("the motion probe keys the character's rounded position and inventory", async (t) => {
  const streams = new Set();
  let authorization;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/v1/events");
    authorization = req.headers.authorization;
    res.writeHead(200, { "content-type": "text/event-stream" });
    streams.add(res);
    req.on("close", () => streams.delete(res));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const probe = createMotionProbe({
    url: `http://127.0.0.1:${server.address().port}/`,
    token: "probe-token",
  });
  t.after(() => probe.close());
  const send = (type, x, slots = [null]) => {
    for (const res of streams)
      res.write(
        `data: ${JSON.stringify({ type, data: { entity: { position: { x, y: 64, z: 0 } }, inventory: { slots } } })}\n\n`,
      );
  };
  while (!streams.size) await delay(10);
  assert.equal(probe.key(), undefined);
  send("reset", 10);
  await delay(50);
  const first = probe.key();
  assert.ok(first);
  send("snapshot", 10.4);
  send("chat", 99);
  await delay(50);
  assert.equal(probe.key(), first, "small moves and other events do not count");
  send("snapshot", 13);
  await delay(50);
  const moved = probe.key();
  assert.notEqual(moved, first);
  send("snapshot", 13, [{ type: 1, count: 3 }]);
  await delay(50);
  assert.notEqual(probe.key(), moved, "an inventory change counts");
  assert.equal(authorization, "Bearer probe-token");
  probe.close();
  await delay(50);
  assert.equal(streams.size, 0);
});
