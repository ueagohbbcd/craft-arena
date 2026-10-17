import http from "node:http";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** HTTP over a private Unix socket (mode 0600 in a 0700 directory). */
export async function createInboxServer({
  inbox,
  socketPath,
  maxRequestBytes = 65536,
  maxReceiptWaitMs = 4000,
}) {
  if (!inbox) throw new Error("inbox required");
  if (!socketPath) throw new Error("socketPath required");
  const server = http.createServer((req, res) => {
    const reply = (status, body) => {
      if (!res.headersSent) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      }
    };
    const url = new URL(req.url, "http://inbox");
    const receipt = /^\/messages\/([^/]+)\/delivery$/.exec(url.pathname);
    if (
      !(req.method === "POST" && url.pathname === "/messages") &&
      !(req.method === "GET" && receipt)
    ) {
      req.resume();
      return reply(404, {
        error: "Use POST /messages or GET /messages/{id}/delivery",
      });
    }
    if (receipt) {
      req.resume();
      return waitForOutcome(
        decodeURIComponent(receipt[1]),
        url.searchParams.get("waitMs"),
        reply,
        res,
      );
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
  /** Long-poll one message's outcome, bounded below the server's request timeout. */
  function waitForOutcome(id, waitText, reply, res) {
    const waitMs = Math.min(
      Math.max(Number.isFinite(Number(waitText)) ? Number(waitText) : 0, 0),
      maxReceiptWaitMs,
    );
    inbox.waitForOutcome(id, waitMs).then((outcome) => {
      if (!res.writableEnded && !res.destroyed)
        reply(outcome === "unknown" ? 404 : 200, { id, outcome });
    });
  }
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = 5000;
  server.maxConnections = 64;
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  // An existing socket is never unlinked: it may belong to a running session.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    server,
    socketPath,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await unlink(socketPath).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    },
  };
}

export class InboxClient {
  constructor({
    socketPath = process.env.MC_INBOX_SOCKET,
    sessionId = process.env.MC_INBOX_SESSION,
    taskId = process.env.MC_INBOX_TASK_ID,
    timeoutMs = 5000,
  } = {}) {
    if (!socketPath) throw new Error("MC_INBOX_SOCKET is required");
    if (!sessionId) throw new Error("MC_INBOX_SESSION is required");
    Object.assign(this, { socketPath, sessionId, taskId, timeoutMs });
  }
  post(data, options = {}) {
    return this.send({ ...options, kind: "event", data });
  }
  upsert(key, data, options = {}) {
    return this.send({ ...options, kind: "state", key, data });
  }
  /**
   * Set this program's current status under key (shown to the model as
   * programStatus until replaced, cleared with null, or expired).
   */
  setStatus(key, data, options = {}) {
    return this.send({
      ...options,
      kind: "current",
      key,
      data,
      priority: "normal",
    });
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
    const body = JSON.stringify({
      ...(this.taskId ? { taskId: this.taskId } : {}),
      ...message,
      sessionId: this.sessionId,
    });
    return this.request("POST", "/messages", body).then(
      ({ status, result }) => {
        if (status >= 300)
          throw new Error(result.error || result.reason || `HTTP ${status}`);
        return result;
      },
    );
  }
  /**
   * Wait until a posted message leaves the queue. Resolves {id, outcome}:
   * "delivered" (shown to the model), "replaced" (a newer state with the same
   * key), "expired", "overflow", "removed", or "pending"/"unknown" on timeout.
   */
  async delivery(id, { timeoutMs = 30000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const waitMs = Math.max(0, Math.min(4000, deadline - Date.now()));
      const { status, result } = await this.request(
        "GET",
        `/messages/${encodeURIComponent(id)}/delivery?waitMs=${waitMs}`,
        undefined,
        waitMs + this.timeoutMs,
      );
      if (status >= 300 && status !== 404)
        throw new Error(result.error || `HTTP ${status}`);
      if (result.outcome !== "pending" || Date.now() >= deadline)
        return { id, outcome: result.outcome };
    }
  }
  request(method, path, body, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            ...(body === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(body),
                }),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (x) => chunks.push(x));
          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode,
                result: JSON.parse(Buffer.concat(chunks)),
              });
            } catch (e) {
              reject(e);
            }
          });
          res.on("error", reject);
        },
      );
      req.setTimeout(timeoutMs, () =>
        req.destroy(new Error("Inbox request timed out")),
      );
      req.on("error", reject);
      req.end(body);
    });
  }
}
