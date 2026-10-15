import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  validSession,
  createMatchReader,
  clockData,
} from "../packages/pi-extension/platform-messages.mjs";
import { openingPromptText } from "../packages/pi-extension/bootstrap.mjs";
import {
  chatWakes,
  startChatForwarder,
} from "../packages/default-scripts/chat.mjs";
import { Inbox, localInboxClient } from "../packages/inbox/index.mjs";

const token = "session-participant-token";

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

async function until(fn, timeout = 2000) {
  for (let i = 0; i < timeout / 10; i++) {
    if (fn()) return;
    await delay(10);
  }
  assert.fail("Timed out");
}

test("validSession requires a state string and finite now; durationMs finite or null", () => {
  assert.equal(
    validSession({ state: "running", now: 1, durationMs: null }),
    true,
  );
  assert.equal(
    validSession({ state: "running", now: 1, durationMs: 60000 }),
    true,
  );
  for (const bad of [
    null,
    undefined,
    "running",
    42,
    {},
    { state: "running" },
    { now: 1 },
    { state: "running", now: 1 },
    // Each of these is valid apart from the one field under test.
    { state: 1, now: 1, durationMs: null },
    { now: 1, durationMs: null },
    { state: "running", durationMs: null },
    { state: "running", now: "1", durationMs: null },
    { state: "running", now: NaN, durationMs: null },
    { state: "running", now: Infinity, durationMs: null },
    { state: "running", now: 1, durationMs: "60000" },
    { state: "running", now: 1, durationMs: NaN },
    { state: "running", now: 1, durationMs: Infinity },
  ])
    assert.equal(validSession(bad), false, JSON.stringify(bad));
});

test("createMatchReader prefers /v1/session and sends the bearer token", async (t) => {
  const { url, requests } = await serve(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.url === "/v1/session")
      return json(res, 200, {
        ok: true,
        result: {
          kind: "open",
          sessionId: "s1",
          state: "running",
          now: 5,
          durationMs: null,
        },
      });
    json(res, 500, { ok: false });
  });
  const read = createMatchReader({ url: `${url}/`, token, timeoutMs: 2000 });
  const snapshot = await read();
  assert.equal(snapshot.kind, "open");
  assert.equal(snapshot.durationMs, null);
  assert.equal(snapshot.sessionId, "s1");
  assert.deepEqual(requests, ["/v1/session"]);
});

test("createMatchReader does not fall back to a legacy route", async (t) => {
  const { url, requests } = await serve(t, (req, res) =>
    json(res, 404, { ok: false }),
  );
  assert.equal(
    await createMatchReader({ url, token, timeoutMs: 2000 })(),
    undefined,
  );
  assert.deepEqual(requests, ["/v1/session"]);
});

test("createMatchReader returns undefined for invalid bodies and errors", async (t) => {
  const bodies = [
    { ok: false, result: { state: "running", now: 1, durationMs: null } },
    { ok: true, result: { state: "running", durationMs: null } },
    { ok: true, result: { state: "running", now: 1, durationMs: "x" } },
    { ok: true },
  ];
  let index = 0;
  let status = 200;
  const { url } = await serve(t, (req, res) => {
    // A well-formed body must still be refused on a non-2xx status.
    if (status !== 200)
      return json(res, status, {
        ok: true,
        result: { state: "running", now: 1, durationMs: null },
      });
    if (index >= bodies.length) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("not json");
    }
    json(res, 200, bodies[index++]);
  });
  const read = createMatchReader({ url, token, timeoutMs: 2000 });
  for (let i = 0; i < bodies.length; i++)
    assert.equal(await read(true), undefined, `body ${i}`);
  assert.equal(await read(true), undefined, "malformed JSON");
  status = 500;
  assert.equal(await read(true), undefined, "server error");
  assert.equal(
    await createMatchReader({ url: "", token })(),
    undefined,
    "no url",
  );
});

test("clockData reports elapsed only for open sessions", () => {
  const options = {
    now: 100,
    bootAt: 0,
    configured: { startedAt: null, durationMs: null },
  };
  const open = clockData(
    {
      kind: "open",
      sessionId: "s1",
      state: "running",
      startedAt: 10,
      now: 1010,
      elapsedMs: 1000,
      durationMs: null,
      winner: "nobody",
    },
    options,
  );
  assert.deepEqual(open, {
    basis: "authenticated host session snapshot",
    kind: "open",
    sessionId: "s1",
    state: "running",
    startedAtMs: 10,
    asOfMs: 1010,
    elapsedMs: 1000,
  });
  assert.equal("durationMs" in open, false);
  assert.equal("remainingMs" in open, false);
  assert.equal("winner" in open, false);
  // An open session never counts down even if a duration is present.
  const withDuration = clockData(
    { kind: "open", state: "running", now: 1, elapsedMs: 5, durationMs: 60 },
    options,
  );
  assert.equal("remainingMs" in withDuration, false);
  assert.equal("durationMs" in withDuration, false);
});

test("clockData match output is unchanged", () => {
  const clock = clockData(
    {
      kind: "match",
      matchId: "m1",
      state: "running",
      startedAt: 10,
      now: 1010,
      elapsedMs: 1000,
      durationMs: 60000,
    },
    { now: 0, bootAt: 0, configured: { startedAt: null, durationMs: null } },
  );
  assert.deepEqual(clock, {
    basis: "authenticated host match snapshot",
    matchId: "m1",
    state: "running",
    matchStartedAtMs: 10,
    asOfMs: 1010,
    durationMs: 60000,
    elapsedMs: 1000,
    remainingMs: 59000,
    winner: null,
  });
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
      `Trusted host session briefing (configuration data):\n${JSON.stringify({ kind: "open", sessionId: "s1", username: "Alex" })}`,
    ),
  );
  assert.equal(text.includes("not a briefing key"), false);
  assert.ok(
    text.includes(
      "Session briefing text (from the trusted session host):\nBuild a house.",
    ),
  );
  assert.ok(
    text.includes(
      'Public session data (from the trusted session host):\n{"spawn":[0,64,0]}',
    ),
  );
  assert.ok(
    text.endsWith(
      "Mode instructions (from the trusted session host; they describe this session's mode and rules):\nCooperate with others.",
    ),
  );
});

test("openingPromptText ignores a non-object briefing and a missing one", () => {
  assert.equal(
    openingPromptText("Base", { matchId: "m1", briefing: "Capture the flag." }),
    `Base\n\nTrusted host session briefing (configuration data):\n{"matchId":"m1"}`,
  );
  const none = openingPromptText("Base", { matchId: "m1" });
  assert.equal(
    none,
    `Base\n\nTrusted host session briefing (configuration data):\n{"matchId":"m1"}`,
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

test("startChatForwarder posts matching chat as urgent and others as normal", async (t) => {
  const lines = [
    "<Steve> hi Bot",
    "<Steve> hello",
    "<Bot> hello Bot",
    "Steve whispers to you: psst",
    "<Botanist> hi",
  ];
  const { url, requests } = await serve(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.url === "/v1/session")
      return json(res, 200, {
        ok: true,
        result: {
          state: "running",
          now: 1,
          participantId: "p1",
          participants: [{ id: "p1", username: "Bot" }],
        },
      });
    if (req.url !== "/v1/chat") return json(res, 404, {});
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"connected"}\n\n');
    for (const text of lines)
      res.write(
        `data: ${JSON.stringify({ type: "event", data: { name: "messagestr", args: [text, "chat"] } })}\n\n`,
      );
  });
  const inbox = new Inbox({ sessionId: "wake" });
  const chat = startChatForwarder({
    url,
    token,
    inbox: localInboxClient(inbox),
    wake: "mention",
    // The session's username wins over this one.
    username: "Someone",
  });
  t.after(() => chat.close());
  await until(() => inbox.items.length === lines.length);
  assert.deepEqual(requests.slice(0, 2), ["/v1/session", "/v1/chat"]);
  const batch = inbox.drain();
  assert.deepEqual(
    batch.messages.map((m) => [m.data.text, m.priority]),
    [
      ["<Steve> hi Bot", "urgent"],
      ["<Steve> hello", "normal"],
      ["<Bot> hello Bot", "normal"],
      ["Steve whispers to you: psst", "urgent"],
      ["<Botanist> hi", "normal"],
    ],
  );
  await chat.close();
});

test("startChatForwarder keeps the configured username without a session route", async (t) => {
  const { url, requests } = await serve(t, (req, res) => {
    if (req.url !== "/v1/chat") return json(res, 404, {});
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const text of ["<Steve> hi Bot", "<Steve> hi Someone"])
      res.write(
        `data: ${JSON.stringify({ type: "event", data: { name: "messagestr", args: [text, "chat"] } })}\n\n`,
      );
  });
  const inbox = new Inbox({ sessionId: "legacy" });
  const chat = startChatForwarder({
    url,
    token,
    inbox: localInboxClient(inbox),
    wake: "mention",
    username: "Someone",
  });
  t.after(() => chat.close());
  await until(() => inbox.items.length === 2);
  assert.deepEqual(requests.slice(0, 2), ["/v1/session", "/v1/chat"]);
  assert.deepEqual(
    inbox.drain().messages.map((m) => [m.data.text, m.priority]),
    [
      ["<Steve> hi Bot", "normal"],
      ["<Steve> hi Someone", "urgent"],
    ],
  );
  await chat.close();
});

test("startChatForwarder rejects an unknown wake mode", () => {
  assert.throws(
    () =>
      startChatForwarder({
        url: "http://127.0.0.1:1",
        token,
        inbox: localInboxClient(new Inbox({ sessionId: "x" })),
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
});

test("platform messages report public data against the opening baseline and inline only small data", async () => {
  const { createPlatformMessages, PUBLIC_INLINE_BYTES, NOTICE_MAX_CHARS } =
    await import("../packages/pi-extension/platform-messages.mjs");
  let host = {
    state: "running",
    now: 1,
    durationMs: null,
    kind: "open",
    briefing: { public: { a: 1 } },
  };
  const platform = createPlatformMessages({
    readMatch: async () => host,
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
