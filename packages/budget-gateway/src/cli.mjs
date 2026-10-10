#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  BudgetLedger,
  ReferenceCostLedger,
  createBudgetGateway,
} from "./index.mjs";
const config = JSON.parse(
  await readFile(process.argv[2] ?? "/config/budget.json", "utf8"),
);
const participants = Object.fromEntries(
  Object.entries(config.participants).map(([id, p]) => {
    const token = process.env[p.tokenEnv];
    if (!token) throw new Error(`Missing token environment for ${id}`);
    return [id, { ...p, token }];
  }),
);
const apiKey = process.env[config.upstream.apiKeyEnv];
if (!apiKey) throw new Error("Missing upstream key");
const ledger = new BudgetLedger({ participants, teams: config.teams });
const cashLedger = config.referenceCost
  ? new ReferenceCostLedger({
      config: config.referenceCost,
      participants,
      teams: config.teams,
      models: config.models,
    })
  : undefined;
const authorizeRequest = config.requireRunningMatch
  ? async (id) => {
      const p = config.participants[id];
      if (!p.matchStatusUrl || !envToken(p.matchTokenEnv)) return false;
      try {
        const response = await fetch(p.matchStatusUrl, {
          headers: { authorization: `Bearer ${envToken(p.matchTokenEnv)}` },
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) return false;
        const value = await response.json();
        return value.ok === true && value.result?.state === "running";
      } catch {
        return false;
      }
    }
  : undefined;
function envToken(name) {
  return name ? process.env[name] : undefined;
}
const server = createBudgetGateway({
  ...config,
  authorizeRequest,
  participants,
  ledger,
  cashLedger,
  upstream: { url: config.upstream.url, apiKey, api: config.upstream.api },
  onMetric: (m) => console.log(JSON.stringify({ kind: "model-usage", ...m })),
});
server.listen(Number(process.env.PORT ?? 8081), "0.0.0.0");
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    ledger.close();
    cashLedger?.close();
    server.close();
  });
