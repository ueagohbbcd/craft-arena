/** Sample current state on demand. Background reporting lives in the observation runtime. */
import { sampleObservation } from "./index.mjs";
export async function observe(
  bot,
  options = {},
  { sample = sampleObservation } = {},
) {
  return {
    state: sample(bot, options),
    metadata: {
      epoch: bot?.epoch ?? null,
      sequence: bot?.sequence ?? null,
      sampledAt: bot?.sampledAt ?? null,
      source: "on-demand observation",
    },
  };
}
