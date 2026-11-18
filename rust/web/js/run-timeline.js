// The run timeline in a browser: each worker loads the engine's module, so each keeps its own timeline (the
// engine's events: map_render::timeline, through map-web's timeline_* functions) and its own JS events (a
// tick, a picture landing). On a take, each hands both over as Chrome trace events on the page's one clock
// (µs since the epoch: performance.timeOrigin + performance.now()), and the page joins them into one file
// that Perfetto (ui.perfetto.dev) opens as lanes, and tools/timeline-summary.py reads.
//
// Lanes: each worker is a process of its own (`pid`): page 1, render 2, map worker 3, tile workers 10 on.
// The engine's events take the worker's thread lane; this worker's JS events take lane 1000 ("js").

/** This worker's JS events while on. */
const js = { on: false, events: [] };
const JS_LANE = 1000;
/** JS events kept at most (past it the oldest half goes). */
const MAX_JS_EVENTS = 200000;

/** Now, on the page's one clock (µs since the epoch). */
export const nowUs = () => (performance.timeOrigin + performance.now()) * 1000;

export const timelineOn = () => js.on;

/** Record (or stop) this worker's timeline: its JS events and, given the module's functions, the engine's,
 * on lane `lane`. */
export function setTimeline(on, wasm, lane) {
  js.on = on;
  if (on) js.events.length = 0;
  try {
    wasm?.timeline_set?.(on);
    if (on && lane) wasm?.timeline_lane?.(lane);
  } catch {}
}

function push(e) {
  if (js.events.length >= MAX_JS_EVENTS) js.events.splice(0, MAX_JS_EVENTS / 2);
  js.events.push(e);
}

/** A step from `startUs` (`nowUs`) to now. */
export function jsSpan(name, startUs, args) {
  if (js.on) push({ name, cat: "js", ph: "X", ts: startUs, dur: nowUs() - startUs, args });
}

/** A moment. */
export function jsMark(name, args) {
  if (js.on) push({ name, cat: "js", ph: "i", s: "t", ts: nowUs(), args });
}

/** A value over time. */
export function jsCounter(name, value) {
  if (js.on) push({ name, cat: "counter", ph: "C", ts: nowUs(), args: { value } });
}

/** This worker's events since the last take, as Chrome trace events (a JSON array's items, no brackets), under
 * process `pid` named `process`; the engine's too, given the module's functions. */
export function takeTimeline(wasm, pid, process) {
  const parts = [];
  try {
    if (wasm?.timeline_take) {
      // the engine's clock starts at its own zero: moved onto the page's clock
      const origin = nowUs() - wasm.timeline_now_us();
      const own = wasm.timeline_take(origin, pid, process);
      if (own) parts.push(own);
    }
  } catch {}
  if (!parts.length) parts.push(JSON.stringify({ ph: "M", name: "process_name", pid, tid: 0, args: { name: process } }));
  parts.push(JSON.stringify({ ph: "M", name: "thread_name", pid, tid: JS_LANE, args: { name: `${process} (js)` } }));
  for (const e of js.events.splice(0)) parts.push(JSON.stringify({ ...e, pid, tid: JS_LANE }));
  return parts.join(",");
}
