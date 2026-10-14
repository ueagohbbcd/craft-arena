import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of infra/datapacks/<name>/. */
export const datapackRoot = (name) =>
  fileURLToPath(new URL(`../../infra/datapacks/${name}/`, import.meta.url));

/** Every file under `root`, as sorted `/`-separated paths relative to it. */
export async function datapackFiles(root, dir = root) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await datapackFiles(root, path)));
    else out.push(relative(root, path).split(sep).join("/"));
  }
  return out.sort();
}

/** `namespace:path` → its .mcfunction path inside the pack. */
export function functionPath(id) {
  const [ns, path] = id.split(":");
  return `data/${ns}/function/${path}.mcfunction`;
}

/** Command lines of an .mcfunction file (no blanks, no comments). */
export const commandLines = (text) =>
  text.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
