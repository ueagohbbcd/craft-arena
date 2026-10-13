import { createRequire, Module } from "node:module";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { InboxClient } from "../inbox/index.mjs";
import { observeCombat } from "./combat-report.mjs";
const require = createRequire(import.meta.url);
/** Local plugin adaptation. No participant code is sent to the authority. */
export function loadSelectedPlugins(
  bot,
  { pvp = true, combatObservation = true, inbox } = {},
) {
  const filename = require.resolve("mineflayer-pathfinder");

  const source = readFileSync(filename, "utf8");
  const start = source.indexOf("  function fullStop () {"),
    end = source.indexOf("\n  }", start) + 4;
  if (
    start < 0 ||
    end < 4 ||
    !source.slice(start, end).includes("bot.entity.velocity.x = 0")
  )
    throw new Error("Pathfinder fullStop patch mismatch");
  const pathHeader = "  function postProcessPath (path) {\n";
  if (
    !source.includes(pathHeader) ||
    source.indexOf(pathHeader) !== source.lastIndexOf(pathHeader)
  )
    throw new Error("Pathfinder path-copy patch mismatch");
  // Native post-processing centers Move coordinates in place. A partial A*
  // result can still share its best node with the open heap; changing that
  // node makes a reachable integer goal fail on the next search slice.
  // Keep optimized execution nodes (and their shiftable work lists) separate.
  const patched = (
    source.slice(0, start) +
    "  function fullStop () { bot.stop() }" +
    source.slice(end)
  ).replace(
    pathHeader,
    pathHeader +
      "    path = path.map(node => Object.assign(Object.create(Object.getPrototypeOf(node)), node, {\n" +
      "      toBreak: [...node.toBreak], toPlace: [...node.toPlace]\n" +
      "    }))\n",
  );
  // Upstream can start horizontal edge positioning while a preceding dig is
  // still falling. Wait before fullStop or backing up; sneak cannot stop air drift.
  const placementHeader =
    "    if (placing || nextPoint.toPlace.length > 0) {\n";
  if (
    !patched.includes(placementHeader) ||
    patched.indexOf(placementHeader) !== patched.lastIndexOf(placementHeader)
  )
    throw new Error("Pathfinder placement landing guard patch mismatch");
  const guarded = patched.replace(
    placementHeader,
    placementHeader +
      "      const nextPlacement = placing ? placingBlock : nextPoint.toPlace[0]\n" +
      "      if (bot.pathfinder.LOSWhenPlacingBlocks && nextPlacement &&\n" +
      "        nextPlacement.dy === 0 && !nextPlacement.useOne && !bot.entity.onGround) {\n" +
      "        for (const control of ['forward', 'back', 'left', 'right']) {\n" +
      "          if (bot.getControlState(control)) bot.setControlState(control, false)\n" +
      "        }\n" +
      "        return\n" +
      "      }\n",
  );
  // Upstream 2.4.5 resolves goto for *any* empty path, including noPath,
  // timeout and partial search slices. A plan is not proof of arrival: leave
  // success to the native goal_reached event (including its slab tolerance).
  // Compile a private copy so unadapted users and shared dependencies stay intact.
  const gotoFilename = require.resolve("mineflayer-pathfinder/lib/goto");
  const gotoSource = readFileSync(gotoFilename, "utf8");
  const emptyPathSuccess =
    "      if (results.path.length === 0) {\n" +
    "        cleanup()\n" +
    "      } else if (results.status === 'noPath') {";
  if (
    !gotoSource.includes(emptyPathSuccess) ||
    gotoSource.indexOf(emptyPathSuccess) !==
      gotoSource.lastIndexOf(emptyPathSuccess)
  )
    throw new Error("Pathfinder goto arrival patch mismatch");
  const gotoModule = new Module(gotoFilename);
  gotoModule.filename = gotoFilename;
  gotoModule.paths = Module._nodeModulePaths(dirname(gotoFilename));
  gotoModule._compile(
    gotoSource.replace(
      emptyPathSuccess,
      "      if (results.status === 'noPath') {",
    ),
    gotoFilename,
  );
  const m = new Module(filename);
  m.require = (id) =>
    id === "./lib/goto"
      ? gotoModule.exports
      : Module.prototype.require.call(m, id);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(dirname(filename));
  m._compile(guarded, filename);
  bot.loadPlugin(m.exports.pathfinder);
  if (pvp) {
    bot.loadPlugin(require("mineflayer-pvp").plugin);
    if (combatObservation) {
      inbox ??=
        (process.env.MC_INBOX_SOCKET || process.env.MC_INBOX_URL) &&
        process.env.MC_INBOX_SESSION
          ? new InboxClient()
          : null;
      bot.combatObservation = observeCombat(bot, {
        inbox,
        ...(typeof combatObservation === "object" ? combatObservation : {}),
      });
    }
    // PvP 1.3.2 still subscribes to the legacy singular spelling.
    bot.on("physicsTick", () => bot.emit("physicTick"));
  }
  bot.on("bridgeReset", () => {
    bot.pvp?.forceStop();
    bot.pathfinder.setGoal(null);
  });
  return { Movements: m.exports.Movements, goals: m.exports.goals };
}
