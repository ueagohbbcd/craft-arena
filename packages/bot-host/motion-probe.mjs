import { status } from "./rpc.mjs";

/** Polls the host's small native status snapshot while bash waits. */
export function createMotionProbe({ socketPath, intervalMs = 500 }) {
  let current;
  let closed = false;
  let pending = false;
  const poll = async () => {
    if (closed || pending) return;
    pending = true;
    try {
      const response = await status(socketPath);
      if (response.bot?.position) {
        const { x, y, z } = response.bot.position;
        current = `${Math.round(x / 2)},${Math.round(y / 2)},${Math.round(z / 2)}|${response.bot.inventory}|${response.bot.health}|${response.bot.food}`;
      }
    } catch {
    } finally {
      pending = false;
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), intervalMs);
  timer.unref?.();
  return {
    key: () => current,
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
