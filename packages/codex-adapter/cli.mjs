#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createTrustedModels } from "./auth.mjs";
import { createCodexAdapter } from "./index.mjs";
import { createCacheBoundaryPolicy } from "./cache-boundary.mjs";
const config = JSON.parse(
  await readFile(process.argv[2] ?? "/config/codex.json", "utf8"),
);
const server = createCodexAdapter({
  ...config,
  models: createTrustedModels(config),
  token: process.env[config.tokenEnv],
});
server.listen(config.port ?? 8082, config.host ?? "127.0.0.1", () =>
  console.log(
    "Trusted Pi adapter ready. " +
      createCacheBoundaryPolicy(config).description,
  ),
);
const stop = () => {
  server.closeAllConnections();
  server.close();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
