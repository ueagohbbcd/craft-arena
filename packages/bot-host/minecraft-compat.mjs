import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const expected = [
  "crafting_shaped",
  "crafting_shapeless",
  "crafting_special_armordye",
  "crafting_special_bookcloning",
  "crafting_special_mapcloning",
  "crafting_special_mapextending",
  "crafting_special_firework_rocket",
  "crafting_special_firework_star",
  "crafting_special_firework_star_fade",
  "crafting_special_tippedarrow",
  "crafting_special_bannerduplicate",
  "crafting_special_banneraddpattern",
  "crafting_special_shielddecoration",
  "crafting_special_shulkerboxcoloring",
  "crafting_special_suspiciousstew",
  "crafting_special_repairitem",
  "smelting",
  "blasting",
  "smoking",
  "campfire_cooking",
  "stonecutting",
  "smithing_transform",
  "smithing_trim",
  "crafting_decorated_pot",
].map((name) => `minecraft:${name}`);

/** Correct the known protocol-767 recipe IDs through customPackets.
 * Apply before this process creates its first 1.21/1.21.1 parser: minecraft-protocol
 * merges overrides into shared in-memory data and caches parsers by version.
 * Subsequent default bots in this process reuse the corrected definition.
 */
export function compatibleMinecraftOptions(
  options,
  loadData = require("minecraft-data"),
) {
  if (!["1.21", "1.21.1"].includes(options.version)) return options;
  const data = loadData(options.version);
  if (data?.version?.version !== 767) return options;
  const existing = options.customPackets?.["1.21"]?.play?.toClient?.types;
  if (existing?.packet_declare_recipes) return options;
  const declaration = data.protocol.play.toClient.types.packet_declare_recipes;
  const fields = declaration?.[1]?.[0]?.type?.[1]?.type?.[1];
  const typeField = fields?.find((field) => field.name === "type");
  const mapper = typeField?.type;
  if (mapper?.[0] !== "mapper" || mapper[1]?.type !== "varint") return options;
  const mappings = mapper[1].mappings;
  if (
    Object.keys(mappings).length !== expected.length ||
    !expected.every((name, id) => mappings[id] === name)
  )
    return options;
  const corrected = Object.fromEntries(
    expected
      .filter((name) => !name.endsWith("crafting_special_banneraddpattern"))
      .map((name, id) => [id, name]),
  );
  const packet = structuredClone(declaration);
  // A named type replaces the entire old mapper during minecraft-protocol's
  // lodash merge, avoiding retention of the obsolete trailing map entry.
  packet[1][0].type[1].type[1].find((field) => field.name === "type").type =
    "arenaRecipeSerializer767";
  const customPackets = structuredClone(options.customPackets ?? {});
  const version = (customPackets["1.21"] ??= {});
  const play = (version.play ??= {});
  const client = (play.toClient ??= {});
  const types = (client.types ??= {});
  types.arenaRecipeSerializer767 = [
    "mapper",
    { type: "varint", mappings: corrected },
  ];
  types.packet_declare_recipes = packet;
  return { ...options, customPackets };
}

export function createCompatibleBot(options) {
  return require("mineflayer").createBot(compatibleMinecraftOptions(options));
}
