import http from "node:http";
import https from "node:https";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export function resolveSystemProxy(target, { signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.env.ARENA_POWERSHELL || "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(
          new URL("../../scripts/resolve-system-proxy.ps1", import.meta.url),
        ),
        "-Target",
        target,
      ],
      { timeout: 15000, maxBuffer: 16384, windowsHide: true, signal },
      (error, stdout) => {
        // PowerShell errors can contain proxy credentials. Keep them out of diagnostics.
        if (error) reject(new Error("System proxy resolution failed"));
        else resolve(stdout.trim());
      },
    );
  });
}

export function createProxyRelay({
  secret,
  resolver = resolveSystemProxy,
  timeoutMs = 20000,
  allowedHosts = ["chatgpt.com", "auth.openai.com"],
  onEvent = () => {},
  connectDirect = (options) => net.connect(options),
} = {}) {
  if (typeof secret !== "string" || secret.length < 16)
    throw new Error("Relay secret must contain at least 16 characters");
  const expected = Buffer.from(
    `Basic ${Buffer.from(`relay:${secret}`).toString("base64")}`,
  );
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const supplied = Buffer.from(req.headers.authorization || "");
      const healthAuth = Buffer.from(`Bearer ${secret}`);
      if (
        supplied.length === healthAuth.length &&
        timingSafeEqual(supplied, healthAuth)
      ) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ kind: "arena-system-proxy-relay" }));
      } else {
        res.writeHead(401);
        res.end();
      }
    } else {
      res.writeHead(405);
      res.end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(timeoutMs, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", async (req, client, head) => {
    const supplied = Buffer.from(req.headers["proxy-authorization"] || "");
    const authorized =
      supplied.length === expected.length &&
      timingSafeEqual(supplied, expected);
    const match = /^([a-z0-9.-]+):443$/i.exec(req.url || "");
    const host = match?.[1].toLowerCase();
    const fail = (status) => {
      if (!client.destroyed)
        client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`, () =>
          client.destroy(),
        );
    };
    if (!authorized) {
      fail("407 Proxy Authentication Required");
      return;
    }
    if (!host || !allowedHosts.includes(host)) {
      fail("403 Forbidden");
      return;
    }
    client.setTimeout(0);
    const abort = new AbortController();
    let upstream;
    let request;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      abort.abort();
      request?.destroy();
      upstream?.destroy();
    };
    const stop = () => {
      settled = true;
      cleanup();
    };
    client.once("close", stop);
    const failed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      fail("502 Bad Gateway");
      onEvent({ event: "connect_failed", host });
    };
    const timer = setTimeout(failed, timeoutMs);
    const pending = [head];
    let pendingBytes = head.length;
    const earlyData = (chunk) => {
      pendingBytes += chunk.length;
      if (pendingBytes > 65536) {
        stop();
        client.destroy();
      } else pending.push(chunk);
    };
    const earlyEnd = () => {
      stop();
      client.destroy();
    };
    client.on("data", earlyData);
    client.once("end", earlyEnd);
    client.resume();
    const connected = (socket, extra = Buffer.alloc(0)) => {
      if (settled || client.destroyed) {
        socket.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      client.setTimeout(0);
      client.removeListener("data", earlyData);
      client.removeListener("end", earlyEnd);
      upstream = socket;
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
        client.destroy();
      });
      socket.on("error", () => client.destroy());
      // Raw TLS stays between the client and destination.
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (extra.length) client.write(extra);
      for (const chunk of pending) if (chunk.length) socket.write(chunk);
      client.pipe(socket);
      socket.pipe(client);
      client.resume();
      onEvent({ event: "connected", host });
    };
    try {
      const selection = await resolver(`https://${host}/`, {
        signal: abort.signal,
      });
      if (settled || client.destroyed) return;
      if (!selection) {
        upstream = connectDirect({ host, port: 443, allowHalfOpen: true });
        upstream.once("error", failed);
        upstream.once("connect", () => connected(upstream));
      } else {
        const proxy = new URL(selection);
        if (
          !["http:", "https:"].includes(proxy.protocol) ||
          proxy.pathname !== "/" ||
          proxy.search ||
          proxy.hash
        )
          throw new Error("Unsupported proxy");
        const headers = { Host: `${host}:443` };
        if (proxy.username || proxy.password)
          headers["Proxy-Authorization"] =
            `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
        request = (proxy.protocol === "https:" ? https : http).request({
          hostname: proxy.hostname,
          port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
          method: "CONNECT",
          path: `${host}:443`,
          headers,
          agent: false,
        });
        request.once("error", failed);
        request.once("response", (response) => {
          response.destroy();
          failed();
        });
        request.once("connect", (response, socket, extra) => {
          if (response.statusCode !== 200) {
            socket.destroy();
            failed();
          } else connected(socket, extra);
        });
        request.end();
      }
    } catch {
      failed();
    }
  });
  // Explicit shutdown also terminates upgraded CONNECT sockets.
  server.closeRelay = () => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  };
  return server;
}
