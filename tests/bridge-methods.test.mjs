import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAuthority, startBridge } from "../packages/mf-bridge/index.mjs";
import { connectBot, Vector } from "../packages/bot-sdk/index.mjs";
import { fakeBot } from "./bridge.test.mjs";

const token = "bridge-methods-token-long";

/** fakeBot plus the native methods this file covers, each recording its call. */
function methodsBot() {
  const b = fakeBot();
  for (const n of [
    "moveSlotItem",
    "putAway",
    "putSelectedItemRange",
    "transfer",
    "activateEntity",
    "activateEntityAt",
    "useOn",
    "mount",
    "dismount",
    "moveVehicle",
    "elytraFly",
    "fish",
    "sleep",
    "updateSign",
    "writeBook",
    "signBook",
    "whisper",
  ])
    b[n] = (...args) => {
      b.calls.push([n, ...args]);
    };
  b.settings = { chat: "enabled", mainHand: "right", skinParts: {} };
  b.setSettings = (s) => {
    b.calls.push(["setSettings", s]);
    Object.assign(b.settings, s);
  };
  b.placeEntity = async (block, face) => {
    b.calls.push(["placeEntity", block, face]);
    return {
      id: 9,
      name: "boat",
      position: new Vector(0.5, 1, 0.5),
      velocity: new Vector(),
    };
  };
  const planks = { id: 5, metadata: null, count: -1 };
  b.recipesAll = () => [
    { result: { id: 1, count: 4 }, delta: [{ ...planks, id: 6 }] },
    { result: { id: 1, count: 4 }, delta: [planks] },
  ];
  return b;
}

function special(kind, extra = {}) {
  const w = Object.assign(new EventEmitter(), {
    id: 4,
    type: kind,
    slots: Array(39).fill(null),
    inventoryStart: 3,
    inventoryEnd: 39,
    ...extra,
  });
  return w;
}

test("inventory helpers act on the open window by ref and validate slots", async () => {
  const b = methodsBot(),
    a = createAuthority(b);
  const ref = a.snapshot(false).inventory.windowRef;
  await a.dispatch({
    action: "moveSlotItem",
    args: { windowRef: ref, sourceSlot: 36, destSlot: 9 },
  });
  assert.deepEqual(b.calls.at(-1), ["moveSlotItem", 36, 9]);
  await a.dispatch({ action: "putAway", args: { windowRef: ref, slot: 0 } });
  assert.deepEqual(b.calls.at(-1), ["putAway", 0]);
  await a.dispatch({
    action: "putSelectedItemRange",
    args: { windowRef: ref, start: 9, end: 45 },
  });
  assert.deepEqual(b.calls.at(-1), [
    "putSelectedItemRange",
    9,
    45,
    b.inventory,
    null,
  ]);
  await a.dispatch({
    action: "transfer",
    args: {
      windowRef: ref,
      itemType: 1,
      count: 3,
      sourceStart: 9,
      sourceEnd: 36,
      destStart: 36,
      destEnd: 45,
    },
  });
  assert.equal(b.calls.at(-1)[1].window, b.inventory);
  assert.equal(b.calls.at(-1)[1].destEnd, 45);
  await assert.rejects(
    a.dispatch({
      action: "transfer",
      args: { itemType: 1, sourceStart: 9, sourceEnd: 8 },
    }),
    /Invalid number/,
  );
  await assert.rejects(
    a.dispatch({ action: "putAway", args: { windowRef: "old", slot: 0 } }),
    /no longer open/,
  );
  await assert.rejects(
    a.dispatch({ action: "moveSlotItem", args: { sourceSlot: 46 } }),
    /Invalid number/,
  );
  await a.dispatch({ action: "toss", args: { itemType: 7, count: 2 } });
  assert.deepEqual(b.calls.at(-1), ["toss", 7, null, 2]);
});

test("craft with a recipe runs the bridge's recipe whose ingredients match", async () => {
  const b = methodsBot(),
    a = createAuthority(b);
  await a.dispatch({
    action: "craft",
    args: {
      itemType: 1,
      runs: 3,
      delta: [{ id: 5, metadata: null, count: -1 }],
    },
  });
  const [name, recipe, runs] = b.calls.at(-1);
  assert.equal(name, "craft");
  assert.equal(recipe.delta[0].id, 5);
  assert.equal(runs, 3);
  await assert.rejects(
    a.dispatch({
      action: "craft",
      args: { itemType: 1, delta: [{ id: 99, count: -1 }] },
    }),
    /No such recipe/,
  );
});

test("special windows expose their state and only their own native methods", async () => {
  const b = methodsBot(),
    a = createAuthority(b);
  const furnace = special("minecraft:furnace", {
    fuel: 0.5,
    progress: 0.25,
    putFuel: (...args) => b.calls.push(["putFuel", ...args]),
    takeOutput: async () => ({ type: 3, count: 2, slot: 2 }),
  });
  b.openFurnace = async () => (b.currentWindow = furnace);
  const opened = await a.dispatch({
    action: "openFurnace",
    args: { position: { x: 0, y: 0, z: 0 } },
  });
  assert.equal(opened.kind, "furnace");
  assert.equal(opened.fuel, 0.5);
  assert.equal(opened.progress, 0.25);
  await a.dispatch({
    action: "windowCall",
    args: {
      windowRef: opened.windowRef,
      method: "putFuel",
      args: [8, null, 4],
    },
  });
  assert.deepEqual(b.calls.at(-1), ["putFuel", 8, null, 4]);
  const taken = await a.dispatch({
    action: "windowCall",
    args: { windowRef: opened.windowRef, method: "takeOutput" },
  });
  assert.equal(taken.value.count, 2);
  for (const method of ["withdraw", "close", "constructor", "putAnything"])
    await assert.rejects(
      a.dispatch({
        action: "windowCall",
        args: { windowRef: opened.windowRef, method },
      }),
      /not allowed/,
    );

  const anvil = special("minecraft:anvil", {
    combine: (...args) => b.calls.push(["combine", ...args]),
  });
  anvil.slots[3] = { type: 1, count: 1, slot: 3 };
  anvil.slots[4] = { type: 2, count: 1, slot: 4 };
  b.openAnvil = async () => (b.currentWindow = anvil);
  const ref = (
    await a.dispatch({
      action: "openAnvil",
      args: { position: { x: 0, y: 0, z: 0 } },
    })
  ).windowRef;
  await a.dispatch({
    action: "windowCall",
    args: { windowRef: ref, method: "combine", args: [3, 4, "Edge"] },
  });
  assert.deepEqual(b.calls.at(-1), [
    "combine",
    anvil.slots[3],
    anvil.slots[4],
    "Edge",
  ]);
  await assert.rejects(
    a.dispatch({
      action: "windowCall",
      args: { windowRef: ref, method: "combine", args: [3, 5] },
    }),
    /Empty slot/,
  );
  await assert.rejects(
    a.dispatch({
      action: "windowCall",
      args: { windowRef: opened.windowRef, method: "putFuel", args: [1] },
    }),
    /no longer open/,
    "the furnace window was replaced",
  );
});

test("the SDK mirrors furnace and villager windows with native-shaped methods", async (t) => {
  const b = methodsBot();
  const furnace = special("minecraft:furnace", {
    fuel: 1,
    putInput: (...args) => b.calls.push(["putInput", ...args]),
  });
  furnace.slots[0] = { type: 1, count: 3, slot: 0 };
  b.openFurnace = async () => (b.currentWindow = furnace);
  const villager = special("minecraft:villager", {
    trades: [
      {
        inputItem1: { type: 1, count: 6 },
        outputItem: { type: 2, count: 1 },
        hasItem2: false,
        realPrice: 5,
      },
    ],
    trade: (...args) => b.calls.push(["trade", ...args]),
  });
  b.entities[2].entityType = 1;
  b.openVillager = async () => (b.currentWindow = villager);
  const service = await startBridge({ bot: b, token, snapshotRadius: 0 });
  t.after(() => service.close());
  const bot = await connectBot({ url: service.url, token });
  t.after(() => bot.closeBridge());

  const window = await bot.openFurnace(bot.blockAt(new Vector(0, 0, 0)));
  assert.equal(window.fuel, 1);
  assert.equal(window.inputItem().count, 3);
  await window.putInput(1, null, 2);
  assert.deepEqual(b.calls.at(-1), ["putInput", 1, null, 2]);

  const shop = await bot.openVillager(bot.entities[2]);
  assert.equal(shop.trades[0].inputs[0].count, 6);
  assert.equal(shop.trades[0].outputItem.type, 2);
  assert.equal(shop.trades[0].realPrice, 5);
  await bot.trade(shop, 0, 2);
  assert.deepEqual(b.calls.at(-1), ["trade", 0, 2]);
});

test("entity, vehicle, bed, sign, book, whisper and settings actions are validated", async () => {
  const b = methodsBot(),
    a = createAuthority(b, { maxReach: 6 });
  const p = { x: 0, y: 0, z: 0 };
  await a.dispatch({ action: "activateEntity", args: { entityId: 2 } });
  assert.equal(b.calls.at(-1)[1], b.entities[2]);
  await a.dispatch({
    action: "activateEntityAt",
    args: { entityId: 2, position: { x: 2, y: 1.5, z: 1 } },
  });
  assert.equal(b.calls.at(-1)[2].y, 1.5);
  await a.dispatch({ action: "mount", args: { entityId: 2 } });
  await a.dispatch({ action: "moveVehicle", args: { left: 0, forward: 1 } });
  assert.deepEqual(b.calls.at(-1), ["moveVehicle", 0, 1]);
  await assert.rejects(
    a.dispatch({ action: "moveVehicle", args: { left: 0, forward: 2 } }),
  );
  b.entities[3] = { id: 3, position: new Vector(40, 1, 0) };
  await assert.rejects(
    a.dispatch({ action: "useOn", args: { entityId: 3 } }),
    /out of reach/,
  );
  await a.dispatch({ action: "sleep", args: { position: p } });
  assert.equal(b.calls.at(-1)[1].name, "stone");
  await a.dispatch({
    action: "updateSign",
    args: { position: p, text: "north\nbase", back: true },
  });
  assert.deepEqual(b.calls.at(-1).slice(2), ["north\nbase", true]);
  const boat = await a.dispatch({
    action: "placeEntity",
    args: { position: p, face: { x: 0, y: 1, z: 0 } },
  });
  assert.equal(boat.name, "boat");
  await a.dispatch({
    action: "signBook",
    args: { slot: 36, pages: ["a", "b"], author: "red1", title: "Log" },
  });
  assert.deepEqual(b.calls.at(-1), ["signBook", 36, ["a", "b"], "red1", "Log"]);
  await assert.rejects(
    a.dispatch({ action: "writeBook", args: { slot: 2, pages: [] } }),
    /Invalid number/,
    "books are written from the inventory proper",
  );
  await a.dispatch({
    action: "whisper",
    args: { username: "blue1", message: "hi" },
  });
  assert.deepEqual(b.calls.at(-1), ["whisper", "blue1", "hi"]);
  const settings = await a.dispatch({
    action: "setSettings",
    args: { settings: { mainHand: "left", skinParts: { showHat: false } } },
  });
  assert.equal(settings.mainHand, "left");
  await assert.rejects(
    a.dispatch({
      action: "setSettings",
      args: { settings: { viewDistance: 32 } },
    }),
    /not allowed/,
  );
  const quiet = createAuthority(methodsBot(), { allowChat: false });
  await assert.rejects(
    quiet.dispatch({
      action: "whisper",
      args: { username: "x", message: "y" },
    }),
    /Chat disabled/,
  );
});
