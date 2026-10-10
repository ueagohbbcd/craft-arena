#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const referenceRepositories = JSON.parse(
  await readFile(new URL("./mf-reference.json", import.meta.url), "utf8"),
);

/** Full Git checkouts for offline reading only; never install or run repository code. */
export async function prepareReferences(
  root,
  repositories = referenceRepositories,
) {
  await mkdir(root, { recursive: true });
  for (const { name, version, url, commit } of repositories) {
    const directory = join(root, name);
    execFileSync("git", ["clone", "--no-checkout", url, directory], {
      stdio: "inherit",
    });
    execFileSync("git", ["-C", directory, "checkout", "--detach", commit], {
      stdio: "inherit",
    });
    const actual = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    if (actual.name !== name || actual.version !== version)
      throw new Error(`Reference checkout does not match ${name}@${version}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await prepareReferences(
    process.argv[2] || process.env.ARENA_REFERENCE_ROOT || "/opt/mf-reference",
  );
