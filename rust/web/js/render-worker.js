// The render thread: the engine (map-web's WebEngine) on the page's canvas, moved here as an OffscreenCanvas,
// so however long a frame takes, the editor never waits on it. The Android app's shape: the UI thread sends
// commands (a story, a time, a size), this thread draws, and its load workers (loads.js) fetch and decode
// what the engine queues. Frames are drawn when something changed (the time, the story, the size, an
// arrival), paced as the Android preview's PreviewDriver paces them: at most the film's 30 a second, playing or
// not; arrivals land between frames and each landing is drawn on the next beat, with a couple of frames
// after it; while the frame is still changing by itself (a tile fading in, detail coming back after a move)
// it is drawn on the beat until it is done; a moment still waiting for loads is drawn again slowly.
import init, { WebEngine, WebFiles, last_panic, startup_files, multdev_story, trail_story, travelboast_story, showcase_catalog, showcase_story, export_frames, source_max_age_s, preview_scale_rules } from "../pkg/map_web.js";
import { LoadPool, compile, sourceUrl } from "./loads.js";
import { remoteLog, startRemoteLog } from "./remote-log.js";
import { Muxer, ArrayBufferTarget, StreamTarget } from "../vendor/mp4-muxer.mjs";

/** the preview's beat: a frame at most this often (ms), whatever asked for it (playing, a gesture, a
 * landing, a change to the story): the film's own 30 a second */
const FRAME_GAP = 1000 / 30;
/** a frame still waiting for loads is drawn again this often (ms): PreviewDriver's buffering cadence */
const BUFFER_GAP = 100;
/** while playing, a frame with more map tiles than this still to come is behind the film: the rest of
 * that play-through is drawn as drafts (the scrub's: half size, the coarser tiles that come quickly) */
const PLAY_BEHIND_TILES = 16;
/** ...once it has been behind this long (ms): tiles coming from the cache catch up within it */
const PLAY_BEHIND_MS = 1000;
/** A CPU job's answer (a street map tile made ready on a worker, megabytes) takes 10-30 ms to land here:
 * landed as it came, two at once dropped a frame. So answers wait (`landCpu`) and land between frames,
 * each only if it can be done, by its size (`CPU_LAND_MS_PER_MB`, measured in Chrome on an M1), before the
 * next frame is due (less `CPU_LAND_MARGIN_MS`). One kept waiting `CPU_LAND_WAIT_MS` lands anyway. */
const CPU_LAND_MS_PER_MB = 8;
/** ...at the least: this device's own, the upper quarter of its last `CPU_LAND_SEEN` landings of an answer of
 * `CPU_LAND_SEEN_MB` or more (a phone's can be several times an M1's) */
const CPU_LAND_SEEN = 24;
const CPU_LAND_SEEN_MB = 0.25;
const CPU_LAND_MARGIN_MS = 4;
const CPU_LAND_WAIT_MS = 250;
/** frames drawn after a landing (PreviewDriver's settle frames) */
const SETTLE_FRAMES = 2;
/** a gesture's end waits this long before the view is drawn still (PreviewDriver's SHARPEN_DELAY_MS): a
 * finger that comes straight back down, or the next wheel notch, keeps the gesture going */
const SHARPEN_MS = 200;
/** what the page hears: the clock and the loads, at most this often (ms), and the diagnostics */
const STATUS_GAP = 50;
const DIAG_GAP = 1000;
/** each file the engine starts with may take this long, body and all (ms): one that hangs is done without */
const STARTUP_DEADLINE_MS = 20_000;
/** the preview's clock stops this far (s) before the film's end: at the end itself the story is over (each
 * shot and item lasts until it, not through it, so the camera fell back to the plain map, its labels gone),
 * and a video's frames stop before it too, its last at 30 fps a 30th of a second earlier */
const END_GAP_S = 1 / 30;
/** play with less than this (s) of the film left starts it over: a few frames and a stop read as nothing */
const RESTART_S = 0.5;

const raf = self.requestAnimationFrame ? (f) => self.requestAnimationFrame(f) : (f) => setTimeout(() => f(performance.now()), 8);

const st = {
  // the film's story as last loaded (put back after a showcase), the showcase being shown (where the film
  // was), and the stretch it loops
  film: null,
  showcase: null,
  loop: null,
  engine: null,
  canvas: null,
  pool: null,
  t: 0,
  playing: false,
  // the map worker (`startMapWorker`) once it is ready, and whether the preview's map is painted there
  mapWorker: null,
  mapWorkerOn: true,
  // the governor's render scale as drawn (`applyScale`), when it last changed, and its rules
  // (`preview_scale_rules`: the lowest scale, ms a scale holds)
  scale: 1,
  scaleAt: 0,
  scaleRules: [0.6, 2000],
  duration: 0,
  loaded: false,
  dirty: true,
  arrived: false,
  failed: null,
  dead: false,
  scrubbing: false,
  draftOn: true,
  drafting: false,
  playDraft: false, // this play-through fell behind its loads: drawn as drafts until it stops
  behindSince: 0, // when the playing frames last fell behind (0: they aren't)
  last: 0,
  lastDraw: 0,
  landed: false, // something landed (or an answer came that lands in the frame) since the last draw
  settle: 0,
  transitioning: false, // the last frame drawn was still changing by itself (the engine says)
  looks: [], // a gesture's cameras: { at (ms since the epoch: the page's frame time), cam }, oldest first
  lookShown: null, // the camera the engine was last told to look with
  lastPending: 0,
  moving: false, // the view is moved by hand, as the engine was told
  sharpen: null, // the timer that tells the engine the gesture ended
  lastStatus: 0,
  frameRevision: 0,
  sentRevision: -1,
  lastDiag: 0,
  diag: "",
  costs: [], // [when, ms] of each drawn frame, the last 240
  cpuSeen: [], // ms a MB of this device's recent landings (`CPU_LAND_SEEN`)
  cpuWaiting: [], // CPU jobs' answers to land between frames (`landCpu`), oldest first, with when they came
  trace: null, // while tracing ("trace" on): one entry a tick (`traceTick`)
  traceAt: 0, // the last traced tick's time
  tickInfo: null, // what this tick met and did, for the trace
  seq: 0, // the page's last clock command, echoed back with the clock
};

const post = (m, transfer) => self.postMessage(m, transfer || []);

/** The world's countries (data/countries-50m.json), fetched once when a Story first lights a country. */
let bordersText = null;
async function worldBorders() {
  if (bordersText === null) {
    const r = await fetch(sourceUrl("data/countries-50m.json"));
    if (!r.ok) throw new Error(`the world's borders could not be loaded (${r.status})`);
    bordersText = await r.text();
  }
  return bordersText;
}

/** the film's last moment, where the preview's clock stops (`END_GAP_S`) */
const filmEnd = () => Math.max(0, st.duration - END_GAP_S);

self.onmessage = async (e) => {
  const m = e.data;
  wake();
  if (m.seq) st.seq = m.seq;
  try {
    switch (m.kind) {
      case "start":
        return await start(m);
      case "multdev-story":
        try {
          post({ kind: m.kind, id: m.id, json: multdev_story(JSON.stringify(m.stops), JSON.stringify(m.meta)) });
        } catch (err) {
          post({ kind: m.kind, id: m.id, error: String(err?.message ?? err) });
        }
        return;
      case "travelboast-story":
        // the Story template's (TravelBoast's) story; with the world's borders when a stop's country lights up
        try {
          const borders = m.borders ? await worldBorders() : "";
          post({ kind: m.kind, id: m.id, json: travelboast_story(JSON.stringify(m.stops), JSON.stringify(m.meta), borders) });
        } catch (err) {
          post({ kind: m.kind, id: m.id, error: String(err?.message ?? err) });
        }
        return;
      case "trail-story":
        // the trail template's story: the path and its settings (map-web's `trail_story`)
        try {
          post({ kind: m.kind, id: m.id, json: trail_story(JSON.stringify(m.path), JSON.stringify(m.meta)) });
        } catch (err) {
          post({ kind: m.kind, id: m.id, error: String(err?.message ?? err) });
        }
        return;
      case "showcase-catalog":
        // the Story template's choices, for the page's pickers (map-web's `showcase_catalog`)
        return post({ kind: m.kind, id: m.id, json: showcase_catalog() });
      case "showcase":
        // One choice's own film (map-web's `showcase_story`), looping in place of the trip's: the trip's is
        // put back by "end-showcase", or by the next load. The engine lets the showcase's models go itself.
        if (st.exporting || st.dead) return post({ kind: m.kind, id: m.id, error: "The engine is busy" });
        try {
          const borders = m.what === "highlight" ? await worldBorders() : "";
          const sc = JSON.parse(showcase_story(m.what, m.key, m.photo || "", borders));
          if (!st.showcase) st.showcase = { t: st.t };
          st.duration = st.engine.load_story(JSON.stringify(sc.story));
          st.loaded = true;
          st.failed = null;
          st.loop = sc.loop;
          st.t = sc.loop[0];
          st.playing = true;
          st.playDraft = false;
          st.behindSince = 0;
          st.last = performance.now();
          st.dirty = true;
          post({ kind: m.kind, id: m.id, duration: st.duration, loop: sc.loop, poster: sc.poster });
        } catch (err) {
          post({ kind: m.kind, id: m.id, error: String(err?.message ?? err) });
        }
        return;
      case "showcase-orbit":
        // a drag turning the showcase's view (degrees of bearing and pitch; 0, 0: its own)
        st.engine?.set_orbit(m.bearing, m.pitch);
        st.dirty = true;
        return;
      case "end-showcase":
        st.engine?.set_orbit(0, 0);
        // the trip's film back where it was, paused
        if (st.showcase && st.film) {
          try {
            st.duration = st.engine.load_story(st.film);
            st.t = Math.min(st.showcase.t, filmEnd());
          } catch (err) {
            st.showcase = null;
            st.loop = null;
            return post({ kind: m.kind, id: m.id, error: String(err?.message ?? err) });
          }
        }
        st.showcase = null;
        st.loop = null;
        st.playing = false;
        st.dirty = true;
        return post({ kind: m.kind, id: m.id, duration: st.duration });
      case "load":
        if (st.exporting) return post({ kind: "load", id: m.id, error: "The film is being rendered; wait for it to finish" });
        if (st.dead) return post({ kind: "load", id: m.id, error: `the engine stopped (${st.failed}); reload the page` });
        try {
          // (a load ends any showcase: this film is the one shown now)
          st.showcase = null;
          st.loop = null;
          st.film = m.json;
          st.duration = st.engine.load_story(m.json);
          st.loaded = true;
          st.failed = null;
          st.t = Math.min(st.t, filmEnd());
          st.dirty = true;
          post({ kind: "load", id: m.id, duration: st.duration });
        } catch (err) {
          post({ kind: "load", id: m.id, error: String(err?.message ?? err) });
        }
        return;
      case "seek":
        if (st.exporting) return;
        if (m.t !== st.t) {
          st.t = Math.max(0, Math.min(filmEnd(), m.t));
          st.dirty = true;
        }
        return;
      case "play":
        if (st.exporting) return;
        if (st.t >= filmEnd() - RESTART_S) st.t = 0;
        st.playing = true;
        // (each play-through starts full: the last one's tiles may all be in by now)
        st.playDraft = false;
        st.behindSince = 0;
        st.last = performance.now();
        return;
      case "map-worker":
        // (the preview's map painted on the map worker, or here: for comparing the two)
        st.mapWorkerOn = !!m.on;
        st.engine?.set_remote_print(st.mapWorkerOn && !!st.mapWorker);
        st.dirty = true;
        return;
      case "pause":
        st.playing = false;
        st.playDraft = false;
        sendStatus(true);
        return;
      case "resize":
        st.previewSize = { w: m.w, h: m.h };
        if (st.exporting) return; // (the export draws at its own size; the preview's comes back after)
        if (st.canvas) sizeCanvas();
        return;
      case "scrub":
        st.scrubbing = m.on;
        st.dirty = true;
        return;
      case "look":
        if (st.exporting) return;
        // the camera an editor looks around with (null: the film's own again); a gesture's, stamped, is
        // coalesced until the next frame (`paceLook`), any other at once
        if (m.cam && m.at != null) {
          // Coalesce input received while a frame or preparation task was busy.
          st.looks = [{ at: m.at, cam: m.cam }];
          return;
        }
        st.looks = [];
        st.lookShown = m.cam || null;
        if (m.cam) st.engine.set_look(...m.cam);
        else st.engine.clear_look();
        st.dirty = true;
        return;
      case "map-input": {
        // a DOM event for MapLibre's gestures (maplibre-gestures.js), on this thread's clock
        if (!st.engine || st.exporting || !st.loaded) return;
        const ev = m.ev;
        st.engine.map_input(ev.type, ev.at - performance.timeOrigin, ev.w, ev.h, ev.x, ev.y, ev.button, ev.buttons,
          ev.mods, ev.inside, ev.dy, ev.mode, ev.key, new Float64Array(ev.touches), new Float64Array(ev.changed));
        st.mapAwake = true;
        return;
      }
      case "moving":
        // the view moved by hand (a pan, a pinch, a wheel): the engine draws lighter, at the same size
        clearTimeout(st.sharpen);
        st.sharpen = null;
        if (m.on) setMoving(true);
        // (a wheel's end is its pause already: one settling delay, not two)
        else if (m.settled) setMoving(false);
        else if (st.moving) st.sharpen = setTimeout(() => ((st.sharpen = null), setMoving(false)), SHARPEN_MS);
        return;
      case "draft":
        st.draftOn = m.on;
        st.dirty = true;
        return;
      case "snapshot":
        return snapshot(m.id);
      case "country-at":
        return post({ kind: "country-at", id: m.id, name: st.engine?.country_at(m.lon, m.lat) ?? null });
      case "country-outline":
        return post({ kind: "country-outline", id: m.id, rings: st.engine ? [...st.engine.country_outline(m.name)] : [] });
      case "nudge":
        // an item dragged on the frame, drawn moved and scaled (empty: let go of it)
        st.engine?.set_nudge(m.nudge || []);
        st.dirty = true;
        return;
      case "country-names":
        return post({ kind: "country-names", id: m.id, names: st.engine?.country_names() ?? [] });
      case "export":
        return await exportFilm(m);
      case "export-cancel":
        st.exportCancel = true;
        // fetches in flight stop now: a step waiting on one gives up at once, and so do the last waits
        st.exportReads?.stop();
        for (const give of finalWaits) give();
        return;
      case "export-forget":
        // a video an export left in the origin's storage, which the page has done with
        if (/^export-\d+\.mp4$/.test(m.name)) await (await self.navigator.storage.getDirectory()).removeEntry(m.name).catch(() => {});
        return;
      case "trace":
        // a per-tick trace of the loop (the page's `Preview.trace`): when each tick ran, what it drew and
        // what that cost, with the engine's own spans of each frame drawn
        st.engine?.set_profiling(m.on);
        st.engine?.take_profile_frame();
        if (m.on) {
          st.trace = [];
          st.traceAnswers = [];
          st.traceAt = 0;
        } else {
          post({ kind: "trace", id: m.id, trace: st.trace || [], answers: st.traceAnswers || [] });
          st.trace = null;
        }
        return;
      case "profile":
        st.engine?.set_profiling(m.on);
        if (!m.on) post({ kind: "profile", id: m.id, spans: st.engine?.take_profile() || "[]" });
        else st.engine?.take_profile();
        return;
    }
  } catch (err) {
    if (err instanceof WebAssembly.RuntimeError || last_panic()) return failed(err);
    post({ kind: "error", message: String(err?.message ?? err), dead: false });
  }
};

/** The engine failed (`err`): a frame that failed stays failed until the story changes; a panic
 * (`unreachable`: the wasm aborted) leaves the engine unusable, and nothing more is asked of it. The page
 * hears it once, and fails what it still waits on when the engine is dead. */
function failed(err) {
  // after a panic every call fails as "recursive use of an object": the panic is what to report
  const panic = last_panic();
  const dead = err instanceof WebAssembly.RuntimeError || !!panic;
  // (where a trap happened: its stack, for a remote console)
  if (dead && !st.dead) console.error(`the engine stopped: ${panic || err?.message}\n${err?.stack || ""}`);
  st.failed = panic || String(err?.message ?? err);
  if (st.dead) return;
  st.dead = dead;
  post({ kind: "error", message: st.failed, dead });
}

/** the faces the editor's films draw with: Inter, and the Story template's place labels (`label_art`) */
const EDITOR_FACES = ["Inter", "Montserrat", "Caveat", "Cinzel", "LuckiestGuy"];

async function start({ canvas, w, h, template, webgl, lowMemory, remotelog, noMapWorker }) {
  // TEMPORARY (Safari black-map diagnosis)
  st.remotelog = !!remotelog;
  LoadPool.remotelog = st.remotelog;
  if (st.remotelog) startRemoteLog("render");
  if (noMapWorker) st.mapWorkerOn = false;
  post({ kind: "status-note", note: "Loading the engine" });
  const module = await compile(new URL("../pkg/map_web_bg.wasm", import.meta.url));
  await init({ module_or_path: module });
  post({ kind: "status-note", note: "Fetching the map's fonts and borders" });
  const files = new WebFiles();
  await Promise.all(
    // This page fixes the theme to Maps: its cards and distances use Inter, a Story's place labels its
    // label faces (EDITOR_FACES). Other editor templates still get the full catalogue.
    startup_files().filter((src) => template !== "multdev" || !src.startsWith("data/fonts/") || EDITOR_FACES.some((f) => src.startsWith(`data/fonts/${f}-`))).map(async (src) => {
      try {
        // (the deadline holds the body too: a fetch's signal aborts its body's reading)
        const r = await fetch(sourceUrl(src), { signal: AbortSignal.timeout(STARTUP_DEADLINE_MS) });
        if (r.ok) files.put(src, new Uint8Array(await r.arrayBuffer()));
      } catch {
        /* the engine does without it */
      }
    }),
  );
  post({ kind: "status-note", note: "Starting the GPU" });
  canvas.width = w;
  canvas.height = h;
  st.canvas = canvas;
  // the size the preview comes back to after an export, until the page sends another
  st.previewSize = { w, h };
  const { mobile, memoryMb } = device();
  // a phone of 4 GB or less keeps to low-memory budgets (its browser is often 32-bit, and grows the
  // page's memory only to a few hundred MB), as the Android app does on one
  const low = !!lowMemory || (mobile && memoryMb > 0 && memoryMb <= 4096);
  st.engine = await WebEngine.create(canvas, files, w, h, mobile, memoryMb, !!webgl, low);
  // which GPU and backend (WebGPU, or Gl: WebGL2) the engine got, for a remote console on a phone
  console.info(`engine on ${st.engine.diagnostics().split("\n")[0]}`);
  if (st.remotelog) {
    remoteLog("render", "[diagnostics]", st.engine.diagnostics(), "| map worker wanted:", st.mapWorkerOn);
    st.probeFrom = performance.now();
    setInterval(probeFrame, 15000);
  }
  st.pool = new LoadPool(module, answer);
  // the workers compress tiles to the store's format (desktop BC7, a phone's ASTC), as Android's do
  st.pool.format = st.engine.tile_format();
  startTileWorkers(module);
  startMapWorker(module);
  // the preview adapts to this device's frame times, as the apps' previews do (`applyScale`)
  st.scaleRules = preview_scale_rules();
  st.engine.start_preview_governor(Math.round(1000 / FRAME_GAP));
  st.last = performance.now();
  wake();
  post({ kind: "ready" });
}

/** The map worker (map-worker.js): paints the preview's map on a GPU device of its own, so this thread never
 * paints it (map-engine's `printed_map::remote`). This thread sends it the map's tiles as they land and its
 * paints after each tick (`flushMapWorker`); each picture comes back as an ImageBitmap, copied into the map's
 * texture on the GPU (`mapPicture`). WebGPU only: on WebGL2 the map is painted here, as before it is ready. */
function startMapWorker(module) {
  if (typeof Worker !== "function" || typeof OffscreenCanvas !== "function") return void (st.remotelog && remoteLog("render", "[map worker] not started: no Worker or OffscreenCanvas"));
  if (!st.engine.diagnostics().split("\n")[0].includes("WebGpu")) return void (st.remotelog && remoteLog("render", "[map worker] not started: the engine is not on WebGPU"));
  const ch = new MessageChannel();
  const w = new Worker(new URL("./map-worker.js", import.meta.url), { type: "module" });
  const rows = Array.from(st.engine.tile_worker_fonts());
  const fonts = rows.map((r) => r[1]);
  w.postMessage({ kind: "init", module, names: rows.map((r) => r[0]), fonts, port: ch.port2, remotelog: st.remotelog }, [ch.port2, ...fonts.map((f) => f.buffer)]);
  w.onmessage = (e) => {
    if (st.remotelog) remoteLog("render", "[map worker] says", e.data.kind, e.data.error ?? "", "| painting there:", st.mapWorkerOn);
    if (e.data.kind === "ready") {
      st.mapWorker = { worker: w, port: ch.port1 };
      if (st.mapWorkerOn) st.engine.set_remote_print(true);
      st.dirty = true;
      wake();
    } else if (e.data.kind === "failed") console.warn(`map worker: ${e.data.error}`);
  };
  ch.port1.onmessage = (e) => mapPicture(e.data);
}

/** The preview's size as drawn: the page's, times the governor's scale (`applyScale`). */
function drawnSize() {
  const p = st.previewSize;
  return { w: Math.max(2, Math.round(p.w * st.scale)), h: Math.max(2, Math.round(p.h * st.scale)) };
}

/** The canvas and the engine at `drawnSize`; the browser shows the canvas at the page's size whatever its
 * pixels (taps and boxes are read as fractions of it). */
function sizeCanvas() {
  const { w, h } = drawnSize();
  if (st.canvas.width !== w || st.canvas.height !== h) {
    st.canvas.width = w;
    st.canvas.height = h;
    st.engine?.resize(w, h);
    st.dirty = true;
  }
}

/** The governor's render scale applied, as the apps' sessions apply it (`map_runtime::session::preview`):
 * never below the lowest scale (map text is unreadable under it), and changed only while the view is still
 * and the last change has held (a resize mid-gesture is a hitch at its start and end). The governor hears
 * the scale drawn. */
function applyScale(now) {
  const [floor, hold] = st.scaleRules;
  const e = st.engine;
  const want = Math.max(floor, e.preview_render_scale());
  const still = !(st.moving || st.mapMoving || st.scrubbing);
  if (Math.abs(want - st.scale) > 1e-3 && still && now - st.scaleAt >= hold && !st.exporting) {
    st.scale = want;
    st.scaleAt = now;
    sizeCanvas();
  }
  e.set_preview_scale_applied(floor, st.scale);
}

/** What the engine has for the map worker (its tiles, its paints), to it, the bytes' buffers transferred. */
function flushMapWorker() {
  if (!st.mapWorker || st.dead || !st.engine) return;
  const rows = st.engine.take_remote_print_out();
  if (!rows.length) return;
  const transfer = [];
  for (const r of rows) if (r[2]) transfer.push(r[2].buffer);
  st.mapWorker.port.postMessage({ rows }, transfer);
}

/** A picture from the map worker (or word that it painted none): in the map's texture for the next frame. */
function mapPicture({ painted, meshes, bitmap, ms }) {
  if (st.dead || !st.engine) return void bitmap?.close();
  if (st.remotelog) {
    st.mapPictures = (st.mapPictures ?? 0) + 1;
    if (st.mapPictures <= 3 || st.mapPictures % 100 === 0)
      remoteLog("render", `[map picture ${st.mapPictures}]`, painted ? `painted, bitmap ${bitmap?.width}x${bitmap?.height}` : "nothing painted", `worker ${ms?.toFixed(1)} ms`);
  }
  const t0 = performance.now();
  try {
    if (painted) st.engine.remote_print_picture(painted, meshes ?? undefined, bitmap);
    else st.engine.remote_print_skipped();
  } catch (err) {
    return failed(err);
  }
  if (st.trace) st.traceAnswers.push({ at: t0, ms: performance.now() - t0, kind: "map-picture", src: ms.toFixed(1), bytes: 0 });
  st.dirty = true;
  wake();
}

/** How long an export waits on the tile workers without an answer before it gives up (ms). */
const TILE_WORKERS_QUIET_MS = 60000;

/** The map's tile workers (map-tile-worker.js): MapLibre's pool, half the cores (at most 4, beside the load
 * workers), each with the engine's module and fonts. The engine builds the preview map's tiles on them
 * (`set_tile_workers`); without Web Workers here, it builds them in its frames. */
function startTileWorkers(module) {
  if (typeof Worker !== "function") return;
  const n = Math.min(4, Math.max(1, Math.floor((self.navigator?.hardwareConcurrency || 4) / 2)));
  st.tileWorkers = [];
  // One that would not start, or that stopped, takes the tiles it was given with it, and the pool's
  // messages are spread over all of them: the pool goes, and the engine builds the map's tiles itself
  // from then on (an export waiting on them looks again, and draws its frame complete).
  const lost = (why) => {
    if (!st.tileWorkers?.length) return;
    console.warn(`map tile workers: ${why}; the map's tiles are built here from now on`);
    for (const t of st.tileWorkers) t.terminate();
    st.tileWorkers = [];
    if (!st.dead && st.engine) st.engine.tile_workers_lost();
    st.tileAnswer?.();
    st.dirty = true;
    wake();
  };
  for (let i = 0; i < n; i++) {
    const w = new Worker(new URL("./map-tile-worker.js", import.meta.url), { type: "module" });
    const rows = Array.from(st.engine.tile_worker_fonts());
    const fonts = rows.map((r) => r[1]);
    w.postMessage({ kind: "init", module, names: rows.map((r) => r[0]), fonts, remotelog: st.remotelog }, fonts.map((f) => f.buffer));
    w.onmessage = (e) => {
      if (st.dead || !st.engine) return;
      if (e.data.kind === "answer") {
        st.engine.tile_worker_answer(e.data.bytes);
        st.tileAnswer?.();
        // a frame takes the tile up
        st.dirty = true;
        wake();
      } else if (e.data.kind === "init-failed") lost(`one would not start (${e.data.error})`);
    };
    w.onerror = (ev) => {
      ev?.preventDefault?.();
      lost(`one stopped (${ev?.message || "an error"})`);
    };
    w.onmessageerror = () => lost("an answer could not be read");
    st.tileWorkers.push(w);
  }
  st.engine.set_tile_workers(n);
}

/** An export frame's map tiles, on the tile workers: until none is out. (A build's parts pass through here on
 * their way between workers, so each answer may send more.) */
async function exportTilesIn(e) {
  for (;;) {
    const out = e.print_tiles_out();
    flushTileWorkers();
    if (!out) return;
    if (st.exportCancel) throw new Error("cancelled");
    const answered = await new Promise((resolve) => {
      const quiet = setTimeout(() => resolve(false), TILE_WORKERS_QUIET_MS);
      st.tileAnswer = () => {
        clearTimeout(quiet);
        st.tileAnswer = null;
        resolve(true);
      };
    });
    if (!answered) throw new Error("the map tile workers stopped answering");
  }
}

/** What a frame gave the tile workers to do, to them (the bytes' buffers transferred). */
function flushTileWorkers() {
  if (!st.tileWorkers?.length || !st.engine) return;
  for (const [i, bytes] of st.engine.tile_worker_messages()) {
    st.tileWorkers[i % st.tileWorkers.length].postMessage({ kind: "msg", bytes }, [bytes.buffer]);
  }
}

/** What the page says this device is: a phone or tablet, and its memory (Chromium tells, in GB). */
function device() {
  const nav = self.navigator || {};
  const ua = nav.userAgent || "";
  // (an iPad's Safari names itself a Mac: one with a touch screen is the iPad)
  const mobile = nav.userAgentData?.mobile ?? (/Android|iPhone|iPad|iPod|Mobi/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1));
  return { mobile: !!mobile, memoryMb: Math.round((nav.deviceMemory || 0) * 1024) };
}

function answer(m) {
  if (st.dead) return;
  if (st.trace) {
    const t0 = performance.now();
    try {
      answerNow(m);
    } finally {
      st.traceAnswers.push({ at: t0, ms: performance.now() - t0, kind: m.kind, src: m.src || "", bytes: m.bytes?.byteLength || 0 });
    }
    return;
  }
  answerNow(m);
}

/** `answer`, untimed. */
function answerNow(m) {
  wake();
  const e = st.engine;
  try {
    if (m.kind === "cpu") {
      // (landed between frames, `landCpu`)
      if (m.bytes) return void st.cpuWaiting.push({ m, at: performance.now() });
      e.cpu_failed(m.id);
    } else if (m.kind === "detail") {
      if (m.bytes) e.detail_done(m.id, m.bytes);
      else e.detail_failed(m.id);
    } else if (m.kind === "levels") {
      // an export's tile made ready (`readyTiles`): never the preview's
      st.levelsWaiting?.get(m.id)?.(m);
      return;
    } else if (m.kind === "tile") {
      if (m.levels) e.tile_levels(m.id, m.levels);
      else if (m.rgba) e.tile_pixels(m.id, m.rgba);
      else if (m.noData) e.tile_no_data(m.id);
      else if (m.throttled) e.tile_throttled(m.id, m.throttled);
      else e.tile_failed(m.id, m.failed || "failed");
      // (tiles wait in the engine's arrivals: the loop lands them between frames)
      return;
    } else if (m.bytes) e.put_file(m.src, m.bytes);
    else e.fail_file(m.src, m.status || 0, m.retryAfter || 0);
  } catch (err) {
    return failed(err);
  }
  // a file lands in the next frame
  st.landed = true;
}

function setMoving(on) {
  wake();
  if (st.moving === on) return;
  st.moving = on;
  st.engine?.set_moving(on);
  st.pool?.setMoving(on);
  st.dirty = true;
}

/** One beat of the loop: the next is asked for whatever this one met (an engine that failed is not
 * called again, `failed`). */
// Idle polling only watches for engine-side work; commands and arrivals wake immediately.
let scheduled = false;
let idleTimer = null;
function wake() {
  if (!st.engine) return;
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
    scheduled = false;
  }
  if (!scheduled) {
    scheduled = true;
    raf(tick);
  }
}
function active() {
  return !st.dead && !st.exporting && st.loaded && (st.dirty || st.playing || st.moving || st.scrubbing ||
    st.landed || st.settle > 0 || st.transitioning || st.lastPending > 0 || st.pool?.loading > 0 ||
    st.cpuWaiting.length > 0);
}

/** The CPU jobs' answers that fit before the next frame is due, oldest first (`CPU_LAND_MS_PER_MB`); one
 * kept waiting too long lands anyway. Each shows in the next frame. `now`: this tick's frame time. */
function landCpu(now) {
  const e = st.engine;
  // the next frame: the beat after the last one drawn when frames are coming, else a beat from now
  const coming = st.playing || st.dirty || st.moving || st.scrubbing || st.settle > 0 || st.transitioning;
  const end = (coming ? st.lastDraw : now) + FRAME_GAP - CPU_LAND_MARGIN_MS;
  const t0 = performance.now();
  let n = 0;
  const seen = [...st.cpuSeen].sort((a, b) => a - b);
  const msPerMb = Math.max(CPU_LAND_MS_PER_MB, seen.length ? seen[Math.floor(seen.length * 0.75)] : 0);
  while (st.cpuWaiting.length) {
    const { m, at } = st.cpuWaiting[0];
    const t = performance.now();
    const mb = m.bytes.byteLength / 1048576;
    const fits = t + mb * msPerMb <= end;
    if (!fits && t - at < CPU_LAND_WAIT_MS) break;
    st.cpuWaiting.shift();
    try {
      e.cpu_done(m.id, m.bytes);
    } catch (err) {
      return failed(err);
    }
    if (mb >= CPU_LAND_SEEN_MB) {
      st.cpuSeen.push((performance.now() - t) / mb);
      if (st.cpuSeen.length > CPU_LAND_SEEN) st.cpuSeen.shift();
    }
    n++;
    st.landed = true;
    // (one kept waiting too long a turn: the rest that wait as long go after the next frames)
    if (!fits) break;
  }
  if (st.trace && n) st.tickInfo.cpuLand = { n, ms: performance.now() - t0, left: st.cpuWaiting.length };
}
function tick(now) {
  scheduled = false;
  const t0 = performance.now();
  if (st.trace) st.tickInfo = { drawn: false };
  try {
    step(now);
  } catch (err) {
    failed(err);
  } finally {
    if (st.trace) traceTick(now, t0);
    if (active()) wake();
    else if (!scheduled) {
      scheduled = true;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        scheduled = false;
        wake();
      }, 250);
    }
  }
}

/** One tick in the trace: when it ran (`at`, the frame clock), how long since the last (`gap`), its whole
 * cost on this thread (`step`), and what `step`/`draw` noted in `tickInfo`. */
function traceTick(now, t0) {
  const e = st.engine;
  st.trace.push({
    at: now,
    gap: st.traceAt ? now - st.traceAt : 0,
    step: performance.now() - t0,
    started: t0 - now,
    t: st.t,
    playing: st.playing,
    drafting: st.drafting,
    pending: st.lastPending,
    tiles: e && st.loaded ? e.tiles_pending() : 0,
    poolLoading: st.pool?.loading || 0,
    ...st.tickInfo,
  });
  st.traceAt = now;
  if (st.trace.length > 20000) st.trace.shift();
}

/** MapLibre's gestures for this frame (map-web `map_step`): the camera they moved the view to is looked
 * with already; the page hears of it, and of the gesture's start and end, to show it as its own look. */
function stepMap(e, now) {
  if (!st.mapAwake) return;
  const r = e.map_step(now);
  e.map_events(); // (the map's own events: the page reads its clicks itself)
  if (!r.length) {
    st.mapAwake = false;
    return;
  }
  if (r.length === 7) {
    const cam = Array.from(r.slice(0, 5));
    st.lookShown = cam;
    st.looks = [];
    st.dirty = true;
    const moving = r[5] === 1;
    if (moving !== !!st.mapMoving) setMoving(moving);
    st.mapMoving = moving;
    post({ kind: "map-look", cam, moving });
  }
  // an animation or a timer goes on: the loop keeps beating
  st.dirty = true;
}

/** Apply only the newest camera received since the last frame. */
function paceLook() {
  if (!st.looks.length) return false;
  // The page already eases gestures. Never replay an older camera after a slow build or a burst of input.
  const cam = st.looks.at(-1).cam;
  st.looks = [];
  const shown = st.lookShown;
  if (shown && shown.every((v, i) => v === cam[i])) return false;
  st.lookShown = cam;
  st.engine.set_look(...cam);
  return true;
}

function step(now) {
  const gap = now - st.last;
  const dt = Math.min(0.1, gap / 1000);
  st.last = now;
  if (st.playing) {
    st.t += dt;
    // a showcase loops its stretch
    if (st.loop && st.t >= st.loop[1]) st.t = st.loop[0] + ((st.t - st.loop[1]) % Math.max(0.1, st.loop[1] - st.loop[0]));
    else if (st.t >= filmEnd()) {
      st.t = filmEnd();
      st.playing = false;
      // the film's last moment is drawn, whatever else is due
      st.dirty = true;
    }
  }
  if (!st.dead && st.loaded && !st.failed && !st.exporting) {
    const e = st.engine;
    if (paceLook()) st.dirty = true;
    stepMap(e, now);
    // a play-through whose loads can't keep up goes on as drafts (the scrub's), so it plays, not stalls on
    // a half-empty map; paused, the full frame comes back
    const tilesNow = st.playing && !st.playDraft ? e.tiles_pending() : 0;
    if (tilesNow > PLAY_BEHIND_TILES) {
      st.behindSince ||= now;
      if (now - st.behindSince >= PLAY_BEHIND_MS) st.playDraft = true;
    } else st.behindSince = 0;
    if (!st.playing) st.playDraft = false;
    // a draft while the playhead is dragged (when asked for), or a play-through's (which loads every tile);
    // the full frame the moment either stops
    const draft = !st.draftOn ? false : st.scrubbing ? "scrub" : st.playDraft ? "play" : false;
    if (draft !== st.drafting) {
      st.drafting = draft;
      if (draft === "play") e.set_play_draft(true);
      else e.set_draft(!!draft);
      st.dirty = true;
    }
    const loads = e.pending();
    const pending = loads > 0;
    // (PreviewDriver's landing: fewer loads than the last tick saw)
    if (loads < st.lastPending) st.landed = true;
    st.lastPending = loads;
    const since = now - st.lastDraw;
    // (2 ms of slack: a display's frames come a little early or late, and 60 Hz's every other one is 33.3)
    const onBeat = since >= FRAME_GAP - 2;
    let due =
      (onBeat && (st.dirty || st.playing || st.landed || st.settle > 0 || st.transitioning)) ||
      (pending && since >= BUFFER_GAP);
    // no frame now: what arrived lands meanwhile, a slice of it, drawn on the beat
    if (!due && st.cpuWaiting.length) landCpu(now);
    if (!due && e.arrivals() > 0) {
      const t = performance.now();
      const landed = e.land();
      if (st.trace) st.tickInfo.land = { n: landed, ms: performance.now() - t };
      if (landed > 0) st.landed = true;
    }
    if (!due && st.landed) due = onBeat;
    if (due) {
      // (what the trace says the frame was drawn for)
      if (st.trace) st.tickInfo.why = { dirty: st.dirty, landed: st.landed, settle: st.settle, trans: st.transitioning, buffering: pending && since >= BUFFER_GAP };
      st.settle = st.landed ? SETTLE_FRAMES : Math.max(0, st.settle - 1);
      st.dirty = false;
      st.landed = false;
      st.lastDraw = now;
      draw(now);
      // the time left before the next frame is the most there is for what came meanwhile
      if (st.cpuWaiting.length) landCpu(now);
    }
  }
  flushMapWorker();
  sendStatus(false, now);
}

function draw(now) {
  const e = st.engine;
  try {
    const t0 = performance.now();
    e.frame(st.t);
    const t1 = performance.now();
    flushTileWorkers();
    const t2 = performance.now();
    st.frameRevision++;
    st.transitioning = e.transitioning();
    handOut();
    const t3 = performance.now();
    if (st.trace) {
      Object.assign(st.tickInfo, { drawn: true, frame: t1 - t0, flush: t2 - t1, hand: t3 - t2 });
      try {
        st.tickInfo.spans = JSON.parse(e.take_profile_frame());
      } catch {}
    }
    const cost = performance.now() - t0;
    st.costs.push([now, cost]);
    // (a frame of a view moved by hand is reported apart: a gesture that stays slow drops effects, never
    // the size mid-gesture)
    e.report_frame_ms(cost, !!(st.moving || st.mapMoving || st.scrubbing));
    applyScale(now);
    if (st.costs.length > 240) st.costs.shift();
  } catch (err) {
    failed(err);
  }
}

/** What the frame asked for goes to the load workers: cancels first, so a source cancelled and asked for
 * again in one frame cancels its old request, not the new one (as the tiles' aborts go first in Rust). */
function handOut() {
  const e = st.engine;
  for (const id of e.take_tile_cancels()) st.pool.cancel(id);
  const jobs = e.take_tile_jobs();
  for (let i = 0; i < jobs.length; i += 2) st.pool.tile(jobs[i], jobs[i + 1]);
  for (const src of e.take_file_cancels()) st.pool.cancelFile(src);
  const files = e.take_file_requests();
  for (let i = 0; i < files.length; i += 2) st.pool.file(files[i], files[i + 1]);
  for (const src of e.take_file_promotions()) st.pool.promoteFile(src);
  const detail = e.take_detail_jobs();
  for (let i = 0; i < detail.length; i += 2) st.pool.detail(detail[i], detail[i + 1]);
  const cpu = e.take_cpu_jobs();
  for (let i = 0; i < cpu.length; i += 2) st.pool.cpu(cpu[i], cpu[i + 1]);
}

function frameStats(now) {
  const recent = st.costs.filter(([at]) => now - at < 2000);
  const ms = st.costs.map(([, c]) => c).sort((a, b) => a - b);
  const q = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))].toFixed(1) : "–");
  return { fps: (recent.length / 2).toFixed(0), p50: q(0.5), p95: q(0.95), max: q(1 - 1e-9), n: ms.length };
}

function sendStatus(force, now = performance.now()) {
  // (every frame while the view is moved by hand: the page's gestures read the camera each frame drew with)
  const gap = st.scrubbing || st.moving ? 0 : active() || st.frameRevision !== st.sentRevision ? STATUS_GAP : DIAG_GAP;
  if (!st.engine || (!force && now - st.lastStatus < gap)) return;
  st.lastStatus = now;
  const stats = frameStats(now);
  if (now - st.lastDiag >= DIAG_GAP && !st.dead) {
    st.lastDiag = now;
    st.diag = `${st.engine.diagnostics()}\npreview: ${st.canvas.width}×${st.canvas.height}${st.drafting ? " (drafting at half)" : ""}, ${stats.fps} frames/s, ${stats.p50} ms a frame on the render thread (p95 ${stats.p95}, max ${stats.max})`;
  }
  const changed = force || st.frameRevision !== st.sentRevision;
  st.sentRevision = st.frameRevision;
  post({
    kind: "status",
    seq: st.seq,
    t: st.t,
    playing: st.playing,
    playDraft: st.playDraft,
    pending: st.dead ? 0 : st.engine.pending() + st.pool.loading,
    stats,
    diag: st.diag,
    view: st.dead || !changed ? null : st.engine.drawn_view(),
    boxes: st.dead || !changed ? null : st.engine.text_boxes(),
  });
}

/** TEMPORARY (Safari black-map diagnosis): the preview's frame drawn and read back, its colours on a coarse
 * grid in the server's log: how much of it is black, and where. */
async function probeFrame() {
  const since = `${((performance.now() - st.probeFrom) / 1000).toFixed(0)} s in`;
  if (st.dead || !st.loaded || !st.engine) return remoteLog("render", "[frame probe] no frame yet", since);
  try {
    st.engine.frame(st.t);
    handOut();
    const blob = await st.canvas.convertToBlob({ type: "image/png" });
    const bmp = await createImageBitmap(blob);
    const [gw, gh] = [24, 14];
    const c = new OffscreenCanvas(gw, gh).getContext("2d");
    c.drawImage(bmp, 0, 0, gw, gh);
    const px = c.getImageData(0, 0, gw, gh).data;
    let black = 0;
    const rows = [];
    for (let y = 0; y < gh; y++) {
      let row = "";
      for (let x = 0; x < gw; x++) {
        const i = (y * gw + x) * 4;
        const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
        if (r + g + b < 30) black++;
        // one letter a cell: . black, # white-ish, w water-blue, l land-light, g green, o other
        row += r + g + b < 30 ? "." : r > 200 && g > 200 && b > 200 ? "#" : b > r + 30 && b > g ? "w" : g > r && g > b ? "g" : r > 180 && g > 170 ? "l" : "o";
      }
      rows.push(row);
    }
    remoteLog("render", `[frame probe ${since}, t=${st.t.toFixed(1)} ${st.canvas.width}x${st.canvas.height}]`, `black ${((100 * black) / (gw * gh)).toFixed(0)}%`, "|", rows.join("/"), "| map pictures", st.mapPictures ?? 0, "| map worker", !!st.mapWorker, st.mapWorkerOn);
  } catch (err) {
    remoteLog("render", "[frame probe] failed", err);
  }
}

async function snapshot(id) {
  if (st.dead || !st.loaded) return post({ kind: "snapshot", id, blob: null });
  try {
    // drawn and read in one task: a WebGPU canvas keeps its picture only until it is presented
    if (st.drafting) {
      st.engine.set_draft(false);
      st.drafting = false;
    }
    st.engine.frame(st.t);
    handOut();
    const blob = await st.canvas.convertToBlob({ type: "image/png" });
    post({ kind: "snapshot", id, blob });
  } catch (err) {
    if (err instanceof WebAssembly.RuntimeError || last_panic()) failed(err);
    post({ kind: "snapshot", id, blob: null });
  }
}

// ---- the film as a video: every frame complete, encoded to H.264 by the browser, put in an MP4


/** The H.264 profile and level for a `w`×`h` film at `fps`: the first the browser's encoder takes. */
async function codecFor(w, h, fps, bitrate) {
  for (const codec of ["avc1.640028", "avc1.64002A", "avc1.640032", "avc1.640033", "avc1.4D4028", "avc1.42E028"]) {
    const config = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode: "quality", avc: { format: "avc" } };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch {
      /* the next */
    }
  }
  return null;
}

/** downloads at once while an export's reads are warmed */
const WARM_AT_ONCE = 12;

/** `srcs` downloaded WARM_AT_ONCE at a time, each handed to `put(src, bytes)` (`progress(done, total)` hears
 * each): the export's own reads (`WebSource`, synchronous) then come from memory. One that fails is left to
 * the export, which reads it again and reports it if it is still missing. */
/** `src`'s bytes for an export: the preview's load workers' cached copy while fresh (a plain fetch doesn't
 * consult Cache Storage, and would download it again), else the network, given up after
 * `READ_TIMEOUT_MS` or when `signal` aborts. `null`: the server has none, or it failed. */
/** `src`'s bytes for an export, from the preview's cache while fresh, else fetched (a stale copy standing in
 * when the network fails), with the server's status: `{ bytes, status }` (`bytes` null when it had none).
 * A network error or the timeout throws. */
async function fetchSource(src, cache, signal) {
  const url = sourceUrl(src);
  const hit = await cache?.match(url).catch(() => null);
  const fresh = hit && Date.now() - (Number(hit.headers.get("x-map-stored")) || 0) <= source_max_age_s(url) * 1000;
  let r = fresh ? hit : null;
  if (!r) {
    try {
      // (given up before it started: no request at all)
      signal.throwIfAborted();
      r = await fetch(url, { mode: "cors", signal: AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]) });
      if (!r.ok && hit) r = hit;
    } catch (err) {
      if (!hit || signal.aborted) throw err;
      r = hit;
    }
  }
  return { bytes: r.ok ? new Uint8Array(await r.arrayBuffer()) : null, status: r.status };
}

/** How often an export asks again for a read that failed for now (no answer, a timeout, a server busy or
 * failing) before it settles it as missing, and the first wait between (doubled each time). */
const READ_RETRIES = 3;
const READ_RETRY_MS = 1000;
/** A failed read worth asking again: none came back (status 0), or the server said to try later. */
const retryable = (status) => status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;

/** The longest one of an export's fetches is waited on. */
const READ_TIMEOUT_MS = 60_000;
/** The most an export's fetched sources may take ahead of the frames that read them (their bytes and the
 * tiles' compressed levels): a long film's are fetched as it goes and let go after their last frame, not
 * all held from the start. What the next frames read is fetched whatever this says. */
const READS_BUDGET = ((self.navigator?.deviceMemory ?? 8) <= 4 ? 96 : 384) << 20;
/** An export's fetches side by side. */
const READS_LANES = 8;
/** the last id an export's `levels` job had, over every export: never one an earlier export's reply can name */
let levelsSeq = 0;
/** The whole plan's tiles fetched side by side before the first frame (an export of exact tiles has them
 * all in first): as many as the load workers take at once (four, six each), and no more held in flight. */
const FILL_LANES = 24;
/** what a staged tile is, as the engine reads it back (`Engine::export_stage`) */
const STAGED_BYTES = 0;
const STAGED_LEVELS = 1;

/**
 * Where an export's map tiles wait for their frames: one file in the origin's private storage (OPFS),
 * written as each lands and read back at once when the engine loads the tile (`Engine::export_stage`), so a
 * long film's tiles, all in before its first frame, take disk, not memory. `null` when it can't be had (no
 * OPFS, or no synchronous access in this browser): the tiles are then held in memory, as before. `put`
 * says false when a write fails (the disk is full): that tile is held in memory instead.
 */
async function openTileStage() {
  const root = await self.navigator?.storage?.getDirectory?.().catch(() => null);
  if (!root || !self.FileSystemFileHandle?.prototype.createSyncAccessHandle) return null;
  // stages earlier exports left behind (a tab closed mid-export) go first
  for await (const [name] of root.entries()) {
    const at = /^export-tiles-(\d+)\.bin$/.exec(name);
    if (at && Date.now() - Number(at[1]) > STALE_EXPORT_MS) await root.removeEntry(name).catch(() => {});
  }
  const name = `export-tiles-${Date.now()}.bin`;
  let access;
  try {
    access = await (await root.getFileHandle(name, { create: true })).createSyncAccessHandle();
  } catch {
    await root.removeEntry(name).catch(() => {});
    return null;
  }
  access.truncate(0);
  const where = new Map(); // `${kind}:${src}` -> [at, length]
  let end = 0;
  let open = true;
  return {
    get bytes() {
      return end;
    },
    put(src, kind, data) {
      if (!open) return false;
      try {
        if (access.write(data, { at: end }) !== data.byteLength) return false;
      } catch {
        return false;
      }
      where.set(`${kind}:${src}`, [end, data.byteLength]);
      end += data.byteLength;
      return true;
    },
    read(src, kind) {
      const at = open && where.get(`${kind}:${src}`);
      if (!at) return undefined;
      const out = new Uint8Array(at[1]);
      try {
        return access.read(out, { at: at[0] }) === at[1] ? out : undefined;
      } catch {
        return undefined;
      }
    },
    async close() {
      if (!open) return;
      open = false;
      where.clear();
      try { access.close(); } catch { /* closed already */ }
      await root.removeEntry(name).catch(() => {});
    },
  };
}

/**
 * An export's reads (`export_begin`: `[src, first, last]` each, files and the map's tiles apart), fetched
 * for it ahead of the frames that read them, side by side, within `READS_BUDGET`, the tiles made ready for
 * the store by the load workers when it is compressed (`format`), and put on disk when there is a `stage`
 * (`openTileStage`; the budget then counts only what is held in memory). The engine lets each go after its
 * last frame (`export_step`). Every wait here ends: a fetch has a timeout, and `stop` (a cancel) ends them all.
 */
function exportReads(e, files, tiles, format, stage) {
  const cache = (self.caches?.open("map-http-v1") ?? Promise.resolve(null)).catch(() => null);
  const abort = new AbortController();
  const entries = [
    ...files.map(([src, first, last]) => ({ src, first, last, tile: false })),
    ...tiles.map(([src, first, last]) => ({ src, first, last, tile: true })),
  ].sort((a, b) => a.first - b.first);
  const tileSrcs = new Set(tiles.map(([src]) => src));
  // src -> its fetch while it is out; and every src the plan's fetches started (not started twice by them).
  // A src the export asks for again (`get`: it let it go, and a frame read it after) is fetched again.
  const inflight = new Map();
  const planned = new Set();
  let next = 0; // the entries before it are started
  let until = 0; // the frames before it are drawn next: their sources go first, budget or not
  let running = 0;
  let stopped = false;
  st.levelsWaiting = new Map();

  const levelsOf = (src) =>
    new Promise((resolve) => {
      const id = ++levelsSeq;
      st.levelsWaiting?.set(id, (m) => {
        st.levelsWaiting?.delete(id);
        resolve(m);
      });
      st.pool.levels(id, sourceUrl(src), format);
    });
  // a tile's bytes on disk when they can go there, else held
  const putBytes = (src, bytes) => {
    if (tileSrcs.has(src) && stage?.put(src, STAGED_BYTES, bytes)) e.put_export_staged(src);
    else e.put_export_bytes(src, bytes);
  };
  // One read, in: its bytes (or a tile's levels) put to the engine. A read that failed for now (`retryable`)
  // is asked again, a few times, the waits growing, before the engine is told it is missing: the engine
  // settles a source it's told failed for the rest of the export, so one dropped connection or busy
  // server must not cost a tile for the whole film. One the server hasn't (a 404) is missing at once.
  const load = async (src) => {
    for (let attempt = 0; ; attempt++) {
      if (stopped) return;
      let status;
      try {
        if (format && tileSrcs.has(src)) {
          const m = await Promise.race([levelsOf(src), stopping]);
          if (stopped || !m) return;
          if (m.failed !== undefined) {
            status = m.status ?? 0;
          } else {
            // the store takes the levels as they are; the bytes only stand in for levels it can't take
            const levelled = m.levels && (stage?.put(src, STAGED_LEVELS, m.levels)
              ? e.put_export_staged_levels(src, m.levels.byteLength)
              : e.put_export_levels(src, m.levels));
            if (!levelled && m.bytes) putBytes(src, m.bytes);
            else if (!levelled) e.put_export_failed(src);
            return;
          }
        } else {
          const got = await fetchSource(src, await cache, abort.signal);
          if (stopped) return;
          if (got.bytes) return putBytes(src, got.bytes);
          status = got.status;
        }
      } catch {
        if (stopped) return;
        status = 0;
      }
      if (attempt >= READ_RETRIES || !retryable(status)) return e.put_export_failed(src);
      await Promise.race([new Promise((r) => setTimeout(r, READ_RETRY_MS << attempt)), stopping]);
    }
  };
  let endStopping;
  const stopping = new Promise((resolve) => (endStopping = resolve));
  const get1 = (src) => {
    let p = inflight.get(src);
    if (!p) {
      p = load(src).finally(() => inflight.delete(src));
      inflight.set(src, p);
    }
    return p;
  };
  const pump = () => {
    while (!stopped && running < READS_LANES && next < entries.length) {
      const en = entries[next];
      if (en.first >= until && e.export_held_bytes() >= READS_BUDGET) return;
      next++;
      if (planned.has(en.src)) continue;
      planned.add(en.src);
      running++;
      get1(en.src).finally(() => {
        running--;
        pump();
      });
    }
  };
  return {
    /** The sources the frames before `frames` read (preparation's included), and every planned map tile
     * (an export of exact tiles has them all in before its first frame: `ExportRun::start`), fetched and in. */
    async fill(frames, progress = () => {}) {
      until = Math.max(until, frames);
      const need = [...new Set(entries.filter((en) => en.tile || en.first < frames).map((en) => en.src))].filter((src) => !planned.has(src) || inflight.has(src));
      for (const src of need) planned.add(src);
      let n = 0;
      progress(0, need.length);
      pump();
      // a few lanes, each taking the next source as its last is in: what is out at once stays bounded
      // (and, with a stage, what is held: each lands on disk as it comes). Every map tile is in before
      // the first frame, so what can't go on disk (no stage, or a write that failed) is held: once that
      // reaches READS_BUDGET no more tiles start and the export fails, rather than filling the browser's
      // memory until it gives out.
      let at = 0;
      let over = false;
      const lane = async () => {
        while (!stopped && !over && at < need.length) {
          const src = need[at];
          if (tileSrcs.has(src) && e.export_held_bytes() >= READS_BUDGET) {
            over = true;
            throw new Error(
              "This film's map needs more memory than the browser can hold for it" +
                (stage ? "" : " (it has no private storage to keep the map's tiles on)") +
                ". Try a shorter film or a smaller size.",
            );
          }
          at++;
          await get1(src);
          progress(++n, need.length);
        }
      };
      await Promise.all(Array.from({ length: Math.min(FILL_LANES, need.length) }, lane));
    },
    /** `srcs` (the export asked for them: its next frames read them), fetched and in. */
    get: (srcs) => Promise.all(srcs.map(get1)),
    /** The export drew up to `frames`: the fetches go on ahead of it. */
    ahead(frames) {
      until = Math.max(until, frames);
      pump();
    },
    /** Every fetch stopped (cancelled, or the export is over): the waits on them end. */
    stop() {
      if (stopped) return;
      stopped = true;
      abort.abort();
      endStopping(null);
      st.pool?.dropLevels?.();
      st.levelsWaiting = null;
    },
  };
}

/** the most an MP4 may come to when it can only be held in memory (no file to write it to): the whole film
 * is held until it is handed over */
const OUTPUT_MAX_BYTES = 1536 << 20;
/** frames an export draws before the thread is given back (the encoder drains and the file is written then) */
const STEP_FRAMES = 4;
/** What an export has in before its first frame, seconds of film: preparation's reads and the first
 * frames' (the map's tiles are scheduled this far ahead, `tile_plan::AHEAD`). */
const READS_START_S = 6;
/** Waits in a row with no frame drawn before an export gives up: each is a fetch (timed out after
 * `READ_TIMEOUT_MS` at worst) or the tile workers' answers. */
const STALL_WAITS = 500;
/** frames the encoder may hold before the next step waits for it */
const ENCODER_QUEUE_MAX = 6;
/** bytes of the file still being written before the next step waits for them */
const WRITES_PENDING_MAX = 64 << 20;
/** the longest a step waits on the encoder or the file with neither going on before the export fails */
const BEHIND_TIMEOUT_MS = 60_000;
/** the longest an export's last waits (the encoder's flush, the file's last writes, its close) may take */
const FINAL_WAIT_MS = 120_000;
/** the export's last waits under way, each given up by a cancel (`finalWait`) */
const finalWaits = new Set();

/** `p`, unless the export is cancelled first (at once, `cancellable`) or `ms` pass with it unsettled: an
 * export's last waits end however the encoder or the file behave, never holding the export, and the page's
 * next one, for ever. */
function finalWait(p, what, { ms = FINAL_WAIT_MS, cancellable = true } = {}) {
  let timer, give;
  const stop = new Promise((_, reject) => {
    if (cancellable && st.exportCancel) return reject(new Error("cancelled"));
    give = () => reject(new Error("cancelled"));
    if (cancellable) finalWaits.add(give);
    timer = setTimeout(() => reject(new Error(`the ${what} never finished`)), ms);
  });
  return Promise.race([p, stop]).finally(() => {
    clearTimeout(timer);
    finalWaits.delete(give);
  });
}

/** the muxer's writes, in pieces of this many bytes */
const WRITE_CHUNK = 4 << 20;
/** a film left in the origin's private storage by an export this long ago is deleted by the next export */
const STALE_EXPORT_MS = 6 * 3600_000;

/** The thread given back for a moment: the encoder's output, the file's writes and the page's messages (a
 * cancel) run meanwhile. A message to itself, not a timer: a background tab's timers are slowed. */
const yieldThread = () => new Promise((resolve) => {
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => { port1.close(); resolve(); };
  port2.postMessage(null);
});

/** Where an export's MP4 goes as it is made, so the film is never held in memory whole: the file the page
 * chose to save it as (`file`, a `FileSystemFileHandle`; Chrome and Edge ask where at the click), else a file
 * in the origin's private storage (OPFS) handed to the page when it is done. `null`: neither can be had
 * (the film is then held in memory, as before). `write(data, at)`; `pending` bytes not yet written;
 * `settled()` until they are; `close()` ends the file and gives what the page is answered with; `abort()`
 * lets it go. */
async function openOutput(file, expected) {
  if (file) {
    const stream = await file.createWritable();
    const out = {
      pending: 0,
      failed: null,
      writes: new Set(),
      write(data, at) {
        out.pending += data.byteLength;
        const p = stream.write({ type: "write", data, position: at }).then(
          () => { out.pending -= data.byteLength; out.writes.delete(p); },
          (err) => { out.pending -= data.byteLength; out.failed ||= err; out.writes.delete(p); },
        );
        out.writes.add(p);
      },
      async settled() {
        await Promise.all([...out.writes]);
        if (out.failed) throw out.failed;
      },
      async close() {
        await out.settled();
        await stream.close();
        return { saved: true, file: await file.getFile() };
      },
      async abort() {
        await stream.abort().catch(() => {});
      },
    };
    return out;
  }
  const root = await self.navigator?.storage?.getDirectory?.().catch(() => null);
  if (!root || !self.FileSystemFileHandle?.prototype.createSyncAccessHandle) return null;
  // films earlier exports left behind (the page has long since saved them) go first
  for await (const [name] of root.entries()) {
    const at = /^export-(\d+)\.mp4$/.exec(name);
    if (at && Date.now() - Number(at[1]) > STALE_EXPORT_MS) await root.removeEntry(name).catch(() => {});
  }
  const { quota = Infinity, usage = 0 } = (await self.navigator.storage.estimate?.().catch(() => null)) ?? {};
  if (quota - usage < expected * 1.25) {
    throw new Error(`there isn't room in this browser's storage for the video (about ${Math.round(expected / 1048576)} MB). Free some disk space, or try 720p.`);
  }
  const name = `export-${Date.now()}.mp4`;
  const handle = await root.getFileHandle(name, { create: true });
  const access = await handle.createSyncAccessHandle();
  access.truncate(0);
  return {
    pending: 0,
    write(data, at) {
      access.write(data, { at });
    },
    async settled() {},
    async close() {
      access.flush();
      access.close();
      return { saved: false, file: await handle.getFile() };
    },
    async abort() {
      try { access.close(); } catch { /* closed already */ }
      await root.removeEntry(name).catch(() => {});
    },
  };
}

async function exportFilm({ id, w, h, fps, file }) {
  const done = (m, transfer) => post({ kind: "export", id, ...m }, transfer);
  if (!self.VideoEncoder || !self.VideoFrame) return done({ error: "This browser can't encode video (no WebCodecs). Chrome, Edge and Safari can." });
  if (st.exporting || st.dead || !st.loaded) return done({ error: st.dead ? "The engine stopped; reload the page" : "Nothing to render yet" });
  // the frames, checked as a native export checks them, before anything changes
  let total;
  try {
    total = export_frames(w, h, fps, st.duration);
  } catch (err) {
    return done({ error: `This film can't be rendered: ${err?.message ?? err}` });
  }
  const bitrate = Math.round(w * h * fps * 0.2);
  const expected = (bitrate / 8) * st.duration;
  // the export is this call's from here (a second is refused meanwhile, the file and the codec probe
  // included); where it goes is settled before the engine is touched, and a refusal then leaves it alone
  st.exporting = true;
  // a cancel from here on is heard (one that comes while the file is opened included)
  st.exportCancel = false;
  let output = null;
  try {
    output = await openOutput(file, expected);
  } catch (err) {
    st.exporting = false;
    return done({ error: `The video can't be saved: ${err?.message ?? err}` });
  }
  if (!output && expected > OUTPUT_MAX_BYTES) {
    st.exporting = false;
    return done({ error: `At this size the video would come to about ${Math.round(expected / 1048576)} MB, more than the browser can hold (${OUTPUT_MAX_BYTES >> 20} MB). Try 720p, or render it with map-cli.` });
  }
  // everything below is undone in one place
  const e = st.engine;
  st.playing = false;
  let encoder = null;
  let reads = null;
  let stage = null;
  let failure = null;
  let bytes = 0;
  const started = performance.now();
  try {
    if (st.exportCancel) throw new Error("cancelled");
    const config = await codecFor(w, h, fps, bitrate);
    if (!config) throw new Error(`This browser can't encode ${w}×${h} H.264 video. Try 720p.`);
    // written as it is made, its index at the end (the file is never whole in memory); held in memory, the
    // index goes first as before
    const target = output
      ? new StreamTarget({ onData: (data, at) => output.write(data, at), chunked: true, chunkSize: WRITE_CHUNK })
      : new ArrayBufferTarget();
    const muxer = new Muxer({ target, video: { codec: "avc", width: w, height: h, frameRate: fps }, fastStart: output ? false : "in-memory", firstTimestampBehavior: "offset" });
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        bytes += chunk.byteLength;
        if (!output && bytes > OUTPUT_MAX_BYTES) failure ||= new Error(`the video passed ${OUTPUT_MAX_BYTES >> 20} MB, more than the browser can hold. Try 720p.`);
        else muxer.addVideoChunk(chunk, meta);
      },
      error: (err) => (failure ||= err),
    });
    encoder.configure(config);
    // the film at its own size, at full quality, from its own camera
    if (st.drafting) {
      e.set_draft(false);
      st.drafting = false;
    }
    e.clear_look();
    st.looks = [];
    st.lookShown = null;
    // (the page's canvas is left alone: the engine draws at the export's size for the export's own canvas)
    // what the export will read (its own plan: map tiles, detail files, close-up areas' tiles), downloaded
    // side by side first and held for it: its reads, one at a time on this thread, then come from memory
    // (the map's tiles, for a compressed store, made ready by the workers: downloaded and compressed)
    const [files, tiles] = e.export_begin(w, h, fps);
    // the map's tiles wait for their frames on disk where it can be had: every one is in before the
    // first frame, and a long film's would not all fit in memory
    stage = await openTileStage().catch(() => null);
    if (!stage && tiles.length) console.warn("export: no private storage for the map's tiles; they are held in memory");
    e.export_stage(stage ? (src, kind) => stage.read(src, kind) : null);
    reads = st.exportReads = exportReads(e, files, tiles, e.tile_format(), stage);
    // what preparation and the first frames read, in before the export starts (its progress shown); the
    // rest is fetched as the frames go, ahead of them
    await reads.fill(Math.ceil(fps * READS_START_S), (done, total) => post({ kind: "export-progress", id, phase: "tiles", done, total }));
    if (st.exportCancel) throw new Error("cancelled");
    // the engine's own export (as the Android app runs it): it plans, loads and draws every frame itself,
    // each on a canvas of the export's own (on no page: the preview's goes at the display's pace, and a
    // frame taken from it could be the one before), where it is taken into the encoder before the next is
    // drawn. It runs a few frames at a time, the thread given back between: the encoder drains into the
    // file then, and a step waits while either is behind, so however long the film, memory holds a few
    // frames, not the video.
    const out = new OffscreenCanvas(w, h);
    let n = 0;
    // a keyframe every 2 s, in whole frames: at 29.97 fps `n % (fps * 2)` is never 0 after frame 0
    const keyEvery = Math.max(1, Math.round(fps * 2));
    // where the frame loop's wall time goes, said at the end (ms)
    const spent = { step: 0, handOff: 0, tiles: 0, tileWaits: 0, fetch: 0, fetchWaits: 0, yield: 0, behind: 0, behindEncoder: 0 };
    const onFrame = () => {
      if (failure) throw failure;
      const t0 = performance.now();
      const bitmap = out.transferToImageBitmap();
      // each closed however the hand-off goes: they hold the frame's GPU memory until then
      try {
        const frame = new VideoFrame(bitmap, { timestamp: Math.round((n * 1e6) / fps), duration: Math.round(1e6 / fps) });
        try {
          encoder.encode(frame, { keyFrame: n % keyEvery === 0 });
        } finally {
          frame.close();
        }
      } finally {
        bitmap.close();
      }
      n++;
      spent.handOff += performance.now() - t0;
    };
    const onProgress = (kind, a, b) => {
      if (kind === "status") return post({ kind: "export-progress", id, phase: "status", text: a, done: 0, total: 0 });
      const spent = performance.now() - started;
      post({ kind: "export-progress", id, done: a, total: b, eta: Math.round((spent / a) * (b - a) / 1000) });
    };
    if (!e.export_start(w, h, fps, out, onFrame, onProgress)) throw new Error("cancelled");
    let summary;
    const loopStart = performance.now();
    // waits in a row with no frame drawn: one that never ends is an error, said with what it waited on
    let stalled = 0;
    // the most the export's fetched sources held at once (MB in the summary)
    let heldPeak = e.export_held_bytes();
    const waited = (what) => {
      if (++stalled % 50 === 0) console.warn(`export: ${stalled} waits with no frame drawn, on ${what}`);
      if (stalled >= STALL_WAITS) throw new Error(`the export waited on ${what} and it never came`);
    };
    // frames drawn and handed on so far: a step that draws any (a "more", or a "tiles" that drew some
    // before it came to wait) is progress, whatever it ends on
    let lastDone = 0;
    const progressed = (step) => {
      if (!(step.done > lastDone)) return;
      lastDone = step.done;
      stalled = 0;
      heldPeak = Math.max(heldPeak, e.export_held_bytes());
      reads.ahead(step.done + STEP_FRAMES);
    };
    // wait while the encoder or the file is behind: after every step that may have handed it frames, so
    // a run of steps that each draw some and then wait still lets them drain
    const drain = async () => {
      const t0 = performance.now();
      const queued = encoder.encodeQueueSize > ENCODER_QUEUE_MAX;
      // (a wait that goes on with neither the encoder's queue nor the file's writes going down is stuck)
      let moved = performance.now();
      let last = [encoder.encodeQueueSize, output?.pending ?? 0];
      while (!failure && !output?.failed && !st.exportCancel && (encoder.encodeQueueSize > ENCODER_QUEUE_MAX || (output?.pending ?? 0) > WRITES_PENDING_MAX)) {
        await yieldThread();
        const now = [encoder.encodeQueueSize, output?.pending ?? 0];
        if (now[0] < last[0] || now[1] < last[1]) moved = performance.now();
        else if (performance.now() - moved > BEHIND_TIMEOUT_MS) throw new Error(`the ${now[0] > ENCODER_QUEUE_MAX ? "video encoder" : "file's writes"} stopped going on`);
        last = now;
      }
      spent.behind += performance.now() - t0;
      if (queued) spent.behindEncoder++;
      if (output?.failed) throw output.failed;
    };
    for (;;) {
      if (st.exportCancel) throw new Error("cancelled");
      if (failure) throw failure;
      let t0 = performance.now();
      const step = JSON.parse(e.export_step(STEP_FRAMES));
      spent.step += performance.now() - t0;
      flushTileWorkers();
      // the next frames' planned files, not in yet: fetched, then the same frames
      if (step.state === "fetch") {
        waited(step.srcs.slice(0, 4).join(", ") || "its files");
        t0 = performance.now();
        await reads.get(step.srcs);
        spent.fetch += performance.now() - t0;
        spent.fetchWaits++;
        continue;
      }
      // a frame waits on the page: the map print's tiles on the tile workers, and what it read before it
      // was in (the store's tiles), fetched; then drawn again
      if (step.state === "tiles") {
        progressed(step);
        const asked = e.export_asked();
        waited(asked.length ? asked.slice(0, 4).join(", ") : `${e.print_tiles_out()} map print tiles`);
        t0 = performance.now();
        await Promise.all([exportTilesIn(e), reads.get(asked)]);
        spent.tiles += performance.now() - t0;
        spent.tileWaits++;
        // (the thread back here too: nothing else slows a frame that is drawn again and never read)
        await yieldThread();
        await drain();
        continue;
      }
      if (step.state === "cancelled") throw new Error("cancelled");
      if (step.state === "done") {
        summary = step;
        break;
      }
      progressed(step);
      // the thread back: what was encoded goes to the file, and a cancel is heard; then wait while the
      // encoder or the file is behind
      t0 = performance.now();
      await yieldThread();
      spent.yield += performance.now() - t0;
      await drain();
    }
    const loop = performance.now() - loopStart;
    await finalWait(encoder.flush(), "video encoder's flush");
    if (failure) throw failure;
    // a cancel is heard until the film is committed: after the flush, and while the last writes settle
    if (st.exportCancel) throw new Error("cancelled");
    muxer.finalize();
    console.info(`export loop: ${n} frames, ms a frame: ${Object.entries({ all: loop, ...spent }).map(([k, v]) => `${k} ${k === "tileWaits" || k === "fetchWaits" || k === "behindEncoder" ? v : (v / n).toFixed(1)}`).join(", ")}; inputs held at most ${Math.round(heldPeak / 1048576)} MB${stage ? `, tiles on disk ${Math.round(stage.bytes / 1048576)} MB` : ""}`);
    // the frames drawn with planned data or tiles that never came: the page says so
    // reads its plan didn't foresee, drawn without: said, so a gap in the plan shows
    if (summary.unplannedReads?.length) console.warn(`export: ${summary.unplannedReads.length} reads the plan didn't foresee, drawn without: ${summary.unplannedReads.slice(0, 8).join(", ")}`);
    const report = { frames: n, seconds: Math.round((performance.now() - started) / 1000), incomplete: summary.missingDataFrames + summary.missingTileFrames, firstIncomplete: null, missing: summary.missing, unplannedReads: summary.unplannedReads ?? [] };
    if (output) {
      await finalWait(output.settled(), "file's last writes");
      if (st.exportCancel) throw new Error("cancelled");
      // (its close commits the film: given up on a hang, not on a cancel that comes meanwhile)
      const result = await finalWait(output.close(), "file's close", { cancellable: false });
      output = null;
      done({ ...result, ...report });
    } else {
      const buffer = muxer.target.buffer;
      done({ buffer, ...report }, [buffer]);
    }
  } catch (err) {
    // an export between its steps is given up here (one that ended itself is over already)
    if (!st.dead) {
      try { e.export_abandon(); } catch { /* over already */ }
    }
    // the encoder reset first (a flush given up on still holds its frames), then the file let go
    try {
      encoder?.close();
    } catch {
      /* closed already */
    }
    await finalWait(output?.abort() ?? null, "file's abort", { ms: 10_000, cancellable: false }).catch(() => {});
    done({ error: String(err?.message ?? err) });
  } finally {
    reads?.stop();
    st.exportReads = null;
    try {
      encoder?.close();
    } catch {
      /* closed already */
    }
    st.exporting = false;
    // the engine back at the preview's size: as it was, or as the page last sent it (during the export too),
    // at the governor's scale
    const p = drawnSize();
    if (st.canvas.width !== p.w || st.canvas.height !== p.h) {
      st.canvas.width = p.w;
      st.canvas.height = p.h;
    }
    if (!st.dead) {
      e.resize(p.w, p.h);
      e.export_end();
    }
    // (after the engine let go of its reader: nothing reads the stage once it is closed)
    await stage?.close();
    st.dirty = true;
  }
}

