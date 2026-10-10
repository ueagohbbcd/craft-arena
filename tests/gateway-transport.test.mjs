import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { installGatewayTransport } from "../packages/pi-extension/gateway-transport.mjs";
import {
  BudgetLedger,
  createBudgetGateway,
} from "../packages/budget-gateway/src/index.mjs";

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("native fetch preserves gateway header/body waits and unrelated origin timeouts", async () => {
  const handler = async (req, res) => {
    if (req.url === "/body") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": admitted\n\n");
      await delay(1600);
      res.end('data: {"type":"done"}\n\n');
    } else {
      await delay(1600);
      res.setHeader("x-arena-queue-delay-ms", "1600");
      res.setHeader("x-arena-cash-ratios", '{"admission":"snapshot"}');
      res.end("admitted");
    }
  };
  const gateway = await serve(handler);
  const other = await serve(handler);
  const dispatcher = new Agent({ headersTimeout: 40, bodyTimeout: 40 });
  const restore = installGatewayTransport({
    baseUrl: `${gateway.url}/participants/red1/v1`,
    dispatcher,
  });
  try {
    const response = await fetch(`${gateway.url}/headers`);
    assert.equal(await response.text(), "admitted");
    assert.equal(response.headers.get("x-arena-queue-delay-ms"), "1600");
    assert.equal(
      response.headers.get("x-arena-cash-ratios"),
      '{"admission":"snapshot"}',
    );
    assert.match(await (await fetch(`${gateway.url}/body`)).text(), /done/);
    await assert.rejects(
      fetch(`${other.url}/headers`),
      (error) => error.cause?.code === "UND_ERR_HEADERS_TIMEOUT",
    );
    await assert.rejects(
      async () => (await fetch(`${other.url}/body`)).text(),
      (error) => error.cause?.code === "UND_ERR_BODY_TIMEOUT",
    );
  } finally {
    restore();
    await dispatcher.destroy();
    await gateway.close();
    await other.close();
  }
});

test("native fetch abort still closes a queued gateway request", async () => {
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  let resolveArrived;
  const arrived = new Promise((resolve) => {
    resolveArrived = resolve;
  });
  const gateway = await serve((_req, res) => {
    res.once("close", resolveClosed);
    resolveArrived();
  });
  const dispatcher = new Agent({ headersTimeout: 40, bodyTimeout: 40 });
  const restore = installGatewayTransport({ baseUrl: gateway.url, dispatcher });
  try {
    const abort = new AbortController();
    const response = fetch(gateway.url, { signal: abort.signal });
    await Promise.race([
      arrived,
      response.then(
        () => {
          throw new Error("Queued gateway replied before cancellation");
        },
        (error) => {
          throw error;
        },
      ),
    ]);
    abort.abort();
    await assert.rejects(response, { name: "AbortError" });
    await Promise.race([
      closed,
      delay(1000).then(() => {
        throw new Error("Aborted gateway request stayed connected");
      }),
    ]);
  } finally {
    restore();
    await dispatcher.destroy();
    await gateway.close();
  }
});

test("gateway upstream idle waits obey the explicit request deadline", async () => {
  const previous = getGlobalDispatcher();
  const dispatcher = new Agent({ headersTimeout: 40, bodyTimeout: 40 });
  setGlobalDispatcher(dispatcher);
  const upstream = await serve(async (_req, res) => {
    await delay(1600);
    res.setHeader("content-type", "application/json");
    res.write('{"choices":[],"usage":');
    await delay(1600);
    res.end('{"total_tokens":17}}');
  });
  const participants = {
    a: {
      token: "test-token",
      team: "red",
      tokens: 10000,
      tpm: 10000,
      concurrency: 1,
    },
  };
  const gateways = [];
  const ledgers = [];
  const call = async (requestTimeoutMs) => {
    const ledger = new BudgetLedger({
      participants,
      teams: { red: { tokens: 10000, tpm: 10000, concurrency: 1 } },
    });
    ledgers.push(ledger);
    const gateway = createBudgetGateway({
      ledger,
      participants,
      upstream: { url: upstream.url, apiKey: "fake-key" },
      models: ["fake-model"],
      limits: { maxOutputTokens: 100, requestTimeoutMs },
    });
    gateways.push(gateway);
    await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    // Node HTTP avoids adding a separate client's idle timeout to this upstream test.
    return new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${gateway.address().port}/participants/a/v1/chat/completions`,
        { method: "POST", headers: { authorization: "Bearer test-token" } },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.once("end", () =>
            resolve({ status: res.statusCode, body, ledger }),
          );
          res.once("error", reject);
        },
      );
      req.once("error", reject);
      req.end(
        JSON.stringify({
          model: "fake-model",
          messages: [{ role: "user", content: "hello" }],
        }),
      );
    });
  };
  try {
    const completed = await call(5000);
    assert.equal(completed.status, 200, completed.body);
    assert.deepEqual(JSON.parse(completed.body).usage, { total_tokens: 17 });
    assert.equal(completed.ledger.snapshot("a")[0].usedTokens, 17);
    const timedOut = await call(100);
    assert.equal(timedOut.status, 502);
    assert.match(JSON.parse(timedOut.body).error.message, /timeout|aborted/i);
  } finally {
    setGlobalDispatcher(previous);
    ledgers.forEach((ledger) => ledger.close());
    for (const gateway of gateways) {
      gateway.closeAllConnections();
      await new Promise((resolve) => gateway.close(resolve));
    }
    await dispatcher.destroy();
    await upstream.close();
  }
});
