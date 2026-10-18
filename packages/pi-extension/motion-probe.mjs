import { sseData } from "../bridge-protocol/sse.mjs";

/**
 * Follows the bridge's state stream while a bash wait runs, so the wait can
 * tell whether the character is doing anything. `key()` changes when the
 * character moves about two blocks or its inventory changes (digging, placing,
 * picking up); it is undefined until the first state arrives.
 */
export function createMotionProbe({ url, token, fetch = globalThis.fetch }) {
  const abort = new AbortController();
  let current;
  const accept = (frame) => {
    let event;
    try {
      event = JSON.parse(frame);
    } catch {
      return;
    }
    if (event?.type !== "reset" && event?.type !== "snapshot") return;
    const position = event.data?.entity?.position;
    if (!position) return;
    const cell = ["x", "y", "z"]
      .map((axis) => Math.round(Number(position[axis]) / 2))
      .join(",");
    const items = (event.data.inventory?.slots ?? [])
      .map((item) => (item ? `${item.type}:${item.count}` : ""))
      .join(",");
    current = `${cell}|${items}`;
  };
  (async () => {
    const response = await fetch(`${url.replace(/\/$/, "")}/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return;
    }
    for await (const data of sseData(response.body)) accept(data);
  })().catch(() => {}); // Without a stream, the wait judges by output alone.
  return {
    key: () => current,
    close: () => abort.abort(),
  };
}
