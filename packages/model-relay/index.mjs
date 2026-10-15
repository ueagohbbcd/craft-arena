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

/** Headers to forward: end-to-end only, minus those `Connection` names. */
function endToEnd(headers, skip = []) {
  const named = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const out = {};
  for (const [name, value] of Object.entries(headers))
    if (!HOP_BY_HOP.has(name) && !named.has(name) && !skip.includes(name))
      out[name] = value;
  return out;
}

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
 * upstream base URL (any path below it), streaming both ways, and reaches no
 * other host. With
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
    let pathname, search;
    try {
      ({ pathname, search } = new URL(req.url, "http://relay.invalid"));
    } catch {
      // A target Node's parser accepts but URL rejects (e.g. "http://[").
      res.writeHead(400).end();
      return;
    }
    const headers = endToEnd(req.headers, ["host"]);
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
        res.writeHead(upstreamRes.statusCode, endToEnd(upstreamRes.headers));
        upstreamRes.pipe(res);
        // An upstream that dies mid-body must not leave the caller waiting.
        upstreamRes.on("close", () => {
          if (!upstreamRes.complete) res.destroy();
        });
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
