import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  commandLines as lines,
  datapackFiles,
  datapackRoot,
  functionPath,
} from "./helpers/datapack.mjs";

const root = datapackRoot("arena-example");
const files = (dir) => datapackFiles(root, dir);

test("example datapack declares 1.21.1 and singular folder names", async () => {
  const pack = JSON.parse(await readFile(join(root, "pack.mcmeta"), "utf8"));
  assert.equal(pack.pack.pack_format, 48);
  assert.equal(typeof pack.pack.description, "string");
  const all = await files(root);
  for (const path of all.filter((p) => p.startsWith("data/")))
    assert.doesNotMatch(path, /\/(functions|tags\/functions)\//, path);
});

test("every function tag entry resolves to a function file", async () => {
  const all = new Set(await files(root));
  const tags = {
    "data/arena/tags/function/prepare.json": true,
    "data/arena/tags/function/start.json": true,
    "data/arena/tags/function/stop.json": true,
    "data/minecraft/tags/function/tick.json": true,
  };
  for (const tag of Object.keys(tags)) {
    assert(all.has(tag), `missing ${tag}`);
    const { values } = JSON.parse(await readFile(join(root, tag), "utf8"));
    assert(Array.isArray(values) && values.length > 0, tag);
    for (const id of values) {
      assert.match(id, /^arena_example:[a-z0-9_/]+$/);
      assert(all.has(functionPath(id)), `${tag} -> ${id}`);
    }
  }
  // Calls between functions resolve too.
  for (const path of [...all].filter((p) => p.endsWith(".mcfunction"))) {
    const text = await readFile(join(root, path), "utf8");
    for (const [, id] of text.matchAll(/\bfunction (arena_example:[\w/]+)/g))
      assert(all.has(functionPath(id)), `${path} calls ${id}`);
  }
});

test("functions write arena:session with the protocol v1 fields", async () => {
  const fn = (name) =>
    readFile(
      join(root, `data/arena_example/function/${name}.mcfunction`),
      "utf8",
    );
  const prepare = await fn("prepare");
  const reset = prepare.match(/^data merge storage arena:session (\{.*\})$/m);
  assert(reset, "prepare resets arena:session");
  // Stale nested compounds from a previous session are cleared before the merge.
  assert.match(prepare, /^data remove storage arena:session scores$/m);
  assert.match(prepare, /^data remove storage arena:session public$/m);
  for (const field of [
    "version:1",
    'state:"waiting"',
    'winner:""',
    "scores:{red:0,blue:0}",
    "public:{",
    'message:""',
  ])
    assert(reset[1].includes(field), field);
  assert.match(prepare, /from storage arena:config teams/);
  assert.match(prepare, /scoreboard objectives add arena_points/);
  assert.match(prepare, /gamemode adventure/);
  assert.match(await fn("start"), /arena:session state set value "running"/);
  const stop = await fn("stop");
  assert.match(stop, /arena:session \{state:"ended"\}/);
  assert.match(stop, /arena:session state set value "ended"/);
  const tick = await fn("tick");
  assert.match(tick, /unless data storage arena:session \{state:"running"\}/);
  assert.match(await fn("sync_scores"), /arena:session scores\.red int/);
  assert.match(await fn("sync_scores"), /arena:session scores\.blue int/);
  const finish = await fn("finish");
  assert.match(finish, /arena:session winner set value "\$\(winner\)"/);
  assert.match(finish, /arena:session state set value "ended"/);
});

test("data modify always names a path below the storage root", async () => {
  // `data modify storage <id> set value …` parses `set` as the path and fails.
  const all = (await files(root)).filter((p) => p.endsWith(".mcfunction"));
  for (const path of all) {
    const text = await readFile(join(root, path), "utf8");
    for (const line of lines(text))
      assert.doesNotMatch(
        line,
        /data modify storage \S+ (set|merge|append|prepend|insert)\b/,
        `${path}: ${line}`,
      );
  }
});

test("macro lines start with $ and only macro functions use $(…)", async () => {
  const all = (await files(root)).filter((p) => p.endsWith(".mcfunction"));
  const macros = new Set();
  for (const path of all) {
    const text = await readFile(join(root, path), "utf8");
    for (const line of lines(text)) {
      if (line.includes("$(")) {
        assert(line.startsWith("$"), `${path}: ${line}`);
        macros.add(path);
      }
      if (line.startsWith("$")) assert.match(line, /\$\([a-z_]+\)/, line);
    }
  }
  assert(macros.has("data/arena_example/function/assign/join.mcfunction"));
  assert(macros.has("data/arena_example/function/finish.mcfunction"));
  // Macro functions are only called with arguments.
  for (const path of all) {
    const text = await readFile(join(root, path), "utf8");
    for (const [, id, rest] of text.matchAll(
      /\bfunction (arena_example:[\w/]+)(.*)$/gm,
    ))
      if (macros.has(functionPath(id)))
        assert.match(rest, /^ (with |\{)/, `${path} calls ${id}${rest}`);
  }
});
