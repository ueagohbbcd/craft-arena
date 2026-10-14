import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSnbt } from "../packages/arena/src/snbt.mjs";

const root = fileURLToPath(
  new URL("../infra/datapacks/race-of-wool/", import.meta.url),
);

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else out.push(relative(root, path).split(sep).join("/"));
  }
  return out.sort();
}
const functionPath = (id) => {
  const [ns, path] = id.split(":");
  return `data/${ns}/function/${path}.mcfunction`;
};
const lines = (text) =>
  text.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
const fn = (name) =>
  readFile(join(root, `data/race_of_wool/function/${name}.mcfunction`), "utf8");

test("race-of-wool datapack: 1.21.1 layout, tags and calls resolve", async () => {
  const pack = JSON.parse(await readFile(join(root, "pack.mcmeta"), "utf8"));
  assert.equal(pack.pack.pack_format, 48);
  const all = new Set(await files(root));
  for (const tag of [
    "data/arena/tags/function/prepare.json",
    "data/arena/tags/function/start.json",
    "data/arena/tags/function/stop.json",
    "data/minecraft/tags/function/tick.json",
  ]) {
    const { values } = JSON.parse(await readFile(join(root, tag), "utf8"));
    for (const id of values) assert(all.has(functionPath(id)), `${tag} ${id}`);
  }
  for (const path of [...all].filter((p) => p.endsWith(".mcfunction"))) {
    assert.doesNotMatch(path, /\/functions\//);
    const text = await readFile(join(root, path), "utf8");
    // Direct calls and the walker's {run:"…"} targets.
    for (const [, id] of text.matchAll(
      /(?:\bfunction |run:")(race_of_wool:[\w/]+)/g,
    ))
      assert(all.has(functionPath(id)), `${path} calls ${id}`);
    for (const line of lines(text)) {
      assert.doesNotMatch(
        line,
        /data modify storage \S+ (set|merge|append|prepend|insert)\b/,
        `${path}: ${line}`,
      );
      if (line.includes("$(")) assert(line.startsWith("$"), `${path}: ${line}`);
    }
  }
});

test("race-of-wool prepare writes protocol v1 session state and public data", async () => {
  const prepare = await fn("prepare");
  assert.match(prepare, /^data remove storage arena:session scores$/m);
  assert.match(prepare, /^data remove storage arena:session public$/m);
  const reset = prepare.match(/^data merge storage arena:session (\{.*\})$/m);
  assert.deepEqual(parseSnbt(reset[1]), {
    version: 1,
    state: "waiting",
    winner: "",
    scores: {},
    public: {},
    message: "",
  });
  for (const key of ["objectives", "goals", "watchItems"])
    assert.match(prepare, new RegExp(`arena:session public\\.${key} set from`));
  // Monuments are loaded and emptied before the start.
  assert.match(await fn("reset_goal"), /^\$forceload add \$\(x\) \$\(z\)$/m);
  assert.match(await fn("reset_goal"), /^\$setblock .* air$/m);
  assert.match(await fn("tick"), /\{state:"running"\}/);
  assert.match(await fn("finish"), /winner set value "\$\(winner\)"/);
  assert.match(await fn("stop"), /state set value "ended"/);
});

test("map.mcfunction matches the Direct Fire match config", async () => {
  const text = await fn("map");
  const merge = text.match(/^data merge storage race_of_wool:map (\{.*\})$/m);
  const map = parseSnbt(merge[1]);
  const config = JSON.parse(
    await readFile(
      new URL("../infra/windows-local/match.direct-fire.json", import.meta.url),
      "utf8",
    ),
  );
  const teams = config.teams.map((t) => t.id);
  assert.equal(map.publishGoals, 1);
  assert.equal(new Set(map.objectives).size, map.objectives.length);
  assert.equal(map.goals.length, teams.length * map.objectives.length);
  for (const team of teams)
    for (const objective of map.objectives)
      assert.equal(
        map.goals.filter((g) => g.team === team && g.objective === objective)
          .length,
        1,
        `${team}/${objective}`,
      );
  assert.equal(
    new Set(map.goals.map((g) => `${g.x},${g.y},${g.z}`)).size,
    map.goals.length,
  );
  for (const goal of map.goals) {
    for (const axis of ["x", "y", "z"])
      assert(Number.isSafeInteger(goal[axis]), JSON.stringify(goal));
    assert.match(goal.block, /^minecraft:[a-z_]+(\[.*\])?$/);
  }
  assert.ok(map.watchItems.every((item) => /^[a-z_]+$/.test(item)));
});
