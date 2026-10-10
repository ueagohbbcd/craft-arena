const invalid = (message) => Object.assign(new Error(message), { status: 400 });
function dimensions(bytes, mime) {
  if (mime === "image/png") {
    if (
      bytes.length < 24 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString("ascii", 12, 16) !== "IHDR"
    )
      throw invalid("Invalid PNG header");
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw invalid("Invalid JPEG header");
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p++] !== 0xff) throw invalid("Invalid JPEG marker");
    while (bytes[p] === 0xff) p++;
    const marker = bytes[p++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (p + 2 > bytes.length) break;
    const size = bytes.readUInt16BE(p);
    if (size < 2 || p + size > bytes.length)
      throw invalid("Invalid JPEG segment");
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    ) {
      if (size < 7) throw invalid("Invalid JPEG dimensions");
      return [bytes.readUInt16BE(p + 5), bytes.readUInt16BE(p + 3)];
    }
    p += size;
  }
  throw invalid("JPEG dimensions unavailable");
}
/** Validates bounded inline vision and returns a text-only estimation copy plus image allowance. */
export function inspectMessages(body, limits = {}) {
  let images = 0;
  const copy = structuredClone(body);
  copy.messages = body.messages.map((message) => {
    if (!message || typeof message !== "object")
      throw invalid("Invalid message");
    if (
      Object.keys(message).some(
        (k) =>
          ![
            "role",
            "content",
            "name",
            "tool_calls",
            "tool_call_id",
            "refusal",
          ].includes(k),
      )
    )
      throw invalid("Unsupported message field");
    if (
      !["system", "developer", "user", "assistant", "tool"].includes(
        message.role,
      )
    )
      throw invalid("Unsupported message role");
    if (
      typeof message.content === "string" ||
      message.content === null ||
      message.content === undefined
    )
      return message;
    if (!Array.isArray(message.content)) throw invalid("Invalid content");
    return {
      ...message,
      content: message.content.map((part) => {
        if (part?.type === "text" && typeof part.text === "string")
          return { type: "text", text: part.text };
        if (
          part?.type !== "image_url" ||
          typeof part.image_url?.url !== "string"
        )
          throw invalid("Unsupported content block");
        if (++images > (limits.maxImages ?? 4))
          throw invalid("Too many images");
        const m =
          /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
            part.image_url.url,
          );
        if (!m || m[2].length % 4 !== 0)
          throw invalid(
            "Images must be inline PNG/JPEG base64; remote URLs forbidden",
          );
        const bytes = Buffer.from(m[2], "base64");
        if (bytes.length > (limits.maxImageBytes ?? 2 * 1024 * 1024))
          throw invalid("Image exceeds byte limit");
        if (bytes.toString("base64") !== m[2])
          throw invalid("Invalid image base64");
        const [width, height] = dimensions(bytes, m[1]);
        if (
          !width ||
          !height ||
          width > (limits.maxImageDimension ?? 4096) ||
          height > (limits.maxImageDimension ?? 4096) ||
          width * height > (limits.maxImagePixels ?? 16_777_216)
        )
          throw invalid("Image exceeds dimension limit");
        if (
          part.image_url.detail &&
          !["auto", "low", "high"].includes(part.image_url.detail)
        )
          throw invalid("Invalid image detail");
        return {
          type: "image_url",
          image_url: { url: "[accounted inline image]" },
        };
      }),
    };
  });
  const perImage = limits.imageTokenAllowance ?? 4096;
  if (!Number.isSafeInteger(perImage) || perImage < 1)
    throw invalid("Invalid configured image token allowance");
  return { copy, imageTokens: images * perImage };
}
