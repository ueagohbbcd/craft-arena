/** Pi access to current observation state. */
import { Type } from "typebox";
import { observe } from "../observation/observe.mjs";

export const observeParameters = Type.Object({
  radar: Type.Optional(
    Type.Object({
      radius: Type.Optional(Type.Number({ minimum: 0 })),
      playerRadius: Type.Optional(Type.Number({ minimum: 0 })),
      dropGroupRadius: Type.Optional(Type.Number({ minimum: 0 })),
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
/**
 * One on-demand sample. Background reporting belongs to the default observer
 * script; this tool creates no listeners or reports. Register exactly once.
 * `runtime(ctx, params)` adds the runtime's own sections (task and program
 * status) next to the game state.
 */
export function registerObserveTool(
  pi,
  { getBot, sampleOptions = {}, runtime } = {},
) {
  if (typeof getBot !== "function")
    throw new TypeError("registerObserveTool requires getBot(ctx, params)");
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
      const bot = await getBot(ctx, params);
      const defaults =
        typeof sampleOptions === "function"
          ? await sampleOptions(ctx, params)
          : sampleOptions;
      if (signal?.aborted)
        throw signal.reason ?? new Error("Observation cancelled");
      const result = await observe(bot, { ...defaults, ...params });
      if (runtime) Object.assign(result.state, await runtime(ctx, params));
      return observationForModel(result);
    },
  });
}
