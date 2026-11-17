// The timeline: a ruler and its playhead, the scenes as tabs (the one under the playhead lit green; drag a
// scene's right edge to change its length; a diamond between two is how the film goes into the next), then
// one lane per kind of item, as the Android app colours them: titles white, routes green, highlights amber,
// places teal. Click to pick; drag a clip to move it in time, its ends to trim it. A change lands when the
// pointer lifts, so the engine reloads once per drag.
import { Icons, glyph } from "./icons.js";
import { LANES } from "./story.js";

export const LANE_LABEL = { titles: ["Titles", Icons.text, "var(--ink2)"], routes: ["Routes", Icons.route, "#6C9A46"], highlights: ["Areas", Icons.area, "#C89040"], pins: ["Places", Icons.pin, "var(--teal)"] };
const RULER = 26;
/** one track of a lane: a clip and the gap under it */
const TRACK = 30;

export function clock(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

const snap = (v) => Math.round(v * 10) / 10;

/** moves outside the element stay its own; a pointer the browser no longer tracks goes on without */
function capture(el, id) {
  try {
    el.setPointerCapture(id);
  } catch {
    /* (no capture: the drag still ends on its pointerup) */
  }
}

export class Timeline {
  constructor({ labels, scroll, inner }, handlers) {
    Object.assign(this, { labels, scroll, inner, h: handlers });
    this.px = 22;
    this.state = null;
    this.key = "";
    this.drag = null;
    // a vertical wheel over the lanes scrolls the rows (or time, when all rows fit, or with shift); with ⌘/ctrl it zooms
    this.scroll.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.h.onZoom(this.px * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        // a vertical wheel scrolls the rows when there are more than fit; with shift (or with no more rows)
        // it scrolls time
        const body = this.scroll.parentElement;
        if (!e.shiftKey && body.scrollHeight > body.clientHeight + 1) return;
        e.preventDefault();
        this.scroll.scrollLeft += e.deltaY;
      }
    }, { passive: false });
    // the ruler and the empty lanes scrub; a click on empty lanes picks nothing
    this.inner.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".tl-clip, .tl-seg, .tl-join, .tl-add, .cam-dur, .cam-end")) return;
      const scrub = (ev) => this.h.onScrub(this.timeAt(ev.clientX));
      scrub(e);
      let moved = false;
      capture(this.inner, e.pointerId);
      const move = (ev) => { moved = true; scrub(ev); };
      const up = () => {
        this.inner.removeEventListener("pointermove", move);
        this.inner.removeEventListener("pointerup", up);
        this.inner.removeEventListener("pointercancel", up);
        this.h.onScrubEnd?.();
        if (!moved && !e.target.closest(".ruler")) this.h.onPick(null);
      };
      this.inner.addEventListener("pointermove", move);
      this.inner.addEventListener("pointerup", up);
      this.inner.addEventListener("pointercancel", up);
    });
  }

  timeAt(clientX) {
    const r = this.inner.getBoundingClientRect();
    return Math.max(0, Math.min(this.state?.duration || 0, (clientX - r.left - 8) / this.px));
  }

  setZoom(px) {
    const t = this.state?.t || 0;
    const before = t * this.px - this.scroll.scrollLeft;
    this.px = Math.max(6, Math.min(80, px));
    this.render(true);
    this.scroll.scrollLeft = t * this.px - before; // the playhead stays where it was on screen
  }

  /** `s`: { rev, segments, clips, camera, duration, t, pick, doc } */
  update(s) {
    this.state = s;
    this.render(false);
    this.setTime(s.t, false);
  }

  /** the playhead to `t`; `follow`: keep it in view (while playing) */
  setTime(t, follow) {
    if (!this.state) return;
    this.state.t = t;
    const x = 8 + t * this.px;
    const ph = this.inner.querySelector(".ph");
    if (ph) {
      ph.style.left = `${x}px`;
      ph.firstChild.textContent = clock(t);
    }
    if (follow) {
      const w = this.scroll.clientWidth;
      if (x < this.scroll.scrollLeft + 40 || x > this.scroll.scrollLeft + w - 80) this.scroll.scrollLeft = x - 80;
    }
    this.inner.querySelectorAll(".tl-seg").forEach((el) => {
      const g = this.state.segments[Number(el.dataset.shot)];
      el.classList.toggle("now", !!g && t >= g.start && t < g.end);
    });
  }

  render(force) {
    const s = this.state;
    if (!s || this.drag) return;
    const key = JSON.stringify([s.rev, s.duration, s.pick, this.px]);
    if (!force && key === this.key) return;
    this.key = key;
    const px = this.px;
    const X = (t) => 8 + t * px;
    const width = X(s.duration) + 120;
    const parts = [`<div class="ruler" style="width:${width}px">`];
    const step = px >= 40 ? 1 : px >= 14 ? 5 : 10;
    for (let t = 0; t <= s.duration + 0.001; t += step) {
      // a label every five seconds when ticks are a second apart, else on every tick
      const big = step >= 5 || t % 5 === 0;
      parts.push(`<div class="t${big ? " big" : ""}" style="left:${X(t)}px">${big ? `<span>${t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}` : `${t}s`}</span>` : ""}</div>`);
    }
    parts.push(`</div><div class="tl-row scenes-row" style="width:${width}px">`);
    const scenes = s.segments.length > 1;
    s.segments.forEach((g, i) => {
      const on = s.pick?.kind === "shot" && s.pick.i === i;
      parts.push(`<div class="tl-seg${on ? " on" : ""}" data-shot="${i}" style="left:${X(g.start) + 1}px;width:${Math.max(6, (g.end - g.start) * px - 2)}px">
        <b>${esc(g.label)}</b><span>Scene ${g.scene + 1} · ${(g.end - g.start).toFixed(1)}s</span>${g.key == null && s.doc.overrides(g.scene) ? '<i class="own" title="Its own look"></i>' : ""}${g.key == null ? '<i class="edge" title="Drag to change its length"></i>' : ""}</div>`);
    });
    if (scenes) s.segments.slice(1).forEach((g) => parts.push(`<div class="tl-join${s.pick?.kind === "join" && s.pick.scene === g.scene ? " on" : ""}" data-join="${g.scene}" style="left:${X(g.start)}px" title="How the film goes into ${esc(g.label)}"></div>`));
    parts.push(`<button class="tl-add" style="left:${X(s.duration) + 6}px" title="Add a scene">${glyph(Icons.plus, 16)}</button></div>`);
    const picked = s.pick?.kind === "item";
    const labels = [`<div style="height:${RULER}px"></div>`, `<div style="height:44px;margin-top:8px"><span style="color:#6C9A46">${glyph(Icons.film, 14)}</span>Scenes</div>`,
      `<div class="cam-label" style="height:34px;margin-top:6px"><span style="color:#8EA2F2">${glyph(Icons.camera, 14)}</span>Camera<button class="ib sm add-key" title="A camera move at the playhead, arriving at the view on screen (K)">${glyph(Icons.plus, 13)}</button></div>`];
    // the camera: each key a block from its arrival to the next; its move a ramp into it
    parts.push(`<div class="tl-row cam-row" style="width:${width}px">`);
    const camPicked = s.pick?.kind === "cam";
    for (const c of s.camera) {
      const on = camPicked && s.pick.scene === c.scene && s.pick.key === c.key;
      if (c.ramp) {
        parts.push(`<div class="cam-ramp ${c.kind}${on ? " on" : ""}" style="left:${X(c.ramp[0])}px;width:${Math.max(2, (c.ramp[1] - c.ramp[0]) * px)}px" title="${esc(c.move)}, ${(c.ramp[1] - c.ramp[0]).toFixed(1)} s"></div>`);
      }
      parts.push(`<div class="tl-clip cam ${c.kind}${on ? " on" : camPicked ? " dim" : ""}" data-scene="${c.scene}" data-key="${c.key ?? ""}" title="${esc(c.label)}"
        style="left:${X(c.start)}px;width:${Math.max(8, (c.end - c.start) * px)}px"><i class="cam-dot"></i><b>${esc(c.label)}</b></div>`);
    }
    // the grips sit over the blocks: the left one is where the move begins (drag it left for a longer move,
    // from a cut to a glide), the right one is where this camera lets go to the next (or the scene ends)
    for (const c of s.camera) {
      if (c.key != null) {
        const outer = c.ramp ? (c.kind === "shot" ? c.ramp[1] : c.ramp[0]) : c.start;
        parts.push(`<i class="cam-dur" data-scene="${c.scene}" data-key="${c.key}" style="left:${X(outer)}px" title="Drag: where the move begins (how long it takes)"></i>`);
      }
      parts.push(`<i class="cam-end" data-scene="${c.scene}" data-key="${c.key ?? ""}" style="left:${X(c.end)}px" title="Drag: how long the camera holds here"></i>`);
    }
    parts.push(`</div>`);
    for (const lane of LANES) {
      // clips that overlap in time stack, each on the first track free at its start
      const tracks = [];
      const placed = s.clips.filter((k) => k.lane === lane).sort((a, b) => a.start - b.start).map((c) => {
        let k = tracks.findIndex((end) => end <= c.start + 0.01);
        if (k < 0) k = tracks.push(0) - 1;
        tracks[k] = c.end;
        return [c, k];
      });
      const h = TRACK * Math.max(1, tracks.length) + 4;
      labels.push(`<div style="height:${h}px;margin-top:6px"><span style="color:${LANE_LABEL[lane][2]}">${glyph(LANE_LABEL[lane][1], 14)}</span>${LANE_LABEL[lane][0]}</div>`);
      parts.push(`<div class="tl-row" style="width:${width}px;height:${h}px">`);
      for (const [c, k] of placed) {
        const on = picked && s.pick.scene === c.scene && s.pick.index === c.index;
        const marks = c.marks.slice(0, -1).map((m) => `<i class="mark" style="left:${(m - c.start) * px}px"></i>`).join("");
        parts.push(`<div class="tl-clip ${lane}${on ? " on" : picked ? " dim" : ""}" data-scene="${c.scene}" data-index="${c.index}" title="${esc(c.label)}"
          style="left:${X(c.start)}px;top:${4 + k * TRACK}px;width:${Math.max(8, (c.end - c.start) * px)}px">${marks}<b>${esc(c.label)}</b><i class="handle l"></i><i class="handle r"></i></div>`);
      }
      parts.push(`</div>`);
    }
    this.labels.innerHTML = labels.join("");
    parts.push(`<div class="ph"><b></b></div>`);
    this.inner.style.width = `${width}px`;
    this.inner.innerHTML = parts.join("");
    this.wire(s);
  }

  wire(s) {
    this.inner.querySelectorAll(".tl-seg").forEach((el) => {
      const i = Number(el.dataset.shot);
      el.addEventListener("click", (e) => !e.target.classList.contains("edge") && this.h.onPick({ kind: "shot", i }));
      el.querySelector(".edge")?.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        const g = s.segments[i];
        this.dragOn(el, e, (d) => (el.style.width = `${Math.max(this.px, (g.end - g.start + d) * this.px - 2)}px`), (d) => this.h.onSceneLength(g.scene, snap(Math.max(1, g.end - g.start + d))));
      });
    });
    this.inner.querySelectorAll(".tl-join").forEach((el) => el.addEventListener("click", () => this.h.onPick({ kind: "join", scene: Number(el.dataset.join) })));
    this.inner.querySelector(".tl-add")?.addEventListener("click", () => this.h.onAddScene());
    this.labels.querySelector(".add-key")?.addEventListener("click", () => this.h.onAddKey());
    // the camera's blocks: click picks one, dragging moves when it arrives; a ramp's end sets its move's length
    this.inner.querySelectorAll(".tl-clip.cam").forEach((el) => {
      const c = s.camera.find((k) => k.scene === Number(el.dataset.scene) && String(k.key ?? "") === el.dataset.key);
      if (!c) return;
      const pickIt = () => this.h.onPick({ kind: "cam", scene: c.scene, key: c.key });
      if (c.key == null) el.addEventListener("click", pickIt);
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        if (c.key == null) return; // the scene's own view starts with the scene: a click picks it
        const left0 = parseFloat(el.style.left);
        const label = el.querySelector("b");
        this.dragOn(el, e, (d) => {
          el.style.left = `${left0 + d * this.px}px`;
          label.textContent = clock(Math.max(0, c.start + d));
        }, (d) => this.h.onMoveKey(c.scene, c.key, snap(c.start + d - s.doc.sceneStart(c.scene))), pickIt);
      });
    });
    this.inner.querySelectorAll(".cam-dur").forEach((el) => {
      const c = s.camera.find((k) => k.scene === Number(el.dataset.scene) && k.key === Number(el.dataset.key));
      if (!c) return;
      el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        const dur0 = c.ramp ? c.ramp[1] - c.ramp[0] : 0;
        const x0 = parseFloat(el.style.left);
        // a view's move ends at its arrival (its ramp grows to the left); a shot's blend starts at its cut
        const sign = c.kind === "shot" ? 1 : -1;
        this.dragOn(el, e, (d) => (el.style.left = `${x0 + d * this.px}px`), (d) => this.h.onKeyDur(c.scene, c.key, snap(Math.max(0, dur0 + sign * d))));
      });
    });
    this.inner.querySelectorAll(".cam-end").forEach((el) => {
      const c = s.camera.find((k) => k.scene === Number(el.dataset.scene) && String(k.key ?? "") === el.dataset.key);
      if (!c) return;
      el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        const x0 = parseFloat(el.style.left);
        const lo = c.start - s.doc.sceneStart(c.scene);
        this.dragOn(el, e, (d) => (el.style.left = `${x0 + d * this.px}px`), (d) => this.h.onHoldEnd(c.scene, c.key, snap(Math.max(lo + 0.2, c.end - s.doc.sceneStart(c.scene) + d))));
      });
    });
    // a double-click on the camera lane's empty part: a camera move there
    this.inner.querySelector(".cam-row")?.addEventListener("dblclick", (e) => {
      if (e.target.closest(".tl-clip, .cam-dur, .cam-end")) return;
      this.h.onAddKeyAt(this.timeAt(e.clientX));
    });
    this.inner.querySelectorAll(".tl-clip:not(.cam)").forEach((el) => {
      const c = s.clips.find((k) => k.scene === Number(el.dataset.scene) && k.index === Number(el.dataset.index));
      if (!c) return;
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const what = e.target.classList.contains("l") ? "start" : e.target.classList.contains("r") ? "end" : "move";
        const left0 = parseFloat(el.style.left);
        const w0 = parseFloat(el.style.width);
        const label = el.querySelector("b");
        el.classList.add("dragging");
        this.dragOn(el, e, (d) => {
          if (what === "move") el.style.left = `${left0 + d * this.px}px`;
          else if (what === "start") {
            const dd = Math.min(d, c.end - c.start - 0.3);
            el.style.left = `${left0 + dd * this.px}px`;
            el.style.width = `${w0 - dd * this.px}px`;
          } else el.style.width = `${Math.max(0.3 * this.px, w0 + d * this.px)}px`;
          label.textContent = clock(Math.max(0, what === "end" ? c.end + d : c.start + d));
        }, (d) => {
          if (what === "move") this.h.onMove(c, Math.max(0, snap(c.start + d)));
          else if (what === "start") this.h.onTrim(c, snap(c.start + d), c.end);
          else this.h.onTrim(c, c.start, snap(c.end + d));
        }, () => this.h.onPick({ kind: "item", scene: c.scene, index: c.index }));
      });
    });
  }

  /** a drag from `e`: `move(dt)` as it goes, `done(dt)` when it moved, `click()` when it didn't */
  dragOn(el, e, move, done, click) {
    const x0 = e.clientX;
    let d = 0;
    let moved = false;
    this.drag = true;
    capture(el, e.pointerId);
    const onMove = (ev) => {
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (!moved) return;
      d = (ev.clientX - x0) / this.px;
      move(d);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      this.drag = null;
      if (moved && Math.abs(d) >= 0.05) done(d);
      else if (click) click();
      else this.render(true);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }
}
