import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import http from "node:http";
import {
  profileAcceptsImages,
  readParticipantConfig,
} from "../packages/pi-extension/participant-config.mjs";

const bootstrap = new URL(
  "../packages/pi-extension/bootstrap.mjs",
  import.meta.url,
).pathname;
// 1x1 transparent PNG.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
  "base64",
);

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fill(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

test("a missing config directory means the defaults", async (t) => {
  const dir = await tempDir(t, "arena-config-");
  for (const directory of [undefined, join(dir, "absent"), dir])
    assert.deepEqual(await readParticipantConfig(directory), {
      systemPromptFiles: [],
      images: [],
    });
});

test("config files are read in file-name order", async (t) => {
  const dir = await tempDir(t, "arena-config-");
  await fill(dir, {
    "first-message.md": "\nWalk to the gate.\n",
    "agents.d/20-chest.md": "chest",
    "agents.d/10-map.md": "map",
    "agents.d/notes.txt": "ignored",
    "images/b.webp": "b",
    "images/a.PNG": png,
    "skills/route/SKILL.md": "---\nname: route\n---\n",
    "default-scripts.json": '["chat"]',
  });
  const config = await readParticipantConfig(dir);
  assert.equal(config.firstMessage, "Walk to the gate.");
  assert.deepEqual(config.systemPromptFiles, [
    join(dir, "agents.d/10-map.md"),
    join(dir, "agents.d/20-chest.md"),
  ]);
  assert.deepEqual(
    config.images.map((image) => image.mimeType),
    ["image/png", "image/webp"],
  );
  assert.equal(config.images[0].data, png.toString("base64"));
  assert.equal(config.skillsDir, join(dir, "skills"));
  assert.equal(config.defaultScripts, "chat");
});

test("config fragments join the built-in ones and replace those of the same name", async (t) => {
  const dir = await tempDir(t, "arena-config-");
  await fill(dir, {
    "builtin/10-arena.md": "arena",
    "builtin/50-chest.md": "chest",
    "config/agents.d/50-chest.md": "map chest",
    "config/agents.d/30-map.md": "map",
  });
  const config = await readParticipantConfig(join(dir, "config"), {
    builtinAgentsDir: join(dir, "builtin"),
  });
  assert.deepEqual(config.systemPromptFiles, [
    join(dir, "builtin/10-arena.md"),
    join(dir, "config/agents.d/30-map.md"),
    join(dir, "config/agents.d/50-chest.md"),
  ]);
  const builtinOnly = await readParticipantConfig(undefined, {
    builtinAgentsDir: join(dir, "builtin"),
  });
  assert.equal(builtinOnly.systemPromptFiles.length, 2);
});

test("default scripts are keyed by bot name when the file is an object", async (t) => {
  const dir = await tempDir(t, "arena-config-");
  await fill(dir, {
    "default-scripts.json": JSON.stringify({
      arena_red1: ["danger", "chat"],
      arena_red2: [],
    }),
  });
  const read = (ARENA_BOT) =>
    readParticipantConfig(dir, { env: ARENA_BOT ? { ARENA_BOT } : {} });
  assert.equal((await read("arena_red1")).defaultScripts, "danger,chat");
  assert.equal((await read("arena_red2")).defaultScripts, "");
  assert.equal((await read("arena_blue1")).defaultScripts, "");
  await assert.rejects(read(), /ARENA_BOT is not set/);
});

test("bad config files are rejected before Pi starts", async (t) => {
  const dir = await tempDir(t, "arena-config-");
  await fill(dir, { "default-scripts.json": '["danger","observer"]' });
  await assert.rejects(
    readParticipantConfig(dir),
    /Unknown default script: observer/,
  );
  await fill(dir, { "default-scripts.json": '"danger"' });
  await assert.rejects(readParticipantConfig(dir), /must be a list/);
  await fill(dir, { "default-scripts.json": "[" });
  await assert.rejects(readParticipantConfig(dir), /default-scripts\.json/);
  await rm(join(dir, "default-scripts.json"));
  await fill(dir, { "images/map.svg": "<svg/>" });
  await assert.rejects(readParticipantConfig(dir), /images\/map\.svg/);
});

test("images go only to a generated model that declares image input", () => {
  const profile = (input) => ({ generated: true, model: { id: "m", input } });
  assert.equal(profileAcceptsImages(profile(["text", "image"])), true);
  assert.equal(profileAcceptsImages(profile(["text"])), false);
  assert.equal(profileAcceptsImages({ generated: false }), true);
});

async function fakeProvider(t) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "cfg", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    chunk({ role: "assistant", content: "config fixture done" });
    chunk({}, "stop");
    res.end(
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n',
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1` };
}

async function launcherEnv(dir, provider, extra = {}) {
  const env = {
    ...process.env,
    // Pi built-in models with and without image input.
    ARENA_PI_MODEL: extra.textOnly
      ? "groq/llama-3.3-70b-versatile"
      : "groq/qwen/qwen3.8-27b",
    ARENA_PI_BASE_URL: provider.url,
    ARENA_PI_API_KEY: "config-fixture-token",
    ARENA_CONFIG_DIR: join(dir, "config"),
  };
  for (const key of [
    "ARENA_BRIDGE_URL",
    "ARENA_BRIDGE_TOKEN",
    "ARENA_PROMPT",
    "ARENA_EXTRA_EXTENSIONS",
  ])
    delete env[key];
  return env;
}

test(
  "the launcher sends the first message and images, and appends agents.d and skills",
  { timeout: 20000 },
  async (t) => {
    const dir = await tempDir(t, "arena-config-e2e-");
    const workspace = join(dir, "workspace");
    await mkdir(workspace);
    await fill(join(dir, "config"), {
      "first-message.md": "FIRST-MESSAGE-FIXTURE",
      "agents.d/20-second.md": "AGENTS-SECOND-FIXTURE",
      "agents.d/10-first.md": "AGENTS-FIRST-FIXTURE",
      "images/map.png": png,
      "skills/route-fixture/SKILL.md":
        "---\nname: route-fixture\ndescription: Fixture skill from the config directory.\n---\nRoute.\n",
    });
    const provider = await fakeProvider(t);
    const child = spawn(process.execPath, [bootstrap], {
      cwd: workspace,
      env: await launcherEnv(dir, provider),
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    const until = Date.now() + 15000;
    while (!stdout.includes("config fixture done")) {
      if (Date.now() > until || child.exitCode !== null)
        throw new Error(`No reply: ${stderr}\n${stdout.slice(-1000)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    const body = JSON.stringify(provider.requests[0].messages);
    const system = JSON.stringify(provider.requests[0].messages[0]);
    assert.ok(
      system.indexOf("AGENTS-FIRST-FIXTURE") <
        system.indexOf("AGENTS-SECOND-FIXTURE") &&
        system.includes("AGENTS-FIRST-FIXTURE"),
      system,
    );
    assert.match(system, /route-fixture/);
    assert.match(system, /skills\/arena-programs\/SKILL\.md/);
    // No manifest, so no teammates: the team skill stays out.
    assert.doesNotMatch(system, /skills-team/);
    assert.match(body, /FIRST-MESSAGE-FIXTURE/);
    assert.match(body, new RegExp(png.toString("base64").slice(0, 40)));
  },
);

test(
  "the launcher offers the team skill only when the manifest lists teammates",
  { timeout: 20000 },
  async (t) => {
    const dir = await tempDir(t, "arena-config-e2e-");
    const workspace = join(dir, "workspace");
    await mkdir(workspace);
    await fill(join(dir, "provision"), {
      "manifest.json": JSON.stringify({ files: [], teammates: ["red2"] }),
    });
    const provider = await fakeProvider(t);
    const env = await launcherEnv(dir, provider);
    env.ARENA_PROVISION_DIR = join(dir, "provision");
    const child = spawn(process.execPath, [bootstrap], {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    const until = Date.now() + 15000;
    while (!stdout.includes("config fixture done")) {
      if (Date.now() > until || child.exitCode !== null)
        throw new Error(`No reply: ${stderr}\n${stdout.slice(-1000)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    const system = JSON.stringify(provider.requests[0].messages[0]);
    assert.match(system, /skills-team\/arena-team\/SKILL\.md/);
  },
);

test(
  "the launcher skips images for a text-only model, with a warning",
  { timeout: 20000 },
  async (t) => {
    const dir = await tempDir(t, "arena-config-e2e-");
    const workspace = join(dir, "workspace");
    await mkdir(workspace);
    await fill(join(dir, "config"), { "images/map.png": png });
    const provider = await fakeProvider(t);
    const child = spawn(process.execPath, [bootstrap], {
      cwd: workspace,
      env: await launcherEnv(dir, provider, { textOnly: true }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    const until = Date.now() + 15000;
    while (!stdout.includes("config fixture done")) {
      if (Date.now() > until || child.exitCode !== null)
        throw new Error(`No reply: ${stderr}\n${stdout.slice(-1000)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    assert.match(stderr, /1 image\(s\) not sent/);
    assert.doesNotMatch(
      JSON.stringify(provider.requests[0].messages),
      new RegExp(png.toString("base64").slice(0, 40)),
    );
  },
);
