import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import {
  cliOptions,
  openSession,
  MAX_SESSION_PROMPT_BYTES,
} from "../packages/mf-bridge/cli.mjs";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { BotFacade, Vector } from "../packages/bot-sdk/index.mjs";

const token = "test-token-long-enough";
const baseEnv = {
  MF_HOST: "mc.local",
  MF_USERNAME: "account@example.com",
  MF_VERSION: "1.21.1",
  BRIDGE_TOKEN: token,
};

function clock(start = 1_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

function fakeBot() {
  const bot = new EventEmitter();
  Object.assign(bot, {
    version: "1.21.1",
    username: "test",
    entity: {
      id: 1,
      position: new Vector(0.5, 1, 0.5),
      velocity: new Vector(),
      yaw: 0,
      pitch: 0,
      height: 1.8,
      width: 0.6,
      onGround: true,
      effects: {},
      attributes: {},
    },
    entities: {},
    inventory: {
      slots: Array(46).fill(null),
      inventoryStart: 9,
      inventoryEnd: 45,
    },
    game: { minY: -64, height: 384, dimension: "overworld" },
    controlState: {},
    health: 20,
    food: 20,
    heldItem: null,
  });
  bot.entities[1] = bot.entity;
  bot.blockAt = (p) => ({
    position: new Vector(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    stateId: p.y < 1 ? 1 : 0,
    type: p.y < 1 ? 1 : 0,
    name: p.y < 1 ? "stone" : "air",
    diggable: true,
    shapes: p.y < 1 ? [[0, 0, 0, 1, 1, 1]] : [],
    boundingBox: p.y < 1 ? "block" : "empty",
  });
  return bot;
}

test("cliOptions without BRIDGE_SESSION has no session route and offline auth", () => {
  const options = cliOptions({ ...baseEnv });
  assert.equal(options.minecraft.auth, "offline");
  assert.equal(options.minecraft.port, 25565);
  assert.equal(options.minecraft.username, "account@example.com");
  assert.equal("profilesFolder" in options.minecraft, false);
  assert.equal(options.bridge.getMatchState, undefined);
  assert.equal(options.session, undefined);
  assert.equal(options.bridge.token, token);
  assert.equal(
    cliOptions({ ...baseEnv, BRIDGE_SESSION: "" }).session,
    undefined,
  );
});

test("cliOptions rejects unknown BRIDGE_SESSION and MF_AUTH values", () => {
  assert.throws(
    () => cliOptions({ ...baseEnv, BRIDGE_SESSION: "match" }),
    /BRIDGE_SESSION must be open or server/,
  );
  assert.throws(
    () => cliOptions({ ...baseEnv, MF_AUTH: "mojang" }),
    /MF_AUTH must be offline or microsoft/,
  );
  assert.throws(() => cliOptions({ ...baseEnv, MF_HOST: "" }), /MF_HOST/);
});

test("MF_AUTH=microsoft sets auth and resolves MF_PROFILES_DIR", () => {
  const options = cliOptions(
    { ...baseEnv, MF_AUTH: "microsoft", MF_PROFILES_DIR: "profiles" },
    { cwd: "/srv/bridge" },
  );
  assert.equal(options.minecraft.auth, "microsoft");
  assert.equal(
    options.minecraft.profilesFolder,
    resolve("/srv/bridge/profiles"),
  );
  // Offline auth ignores the profiles directory.
  const offline = cliOptions(
    { ...baseEnv, MF_PROFILES_DIR: "profiles" },
    { cwd: "/srv/bridge" },
  );
  assert.equal("profilesFolder" in offline.minecraft, false);
});

test("BRIDGE_SESSION=open serves a running open session", () => {
  const now = clock(5_000);
  const reads = [];
  const options = cliOptions(
    {
      ...baseEnv,
      BRIDGE_SESSION: "open",
      BRIDGE_SESSION_ID: "solo-1",
      BRIDGE_BRIEFING: "Build a house.",
      BRIDGE_PROMPT_FILE: "prompt.md",
    },
    {
      now,
      cwd: "/work",
      readPrompt: (path) => {
        reads.push(path);
        return Buffer.from("# Prompt\nBe nice.");
      },
    },
  );
  assert.deepEqual(reads, [resolve("/work/prompt.md")]);
  assert.equal(typeof options.bridge.getMatchState, "function");
  const first = options.bridge.getMatchState();
  assert.deepEqual(first, {
    kind: "open",
    state: "running",
    sessionId: "solo-1",
    matchId: "solo-1",
    runId: "solo-1",
    participantId: "account@example.com",
    teamId: null,
    username: "account@example.com",
    teams: [],
    participants: [
      {
        id: "account@example.com",
        username: "account@example.com",
        teamId: null,
      },
    ],
    map: null,
    now: 5_000,
    winner: null,
    scores: null,
    briefing: {
      text: "Build a house.",
      prompt: "# Prompt\nBe nice.",
      public: null,
    },
  });
  now.advance(1_500);
  const later = options.bridge.getMatchState();
  assert.equal(later.now, 6_500);
  // The prompt file is read once at start.
  assert.equal(reads.length, 1);
});

test("open session defaults: generated id, null briefing and prompt", () => {
  const now = clock(42);
  let reads = 0;
  const options = cliOptions(
    { ...baseEnv, BRIDGE_SESSION: "open" },
    {
      now,
      readPrompt: () => {
        reads++;
        return "";
      },
    },
  );
  const state = options.bridge.getMatchState();
  assert.equal(state.sessionId, "open-42");
  assert.deepEqual(state.briefing, { text: null, prompt: null, public: null });
  assert.equal(reads, 0);
});

test("session.setUsername updates the reported in-game name", () => {
  const options = cliOptions(
    { ...baseEnv, MF_AUTH: "microsoft", BRIDGE_SESSION: "open" },
    { now: clock() },
  );
  assert.equal(typeof options.session.setUsername, "function");
  options.session.setUsername("Steve");
  const state = options.bridge.getMatchState();
  assert.equal(state.username, "Steve");
  assert.equal(state.participantId, "Steve");
  assert.deepEqual(state.participants, [
    { id: "Steve", username: "Steve", teamId: null },
  ]);
  // Empty or non-string names are ignored.
  options.session.setUsername("");
  options.session.setUsername(undefined);
  assert.equal(options.bridge.getMatchState().username, "Steve");
});

test("prompt file over MAX_SESSION_PROMPT_BYTES is rejected", () => {
  const env = { ...baseEnv, BRIDGE_SESSION: "open", BRIDGE_PROMPT_FILE: "p" };
  assert.throws(
    () =>
      cliOptions(env, {
        readPrompt: () => Buffer.alloc(MAX_SESSION_PROMPT_BYTES + 1, 0x61),
      }),
    /exceeds/,
  );
  // Multibyte strings are measured in bytes, not characters.
  assert.throws(
    () =>
      cliOptions(env, {
        readPrompt: () => "é".repeat(MAX_SESSION_PROMPT_BYTES / 2 + 1),
      }),
    /exceeds/,
  );
  const ok = cliOptions(env, {
    readPrompt: () => Buffer.alloc(MAX_SESSION_PROMPT_BYTES, 0x61),
  });
  assert.equal(
    ok.bridge.getMatchState().briefing.prompt.length,
    MAX_SESSION_PROMPT_BYTES,
  );
});

test("openSession accepts a fixed username", () => {
  const get = openSession({
    sessionId: "s",
    username: "alex",
    now: () => 50,
  });
  const state = get();
  assert.equal(state.username, "alex");
  assert.deepEqual(state.briefing, { text: null, prompt: null, public: null });
});

async function getJson(url) {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, text: await res.text() };
}

test("bridge serves /v1/session and no legacy /v1/match alias", async (t) => {
  const getMatchState = openSession({
    sessionId: "solo",
    username: "test",
    now: () => 30,
  });
  const service = await startBridge({
    bot: fakeBot(),
    token,
    snapshotRadius: 1,
    getMatchState,
  });
  t.after(() => service.close());
  const session = await getJson(service.url + "/v1/session");
  const match = await getJson(service.url + "/v1/match");
  assert.equal(session.status, 200);
  assert.equal(match.status, 404);
  assert.deepEqual(JSON.parse(session.text), {
    ok: true,
    result: getMatchState(),
  });
  const unauth = await fetch(service.url + "/v1/session");
  assert.equal(unauth.status, 401);
});

test("bridge session route is GET-only and 503s when state fails", async (t) => {
  const service = await startBridge({
    bot: fakeBot(),
    token,
    snapshotRadius: 1,
    getMatchState: () => {
      throw new Error("host down");
    },
  });
  t.after(() => service.close());
  const failed = await getJson(service.url + "/v1/session");
  assert.equal(failed.status, 503);
  assert.deepEqual(JSON.parse(failed.text), {
    ok: false,
    error: "Session state unavailable",
  });
  const post = await fetch(service.url + "/v1/session", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  await post.body?.cancel();
  assert.notEqual(post.status, 200);
  assert.notEqual(post.status, 503);
});

test("bridge 404s the session routes without getMatchState", async (t) => {
  const service = await startBridge({
    bot: fakeBot(),
    token,
    snapshotRadius: 1,
  });
  t.after(() => service.close());
  assert.equal((await getJson(service.url + "/v1/session")).status, 404);
  assert.equal((await getJson(service.url + "/v1/match")).status, 404);
});

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, auth: init?.headers?.authorization });
    const body = routes[path];
    if (body === undefined) return new Response(null, { status: 404 });
    return new Response(JSON.stringify({ ok: true, result: body }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

test("getSessionState reads /v1/session", async () => {
  const { impl, calls } = fakeFetch({ "/v1/session": { kind: "open" } });
  const bot = new BotFacade({ url: "http://bridge/", token, fetchImpl: impl });
  assert.deepEqual(await bot.getSessionState(), { kind: "open" });
  assert.deepEqual(await bot.getMatchState(), { kind: "open" });
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/v1/session", "/v1/session"],
  );
  assert.ok(calls.every((c) => c.auth === `Bearer ${token}`));
});

test("getSessionState throws when the route is missing", async () => {
  const { impl } = fakeFetch({});
  const bot = new BotFacade({ url: "http://bridge", token, fetchImpl: impl });
  await assert.rejects(bot.getSessionState(), /Session state HTTP 404/);
});

test("getSessionState reports a failing route", async () => {
  const calls = [];
  const impl = async (url) => {
    calls.push(new URL(url).pathname);
    return new Response(null, { status: 500 });
  };
  const bot = new BotFacade({ url: "http://bridge", token, fetchImpl: impl });
  await assert.rejects(bot.getSessionState(), /Session state HTTP 500/);
  assert.deepEqual(calls, ["/v1/session"]);
});

test("getSessionState works against a real bridge", async (t) => {
  const service = await startBridge({
    bot: fakeBot(),
    token,
    snapshotRadius: 1,
    getMatchState: () => ({ kind: "open", state: "running" }),
  });
  t.after(() => service.close());
  const bot = new BotFacade({ url: service.url, token, loadRegistry: false });
  assert.deepEqual(await bot.getSessionState(), {
    kind: "open",
    state: "running",
  });
});
