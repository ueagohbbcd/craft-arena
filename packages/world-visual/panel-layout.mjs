/**
 * Pure layout helpers for stitched screenshots (gl-render.mjs): the crop of a
 * render around what it shows, one aspect ratio shared by all panels of an
 * image, the panel size for a pixel budget, and the corner legend.
 */

/** Panels are never narrower or wider than this (width / height). */
export const ASPECT_RANGE = Object.freeze([0.5, 2.5]);

/** The content box with a margin of 2% of the render width, or null. */
export function paddedBox(box, W) {
  if (!box) return null;
  const pad = Math.round(W * 0.02);
  return {
    x0: box.x0 - pad,
    y0: box.y0 - pad,
    x1: box.x1 + pad,
    y1: box.y1 + pad,
  };
}

/**
 * One aspect ratio for every panel of an image: the geometric mean of what
 * the views show (so a tall view and a wide one meet in between), kept inside
 * ASPECT_RANGE. `fallback` when no view shows anything.
 */
export function sharedAspect(boxes, fallback) {
  const ratios = boxes
    .filter(Boolean)
    .map((b) => (b.x1 - b.x0) / Math.max(1, b.y1 - b.y0));
  if (!ratios.length) return fallback;
  const mean = Math.exp(
    ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length,
  );
  const [lo, hi] = ASPECT_RANGE;
  return Math.min(Math.max(mean, lo), hi);
}

/** The panel width and height with `aspect` and about `area` pixels. */
export function panelSize(area, aspect) {
  const width = Math.max(1, Math.round(Math.sqrt(area * aspect)));
  return { width, height: Math.max(1, Math.round(width / aspect)) };
}

/**
 * The part of a W×H render around `box` (already padded) with `aspect`,
 * centred on the box and kept inside the render.
 */
export function cropFor(box, W, H, aspect) {
  if (!box) return { x: 0, y: 0, w: W, h: H };
  let w = box.x1 - box.x0,
    h = box.y1 - box.y0;
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  if (w > W) [w, h] = [W, W / aspect];
  if (h > H) [w, h] = [H * aspect, H];
  const cx = (box.x0 + box.x1) / 2,
    cy = (box.y0 + box.y1) / 2;
  return {
    x: Math.min(Math.max(cx - w / 2, 0), W - w),
    y: Math.min(Math.max(cy - h / 2, 0), H - h),
    w,
    h,
  };
}

/**
 * Legend entries for the marks of one panel that carry `legend`: one line
 * per label with its colour and how many of them the panel shows, in order of
 * first appearance.
 */
export function legendOf(marks) {
  const lines = new Map();
  for (const m of marks)
    if (m.legend && m.label) {
      const line = lines.get(m.label);
      if (line) line.count++;
      else lines.set(m.label, { label: m.label, color: m.color, count: 1 });
    }
  return [...lines.values()];
}
