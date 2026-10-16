import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSnbt,
  parseStorageReply,
  serializeSnbt,
} from "../packages/arena/src/snbt.mjs";

test("SNBT parses compounds, lists, strings and suffixed numbers", () => {
  assert.deepEqual(
    parseSnbt(
      `{version:1, state:"running", winner:'', scores:{red:2,blue:-1b}, "odd key":'it\\'s', n:[1.5d,2f,3L,4s,5b,6], t:true, f:false, e:[], c:{}}`,
    ),
    {
      version: 1,
      state: "running",
      winner: "",
      scores: { red: 2, blue: -1 },
      "odd key": "it's",
      n: [1.5, 2, 3, 4, 5, 6],
      t: 1,
      f: 0,
      e: [],
      c: {},
    },
  );
  assert.deepEqual(parseSnbt("[I; 1, 2, 3]"), [1, 2, 3]);
  assert.deepEqual(parseSnbt("[B;1b,0b]"), [1, 0]);
  assert.deepEqual(parseSnbt("[L;]"), []);
  assert.equal(parseSnbt("wool-a"), "wool-a");
  assert.equal(parseSnbt("1e3"), 1000);
  assert.equal(parseSnbt('"a\\"b\\\\c"'), 'a"b\\c');
  for (const bad of ["{", "{a:}", "{a:1", "[1,", '"x', "{a:1} junk", ""])
    assert.throws(() => parseSnbt(bad), SyntaxError, bad);
  const proto = parseSnbt('{"__proto__":{polluted:1b}}');
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(proto), ["__proto__"]);
});

test("SNBT serialization round-trips the arena:config shape", () => {
  const value = {
    version: 1,
    sessionId: "match-1",
    kind: "match",
    durationMs: 1800000,
    big: 2 ** 40,
    ratio: 0.5,
    flag: true,
    skip: undefined,
    none: null,
    "key with space": 'say "hi"\\',
    teams: [
      { id: "red", players: ["arena_red1"] },
      { id: "blue", players: [] },
    ],
  };
  const text = serializeSnbt(value);
  assert.match(text, /^\{version:1,sessionId:"match-1",kind:"match"/);
  assert.match(text, /big:1099511627776L/);
  assert.match(text, /ratio:0.5d/);
  assert.match(text, /flag:1b/);
  assert.doesNotMatch(text, /skip|none/);
  const back = parseSnbt(text);
  assert.equal(back["key with space"], 'say "hi"\\');
  assert.deepEqual(back.teams, value.teams);
  assert.equal(back.big, 2 ** 40);
  assert.throws(() => serializeSnbt(NaN), TypeError);
  assert.throws(() => serializeSnbt([null]), TypeError);
});

test("storage replies: contents, empty, missing and unknown", () => {
  assert.deepEqual(
    parseStorageReply(
      'Storage arena:session has the following contents: {version:1,state:"waiting"}',
      "arena:session",
    ),
    { version: 1, state: "waiting" },
  );
  assert.equal(
    parseStorageReply(
      "Storage arena:session has the following contents: {}",
      "arena:session",
    ),
    null,
  );
  assert.equal(
    parseStorageReply("Found no elements matching arena:session"),
    null,
  );
  // Another RCON client's output around the reply (shared vanilla buffer).
  assert.deepEqual(
    parseStorageReply(
      'Unknown or incomplete command<--[HERE]Storage arena:session has the following contents: {state:"ended"}Unknown or incomplete command<--[HERE]',
      "arena:session",
    ),
    { state: "ended" },
  );
  assert.throws(
    () =>
      parseStorageReply(
        "Storage other:x has the following contents: {}",
        "arena:session",
      ),
    /another storage/,
  );
  assert.throws(
    () => parseStorageReply("Unknown or incomplete command, see below"),
    /Unrecognised/,
  );
  assert.throws(
    () =>
      parseStorageReply(
        "Storage arena:session has the following contents: {state:",
      ),
    SyntaxError,
  );
  assert.throws(
    () =>
      parseStorageReply("Storage arena:session has the following contents: 3"),
    /compound/,
  );
});
