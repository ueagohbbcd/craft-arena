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
  for (const name of [
    "match.live.template.json",
    "windows-local/match.direct-fire.json",
  ]) {
    const match = JSON.parse(
      await readFile(new URL(`../infra/${name}`, import.meta.url), "utf8"),
    );
    assert.equal(match.live.minecraft.version, manifest.minecraftVersion);
    assert.equal(match.live.replay.enabled, true);
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
