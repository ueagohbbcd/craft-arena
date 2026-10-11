import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReplayRecorder,
  inspectReplay,
  validateReplay,
} from "../packages/arena/src/replay.mjs";

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "arena-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = {
    id: "test",
    map: { id: "fixture" },
    participants: [
      { id: "red1", username: "arena_red1" },
      { id: "blue1", username: "arena_blue1" },
    ],
    live: {
      minecraft: { version: "1.21.1" },
      readyTimeoutMs: 100,
      replay: {
        configPath: join(directory, "config", "config.json"),
        serverResultsDir: "/server-results",
        saveTimeoutMs: 100,
        ...overrides,
      },
    },
  };
  const commands = [];
  const replies = {
    "replay disable": "ServerReplay is now disabled! Stopped all recordings.",
    "replay stop all": "Successfully stopped all recordings.",
    "replay reload": "Successfully reloaded config.",
    "replay enable": "ServerReplay is now enabled!",
  };
  const rcon = {
    async command(command) {
      commands.push(command);
      if (command.startsWith("replay start players ")) {
        const username = command.split(" ").at(-1);
        const folder = join(directory, "runs", "run-1", "replays", username);
        await mkdir(folder, { recursive: true });
        return "Successfully started 1 recordings";
      }
      return replies[command] ?? "Successfully marked 1 recordings";
    },
  };
  const recorder = createReplayRecorder({
    config,
    runId: "run-1",
    resultDir: directory,
    rcon,
    inspect: async () => ({ sha256: "checked", bytes: 42 }),
  });
  const file = async (username, name = "segment.mcpr") => {
    const folder = join(directory, "runs", "run-1", "replays", username);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, name), "fixture");
    return join(folder, name);
  };
  return { directory, config, recorder, commands, replies, file, rcon };
}

test("replay defaults on, config scopes participants and uses the existing run archive", async (t) => {
  const f = await fixture(t);
  await f.recorder.prepare();
  const config = JSON.parse(
    await readFile(f.config.live.replay.configPath, "utf8"),
  );
  assert.equal(config.enabled, false);
  assert.equal(
    config.player_recording_path,
    "/server-results/runs/run-1/replays",
  );
  assert.equal(config.allow_downloading_replays, false);
  assert.deepEqual(config.player_predicate, {
    type: "has_name",
    names: ["arena_red1", "arena_blue1"],
  });
  assert.deepEqual(config.chunks, []);
  assert.deepEqual(f.commands, [
    "replay disable",
    "replay stop all",
    "replay reload",
  ]);
  await f.recorder.start();
  assert.equal(f.recorder.state.status, "recording");
  assert.ok(!f.commands.includes("replay enable"));
  assert.ok(
    f.commands.includes(
      'replay marker add players arena_red1 "arena:run-1:start"',
    ),
  );
  for (const { username } of f.config.participants) await f.file(username);
  await f.file("arena_red1", "reconnected.mcpr");
  await f.recorder.requestStop();
  await f.recorder.finish();
  assert.equal(f.recorder.state.status, "saved");
  assert.equal(f.recorder.state.files.length, 3);
  assert.ok(
    f.recorder.state.files.every((file) =>
      file.path.startsWith("runs/run-1/replays/"),
    ),
  );
  const count = f.commands.length;
  await f.recorder.requestStop();
  assert.equal(f.commands.length, count);
});

test("disabled replay touches neither disk nor RCON", async (t) => {
  const f = await fixture(t, { enabled: false });
  await f.recorder.prepare();
  await f.recorder.start();
  await f.recorder.requestStop();
  await f.recorder.finish();
  assert.deepEqual(f.commands, []);
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal(f.recorder.state.status, "disabled");
});

test("missing mod and unconfirmed individual recorder prevent match start", async (t) => {
  const f = await fixture(t);
  f.replies["replay disable"] = "Unknown command";
  await assert.rejects(f.recorder.prepare(), /acknowledgement/);
  assert.equal(f.recorder.state.status, "failed");
  const other = await fixture(t);
  await other.recorder.prepare();
  other.rcon.command = async (command) =>
    command.startsWith("replay start players")
      ? "Successfully started 1 recordings"
      : "Failed to mark any recordings";
  await assert.rejects(other.recorder.start(), /acknowledgement/);
});

test("save waits for all participants and caches to close; timeout is explicit", async (t) => {
  const f = await fixture(t);
  await f.recorder.prepare();
  await f.recorder.start();
  await f.file("arena_red1");
  await f.file("arena_blue1");
  const cache = await f.file("arena_red1", "segment.cache");
  await f.recorder.requestStop();
  await f.recorder.finish();
  assert.equal(f.recorder.state.status, "failed");
  assert.match(f.recorder.state.error, /save timed out/);
  assert.equal(
    await readFile(cache, "utf8"),
    "fixture",
    "never delete recovery data on failure",
  );
});

test("save does not finish before pending asynchronous output appears", async (t) => {
  const f = await fixture(t, { saveTimeoutMs: 1000 });
  await f.recorder.prepare();
  await f.recorder.start();
  await f.recorder.requestStop();
  const finishing = f.recorder.finish();
  for (const { username } of f.config.participants) await f.file(username);
  await finishing;
  assert.equal(f.recorder.state.status, "saved");
});

test("reused run IDs fail without mingling archives and command targets are validated", async (t) => {
  const f = await fixture(t);
  await f.recorder.prepare();
  const second = createReplayRecorder({
    config: f.config,
    runId: "run-1",
    resultDir: f.directory,
    rcon: f.rcon,
  });
  await assert.rejects(second.prepare(), { code: "EEXIST" });
  f.config.participants[0].username = "@a";
  assert.throws(() => validateReplay(f.config), /usernames/);
});

// Tiny deterministic stored-ZIP fixture; no Java or Minecraft process is started.
function zip(entries) {
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const local = [],
    central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const n = Buffer.from(name),
      data = Buffer.from(value),
      crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    local.push(h, n, data);
    central.push(c, n);
    offset += h.length + n.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test("actual ZIP verification rejects corrupt, empty and wrong-version .mcpr files", async (t) => {
  const f = await fixture(t);
  const path = join(f.directory, "recording.mcpr");
  const entries = {
    "metaData.json": JSON.stringify({
      mcversion: "1.21.1",
      generator: "ServerReplay v1.2.10",
      duration: 123,
    }),
    "recording.tmcpr": "packet",
    "server_replay_meta.json": "{}",
  };
  const valid = zip(entries);
  await writeFile(path, valid);
  const basic = await inspectReplay(path, "1.21.1");
  assert.equal(basic.sha256, undefined);
  assert.equal(basic.packetBytes, undefined);
  const metadata = await inspectReplay(path, "1.21.1", { verify: true });
  assert.equal(metadata.packetBytes, 6);
  assert.equal(metadata.durationMs, 123);
  assert.equal(
    metadata.sha256,
    createHash("sha256").update(valid).digest("hex"),
  );
  await assert.rejects(inspectReplay(path, "1.21"), /metadata/);
  await writeFile(path, zip({ ...entries, "recording.tmcpr": "" }));
  await assert.rejects(
    inspectReplay(path, "1.21.1", { verify: true }),
    /empty/,
  );
  await writeFile(path, valid.subarray(0, -5));
  await assert.rejects(inspectReplay(path, "1.21.1"));
});
