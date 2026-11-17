// A map tile worker: builds the map's tiles for the render thread, as MapLibre GL JS builds them in its Web
// Workers (map-print's `source::tile_worker`, through map-web's WebTileWorker). The render thread sends a
// tile's features as bytes; this worker lays the tile out (fills, lines, labels and their glyphs) and sends
// its buckets back as bytes, the buffer transferred. One message in, one answer out, in order.
//
//   { kind: "init", module, names, fonts }   the engine's compiled module and fonts (once)
//   { kind: "msg", bytes }                   a message for the worker
//   -> { kind: "answer", bytes }             its answer
import init, { WebTileWorker } from "../pkg/map_web.js";

let worker = null;
let ready = null;
const waiting = [];

function handle(bytes) {
  const answer = worker.handle(bytes);
  self.postMessage({ kind: "answer", bytes: answer }, [answer.buffer]);
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.kind === "init") {
    if (m.remotelog) import("./remote-log.js").then((r) => r.startRemoteLog("tile"));
    ready = init({ module_or_path: m.module }).then(() => {
      worker = new WebTileWorker(m.names, m.fonts);
      // what came while the module started, in order
      for (const bytes of waiting.splice(0)) handle(bytes);
    });
    ready.catch((err) => self.postMessage({ kind: "init-failed", error: String(err?.message ?? err) }));
    return;
  }
  if (m.kind === "msg") {
    if (!worker) waiting.push(m.bytes);
    else handle(m.bytes);
  }
};
