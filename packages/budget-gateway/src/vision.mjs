const invalid = (message) => Object.assign(new Error(message), { status: 400 });
/** Account image references without decoding media or reimplementing the provider schema. */
export function inspectMessages(body, limits = {}) {
  if (!Array.isArray(body.messages)) throw invalid("Messages must be an array");
  let images = 0;
  const copy = structuredClone(body);
  for (const message of copy.messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type !== "image_url") continue;
      images++;
      part.image_url = { ...part.image_url, url: "[accounted image]" };
    }
  }
  const perImage = limits.imageTokenAllowance ?? 4096;
  if (!Number.isSafeInteger(perImage) || perImage < 1)
    throw new Error("Invalid configured image token allowance");
  return { copy, imageTokens: images * perImage };
}
