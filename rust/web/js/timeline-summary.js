// What a run's timeline says, in numbers: how evenly frames came, which were late and what they spent their
// time on, how far the map on show trailed the camera, how long tiles and files took to come. The same
// reading as tools/timeline-summary.py, for the timeline page.

const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const stats = (xs) => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), p99: pct(xs, 0.99), max: xs.length ? Math.max(...xs) : NaN });

/** Each `asked` mark paired with the next `landed` (or failed) one of the same key: the waits (ms). */
function waits(events, asked, landed, failed, key) {
  const out = new Map();
  const ws = [];
  let lost = 0;
  for (const e of events) {
    const k = e.args?.[key];
    if (k == null) continue;
    if (asked.includes(e.name)) out.set(k, e.ts);
    else if (e.name === landed || e.name === failed) {
      if (out.has(k)) {
        ws.push((e.ts - out.get(k)) / 1000);
        out.delete(k);
      }
      if (e.name === failed) lost++;
    }
  }
  return { ...stats(ws), failed: lost, never: out.size };
}

/** The summary of a trace (`{traceEvents}`), with the slowest frames' biggest steps. */
export function summarize(trace) {
  const ev = (trace.traceEvents || []).filter((e) => e.ph !== "M").sort((a, b) => a.ts - b.ts);
  const frames = ev.filter((e) => e.name === "frame" && e.cat === "frame");
  const preview = frames.filter((f) => f.args?.kind === "preview");
  const shown = preview.length ? preview : frames;
  const gaps = shown.slice(1).map((f, i) => (f.ts - shown[i].ts) / 1000);
  const typical = pct(gaps, 0.5);
  const late = gaps.filter((g) => g > Math.max(50, 1.5 * typical)).length;
  const span = shown.length > 1 ? (shown[shown.length - 1].ts - shown[0].ts) / 1e6 : 0;
  // the slowest frames and their biggest steps (spans on the same lane within them)
  const steps = ev.filter((e) => e.ph === "X" && e.cat !== "frame");
  const slowest = [...shown]
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 8)
    .map((f) => {
      const inside = steps.filter((s) => s.pid === f.pid && s.tid === f.tid && s.ts >= f.ts && s.ts + s.dur <= f.ts + f.dur);
      const top = inside.sort((a, b) => b.dur - a.dur).slice(0, 4).map((s) => `${s.name} ${(s.dur / 1000).toFixed(1)}`);
      return { at_s: (f.ts - (shown[0]?.ts || 0)) / 1e6, t: f.args?.t, ms: f.dur / 1000, top };
    });
  // the longest gaps between frames, and what ran on the frames' worker meanwhile (a tick, a load landing)
  const longGaps = shown
    .slice(1)
    .map((f, i) => ({ prev: shown[i], next: f, ms: (f.ts - shown[i].ts) / 1000 }))
    .filter((g) => g.ms > Math.max(50, 1.5 * typical))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 8)
    .map((g) => {
      const from = g.prev.ts + g.prev.dur;
      const inGap = ev.filter((e) => e.pid === g.prev.pid && e.ph === "X" && e.ts < g.next.ts && e.ts + e.dur > from && !["frame", "gpu", "run", "export"].includes(e.cat));
      const top = inGap.sort((a, b) => b.dur - a.dur).slice(0, 5).map((e) => `${e.name} ${(e.dur / 1000).toFixed(1)}`);
      return { at_s: (g.prev.ts - (shown[0]?.ts || 0)) / 1e6, t: g.next.args?.t, ms: g.ms, top };
    });
  const lag = shown.map((f) => f.args?.["map.asked_ms_ago"]).filter((v) => typeof v === "number");
  const paints = ev.filter((e) => e.name === "map paint").map((e) => e.dur / 1000);
  // the run's phases (an export's setup) and the GPU's frames (the first carries the setup's passes)
  const phases = ev.filter((e) => (e.cat === "run" || e.cat === "export") && e.ph === "X").map((e) => [e.name, e.dur / 1000]);
  const gpuSpans = ev.filter((e) => e.cat === "gpu" && e.name === "gpu frame");
  const gpuFrames = gpuSpans.map((e) => e.dur / 1000);
  // each part's (pass's) time a frame: summed by name within each GPU frame, the median over frames (the
  // first left out), a part a frame lacks counting 0
  const gpuPasses = ev.filter((e) => e.cat === "gpu" && e.name !== "gpu frame");
  const perFrame = gpuSpans.slice(1).map((g) => {
    const parts = new Map();
    for (const e of gpuPasses) if (e.ts >= g.ts && e.ts < g.ts + Math.max(g.dur, 1)) parts.set(e.name, (parts.get(e.name) || 0) + e.dur / 1000);
    return parts;
  });
  const passes = new Map([...new Set(perFrame.flatMap((p) => [...p.keys()]))].map((n) => [n, pct(perFrame.map((p) => p.get(n) || 0), 0.5)]));
  const waitingFrames = shown.filter((f) => (f.args?.["tiles.pending"] || 0) > 0).length;
  return {
    frames: { n: shown.length, seconds: span, fps: span ? shown.length / span : NaN, late, gap_ms: stats(gaps), cpu_ms: stats(shown.map((f) => f.dur / 1000)) },
    map: { paints: stats(paints), behind_camera_ms: stats(lag), frames_over_250ms_behind: lag.filter((v) => v > 250).length },
    loads: {
      detail_files: waits(ev, ["detail asked", "detail asked ahead"], "detail landed", "detail failed", "path"),
      imagery_tiles: waits(ev, ["tile asked"], "tile landed", "tile failed", "key"),
      frames_waiting_on_tiles: waitingFrames,
    },
    slowest,
    longGaps,
    phases,
    gpu: { frame_ms: stats(gpuFrames.length > 1 ? gpuFrames.slice(1) : gpuFrames), passes: [...passes].sort((a, b) => b[1] - a[1]).slice(0, 12) },
  };
}

/** The summary as lines of text. */
export function summaryText(s) {
  const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");
  const st = (x) => `p50 ${f(x.p50)}  p95 ${f(x.p95)}  p99 ${f(x.p99)}  max ${f(x.max)}  (n ${x.n})`;
  return [
    ...(s.phases.length ? ["run phases (ms):", ...s.phases.map(([n, ms]) => `  ${f(ms).padStart(9)}  ${n}`)] : []),
    `frames: ${s.frames.n} over ${f(s.frames.seconds)} s = ${f(s.frames.fps)} fps, late ${s.frames.late}`,
    `  gap between frames ms: ${st(s.frames.gap_ms)}`,
    `  frame CPU ms:          ${st(s.frames.cpu_ms)}`,
    ...(s.gpu.frame_ms.n ? [`GPU per frame ms:        ${st(s.gpu.frame_ms)} (the first frame left out: it carries the setup passes)`, "  GPU per part, a frame (median ms; the scene's parts apart with --profile-split):", ...s.gpu.passes.map(([n, ms]) => `    ${f(ms, 3).padStart(7)}  ${n}`)] : []),
    `map paints ms:           ${st(s.map.paints)}`,
    `map behind camera ms:    ${st(s.map.behind_camera_ms)}; frames > 250 ms behind: ${s.map.frames_over_250ms_behind}`,
    `detail files wait ms:    ${st(s.loads.detail_files)}; failed ${s.loads.detail_files.failed}, never came ${s.loads.detail_files.never}`,
    `imagery tiles wait ms:   ${st(s.loads.imagery_tiles)}; failed ${s.loads.imagery_tiles.failed}, never came ${s.loads.imagery_tiles.never}`,
    `frames waiting on tiles: ${s.loads.frames_waiting_on_tiles}`,
    `slowest frames:`,
    ...s.slowest.map((x) => `  at ${f(x.at_s, 2)} s (story t ${f(x.t, 2)}): ${f(x.ms)} ms — ${x.top.join(", ")}`),
    `longest gaps between frames (what ran meanwhile on the frames' worker):`,
    ...s.longGaps.map((x) => `  at ${f(x.at_s, 2)} s (story t ${f(x.t, 2)}): ${f(x.ms)} ms — ${x.top.join(", ") || "nothing recorded (the browser or GPU)"}`),
  ].join("\n");
}
