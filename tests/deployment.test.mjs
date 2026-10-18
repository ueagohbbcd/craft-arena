import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveParticipantState } from "../scripts/archive-participant-state.mjs";

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "arena-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("reset archives known match state while retaining code, settings and old traces", async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, ".pi", "sessions"), { recursive: true });
  await mkdir(join(root, "match-artifacts"));
  await writeFile(join(root, ".pi", "settings.json"), "settings");
  await writeFile(join(root, ".pi", "sessions", "run.jsonl"), "transcript");
  await writeFile(join(root, "match-artifacts", "map.json"), "map");
  await writeFile(join(root, "strategy.mjs"), "code");
  const archive = await archiveParticipantState(root, "run-1");
  assert.equal(
    await readFile(join(archive, "sessions", "run.jsonl"), "utf8"),
    "transcript",
  );
  assert.equal(
    await readFile(join(archive, "match-artifacts", "map.json"), "utf8"),
    "map",
  );
  assert.equal(
    await readFile(join(root, ".pi", "settings.json"), "utf8"),
    "settings",
  );
  assert.equal(await readFile(join(root, "strategy.mjs"), "utf8"), "code");
  assert.deepEqual(await readdir(join(root, ".pi")), ["settings.json"]);
  assert.equal(await archiveParticipantState(root, "run-2"), undefined);
  await mkdir(join(root, "match-artifacts"));
  await assert.rejects(archiveParticipantState(root, "run-1"), {
    code: "EEXIST",
  });
  assert.deepEqual(await readdir(join(root, "match-artifacts")), []);
});

test("reset refuses traversal IDs and symlinks before moving participant state", async (t) => {
  const root = await workspace(t);
  const outside = await workspace(t);
  await writeFile(join(outside, "keep.txt"), "keep");
  await assert.rejects(
    archiveParticipantState(root, "../outside"),
    /archive ID/,
  );
  for (const path of [".arena-history", ".pi", "match-artifacts"]) {
    await symlink(outside, join(root, path), "dir");
    await assert.rejects(
      archiveParticipantState(root, "run-1"),
      /ordinary directory/,
    );
    await rm(join(root, path));
  }
  await mkdir(join(root, ".pi"));
  await symlink(outside, join(root, ".pi", "sessions"), "dir");
  await assert.rejects(
    archiveParticipantState(root, "run-1"),
    /ordinary directory/,
  );
  assert.deepEqual(await readdir(outside), ["keep.txt"]);
});

test("Docker dependency layers precede source copies and participant image excludes operator config", async () => {
  for (const name of ["participant", "trusted"]) {
    const dockerfile = await readFile(
      new URL(`../infra/Dockerfile.${name}`, import.meta.url),
      "utf8",
    );
    const manifests = dockerfile.indexOf(
      "COPY --chown=node:node package.json package-lock.json ./",
    );
    const install = dockerfile.indexOf("RUN npm ci");
    const source = dockerfile.indexOf(
      name === "participant"
        ? "COPY --chown=node:node packages"
        : "COPY --chown=node:node . .",
    );
    assert(manifests >= 0 && manifests < install && install < source);
    if (name === "participant") {
      assert.doesNotMatch(dockerfile, /COPY[^\n]*(?:infra|\. \.|runtime)/);
      assert.match(dockerfile, /USER node/);
      assert.match(
        dockerfile,
        /apt-get[^\n]*install[^\n]*\bripgrep\b[^\n]*\bfd-find\b/,
        "offline Pi search tools must be present in the image",
      );
      assert.match(
        dockerfile,
        /RUN npm ci[^\n]*&& node scripts\/prune-node-modules\.mjs node_modules 1\.21\.1/,
        "participant image drops Minecraft data for other versions",
      );
    }
  }
});

test("Windows deployment uses operator world/config and one server metadata source", async () => {
  const init = await readFile(
    new URL("../scripts/initialize-windows-arena.ps1", import.meta.url),
    "utf8",
  );
  const control = await readFile(
    new URL("../scripts/windows-arena.ps1", import.meta.url),
    "utf8",
  );
  assert.match(init, /\[Parameter\(Mandatory\)\]\[string\]\$WorldDir/);
  assert.match(init, /\[Parameter\(Mandatory\)\]\[string\]\$MatchConfig/);
  assert.match(init, /Get-Content -LiteralPath \$ServerDownload/);
  assert.match(init, /prepare-minecraft-server\.mjs/);
  assert.match(init, /\$download\.minecraftVersion -ne '1\.21\.1'/);
  assert.match(init, /packages\/arena\/src\/cli\.mjs'\) check \$match/);
  assert.match(init, /DeploymentDir must not be inside WorldDir/);
  assert.match(init, /\[IO\.Directory\]::Move\(\$stage, \$destination\)/);
  assert.match(init, /Assert-ArenaPath \$stage -Root \$parent -Tree/);
  for (const text of [init, control]) {
    assert.match(text, /map-original\/world/);
    assert.doesNotMatch(
      text,
      /Direct-Fire|match\.direct-fire|450698d186|80d40110a81/,
    );
  }
  assert.match(control, /archive-participant-state\.mjs/);
});

test("live deployment: replay storage only on the server, bridges read the session over RCON", async () => {
  for (const path of ["compose.live.yaml", "windows-local/compose.yaml"]) {
    const text = await readFile(
      new URL(`../infra/${path}`, import.meta.url),
      "utf8",
    );
    const sections = Object.fromEntries(
      [
        ...text.matchAll(
          /^  ([a-z][a-z0-9-]+):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]+:|^networks:|^volumes:|(?![\s\S]))/gm,
        ),
      ].map((match) => [match[1], match[2]]),
    );
    assert.match(sections.minecraft, /:\/results/);
    assert.match(sections.minecraft, /replay-config/);
    assert.match(sections.minecraft, /stop_grace_period/);
    assert.equal(sections["arena-host"], undefined);
    assert.match(sections.arena, /profiles: \[tools\]/);
    for (const [name, section] of Object.entries(sections))
      if (name.startsWith("bridge-")) {
        assert.match(section, /BRIDGE_SESSION: server/);
        assert.match(section, /BRIDGE_RCON_HOST: minecraft/);
      }
    for (const [name, section] of Object.entries(sections))
      if (name.startsWith("participant-"))
        assert.doesNotMatch(
          section,
          /replay-config|:\/results|minecraft-data|world:\/data/,
        );
  }
  const init = await readFile(
    new URL("../scripts/initialize-windows-arena.ps1", import.meta.url),
    "utf8",
  );
  const control = await readFile(
    new URL("../scripts/windows-arena.ps1", import.meta.url),
    "utf8",
  );
  assert.match(init, /\.\.\/infra\/minecraft-download\.json/);
  assert.doesNotMatch(control, /arena-host|supervise-participants/);
  assert.match(control, /Invoke-Arena 'prepare' '\/config\/match\.json'/);
});

test("participant image carries only participant-side code", async () => {
  const dockerfile = await readFile(
    new URL("../infra/Dockerfile.participant", import.meta.url),
    "utf8",
  );
  const copied = [...dockerfile.matchAll(/^COPY --chown=node:node (\S+) /gm)]
    .map((m) => m[1])
    .filter((path) => path !== "package.json");
  const participant = [
    "pi-extension",
    "tasks",
    "inbox",
    "bot-sdk",
    "bridge-protocol",
    "observation",
    "default-scripts",
    "world-visual",
    // Native runtime: the bot and its local bridge run in the container.
    "mf-bridge",
  ];
  for (const path of copied)
    if (path.startsWith("packages"))
      assert.ok(
        participant.some((name) => path === `packages/${name}`),
        `${path} is not a participant package`,
      );
  for (const name of participant)
    assert.ok(copied.includes(`packages/${name}`), `missing packages/${name}`);
  // The appended system prompt and the skill the launcher passes to Pi.
  for (const path of ["examples", "participant"])
    assert.ok(copied.includes(path), `missing ${path}`);
  for (const path of copied)
    assert.doesNotMatch(path, /^(?:tests|docs\/?$|scripts\/?$|README)/);
  // Participant code must not import trusted-side packages.
  const { readdir } = await import("node:fs/promises");
  for (const name of participant) {
    const dir = new URL(`../packages/${name}/`, import.meta.url);
    for (const file of await readdir(dir))
      if (file.endsWith(".mjs"))
        assert.doesNotMatch(
          await readFile(new URL(file, dir), "utf8"),
          /^import[^;]*["']\.\.\/(?:arena|model-relay|login-gate)\//m,
          `packages/${name}/${file}`,
        );
  }
  // The examples import only participant packages.
  for (const file of await readdir(new URL("../examples/", import.meta.url)))
    if (file.endsWith(".mjs"))
      for (const [, pkg] of (
        await readFile(new URL(`../examples/${file}`, import.meta.url), "utf8")
      ).matchAll(/\.\.\/packages\/([a-z-]+)\//g))
        assert.ok(participant.includes(pkg), `examples/${file} uses ${pkg}`);
});
