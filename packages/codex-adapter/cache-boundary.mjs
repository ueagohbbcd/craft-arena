/** The runtime adds this user-message prefix only to the current request. */
export const CURRENT_OBSERVATION_PREFIX =
  "Current observation for this model request only.";

const explicit = () => ({ mode: "explicit" });
const blockTypes = new Set(["input_text", "input_image", "input_file"]);
const responseApis = new Set(["openai-responses", "openai-codex-responses"]);

function textOf(item) {
  if (typeof item?.content === "string") return item.content;
  const first = item?.content?.[0];
  return first?.type === "input_text" ? first.text : undefined;
}

/**
 * This config is trusted operator input, never a participant generation option.
 * Explicit mode is experimental on OAuth: a model name alone does not prove
 * that backend accepts the public Responses cache schema.
 */
export function createCacheBoundaryPolicy({
  provider = "openai-codex",
  promptCacheStrategy = "provider-native",
} = {}) {
  const strategy = promptCacheStrategy;
  if (!["provider-native", "openai-explicit"].includes(strategy))
    throw new Error("Unknown trusted prompt-cache strategy");
  if (strategy === "openai-explicit" && provider !== "openai-codex")
    throw new Error(
      "Use provider-native prompt caching with DeepSeek; OpenAI explicit boundaries are unsupported",
    );
  const description =
    strategy === "openai-explicit"
      ? "Experimental OpenAI explicit boundaries enabled; OAuth support is unverified; cache hits are not guaranteed"
      : provider === "deepseek"
        ? "DeepSeek native prefix caching; no OpenAI cache fields added; cache hits are not guaranteed"
        : "Codex native caching unchanged; OAuth explicit-boundary support is unverified; cache hits are not guaranteed";
  return Object.freeze({
    strategy,
    description,
    adapt(payload, model) {
      const diagnostic = (reason, markedBoundaries = 0) => ({
        strategy,
        reason,
        markedBoundaries,
        // This describes payload shaping, never proof of a provider cache hit.
        cacheHitVerified: false,
      });
      if (strategy === "provider-native")
        return { payload, diagnostic: diagnostic("provider-native") };
      if (!responseApis.has(model?.api))
        return { payload, diagnostic: diagnostic("unsupported-api") };
      return applyExplicitCacheBoundaries(payload, diagnostic);
    },
  });
}

/**
 * Mark stable eligible endpoints AFTER Pi's provider conversion. Pi 1.1 drops
 * raw message/block cache properties during conversion. Keep earlier endpoints
 * as well as the latest one: explicit lookup needs a matching prior boundary
 * (the public guide describes first 2 + latest 50); a moving last marker alone
 * cannot reuse the previous request's stable-prefix write.
 *
 * No history/session cache is needed. Endpoints are reconstructed from the
 * full transcript, and no item, tool ID, reasoning blob, or user data is removed.
 */
function applyExplicitCacheBoundaries(payload, diagnostic) {
  const tail = Array.isArray(payload?.input) ? payload.input.at(-1) : undefined;
  const tailText = textOf(tail);
  if (
    !Array.isArray(payload?.input) ||
    tail?.role !== "user" ||
    typeof tailText !== "string" ||
    !tailText.startsWith(CURRENT_OBSERVATION_PREFIX)
  )
    return { payload, diagnostic: diagnostic("no-current-observation-tail") };

  const result = structuredClone(payload);
  let marked = 0;
  for (const item of result.input.slice(0, -1)) {
    let key;
    if (["user", "developer", "system"].includes(item?.role)) key = "content";
    else if (
      ["function_call_output", "custom_tool_call_output"].includes(item?.type)
    )
      key = "output";
    else continue;

    // Responses supports content-block breakpoints, not a marker on an item or
    // on a bare output string. Convert only that string, preserving call pairing.
    if (typeof item[key] === "string")
      item[key] = [{ type: "input_text", text: item[key] }];
    const last = Array.isArray(item[key]) ? item[key].at(-1) : undefined;
    if (!blockTypes.has(last?.type)) continue;
    last.prompt_cache_breakpoint = explicit();
    marked++;
  }
  // Explicit-only mode avoids spending a cache write on the changing snapshot.
  // Leave instructions, tools, cache key, transport and all request IDs intact.
  result.prompt_cache_options = { mode: "explicit" };
  // The old retention field and new cache options are mutually exclusive.
  delete result.prompt_cache_retention;
  return {
    payload: result,
    diagnostic: diagnostic("stable-prefix-marked", marked),
  };
}
