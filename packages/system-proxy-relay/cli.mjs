import { readFile } from "node:fs/promises";
import { createProxyRelay } from "./index.mjs";

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--port", "--secret-file"].includes(args[i]) || !args[i + 1])
    throw new Error("Expected --port or --secret-file");
  options[args[i]] = args[i + 1];
}
const port = Number(
  options["--port"] || process.env.ARENA_PROXY_RELAY_PORT || 18181,
);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid relay port");
const secretFile =
  options["--secret-file"] || process.env.ARENA_PROXY_RELAY_SECRET_FILE;
const secret =
  process.env.ARENA_PROXY_RELAY_SECRET ||
  (secretFile ? (await readFile(secretFile, "utf8")).trim() : "");
const relay = createProxyRelay({
  secret,
  onEvent: (event) => console.log(JSON.stringify(event)),
});
relay.on("error", () => {
  console.error("Relay listener failed");
  process.exitCode = 1;
});
relay.listen(port, "127.0.0.1", () =>
  console.log(`System proxy relay listening on 127.0.0.1:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => relay.closeRelay());
