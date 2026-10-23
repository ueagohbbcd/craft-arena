/**
 * Renders a screenshot job with the Prismarine viewer in Node, on headless-gl
 * (WebGL 1 through ANGLE, which needs an X display: prismarine.mjs starts this
 * file under xvfb-run when DISPLAY is not set). Usage: node gl-render.mjs
 * JOB.json. The job is written by prismarine.mjs (renderJob): the scenes'
 * chunk columns and entities, and each view's camera, clip box, label and
 * marks. Writes the stitched PNG (or one raw view) and prints
 * `{crops, filled}` as JSON.
 */
import Module, { createRequire } from "node:module";
import { writeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";

const require = createRequire(import.meta.url);
const { createCanvas, loadImage, Canvas, Image } = require("canvas");
const createGLContext = require("gl");

// The viewer loads its textures with `require("node-canvas-webgl/lib").loadImage`;
// node-canvas has the same function, so answer that require with it.
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "node-canvas-webgl/lib") return { loadImage };
  return load.call(this, request, ...rest);
};

/** A canvas-like object for three.js, drawing into a headless-gl context. */
function glCanvas(width, height) {
  const gl = createGLContext(width, height, {
    antialias: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error("headless-gl could not create a WebGL context");
  // headless-gl takes pixels from a canvas, not from an image.
  const texImage2D = gl.texImage2D;
  gl.texImage2D = function (...args) {
    const source = args.at(-1);
    if (source instanceof Image) {
      const c = new Canvas(source.width, source.height);
      c.getContext("2d").drawImage(source, 0, 0);
      args[args.length - 1] = c;
    }
    return texImage2D.apply(this, args);
  };
  const canvas = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    getContext: () => gl,
    addEventListener() {},
    removeEventListener() {},
  };
  gl.canvas = canvas;
  return { canvas, gl };
}

/** RGBA rows of the drawing buffer, top row first. */
function readRGBA(gl, width, height) {
  const flipped = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
  const out = new Uint8ClampedArray(flipped.length);
  const row = width * 4;
  for (let y = 0; y < height; y++)
    out.set(
      flipped.subarray((height - 1 - y) * row, (height - y) * row),
      y * row,
    );
  return out;
}

// The viewer's sky colour (lightblue) is "nothing here".
const isSky = (d, i) =>
  Math.abs(d[i] - 173) < 8 &&
  Math.abs(d[i + 1] - 216) < 8 &&
  Math.abs(d[i + 2] - 230) < 8;

function contentBox(d, W, H) {
  let x0 = W,
    y0 = H,
    x1 = -1,
    y1 = -1;
  for (let py = 0; py < H; py++)
    for (let px = 0; px < W; px++)
      if (!isSky(d, (py * W + px) * 4)) {
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Grow the content box to the cell's shape, with a small margin, inside the render. */
function cropFor(box, W, H, aspect) {
  if (!box) return { x: 0, y: 0, w: W, h: H };
  const pad = Math.round(W * 0.02);
  let w = box.x1 - box.x0 + 2 * pad,
    h = box.y1 - box.y0 + 2 * pad;
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
 * Darken the block edges on the block faces of `material`: where a fragment
 * lies on a whole-block plane (a full block's face) and within about a pixel
 * of another whole-block line. Faces off those planes, such as slab tops,
 * plants and torches, get no lines.
 */
function drawGrid(material) {
  material.extensions = { derivatives: true };
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "varying vec3 vGridPos;\nvoid main() {")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvGridPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "varying vec3 vGridPos;\nvoid main() {")
      .replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
        {
          // In a block of its own: the clipping chunk has a \`plane\` too.
          vec3 gridOff = abs(fract(vGridPos + 0.5) - 0.5);
          vec3 gridPx = gridOff / max(fwidth(vGridPos), 1e-6);
          // The face's own axis is the one nearest a whole block (in blocks;
          // in pixels it is noise where the face is flat). The nearer of the
          // other two is the distance to the nearest edge, in pixels.
          float edge = gridOff.x <= min(gridOff.y, gridOff.z)
            ? min(gridPx.y, gridPx.z)
            : gridOff.y <= gridOff.z
              ? min(gridPx.x, gridPx.z)
              : min(gridPx.x, gridPx.y);
          if (min(gridOff.x, min(gridOff.y, gridOff.z)) < 0.002)
            gl_FragColor.rgb *= mix(0.55, 1.0, smoothstep(0.5, 1.5, edge));
        }`,
      );
  };
}

async function waitFor(check, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function main() {
  const job = JSON.parse(await readFile(process.argv[2], "utf8"));
  const { renderWidth: RW, renderHeight: RH } = job;
  const THREE = require("three");
  globalThis.THREE = THREE;
  globalThis.Worker = Worker;
  const { Viewer } = require("prismarine-viewer/viewer");
  const { canvas, gl } = glCanvas(RW, RH);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  const renders = [];
  for (const [s, scene] of job.scenes.entries()) {
    const viewer = new Viewer(renderer);
    viewer.setVersion(job.renderVersion);
    if (scene.grid) drawGrid(viewer.world.material);
    // The viewer's own wait (waitForChunksToRender) ends at the first answer
    // for a section that was marked twice (once before its column reached
    // the worker), while the second is still queued. Wait instead until
    // that set is empty and the workers have been quiet for a few of their
    // 50 ms meshing rounds.
    let lastAnswer = Date.now();
    for (const worker of viewer.world.workers)
      worker.on("message", () => (lastAnswer = Date.now()));
    // The scene is moved up or down by `dy` so its blocks lie in y 0..255,
    // the only heights the viewer meshes; the camera and clip box move with it.
    const dy = scene.dy ?? 0;
    for (const c of scene.columns) viewer.addColumn(c.x, c.z, c.chunk);
    for (const e of scene.entities)
      viewer.updateEntity({ ...e, pos: { ...e.pos, y: e.pos.y + dy } });
    await waitFor(
      () => viewer.world.material.map?.image,
      job.timeoutMs,
      "block textures",
    );
    await waitFor(
      () =>
        viewer.world.sectionsOutstanding.size === 0 &&
        Date.now() - lastAnswer > 250,
      job.timeoutMs,
      "block meshes",
    );
    // Entity skins load on their own, without a signal.
    if (scene.entities.length) await new Promise((r) => setTimeout(r, 300));
    // updateEntity moves and turns the models with 50 ms tweens, which only
    // a render loop would advance: finish them here.
    viewer.update();
    for (const view of job.views.filter((v) => v.scene === s)) {
      const { position, yaw, pitch } = view.camera;
      viewer.camera.position.set(position.x, position.y + 1.6 + dy, position.z);
      viewer.camera.rotation.set(pitch, yaw, 0, "ZYX");
      viewer.camera.aspect = RW / RH;
      viewer.camera.updateProjectionMatrix();
      // Clip everything outside `clip` ({min, max, faces}): blocks just
      // outside the box hide the faces it cuts where they would be hidden in
      // the game, and the planes hide those blocks themselves. With faces
      // "open" the planes sit just inside the box, so no face on its edge is
      // drawn; with "game" just outside, so the edge faces stay where the
      // outer block is not opaque. The outer blocks' own faces on the edge
      // look into the box, away from the camera, and are culled as back faces.
      const box = view.clip && {
        ...view.clip,
        min: { ...view.clip.min, y: view.clip.min.y + dy },
        max: { ...view.clip.max, y: view.clip.max.y + dy },
      };
      const e = box?.faces === "game" ? -0.001 : 0.001;
      renderer.clippingPlanes = box
        ? [
            new THREE.Plane(new THREE.Vector3(1, 0, 0), -box.min.x - e),
            new THREE.Plane(new THREE.Vector3(-1, 0, 0), box.max.x + 1 - e),
            new THREE.Plane(new THREE.Vector3(0, 1, 0), -box.min.y - e),
            new THREE.Plane(new THREE.Vector3(0, -1, 0), box.max.y + 1 - e),
            new THREE.Plane(new THREE.Vector3(0, 0, 1), -box.min.z - e),
            new THREE.Plane(new THREE.Vector3(0, 0, -1), box.max.z + 1 - e),
          ]
        : [];
      renderer.render(viewer.scene, viewer.camera);
      // three.js only logs a shader that does not compile and draws nothing.
      const broken = renderer.info.programs.find(
        (p) => p.diagnostics && !p.diagnostics.runnable,
      );
      if (broken)
        throw new Error(
          `A shader did not compile: ${broken.diagnostics.fragmentShader.log || broken.diagnostics.vertexShader.log || broken.diagnostics.programLog}`,
        );
      renders[job.views.indexOf(view)] = readRGBA(gl, RW, RH);
    }
    for (const worker of viewer.world.workers) await worker.terminate();
    viewer.resetAll();
  }

  const image = (rgba) => {
    const c = createCanvas(RW, RH);
    c.getContext("2d").putImageData(
      new (require("canvas").ImageData)(rgba, RW, RH),
      0,
      0,
    );
    return c;
  };
  if (job.raw) {
    await writeFile(job.outputPath, image(renders[0]).toBuffer("image/png"));
    return { crops: [{ x: 0, y: 0, w: RW, h: RH }], filled: null };
  }

  const { width, height, columns, rows } = job;
  const out = createCanvas(width * columns, height * rows);
  const ctx = out.getContext("2d");
  const tag = (
    text,
    x,
    y,
    { color = "#fff", bg = "rgba(0,0,0,0.65)", size = 13 } = {},
  ) => {
    ctx.font = `bold ${size}px sans-serif`;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w + 8, size + 6);
    ctx.fillStyle = color;
    ctx.fillText(text, x + 4, y + size + 1);
  };
  const crops = [];
  const sources = renders.map(image);
  for (const [i, v] of job.views.entries()) {
    const { x, y } = v.viewport;
    const crop = job.cropToContent
      ? cropFor(contentBox(renders[i], RW, RH), RW, RH, width / height)
      : { x: 0, y: 0, w: RW, h: RH };
    crops.push(crop);
    ctx.drawImage(
      sources[i],
      crop.x,
      crop.y,
      crop.w,
      crop.h,
      x,
      y,
      width,
      height,
    );
  }
  // Share of the image that shows something, before marks and labels.
  const d = ctx.getImageData(0, 0, out.width, out.height).data;
  let content = 0;
  for (let i = 0; i < d.length; i += 4) if (!isSky(d, i)) content++;
  for (const [i, v] of job.views.entries()) {
    const { x, y } = v.viewport;
    const crop = crops[i];
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    for (const m of v.marks) {
      const px = x + ((m.x - crop.x) * width) / crop.w,
        py = y + ((m.y - crop.y) * height) / crop.h;
      if (m.dot !== false) {
        ctx.beginPath();
        ctx.arc(px, py, m.dot === "small" ? 2.5 : 5, 0, Math.PI * 2);
        ctx.fillStyle = m.color ?? "#e33";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
      }
      if (m.label)
        tag(m.label, px + 6, py - 9, {
          size: m.size ?? 13,
          color: m.textColor ?? "#fff",
          bg: m.bg ?? "rgba(0,0,0,0.65)",
        });
    }
    ctx.restore();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, width - 2, height - 2);
    if (job.views.length > 1)
      tag(v.label, x + 6, y + height - 30, { size: 16 });
  }
  await writeFile(job.outputPath, out.toBuffer("image/png"));
  return { crops, filled: content / (out.width * out.height) };
}

// Written synchronously: output to a pipe is otherwise lost at process.exit
// (which ends the viewer's worker threads).
main().then(
  (result) => {
    writeSync(1, `${JSON.stringify(result)}\n`);
    process.exit(0);
  },
  (error) => {
    writeSync(2, `${error.stack ?? error}\n`);
    process.exit(1);
  },
);
