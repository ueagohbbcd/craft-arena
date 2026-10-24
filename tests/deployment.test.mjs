import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveParticipantState } from "../scripts/archive-participant-state.mjs";

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "arena-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("reset archives known match state while retaining code, settings and old traces", async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, ".pi", "sessions"), { recursive: true });
  await mkdir(join(root, "match-artifacts"));
  await writeFile(join(root, ".pi", "settings.json"), "settings");
  await writeFile(join(root, ".pi", "sessions", "run.jsonl"), "transcript");
  await writeFile(join(root, "match-artifacts", "map.json"), "map");
  await mkdir(join(root, ".mf", "tasks", "t1"), { recursive: true });
  await writeFile(join(root, ".mf", "inbox.jsonl"), "inbox");
  await mkdir(join(root, ".arena", "tasks", "c1"), { recursive: true });
  await writeFile(join(root, ".arena", "tasks", "c1", "stdout.log"), "out");
  await writeFile(join(root, "strategy.mjs"), "code");
  const archive = await archiveParticipantState(root, "run-1");
  assert.equal(await readFile(join(archive, "mf", "inbox.jsonl"), "utf8"), "inbox");
  assert.deepEqual(await readdir(join(archive, "mf", "tasks")), ["t1"]);
  assert.equal(
    await readFile(join(archive, "tasks", "c1", "stdout.log"), "utf8"),
    "out",
  );
  assert.deepEqual(await readdir(join(root, ".arena")), []);
  assert.equal(
    await readFile(join(archive, "sessions", "run.jsonl"), "utf8"),
    "transcript",
  );
  assert.equal(
    await readFile(join(archive, "match-artifacts", "map.json"), "utf8"),
    "map",
  );
  assert.equal(
    await readFile(join(root, ".pi", "settings.json"), "utf8"),
    "settings",
  );
  assert.equal(await readFile(join(root, "strategy.mjs"), "utf8"), "code");
  assert.deepEqual(await readdir(join(root, ".pi")), ["settings.json"]);
  assert.equal(await archiveParticipantState(root, "run-2"), undefined);
  await mkdir(join(root, "match-artifacts"));
  await assert.rejects(archiveParticipantState(root, "run-1"), {
    code: "EEXIST",
  });
  assert.deepEqual(await readdir(join(root, "match-artifacts")), []);
});

test("reset refuses traversal IDs and symlinks before moving participant state", async (t) => {
  const root = await workspace(t);
  const outside = await workspace(t);
  await writeFile(join(outside, "keep.txt"), "keep");
  await assert.rejects(
    archiveParticipantState(root, "../outside"),
    /archive ID/,
  );
  for (const path of [".arena-history", ".pi", "match-artifacts", ".mf", ".arena"]) {
    await symlink(outside, join(root, path), "dir");
    await assert.rejects(
      archiveParticipantState(root, "run-1"),
      /ordinary directory/,
    );
    await rm(join(root, path));
  }
  await mkdir(join(root, ".pi"));
  await symlink(outside, join(root, ".pi", "sessions"), "dir");
  await assert.rejects(
    archiveParticipantState(root, "run-1"),
    /ordinary directory/,
  );
  assert.deepEqual(await readdir(outside), ["keep.txt"]);
});

test("Docker dependency layers precede source copies and participant image excludes operator config", async () => {
  for (const name of ["participant", "trusted"]) {
    const dockerfile = await readFile(
      new URL(`../infra/Dockerfile.${name}`, import.meta.url),
      "utf8",
    );
    const manifests = dockerfile.indexOf(
      "COPY --chown=node:node package.json package-lock.json ./",
    );
    const install = dockerfile.indexOf("RUN npm ci");
    const source = dockerfile.indexOf(
      name === "participant"
        ? "COPY --chown=node:node packages"
        : "COPY --chown=node:node . .",
    );
    assert(manifests >= 0 && manifests < install && install < source);
    if (name === "participant") {
      assert.doesNotMatch(dockerfile, /COPY[^\n]*(?:infra|\. \.|runtime)/);
      assert.match(dockerfile, /USER node/);
      assert.match(
        dockerfile,
        /apt-get[^\n]*install[^\n]*\bripgrep\b[^\n]*\bfd-find\b/,
        "offline Pi search tools must be present in the image",
      );
      assert.match(
        dockerfile,
        /RUN npm ci[^\n]*&& node scripts\/prune-node-modules\.mjs node_modules 1\.21\.1/,
        "participant image drops Minecraft data for other versions",
      );
    }
  }
});

test("participant image carries only participant-side code", async () => {
  const dockerfile = await readFile(
    new URL("../infra/Dockerfile.participant", import.meta.url),
    "utf8",
  );
  const copied = [...dockerfile.matchAll(/^COPY --chown=node:node (\S+) /gm)]
    .map((m) => m[1])
    .filter((path) => path !== "package.json");
  // The characters and their runtime come from the toolkit package.
  const participant = ["pi-extension", "world-visual"];
  for (const path of copied)
    if (path.startsWith("packages"))
      assert.ok(
        participant.some((name) => path === `packages/${name}`),
        `${path} is not a participant package`,
      );
  for (const name of participant)
    assert.ok(copied.includes(`packages/${name}`), `missing packages/${name}`);
  assert.ok(
    !copied.includes("packages/login-gate"),
    "login gate is trusted-side code",
  );
  // The appended system prompt and the skill the launcher passes to Pi.
  for (const path of ["examples", "participant"])
    assert.ok(copied.includes(path), `missing ${path}`);
  for (const path of copied)
    assert.doesNotMatch(path, /^(?:tests|docs\/?$|scripts\/?$|README)/);
  // Participant code must not import trusted-side packages.
  const { readdir } = await import("node:fs/promises");
  for (const name of participant) {
    const dir = new URL(`../packages/${name}/`, import.meta.url);
    for (const file of await readdir(dir))
      if (file.endsWith(".mjs"))
        assert.doesNotMatch(
          await readFile(new URL(file, dir), "utf8"),
          /^import[^;]*["']\.\.\/(?:arena|model-relay|login-gate)\//m,
          `packages/${name}/${file}`,
        );
  }
  // The examples import only participant packages.
  for (const file of await readdir(new URL("../examples/", import.meta.url)))
    if (file.endsWith(".mjs"))
      for (const [, pkg] of (
        await readFile(new URL(`../examples/${file}`, import.meta.url), "utf8")
      ).matchAll(/\.\.\/packages\/([a-z-]+)\//g))
        assert.ok(participant.includes(pkg), `examples/${file} uses ${pkg}`);
});
