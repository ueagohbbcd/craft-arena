#!/usr/bin/env node
/**
 * One participant's gate: the login gate on GATE_PORT and, with RCON
 * settings, a read-only session endpoint on GATE_SESSION_PORT:
 * GET /v1/session?username=<character> → {ok, result} (protocol v1 session
 * object for that character). Runs on the trusted side, in the participant's
 * network and the backend network.
 */
import http from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RconClient } from "../arena/src/rcon.mjs";
import { polledSession, serverSessionReader } from "./server-session.mjs";
import { startLoginGate } from "./index.mjs";

export function gateOptions(env = process.env) {
  const port = (name, fallback) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < 0 || n > 65535)
      throw new Error(`${name} must be a port`);
    return n;
  };
  const usernames = (env.GATE_USERNAMES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!usernames.length) throw new Error("GATE_USERNAMES is required");
  if (!env.GATE_UPSTREAM_HOST)
    throw new Error("GATE_UPSTREAM_HOST is required");
  return {
    gate: {
      host: env.GATE_HOST ?? "0.0.0.0",
      port: port("GATE_PORT", 25565),
      upstream: {
        host: env.GATE_UPSTREAM_HOST,
        port: port("GATE_UPSTREAM_PORT", 25565),
      },
      usernames,
    },
    session: env.GATE_RCON_HOST
      ? {
          port: port("GATE_SESSION_PORT", 8080),
          rcon: {
            host: env.GATE_RCON_HOST,
            port: port("GATE_RCON_PORT", 25575),
            password: env.GATE_RCON_PASSWORD ?? "",
          },
          sessionId: env.GATE_SESSION_ID || `server-${Date.now()}`,
        }
      : null,
  };
}

/** The read-only session endpoint, one poll per character. */
export async function startSessionEndpoint({
  host = "0.0.0.0",
  port,
  usernames,
  rcon,
  sessionId,
  intervalMs = 250,
  createRcon = (options) => new RconClient(options),
}) {
  // Connect on first use and again after the connection drops (the server
  // restarting between matches, or not listening yet when the gate starts).
  let client;
  let connecting;
  const connection = async () => {
    if (client && !client.socket?.destroyed) return client;
    connecting ??= (async () => {
      client?.close?.();
      client = undefined;
      const next = createRcon(rcon);
      await next.connect();
      client = next;
      return next;
    })().finally(() => (connecting = undefined));
    return connecting;
  };
  const shared = {
    command: async (text) => (await connection()).command(text),
  };
  await connection().catch(() => {});
  const polls = new Map();
  for (const name of usernames) {
    const polled = polledSession({
      intervalMs,
      read: serverSessionReader({
        rcon: shared,
        username: () => name,
        sessionId,
      }),
    });
    await polled.start();
    polls.set(name.toLowerCase(), polled);
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://gate");
    const polled =
      req.method === "GET" &&
      url.pathname === "/v1/session" &&
      polls.get(String(url.searchParams.get("username")).toLowerCase());
    if (!polled) {
      res.writeHead(404);
      return res.end();
    }
    try {
      const result = polled.getSessionState();
      if (!result) throw new Error("No session from the game server yet");
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, done);
  });
  return {
    port: server.address().port,
    close() {
      for (const polled of polls.values()) polled.close();
      client?.close?.();
      server.closeAllConnections?.();
      server.close();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const options = gateOptions();
  const gate = await startLoginGate(options.gate);
  console.log(
    `Login gate for ${options.gate.usernames.join(", ")} on port ${gate.port}`,
  );
  const session =
    options.session &&
    (await startSessionEndpoint({
      ...options.session,
      usernames: options.gate.usernames,
    }));
  if (session) console.log(`Session endpoint on port ${session.port}`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      session?.close();
      await gate.close();
      process.exit(0);
    });
}
