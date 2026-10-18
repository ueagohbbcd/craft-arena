import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { connectBot } from "../packages/bot-sdk/index.mjs";

const token = "sdk-stream-reading-token";

// A snapshot in the bridge's own wire shape, listing one loaded column.
async function resetData(t) {
  const native = Object.assign(new EventEmitter(), {
    version: "1.21.1",
    username: "reader",
    entity: { id: 1, position: { x: 0.5, y: 64, z: 0.5 } },
    entities: {},
    inventory: { slots: [] },
    game: { minY: -64, height: 384, dimension: "overworld" },
    health: 20,
    world: { getColumns: () => [{ chunkX: 0, chunkZ: 0 }] },
    blockAt: () => null,
  });
  const service = await startBridge({ bot: native, token });
  t.after(() => service.close());
  return service.authority.snapshot(false);
}

test(
  "the SDK keeps reading the event stream while a reset fetches columns",
  { timeout: 10000 },
  async (t) => {
    const data = await resetData(t);
    assert.equal(data.columns.length, 1);
    let events, releaseChunk;
    const chunkRequested = new Promise((resolve) => {
      releaseChunk = resolve;
    });
    let answerChunk;
    const server = http.createServer((req, res) => {
      if (req.url.startsWith("/v1/events")) {
        events = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ epoch: "e", sequence: 0, type: "reset", data })}\n\n`,
        );
      } else if (req.url.startsWith("/v1/chunk")) {
        // Hold the column until the test has seen the stream drain.
        answerChunk = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, result: null }));
        };
        releaseChunk();
      } else {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const connecting = connectBot({
      url: `http://127.0.0.1:${server.address().port}`,
      token,
    });
    await chunkRequested;
    // While the reset waits on its column, the bridge keeps sending: 16 MiB,
    // far more than socket and fetch buffers hold. The bridge's queue only
    // empties if the client reads concurrently.
    const pad = `: ${"x".repeat(64 * 1024)}\n\n`;
    for (let i = 0; i < 256; i++) events.write(pad);
    assert.ok(events.writableNeedDrain, "the stream filled its send buffer");
    await once(events, "drain");
    answerChunk();
    const bot = await connecting;
    t.after(() => bot.closeBridge());
    assert.equal(bot.username, "reader");
  },
);
