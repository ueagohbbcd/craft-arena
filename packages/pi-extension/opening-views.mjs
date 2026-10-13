import { connectBot } from "../bot-sdk/index.mjs";
import { snapshotFromBot } from "mineflayer-world-memory/live.mjs";
import { captureOpeningComposite } from "../world-visual/prismarine.mjs";

export function inside(position, bounds) {
  return (
    !!position &&
    !!bounds &&
    ["x", "y", "z"].every(
      (axis) =>
        position[axis] >= bounds.min[axis] &&
        position[axis] < bounds.max[axis] + 1,
    )
  );
}

/** Two map-defined observations, using only this participant's loaded world. */
export function createOpeningViews({
  url,
  token,
  render = captureOpeningComposite,
  connect = connectBot,
  report = () => {},
} = {}) {
  let bot,
    closed = false,
    courseSent = false;
  const attempts = { lobby: 0, course: 0 };
  async function connection() {
    if (!bot) {
      const connected = await connect({
        url,
        token,
        fetchImpl: async (input, options) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          try {
            return await fetch(input, {
              ...options,
              signal: AbortSignal.any([options.signal, controller.signal]),
            });
          } finally {
            clearTimeout(timer);
          }
        },
      });
      if (closed) {
        connected.closeBridge();
        throw new Error("Opening views closed");
      }
      bot = connected;
      bot.on("error", (error) =>
        report(`Opening observation: ${error.message}`),
      );
    }
    return bot;
  }
  function close() {
    closed = true;
    bot?.closeBridge();
    bot = undefined;
  }
  async function capture(host, initial = false) {
    const config = host?.openingViews;
    if (!config || closed || courseSent) return;
    let stage;
    try {
      const current = await connection();
      const position = { ...current.entity.position };
      stage =
        initial &&
        config.lobby &&
        inside(position, config.lobby.bounds) &&
        !inside(position, config.course.entryBounds)
          ? "lobby"
          : "course";
      if (!initial && !inside(position, config.course.entryBounds)) return;
      if (attempts[stage] >= 3) return;
      attempts[stage]++;
      const snapshot = snapshotFromBot(current, {
        bounds: config[stage].bounds,
      });
      if (!snapshot.blocks.length)
        throw new Error("No loaded blocks in opening view");
      const result = await render(snapshot, {
        layout: stage,
        position,
      });
      if (closed) return;
      if (stage === "course") {
        courseSent = true;
        close();
      }
      report(`Opening image ready: ${stage}, ${result.png.length} bytes`);
      return {
        message: `${stage === "lobby" ? "Lobby opening observation" : "Initial course observation"}.\n${JSON.stringify(result.metadata)}`,
        images: [
          {
            type: "image",
            mimeType: "image/png",
            data: result.png.toString("base64"),
          },
        ],
      };
    } catch (error) {
      report(
        `Opening image unavailable${stage ? ` (${stage})` : ""}: ${error.message}`,
      );
      // A failed renderer must not prevent gameplay. Subsequent course checks retry at most three times.
      if (stage === "course" && attempts.course >= 3) close();
      if (initial)
        return {
          message:
            'Opening image unavailable; when needed run node "$ARENA_TOOLKIT_ROOT/examples/observe-and-render.mjs" [minX minY minZ maxX maxY maxZ] and read the printed imagePath.',
        };
    }
  }
  return { capture, close };
}
