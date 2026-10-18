/**
 * Yield SSE data fields from a byte stream. Framing is shared; JSON parsing,
 * retries and error policy belong to each consumer. Incomplete final events
 * are discarded. Iteration owns the stream and cancels it on early return.
 */
export async function* sseData(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.search(/[\r\n]/)) !== -1) {
      // A CR at a chunk boundary may be the first half of CRLF.
      if (buffer[end] === "\r" && end === buffer.length - 1) break;
      const line = buffer.slice(0, end);
      const width = buffer.slice(end, end + 2) === "\r\n" ? 2 : 1;
      buffer = buffer.slice(end + width);
      if (!line) {
        if (data.length) yield data.join("\n");
        data = [];
      } else if (line === "data" || line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
  if (buffer === "\r" && data.length) yield data.join("\n");
}
