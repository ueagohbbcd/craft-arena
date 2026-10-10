import http from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { once } from "node:events";
import { inspectMessages } from "./vision.mjs";
import { publicProviderResponse } from "./reference-cost.mjs";
import { inspectPiRequest, piUsage, publicPiEvent } from "./pi-messages.mjs";
export { ReferenceCostLedger } from "./reference-cost.mjs";
export { BudgetLedger, BudgetError } from "./ledger.mjs";
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function estimateReservation(body, limits = {}) {
  const { maxOutputTokens = 2048, estimator = "conservative" } = limits;
  const contextWindowTokens =
    limits.contextWindowTokens ?? limits.contextTokens ?? 32768;
  const contextBytesPerToken = limits.contextBytesPerToken ?? 4;
  const maxReservationTokens =
    limits.maxReservationTokens ?? contextWindowTokens * 4;
  if (
    !Number.isSafeInteger(contextWindowTokens) ||
    contextWindowTokens < 1 ||
    !Number.isFinite(contextBytesPerToken) ||
    contextBytesPerToken <= 0 ||
    !Number.isSafeInteger(maxReservationTokens) ||
    maxReservationTokens < 1
  )
    throw Object.assign(
      new Error("Invalid configured context/reservation limits"),
      { status: 500 },
    );
  const { copy, imageTokens } = inspectMessages(body, limits);
  const output =
    body.max_completion_tokens ?? body.max_tokens ?? maxOutputTokens;
  if (!Number.isSafeInteger(output) || output <= 0 || output > maxOutputTokens)
    throw Object.assign(new Error("Invalid output token cap"), { status: 400 });
  const textBytes = Buffer.byteLength(JSON.stringify(copy));
  // Context fit and financial/token-budget reservation are different estimates.
  // Neither byte-based heuristic is an exact provider tokenizer or universal bound.
  const contextInputTokens =
    Math.ceil(textBytes / contextBytesPerToken) + 256 + imageTokens;
  const estimatedContextTokens = contextInputTokens + output;
  if (estimatedContextTokens > contextWindowTokens)
    throw Object.assign(
      new Error(
        "Approximate context estimate exceeds configured provider window",
      ),
      { status: 400 },
    );
  const input =
    Math.ceil(textBytes / (estimator === "conservative" ? 1 : 4)) +
    256 +
    imageTokens;
  const total = input + output;
  if (total > maxReservationTokens)
    throw Object.assign(
      new Error("Request exceeds configured reservation safety cap"),
      { status: 400 },
    );
  return {
    input,
    output,
    total,
    estimatedContextTokens,
    contextInputTokens,
    contextWindowTokens,
    maxReservationTokens,
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
      upstreamStarted = false;
    const requestId = randomUUID();
    const abort = new AbortController();
    req.on("aborted", () => abort.abort());
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const match =
        /^\/participants\/([a-zA-Z0-9_-]+)\/v1\/(chat\/completions|messages|budget)$/.exec(
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
      const nativePi = match[2] === "messages";
      if (nativePi && upstream.api !== "pi-messages")
        throw Object.assign(new Error("Native Pi upstream is not configured"), {
          status: 400,
        });
      if (!nativePi && upstream.api === "pi-messages")
        throw Object.assign(
          new Error("This upstream requires the native Pi endpoint"),
          { status: 400 },
        );
      if (
        req.method !== "POST" ||
        !["chat/completions", "messages"].includes(match[2])
      )
        throw Object.assign(new Error("Method not allowed"), { status: 405 });
      if (authorizeRequest && (await authorizeRequest(id)) !== true)
        throw Object.assign(new Error("Match is not running"), { status: 403 });
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > (limits.maxBodyBytes ?? 8 * 1024 * 1024))
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
      const estimationBody = nativePi ? inspectPiRequest(body) : body;
      if (
        !body ||
        typeof body !== "object" ||
        !models.includes(body.model) ||
        !Array.isArray(estimationBody.messages) ||
        (body.n !== undefined && body.n !== 1)
      )
        throw Object.assign(new Error("Invalid model/messages/n"), {
          status: 400,
        });
      const allowed = new Set([
        "model",
        "messages",
        "stream",
        "stream_options",
        "max_tokens",
        "max_completion_tokens",
        "n",
        "user",
        "temperature",
        "top_p",
        "stop",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "response_format",
        "presence_penalty",
        "frequency_penalty",
        "seed",
        "reasoning_effort",
        "store",
      ]);
      if (!nativePi && Object.keys(body).some((k) => !allowed.has(k)))
        throw Object.assign(new Error("Unsupported request field"), {
          status: 400,
        });
      if (body.stream !== undefined && typeof body.stream !== "boolean")
        throw Object.assign(new Error("stream must be boolean"), {
          status: 400,
        });
      if (
        body.tools !== undefined &&
        (!Array.isArray(body.tools) ||
          body.tools.some(
            (t) =>
              t?.type !== "function" ||
              !t.function ||
              typeof t.function.name !== "string",
          ))
      )
        throw Object.assign(
          new Error("Only client-executed function tools are supported"),
          { status: 400 },
        );
      if (body.store !== undefined && body.store !== false)
        throw Object.assign(new Error("Provider storage must be disabled"), {
          status: 400,
        });
      const estimate = estimateReservation(estimationBody, limits);
      requestModel = body.model;
      queueStartedAt = Date.now();
      cashQuote = cashLedger?.quote(id, body.model, estimate);
      if (cashQuote) cashLedger.assertFits(id, cashQuote);
      if (nativePi)
        body.options = { ...body.options, maxTokens: estimate.output };
      else {
        body.max_completion_tokens = estimate.output;
        delete body.max_tokens;
        delete body.user;
        if (body.stream) body.stream_options = { include_usage: true };
      }
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
      const response = await fetch(upstream.url, {
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
      if ((!nativePi && !body.stream) || !response.ok) {
        const text = await response.text();
        let value;
        try {
          value = JSON.parse(text);
          actual = usageTokens(value);
          actualUsage = value.usage;
        } catch {}
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
            return cashLedger || nativePi ? (line === "" ? "\n" : "") : "";
          const data = line.slice(5).trim();
          if (data === "[DONE]") return cashLedger ? "data: [DONE]\n" : "";
          let value;
          try {
            value = JSON.parse(data);
          } catch {
            if (cashLedger || nativePi)
              throw new Error("Malformed upstream SSE data");
            return "";
          }
          if (nativePi) {
            const usage = piUsage(value);
            if (usage) {
              actual = usage.total_tokens;
              actualUsage = usage;
            }
          } else {
            actual = usageTokens(value) ?? actual;
            if (value.usage !== undefined && value.usage !== null)
              actualUsage = value.usage;
          }
          return cashLedger || nativePi
            ? `data: ${JSON.stringify(nativePi ? publicPiEvent(value) : publicProviderResponse(value))}\n`
            : "";
        };
        for await (const chunk of response.body) {
          pending += decoder.decode(chunk, { stream: true });
          if (pending.length > 2_000_000)
            throw new Error("Upstream SSE line too large");
          let newline,
            out = "";
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline).replace(/\r$/, "");
            pending = pending.slice(newline + 1);
            out += processLine(line);
          }
          const data = cashLedger || nativePi ? out : chunk;
          if (data.length && !res.write(data))
            await once(res, "drain", { signal: abort.signal });
        }
        pending += decoder.decode();
        if (pending) {
          const out = processLine(pending);
          if ((cashLedger || nativePi) && out) res.write(out);
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
      reservation?.settle(upstreamStarted ? actual : 0);
      cashReservation?.settle(actualUsage, { dispatched: upstreamStarted });
      if (upstreamStarted) {
        onMetric({
          participant: participantId,
          model: requestModel,
          queueDelayMs,
          reservedTokens: reservation.reservedTokens,
          chargedTokens: actual ?? reservation.reservedTokens,
          usageReported: actual !== undefined,
          ...(cashLedger
            ? { referenceCost: cashLedger.operatorSnapshot(participantId) }
            : {}),
        });
      }
    }
  });
  return server;
}
