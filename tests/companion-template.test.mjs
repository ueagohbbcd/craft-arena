import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = new URL("../infra/companion/", import.meta.url);
const read = (name) => readFile(new URL(name, dir), "utf8");

function sections(text) {
  return Object.fromEntries(
    [
      ...text.matchAll(
        /^  ([a-z][a-z0-9-]+):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]+:|^networks:|^volumes:|(?![\s\S]))/gm,
      ),
    ].map((match) => [match[1], match[2]]),
  );
}

function environment(section) {
  const block = section.match(/^    environment:\n((?:^      .*\n?)*)/m);
  assert(block, "service has an environment block");
  return Object.fromEntries(
    [...block[1].matchAll(/^      ([A-Z][A-Z0-9_]*): (.*)$/gm)].map((m) => [
      m[1],
      m[2].trim().replace(/^(["'])(.*)\1$/, "$2"),
    ]),
  );
}

const CONTRACT = new Set(["ARENA_CHAT_WAKE"]);

async function sourceText(path) {
  const out = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) out.push(await sourceText(child));
    else if (entry.name.endsWith(".mjs"))
      out.push(await readFile(child, "utf8"));
  }
  return out.join("\n");
}

test("companion compose runs a native bot host behind a login gate and an isolated participant", async () => {
  const text = await read("compose.yaml");
  const services = sections(text);
  assert.deepEqual(Object.keys(services).sort(), [
    "gate",
    "model-relay",
    "participant",
  ]);
  for (const section of Object.values(services)) {
    assert.match(section, /<<: \*restricted/);
    assert.doesNotMatch(section, /^    ports:/m, "no host ports");
  }
  assert.match(text, /cap_drop: \[ALL\]/);
  assert.match(text, /no-new-privileges:true/);
  assert.match(text, /^  companion: \{ ?internal: true ?\}$/m);

  const gate = environment(services.gate);
  assert.match(services.gate, /packages\/login-gate\/cli\.mjs/);
  assert.match(gate.GATE_USERNAMES, /^\$\{MC_USERNAME:\?/);
  assert.match(
    gate.GATE_UPSTREAM_HOST,
    /^\$\{MC_HOST:\?/,
    "external server from env",
  );
  assert.match(services.gate, /networks: \[companion, minecraft-egress\]/);

  const participant = environment(services.participant);
  assert.match(services.participant, /Dockerfile\.participant/);
  assert.equal(participant.ARENA_MINECRAFT_HOST, "gate");
  assert.equal(
    participant.ARENA_BOT,
    "${MC_USERNAME:?Provide the bot account name}",
  );
  assert.equal(participant.ARENA_BRIDGE_URL, undefined);
  assert.equal(participant.ARENA_BRIDGE_TOKEN, undefined);
  assert.match(participant.ARENA_CHAT_WAKE, /mention/);
  assert.equal(participant.OPENAI_BASE_URL, "http://model-relay:8080");
  assert.equal(
    participant.OPENAI_API_KEY,
    undefined,
    "the key stays in the relay",
  );
  assert.match(services.participant, /^    networks: \[companion\]$/m);
  // The model key and the upstream key stay outside the participant.
  assert.doesNotMatch(
    services.participant,
    /MODEL_UPSTREAM|^      BRIDGE_TOKEN:/,
  );
  // Microsoft device login can hold the native bot host back for a long time.
  assert(Number(participant.ARENA_START_TIMEOUT_MS) >= 3600000);

  const relay = environment(services["model-relay"]);
  assert.match(services["model-relay"], /packages\/model-relay\/cli\.mjs/);
  assert.match(relay.MODEL_RELAY_UPSTREAM, /^\$\{MODEL_UPSTREAM_URL:\?/);
  assert.match(relay.MODEL_RELAY_API_KEY, /^\$\{MODEL_UPSTREAM_KEY:-\}$/);
  assert.match(
    services["model-relay"],
    /networks: \[companion, model-egress\]/,
  );
  assert.doesNotMatch(services.gate, /MODEL_UPSTREAM/);
});

test("every gate and participant variable is defined by the code or the contract", async () => {
  const services = sections(await read("compose.yaml"));
  const code = {
    gate: await sourceText(
      fileURLToPath(new URL("../packages/login-gate/", import.meta.url)),
    ),
    participant: [
      await sourceText(fileURLToPath(new URL("../packages/", import.meta.url))),
    ].join("\n"),
  };
  for (const [service, text] of Object.entries(code)) {
    for (const name of Object.keys(environment(services[service]))) {
      if (name === "TEAM_GIT_DIR") continue; // Mounted path, read by participant programs.
      assert(
        CONTRACT.has(name) || new RegExp(`\\b${name}\\b`).test(text),
        `${service}: ${name} is not read by the code`,
      );
    }
  }
});

test("model and env examples agree with the compose file", async () => {
  const compose = await read("compose.yaml");
  const model = JSON.parse(await read("model.json"));
  for (const key of ["id", "api", "contextWindow", "maxOutputTokens"])
    assert(key in model, key);

  const example = await read(".env.example");
  const required = [...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map(
    (m) => m[1],
  );
  for (const name of new Set(required))
    assert.match(example, new RegExp(`^${name}=`, "m"), name);

  const prompt = await read("PROMPT.md");
  assert(Buffer.byteLength(prompt) <= 32 * 1024);
  assert.match(prompt, /grief/i);
  assert.match(prompt, /chat/i);
});
