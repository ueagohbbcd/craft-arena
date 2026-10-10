import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareReferences,
  referenceRepositories,
} from "../scripts/prepare-mf-reference.mjs";

function git(directory, ...args) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
  }).trim();
}

test("reference pins match locked runtime dependencies and live in a cached participant layer", async () => {
  const lock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  for (const repo of referenceRepositories) {
    assert.equal(
      repo.version,
      lock.packages[`node_modules/${repo.name}`].version,
    );
    assert.match(repo.commit, /^[0-9a-f]{40}$/);
    assert.equal(repo.url, `https://github.com/PrismarineJS/${repo.name}.git`);
  }
  assert.deepEqual(
    referenceRepositories.map((repo) => repo.name),
    ["mineflayer", "mineflayer-pathfinder", "mineflayer-pvp"],
  );
  const dockerfile = await readFile(
    new URL("../infra/Dockerfile.participant", import.meta.url),
    "utf8",
  );
  assert.match(dockerfile, /ENV ARENA_REFERENCE_ROOT="\/opt\/mf-reference"/);
  assert(
    dockerfile.indexOf("RUN node scripts/prepare-mf-reference.mjs") <
      dockerfile.indexOf("COPY --chown=node:node packages"),
  );
  assert.match(dockerfile, /npm ci --ignore-scripts/);
});

test("reference preparation retains full Git history and checked-out docs/examples without running package scripts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arena-reference-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  git(source, "init", "--quiet");
  git(source, "config", "user.name", "Reference test");
  git(source, "config", "user.email", "test@example.invalid");
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: { postinstall: "touch executed" },
    }),
  );
  for (const directory of ["docs", "examples"]) {
    await mkdir(join(source, directory));
    await writeFile(join(source, directory, "readme.txt"), directory);
  }
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "pinned release");
  const commit = git(source, "rev-parse", "HEAD");
  git(source, "tag", "1.0.0");
  await writeFile(join(source, "later.txt"), "later history");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "later upstream commit");
  await prepareReferences(join(root, "reference"), [
    { name: "fixture", version: "1.0.0", url: source, commit },
  ]);
  const checkout = join(root, "reference", "fixture");
  assert.equal(git(checkout, "rev-parse", "HEAD"), commit);
  assert.equal(git(checkout, "rev-parse", "--is-shallow-repository"), "false");
  assert.equal(git(checkout, "rev-list", "--all", "--count"), "2");
  assert.equal(
    await readFile(join(checkout, "docs", "readme.txt"), "utf8"),
    "docs",
  );
  assert.equal(
    await readFile(join(checkout, "examples", "readme.txt"), "utf8"),
    "examples",
  );
  await access(join(checkout, ".git", "HEAD"));
  await assert.rejects(access(join(checkout, "executed")), { code: "ENOENT" });
  await assert.rejects(access(join(checkout, "node_modules")), {
    code: "ENOENT",
  });
});
