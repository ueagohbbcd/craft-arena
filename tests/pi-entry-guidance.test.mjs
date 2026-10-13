import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { Vector } from "../packages/bot-sdk/index.mjs";
import { arenaGuidanceArgs } from "../packages/pi-extension/bootstrap.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const guidance = join(root, "examples", "PROMPT.md");
const append = ["--append-system-prompt", guidance];
const defaultTools = [
  "bash",
  "edit",
  "observe",
  "read",
  "task_cancel",
  "task_wait",
  "write",
];

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "arena-entry-guidance-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  return { dir, agentDir };
}

test("the participant prompt is appended even inside the repository, whose AGENTS.md is for developers", async (t) => {
  const { agentDir } = await fixture(t);
  for (const cwd of [
    root,
    join(root, "examples"),
    join(root, "packages", "pi-extension"),
  ])
    assert.deepEqual(await arenaGuidanceArgs({ cwd, agentDir }), append);
});

test("arena guidance matches physical cwd and symlinked instruction identity", async (t) => {
  const { dir, agentDir } = await fixture(t);
  const alias = join(dir, "toolkit-alias");
  await symlink(root, alias, "dir");
  for (const cwd of [alias, join(alias, "examples")])
    assert.deepEqual(await arenaGuidanceArgs({ cwd, agentDir }), append);
  const workspace = join(dir, "workspace");
  await mkdir(workspace);
  await symlink(guidance, join(workspace, "AGENTS.md"), "file");
  assert.deepEqual(await arenaGuidanceArgs({ cwd: workspace, agentDir }), []);
});

test("separate workspace retains arena guidance and unrelated user instructions", async (t) => {
  const { dir, agentDir } = await fixture(t);
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  assert.deepEqual(await arenaGuidanceArgs({ cwd, agentDir }), append);
  await writeFile(join(cwd, "AGENTS.md"), "User-owned project instructions.\n");
  await writeFile(
    join(agentDir, "AGENTS.md"),
    "User-owned global instructions.\n",
  );
  assert.deepEqual(await arenaGuidanceArgs({ cwd, agentDir }), append);
  // Pi's override precedence must not be mistaken for discovery of its sibling.
  await symlink(guidance, join(cwd, "CLAUDE.md"), "file");
  assert.deepEqual(await arenaGuidanceArgs({ cwd, agentDir }), append);
});

test("explicitly disabled context discovery still receives appended arena guidance", async (t) => {
  const { agentDir } = await fixture(t);
  for (const flag of ["--no-context-files", "-nc"])
    assert.deepEqual(
      await arenaGuidanceArgs({ cwd: root, agentDir, args: [flag] }),
      append,
    );
});

test(
  "real bootstrap sends arena guidance once and preserves user context across cwd layouts",
  { timeout: 45000 },
  async (t) => {
    const { dir } = await fixture(t);
    const requests = [];
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: "entry-fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Entry fixture complete." }, finish_reason: "stop" }] })}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    const workspace = join(dir, "workspace");
    const custom = join(dir, "custom-workspace");
    const overridden = join(dir, "override-workspace");
    const alias = join(dir, "toolkit-alias");
    for (const cwd of [workspace, custom, overridden]) await mkdir(cwd);
    await symlink(root, alias, "dir");
    await writeFile(join(custom, "AGENTS.md"), "KEEP_USER_PROJECT_CONTEXT\n");
    await symlink(guidance, join(overridden, "AGENTS.md"), "file");
    await writeFile(
      join(overridden, "AGENTS.override.md"),
      "KEEP_USER_OVERRIDE_CONTEXT\n",
    );
    const modelPath = join(dir, "model.json");
    await writeFile(
      modelPath,
      JSON.stringify({
        id: "fixture",
        api: "openai-completions",
        contextWindow: 32768,
        maxOutputTokens: 2048,
      }),
    );
    const content = await readFile(guidance, "utf8");
    for (const [name, cwd, flags, marker] of [
      ["separate workspace", workspace, []],
      ["repository root", root, []],
      ["symlink cwd", alias, []],
      ["user AGENTS", custom, [], "KEEP_USER_PROJECT_CONTEXT"],
      ["user override", overridden, [], "KEEP_USER_OVERRIDE_CONTEXT"],
      ["discovery disabled", root, ["--no-context-files"]],
      ["explicit codemode", workspace, ["--tools", "+codemode"]],
      ["explicit allowlist", workspace, ["-t", "read,bash"]],
    ]) {
      await t.test(name, async () => {
        const operation = promisify(execFile)(
          process.execPath,
          [
            join(root, "packages/pi-extension/bootstrap.mjs"),
            ...flags,
            "--print",
            "Complete the local entry fixture.",
          ],
          {
            cwd,
            timeout: 10000,
            env: {
              PATH: process.env.PATH,
              HOME: dir,
              ARENA_MODEL_CONFIG: modelPath,
              OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
              OPENAI_API_KEY: "entry-fixture-only",
              PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
              MC_INBOX_TRANSPORT: "http",
              MC_INBOX_TOKEN: "entry-inbox-fixture-only",
            },
          },
        );
        operation.child.stdin.end();
        const { stdout, stderr } = await operation;
        assert.match(stdout, /Entry fixture complete/);
        assert.doesNotMatch(stderr, /Error loading extension/);
        const request = requests.at(-1);
        assert.deepEqual(
          request.tools.map((tool) => tool.function.name).toSorted(),
          flags.includes("+codemode")
            ? [...defaultTools, "codemode"].toSorted()
            : flags.includes("read,bash")
              ? ["bash", "read"]
              : defaultTools,
          "default tools and explicit CLI selection reach the real provider",
        );
        const system = request.messages.find(
          (message) => message.role === "system",
        ).content;
        assert.equal(system.split(content.trim()).length - 1, 1, name);
        if (marker)
          assert.ok(system.includes(marker), "user instructions remain loaded");
      });
    }
    assert.equal(requests.length, 8);
  },
);

test(
  "real default bootstrap returns direct bash stdout and observe state without codemode",
  { timeout: 20000 },
  async (t) => {
    const { dir } = await fixture(t);
    const backend = new EventEmitter();
    Object.assign(backend, {
      version: "1.21.1",
      username: "entry-observer",
      entity: {
        id: 1,
        position: new Vector(0, 1, 0),
        velocity: new Vector(),
        yaw: 0,
        pitch: 0,
        height: 1.8,
      },
      entities: {},
      inventory: {
        slots: Array(46).fill(null),
        inventoryStart: 9,
        inventoryEnd: 45,
      },
      health: 20,
      food: 20,
      game: {},
      controlState: {},
      blockAt: (position) => ({
        position: new Vector(position.x, position.y, position.z),
        name: position.y === 0 ? "stone" : "air",
        stateId: position.y === 0 ? 1 : 0,
        type: position.y === 0 ? 1 : 0,
        shapes: position.y === 0 ? [[0, 0, 0, 1, 1, 1]] : [],
        boundingBox: position.y === 0 ? "block" : "empty",
      }),
    });
    const bridge = await startBridge({
      bot: backend,
      token: "entry-observe-fixture-token",
      snapshotRadius: 1,
    });
    t.after(() => bridge.close());
    let actions = 0;
    bridge.server.on("request", (request) => {
      if (request.url === "/v1/action") actions++;
    });
    const requests = [];
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push(JSON.parse(raw));
      const first = requests.length === 1;
      const delta = first
        ? {
            role: "assistant",
            tool_calls: [
              {
                name: "bash",
                args: {
                  command: "node -e 'console.log(\"DIRECT_NODE_STDOUT\")'",
                  wait_seconds: 5,
                },
              },
              {
                name: "observe",
                args: {},
              },
            ].map(({ name, args }, index) => ({
              index,
              id: `entry-direct-${name}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            })),
          }
        : { role: "assistant", content: "Direct entry fixture complete." };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: "entry-direct-fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    const modelPath = join(dir, "model.json");
    await writeFile(
      modelPath,
      JSON.stringify({
        id: "fixture",
        api: "openai-completions",
        contextWindow: 32768,
        maxOutputTokens: 2048,
      }),
    );
    const operation = promisify(execFile)(
      process.execPath,
      [
        join(root, "packages/pi-extension/bootstrap.mjs"),
        "--print",
        "Run the direct-tool entry fixture.",
      ],
      {
        cwd: dir,
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          ARENA_MODEL_CONFIG: modelPath,
          OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
          OPENAI_API_KEY: "entry-fixture-only",
          ARENA_BRIDGE_URL: bridge.url,
          ARENA_BRIDGE_TOKEN: "entry-observe-fixture-token",
          MC_INBOX_TRANSPORT: "http",
          MC_INBOX_TOKEN: "entry-inbox-fixture-only",
          PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
        },
      },
    );
    operation.child.stdin.end();
    const { stdout, stderr } = await operation;
    assert.match(stdout, /Direct entry fixture complete/);
    assert.doesNotMatch(stderr, /Error loading extension/);
    assert.equal(requests.length, 2);
    for (const request of requests)
      assert.deepEqual(
        request.tools.map((tool) => tool.function.name).toSorted(),
        defaultTools,
      );
    const messages = requests[1].messages;
    const bash = messages.find(
      (message) =>
        message.role === "tool" && message.tool_call_id === "entry-direct-bash",
    );
    assert.ok(bash, "native bash tool result reaches the next request");
    assert.match(JSON.stringify(bash), /DIRECT_NODE_STDOUT/);
    assert.match(JSON.stringify(bash), /completed/);
    const observation = messages.find(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === "entry-direct-observe",
    );
    assert.ok(observation, "native observe result reaches the next request");
    assert.match(JSON.stringify(observation), /entry-observer/);
    assert.equal(actions, 0, "direct observation does not submit game actions");
  },
);
