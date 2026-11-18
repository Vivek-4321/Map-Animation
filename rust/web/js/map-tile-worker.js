// A map tile worker: builds the map's tiles for the render thread, as MapLibre GL JS builds them in its Web
// Workers (map-print's `source::tile_worker`, through map-web's WebTileWorker). The render thread sends a
// tile's features as bytes; this worker lays the tile out (fills, lines, labels and their glyphs) and sends
// its buckets back as bytes, the buffer transferred. One message in, one answer out, in order.
//
//   { kind: "init", module, names, fonts }   the engine's compiled module and fonts (once)
//   { kind: "msg", bytes }                   a message for the worker
//   -> { kind: "answer", bytes }             its answer
//   { kind: "port", port }                   another sender's port (the street map's tiles): its messages
//                                            there, answered there, by a TileWorker of its own (a sender's
//                                            style and waiting tiles are its own)
import init, { WebTileWorker, timeline_set, timeline_lane, timeline_now_us, timeline_take } from "../pkg/map_web.js";
import { setTimeline, takeTimeline, jsSpan, nowUs } from "./run-timeline.js";

const TIMELINE_WASM = { timeline_set, timeline_lane, timeline_now_us, timeline_take };

let worker = null;
let ready = null;
const waiting = [];
let fontsOf = null;

function handle(bytes) {
  const tl = nowUs();
  const answer = worker.handle(bytes);
  jsSpan("tile worker message", tl, { in_bytes: bytes.byteLength, out_bytes: answer.byteLength });
  self.postMessage({ kind: "answer", bytes: answer }, [answer.buffer]);
}

/** Another sender on `port`, with a TileWorker of its own (a new port for the same sender replaces it). */
function takePort(port) {
  const mine = { worker: null, waiting: [] };
  const answer = (bytes) => {
    const tl = nowUs();
    const out = mine.worker.handle(bytes);
    jsSpan("tile worker message (port)", tl, { in_bytes: bytes.byteLength, out_bytes: out.byteLength });
    port.postMessage({ kind: "answer", bytes: out }, [out.buffer]);
  };
  port.onmessage = (e) => {
    if (e.data.kind !== "msg") return;
    if (!mine.worker) mine.waiting.push(e.data.bytes);
    else answer(e.data.bytes);
  };
  const start = () => {
    mine.worker = new WebTileWorker(fontsOf.names, fontsOf.fonts);
    for (const bytes of mine.waiting.splice(0)) answer(bytes);
  };
  if (ready) ready.then(start);
  else self.addEventListener("message", function once(ev) {
    if (ev.data.kind !== "init") return;
    self.removeEventListener("message", once);
    ready.then(start);
  });
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.kind === "port") return void takePort(m.port);
  if (m.kind === "timeline") {
    // (only once the module is in: its functions are the engine's)
    const go = () => {
      setTimeline(m.on, TIMELINE_WASM, "tile worker");
      if (m.take) self.postMessage({ kind: "timeline-out", json: takeTimeline(TIMELINE_WASM, 10 + (m.index || 0), `tile worker ${m.index || 0}`) });
    };
    return void (ready ? ready.then(go, go) : go());
  }
  if (m.kind === "init") {
    fontsOf = { names: m.names, fonts: m.fonts };
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
