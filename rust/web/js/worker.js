// A load worker: the browser's tile worker (map-runtime's TilePool) and asset fetcher in one.
//
// Relief areas: the engine's close-up relief areas (hundreds of milliseconds each), handed over as bytes,
// built with the same module and posted back, as Android builds them on background threads.
//
// Tiles: fetch through the HTTP cache, decode with the engine's own decoder (decode_tile, the one the
// Android tile workers run), and post 256×256 RGBA back, its buffer transferred; for a compressed store
// (the job's `format`), its mip chain compressed as Android's tile threads compress it (tile_levels) instead.
// An export's tiles ("levels" jobs) come back as both: the bytes and the compressed chain. Files: fetch and post the
// bytes. Downloads from other origins are kept in Cache Storage (the app's disk cache on Android) for as
// long as the shells' one rule says (source_max_age_s: a day for a TileJSON or a style, 30 days for a tile);
// past it they are fetched again, and the old copy is still the answer when that fails (offline). A
// cancelled fetch is aborted where it is and never answered; every other one is answered exactly once.
//
// Every download has a deadline, body and all, and a size: a stalled one is failed (the engine asks again
// later), and none is read past what it may be, whatever its Content-Length said.
import init, { detail_build, cpu_build, decode_tile, tile_is_no_data, tile_levels, source_max_age_s, retry_after_s } from "../pkg/map_web.js";

const CACHE = "map-http-v1";
/** when a cached response was stored (ms since the epoch): its age is read from it */
const STORED = "x-map-stored";
/** a cached response's size (bytes): what this cache holds is summed from it, not from the origin's
 * whole storage (export staging and the rest share that) */
const SIZE = "x-map-size";
/** Cache Storage is kept under this, the native disk cache's budget (map-net's CACHE_BUDGET): past it the
 * entries stored longest ago go until it is back under, checked every PRUNE_EVERY stores */
const CACHE_BUDGET = 1 << 30;
const PRUNE_EVERY = 200;
/** what an entry stored before it carried its size is taken to hold */
const UNSIZED_ENTRY = 64 << 10;
/** the origin is short of room when its usage passes this share of its quota: then this cache, the one
 * store that can be fetched again, gives back a tenth more, whatever its own size */
const QUOTA_PRESSURE = 0.9;
/** a download's deadline, body and all (ms) */
const TILE_DEADLINE_MS = 30_000;
const FILE_DEADLINE_MS = 120_000;
/** the largest download of each kind (bytes): no tile is larger, nor any model, image or terrain sheet */
const TILE_MAX_BYTES = 8 << 20;
const FILE_MAX_BYTES = 256 << 20;
/** what this worker holds at once of the bodies it reads, their assembly and the copies being written to the
 * cache, all told. A download past it is answered busy only while other work holds some: alone, one is
 * read whole up to its own limit (FILE_MAX_BYTES), so a retry can always succeed. A cache write past it
 * is skipped (the cache is a copy, fetched again when missing). */
const HELD_MAX_BYTES = 192 << 20;

let ready = null;
let cache = null;
let stores = 0;
/** bytes held now: bodies being read and assembled, and cache writes not yet settled */
let held = 0;
const running = new Map(); // id -> AbortController

self.onmessage = async (e) => {
  const m = e.data;
  if (m.kind === "init") {
    if (m.remotelog) import("./remote-log.js").then((r) => r.startRemoteLog("load"));
    // the pool hears whether the module started: a worker that can't is replaced, its jobs failed
    ready = init({ module_or_path: m.module });
    ready.then(
      () => post({ kind: "ready" }),
      (err) => post({ kind: "init-failed", error: String(err?.message ?? err) }),
    );
    cache = await (self.caches?.open(CACHE) ?? Promise.resolve(null)).catch(() => null);
    return;
  }
  if (m.kind === "cancel") {
    const ctl = running.get(m.id);
    running.delete(m.id);
    ctl?.abort();
    return;
  }
  try {
    await ready;
  } catch (err) {
    return answerFailed(m, `the load worker did not start (${err?.message ?? err})`);
  }
  if (m.kind === "tile") tile(m);
  else if (m.kind === "levels") levels(m);
  else if (m.kind === "file") file(m);
  else if (m.kind === "detail") detail(m);
  else if (m.kind === "cpu") cpu(m);
};

/** A job this worker can't run, answered as failed (a file as having no response: asked again later). */
function answerFailed(m, why) {
  if (m.kind === "tile" || m.kind === "levels") post({ kind: m.kind, id: m.id, failed: why });
  else if (m.kind === "file") post({ kind: "file", id: m.id, src: m.src, failed: why, status: 0 });
  else if (m.kind === "detail" || m.kind === "cpu") post({ kind: m.kind, id: m.id, bytes: null });
}

class TooLarge extends Error {}
class Busy extends Error {}

/** `r`'s body, read as it comes: never past `max` bytes, nor, while other work holds memory here, past
 * HELD_MAX_BYTES. Its chunks and their assembly into one are counted in `held` while they are held. A body
 * it won't read (too large by its Content-Length) is cancelled, not left open. */
async function readBody(r, max) {
  const declared = Number(r.headers.get("content-length"));
  if (declared > max) {
    r.body?.cancel().catch(() => {});
    throw new TooLarge(`larger than ${max >> 20} MB`);
  }
  if (!r.body) return new Uint8Array(0);
  const reader = r.body.getReader();
  const parts = [];
  let n = 0;
  let assembly = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.byteLength > max) throw new TooLarge(`larger than ${max >> 20} MB`);
      // busy only because of others: this body alone is always read (within `max`)
      if (held > n && held + value.byteLength > HELD_MAX_BYTES) throw new Busy("too many large downloads at once");
      held += value.byteLength;
      n += value.byteLength;
      parts.push(value);
    }
    if (parts.length === 1) return parts[0];
    // (the chunks and the whole they are copied into are both held while it is made)
    assembly = n;
    held += assembly;
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  } finally {
    held -= n + assembly;
  }
}

/** A download of `url`, its body read within `max` bytes: { status, bytes } (bytes when ok), or
 * { status, retry } for a server that asked to wait. Kept in Cache Storage when `keep`: a fresh copy is
 * the answer; a stale one is the answer when the refresh fails, however it fails (no answer, an error, its
 * body dropped or timed out as it came), as long as the job is still `wanted` (a cancelled one does no
 * more). Throws on no response with no stale copy. Every body it doesn't read is cancelled. */
async function download(url, signal, keep, max, wanted = () => true) {
  const copy = keep && cache ? await cache.match(url).catch(() => null) : null;
  if (copy && Date.now() - (Number(copy.headers.get(STORED)) || 0) <= source_max_age_s(url) * 1000) {
    return { status: 200, bytes: await readBody(copy, max) };
  }
  // the refresh failed: the old bytes (as map-net's cache keeps them), else `failure`'s answer
  const failed = async (failure) => {
    if (copy && wanted()) return { status: 200, bytes: await readBody(copy, max) };
    return failure();
  };
  let r;
  try {
    r = await fetch(url, { signal, mode: "cors" });
  } catch (err) {
    return failed(() => {
      throw err;
    });
  }
  if (!r.ok) {
    const retry = r.status === 429 || r.status === 503 ? retryAfter(r) : 0;
    r.body?.cancel().catch(() => {});
    return failed(() => ({ status: r.status, retry }));
  }
  let bytes;
  try {
    bytes = await readBody(r, max);
  } catch (err) {
    return failed(() => {
      throw err;
    });
  }
  if (keep && cache) store(url, bytes, r.headers.get("content-type"));
  return { status: r.status, bytes };
}

/** `bytes` kept for `url` (copied as the Response is made: the caller may transfer them at once). The copy
 * is held until the write settles, counted in `held`: a write that would pass HELD_MAX_BYTES is skipped
 * (it is a cache), so writes never pile up copies beside the downloads. */
function store(url, bytes, type) {
  const n = bytes.byteLength;
  if (held + n > HELD_MAX_BYTES) return;
  const headers = { [STORED]: String(Date.now()), [SIZE]: String(n) };
  if (type) headers["content-type"] = type;
  held += n;
  cache
    .put(url, new Response(bytes, { headers }))
    .catch(() => {})
    .finally(() => {
      held -= n;
    });
  if (++stores % PRUNE_EVERY === 0) prune().catch(() => {});
}

/** This cache under its budget, by what it holds (its entries' sizes, summed): past it, the entries stored
 * longest ago go until it is back under (Cache Storage keeps them in the order stored). And, apart, when the
 * origin as a whole is short of room, a tenth more of the oldest: this is the store that can be fetched
 * again. */
async function prune() {
  const [keys, responses] = await Promise.all([cache.keys(), cache.matchAll()]);
  if (keys.length !== responses.length) return; // (changed meanwhile: the next prune sees it whole)
  const sizes = responses.map((r) => Number(r.headers.get(SIZE)) || UNSIZED_ENTRY);
  let total = sizes.reduce((a, b) => a + b, 0);
  let drop = 0;
  while (total > CACHE_BUDGET && drop < keys.length) total -= sizes[drop++];
  const estimate = await self.navigator?.storage?.estimate?.().catch(() => null);
  if (estimate?.quota && estimate.usage > estimate.quota * QUOTA_PRESSURE) {
    drop = Math.min(keys.length, drop + Math.ceil(keys.length / 10));
  }
  for (const k of keys.slice(0, drop)) await cache.delete(k);
}

const remote = (url) => /^https?:/.test(url) && new URL(url).origin !== self.location.origin;

/** seconds a server asked to wait (Retry-After, in seconds or as a date), or a few by default */
function retryAfter(r) {
  const s = retry_after_s(r.headers.get("retry-after") ?? "", Date.now() / 1000);
  return Number.isFinite(s) && s > 0 ? Math.min(s, 120) : 5;
}

/** Run `job` with an abort controller under `key` and a deadline: `answer(error)` hears a failure (none
 * when it was cancelled), `deadline` aborting it as a timeout. */
async function guarded(key, deadline, job, answer) {
  const ctl = new AbortController();
  running.set(key, ctl);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, deadline);
  try {
    await job(ctl.signal, () => running.get(key) === ctl);
  } catch (err) {
    // a failed job lets go of its fetch: whatever it left open (a response refused unread) is aborted
    ctl.abort();
    if (running.get(key) !== ctl) return; // cancelled: never answered
    answer(timedOut ? new Error(`no answer in ${deadline / 1000} s`) : err);
  } finally {
    clearTimeout(timer);
    if (running.get(key) === ctl) running.delete(key);
  }
}

/** A download job: `url` fetched under `key` (what a cancel names) within `deadline` and `max` bytes, and
 * `use(result)` called only while the job is still wanted; a failure, `use`'s own included, goes to
 * `answer` (a cancelled job hears nothing). The one lifecycle of every download this worker makes. */
function downloadJob(key, deadline, url, max, use, answer) {
  return guarded(
    key,
    deadline,
    async (signal, wanted) => {
      const r = await download(url, signal, remote(url), max, wanted);
      if (wanted()) use(r);
    },
    answer,
  );
}

function tile({ id, url, format }) {
  const answer = (err) => {
    if (err instanceof Busy) return post({ kind: "tile", id, throttled: 1 });
    post({ kind: "tile", id, failed: String(err?.message ?? err) });
  };
  return downloadJob(
    id,
    TILE_DEADLINE_MS,
    url,
    TILE_MAX_BYTES,
    (r) => {
      if (r.retry) return post({ kind: "tile", id, throttled: r.retry });
      // (as the Android host: anything else unanswered is a failure, which the engine retries and backs off)
      if (!r.bytes) return post({ kind: "tile", id, failed: `HTTP ${r.status}` });
      const rgba = decode_tile(r.bytes);
      if (!rgba) return post({ kind: "tile", id, failed: "the tile does not decode" });
      if (tile_is_no_data(url, rgba)) return post({ kind: "tile", id, noData: true });
      const lv = format ? tile_levels(rgba, format) : null;
      if (lv) return post({ kind: "tile", id, levels: lv }, [lv.buffer]);
      post({ kind: "tile", id, rgba }, [rgba.buffer]);
    },
    answer,
  );
}

/** An export's tile, made ready before it starts: its bytes (what the export reads should it need the tile
 * again) and its chain compressed in `format`. One that is no imagery, or doesn't decode, comes back with its
 * bytes alone: the export decides about it as it would have. */
function levels({ id, url, format }) {
  const failed = (err) => post({ kind: "levels", id, failed: String(err?.message ?? err) });
  return downloadJob(
    `l${id}`,
    TILE_DEADLINE_MS,
    url,
    TILE_MAX_BYTES,
    (r) => {
      if (!r.bytes) return failed(`HTTP ${r.status}`);
      const rgba = decode_tile(r.bytes);
      const lv = rgba && !tile_is_no_data(url, rgba) ? tile_levels(rgba, format) : null;
      post({ kind: "levels", id, bytes: r.bytes, levels: lv }, lv ? [r.bytes.buffer, lv.buffer] : [r.bytes.buffer]);
    },
    failed,
  );
}

function file({ id, src, url }) {
  // (keyed apart from the tiles' ids: a cancel names one or the other)
  const answer = (err) => {
    const failed = String(err?.message ?? err);
    // a file larger than any may be is as good as missing; one refused while other work held this worker's
    // memory is asked again shortly (alone, it is always read whole)
    if (err instanceof TooLarge) return post({ kind: "file", id, src, failed, status: 413 });
    if (err instanceof Busy) return post({ kind: "file", id, src, failed, status: 429, retryAfter: 1 });
    post({ kind: "file", id, src, failed, status: 0 });
  };
  return downloadJob(
    `f${id}`,
    FILE_DEADLINE_MS,
    url,
    FILE_MAX_BYTES,
    (r) => {
      if (!r.bytes) return post({ kind: "file", id, src, failed: `HTTP ${r.status}`, status: r.status, retryAfter: r.retry });
      post({ kind: "file", id, src, bytes: r.bytes }, [r.bytes.buffer]);
    },
    answer,
  );
}

/** A close-up relief area, decoded and reprojected here instead of in the render thread's frame. */
function detail({ id, bytes }) {
  let out = null;
  try {
    out = detail_build(bytes) ?? null;
  } catch {
    /* answered as failed: the engine asks for the area again */
  }
  post({ kind: "detail", id, bytes: out }, out ? [out.buffer] : []);
}

function post(msg, transfer = []) {
  self.postMessage(msg, transfer);
}

function cpu({ id, bytes }) {
  let out = null;
  try { out = cpu_build(bytes) ?? null; } catch { /* answered as failed; the engine retries */ }
  post({ kind: "cpu", id, bytes: out }, out ? [out.buffer] : []);
}
