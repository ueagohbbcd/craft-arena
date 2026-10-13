/** Pi access to current observation state. */
import { Type } from "typebox";
import { connectBot } from "../bot-sdk/index.mjs";
import { observe } from "./observe.mjs";

export const observeParameters = Type.Object({
  reload: Type.Optional(
    Type.Boolean({
      description:
        "Reload workspace perception.mjs and perception.json into the default observer; report the active source and any reload error.",
    }),
  ),
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
        "Return every retained task status and full current program record. Default output is compact and reports omissions.",
    }),
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
});

export async function observeForModel(bot, options = {}, dependencies) {
  const result = await observe(bot, options, dependencies);
  if (options.runtimeProjection)
    result.state.runtimeProjection = options.runtimeProjection;
  if (options.recentBlocks) result.state.recentBlocks = options.recentBlocks;
  if (options.nearbySigns) result.state.nearbySigns = options.nearbySigns;
  return observationForModel(result);
}

export function observationForModel(result) {
  const payload = { state: result.state, metadata: result.metadata };
  const content = [
    {
      type: "text",
      text: JSON.stringify(payload, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    },
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
  { getBot, sampleState, sampleOptions = {}, dependencies } = {},
) {
  if (typeof getBot !== "function" && typeof sampleState !== "function")
    throw new TypeError(
      "registerObserveTool requires getBot(ctx) or sampleState(ctx, params)",
    );
  pi.registerTool({
    name: "observe",
    label: "Observe current state",
    description:
      "Return current player state, inventory/equipment, open window, observed entities, local terrain and program status as JSON. Use full* options to expand compact details.",
    parameters: observeParameters,
    outputSchema: Type.Object({
      state: Type.Any(),
      metadata: Type.Any(),
      content: Type.Array(Type.Any()),
    }),
    async execute(_id, params = {}, signal, _onUpdate, ctx) {
      if (sampleState) {
        if (signal?.aborted)
          throw signal.reason ?? new Error("Observation cancelled");
        const state = await sampleState(ctx, params);
        return observationForModel({
          state,
          metadata: {
            epoch: state.freshness?.epoch ?? null,
            sequence: state.freshness?.sequence ?? null,
            sampledAt: state.freshness?.sampledAt ?? null,
            source: "on-demand observation",
          },
        });
      }
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
      connection ??= connectBot();
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
