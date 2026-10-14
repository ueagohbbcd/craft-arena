import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { createProxyRelay } from "../packages/system-proxy-relay/index.mjs";

const secret = "test-private-relay-secret";
const auth = `Basic ${Buffer.from(`relay:${secret}`).toString("base64")}`;
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
function tunnel(port, authorization = auth, target = "api.openai.com:443") {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "CONNECT",
      path: target,
      headers: { "Proxy-Authorization": authorization },
    });
    req.on("error", reject);
    req.on("connect", (response, socket) =>
      resolve({ status: response.statusCode, socket }),
    );
    req.end();
  });
}
async function echo(socket, value) {
  const received = once(socket, "data");
  socket.write(value);
  assert.equal((await received)[0].toString(), value);
}
test("fresh resolution follows direct/proxy A/proxy B/direct while existing tunnels stay alive", async () => {
  const echoServer = net.createServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echoServer);
  const seen = [0, 0];
  const proxies = seen.map((_, index) => {
    const proxy = http.createServer();
    proxy.on("connect", (req, socket, head) => {
      seen[index]++;
      assert.equal(req.url, "api.openai.com:443");
      const upstream = net.connect(echoPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      socket.on("close", () => upstream.destroy());
    });
    return proxy;
  });
  const ports = await Promise.all(proxies.map(listen));
  let selection = "";
  let resolutions = 0;
  const relay = createProxyRelay({
    secret,
    resolver: async () => {
      resolutions++;
      return selection;
    },
    connectDirect: () => net.connect(echoPort, "127.0.0.1"),
  });
  const port = await listen(relay);
  const clients = [];
  try {
    for (const next of [
      "",
      `http://127.0.0.1:${ports[0]}`,
      `http://127.0.0.1:${ports[1]}`,
      "",
    ]) {
      selection = next;
      const { status, socket } = await tunnel(port);
      assert.equal(status, 200);
      clients.push(socket);
      for (const client of clients)
        await echo(client, `alive-${clients.length}`);
    }
    assert.equal(resolutions, 4);
    assert.deepEqual(seen, [1, 1]);
    const denied = await tunnel(port, "wrong");
    assert.equal(denied.status, 407);
    denied.socket.destroy();
    const forbidden = await tunnel(port, auth, "example.com:443");
    assert.equal(forbidden.status, 403);
    forbidden.socket.destroy();
    const wrongPort = await tunnel(port, auth, "api.openai.com:80");
    assert.equal(wrongPort.status, 403);
    wrongPort.socket.destroy();
    assert.equal(resolutions, 4);
  } finally {
    clients.forEach((socket) => socket.destroy());
    await relay.closeRelay();
    await Promise.all(
      [...proxies, echoServer].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
  }
});
test("resolution timeout and upstream failures return 502 without exposing details", async () => {
  for (const resolver of [
    async () => {
      throw new Error("private credential");
    },
    () => new Promise(() => {}),
  ]) {
    const relay = createProxyRelay({ secret, resolver, timeoutMs: 30 });
    const port = await listen(relay);
    const result = await tunnel(port);
    assert.equal(result.status, 502);
    result.socket.destroy();
    await relay.closeRelay();
  }
});
test("health requires the independent secret and disconnect cancels resolution", async () => {
  let canceled;
  const cancellation = new Promise((resolve) => {
    canceled = resolve;
  });
  const relay = createProxyRelay({
    secret,
    resolver: (_target, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            canceled();
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  });
  const port = await listen(relay);
  try {
    for (const [authorization, status] of [
      ["", 401],
      [`Bearer ${secret}`, 200],
    ]) {
      const result = await new Promise((resolve, reject) => {
        http
          .get(
            {
              hostname: "127.0.0.1",
              port,
              path: "/health",
              headers: { Authorization: authorization },
            },
            (res) => {
              let body = "";
              res.on("data", (chunk) => {
                body += chunk;
              });
              res.on("end", () => resolve({ status: res.statusCode, body }));
            },
          )
          .on("error", reject);
      });
      assert.equal(result.status, status);
      if (status === 200)
        assert.deepEqual(JSON.parse(result.body), {
          kind: "arena-system-proxy-relay",
        });
    }
    const client = net.connect(port, "127.0.0.1");
    await once(client, "connect");
    client.write(
      `CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\nProxy-Authorization: ${auth}\r\n\r\n`,
    );
    // Wait for delivery, then disconnect during the pending resolver.
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.destroy();
    await cancellation;
  } finally {
    await relay.closeRelay();
  }
});
test("upstream rejection is generic and the relay never forwards its secret", async () => {
  const proxy = http.createServer();
  proxy.on("connect", (req, socket) => {
    assert.equal(
      req.headers["proxy-authorization"],
      `Basic ${Buffer.from("user:upstream-password").toString("base64")}`,
    );
    socket.end("HTTP/1.1 407 Private-upstream-details\r\n\r\n");
  });
  const proxyPort = await listen(proxy);
  const relay = createProxyRelay({
    secret,
    resolver: async () =>
      `http://user:upstream-password@127.0.0.1:${proxyPort}`,
  });
  const port = await listen(relay);
  try {
    const result = await tunnel(port);
    assert.equal(result.status, 502);
    result.socket.destroy();
  } finally {
    await relay.closeRelay();
    await new Promise((resolve) => proxy.close(resolve));
  }
});
test("a client half-close preserves the destination final response", async () => {
  const destination = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.resume();
    socket.on("end", () => socket.end("final-response"));
  });
  const destinationPort = await listen(destination);
  const relay = createProxyRelay({
    secret,
    resolver: async () => "",
    connectDirect: () =>
      net.connect({
        host: "127.0.0.1",
        port: destinationPort,
        allowHalfOpen: true,
      }),
  });
  const port = await listen(relay);
  try {
    const { socket } = await tunnel(port);
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk;
    });
    const ended = once(socket, "end");
    socket.end("request");
    await ended;
    assert.equal(body, "final-response");
    socket.destroy();
  } finally {
    await relay.closeRelay();
    await new Promise((resolve) => destination.close(resolve));
  }
});
