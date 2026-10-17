import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test(
  "Windows initializer delegates all supported digests and rejects wrong bytes",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "arena-init-digests-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const world = join(root, "world");
    await mkdir(world);
    await writeFile(join(world, "level.dat"), "world fixture");
    const bytes = Buffer.from("server fixture, never executed");
    const jar = join(root, "server.jar");
    await writeFile(jar, bytes);
    const match = join(root, "match.json");
    await writeFile(
      match,
      JSON.stringify({ live: { minecraft: { version: "1.21.1" } } }),
    );
    const initializer = fileURLToPath(
      new URL("../scripts/initialize-windows-arena.ps1", import.meta.url),
    );
    for (const algorithm of ["sha1", "sha256", "sha512", "wrong-sha256"]) {
      const digest = algorithm.replace("wrong-", "");
      const manifest = join(root, `${algorithm}.json`);
      await writeFile(
        manifest,
        JSON.stringify({
          minecraftVersion: "1.21.1",
          url: "https://example.invalid/server.jar",
          size: bytes.length,
          [digest]: createHash(digest)
            .update(algorithm.startsWith("wrong") ? "wrong" : bytes)
            .digest("hex"),
        }),
      );
      const destination = join(root, algorithm);
      const result = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-File",
          initializer,
          "-WorldDir",
          world,
          "-MatchConfig",
          match,
          "-DeploymentDir",
          destination,
          "-ServerDownload",
          manifest,
          "-ServerJar",
          jar,
          "-AcceptEula",
          "-BlueModelKeyEnv",
          "ARENA_TEST_UNUSED_KEY",
        ],
        {
          encoding: "utf8",
          timeout: 60000,
          env: {
            ...process.env,
            PATH: dirname(process.execPath) + delimiter + process.env.PATH,
            ARENA_TEST_UNUSED_KEY: "",
          },
        },
      );
      if (algorithm.startsWith("wrong")) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /sha256 mismatch/);
        assert.ok(!(await readdir(root)).includes(algorithm));
      } else {
        assert.equal(result.status, 0, result.stderr || String(result.error));
        assert.deepEqual(
          await readFile(join(destination, "server", "server.jar")),
          bytes,
        );
      }
    }
    assert.ok(
      !(await readdir(root)).some((name) =>
        name.startsWith(".arena-initialize-"),
      ),
    );
  },
);

test("Windows Compose with provisioned agents applies resource defaults and operator overrides", async (t) => {
  const docker =
    process.env.ARENA_TEST_DOCKER ??
    (process.platform === "win32"
      ? join(
          process.env.ProgramFiles,
          "Docker",
          "Docker",
          "resources",
          "bin",
          "docker.exe",
        )
      : "docker");
  const template = fileURLToPath(
    new URL("../infra/windows-local/compose.yaml", import.meta.url),
  );
  const { provision } = await import("../packages/arena/src/provision.mjs");
  const root = await mkdtemp(join(tmpdir(), "arena-provision-compose-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const team of ["red", "blue"])
    await writeFile(
      join(root, `model.${team}.json`),
      await readFile(
        new URL(`../infra/windows-local/model.${team}.json`, import.meta.url),
      ),
    );
  await writeFile(
    join(root, "match.json"),
    JSON.stringify({ config: { sessionId: "compose-test" } }),
  );
  const out = join(root, "deploy");
  await provision({
    mapDir: fileURLToPath(
      new URL("../infra/maps/race-of-wool", import.meta.url),
    ),
    matchPath: join(root, "match.json"),
    outDir: out,
  });
  const env = {
    ...process.env,
    ARENA_SOURCE_DIR: fileURLToPath(new URL("..", import.meta.url)),
  };
  for (const key of [
    "MC_RCON_PASSWORD",
    "BRIDGE_TOKEN_ARENA_RED1",
    "BRIDGE_TOKEN_ARENA_BLUE1",
    "RED_MODEL_URL",
    "BLUE_MODEL_URL",
    "RED_MODEL_KEY",
    "BLUE_MODEL_KEY",
  ])
    env[key] = "test-placeholder";
  for (const [values, expected] of [
    [
      {
        ARENA_CPU_LIMIT: "",
        ARENA_MEMORY_LIMIT: "",
        ARENA_PIDS_LIMIT: "",
        MC_MEMORY_LIMIT: "",
      },
      { cpu: 2, memory: 2 * 1024 ** 3, pids: 256, minecraft: 3 * 1024 ** 3 },
    ],
    [
      {
        ARENA_CPU_LIMIT: "1.25",
        ARENA_MEMORY_LIMIT: "1536m",
        ARENA_PIDS_LIMIT: "192",
        MC_MEMORY_LIMIT: "2560m",
      },
      {
        cpu: 1.25,
        memory: 1536 * 1024 ** 2,
        pids: 192,
        minecraft: 2560 * 1024 ** 2,
      },
    ],
  ]) {
    const result = spawnSync(
      docker,
      [
        "compose",
        "-f",
        template,
        "-f",
        join(out, "compose.agents.yaml"),
        "--profile",
        "agents",
        "config",
        "--format",
        "json",
      ],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { ...env, ...values },
      },
    );
    if (result.error?.code === "ENOENT")
      return t.skip("Docker Compose CLI unavailable");
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const { services } = JSON.parse(result.stdout);
    for (const [participant, relay] of [
      ["participant-red1", "model-red"],
      ["participant-blue1", "model-blue"],
    ]) {
      const player = services[participant];
      const descriptor = player.environment.ARENA_MODEL_CONFIG;
      const playerMount = player.volumes.find((volume) =>
        descriptor.startsWith(`${volume.target}/`),
      );
      assert.ok(playerMount?.read_only, participant);
      assert.equal(player.environment.OPENAI_BASE_URL, `http://${relay}:8080`);
      assert.equal(player.environment.OPENAI_API_KEY, undefined);
      assert.ok(services[relay].environment.MODEL_RELAY_UPSTREAM, relay);
      for (const name of Object.keys(player.environment))
        assert.ok(
          !/^PI_(MAX_TOKENS|CONTEXT_WINDOW|COMPACTION_)|^MODEL_ID$/.test(name),
        );
    }
    for (const [name, service] of Object.entries(services)) {
      assert.equal(Number(service.cpus), expected.cpu, name);
      assert.equal(service.pids_limit, expected.pids, name);
      assert.equal(
        Number(service.mem_limit),
        name === "minecraft" ? expected.minecraft : expected.memory,
        name,
      );
    }
  }
});
