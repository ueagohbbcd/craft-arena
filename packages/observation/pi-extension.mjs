/** Pi observe: ordinary persisted tool result, with native images preserved for codemode. */
import { Type } from "typebox";
import { connectBot } from "../bot-sdk/index.mjs";
import { observe, OBSERVATION_VIEWS } from "./observe.mjs";
import { VIEW_DIRECTIONS } from "../world-visual/index.mjs";

const point = Type.Object({
  x: Type.Integer(),
  y: Type.Integer(),
  z: Type.Integer(),
});
const bounds = Type.Object({ min: point, max: point });
export const observeParameters = Type.Object({
  radar: Type.Optional(
    Type.Object({
      radius: Type.Optional(Type.Number({ minimum: 0 })),
      playerRadius: Type.Optional(Type.Number({ minimum: 0 })),
      dropGroupRadius: Type.Optional(Type.Number({ minimum: 0 })),
    }),
  ),
  fullRecentBlocks: Type.Optional(
    Type.Boolean({
      description:
        "Expand the retained interval block samples with per-type sample-frame counts, representative coordinates, source times and sample coverage. Does not clear the interval.",
    }),
  ),
  fullRuntime: Type.Optional(
    Type.Boolean({
      description:
        "Return every retained task status and unabridged current program record. Default uses compact display budgets and reports omissions; does not change underlying runtime data.",
    }),
  ),
  views: Type.Optional(
    Type.Array(
      Type.Union(OBSERVATION_VIEWS.map((name) => Type.Literal(name))),
      {
        description:
          "Optional images: overview is the full public map or loaded extent; local is a near-feet Y slice; 3d is a local structure view. Default [] returns state only.",
      },
    ),
  ),
  fullEntities: Type.Optional(
    Type.Boolean({
      description:
        "Include all observed nonplayer entities instead of the compact summary.",
    }),
  ),
  fullLocal: Type.Optional(
    Type.Boolean({
      description: "Include all sampled local blocks and observed signs.",
    }),
  ),
  fullItems: Type.Optional(
    Type.Boolean({
      description: "Include complete NBT/components for observed items.",
    }),
  ),
  overviewBounds: Type.Optional(bounds),
  localBounds: Type.Optional(bounds),
  structureBounds: Type.Optional(bounds),
  viewRadius: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "Local and 3D horizontal radius, default 12. Does not crop overview.",
    }),
  ),
  width: Type.Optional(Type.Integer({ minimum: 1 })),
  height: Type.Optional(Type.Integer({ minimum: 1 })),
  textured: Type.Optional(
    Type.Boolean({
      description:
        "Maps use real Minecraft top-face texture tiles on CPU by default; requested 3D uses genuine Prismarine shapes/textures. False explicitly selects schematic maps/cubes.",
    }),
  ),
  fallback: Type.Optional(
    Type.Union([Type.Literal("schematic"), Type.Literal("error")], {
      description:
        "If textured capture fails, default schematic returns a clearly labeled fallback; error reports the unavailable view while preserving state.",
    }),
  ),
  viewDirection: Type.Optional(
    Type.Union(VIEW_DIRECTIONS.map((name) => Type.Literal(name))),
  ),
});

export async function observeForModel(bot, options = {}, dependencies) {
  const result = await observe(bot, options, dependencies);
  if (options.runtimeProjection)
    result.state.runtimeProjection = options.runtimeProjection;
  if (options.recentBlocks) result.state.recentBlocks = options.recentBlocks;
  const views = result.views.map(({ name, metadata }, index) => ({
    name,
    ...metadata,
    contentIndex: result.views[index].png
      ? 1 + result.views.slice(0, index).filter((v) => v.png).length
      : null,
  }));
  const payload = { state: result.state, views, metadata: result.metadata };
  const content = [
    {
      type: "text",
      text: JSON.stringify(payload, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    },
    ...result.views
      .filter((v) => v.png)
      .map(({ png }) => ({
        type: "image",
        data: png.toString("base64"),
        mimeType: "image/png",
      })),
  ];
  return {
    content,
    details: payload,
    structuredContent: { ...payload, content },
  };
}
/** Reuse the runtime's connection. Register exactly once; no background observer is created here. */
export function registerObserveTool(
  pi,
  { getBot, sampleOptions = {}, dependencies } = {},
) {
  if (typeof getBot !== "function")
    throw new TypeError("registerObserveTool requires getBot(ctx)");
  pi.registerTool({
    name: "observe",
    label: "Observe current state and views",
    description:
      "Get current player state, health, equipment, inventory, open window, observed entities, local terrain and program status as JSON. Images are opt-in via views: overview, local, 3d. All selected image snapshots share the state source sequence. Surface maps show known/unknown coverage and player coordinates; requested 3D uses real block textures when available and labels any fallback. Does not repeat opening images or restrict ordinary bot SDK queries.",
    parameters: observeParameters,
    outputSchema: Type.Object({
      state: Type.Any(),
      views: Type.Array(Type.Any()),
      metadata: Type.Any(),
      content: Type.Array(Type.Any()),
    }),
    async execute(_id, params = {}, signal, _onUpdate, ctx) {
      const bot = await getBot(ctx, params);
      const defaults =
        typeof sampleOptions === "function"
          ? await sampleOptions(ctx, params)
          : sampleOptions;
      if (signal?.aborted)
        throw signal.reason ?? new Error("Observation cancelled");
      return observeForModel(bot, { ...defaults, ...params }, dependencies);
    },
  });
}
/** Optional standalone registration for hosts that do not load the main arena extension. */
export default function observationExtension(pi) {
  let connection;
  registerObserveTool(pi, {
    async getBot() {
      connection ??= connectBot({
        url: process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL,
        token: process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN,
      });
      try {
        return await connection;
      } catch (error) {
        connection = undefined;
        throw error;
      }
    },
  });
  pi.on("session_shutdown", async () => {
    try {
      (await connection)?.closeBridge();
    } catch {}
    connection = undefined;
  });
}
