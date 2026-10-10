import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (/\.(mjs|cjs|js)$/.test(p)) {
      const r = spawnSync(process.execPath, ["--check", p], {
        stdio: "inherit",
      });
      if (r.status !== 0) process.exit(r.status || 1);
    }
  }
}
for (const path of ["packages", "examples", "tests", "scripts"])
  await walk(path);
console.log("JavaScript syntax checks passed.");
