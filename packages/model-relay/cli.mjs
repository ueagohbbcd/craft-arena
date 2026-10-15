import { createModelRelay } from "./index.mjs";

const port = Number(process.env.MODEL_RELAY_PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid MODEL_RELAY_PORT");
const relay = createModelRelay({
  upstream: process.env.MODEL_RELAY_UPSTREAM,
  apiKey: process.env.MODEL_RELAY_API_KEY || undefined,
  onEvent: (event) => console.log(JSON.stringify(event)),
});
// Node's default header and request-body timeouts stay: they bound an idle
// caller, while a long streamed response is not limited by either.
relay.listen(port, process.env.MODEL_RELAY_HOST || "0.0.0.0", () =>
  console.log(`Model relay listening on port ${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => relay.close(() => process.exit(0)));
