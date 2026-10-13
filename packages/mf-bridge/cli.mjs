import { startLiveBridge } from "./live.mjs";
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const port = (name, fallback) => {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error(`${name} must be a port`);
  return n;
};
const service = await startLiveBridge({
  minecraft: {
    host: required("MF_HOST"),
    port: port("MF_PORT", 25565),
    username: required("MF_USERNAME"),
    version: required("MF_VERSION"),
    auth: "offline",
  },
  bridge: {
    host: process.env.BRIDGE_HOST ?? "127.0.0.1",
    port: port("BRIDGE_PORT", 8080),
    token: required("BRIDGE_TOKEN"),
    allowChat: process.env.BRIDGE_ALLOW_CHAT !== "false",
    blockMemory: process.env.BRIDGE_BLOCK_MEMORY === "false" ? false : {},
  },
});
console.log(`Capability bridge listening at ${service.url}`);
service.bot.on("error", (error) =>
  console.error("Minecraft bot error:", error.message),
);
service.bot.on("end", (reason) =>
  console.error("Minecraft bot ended:", reason),
);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    try {
      await service.close();
      process.exit(0);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  });
