import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
const Vector = Vec3;

export function fakeBot() {
  const bot = new EventEmitter();
  Object.assign(bot, {
    version: "1.21.1",
    username: "test",
    entity: {
      id: 1,
      position: new Vector(0.5, 1, 0.5),
      velocity: new Vector(),
      yaw: 0,
      pitch: 0,
      height: 1.8,
      width: 0.6,
      onGround: true,
      effects: {},
      attributes: {},
    },
    entities: {},
    inventory: {
      slots: Array(46).fill(null),
      inventoryStart: 9,
      inventoryEnd: 45,
    },
    game: { minY: -64, height: 384, dimension: "overworld" },
    controlState: {},
    health: 20,
    food: 20,
    heldItem: null,
    calls: [],
  });
  bot.entities[1] = bot.entity;
  bot.entities[2] = {
    id: 2,
    position: new Vector(2, 1, 1),
    velocity: new Vector(),
    height: 1.8,
    width: 0.6,
  };
  bot.blockAt = (p) => ({
    position: new Vector(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    stateId: p.y < 1 ? 1 : 0,
    type: p.y < 1 ? 1 : 0,
    name: p.y < 1 ? "stone" : "air",
    diggable: true,
    shapes: p.y < 1 ? [[0, 0, 0, 1, 1, 1]] : [],
    boundingBox: p.y < 1 ? "block" : "empty",
  });
  for (const n of [
    "setControlState",
    "clearControlStates",
    "look",
    "lookAt",
    "attack",
    "dig",
    "stopDigging",
    "placeBlock",
    "activateBlock",
    "equip",
    "unequip",
    "activateItem",
    "deactivateItem",
    "swingArm",
    "chat",
    "setQuickBarSlot",
    "toss",
    "craft",
    "closeWindow",
    "clickWindow",
  ])
    bot[n] = (...args) => {
      bot.calls.push([n, ...args]);
    };
  bot.recipesFor = () => [{ result: { id: 1, count: 1 } }];
  return bot;
}
