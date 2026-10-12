import { isContextOverflow } from "@earendil-works/pi-ai";

/** Keep actionable failure semantics without forwarding provider/auth error bodies. */
export function providerFailure(error, { status, aborted = false } = {}) {
  status ??= error?.status;
  if (!Number.isInteger(status) || status < 400 || status > 599)
    status = undefined;
  const message = error?.errorMessage ?? error?.message ?? "";
  const rawCode = error?.code ?? error?.cause?.code ?? "";
  const knownCodes = [
    "context_length_exceeded",
    "invalid_api_key",
    "invalid_encrypted_content",
    "model_not_found",
    "unsupported_parameter",
    "invalid_request_error",
    "rate_limit_exceeded",
    "usage_limit_reached",
    "usage_not_included",
    "insufficient_quota",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ];
  const code = knownCodes.find(
    (candidate) =>
      candidate === rawCode ||
      new RegExp(`\\b${candidate}\\b`, "i").test(message),
  );
  let category = "provider_failure";
  if (aborted || error?.stopReason === "aborted") category = "cancelled";
  else if (
    status === 401 ||
    status === 403 ||
    /no (?:API key|OAuth credentials)|authentication failed|invalid API key/i.test(
      message,
    )
  )
    category = "authentication";
  else if (
    status === 429 ||
    /rate.?limit|too many requests|usage limit/i.test(message)
  )
    category = "rate_limit";
  else if (status >= 500) category = "provider_failure";
  else if (isContextOverflow({ stopReason: "error", errorMessage: message }))
    category = "context_length";
  else if (/timeout|timed out/i.test(message) || /TIMEOUT/.test(code ?? ""))
    category = "timeout";
  else if (
    /fetch failed|network|socket|connection|ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(
      `${message} ${code}`,
    )
  )
    category = "network";
  else if (status !== undefined) category = "invalid_request";
  return {
    category,
    ...(status === undefined ? {} : { status }),
    ...(code ? { code } : {}),
    message: `Trusted provider failure [category=${category}${status === undefined ? "" : `; status=${status}`}]${category === "context_length" ? ": context_length_exceeded" : ""}`,
  };
}
