import { setTimeout as delay } from "node:timers/promises";

/** Passive chat only: no world mirror, action calls, or model wakeups. */
export function startChatInbox({ url, token, inbox, retryMs = 1000 }) {
  const controller = new AbortController();
  const { signal } = controller;
  function accept(frame) {
    const payload = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!payload) return;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (
      signal.aborted ||
      event.type !== "event" ||
      event.data?.name !== "messagestr"
    )
      return;
    const args = event.data.args;
    if (!Array.isArray(args) || typeof args[0] !== "string") return;
    if (args[1] === "game_info") return;
    const metadata = args[5] ?? {};
    inbox.post(
      {
        sessionId: inbox.sessionId,
        kind: "event",
        priority: "normal",
        data: {
          type: "game.chat",
          source: "minecraft",
          trusted: false,
          text: args[0],
          position: args[1] ?? null,
          senderUUID: args[3] ?? null,
          verified: args[4] ?? null,
          observedAt: metadata.observedAt ?? Date.now(),
          truncated: metadata.truncated === true,
        },
      },
      { source: "runtime" },
    );
  }
  const done = (async () => {
    while (!signal.aborted) {
      try {
        const response = await fetch(`${url.replace(/\/$/, "")}/v1/chat`, {
          headers: { authorization: `Bearer ${token}` },
          signal,
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error("Chat stream unavailable");
        }
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          // SSE accepts CRLF as well as LF, even across chunk boundaries.
          buffer = buffer.replace(/\r\n/g, "\n");
          let end;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            accept(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
          }
        }
      } catch {
        // A disconnected bridge may return; no historical messages are replayed.
      }
      if (!signal.aborted) {
        try {
          await delay(retryMs, undefined, { signal });
        } catch {
          break;
        }
      }
    }
  })();
  return {
    async close() {
      controller.abort();
      await done;
    },
  };
}
