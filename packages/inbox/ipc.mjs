import http from "node:http";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { timingSafeEqual } from "node:crypto";

/** HTTP over a private Unix socket by default; TCP binds only loopback and needs a token. */
export async function createInboxServer({
  inbox,
  socketPath,
  port,
  host = "127.0.0.1",
  token,
  maxRequestBytes = 65536,
}) {
  if (!inbox) throw new Error("inbox required");
  if (
    !socketPath &&
    (!["127.0.0.1", "::1"].includes(host) || !token || token.length < 16)
  )
    throw new Error("Loopback HTTP needs a token of at least 16 characters");
  const server = http.createServer((req, res) => {
    const reply = (status, body) => {
      if (!res.headersSent) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      }
    };
    if (req.method !== "POST" || req.url !== "/messages") {
      req.resume();
      return reply(404, { error: "Use POST /messages" });
    }
    if (token) {
      const got = Buffer.from(req.headers.authorization || "");
      const want = Buffer.from(`Bearer ${token}`);
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        req.resume();
        return reply(401, { error: "Unauthorized" });
      }
    }
    let bytes = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxRequestBytes) {
        reply(413, { error: "Request too large" });
        chunks.length = 0;
      } else if (!res.headersSent) chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.headersSent) return;
      try {
        const result = inbox.post(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        reply(result.accepted ? 202 : 413, result);
      } catch (error) {
        reply(400, { error: error.message });
      }
    });
    req.on("error", () => reply(400, { error: "Incomplete request" }));
    req.setTimeout(5000, () => req.destroy());
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = 5000;
  server.maxConnections = 64;
  if (socketPath)
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  // An existing socket is never unlinked: it may belong to a running session.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath ?? { port: port ?? 0, host }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (socketPath) {
    try {
      await chmod(socketPath, 0o600);
    } catch (error) {
      server.close();
      throw error;
    }
  }
  return {
    server,
    socketPath,
    address: server.address(),
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      if (socketPath)
        await unlink(socketPath).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
    },
  };
}

export class InboxClient {
  constructor({
    socketPath = process.env.MC_INBOX_SOCKET,
    url = process.env.MC_INBOX_URL,
    sessionId = process.env.MC_INBOX_SESSION,
    token = process.env.MC_INBOX_TOKEN,
    timeoutMs = 5000,
  } = {}) {
    if (!socketPath && !url)
      throw new Error("MC_INBOX_SOCKET or MC_INBOX_URL is required");
    if (!sessionId) throw new Error("MC_INBOX_SESSION is required");
    if (url) {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "http:" ||
        !["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname)
      )
        throw new Error("Inbox URL must use loopback HTTP");
    }
    Object.assign(this, { socketPath, url, sessionId, token, timeoutMs });
  }
  post(data, options = {}) {
    return this.send({ ...options, kind: "event", data });
  }
  upsert(key, data, options = {}) {
    return this.send({ ...options, kind: "state", key, data });
  }
  requestJudgment(data, options = {}) {
    return this.send({
      ...options,
      kind: "judgment",
      data,
      priority: "urgent",
    });
  }
  send(message) {
    const body = JSON.stringify({ ...message, sessionId: this.sessionId });
    return new Promise((resolve, reject) => {
      const opts = this.socketPath
        ? { socketPath: this.socketPath, path: "/messages" }
        : { ...urlOptions(this.url), path: "/messages" };
      const req = http.request(
        {
          ...opts,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (x) => chunks.push(x));
          res.on("end", () => {
            try {
              const result = JSON.parse(Buffer.concat(chunks));
              if (res.statusCode >= 300)
                reject(
                  new Error(
                    result.error || result.reason || `HTTP ${res.statusCode}`,
                  ),
                );
              else resolve(result);
            } catch (e) {
              reject(e);
            }
          });
          res.on("error", reject);
        },
      );
      req.setTimeout(this.timeoutMs, () =>
        req.destroy(new Error("Inbox request timed out")),
      );
      req.on("error", reject);
      req.end(body);
    });
  }
}
function urlOptions(value) {
  const u = new URL(value);
  return { hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || 80 };
}
