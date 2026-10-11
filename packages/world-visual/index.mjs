/** Arena-specific opening layout. Generic capture/rendering lives in the MIT world-memory package. */
import {
  renderMinimap,
  renderOblique,
  normalizeSnapshot,
  validateImageDimensions,
  encodePNG,
} from "mineflayer-world-memory/live.mjs";
export * from "mineflayer-world-memory/live.mjs";

// Only the collage background belongs here; generic voxel rasterization is upstream.
function raster(width, height, bg) {
  validateImageDimensions(width, height);
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bg[0];
    data[i + 1] = bg[1];
    data[i + 2] = bg[2];
    data[i + 3] = 255;
  }
  return { data };
}

/** One snapshot, aspect-preserving panels. Panel coordinates refer to the final PNG. */
export function renderOpeningComposite(
  snapshot,
  { layout = "lobby", width = 1024, height = width, gap = 8, position } = {},
) {
  validateImageDimensions(width, height);
  if (!["lobby", "course"].includes(layout))
    throw new TypeError("layout must be lobby or course");
  if (!Number.isSafeInteger(gap) || gap < 0)
    throw new TypeError("gap must be a nonnegative integer");
  const start = performance.now(),
    norm = normalizeSnapshot(snapshot);
  const left = Math.floor((width - gap) / 2),
    right = width - gap - left;
  let specs;
  if (layout === "lobby") {
    const mapWidth = Math.floor((width - gap) * 0.68),
      contextWidth = width - gap - mapWidth;
    const upper = Math.floor((height - gap) / 2),
      lower = height - gap - upper;
    specs = [
      {
        kind: "minimap",
        horizontalAxis: norm.size.x <= norm.size.z ? "x" : "z",
        x: 0,
        y: 0,
        width: mapWidth,
        height,
      },
      ...["+x+z", "-x-z"].map((viewDirection, i) => ({
        kind: "oblique",
        viewDirection,
        x: mapWidth + gap,
        y: i ? upper + gap : 0,
        width: contextWidth,
        height: i ? lower : upper,
      })),
    ];
  } else {
    // Keep the long world axis horizontal without stretching its blocks.
    const horizontalAxis = norm.size.x >= norm.size.z ? "x" : "z";
    const ratio =
      Math.min(norm.size.x, norm.size.z) / Math.max(norm.size.x, norm.size.z);
    const strip = Math.min(
      Math.floor((height - gap) / 2),
      Math.max(1, Math.round(width * ratio)),
    );
    const upper = Math.floor((height - strip - gap * 2) / 2);
    const lower = height - strip - gap * 2 - upper;
    specs = [
      { kind: "minimap", horizontalAxis, x: 0, y: 0, width, height: strip },
      ...["+x+z", "-x-z"].map((viewDirection, i) => ({
        kind: "oblique",
        viewDirection,
        x: 0,
        y: strip + gap + (i ? upper + gap : 0),
        width,
        height: i ? lower : upper,
      })),
    ];
  }
  if (specs.some((p) => p.width < 1 || p.height < 1))
    throw new RangeError("composite dimensions too small for panels and gap");
  const r = raster(width, height, [18, 24, 34]);
  const panels = specs.map((panel, index) => {
    const result = (panel.kind === "minimap" ? renderMinimap : renderOblique)(
      snapshot,
      panel,
    );
    for (let y = 0; y < panel.height; y++)
      result.rgba.copy(
        r.data,
        ((panel.y + y) * width + panel.x) * 4,
        y * panel.width * 4,
        (y + 1) * panel.width * 4,
      );
    return {
      index,
      rect: {
        x: panel.x,
        y: panel.y,
        width: panel.width,
        height: panel.height,
      },
      ...result.metadata,
    };
  });
  const common = [
    "schemaVersion",
    "source",
    "sampledAt",
    "sequence",
    "epoch",
    "version",
    "dimension",
    "acquiredAt",
    "observedAtRange",
    "staleVoxels",
    "knownVoxels",
    "totalVoxels",
    "knownFraction",
    "textures",
    "legend",
    "unknownIsAir",
    "presentation",
  ];
  const meta = Object.fromEntries(common.map((key) => [key, panels[0][key]]));
  Object.assign(meta, {
    kind: "opening-world-composite",
    width,
    height,
    bounds: norm.bounds,
    boundsInclusive: true,
    renderedAt: new Date().toISOString(),
    renderMs: Math.round((performance.now() - start) * 100) / 100,
  });
  Object.assign(meta, { layout, gap, panels, position: position ?? null });
  return {
    png: encodePNG(width, height, r.data),
    metadata: meta,
    rgba: r.data,
  };
}
