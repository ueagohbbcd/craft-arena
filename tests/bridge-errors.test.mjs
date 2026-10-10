import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { connectBot } from "../packages/bot-sdk/index.mjs";
const require = createRequire(import.meta.url);
const { Vec3 } = require("vec3");
const injectDigging = require("mineflayer/lib/plugins/digging.js");
const nativeGoto = require("mineflayer-pathfinder/lib/goto.js");
const token = "error-test-participant-token";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function nativeDigBot() {
  const bot = new EventEmitter();
  Object.assign(bot, {
    version: "1.21.1",
    game: {},
    entities: {},
    inventory: { slots: [], inventoryStart: 9, inventoryEnd: 45 },
    entity: { id: 1, position: new Vec3(0, 1, 0) },
    _client: { write() {} },
    lookAt: async () => {},
    swingArm() {},
    clearControlStates() {},
    blockAt: (position) => ({ name: "stone", type: 1, stateId: 1, position }),
  });
  injectDigging(bot);
  bot.digTime = () => 60000;
  return bot;
}
async function setup(t, bot = nativeDigBot(), options = {}) {
  const bridge = await startBridge({
    bot,
    token,
    snapshotRadius: 0,
    ...options,
  });
  t.after(async () => {
    bot.stopDigging();
    await bridge.close();
  });
  return {
    bot,
    bridge,
    call: async (action, args = {}) => {
      const response = await fetch(`${bridge.url}/v1/action`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action, args }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}
async function waitForDig(bot) {
  const deadline = Date.now() + 1000;
  while (!bot.targetDigBlock && Date.now() < deadline) await delay(1);
  assert.ok(bot.targetDigBlock, "native dig entered its pending task");
}

test("bridge preserves native rejection name, message, code and action without stack or arbitrary error fields", async (t) => {
  const s = await setup(t);
  s.bot.look = async () => {
    throw Object.assign(
      new Error("Cannot rotate while this action is pending"),
      {
        name: "BusyAction",
        code: "E_BUSY",
        stack: "PRIVATE_STACK",
        credentials: { password: "PRIVATE_PASSWORD" },
        cause: "PRIVATE_CAUSE",
      },
    );
  };
  const response = await s.call("look", { yaw: 0, pitch: 0 });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    ok: false,
    error: "Cannot rotate while this action is pending",
    errorDetails: {
      name: "BusyAction",
      message: "Cannot rotate while this action is pending",
      code: "E_BUSY",
      action: "look",
    },
  });
  assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE_/);
});

test("error text redacts credentials while retaining the native failure reason", async (t) => {
  const s = await setup(t);
  s.bot.look = () => {
    throw new Error(
      `Connection failed: ${token}; Bearer another-secret; https://operator:password@host/path password=secret-password apiKey='secret-api-key' MC_RCON_PASSWORD=server-credential {"OPENAI_API_KEY":"provider-credential"}`,
    );
  };
  const { body } = await s.call("look", { yaw: 0, pitch: 0 });
  assert.match(body.error, /Connection failed/);
  assert.match(body.error, /\[redacted\]/);
  assert.doesNotMatch(
    JSON.stringify(body),
    /error-test-participant-token|another-secret|operator:password|secret-password|secret-api-key|server-credential|provider-credential/,
  );
});

test("native dig cancellation and death reject the same pending dig through HTTP", async (t) => {
  const s = await setup(t);
  const block = s.bot.blockAt(new Vec3(0, 0, 0));
  const direct = s.bot.dig(block, "ignore");
  const nativeError = assert.rejects(direct, {
    name: "Error",
    message: "Digging aborted",
  });
  s.bot.stopDigging();
  await nativeError;
  for (const reason of ["stopDigging", "death"]) {
    const digging = s.call("dig", {
      position: { x: 0, y: 0, z: 0 },
      forceLook: "ignore",
    });
    await waitForDig(s.bot);
    if (reason === "stopDigging")
      assert.equal((await s.call("stopDigging")).body.ok, true);
    else s.bot.emit("death");
    const { body } = await digging;
    assert.deepEqual(body.errorDetails, {
      name: "Error",
      message: "Digging aborted",
      action: "dig",
    });
    assert.equal(s.bot.targetDigBlock, null);
  }
});

test("native dig errors and explicit authority denials retain distinct reasons", async (t) => {
  const s = await setup(t);
  s.bot.digTime = () => Infinity;
  const failure = await s.call("dig", { position: { x: 0, y: 0, z: 0 } });
  assert.equal(failure.body.error, "dig time for stone is Infinity");
  const denied = await setup(t, nativeDigBot(), {
    authorizeAction: () => false,
  });
  const response = await denied.call("dig", { position: { x: 0, y: 0, z: 0 } });
  assert.equal(response.status, 403);
  assert.equal(
    response.body.errorDetails.message,
    "Actions disabled by match policy",
  );
  assert.equal(denied.bot.targetDigBlock, null);
});

test("native death then spawn restores only bridge digging relays, once, with the native block argument", async (t) => {
  const s = await setup(t);
  const mirror = await connectBot({
    url: s.bridge.url,
    token,
    loadRegistry: false,
  });
  t.after(() => mirror.closeBridge());
  let oldParticipantCalls = 0;
  s.bot.on("diggingCompleted", () => oldParticipantCalls++);
  const death = once(mirror, "death");
  s.bot.emit("death");
  await death;
  assert.equal(s.bot.listenerCount("diggingCompleted"), 0);
  for (let n = 0; n < 2; n++) {
    const spawn = once(mirror, "spawn");
    s.bot.emit("spawn");
    await spawn;
    assert.equal(s.bot.listenerCount("diggingCompleted"), 1);
    assert.equal(s.bot.listenerCount("diggingAborted"), 1);
  }
  const digging = s.call("dig", {
    position: { x: 0, y: 0, z: 0 },
    forceLook: "ignore",
  });
  await waitForDig(s.bot);
  const completed = once(mirror, "diggingCompleted");
  const block = s.bot.targetDigBlock;
  s.bot.emit(`blockUpdate:${block.position}`, block, {
    ...block,
    type: 0,
    stateId: 0,
    name: "air",
  });
  assert.equal((await digging).body.ok, true);
  const [observed] = await completed;
  assert.equal(observed.name, "air");
  assert.deepEqual(
    [observed.position.x, observed.position.y, observed.position.z],
    [0, 0, 0],
  );
  assert.equal(oldParticipantCalls, 0, "only bridge relays are restored");
});

test("installed Pathfinder goto is event-driven: death alone does not reject, path_stop does", async () => {
  const bot = new EventEmitter();
  bot.pathfinder = { setGoal() {} };
  const goal = {};
  let settled = false;
  const moving = nativeGoto(bot, goal);
  moving.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  bot.emit("death");
  await delay(10);
  assert.equal(settled, false);
  const stopped = assert.rejects(moving, {
    name: "PathStopped",
    message: /Path was stopped before/,
  });
  bot.emit("path_stop");
  await stopped;
  const emptyPath = nativeGoto(bot, {});
  bot.emit("path_update", { status: "noPath", path: [] });
  assert.equal(
    await emptyPath,
    undefined,
    "native empty-path resolution is not proof of arrival",
  );
});

test("SDK and bridge preserve omitted and explicit native dig forceLook values", async (t) => {
  const s = await setup(t);
  const received = [];
  s.bot.dig = async (_block, forceLook) => received.push(forceLook);
  const mirror = await connectBot({
    url: s.bridge.url,
    token,
    loadRegistry: false,
  });
  t.after(() => mirror.closeBridge());
  const block = mirror.blockAt(new Vec3(0, 0, 0));
  await mirror.dig(block);
  for (const forceLook of [true, false, "ignore"])
    await mirror.dig(block, forceLook);
  assert.deepEqual(received, [undefined, true, false, "ignore"]);
});
