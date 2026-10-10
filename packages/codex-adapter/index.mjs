import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import {
  inspectPiRequest,
  publicPiEvent,
  PiRequestValidationError,
} from "../budget-gateway/src/pi-messages.mjs";

/** Restore the SDK origin before conversion, keeping signed reasoning and paired item IDs. */
export function codexContext(context, model) {
  const result = structuredClone(context);
  for (const message of result.messages) {
    if (
      message.role === "assistant" &&
      message.api === "pi-messages" &&
      message.provider === "arena"
    ) {
      message.api = model.api;
      message.provider = model.provider;
    }
  }
  return result;
}

export function nativeEvent(event) {
  const { type, contentIndex } = event;
  if (type === "start") return { type };
  if (["text_start", "thinking_start"].includes(type))
    return { type, contentIndex };
  if (["text_delta", "thinking_delta", "toolcall_delta"].includes(type))
    return { type, contentIndex, delta: event.delta };
  if (["text_end", "thinking_end"].includes(type)) {
    const block = event.partial.content[contentIndex];
    return {
      type,
      contentIndex,
      content: event.content,
      contentSignature: block.textSignature ?? block.thinkingSignature,
      redacted: block.redacted,
    };
  }
  if (type === "toolcall_start") {
    const block = event.partial.content[contentIndex];
    return { type, contentIndex, id: block.id, toolName: block.name };
  }
  if (type === "toolcall_end")
    return { type, contentIndex, toolCall: event.toolCall };
  if (["done", "error"].includes(type)) {
    const message = event.message ?? event.error;
    return {
      type,
      reason: event.reason,
      usage: publicPiEvent({ usage: message.usage }).usage,
      errorMessage:
        type === "error" ? "Trusted provider request failed" : undefined,
      responseId: message.responseId,
      providerThinkingLevel: message.providerThinkingLevel,
    };
  }
  throw new Error(`Unsupported SDK event: ${type}`);
}

/** The terminal SDK message can contain late encrypted-content updates after an end event. */
export function finalSignatureEvents(message) {
  return message.content.map((block, contentIndex) => {
    if (block.type === "text")
      return {
        type: "text_end",
        contentIndex,
        content: block.text,
        contentSignature: block.textSignature,
      };
    if (block.type === "thinking")
      return {
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        contentSignature: block.thinkingSignature,
        redacted: block.redacted,
      };
    return { type: "toolcall_end", contentIndex, toolCall: block };
  });
}

const equal = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createCodexAdapter({
  models,
  provider = "openai-codex",
  allowedModels,
  token,
  maxBodyBytes = 8 * 1024 * 1024,
  maxOutputTokens = 2048,
  timeoutMs = 120000,
}) {
  if (!["openai-codex", "deepseek"].includes(provider))
    throw new Error("Unsupported trusted provider");
  if (!token || !Array.isArray(allowedModels) || !allowedModels.length)
    throw new Error("Configure trusted adapter token and model allowlist");
  for (const id of allowedModels)
    if (!models.getModel(provider, id))
      throw new Error(`Unknown Pi Codex model: ${id}`);
  return http.createServer(async (req, res) => {
    const abort = new AbortController();
    req.on("aborted", () => abort.abort());
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      if (
        req.method !== "POST" ||
        req.url !== "/messages" ||
        !equal(req.headers.authorization, `Bearer ${token}`)
      )
        throw new PiRequestValidationError("Not found or unauthorized", 403);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBodyBytes)
          throw new PiRequestValidationError("Body too large", 413);
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new PiRequestValidationError("Invalid JSON");
      }
      inspectPiRequest(body);
      if (!allowedModels.includes(body.model))
        throw new PiRequestValidationError("Model is not allowed");
      const cap = body.options?.maxTokens ?? maxOutputTokens;
      if (!Number.isSafeInteger(cap) || cap < 1 || cap > maxOutputTokens)
        throw new PiRequestValidationError("Invalid output reservation cap");
      const model = models.getModel(provider, body.model);
      const options = body.options ?? {};
      let usageReported = false;
      let accountingUsage;
      const events = models.stream(model, codexContext(body.context, model), {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]),
        maxTokens: cap,
        reasoningEffort: options.reasoning,
        cacheRetention: options.cacheRetention,
        sessionId: options.sessionId,
        toolChoice: options.toolChoice,
        transport: "sse",
        maxRetries: 0,
        onProviderStreamEvent(value) {
          const raw = value?.response?.usage ?? value?.usage;
          if (raw) {
            usageReported = true;
            const cached =
              raw.input_tokens_details?.cached_tokens ??
              raw.prompt_tokens_details?.cached_tokens ??
              raw.prompt_cache_hit_tokens;
            const reasoning =
              raw.output_tokens_details?.reasoning_tokens ??
              raw.completion_tokens_details?.reasoning_tokens;
            accountingUsage = {
              prompt_tokens: raw.input_tokens ?? raw.prompt_tokens,
              completion_tokens: raw.output_tokens ?? raw.completion_tokens,
              total_tokens: raw.total_tokens,
              ...(cached === undefined
                ? {}
                : { prompt_tokens_details: { cached_tokens: cached } }),
              ...(reasoning === undefined
                ? {}
                : {
                    completion_tokens_details: { reasoning_tokens: reasoning },
                  }),
            };
          }
        },
      });
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-store");
      const send = async (value) => {
        if (!res.write(`data: ${JSON.stringify(value)}\n\n`))
          await once(res, "drain", { signal: abort.signal });
      };
      const endedBlocks = new Map();
      for await (const event of events) {
        if (["done", "error"].includes(event.type)) {
          for (const update of finalSignatureEvents(
            event.message ?? event.error,
          )) {
            if (endedBlocks.get(update.contentIndex) !== JSON.stringify(update))
              await send(update);
          }
          await send({ ...nativeEvent(event), usageReported, accountingUsage });
          res.end();
          return;
        }
        const value = nativeEvent(event);
        if (["text_end", "thinking_end", "toolcall_end"].includes(value.type))
          endedBlocks.set(value.contentIndex, JSON.stringify(value));
        await send(value);
      }
      throw new Error("Provider stream ended without terminal event");
    } catch (error) {
      if (!res.headersSent) {
        const validation = error instanceof PiRequestValidationError;
        res.statusCode = validation ? error.status : 502;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: {
              message: validation
                ? error.message
                : "Trusted provider adapter failed",
            },
          }),
        );
      } else res.destroy();
    }
  });
}
