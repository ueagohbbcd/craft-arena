import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareMinecraftServer,
  validateServerDownload,
  verifyDownload,
} from "../scripts/prepare-minecraft-server.mjs";
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "arena-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory };
}
test("download manifest is the single pinned Minecraft/Fabric/mod source", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../infra/minecraft-download.json", import.meta.url),
      "utf8",
    ),
  );
  validateServerDownload(manifest);
  assert.equal(manifest.mods.length, 3);
  assert.ok(manifest.mods.every((mod) => mod.sha512 && mod.release_url));
  // Native bot hosts connect to servers running the pinned Minecraft version.
  for (const name of [
    "compose.live.yaml",
    "../packages/arena/src/provision.mjs",
  ]) {
    const text = await readFile(
      new URL(`../infra/${name}`, import.meta.url),
      "utf8",
    );
    const versions = [...text.matchAll(/MC_VERSION:.*?([\d.]+)/g)];
    assert.ok(versions.length >= 1, name);
    for (const [, version] of versions)
      assert.equal(version, manifest.minecraftVersion, name);
  }
});

test("preparation checks downloaded bytes and refuses to overwrite build contexts", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("downloaded fixture");
  const manifest = {
    minecraftVersion: "test",
    url: "https://example.invalid/server.jar",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const manifestPath = join(f.directory, "download.json");
  const destination = join(f.directory, "server");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => bytes });
  await prepareMinecraftServer({ destination, manifestPath, fetchImpl });
  assert.deepEqual(await readFile(join(destination, "server.jar")), bytes);
  assert.match(
    await readFile(join(destination, "run.sh"), "utf8"),
    /exec java/,
  );
  await assert.rejects(
    prepareMinecraftServer({ destination, manifestPath, fetchImpl }),
    { code: "EEXIST" },
  );
  assert.throws(
    () => verifyDownload(Buffer.from("wrong"), manifest),
    /mismatch/,
  );
  const bad = { ...manifest, size: bytes.length, sha256: "0".repeat(64) };
  await writeFile(manifestPath, JSON.stringify(bad));
  await assert.rejects(
    prepareMinecraftServer({
      destination: join(f.directory, "bad"),
      manifestPath,
      fetchImpl,
    }),
    /mismatch/,
  );
  assert.ok(!(await readdir(f.directory)).includes("bad"));
});

// The Windows initializer delegates download validation to this same helper.
test("server preparation accepts each supported pinned digest", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("local server fixture");
  const serverJar = join(f.directory, "server.jar");
  await writeFile(serverJar, bytes);
  for (const algorithm of ["sha1", "sha256", "sha512"]) {
    const manifestPath = join(f.directory, `${algorithm}.json`);
    await writeFile(
      manifestPath,
      JSON.stringify({
        minecraftVersion: "test",
        url: "https://example.invalid/server.jar",
        size: bytes.length,
        [algorithm]: createHash(algorithm).update(bytes).digest("hex"),
      }),
    );
    const destination = join(f.directory, algorithm);
    await prepareMinecraftServer({ destination, manifestPath, serverJar });
    assert.deepEqual(await readFile(join(destination, "server.jar")), bytes);
  }
});

test("the anticheat profile is the default server plus Grim, configured to only record", async () => {
  const read = async (path) =>
    readFile(new URL(`../infra/${path}`, import.meta.url), "utf8");
  const base = JSON.parse(await read("minecraft-download.json"));
  const profile = JSON.parse(await read("minecraft-anticheat.json"));
  validateServerDownload(profile);
  assert.equal(profile.url, base.url);
  assert.deepEqual(profile.fabric, base.fabric);
  assert.deepEqual(profile.mods.slice(0, base.mods.length), base.mods);
  assert.deepEqual(
    profile.mods.slice(base.mods.length).map((mod) => mod.component),
    ["grimac"],
  );
  const config = await read(
    "server-profiles/anticheat/config/GrimAC/config.yml",
  );
  for (const line of [
    /^ {4}immediate-setback-threshold: -1$/gm,
    /^ {4}max-advantage: -1$/gm,
  ])
    assert.equal(config.match(line)?.length, 2);
  assert.doesNotMatch(config, /^ {4}(?:setbackvl|cancelvl): (?!1000000$)/m);
  assert.match(config, /^ {4}block-impossible-hits: false$/m);
  assert.match(config, /^max-transaction-time: 86400$/m);
  assert.match(config, /^config-version: 11$/m);
  const punishments = await read(
    "server-profiles/anticheat/config/GrimAC/punishments.yml",
  );
  for (const [, command] of punishments.matchAll(/^\s+- "\d+:\d+ (.*)"$/gm))
    assert.match(command, /^\[(?:alert|log)\]$/);
});

test("profile server files are copied at every start", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("server");
  await writeFile(join(f.directory, "grim.yml"), "quiet: true\n");
  const manifestPath = join(f.directory, "download.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      minecraftVersion: "test",
      url: "https://example.invalid/server.jar",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      serverFiles: [{ source: "grim.yml", target: "config/GrimAC/config.yml" }],
    }),
  );
  const destination = join(f.directory, "server");
  await prepareMinecraftServer({
    destination,
    manifestPath,
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => bytes }),
  });
  assert.equal(
    await readFile(
      join(destination, "server-files/config/GrimAC/config.yml"),
      "utf8",
    ),
    "quiet: true\n",
  );
  assert.match(
    await readFile(join(destination, "run.sh"), "utf8"),
    /cp -R \/opt\/minecraft\/server-files\/\. \.\//,
  );
  assert.throws(
    () =>
      validateServerDownload({
        minecraftVersion: "test",
        url: "https://example.invalid/server.jar",
        size: 1,
        sha256: "0".repeat(64),
        serverFiles: [{ source: "x", target: "../escape" }],
      }),
    /relative target/,
  );
});
