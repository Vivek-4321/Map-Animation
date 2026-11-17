// The map worker: paints the live preview's map on a GPU device of its own (map-web's WebMapWorker), so the
// render thread never paints it. The render thread sends it the map's tiles as they land and its paints;
// each picture goes back as an ImageBitmap of this worker's canvas, which the render thread copies into the
// texture its frames drape (a copy on the GPU). Exports and stills still paint on the render thread.
//
//   { kind: "init", module, names, fonts, port }   the engine's compiled module, its fonts, and the port
//                                                  the render thread talks on (once)
//   on the port: { rows }                          [kind, path, bytes] rows (WebEngine::take_remote_print_out)
//   -> on the port: { painted, meshes, bitmap, ms }  a picture (painted: what it is; meshes: its building
//                                                  meshes not sent before), and the paint's time
//   -> { kind: "ready" } | { kind: "failed", error }
import init, { WebMapWorker } from "../pkg/map_web.js";

let worker = null;
let canvas = null;
let port = null;
let remotelog = false;
let pictures = 0;

/** TEMPORARY: a picture's mean colour and how much of it is transparent or black, to the server's log. */
function probe(bitmap) {
  try {
    const c = new OffscreenCanvas(32, 32).getContext("2d");
    c.drawImage(bitmap, 0, 0, 32, 32);
    const px = c.getImageData(0, 0, 32, 32).data;
    let [r, g, b, a, clear, black] = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < px.length; i += 4) {
      r += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3];
      if (px[i + 3] === 0) clear++;
      else if (px[i] + px[i + 1] + px[i + 2] < 30) black++;
    }
    const n = px.length / 4;
    console.info(`[picture ${pictures}] ${bitmap.width}x${bitmap.height} mean rgba ${[r, g, b, a].map((v) => (v / n).toFixed(0)).join(",")} transparent ${((100 * clear) / n).toFixed(0)}% black ${((100 * black) / n).toFixed(0)}%`);
  } catch (err) {
    console.warn(`[picture ${pictures}] probe failed: ${err?.message ?? err}`);
  }
}
const waiting = [];

function handle(rows) {
  for (const [kind, path, bytes] of rows) {
    if (kind === "printed") worker.printed(path, bytes);
    else if (kind === "forget") worker.forget(path);
    else if (kind === "paint") paint(bytes);
  }
}

function paint(bytes) {
  const t0 = performance.now();
  let painted;
  try {
    painted = worker.paint(bytes);
  } catch (err) {
    console.warn(`map worker: ${err?.message ?? err}`);
    painted = null;
  }
  // (nothing painted: the render thread hears so, and its next paint goes out)
  if (!painted) return port.postMessage({ painted: null, bitmap: null, ms: performance.now() - t0 });
  const meshes = worker.take_meshes();
  const bitmap = canvas.transferToImageBitmap();
  // TEMPORARY (Safari black-map diagnosis): the first pictures' pixels, coarsely
  if (remotelog && (pictures += 1) <= 3) probe(bitmap);
  const transfer = [bitmap, painted.buffer];
  if (meshes) transfer.push(meshes.buffer);
  port.postMessage({ painted, meshes, bitmap, ms: performance.now() - t0 }, transfer);
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.kind !== "init") return;
  port = m.port;
  remotelog = !!m.remotelog;
  if (remotelog) (await import("./remote-log.js")).startRemoteLog("map");
  port.onmessage = (ev) => {
    if (!worker) waiting.push(ev.data.rows);
    else handle(ev.data.rows);
  };
  try {
    await init({ module_or_path: m.module });
    canvas = new OffscreenCanvas(1, 1);
    worker = await WebMapWorker.create(canvas, m.names, m.fonts);
    // what came while the module and device started, in order
    for (const rows of waiting.splice(0)) handle(rows);
    self.postMessage({ kind: "ready" });
  } catch (err) {
    self.postMessage({ kind: "failed", error: String(err?.message ?? err) });
  }
};
