import http from "node:http";
import https from "node:https";

// Connection-scoped headers never cross a proxy (RFC 9110 §7.6.1).
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Parse and check the one upstream base URL the relay may reach. */
export function parseUpstream(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MODEL_RELAY_UPSTREAM must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash)
    throw new Error(
      "MODEL_RELAY_UPSTREAM must be an HTTP(S) base URL without query or fragment",
    );
  if (url.username || url.password)
    throw new Error(
      "MODEL_RELAY_UPSTREAM must not embed credentials; use MODEL_RELAY_API_KEY",
    );
  return url;
}

/**
 * A participant's model endpoint: forwards every request to one configured
 * upstream base URL, streaming both ways, and reaches nothing else. With
 * `apiKey` it replaces the caller's Authorization header, so the key stays
 * outside the participant container. It does no metering, queueing or
 * rewriting; anything more belongs in a service the upstream URL points at.
 */
export function createModelRelay({ upstream, apiKey, onEvent = () => {} }) {
  const base = parseUpstream(upstream);
  const prefix = base.pathname.replace(/\/$/, "");
  const client = base.protocol === "https:" ? https : http;
  return http.createServer((req, res) => {
    // Only the path and query of the request target are used, so "//host" or
    // "http://host/" in the request line still lands below the upstream base.
    const { pathname, search } = new URL(req.url, "http://relay.invalid");
    const headers = {};
    for (const [name, value] of Object.entries(req.headers))
      if (!HOP_BY_HOP.has(name) && name !== "host") headers[name] = value;
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const started = Date.now();
    const outgoing = client.request(
      {
        protocol: base.protocol,
        hostname: base.hostname.replace(/^\[(.*)\]$/, "$1"),
        port: base.port,
        method: req.method,
        path: `${prefix}${pathname}${search}`,
        headers,
      },
      (upstreamRes) => {
        const out = {};
        for (const [name, value] of Object.entries(upstreamRes.headers))
          if (!HOP_BY_HOP.has(name)) out[name] = value;
        res.writeHead(upstreamRes.statusCode, out);
        upstreamRes.pipe(res);
        upstreamRes.on("end", () =>
          onEvent({
            method: req.method,
            path: pathname,
            status: upstreamRes.statusCode,
            ms: Date.now() - started,
          }),
        );
      },
    );
    outgoing.on("error", (error) => {
      onEvent({ method: req.method, path: pathname, error: error.code });
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: "Model upstream unavailable" } }),
        );
      } else res.destroy();
    });
    // A caller that goes away cancels the upstream request.
    res.on("close", () => {
      if (!res.writableFinished) outgoing.destroy();
    });
    req.pipe(outgoing);
  });
}
