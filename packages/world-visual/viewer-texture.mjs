/**
 * node-canvas `loadImage` wrapper for the Prismarine viewer's texture loads.
 *
 * The viewer loads textures asynchronously (`loadTexture` -> `loadImage`) and
 * the callback has no error channel: a missing file is an uncaught rejection
 * that aborts the whole renderer process, not just that mesh. That can happen
 * when a screenshot includes an entity and the participant image does not ship
 * the entity texture layout the viewer asks for, or when a future viewer
 * version moves a texture again.
 *
 * Resolve a missing viewer texture to a 1x1 transparent PNG instead. The mesh
 * then renders with a fully transparent skin (the material uses alphaTest), so
 * one missing asset costs that entity, not the picture. Each missing source is
 * reported once so the image can be fixed without flooding the render log.
 */
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTextureLoader({
  loadImage,
  createCanvas,
  fallbackPath = join(tmpdir(), "arena-missing-viewer-texture.png"),
  warn = (line) => console.error(line),
} = {}) {
  if (!existsSync(fallbackPath)) {
    const canvas = createCanvas(1, 1);
    writeFileSync(fallbackPath, canvas.toBuffer("image/png"));
  }
  const warned = new Set();
  return async function loadViewerTexture(source, ...rest) {
    try {
      return await loadImage(source, ...rest);
    } catch {
      if (!warned.has(source)) {
        warned.add(source);
        warn(
          `screenshot: missing viewer texture ${source}; using a transparent placeholder`,
        );
      }
      return await loadImage(fallbackPath);
    }
  };
}
