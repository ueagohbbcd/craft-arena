import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { BotFacade } from "../packages/bot-sdk/index.mjs";

const require = createRequire(import.meta.url);

/**
 * Mineflayer bot methods the facade does not provide yet. Plugins and model
 * code are written against real Mineflayer, so every entry is a place where
 * the bridged bot differs. Fill a gap by implementing it and deleting it here.
 */
const KNOWN_GAPS = {
  // Computable from the local mirror and registry; no bridge change needed.
  localReads: [],
  // Mineflayer names that map onto existing semantic window/item actions.
  existingActions: [],
  // Need a new validated action on the trusted bridge.
  newActions: [],
  // Owned by the trusted host by design.
  hostOwned: [
    "acceptResourcePack",
    "denyResourcePack",
    "end",
    "quit",
    "respawn",
    "setCommandBlock",
    "tabComplete",
  ],
};

async function realMineflayerBot() {
  const mineflayer = require("mineflayer");
  // An inert protocol client: plugins inject, nothing is sent anywhere.
  const client = new EventEmitter();
  Object.assign(client, {
    version: "1.21.1",
    state: "play",
    username: "fidelity",
    socket: new EventEmitter(),
    write() {},
    writeRaw() {},
    writeChannel() {},
    registerChannel() {},
    unregisterChannel() {},
    chat() {},
    end() {},
  });
  const bot = mineflayer.createBot({
    client,
    version: "1.21.1",
    username: "fidelity",
    auth: "offline",
    hideErrors: true,
  });
  for (let i = 0; i < 200 && typeof bot.dig !== "function"; i++)
    await delay(10);
  assert.equal(typeof bot.dig, "function", "Mineflayer plugins injected");
  return bot;
}

function methodNames(object) {
  const names = new Set();
  for (
    let proto = object;
    proto && proto !== Object.prototype && proto !== EventEmitter.prototype;
    proto = Object.getPrototypeOf(proto)
  )
    for (const name of Object.getOwnPropertyNames(proto))
      if (!name.startsWith("_") && typeof object[name] === "function")
        names.add(name);
  return names;
}

// This is an API inventory smoke check, not evidence of behavioral parity.
// Real method behavior belongs in sdk-*.test.mjs and live server checks.
test("facade method inventory matches Mineflayer except for documented gaps (not behavior)", async () => {
  const real = methodNames(await realMineflayerBot());
  // Compare a configured facade, as connectBot returns it.
  const configured = new BotFacade({
    url: "http://fidelity.invalid",
    token: "unused",
  });
  await configured.configure("1.21.1");
  const facade = methodNames(configured);
  const missing = [...real].filter((name) => !facade.has(name)).sort();
  const known = Object.values(KNOWN_GAPS).flat().sort();
  assert.deepEqual(
    missing,
    known,
    "update KNOWN_GAPS when the facade gains or loses a Mineflayer method",
  );
});
