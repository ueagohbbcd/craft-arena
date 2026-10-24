import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
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
import { systemPromptArgs } from "../packages/pi-extension/bootstrap.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const guidance = join(root, "participant", "agents.d", "10-arena.md");
const arenaGuidanceArgs = (options) =>
  systemPromptArgs({ ...options, files: [guidance] });
const append = ["--append-system-prompt", guidance];
const defaultTools = ["bash", "edit", "read", "write"];

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
  for (const cwd of [alias, join(alias, "participant", "agents.d")])
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
              ARENA_PI_MODEL: "groq/qwen/qwen3.8-27b",
              ARENA_PI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
              ARENA_PI_API_KEY: "entry-fixture-only",
              PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
              // Task files would otherwise go under <cwd>/.arena.
              ARENA_TASK_DIR: join(dir, "tasks"),
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
        // Pi sends the system prompt as `developer` to reasoning models.
        const system = request.messages.find((message) =>
          ["system", "developer"].includes(message.role),
        ).content;
        assert.equal(system.split(content.trim()).length - 1, 1, name);
        if (marker)
          assert.ok(system.includes(marker), "user instructions remain loaded");
      });
    }
    assert.equal(requests.length, 8);
  },
);
