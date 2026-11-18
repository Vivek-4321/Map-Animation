// The load workers (map-runtime's TilePool and AssetPool, in the browser): each fetches through the HTTP
// cache and decodes tiles with the engine's own decoder (worker.js), and compresses them for the tile store
// when it keeps them compressed (`format`), as Android's tile threads do. Tiles go to the least busy worker.
//
// Every job handed out is answered once: by its worker, or here, as failed, when its worker is lost (a
// script error, a module that would not start). A lost worker is replaced, a few times at most.

/** the repo root: the engine's sources (data/, glb/, stories/) are relative to it */
export const ROOT = new URL("../../../", import.meta.url);

export const sourceUrl = (src) => (/^(https?:|data:|blob:)/.test(src) ? src : new URL(src, ROOT).href);

/** Android runs four tile threads; one core is left to the render thread and one to the page */
const WORKERS = Math.min(4, Math.max(2, (self.navigator?.hardwareConcurrency || 4) - 2));
/** workers preparing vector tiles, images and files (the CPU jobs that aren't models), side by side: a
 * single one sat idle between the frames that hand jobs out while a fly-in's tiles queued behind it. One
 * core each is left to the render thread, the page, the map's worker and the model worker. Each holds a
 * wasm instance of its own, so a small device keeps one. (Rust admits two jobs a worker: map-web's
 * `CPU_JOBS`, kept to this.) */
export const CPU_FAST_WORKERS = Math.min(3, Math.max(1, (self.navigator?.hardwareConcurrency || 4) - 4));
/** downloads one worker has out at once; the rest wait their turn */
const PER_WORKER = 6;
/** while the view is moved by hand, at most this many of the view's tile downloads are out at once
 * (MapLibre's MAX_PARALLEL_IMAGE_REQUESTS_PER_FRAME while its map moves): the view goes by faster than most
 * of them would land, and the network and the workers' decoding are left to what still shows. The
 * look-ahead's tiles start none meanwhile, and those out don't count against it. */
const MOVING_TILES = 8;
/** lost workers replaced, over the pool's life: past it the pool runs on with those it has */
const RESTARTS = 8;
/** downloads asked for only ahead of need (the look-ahead's tiles and files) out at once, a worker: one
 * slot each is always left to what the view needs now, so it never waits behind work for later. Of the
 * workers there are (`LoadPool::aheadRoom`): a pool down a worker keeps its reserve. */
const AHEAD_PER_WORKER = PER_WORKER - 1;

export class LoadPool {
  /** `spawn`: a new worker (tests give their own) */
  constructor(module, onAnswer, spawn = () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" })) {
    this.onAnswer = onAnswer;
    this.module = module;
    this.spawn = spawn;
    this.restarts = 0;
    this.workers = Array.from({ length: WORKERS }, () => this.start());
    this.queue = []; // [{kind, ...}] waiting for room
    this.owner = new Map(); // tile id -> worker
    this.levelsOwner = new Map(); // export tile id -> worker
    // the tile store's format, the engine's `tile_format` (0: RGBA, the tiles go uncompressed)
    this.format = 0;
    this.fileOwner = new Map(); // file job id -> worker
    this.fileSrc = new Map(); // file job id -> src, while it is out
    this.fileIds = new Map(); // src -> file job id, while it is queued or out
    this.nextFile = 1;
    this.moving = false;
    this.buildOut = new Set(); // "kind:id" of the builds out with the build worker (relief areas)
    this.aheadOut = new Set(); // "kind:id" of the downloads out that only the look-ahead wants
    this.held = 0; // `hold`s not yet released: the queue is filled, not pumped
  }

  /** Jobs about to be handed over in a batch (cancels, new ones, promotions): none goes out until
   * `release`, then the queue is pumped once, in its order. */
  hold() {
    this.held++;
  }

  release() {
    this.held = Math.max(0, this.held - 1);
    if (!this.held) this.pump();
  }

  /** How many look-ahead downloads may be out: all but one place on each worker there is. */
  aheadRoom() {
    return this.workers.length * AHEAD_PER_WORKER;
  }

  /** `job` in the queue by need: the view's own (tiles and files alike) before any asked for only ahead,
   * in the order they came. */
  enqueue(job) {
    const behind = job.ahead ? -1 : this.queue.findIndex((j) => j.ahead);
    if (behind < 0) this.queue.push(job);
    else this.queue.splice(behind, 0, job);
  }

  start(onMessage = (w, m) => this.answered(w, m)) {
    const w = this.spawn();
    w.busy = 0;
    w.onmessage = (e) => onMessage(w, e.data);
    w.onerror = (e) => this.lost(w, e?.message || "the load worker stopped");
    w.onmessageerror = () => this.lost(w, "a load worker's answer could not be read");
    w.postMessage({ kind: "init", module: this.module, remotelog: LoadPool.remotelog });
    return w;
  }

  /** A map tile's download. `ahead`: only the look-ahead wants it (it waits behind the view's own). */
  tile(id, url, ahead = false) {
    this.enqueue({ kind: "tile", id, url, format: this.format, ahead });
    this.pump();
  }

  /** An export's map tile (`id` its own count), made ready for the store before the export starts: its
   * bytes and its levels compressed in `format`, answered as `{kind: "levels", id, bytes, levels}`. */
  levels(id, url, format) {
    this.queue.push({ kind: "levels", id, url, format });
    this.pump();
  }

  /** The export's tiles for `levels`, given up (it was cancelled, or is over): those queued dropped, those
   * out cancelled with their workers, and none answered, so a late reply can't land in the next export. */
  dropLevels() {
    this.queue = this.queue.filter((j) => j.kind !== "levels");
    for (const [id, w] of this.levelsOwner) {
      w.busy--;
      w.postMessage({ kind: "cancel", id: `l${id}` });
    }
    this.levelsOwner.clear();
    this.pump();
  }


  /** A close-up relief area's build (encoded, with its tiles' bytes). */
  detail(id, bytes) {
    this.build("detail", id, bytes);
  }

  /** Vector preparation and image decodes never queue behind relief builds or tile downloads, and a
   * model's preparation (its parse, textures and levels of detail, the longest job) never queues
   * before them: models go to a worker of their own (`model`), the rest to the least busy of
   * `CPU_FAST_WORKERS` (`fastLane`). Rust admits two jobs a worker (map-web's `CPU_JOBS`); each worker
   * runs its own in that bounded order. */
  cpu(id, bytes, model = false) {
    const lane = model ? "model" : this.fastLane();
    this.cpuLanes ??= {};
    let c = this.cpuLanes[lane];
    if (!c?.worker) {
      c = this.cpuLanes[lane] ??= { starts: 0 };
      if (c.starts > RESTARTS) return void this.onAnswer({ kind: "cpu", id, bytes: null });
      c.starts++;
      c.out = new Set();
      c.worker = this.start((w, m) => {
        if (m.kind === "init-failed") return this.lost(w, m.error);
        if (w !== c.worker || m.kind !== "cpu" || !c.out.delete(m.id)) return;
        this.onAnswer(m);
      });
    }
    c.out.add(id);
    c.worker.postMessage({ kind: "cpu", id, bytes }, [bytes.buffer]);
  }

  /** The fast lane with the fewest jobs out (a worker not started yet has none): a camera flying in asks
   * for dozens of tiles at once, prepared side by side, not one after another on a single worker. */
  fastLane() {
    let best = "fast0";
    let fewest = Infinity;
    for (let i = 0; i < CPU_FAST_WORKERS; i++) {
      const out = this.cpuLanes?.[`fast${i}`]?.out?.size ?? 0;
      if (out < fewest) [best, fewest] = [`fast${i}`, out];
    }
    return best;
  }

  /** A long build of `kind` ("detail"): on a worker of its own (the build worker), so one that
   * takes hundreds of milliseconds never holds up the tiles. */
  build(kind, id, bytes) {
    if (!this.buildWorker) {
      // (lost too often: built nowhere, so the engine keeps what it shows, or asks again)
      if (this.buildStarts > RESTARTS) return void this.onAnswer({ kind, id, bytes: null });
      this.buildStarts = (this.buildStarts || 0) + 1;
      this.buildWorker = this.start((w, m) => {
        if (m.kind === "init-failed") return this.lost(w, m.error);
        if (m.kind !== "detail" || w !== this.buildWorker) return;
        this.buildOut.delete(`${m.kind}:${m.id}`);
        this.onAnswer(m);
      });
    }
    this.buildOut.add(`${kind}:${id}`);
    this.buildWorker.postMessage({ kind, id, bytes }, [bytes.buffer]);
  }

  /** A source the engine missed. `ahead`: only a job asked for ahead of need wants it, so it waits behind
   * the rest (Android's look-ahead lane); the view's own go before those. One asked for again while its
   * last request is still here replaces that one. */
  file(src, ahead = false) {
    if (this.fileIds.has(src)) this.cancelFile(src);
    const id = this.nextFile++;
    this.fileIds.set(src, id);
    this.enqueue({ kind: "file", id, src, url: sourceUrl(src), ahead });
    this.pump();
  }

  /** A source asked for ahead of need that the view now needs: still queued, it goes before the look-ahead. */
  promoteFile(src) {
    const id = this.fileIds.get(src);
    const i = this.queue.findIndex((j) => j.kind === "file" && j.id === id);
    if (i < 0 || !this.queue[i].ahead) return;
    const [job] = this.queue.splice(i, 1);
    job.ahead = false;
    this.enqueue(job);
    this.pump();
  }

  /** No job waits for `src` any more: dropped from the queue, or its download aborted (never answered). */
  cancelFile(src) {
    const id = this.fileIds.get(src);
    if (id === undefined) return;
    this.fileIds.delete(src);
    const i = this.queue.findIndex((j) => j.kind === "file" && j.id === id);
    if (i >= 0) return void this.queue.splice(i, 1);
    const w = this.fileOwner.get(id);
    if (!w) return;
    this.fileOwner.delete(id);
    this.fileSrc.delete(id);
    this.aheadOut.delete(`file:${id}`);
    w.busy--;
    w.postMessage({ kind: "cancel", id: `f${id}` });
    this.pump();
  }

  /** A tile asked for ahead of need that the view now needs: still queued, it goes before the look-ahead;
   * out, it no longer counts as the look-ahead's. The same download either way. */
  promoteTile(id) {
    const i = this.queue.findIndex((j) => j.kind === "tile" && j.id === id);
    if (i >= 0) {
      if (!this.queue[i].ahead) return;
      const [job] = this.queue.splice(i, 1);
      job.ahead = false;
      this.enqueue(job);
      return void this.pump();
    }
    if (this.aheadOut.delete(`tile:${id}`)) this.pump();
  }

  cancel(id) {
    const i = this.queue.findIndex((j) => j.kind === "tile" && j.id === id);
    if (i >= 0) return void this.queue.splice(i, 1);
    const w = this.owner.get(id);
    if (!w) return;
    this.owner.delete(id);
    this.aheadOut.delete(`tile:${id}`);
    w.busy--;
    w.postMessage({ kind: "cancel", id });
    this.pump();
  }

  /** The view is moved by hand (or has stopped): fewer tile downloads go out meanwhile (`MOVING_TILES`). */
  setMoving(on) {
    this.moving = on;
    if (!on) this.pump();
  }

  pump() {
    if (this.held) return;
    while (this.queue.length) {
      if (!this.workers.length) return this.failQueued("no load worker is left");
      const w = this.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
      if (w.busy >= PER_WORKER) return;
      // (while moving, the view's tiles are held at `MOVING_TILES` of their own and the look-ahead's
      // tiles start none, so the queue's first file goes ahead of them; the look-ahead's jobs wait while
      // they hold all the room they may, `aheadRoom`)
      let aheadTiles = 0;
      for (const k of this.aheadOut) if (k.startsWith("tile:")) aheadTiles++;
      const viewTilesHeld = this.moving && this.owner.size - aheadTiles >= MOVING_TILES;
      const aheadHeld = this.aheadOut.size >= this.aheadRoom();
      const i = this.queue.findIndex((j) =>
        !(aheadHeld && j.ahead) && !(j.kind === "tile" && this.moving && (j.ahead || viewTilesHeld)));
      if (i < 0) return;
      const [job] = this.queue.splice(i, 1);
      if (job.ahead) this.aheadOut.add(`${job.kind}:${job.id}`);
      w.busy++;
      if (job.kind === "tile") this.owner.set(job.id, w);
      if (job.kind === "levels") this.levelsOwner.set(job.id, w);
      if (job.kind === "file") {
        this.fileOwner.set(job.id, w);
        this.fileSrc.set(job.id, job.src);
      }
      w.postMessage(job);
    }
  }

  answered(w, m) {
    if (m.kind === "ready") return;
    if (m.kind === "init-failed") return this.lost(w, m.error);
    if (m.kind === "tile") {
      if (this.owner.get(m.id) !== w) return; // cancelled meanwhile
      this.owner.delete(m.id);
      this.aheadOut.delete(`tile:${m.id}`);
    }
    if (m.kind === "levels") {
      if (this.levelsOwner.get(m.id) !== w) return;
      this.levelsOwner.delete(m.id);
    }
    if (m.kind === "file") {
      if (this.fileOwner.get(m.id) !== w) return; // cancelled meanwhile
      this.fileOwner.delete(m.id);
      this.fileSrc.delete(m.id);
      this.aheadOut.delete(`file:${m.id}`);
      if (this.fileIds.get(m.src) === m.id) this.fileIds.delete(m.src);
    }
    w.busy--;
    this.pump();
    this.onAnswer(m);
  }

  /** `w` is gone (`why`): each job it had is answered as failed (a file as having no response, so it is
   * asked for again later), and a new worker takes its place while restarts last. */
  lost(w, why) {
    if (w.lost) return;
    w.lost = true;
    try {
      w.terminate();
    } catch {
      /* gone already */
    }
    const failed = `the load worker stopped (${why})`;
    const lane = Object.values(this.cpuLanes ?? {}).find((c) => c.worker === w);
    if (lane) {
      lane.worker = null;
      const out = [...lane.out];
      lane.out.clear();
      for (const id of out) this.onAnswer({ kind: "cpu", id, bytes: null });
      return;
    }
    if (w === this.buildWorker) {
      this.buildWorker = null;
      const out = [...this.buildOut];
      this.buildOut.clear();
      for (const k of out) {
        const [kind, id] = k.split(":");
        this.onAnswer({ kind, id: Number(id), bytes: null });
      }
      return;
    }
    this.workers = this.workers.filter((x) => x !== w);
    const answers = [];
    for (const [id, owner] of this.owner) {
      if (owner !== w) continue;
      this.owner.delete(id);
      this.aheadOut.delete(`tile:${id}`);
      answers.push({ kind: "tile", id, failed });
    }
    for (const [id, owner] of this.levelsOwner) {
      if (owner !== w) continue;
      this.levelsOwner.delete(id);
      answers.push({ kind: "levels", id, failed });
    }
    for (const [id, owner] of this.fileOwner) {
      if (owner !== w) continue;
      const src = this.fileSrc.get(id);
      this.fileOwner.delete(id);
      this.fileSrc.delete(id);
      this.aheadOut.delete(`file:${id}`);
      if (this.fileIds.get(src) === id) this.fileIds.delete(src);
      answers.push({ kind: "file", id, src, failed, status: 0 });
    }
    if (this.restarts < RESTARTS) {
      this.restarts++;
      this.workers.push(this.start());
    }
    for (const m of answers) this.onAnswer(m);
    this.pump();
  }

  /** With no worker to run them, the jobs still queued are answered as failed. */
  failQueued(why) {
    const queued = this.queue;
    this.queue = [];
    for (const job of queued) {
      if (job.kind === "tile" || job.kind === "levels") this.onAnswer({ kind: job.kind, id: job.id, failed: why });
      else {
        if (this.fileIds.get(job.src) === job.id) this.fileIds.delete(job.src);
        this.onAnswer({ kind: "file", id: job.id, src: job.src, failed: why, status: 0 });
      }
    }
  }

  get loading() {
    return this.queue.length + this.workers.reduce((n, w) => n + w.busy, 0);
  }
}

export async function compile(url) {
  // Revalidate the engine on startup: replacing a local build must not keep
  // serving a fresh HTTP-cache entry from the previous version.
  // Fetched once: streamed into the compiler when the server says it is wasm, else (a server that sends
  // another type for .wasm, which compileStreaming refuses) its bytes compiled. A module that doesn't
  // compile fails as itself, never fetched again.
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`the engine's module: HTTP ${r.status}`);
  const type = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type === "application/wasm") return WebAssembly.compileStreaming(r);
  return WebAssembly.compile(await r.arrayBuffer());
}
