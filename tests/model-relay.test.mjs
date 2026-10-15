import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import {
  createModelRelay,
  parseUpstream,
} from "../packages/model-relay/index.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
/** Upstream fixture that records each request and streams two chunks. */
async function upstreamFixture(t) {
  const seen = [];
  let release;
  const second = new Promise((resolve) => (release = resolve));
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(201, {
      "content-type": "text/event-stream",
      "x-upstream": "kept",
    });
    res.write("data: first\n\n");
    await second;
    res.end("data: second\n\n");
  });
  const url = await listen(server);
  t.after(() => close(server));
  return { seen, url, release };
}
async function relayFor(t, options) {
  const relay = createModelRelay(options);
  const url = await listen(relay);
  t.after(() => close(relay));
  return url;
}

test("relay forwards below the upstream base, streams, and swaps in its own key", async (t) => {
  const upstream = await upstreamFixture(t);
  const relay = await relayFor(t, {
    upstream: `${upstream.url}/v1/`,
    apiKey: "relay-held-key",
  });
  const response = await fetch(`${relay}/chat/completions?stream=1`, {
    method: "POST",
    headers: {
      authorization: "Bearer participant-value",
      "content-type": "application/json",
      "proxy-authorization": "Basic should-not-leave",
    },
    body: JSON.stringify({ model: "m" }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-upstream"), "kept");
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(
    first,
    "data: first\n\n",
    "the first chunk arrives before the end",
  );
  upstream.release();
  let rest = "";
  for (let chunk; !(chunk = await reader.read()).done;)
    rest += new TextDecoder().decode(chunk.value);
  assert.equal(rest, "data: second\n\n");
  const [seen] = upstream.seen;
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/v1/chat/completions?stream=1");
  assert.equal(seen.body, '{"model":"m"}');
  assert.equal(seen.headers.authorization, "Bearer relay-held-key");
  assert.equal(seen.headers["proxy-authorization"], undefined);
  assert.equal(seen.headers.host, new URL(upstream.url).host);
});

test("without a key the caller's own credential passes through", async (t) => {
  const upstream = await upstreamFixture(t);
  upstream.release();
  const relay = await relayFor(t, { upstream: upstream.url });
  await (
    await fetch(`${relay}/models`, {
      headers: { authorization: "Bearer caller-key" },
    })
  ).text();
  assert.equal(upstream.seen[0].url, "/models");
  assert.equal(upstream.seen[0].headers.authorization, "Bearer caller-key");
});

test("an absolute or scheme-relative request target cannot leave the upstream", async (t) => {
  const upstream = await upstreamFixture(t);
  upstream.release();
  const relay = await relayFor(t, { upstream: `${upstream.url}/v1` });
  const { port } = new URL(relay);
  for (const target of [
    "//elsewhere.invalid/x",
    "http://elsewhere.invalid/y",
  ]) {
    const socket = net.connect(port, "127.0.0.1");
    socket.write(
      `GET ${target} HTTP/1.1\r\nHost: elsewhere.invalid\r\nConnection: close\r\n\r\n`,
    );
    let reply = "";
    for await (const chunk of socket) reply += chunk;
    assert.match(reply, /^HTTP\/1\.1 201/);
  }
  assert.deepEqual(
    upstream.seen.map((r) => r.url),
    ["/v1/x", "/v1/y"],
  );
});

test("an unreachable upstream is a 502, not a crash", async (t) => {
  const spare = http.createServer();
  const url = await listen(spare);
  await close(spare);
  const relay = await relayFor(t, { upstream: url });
  const response = await fetch(`${relay}/chat/completions`, { method: "POST" });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /Model upstream unavailable/);
});

test("the upstream URL must be a plain HTTP(S) base", () => {
  for (const bad of [
    undefined,
    "relative/v1",
    "ftp://host/v1",
    "http://user:pass@host/v1",
    "http://host/v1?x=1",
  ])
    assert.throws(() => parseUpstream(bad), /MODEL_RELAY_UPSTREAM/);
  assert.equal(
    parseUpstream("https://api.example/v1/").href,
    "https://api.example/v1/",
  );
});

test(
  "an upstream that dies mid-body ends the caller's response",
  { timeout: 5000 },
  async (t) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: partial\n\n");
      setTimeout(() => res.socket.destroy(), 20);
    });
    const url = await listen(server);
    t.after(() => close(server));
    const relay = await relayFor(t, { upstream: url });
    const response = await fetch(`${relay}/chat/completions`, {
      method: "POST",
    });
    await assert.rejects(response.text());
  },
);

test("headers named in Connection are not forwarded", async (t) => {
  const upstream = await upstreamFixture(t);
  upstream.release();
  const relay = await relayFor(t, { upstream: upstream.url });
  const { port } = new URL(relay);
  const socket = net.connect(port, "127.0.0.1");
  socket.write(
    "GET /models HTTP/1.1\r\nHost: x\r\nConnection: close, x-hop\r\nX-Hop: secret\r\nX-Kept: yes\r\n\r\n",
  );
  for await (const _ of socket);
  assert.equal(upstream.seen[0].headers["x-hop"], undefined);
  assert.equal(upstream.seen[0].headers["x-kept"], "yes");
});

test("a target URL cannot parse is a 400, and the relay keeps serving", async (t) => {
  const upstream = await upstreamFixture(t);
  upstream.release();
  const relay = await relayFor(t, { upstream: upstream.url });
  const { port } = new URL(relay);
  const socket = net.connect(port, "127.0.0.1");
  socket.write("GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  let reply = "";
  for await (const chunk of socket) reply += chunk;
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.equal(upstream.seen.length, 0);
  assert.equal((await fetch(`${relay}/models`)).status, 201);
});
