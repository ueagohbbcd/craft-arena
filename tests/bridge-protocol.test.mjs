import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWire,
  wireStringify,
} from "../packages/bridge-protocol/index.mjs";
import { sseData } from "../packages/bridge-protocol/sse.mjs";
import { connectBot } from "../packages/bot-sdk/index.mjs";

const encode = (text) => new TextEncoder().encode(text);
const stream = (chunks) => ReadableStream.from(chunks);
const collect = async (chunks) => Array.fromAsync(sseData(stream(chunks)));

test("wire values preserve nested BigInts and leave unrecognized tags as data", () => {
  const value = { values: [0n, -123n, { id: 2n ** 64n }], plain: null };
  assert.deepEqual(parseWire(wireStringify(value)), value);
  for (const tag of [
    { $arenaBigInt: "1", other: true },
    { $arenaBigInt: "1.2" },
    { $arenaBigInt: "9".repeat(81) },
    { $arenaBigInt: 1 },
  ])
    assert.deepEqual(parseWire(JSON.stringify(tag)), tag);
});

for (const newline of ["\n", "\r\n", "\r"]) {
  test(`SSE handles ${JSON.stringify(newline)}, UTF-8 and arbitrary chunk boundaries`, async () => {
    const bytes = encode(
      [
        ": heartbeat",
        "event: state",
        "data: 羊毛",
        "data:  second",
        "",
        "data:done",
        "",
        "data: incomplete",
      ].join(newline),
    );
    for (let split = 0; split <= bytes.length; split++) {
      assert.deepEqual(
        await collect([bytes.slice(0, split), bytes.slice(split)]),
        ["羊毛\n second", "done"],
      );
    }
    assert.deepEqual(
      await collect(Array.from(bytes, (byte) => Uint8Array.of(byte))),
      ["羊毛\n second", "done"],
    );
    assert.deepEqual(
      await collect([encode(`data: final${newline}${newline}`)]),
      ["final"],
    );
  });
}

test("SSE ignores comments and metadata but preserves empty data events", async () => {
  assert.deepEqual(
    await collect([encode(": ping\n\nid: 1\n\ndata\n\ndata:\n\n")]),
    ["", ""],
  );
});

test("leaving an SSE iteration cancels the underlying response", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encode("data: first\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const data of sseData(body)) {
    assert.equal(data, "first");
    break;
  }
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("SDK accepts SSE metadata and CRLF through the shared parser", async () => {
  const bot = await connectBot({
    url: "http://bridge",
    loadRegistry: false,
    fetchImpl: async () =>
      new Response(
        stream([
          encode(
            'event: update\r\ndata:{"epoch":null,"sequence":0,"type":"connected","data":null}\r\n\r\n',
          ),
        ]),
      ),
  });
  bot.closeBridge();
  await bot.transport;
  assert.equal(bot.closed, true);
});
