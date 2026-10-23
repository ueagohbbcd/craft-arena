/**
 * Camera geometry of the Prismarine viewer screenshots: world point → pixel,
 * pixel → ray, a ray through known blocks, and the point nearest several rays.
 * The viewer puts its eye 1.6 above `camera.position`, looks along -Z of a
 * three.js camera rotated (pitch, yaw, 0, 'ZYX'), with a vertical fov of 75°.
 */

const airNames = new Set(["air", "cave_air", "void_air"]);
export const isAir = (name) =>
  airNames.has(String(name).replace(/^minecraft:/, ""));

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const unit = (a) => scale(a, 1 / Math.hypot(a.x, a.y, a.z));

/** Eye position and the camera's right, up and forward axes in world space. */
export function cameraBasis({ position, yaw, pitch, fov = 75 }) {
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw),
    cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  return {
    eye: { x: position.x, y: position.y + 1.6, z: position.z },
    right: { x: cy, y: 0, z: -sy },
    up: { x: sy * sp, y: cp, z: cy * sp },
    forward: { x: -sy * cp, y: sp, z: -cy * cp },
    tanY: Math.tan((fov * Math.PI) / 360),
  };
}

/** Pixel of a world point in a `width`×`height` view, or null when behind the camera. */
export function projectPoint(camera, width, height, point) {
  const b = cameraBasis(camera);
  const v = sub(point, b.eye);
  const depth = dot(v, b.forward);
  if (depth <= 0.1) return null;
  const tanX = (b.tanY * width) / height;
  const nx = dot(v, b.right) / depth / tanX,
    ny = dot(v, b.up) / depth / b.tanY;
  return {
    x: ((nx + 1) / 2) * width,
    y: ((1 - ny) / 2) * height,
    depth,
  };
}

/** The ray through pixel (px, py) of a `width`×`height` view: `{origin, direction}`. */
export function pixelRay(camera, width, height, px, py) {
  const b = cameraBasis(camera);
  const tanX = (b.tanY * width) / height;
  const nx = (2 * px) / width - 1,
    ny = 1 - (2 * py) / height;
  return {
    origin: b.eye,
    direction: unit(
      add(b.forward, add(scale(b.right, nx * tanX), scale(b.up, ny * b.tanY))),
    ),
  };
}

const faceNames = {
  "1,0,0": "east",
  "-1,0,0": "west",
  "0,1,0": "top",
  "0,-1,0": "bottom",
  "0,0,1": "south",
  "0,0,-1": "north",
};

/**
 * Walk a ray cell by cell through `bounds` and return the first cell that
 * `solidAt(x, y, z)` accepts: `{cell, face, normal, distance, crossedUnknown}`,
 * or `{cell: null}` when it leaves the box. `solidAt` returns true for a hit,
 * false for empty, and null for a cell nobody has seen. A hit is a solid
 * cell entered from a cell that is not solid; with `startSolid` the ray
 * starts as if inside solid ground, so it passes through the solid cells at
 * the box edge (pictures without cut faces) and hits the first wall it sees
 * from open space.
 */
export function raycastCells(
  { origin, direction },
  bounds,
  solidAt,
  { startSolid = false } = {},
) {
  // Clip the ray to the box (slab method), so a camera outside still works.
  let t0 = 0,
    t1 = Infinity,
    enterAxis = null;
  for (const a of ["x", "y", "z"]) {
    const lo = bounds.min[a],
      hi = bounds.max[a] + 1;
    if (Math.abs(direction[a]) < 1e-12) {
      if (origin[a] < lo || origin[a] > hi) return { cell: null };
      continue;
    }
    let ta = (lo - origin[a]) / direction[a],
      tb = (hi - origin[a]) / direction[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) [t0, enterAxis] = [ta, a];
    t1 = Math.min(t1, tb);
  }
  if (t0 > t1) return { cell: null };
  const start = add(origin, scale(direction, t0 + 1e-9));
  const cell = {
    x: Math.min(Math.floor(start.x), bounds.max.x),
    y: Math.min(Math.floor(start.y), bounds.max.y),
    z: Math.min(Math.floor(start.z), bounds.max.z),
  };
  const step = {},
    next = {},
    delta = {};
  for (const a of ["x", "y", "z"]) {
    step[a] = direction[a] > 0 ? 1 : -1;
    delta[a] = Math.abs(1 / direction[a]);
    const boundary = direction[a] > 0 ? cell[a] + 1 : cell[a];
    next[a] =
      direction[a] === 0 ? Infinity : t0 + (boundary - start[a]) / direction[a];
  }
  let axis = enterAxis,
    t = t0,
    crossedUnknown = false,
    previousSolid = startSolid;
  const inside = (c) =>
    ["x", "y", "z"].every(
      (a) => c[a] >= bounds.min[a] && c[a] <= bounds.max[a],
    );
  while (inside(cell) && t <= t1 + 1e-9) {
    const solid = solidAt(cell.x, cell.y, cell.z);
    if (solid === true && !previousSolid) {
      const normal = { x: 0, y: 0, z: 0 };
      if (axis) normal[axis] = -step[axis];
      return {
        cell: { ...cell },
        normal,
        face: axis ? faceNames[`${normal.x},${normal.y},${normal.z}`] : null,
        distance: t,
        crossedUnknown,
      };
    }
    if (solid == null) crossedUnknown = true;
    previousSolid = solid === true;
    axis =
      next.x < next.y
        ? next.x < next.z
          ? "x"
          : "z"
        : next.y < next.z
          ? "y"
          : "z";
    t = next[axis];
    next[axis] += delta[axis];
    cell[axis] += step[axis];
  }
  return { cell: null, crossedUnknown };
}

/**
 * The point nearest to every ray (least squares over the lines), with each
 * ray's distance from it. Rays that never meet still give their closest
 * point; `spread` says how far apart they pass. Needs two rays that are not
 * parallel.
 */
export function nearestPointToRays(rays) {
  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const b = [0, 0, 0];
  for (const { origin, direction: d } of rays) {
    const dv = [d.x, d.y, d.z],
      o = [origin.x, origin.y, origin.z];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const m = (i === j ? 1 : 0) - dv[i] * dv[j];
        A[i][j] += m;
        b[i] += m * o[j];
      }
  }
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-6) return null;
  const solve = (k) =>
    det(A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / D;
  const point = { x: solve(0), y: solve(1), z: solve(2) };
  const distances = rays.map(({ origin, direction }) => {
    const v = sub(point, origin);
    return Math.hypot(
      ...Object.values(sub(v, scale(direction, dot(v, direction)))),
    );
  });
  return { point, distances, spread: Math.max(...distances) };
}
