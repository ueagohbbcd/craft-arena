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
  await writeFile(join(root, "strategy.mjs"), "code");
  const archive = await archiveParticipantState(root, "run-1");
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
  for (const path of [".arena-history", ".pi", "match-artifacts"]) {
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
    }
  }
});

test("Windows deployment uses operator world/config and one server metadata source", async () => {
  const init = await readFile(
    new URL("../scripts/initialize-windows-arena.ps1", import.meta.url),
    "utf8",
  );
  const control = await readFile(
    new URL("../scripts/windows-arena.ps1", import.meta.url),
    "utf8",
  );
  assert.match(init, /\[Parameter\(Mandatory\)\]\[string\]\$WorldDir/);
  assert.match(init, /\[Parameter\(Mandatory\)\]\[string\]\$MatchConfig/);
  assert.match(init, /Get-Content -LiteralPath \$ServerDownload/);
  assert.match(init, /Get-FileHash[^\n]+\$download\.sha1/);
  assert.match(init, /DeploymentDir must not be inside WorldDir/);
  assert.match(init, /\[IO\.Directory\]::Move\(\$stage, \$destination\)/);
  assert.match(init, /Assert-ArenaPath \$stage -Root \$parent -Tree/);
  for (const text of [init, control]) {
    assert.match(text, /map-original\/world/);
    assert.doesNotMatch(
      text,
      /Direct-Fire|match\.direct-fire|450698d186|80d40110a81/,
    );
  }
  assert.match(control, /archive-participant-state\.mjs/);
});
