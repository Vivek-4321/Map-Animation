// The page's handle on the engine, which runs on its own thread (render-worker.js) drawing into this
// canvas, so a heavy frame never holds up the editor. Commands go over (a story, a time, a size, scrubbing);
// the clock and the loads come back a few times a frame's worth.
export { sourceUrl } from "./loads.js";
import { DrawnView } from "./drawn-view.js";
// TEMPORARY (Safari black-map diagnosis): `?remotelog`, and `?nomapworker` to paint the map without its worker
import { REMOTE_LOG, startRemoteLog } from "./remote-log.js";
if (REMOTE_LOG) startRemoteLog("page");
const NO_MAP_WORKER = new URLSearchParams(location.search).has("nomapworker");

/** `?gl` in the page's address: the engine on WebGL2 even where there is WebGPU, to see what an old phone
 * sees. Read as the module loads, before the page rewrites its address. */
const WEBGL = new URLSearchParams(location.search).has("gl");
/** `?lowmem`: the engine on a small phone's low-memory budgets (a phone of 4 GB or less has them anyway) */
const LOW_MEMORY = new URLSearchParams(location.search).has("lowmem");

/** the preview's longest side for each resolution choice (the film renders at its own size) */
export const PREVIEW_SIZES = { 540: 960, 720: 1280, 1080: 1920, full: Infinity };

/**
 * Start the engine on `canvas`. `status(text)` hears what it is doing. Resolves to a Preview, or throws with
 * why (no GPU for the page, the wasm missing).
 */
export async function startEngine(canvas, status = () => {}, resolution = "720", template = null) {
  // (no WebGPU is fine: the engine draws on WebGL2 then, as on an old phone)
  if (!canvas.transferControlToOffscreen) throw new Error("This browser can't draw from a worker (OffscreenCanvas).");
  const worker = new Worker(new URL("./render-worker.js", import.meta.url), { type: "module" });
  const preview = new Preview(worker, canvas, resolution);
  const { w, h } = preview.pixelSize();
  const offscreen = canvas.transferControlToOffscreen();
  await new Promise((resolve, reject) => {
    preview.onReady = resolve;
    preview.onStartFailed = reject;
    preview.statusNote = status;
    worker.postMessage({ kind: "start", canvas: offscreen, w, h, template, webgl: WEBGL, lowMemory: LOW_MEMORY, remotelog: REMOTE_LOG, noMapWorker: NO_MAP_WORKER }, [offscreen]);
  });
  preview.onStartFailed = null;
  preview.size = { w, h };
  preview.watchSize();
  return preview;
}

export class Preview extends EventTarget {
  constructor(worker, canvas, resolution) {
    super();
    Object.assign(this, { worker, canvas, resolution });
    this.t = 0;
    this.duration = 0;
    this.playing = false;
    this.scrubbing = false;
    this.isMoving = false;
    this.pending = 0;
    this.loaded = false;
    this.dead = false;
    this.failed = null;
    /** the last video made in the browser's own storage (not saved to a file chosen): let go of when the
     * next is made, or the page goes */
    this.exportFile = null;
    addEventListener("pagehide", () => this.forgetExport());
    this.stats = { fps: "0", p50: "–", p95: "–", max: "–", n: 0 };
    this.diag = "";
    /** the camera the last frame drew with (a DrawnView), for gestures on the frame */
    this.view = null;
    this.boxes = [];
    this.calls = new Map(); // id -> {resolve, reject}
    this.nextId = 1;
    /** the last clock command sent (seek, play, pause); a status from before it is not trusted on the clock */
    this.seq = 0;
    this.size = { w: 0, h: 0 };
    worker.onmessage = (e) => this.heard(e.data);
    // the render thread gone (a script error, a message it could not read): as an engine that stopped
    worker.onerror = (e) => this.stopped(e?.message || "the render thread stopped");
    worker.onmessageerror = () => this.stopped("the render thread's message could not be read");
  }

  /** The engine is gone (`why`): nothing more is asked of it, and every call still waiting is failed. */
  stopped(why) {
    const first = !this.dead;
    this.dead = true;
    this.failed = why;
    this.playing = false;
    const calls = [...this.calls.values()];
    this.calls.clear();
    for (const c of calls) c.reject(new Error(`the engine stopped (${why})`));
    if (this.onStartFailed) return this.onStartFailed(new Error(why));
    if (first) this.dispatchEvent(new CustomEvent("error", { detail: why }));
  }

  heard(m) {
    switch (m.kind) {
      case "status-note":
        return this.statusNote?.(m.note);
      case "ready":
        return this.onReady?.();
      case "map-look":
        // MapLibre's gestures moved the view (the render thread looks with it already)
        this.mapLook = m.cam;
        return this.dispatchEvent(new CustomEvent("maplook", { detail: { cam: m.cam, moving: m.moving } }));
      case "status":
        // the render thread's clock, once it has heard the page's last command
        if (m.seq === this.seq) {
          this.t = m.t;
          this.playing = m.playing;
          this.playDraft = m.playDraft;
        }
        this.pending = m.pending;
        this.stats = m.stats;
        this.diag = m.diag;
        if (m.view?.length) this.view = new DrawnView(m.view);
        if (m.boxes) this.boxes = m.boxes;
        return this.dispatchEvent(new Event("tick"));
      case "error":
        if (m.dead) return this.stopped(m.message);
        this.failed = m.message;
        this.onStartFailed?.(new Error(m.message));
        return this.dispatchEvent(new CustomEvent("error", { detail: m.message }));
      case "export-progress":
        return this.exportProgress?.(m);
      case "multdev-story":
      case "travelboast-story":
      case "showcase-catalog":
      case "showcase":
      case "end-showcase":
      case "trail-story":
      case "load":
      case "snapshot":
      case "profile":
      case "trace":
      case "country-at":
      case "country-outline":
      case "country-names":
      case "export": {
        const call = this.calls.get(m.id);
        this.calls.delete(m.id);
        if (!call) return;
        if (m.error) call.reject(new Error(m.error));
        else call.resolve(m);
      }
    }
  }

  call(msg) {
    if (this.dead) return Promise.reject(new Error(`the engine stopped (${this.failed})`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  /** Generate the route template in the render worker's existing WASM instance. */
  async multdevStory(stops, meta) {
    return (await this.call({ kind: "multdev-story", stops, meta })).json;
  }

  /** The Story template's (TravelBoast's) story (JSON): `stops`, `meta` its settings; `borders`: the world's
   * countries are wanted (a stop's country lights up). */
  async travelboastStory(stops, meta, borders = false) {
    return (await this.call({ kind: "travelboast-story", stops, meta, borders })).json;
  }

  /** The Story template's choices, by kind: { kind: [{ key, name, about }] } (the engine's catalogue). */
  async showcaseCatalog() {
    return JSON.parse((await this.call({ kind: "showcase-catalog" })).json);
  }

  /** Show choice `key` of kind `what` (vehicle, effect, swap, highlight, label, entrance) on its own, looping,
   * in place of the film: the engine builds, plays and lets go of it. `photo`: an entrance's picture. */
  async showcase(what, key, photo = "") {
    const m = await this.call({ kind: "showcase", what, key, photo });
    this.duration = m.duration;
    this.playing = true;
    return m;
  }

  /** Turn the showcase's view by a drag: degrees of bearing and pitch from its own. */
  orbit(bearing, pitch) {
    this.worker.postMessage({ kind: "showcase-orbit", bearing, pitch });
  }

  /** The film back, where it was, after a showcase. */
  async endShowcase() {
    const m = await this.call({ kind: "end-showcase" });
    this.duration = m.duration;
    this.playing = false;
    return m;
  }

  /** The trail template's story (JSON): `path` [[lon, lat], …] in order, `meta` its settings. */
  async trailStory(path, meta) {
    return (await this.call({ kind: "trail-story", path, meta })).json;
  }

  /** Load a story (JSON text); edits that keep the map reload lightly. Resolves to its length; rejects
   * with why when the engine refuses it. */
  async load(json) {
    const m = await this.call({ kind: "load", json });
    this.duration = m.duration;
    this.loaded = true;
    this.failed = null;
    return m.duration;
  }

  seek(t) {
    this.t = Math.max(0, this.duration ? Math.min(this.duration, t) : t);
    this.worker.postMessage({ kind: "seek", t: this.t, seq: ++this.seq });
  }

  /** Play from where it is (the render thread starts it over when it is at, or nearly at, the end). */
  play() {
    this.playing = true;
    this.worker.postMessage({ kind: "seek", t: this.t, seq: ++this.seq });
    this.worker.postMessage({ kind: "play", seq: ++this.seq });
  }

  pause() {
    this.playing = false;
    this.worker.postMessage({ kind: "pause", seq: ++this.seq });
  }

  /** The playhead is being dragged (draft frames, if they are on) or has stopped (the full frame). */
  scrub(on) {
    if (this.scrubbing === on) return;
    this.scrubbing = on;
    this.worker.postMessage({ kind: "scrub", on });
  }

  /** The view is being moved by hand (a pan, a pinch, a wheel) or has stopped: the engine draws lighter
   * meanwhile, at the same size (the Android editor's interacting). `settled`: the gesture already waited
   * for its end (a wheel's pause), so the view sharpens at once. */
  moving(on, settled = false) {
    if (this.isMoving === on) return;
    this.isMoving = on;
    this.worker.postMessage({ kind: "moving", on, settled });
  }

  /** Look around with `cam` ([lon, lat, dist, pitch, bearing]) instead of the film's camera; null: back
   * to the film's. Only the preview: the story is unchanged. `at`: the page frame time (rAF's clock) a
   * gesture's camera is for: the render thread coalesces these and draws the newest each frame (without
   * one, the view goes there at once). */
  setLook(cam, at) {
    const stamp = cam && Number.isFinite(at) ? performance.timeOrigin + at : null;
    this.worker.postMessage({ kind: "look", cam: cam ? [...cam] : null, at: stamp });
  }

  /** A DOM event on the preview for MapLibre's gestures (maplibre-gestures.js), to the render thread. */
  mapInput(ev) {
    this.worker.postMessage({ kind: "map-input", ev });
  }

  /** Draft frames while scrubbing: on or off. */
  setDraft(on) {
    this.worker.postMessage({ kind: "draft", on });
  }

  /** The preview's resolution: "540", "720", "1080" or "full" (the screen's own pixels). */
  setResolution(r) {
    this.resolution = r;
    this.resize();
  }

  /** The canvas's pixel size: its size on screen at the screen's density, no larger than the resolution. */
  pixelSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, r.width * dpr);
    const h = Math.max(1, r.height * dpr);
    const long = PREVIEW_SIZES[this.resolution] ?? PREVIEW_SIZES[720];
    const k = Math.min(1, long / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  watchSize() {
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.resize();
  }

  resize() {
    const { w, h } = this.pixelSize();
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.worker.postMessage({ kind: "resize", w, h });
  }

  frameStats() {
    return this.stats;
  }

  diagnostics() {
    return this.diag || "starting";
  }

  /** The frame on screen, at full quality, as a PNG blob (null when it can't be read back). */
  async snapshot() {
    try {
      return (await this.call({ kind: "snapshot" })).blob;
    } catch {
      return null;
    }
  }

  /** The country at a map point (its name as the map has it), or null at sea. */
  async countryAt(lon, lat) {
    return (await this.call({ kind: "country-at", lon, lat })).name;
  }

  /** A country's outline: rings of [lon, lat, lon, lat, …] (none when the map has no such country). */
  async countryOutline(name) {
    return (await this.call({ kind: "country-outline", name })).rings;
  }

  /** An item dragged on the frame is drawn moved and scaled: [scene, item, dx, dy, scale, cx, cy] (fractions of the frame); null lets go of it. */
  setNudge(nudge) {
    this.worker.postMessage({ kind: "nudge", nudge });
  }

  /** Every country on the map, sorted (fetched once). */
  countryNames() {
    this.names ||= this.call({ kind: "country-names" }).then((m) => m.names);
    return this.names;
  }

  /**
   * Render the film to an MP4: `w`×`h` at `fps`, every frame complete. `progress({ done, total, eta })` hears
   * each frame. The video is written to a file as it is made, never held in memory whole: where the browser
   * can (Chrome, Edge), it first asks where to save it as `name` (so call this from the click) and writes it
   * there; elsewhere into the browser's own storage. Resolves to { blob, saved, frames, seconds, ... }:
   * `blob` the video (a file on disk), `saved` whether it is already in the file chosen; rejects with why
   * (or "cancelled", the save dialog's cancel too).
   */
  async exportVideo({ w, h, fps, name }, progress = () => {}) {
    this.forgetExport();
    let file = null;
    if (typeof window.showSaveFilePicker === "function") {
      try {
        file = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }] });
        // (the page can say where it goes while it is made)
        progress({ phase: "file", name: file.name });
      } catch (err) {
        if (err?.name === "AbortError") throw new Error("cancelled");
        // (refused for another reason, a click too long ago say: the browser's own storage instead)
      }
    }
    this.exportProgress = progress;
    try {
      const m = await this.call({ kind: "export", w, h, fps, file });
      // (a browser with neither a file nor storage to write to held the video in memory, as before)
      const blob = m.file ?? new Blob([m.buffer], { type: "video/mp4" });
      if (m.file && !m.saved) this.exportFile = m.file.name;
      return { ...m, blob, saved: Boolean(m.saved) };
    } finally {
      this.exportProgress = null;
      this.dirty = true;
    }
  }

  /** The last video kept in the browser's own storage, deleted (the page has done with it). */
  forgetExport() {
    if (!this.exportFile) return;
    this.worker.postMessage({ kind: "export-forget", name: this.exportFile });
    this.exportFile = null;
  }

  cancelExport() {
    this.worker.postMessage({ kind: "export-cancel" });
  }

  /** A trace of the render thread's loop over `ms`: one entry a tick (its time, the gap since the last,
   * whether it drew and what that cost, the engine's own spans of each frame drawn). */
  async trace(ms = 10000) {
    this.worker.postMessage({ kind: "trace", on: true });
    await new Promise((r) => setTimeout(r, ms));
    const m = await this.call({ kind: "trace", on: false });
    // (each load answer the render thread took in meanwhile, outside the ticks: `traceAnswers`)
    this.traceAnswers = m.answers || [];
    return m.trace;
  }

  /** The engine's CPU spans over `ms` of what the preview does meanwhile, summed. */
  async profile(ms = 4000) {
    this.worker.postMessage({ kind: "profile", on: true });
    const n0 = this.stats.n;
    await new Promise((r) => setTimeout(r, ms));
    const m = await this.call({ kind: "profile", on: false });
    return { spans: JSON.parse(m.spans), frames: this.stats.n - n0 };
  }
}
