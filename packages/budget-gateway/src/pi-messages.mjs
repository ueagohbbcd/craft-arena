export class PiRequestValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const invalid = (message) => new PiRequestValidationError(message);
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const only = (value, keys) => {
  if (!record(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw invalid("Unsupported Pi request field");
};
/** Native history stays intact; an image-free copy accounts every schema and opaque signature. */
export function inspectPiRequest(body) {
  only(body, ["model", "context", "options"]);
  only(body.context, ["messages"]);
  only(body.options ?? {}, [
    "maxTokens",
    "reasoning",
    "cacheRetention",
    "sessionId",
    "toolChoice",
    "temperature",
  ]);
  const options = body.options ?? {};
  if (options.temperature !== undefined)
    throw invalid("Codex sampling temperature is unsupported");
  if (
    options.reasoning !== undefined &&
    !["minimal", "low", "medium", "high", "xhigh", "max"].includes(
      options.reasoning,
    )
  )
    throw invalid("Invalid reasoning level");
  if (
    options.cacheRetention !== undefined &&
    !["none", "short", "long"].includes(options.cacheRetention)
  )
    throw invalid("Invalid cache retention");
  if (
    options.sessionId !== undefined &&
    (typeof options.sessionId !== "string" || options.sessionId.length > 256)
  )
    throw invalid("Invalid session identifier");
  if (
    options.toolChoice !== undefined &&
    !["auto", "none", "required"].includes(options.toolChoice)
  )
    throw invalid("Unsupported tool choice");
  if (!Array.isArray(body.context.messages) || !body.context.messages.length)
    throw invalid("Pi transcript messages required");
  const copy = structuredClone(body);
  const images = [];
  for (const message of copy.context.messages) {
    if (
      !record(message) ||
      !["system", "user", "assistant", "toolResult"].includes(message.role)
    )
      throw invalid("Invalid Pi message role");
    if (message.role === "system") {
      if (
        message.toolsAdded !== undefined &&
        (!Array.isArray(message.toolsAdded) ||
          message.toolsAdded.some(
            (tool) =>
              !record(tool) ||
              typeof tool.name !== "string" ||
              !record(tool.parameters) ||
              Object.keys(tool).some(
                (key) =>
                  ![
                    "name",
                    "description",
                    "parameters",
                    "constrainedSampling",
                  ].includes(key),
              ),
          ))
      )
        throw invalid("Only declared client function tools are supported");
    }
    if (
      message.role === "toolResult" &&
      (typeof message.toolCallId !== "string" ||
        typeof message.toolName !== "string")
    )
      throw invalid("Invalid tool result");
    if (
      typeof message.content === "string" &&
      ["user", "system"].includes(message.role)
    )
      continue;
    if (!Array.isArray(message.content)) throw invalid("Invalid Pi content");
    for (const block of message.content) {
      if (!record(block)) throw invalid("Invalid Pi block");
      if (
        block.type === "image" &&
        ["user", "toolResult"].includes(message.role)
      ) {
        if (
          typeof block.data !== "string" ||
          typeof block.mimeType !== "string"
        )
          throw invalid("Invalid image");
        images.push({
          type: "image_url",
          image_url: { url: `data:${block.mimeType};base64,${block.data}` },
        });
        block.data = "[accounted inline image]";
      } else if (block.type === "text" && typeof block.text === "string") {
        if (
          block.textSignature !== undefined &&
          typeof block.textSignature !== "string"
        )
          throw invalid("Invalid text signature");
      } else if (
        block.type === "thinking" &&
        message.role === "assistant" &&
        typeof block.thinking === "string"
      ) {
        if (block.thinkingSignature !== undefined) {
          if (typeof block.thinkingSignature !== "string")
            throw invalid("Invalid reasoning signature");
          if (
            ["reasoning_content", "reasoning"].includes(block.thinkingSignature)
          )
            continue;
          let item;
          try {
            item = JSON.parse(block.thinkingSignature);
          } catch {
            throw invalid("Invalid reasoning signature JSON");
          }
          if (item?.type !== "reasoning")
            throw invalid("Reasoning signature must contain a reasoning item");
        }
      } else if (
        block.type === "toolCall" &&
        message.role === "assistant" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        record(block.arguments)
      ) {
        // Executed on the participant, never by the adapter.
      } else throw invalid("Unsupported Pi content block");
    }
  }
  return {
    model: body.model,
    max_completion_tokens: options.maxTokens,
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
    prompt_tokens_details: { cached_tokens: u.cacheRead },
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
