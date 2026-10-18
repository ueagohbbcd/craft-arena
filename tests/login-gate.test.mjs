import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { once } from "node:events";
import { startLoginGate } from "../packages/login-gate/index.mjs";

const require = createRequire(import.meta.url);
const mc = require("minecraft-protocol");
const version = "1.21.1";

async function fakeServer(t) {
  const server = mc.createServer({
    "online-mode": false,
    host: "127.0.0.1",
    port: 0,
    version,
  });
  await once(server, "listening");
  t.after(() => {
    for (const client of Object.values(server.clients)) client.socket.destroy();
    server.close();
  });
  return server;
}

function join(port, username) {
  const client = mc.createClient({
    host: "127.0.0.1",
    port,
    username,
    version,
    auth: "offline",
  });
  return new Promise((resolve) => {
    client.on("state", (state) => {
      if (state === "play") resolve({ client, ok: true });
    });
    client.once("disconnect", (packet) =>
      resolve({ client, ok: false, reason: String(packet.reason) }),
    );
    client.once("end", (reason) => resolve({ client, ok: false, reason }));
    client.once("error", (error) =>
      resolve({ client, ok: false, reason: error.message }),
    );
  });
}

test("the gate admits only its characters, once each, and forwards the game", async (t) => {
  const server = await fakeServer(t);
  const logins = [];
  server.on("login", (client) => {
    logins.push(client.username);
  });
  const lines = [];
  const gate = await startLoginGate({
    host: "127.0.0.1",
    port: 0,
    upstream: { host: "127.0.0.1", port: server.socketServer.address().port },
    usernames: ["arena_red1", "arena_red2"],
    log: (line) => lines.push(line),
  });
  t.after(() => gate.close());

  const first = await join(gate.port, "arena_red1");
  t.after(() => first.client.socket.destroy());
  assert.equal(first.ok, true);
  assert.deepEqual(logins, ["arena_red1"]);
  assert.deepEqual(gate.connections(), ["arena_red1"]);

  const stranger = await join(gate.port, "arena_blue1");
  assert.equal(stranger.ok, false);
  assert.match(stranger.reason, /not a character of this participant/);

  const twice = await join(gate.port, "ARENA_RED1");
  assert.equal(twice.ok, false);
  assert.match(twice.reason, /already connected/);
  assert.deepEqual(logins, ["arena_red1"]);

  first.client.socket.destroy();
  for (let i = 0; i < 50 && gate.connections().length; i++)
    await new Promise((r) => setTimeout(r, 10));
  const again = await join(gate.port, "arena_red1");
  t.after(() => again.client.socket.destroy());
  assert.equal(again.ok, true);
  assert.ok(lines.some((line) => line.includes("arena_blue1")));
});

test("status pings pass through; a bad header is dropped", async (t) => {
  const server = await fakeServer(t);
  const gate = await startLoginGate({
    host: "127.0.0.1",
    port: 0,
    upstream: { host: "127.0.0.1", port: server.socketServer.address().port },
    usernames: ["arena_red1"],
    log: () => {},
  });
  t.after(() => gate.close());
  const status = await mc.ping({ host: "127.0.0.1", port: gate.port, version });
  assert.equal(status.version.name, version);

  const net = await import("node:net");
  const socket = net.connect({ host: "127.0.0.1", port: gate.port });
  socket.on("error", () => {});
  socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x01]));
  await once(socket, "close");
});

test("the session endpoint serves each character its own session", async (t) => {
  const { fakeServer: fakeMinecraft } =
    await import("./helpers/fake-server.mjs");
  const { startSessionEndpoint, gateOptions } =
    await import("../packages/login-gate/cli.mjs");
  const server = fakeMinecraft();
  server.session = '{version:1,state:"running",winner:""}';
  server.config = '{teams:[{id:"red",players:["arena_red1"]}],sessionId:"m1"}';
  const endpoint = await startSessionEndpoint({
    host: "127.0.0.1",
    port: 0,
    usernames: ["arena_red1"],
    rcon: {},
    sessionId: "fallback",
    createRcon: () => server.rcon(),
  });
  t.after(() => endpoint.close());
  const base = `http://127.0.0.1:${endpoint.port}/v1/session`;
  const body = await (await fetch(`${base}?username=ARENA_RED1`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.result.state, "running");
  assert.equal(body.result.teamId, "red");
  assert.equal(body.result.username, "arena_red1");
  assert.equal((await fetch(`${base}?username=arena_blue1`)).status, 404);

  assert.throws(() => gateOptions({ GATE_UPSTREAM_HOST: "mc" }), /USERNAMES/);
  const options = gateOptions({
    GATE_USERNAMES: "a_bot, b_bot",
    GATE_UPSTREAM_HOST: "minecraft",
    GATE_RCON_HOST: "minecraft",
  });
  assert.deepEqual(options.gate.usernames, ["a_bot", "b_bot"]);
  assert.equal(options.session.rcon.port, 25575);
});
