export class PiRequestValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const invalid = (message) => new PiRequestValidationError(message);
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
/** Native history stays opaque; schemas and signatures count toward the reservation. */
export function inspectPiRequest(body) {
  if (!Array.isArray(body.context?.messages))
    throw invalid("Pi transcript messages required");
  const copy = structuredClone(body);
  const images = [];
  for (const message of copy.context.messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "image") continue;
      images.push({
        type: "image_url",
        image_url: { url: "[accounted image]" },
      });
      block.data = "[accounted image]";
    }
  }
  return {
    model: body.model,
    max_completion_tokens: body.options?.maxTokens,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: JSON.stringify(copy) }, ...images],
      },
    ],
  };
}

export function piUsage(value) {
  if (value?.usageReported === false) return undefined;
  if (value?.usageReported === true) {
    const raw = value.accountingUsage;
    if (
      !record(raw) ||
      !Number.isSafeInteger(raw.total_tokens) ||
      raw.total_tokens < 0
    )
      return undefined;
    if (raw.prompt_tokens === undefined || raw.completion_tokens === undefined)
      return { total_tokens: raw.total_tokens };
    if (
      ![raw.prompt_tokens, raw.completion_tokens].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      raw.total_tokens !== raw.prompt_tokens + raw.completion_tokens
    )
      return undefined;
    return raw;
  }
  const u = value?.usage;
  if (!u) return undefined;
  const values = [u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens];
  if (!values.every((n) => Number.isSafeInteger(n) && n >= 0)) return undefined;
  if (u.totalTokens !== u.input + u.output + u.cacheRead + u.cacheWrite)
    return undefined;
  return {
    prompt_tokens: u.input + u.cacheRead + u.cacheWrite,
    completion_tokens: u.output,
    total_tokens: u.totalTokens,
    prompt_tokens_details: {
      cached_tokens: u.cacheRead,
      ...(u.cacheWrite > 0 ? { cache_write_tokens: u.cacheWrite } : {}),
    },
    ...(Number.isSafeInteger(u.reasoning) && u.reasoning >= 0
      ? { completion_tokens_details: { reasoning_tokens: u.reasoning } }
      : {}),
  };
}

/** Native event allowlist excludes SDK monetary pricing and trusted transport metadata. */
export function publicPiEvent(value) {
  const keys = [
    "type",
    "contentIndex",
    "delta",
    "content",
    "contentSignature",
    "redacted",
    "id",
    "toolName",
    "toolCall",
    "reason",
    "errorMessage",
    "responseId",
    "providerThinkingLevel",
  ];
  const out = Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
  if (value.usage) {
    out.usage = Object.fromEntries(
      ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "reasoning"]
        .filter((key) => value.usage[key] !== undefined)
        .map((key) => [key, value.usage[key]]),
    );
    out.usage.cost = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    };
  }
  return out;
}
