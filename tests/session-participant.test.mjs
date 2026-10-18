import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  validSession,
  createSessionReader,
  sessionData,
} from "../packages/pi-extension/platform-messages.mjs";
import { openingPromptText } from "../packages/pi-extension/bootstrap.mjs";
import {
  chatWakes,
  startChatForwarder,
} from "../packages/default-scripts/chat.mjs";

async function serve(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

test("validSession requires a state string and finite now", () => {
  assert.equal(validSession({ state: "running", now: 1 }), true);
  for (const bad of [
    null,
    undefined,
    "running",
    42,
    {},
    { state: "running" },
    { now: 1 },
    { state: 1, now: 1 },
    { state: "running", now: "1" },
    { state: "running", now: NaN },
    { state: "running", now: Infinity },
  ])
    assert.equal(validSession(bad), false, JSON.stringify(bad));
});

test("createSessionReader reads the specified character from the login gate", async (t) => {
  const { url, requests } = await serve(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    if (req.url === "/v1/session?username=arena_red1")
      return json(res, 200, {
        ok: true,
        result: {
          kind: "open",
          sessionId: "s1",
          state: "running",
          now: 5,
        },
      });
    json(res, 500, { ok: false });
  });
  const read = createSessionReader({
    url: `${url}/v1/session?username=arena_red1`,
    timeoutMs: 2000,
  });
  const snapshot = await read();
  assert.equal(snapshot.kind, "open");
  assert.equal(snapshot.sessionId, "s1");
  assert.deepEqual(requests, ["/v1/session?username=arena_red1"]);
});

test("createSessionReader does not fall back to an unscoped session route", async (t) => {
  const { url, requests } = await serve(t, (req, res) =>
    json(res, 404, { ok: false }),
  );
  assert.equal(
    await createSessionReader({
      url: `${url}/v1/session?username=arena_red1`,
      timeoutMs: 2000,
    })(),
    undefined,
  );
  assert.deepEqual(requests, ["/v1/session?username=arena_red1"]);
});

test("createSessionReader returns undefined for invalid bodies and errors", async (t) => {
  const bodies = [
    { ok: false, result: { state: "running", now: 1 } },
    { ok: true, result: { state: "running" } },
    { ok: true, result: { state: 1, now: 1 } },
    { ok: true },
  ];
  let index = 0;
  let status = 200;
  const { url } = await serve(t, (req, res) => {
    // A well-formed body must still be refused on a non-2xx status.
    if (status !== 200)
      return json(res, status, {
        ok: true,
        result: { state: "running", now: 1 },
      });
    if (index >= bodies.length) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("not json");
    }
    json(res, 200, bodies[index++]);
  });
  const read = createSessionReader({
    url: `${url}/v1/session?username=arena_red1`,
    timeoutMs: 2000,
  });
  for (let i = 0; i < bodies.length; i++)
    assert.equal(await read(true), undefined, `body ${i}`);
  assert.equal(await read(true), undefined, "malformed JSON");
  status = 500;
  assert.equal(await read(true), undefined, "server error");
  assert.equal(await createSessionReader({ url: "" })(), undefined, "no url");
});

test("sessionData carries state and winner, never a clock", () => {
  assert.deepEqual(
    sessionData({
      kind: "open",
      sessionId: "s1",
      state: "running",
      now: 1010,
      winner: "nobody",
    }),
    { kind: "open", sessionId: "s1", state: "running" },
  );
  assert.deepEqual(
    sessionData({ sessionId: "m1", state: "ended", now: 1, winner: "red" }),
    { kind: "match", sessionId: "m1", state: "ended", winner: "red" },
  );
});

test("openingPromptText includes the briefing object sections", () => {
  const text = openingPromptText("Base prompt", {
    kind: "open",
    sessionId: "s1",
    username: "Alex",
    secret: "not a briefing key",
    teamId: undefined,
    briefing: {
      text: "Build a house.",
      public: { spawn: [0, 64, 0] },
      prompt: "  Cooperate with others.  ",
    },
  });
  assert.ok(text.startsWith("Base prompt\n\n"));
  assert.ok(
    text.includes(
      `Session briefing (configuration data):\n${JSON.stringify({ kind: "open", sessionId: "s1", username: "Alex" })}`,
    ),
  );
  assert.equal(text.includes("not a briefing key"), false);
  assert.ok(
    text.includes(
      "Session briefing text (from the trusted game server):\nBuild a house.",
    ),
  );
  assert.ok(
    text.includes(
      'Public session data (from the trusted game server):\n{"spawn":[0,64,0]}',
    ),
  );
  assert.ok(
    text.endsWith(
      "Mode instructions (from the trusted game server; they describe this session's mode and rules):\nCooperate with others.",
    ),
  );
});

test("openingPromptText ignores a non-object briefing and a missing one", () => {
  assert.equal(
    openingPromptText("Base", {
      sessionId: "m1",
      briefing: "Capture the flag.",
    }),
    `Base\n\nSession briefing (configuration data):\n{"sessionId":"m1"}`,
  );
  const none = openingPromptText("Base", { sessionId: "m1" });
  assert.equal(
    none,
    `Base\n\nSession briefing (configuration data):\n{"sessionId":"m1"}`,
  );
  assert.equal(openingPromptText("Base", undefined), "Base");
  // A blank prompt adds no mode instructions.
  assert.equal(
    openingPromptText("Base", { briefing: { prompt: "  " } }).includes(
      "Mode instructions",
    ),
    false,
  );
});

test("chatWakes modes none, mention and all", () => {
  const u = { username: "Bot" };
  assert.equal(chatWakes("<Steve> hi Bot", { ...u }), false, "default none");
  assert.equal(chatWakes("<Steve> hi Bot", { ...u, mode: "none" }), false);
  assert.equal(chatWakes("<Steve> hi Bot", { ...u, mode: "bogus" }), false);
  assert.equal(chatWakes("<Steve> hi Bot", { ...u, mode: "mention" }), true);
  assert.equal(chatWakes("<Steve> hello", { ...u, mode: "mention" }), false);
  assert.equal(chatWakes("<Steve> hello", { ...u, mode: "all" }), true);
  assert.equal(chatWakes("<Steve> hello", { mode: "all" }), true);
  assert.equal(
    chatWakes("<Steve> hi Bot", { mode: "mention" }),
    false,
    "mention needs a known name",
  );
});

test("chatWakes mentions are whole-word and case-insensitive", () => {
  const m = { mode: "mention", username: "Bot" };
  assert.equal(chatWakes("<Steve> hey bot!", m), true);
  assert.equal(chatWakes("<Steve> BOT, come here", m), true);
  assert.equal(chatWakes("<Steve> @Bot?", m), true);
  assert.equal(chatWakes("<Steve> Robot army", m), false);
  assert.equal(chatWakes("<Steve> bots everywhere", m), false);
  assert.equal(chatWakes("<Steve> Bot_2 is here", m), false);
  // A longer player name containing the bot name does not match.
  assert.equal(chatWakes("<Botanist> hello", m), false);
  assert.equal(chatWakes("<Steve> hi Botanist", m), false);
  // Regex characters in the name are literal.
  assert.equal(
    chatWakes("<Steve> hi a.b", { mode: "mention", username: "a.b" }),
    true,
  );
  assert.equal(
    chatWakes("<Steve> hi axb", { mode: "mention", username: "a.b" }),
    false,
  );
});

test("chatWakes wakes for whispers to the bot in mention mode", () => {
  const m = { mode: "mention", username: "Bot" };
  assert.equal(chatWakes("Steve whispers to you: meet me", m), true);
  assert.equal(chatWakes("[Steve -> me] meet me", m), true);
  assert.equal(chatWakes("[Steve -> Bot] meet me", m), true);
  assert.equal(chatWakes("[Steve -> Alex] meet me", m), false);
});

test("chatWakes never wakes for the bot's own messages or outgoing whispers", () => {
  for (const mode of ["mention", "all"]) {
    const m = { mode, username: "Bot" };
    assert.equal(chatWakes("<Bot> hello Bot", m), false, mode);
    assert.equal(chatWakes("<bot> hello", m), false, mode);
    assert.equal(chatWakes("[Bot -> Steve] hi", m), false, mode);
    assert.equal(chatWakes("You whisper to Steve: hi Bot", m), false, mode);
    // Without a known username, outgoing whispers still never wake.
    assert.equal(
      chatWakes("You whisper to Steve: hi", { mode }),
      false,
      `${mode} without username`,
    );
  }
});

test("startChatForwarder rejects an unknown wake mode", () => {
  assert.throws(
    () =>
      startChatForwarder({
        bot: {},
        inbox: {},
        wake: "loud",
      }),
    /ARENA_CHAT_WAKE/,
  );
});

test("openingPromptText lists session and rule files after the briefing", () => {
  const text = openingPromptText(
    "Base",
    { sessionId: "s1" },
    {
      sessionFiles: ["/s/session.json", "/s/public.json"],
      ruleFiles: ["/rules/RULES.md"],
    },
  );
  assert.ok(text.indexOf("/s/session.json") > text.indexOf("s1"));
  assert.match(
    text,
    /Rule files from the operator \(read-only\):\n\/rules\/RULES\.md/,
  );
  assert.match(
    openingPromptText("Base", undefined, { ruleFiles: ["/r/a.md"] }),
    /\/r\/a\.md/,
  );
});

test("session files copy public fields, skip an empty briefing and rewrite public data only on change", async (t) => {
  const { mkdtemp, mkdir, readFile, rm, writeFile, access } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createSessionFiles, listRuleFiles } =
    await import("../packages/pi-extension/session-files.mjs");
  const dir = await mkdtemp(join(tmpdir(), "session-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = createSessionFiles({ directory: join(dir, "session") });
  const host = {
    sessionId: "s1",
    secret: "no",
    briefing: { public: { a: 1 } },
  };
  const written = await files.write(host);
  assert.deepEqual(written, [files.files.session, files.files.public]);
  assert.deepEqual(JSON.parse(await readFile(files.files.session, "utf8")), {
    sessionId: "s1",
  });
  await assert.rejects(access(files.files.briefing));
  assert.equal(await files.updatePublic(host), false);
  assert.equal(
    await files.updatePublic({ briefing: { public: { a: 2 } } }),
    true,
  );
  assert.deepEqual(JSON.parse(await readFile(files.files.public, "utf8")), {
    a: 2,
  });
  const rules = join(dir, "rules");
  assert.deepEqual(await listRuleFiles(rules), []);
  assert.deepEqual(await listRuleFiles(undefined), []);
  await mkdir(join(rules, "nested"), { recursive: true });
  await writeFile(join(rules, "b.md"), "");
  await writeFile(join(rules, "a.md"), "");
  await writeFile(join(rules, ".hidden"), "");
  assert.deepEqual(await listRuleFiles(rules), [
    join(rules, "a.md"),
    join(rules, "b.md"),
  ]);
  // Mounted rule files are often links; a link to a file counts, one to a
  // directory or to nothing does not.
  const { symlink } = await import("node:fs/promises");
  await writeFile(join(dir, "target.md"), "");
  await symlink(join(dir, "target.md"), join(rules, "c.md"));
  await symlink(join(rules, "nested"), join(rules, "d"));
  await symlink(join(dir, "missing"), join(rules, "e.md"));
  assert.deepEqual(await listRuleFiles(rules), [
    join(rules, "a.md"),
    join(rules, "b.md"),
    join(rules, "c.md"),
  ]);
  // Concurrent rewrites do not collide on one temporary file.
  await Promise.all([
    files.write({ ...host, briefing: { public: { a: 3 } } }),
    files.updatePublic({ briefing: { public: { a: 4 } } }),
  ]);
});

test("platform messages report public data against the opening baseline and inline only small data", async () => {
  const { createPlatformMessages, PUBLIC_INLINE_BYTES, NOTICE_MAX_CHARS } =
    await import("../packages/pi-extension/platform-messages.mjs");
  let host = {
    state: "running",
    now: 1,
    kind: "open",
    briefing: { public: { a: 1 } },
  };
  const platform = createPlatformMessages({
    readSession: async () => host,
    env: {},
    sessionDir: "/arena/session",
  });
  platform.notePublic(host);
  let result = await platform.collect();
  assert.equal(result.update.public, undefined, "the baseline is not news");
  assert.equal(result.wake, false);
  host = {
    ...host,
    briefing: { public: { big: "x".repeat(PUBLIC_INLINE_BYTES) } },
  };
  result = await platform.collect();
  assert.deepEqual(result.update.public, {
    omitted: "too large to inline",
    bytes: JSON.stringify(host.briefing.public).length,
    file: "/arena/session/public.json",
  });
  assert.equal(await platform.noticeChanged(), false);
  host = {
    ...host,
    briefing: { public: { notice: "n".repeat(NOTICE_MAX_CHARS + 5) } },
  };
  assert.equal(await platform.noticeChanged(), true);
  result = await platform.collect();
  assert.equal(result.wake, true);
  assert.match(result.update.notice, /\[cut; full text in public\.notice\]$/);
  assert.equal(await platform.noticeChanged(), false);
  host = { ...host, briefing: {} };
  result = await platform.collect();
  assert.deepEqual(result.update.public, { data: null });
  assert.equal(result.update.notice, null, "a removed notice is reported");
});
