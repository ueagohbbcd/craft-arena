import http from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { once } from "node:events";
import { fetch as upstreamFetch, getGlobalDispatcher } from "undici";
import { inspectMessages } from "./vision.mjs";
import { publicProviderResponse } from "./reference-cost.mjs";
export { ReferenceCostLedger } from "./reference-cost.mjs";
export { BudgetLedger, BudgetError } from "./ledger.mjs";
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function estimateReservation(body, limits = {}) {
  const { defaultOutputTokens = 2048, estimator = "conservative" } = limits;
  const output =
    body.max_completion_tokens ?? body.max_tokens ?? defaultOutputTokens;
  const choices = body.n ?? 1;
  if (![output, choices].every((n) => Number.isSafeInteger(n) && n > 0))
    throw Object.assign(
      new Error("Output tokens and n must be positive integers"),
      { status: 400 },
    );
  const { copy, imageTokens } = inspectMessages(body, limits);
  const textBytes = Buffer.byteLength(JSON.stringify(copy));
  // These are accounting estimates, not a provider tokenizer or context admission policy.
  const contextInputTokens = Math.ceil(textBytes / 4) + 256 + imageTokens;
  const input =
    Math.ceil(textBytes / (estimator === "conservative" ? 1 : 4)) +
    256 +
    imageTokens;
  const reservedOutput = output * choices;
  const total = input + reservedOutput;
  if (!Number.isSafeInteger(total) || total < 1)
    throw Object.assign(
      new Error("Reservation exceeds supported integer precision"),
      { status: 400 },
    );
  return {
    input,
    output: reservedOutput,
    requestedOutput: output,
    total,
    estimatedContextTokens: contextInputTokens + output,
    contextInputTokens,
    textBytes,
  };
}
function usageTokens(value) {
  const u = value?.usage;
  const n =
    u?.total_tokens ??
    (Number.isFinite(u?.prompt_tokens) && Number.isFinite(u?.completion_tokens)
      ? u.prompt_tokens + u.completion_tokens
      : undefined);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
/** No client-selected upstream URLs, identities, or credentials. */
export function createBudgetGateway({
  ledger,
  cashLedger,
  participants,
  upstream,
  models,
  limits = {},
  authorizeRequest,
  onMetric = () => {},
}) {
  if (!Array.isArray(models) || !models.length)
    throw new Error("Configure allowed models");
  const lastRequest = new Map();
  const server = http.createServer(async (req, res) => {
    let reservation,
      cashReservation,
      cashQuote,
      actualUsage,
      participantId,
      requestModel,
      queueStartedAt,
      queueDelayMs = 0,
      actual,
      requestRejected = false,
      upstreamStarted = false;
    const requestId = randomUUID();
    const abort = new AbortController();
    req.on("aborted", () => abort.abort());
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const match =
        /^\/participants\/([a-zA-Z0-9_-]+)\/v1\/(chat\/completions|budget)$/.exec(
          req.url,
        );
      const id = match?.[1],
        participant = participants[id];
      participantId = id;
      if (
        !["POST", "GET"].includes(req.method) ||
        !participant ||
        !equal(req.headers.authorization, `Bearer ${participant.token}`) ||
        !participant.token
      )
        throw Object.assign(new Error("Not found or unauthorized"), {
          status: 403,
        });
      if (req.method === "GET" && match[2] === "budget") {
        const [participantBudget, teamBudget] = ledger.snapshot(id);
        if (cashLedger) {
          const [pCash, tCash] = cashLedger.snapshot(id);
          participantBudget.cash = pCash;
          teamBudget.cash = tCash;
        }
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(
          JSON.stringify({
            participantId: id,
            teamId: participant.team,
            at: Date.now(),
            participant: participantBudget,
            team: teamBudget,
            lastRequest: lastRequest.get(id) ?? null,
          }),
        );
        return;
      }
      if (req.method !== "POST" || match[2] !== "chat/completions")
        throw Object.assign(new Error("Method not allowed"), { status: 405 });
      if (authorizeRequest && (await authorizeRequest(id)) !== true)
        throw Object.assign(new Error("Match is not running"), { status: 403 });
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (limits.maxBodyBytes !== undefined && bytes > limits.maxBodyBytes)
          throw Object.assign(new Error("Body too large"), { status: 413 });
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        throw Object.assign(new Error("Invalid JSON"), { status: 400 });
      }
      if (!body || typeof body !== "object" || !models.includes(body.model))
        throw Object.assign(new Error("Model is not allowed"), { status: 400 });
      // Hosted tools carry extra charges/actions that this token-price ledger cannot account for.
      // Function/custom tools execute in the participant; provider schema details remain upstream's job.
      if (
        body.web_search_options !== undefined ||
        (Array.isArray(body.tools) &&
          body.tools.some(
            (tool) => tool?.type && !["function", "custom"].includes(tool.type),
          ))
      )
        throw Object.assign(
          new Error("Only client-executed tools are budgeted"),
          { status: 400 },
        );
      const estimate = estimateReservation(body, limits);
      requestModel = body.model;
      queueStartedAt = Date.now();
      cashQuote = cashLedger?.quote(id, body.model, estimate);
      // The shared provider account must not retain participant-created completion resources
      // or accept participant-selected attribution for another user.
      body.store = false;
      delete body.user;
      delete body.safety_identifier;
      // Forward exactly the concrete output value we reserved, preserving legacy
      // max_tokens clients without leaving null or conflicting caps upstream.
      if (body.max_completion_tokens == null && body.max_tokens != null) {
        body.max_tokens = estimate.requestedOutput;
        delete body.max_completion_tokens;
      } else {
        body.max_completion_tokens = estimate.requestedOutput;
        delete body.max_tokens;
      }
      if (body.n === null) body.n = 1;
      if (body.stream)
        body.stream_options = { ...body.stream_options, include_usage: true };
      reservation = await ledger.acquire(id, estimate.total, {
        signal: abort.signal,
      });
      if (cashQuote)
        cashReservation = await cashLedger.acquire(id, cashQuote, {
          signal: abort.signal,
          requestId,
        });
      queueDelayMs = Date.now() - queueStartedAt;
      cashLedger?.noteWait(id, queueDelayMs, cashQuote);
      if (authorizeRequest && (await authorizeRequest(id)) !== true)
        throw Object.assign(new Error("Match ended before admission"), {
          status: 403,
        });
      res.setHeader("x-arena-queue-delay-ms", String(queueDelayMs));
      res.setHeader("x-arena-reserved-tokens", String(estimate.total));
      if (cashLedger)
        res.setHeader(
          "x-arena-cash-ratios",
          JSON.stringify(
            cashLedger.feedback(id, { quote: cashQuote, queueDelayMs }),
          ),
        );
      res.setHeader(
        "x-arena-estimated-context-tokens",
        String(estimate.estimatedContextTokens),
      );
      const [participantBudget, teamBudget] = ledger.snapshot(id);
      if (participantBudget.remainingTokens !== null)
        res.setHeader(
          "x-arena-participant-remaining-tokens",
          String(participantBudget.remainingTokens),
        );
      if (teamBudget.remainingTokens !== null)
        res.setHeader(
          "x-arena-team-remaining-tokens",
          String(teamBudget.remainingTokens),
        );
      lastRequest.set(id, {
        queueDelayMs,
        reservedTokens: reservation.reservedTokens,
        estimatedContextTokens: estimate.estimatedContextTokens,
        admittedAt: Date.now(),
      });
      upstreamStarted = true;
      const response = await upstreamFetch(upstream.url, {
        // The explicit request signal owns generation timeout, including slow reasoning streams.
        dispatcher: {
          dispatch(options, handler) {
            return getGlobalDispatcher().dispatch(
              { ...options, headersTimeout: 0, bodyTimeout: 0 },
              handler,
            );
          },
        },
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${upstream.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          abort.signal,
          AbortSignal.timeout(limits.requestTimeoutMs ?? 120000),
        ]),
      });
      res.statusCode = response.status;
      if (!body.stream || !response.ok) {
        const text = await response.text();
        let value;
        try {
          value = JSON.parse(text);
          actual = usageTokens(value);
          actualUsage = value.usage;
        } catch {}
        requestRejected =
          !response.ok && actual === undefined && actualUsage == null;
        res.setHeader(
          "content-type",
          response.headers.get("content-type") ?? "application/json",
        );
        res.end(
          cashLedger
            ? JSON.stringify(
                value
                  ? publicProviderResponse(value)
                  : {
                      error: {
                        message: "Upstream returned a non-JSON response",
                      },
                    },
              )
            : text,
        );
      } else {
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        let pending = "";
        const decoder = new TextDecoder();
        const processLine = (line) => {
          if (!line.startsWith("data:"))
            return cashLedger ? (line === "" ? "\n" : "") : "";
          const data = line.slice(5).trim();
          if (data === "[DONE]") return cashLedger ? "data: [DONE]\n" : "";
          let value;
          try {
            value = JSON.parse(data);
          } catch {
            if (cashLedger) throw new Error("Malformed upstream SSE data");
            return "";
          }
          actual = usageTokens(value) ?? actual;
          if (value.usage !== undefined && value.usage !== null)
            actualUsage = value.usage;
          return cashLedger
            ? `data: ${JSON.stringify(publicProviderResponse(value))}\n`
            : "";
        };
        for await (const chunk of response.body) {
          pending += decoder.decode(chunk, { stream: true });
          let newline,
            out = "";
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline).replace(/\r$/, "");
            pending = pending.slice(newline + 1);
            if (
              limits.maxSseLineBytes !== undefined &&
              Buffer.byteLength(line) > limits.maxSseLineBytes
            )
              throw new Error("Upstream SSE line too large");
            out += processLine(line);
          }
          if (
            limits.maxSseLineBytes !== undefined &&
            Buffer.byteLength(pending) > limits.maxSseLineBytes
          )
            throw new Error("Upstream SSE line too large");
          const data = cashLedger ? out : chunk;
          if (data.length && !res.write(data))
            await once(res, "drain", { signal: abort.signal });
        }
        pending += decoder.decode();
        if (pending) {
          if (
            limits.maxSseLineBytes !== undefined &&
            Buffer.byteLength(pending) > limits.maxSseLineBytes
          )
            throw new Error("Upstream SSE line too large");
          const out = processLine(pending);
          if (cashLedger && out) res.write(out);
        }
        res.end();
      }
    } catch (err) {
      if (!res.headersSent && !res.destroyed) {
        res.statusCode = err.status ?? 502;
        res.setHeader("content-type", "application/json");
        const cashRatios =
          err.cashRatios ??
          (cashLedger && participantId && queueStartedAt !== undefined
            ? cashLedger.feedback(participantId, {
                quote: cashQuote,
                queueDelayMs: cashReservation
                  ? queueDelayMs
                  : Math.max(0, Date.now() - queueStartedAt),
              })
            : undefined);
        if (cashRatios)
          res.setHeader("x-arena-cash-ratios", JSON.stringify(cashRatios));
        res.end(
          JSON.stringify({
            error: {
              message: err.message,
              ...(cashRatios ? { cashRatios } : {}),
            },
          }),
        );
      } else if (!res.destroyed) res.destroy();
    } finally {
      reservation?.settle(upstreamStarted && !requestRejected ? actual : 0);
      cashReservation?.settle(actualUsage, {
        dispatched: upstreamStarted && !requestRejected,
      });
      if (upstreamStarted) {
        onMetric({
          participant: participantId,
          model: requestModel,
          queueDelayMs,
          reservedTokens: reservation.reservedTokens,
          chargedTokens: requestRejected
            ? 0
            : (actual ?? reservation.reservedTokens),
          usageReported: actual !== undefined,
          requestRejected,
          ...(cashLedger
            ? { referenceCost: cashLedger.operatorSnapshot(participantId) }
            : {}),
        });
      }
    }
  });
  return server;
}
