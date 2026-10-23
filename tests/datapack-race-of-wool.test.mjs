import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSnbt } from "../packages/arena/src/snbt.mjs";
import {
  commandLines as lines,
  datapackFiles,
  datapackRoot,
  functionPath,
} from "./helpers/datapack.mjs";

const root = datapackRoot("race-of-wool");
const files = (dir) => datapackFiles(root, dir);
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

test("race-of-wool counts down arena:config.rules.durationMs and draws at zero", async () => {
  assert.match(
    await fn("start"),
    /^execute store result score #left rw_time run data get storage arena:config rules\.durationMs 0\.02$/m,
  );
  assert.match(
    await fn("tick"),
    /if score #left rw_time matches 1\.\. run function race_of_wool:countdown/,
  );
  assert.match(
    await fn("countdown"),
    /matches \.\.0 run function race_of_wool:timeout/,
  );
  const timeout = await fn("timeout");
  assert.match(timeout, /winner set value "draw"/);
  assert.match(timeout, /state set value "ended"/);
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
  const teams = config.config.teams.map((t) => t.id);
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
  // Every team has one start; the datapack, not the match file, moves players.
  for (const team of teams)
    assert.equal(map.starts.filter((s) => s.team === team).length, 1, team);
  for (const start of map.starts)
    for (const key of ["x", "y", "z", "yaw", "pitch"])
      assert(Number.isFinite(start[key]), JSON.stringify(start));
  for (const [phase, list] of Object.entries(config.commands))
    for (const entry of list) {
      const command = entry.command ?? entry;
      assert.doesNotMatch(command, /^(tp|teleport|spawnpoint)\b/, phase);
    }
});

test("race-of-wool start teleports listed players to their team start", async () => {
  const start = lines(await fn("start"));
  const walk = start.indexOf(
    'function race_of_wool:each {run:"race_of_wool:start_team"}',
  );
  assert(walk > 0, "start walks arena:config teams");
  assert(
    walk < start.findIndex((l) => l.includes('state set value "running"')),
    "players move before the release",
  );
  assert.match(
    await fn("start_team"),
    /^execute unless data storage race_of_wool:work start run return 0$/m,
  );
  // A selector, not a bare name: an offline player matches nobody and the
  // start goes on.
  assert.match(
    await fn("start_player"),
    /^\$execute as @a\[name=\$\(player\),limit=1\] in minecraft:overworld run tp @s \$\(x\) \$\(y\) \$\(z\) \$\(yaw\) \$\(pitch\)$/m,
  );
  for (const path of await files(root))
    if (path.endsWith(".mcfunction"))
      for (const line of lines(await readFile(join(root, path), "utf8")))
        assert.doesNotMatch(line, /\bspawnpoint\b/, `${path}: ${line}`);
});
