/** Sample current game state on demand. Background reporting is the default observer script's. */
import { sampleObservation } from "./index.mjs";
export async function observe(bot, options = {}) {
  return {
    state: sampleObservation(bot, options),
    metadata: {
      epoch: bot?.epoch ?? null,
      sequence: bot?.sequence ?? null,
      sampledAt: bot?.sampledAt ?? null,
      source: "on-demand observation",
    },
  };
}
