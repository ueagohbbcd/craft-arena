import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { parseMatch, runCli } from "../packages/arena/src/cli.mjs";
import { RconClient } from "../packages/arena/src/rcon.mjs";
import {
  runCommands,
  validateServerConfig,
} from "../packages/arena/src/server-protocol.mjs";
import { fakeServer } from "./helpers/fake-server.mjs";

const match = {
  config: {
    sessionId: "fixture",
    kind: "match",
    durationMs: 60000,
    briefing: "Place your wool.",
    teams: [
      { id: "red", players: ["arena_red1"] },
      { id: "blue", players: ["arena_blue1"] },
    ],
  },
  commands: {
    prepare: ["gamerule doMobSpawning false"],
    start: [{ command: "tp arena_red1 0 64 0", expect: "Teleported" }],
    stop: ["gamerule doMobSpawning false"],
  },
};
const cli = (s, args, files = { "match.json": JSON.stringify(match) }) =>
  runCli(args, {
    rcon: s.rcon(),
    read: async (path) => files[path],
    newRunId: () => "run-1",
  });

test("prepare writes arena:config, runs the prepare commands, then #arena:prepare", async () => {
  const s = fakeServer();
  assert.deepEqual(await cli(s, ["prepare", "match.json"]), {
    phase: "prepare",
    sessionId: "fixture",
    runId: "run-1",
  });
  assert.deepEqual(s.commands, [
    "data remove storage arena:config durationMs",
    "data remove storage arena:config briefing",
    "data remove storage arena:config runId",
    'data merge storage arena:config {version:1,kind:"match",teams:[{id:"red",players:["arena_red1"]},{id:"blue",players:["arena_blue1"]}],runId:"run-1",sessionId:"fixture",durationMs:60000,briefing:"Place your wool."}',
    "data get storage arena:config",
    "gamerule doMobSpawning false",
    "function #arena:prepare",
  ]);
});

test("start runs its commands before the tag; stop runs the tag first", async () => {
  const s = fakeServer();
  s.replies["tp arena_red1 0 64 0"] = "Teleported arena_red1 to 0, 64, 0";
  await cli(s, ["start", "match.json"]);
  await cli(s, ["stop", "match.json"]);
  await cli(s, ["stop"]);
  assert.deepEqual(s.commands, [
    "tp arena_red1 0 64 0",
    "function #arena:start",
    "function #arena:stop",
    "gamerule doMobSpawning false",
    "function #arena:stop",
  ]);
  s.replies["tp arena_red1 0 64 0"] = "No player was found";
  await assert.rejects(cli(s, ["start", "match.json"]), /Unexpected reply/);
  assert.notEqual(s.commands.at(-1), "function #arena:start");
});

test("status reads arena:session and command passes text through", async () => {
  const s = fakeServer();
  s.session = '{version:1,state:"running",winner:"",scores:{red:1}}';
  assert.deepEqual(await cli(s, ["status"]), {
    state: "running",
    winner: null,
    scores: { red: 1 },
    public: null,
    message: null,
  });
  s.replies["say Five minutes left"] = "";
  assert.deepEqual(
    await cli(s, ["command", "say", "Five", "minutes", "left"]),
    {
      reply: "",
    },
  );
  assert.deepEqual(await cli(s, ["check", "match.json"]), { valid: true });
  await assert.rejects(cli(s, ["prepare"]), /Usage/);
  await assert.rejects(cli(s, ["simulate"]), /Usage/);
});

test("a missing datapack tag or a rejected config fails", async () => {
  const s = fakeServer();
  s.replies["function #arena:prepare"] =
    "Can't find any functions for name arena:prepare";
  await assert.rejects(
    cli(s, ["prepare", "match.json"]),
    /install the arena datapack/,
  );
  s.replies["function #arena:prepare"] = "Running function x:prepare";
  s.config = "{}";
  for (const c of s.commands.splice(0))
    if (c.startsWith("data merge")) s.replies[c] = "Invalid tag";
  await assert.rejects(
    cli(s, ["prepare", "match.json"]),
    /arena:config was not written: .*sessionId/,
  );
});

test("another RCON client's output mixed into replies does not fail a run", async () => {
  // Vanilla RCON shares one output buffer between connections, so a bridge's
  // empty fence command can add its error to the CLI's reply.
  const noise = "Unknown or incomplete command, see below for error<--[HERE]";
  const s = fakeServer();
  const merge = s.rcon().command;
  const rcon = s.rcon();
  rcon.command = async function (c) {
    const reply = await merge.call(this, c);
    if (c === "data get storage arena:config")
      return `${noise}${reply}${noise}`;
    return `${reply}${noise}`;
  };
  s.rcon = () => rcon;
  s.commands.length = 0;
  assert.deepEqual(await cli(s, ["prepare", "match.json"]), {
    phase: "prepare",
    sessionId: "fixture",
    runId: "run-1",
  });
  assert.equal(s.commands.at(-1), "function #arena:prepare");
});

test("match files and arena:config values are checked", () => {
  assert.deepEqual(validateServerConfig(match.config), []);
  assert.deepEqual(
    validateServerConfig({ sessionId: "open-1", kind: "open" }),
    [],
  );
  const errors = validateServerConfig({
    sessionId: "bad id",
    kind: "race",
    durationMs: 0,
    briefing: 1,
    teams: [
      { id: "draw", players: [] },
      { id: "red" },
      { id: "red", players: [] },
    ],
  });
  for (const pattern of [
    /sessionId/,
    /kind/,
    /durationMs/,
    /briefing/,
    /draw/,
    /red players/,
    /twice/,
  ])
    assert.ok(
      errors.some((e) => pattern.test(e)),
      String(pattern),
    );
  assert.throws(
    () => parseMatch(JSON.stringify({ ...match, commands: { end: [] } })),
    /unknown command phase end/,
  );
  assert.throws(() => parseMatch("{}"), /arena:config must be an object/);
});

test("shipped match files parse", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const name of [
    "match.live.template.json",
    "windows-local/match.direct-fire.json",
  ])
    parseMatch(
      await readFile(new URL(`../infra/${name}`, import.meta.url), "utf8"),
    );
});

test("an expect does not fail on a reply lost to another RCON client", async () => {
  const s = fakeServer();
  const list = [{ command: "tp arena_red1 0 64 0", expect: "Teleported" }];
  for (const lost of [
    "",
    "Storage arena:session has the following contents: {}",
  ]) {
    s.replies["tp arena_red1 0 64 0"] = lost;
    await runCommands(s.rcon(), list);
  }
  s.replies["tp arena_red1 0 64 0"] = "Unknown or incomplete command";
  await assert.rejects(runCommands(s.rcon(), list), /Unexpected reply/);
});

test("runCommands refuses empty commands", async () => {
  await assert.rejects(runCommands(fakeServer().rcon(), [""]), /non-empty/);
});

const packet = (id, type, text) => {
  const b = Buffer.from(text),
    p = Buffer.alloc(b.length + 14);
  p.writeInt32LE(b.length + 10);
  p.writeInt32LE(id, 4);
  p.writeInt32LE(type, 8);
  b.copy(p, 12);
  return p;
};
test("real local TCP RCON handshake, split packets and fenced command responses", async (t) => {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (c) => {
      buffer = Buffer.concat([buffer, c]);
      while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
        const len = buffer.readInt32LE(0),
          p = buffer.subarray(0, len + 4);
        buffer = buffer.subarray(len + 4);
        const id = p.readInt32LE(4),
          type = p.readInt32LE(8),
          body = p.toString("utf8", 12, p.length - 2);
        if (type === 3) {
          const out = packet(body === "operator-password" ? id : -1, 2, "");
          socket.write(out.subarray(0, 5));
          socket.write(out.subarray(5));
        } else {
          socket.write(packet(id, 0, body ? "part1" : "Unknown command"));
          if (body) socket.write(packet(id, 0, "part2"));
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new RconClient({
    host: "127.0.0.1",
    port: server.address().port,
    password: "operator-password",
  });
  t.after(() => {
    client.close();
    server.close();
  });
  await client.connect();
  assert.equal(await client.command("say fixture"), "part1part2");
});

test("RCON waits for command response before sending its fence", async (t) => {
  let earlyFence = false;
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0),
      commandPending = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
        const length = buffer.readInt32LE(0) + 4;
        const request = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        const id = request.readInt32LE(4),
          type = request.readInt32LE(8);
        const body = request.toString("utf8", 12, length - 2);
        if (type === 3) socket.write(packet(id, 2, ""));
        else if (body) {
          commandPending = true;
          setTimeout(() => {
            commandPending = false;
            socket.write(
              Buffer.concat([packet(id, 0, "first"), packet(id, 0, "second")]),
            );
          }, 20);
        } else {
          if (commandPending) {
            earlyFence = true;
            socket.destroy();
          } else socket.write(packet(id, 0, "Unknown command"));
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new RconClient({
    host: "127.0.0.1",
    port: server.address().port,
    password: "fixture",
    timeoutMs: 1000,
  });
  t.after(() => {
    client.close();
    server.close();
  });
  await client.connect();
  assert.deepEqual(
    await Promise.all([
      client.command("first command"),
      client.command("second command"),
    ]),
    ["firstsecond", "firstsecond"],
  );
  assert.equal(earlyFence, false);
});
