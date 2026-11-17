// A story file, read for the editor and edited in place: the Android app's StoryDoc. The JSON stays the
// source of truth: the editor changes only fields it understands and keeps the rest as written, so the
// engine always gets a story it already knows how to render.

/** the editor's own name for an item; the engine keeps fields it doesn't know and ignores them */
export const NAME = "editorName";
/** a route made of legs carries its route's id on every leg */
export const ROUTE = "editorRoute";

const TRAVELS = new Set(["route", "sea", "march", "leg"]);
export const travels = (o) => TRAVELS.has(o.type);

/** The timeline's rows under the shots. */
export const LANES = ["titles", "routes", "highlights", "pins"];

export function laneOf(o) {
  const type = o.type || "";
  const kind = o.kind || "";
  if (type === "text" || (type === "fx" && /^(cap-|label-|text-)/.test(kind))) return "titles";
  if (TRAVELS.has(type) || (type === "fx" && /^(arrow-|route-)/.test(kind))) return "routes";
  if (["highlight", "area", "region", "mapfx"].includes(type)) return "highlights";
  if (["city", "visit", "battle", "media", "sticker", "infographic", "stats"].includes(type)) return "pins";
  return null;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** what a clip is called on the timeline: the editor's own name for it, else what the item says */
export function nameOf(o) {
  if (o[NAME]) return o[NAME];
  const regions = ["countries", "states", "districts"]
    .flatMap((k) => (Array.isArray(o[k]) ? o[k].map((n) => String(n).split(",")[0]) : []))
    .join(", ");
  const name = {
    text: () => o.text,
    fx: () => o.text || cap((o.kind || "").split("-").slice(1).join("-")),
    sea: () => o.label || o.id || "Sea route",
    route: () => o.label || o.id || (o.line === "arc" ? "Flight" : "Route"),
    leg: () => `${o.from} → ${o.to}`,
    march: () => o.label || "March",
    highlight: () => regions || "Highlight",
    area: () => regions || "Highlight",
    region: () => o.label || "Area",
    city: () => o.label || o.name,
    battle: () => o.label || o.name,
    visit: () => o.place,
    media: () => o.caption || "Photo",
    sticker: () => cap(o.kind),
    mapfx: () => cap(o.kind),
    infographic: () => "Chart",
    stats: () => "Chart",
  }[o.type];
  return (name && name()) || o.type || "item";
}

const r2 = (v) => Math.round(v * 100) / 100;
/** a scene's length when it gives none (or none that is a positive number): the engine's
 * (map-engine's narrative::schema::SCENE_DURATION), so the timeline and the frames agree */
export const SCENE_DURATION = 8;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class StoryDoc {
  constructor(json) {
    this.root = typeof json === "string" ? JSON.parse(json) : json;
    if (!Array.isArray(this.root.scenes)) this.root.scenes = [];
    if (!this.root.map || typeof this.root.map !== "object") this.root.map = {};
  }

  json() {
    return JSON.stringify(this.root);
  }

  /** The story as the engine gets it: each item tagged `_ed: [scene, item]`, so the frame reports where it drew each title (the saved file never has the tags) */
  engineJson() {
    const copy = JSON.parse(JSON.stringify(this.root));
    copy.scenes.forEach((sc, i) => (sc.items || []).forEach((it, j) => { it._ed = [i, j]; }));
    return JSON.stringify(copy);
  }

  get scenes() {
    return this.root.scenes;
  }
  get title() {
    return this.root.title || "Untitled film";
  }
  set title(v) {
    this.root.title = v;
  }
  get sceneCount() {
    return this.scenes.length;
  }
  sceneDur(i) {
    if (!this.scenes[i]) return 0;
    const d = this.scenes[i].duration;
    // (as the engine reads it: a number, finite and positive; anything else is the default)
    return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : SCENE_DURATION;
  }
  sceneStart(i) {
    let s = 0;
    for (let k = 0; k < i; k++) s += this.sceneDur(k);
    return s;
  }
  get duration() {
    return this.scenes.reduce((s, _, i) => s + this.sceneDur(i), 0);
  }
  sceneIndexAt(t) {
    let s0 = 0;
    for (let i = 0; i < this.scenes.length; i++) {
      const d = this.sceneDur(i);
      if (t < s0 + d || i === this.scenes.length - 1) return i;
      s0 += d;
    }
    return 0;
  }
  itemsOf(i) {
    const sc = this.scenes[i];
    if (!Array.isArray(sc.items)) sc.items = [];
    return sc.items;
  }
  cameraOf(i) {
    const sc = this.scenes[i];
    if (!sc.camera || typeof sc.camera !== "object") sc.camera = {};
    return sc.camera;
  }

  /**
   * The shots strip: the scenes when the story has several, else the shots between the one scene's camera
   * keys. { label, start, end, scene, key, move }
   */
  segments() {
    const sc = this.scenes;
    if (sc.length > 1)
      return sc.map((s, i) => {
        const start = this.sceneStart(i);
        return { label: s.caption || `Scene ${i + 1}`, start, end: start + this.sceneDur(i), scene: i, key: null, move: s.camera?.move || "cut" };
      });
    const s = sc[0];
    if (!s) return [];
    const d = this.sceneDur(0);
    const keys = s.camera?.keys;
    const move = s.camera?.move || "cut";
    if (!Array.isArray(keys) || !keys.length) return [{ label: s.caption || "Scene 1", start: 0, end: d, scene: 0, key: null, move }];
    const out = [];
    const firstAt = Number(keys[0]?.at ?? d);
    if (firstAt > 0.05) out.push({ label: "Opening", start: 0, end: firstAt, scene: 0, key: null, move });
    keys.forEach((k, i) => {
      const at = Number(k.at) || 0;
      const end = keys[i + 1] ? Number(keys[i + 1].at) || d : d;
      const preset = k.shot?.preset;
      out.push({ label: preset ? cap(preset.replace(/-/g, " ")) : `Shot ${i + 1}`, start: at, end, scene: 0, key: i, move: k.move || "cut" });
    });
    return out;
  }

  /** The scenes on the film's clock, one segment each (the camera's moves are the Camera lane's). */
  sceneSegments() {
    return this.scenes.map((sc, i) => {
      const start = this.sceneStart(i);
      return { label: sc.caption || `Scene ${i + 1}`, start, end: start + this.sceneDur(i), scene: i, key: null, move: sc.camera?.move || "cut" };
    });
  }

  /** Every item the timeline shows, in its lane, on the film's clock. A route's legs are one clip. */
  clips() {
    const out = [];
    this.scenes.forEach((sc, i) => {
      const s0 = this.sceneStart(i);
      const d = this.sceneDur(i);
      const chains = new Map();
      (sc.items || []).forEach((it, j) => {
        const lane = laneOf(it);
        if (!lane) return;
        const at = Number(it.at) || 0;
        const end = travels(it) ? at + (Number(it.dur) || 4) : it.until != null ? Number(it.until) : it.dur != null ? at + Number(it.dur) : d;
        const clip = { lane, scene: i, index: j, type: it.type, label: nameOf(it), start: s0 + at, end: s0 + Math.max(at + 0.3, Math.min(end, d)), marks: [] };
        const chain = it[ROUTE];
        if (chain) {
          const c = chains.get(chain);
          if (c) {
            c.end = Math.max(c.end, clip.end);
            c.marks.push(clip.end);
            c.legs.push(j);
            return;
          }
          clip.route = chain;
          clip.legs = [j];
          clip.marks = [clip.end];
          chains.set(chain, clip);
        }
        out.push(clip);
      });
    });
    return out;
  }

  item(c) {
    return this.itemsOf(c.scene)[c.index];
  }

  /** Moves `c` to start at `start` (film clock), into another scene if it lands there. Returns its ref. */
  moveClip(c, start) {
    const to = this.sceneIndexAt(clamp(start, 0, Math.max(0, this.duration - 0.1)));
    const legs = c.legs || [c.index];
    const delta = start - c.start;
    if (to === c.scene || c.route) {
      // a route's legs move together, inside their scene
      for (const j of legs) {
        const o = this.itemsOf(c.scene)[j];
        const at = clamp((Number(o.at) || 0) + delta, 0, Math.max(0, this.sceneDur(c.scene) - 0.2));
        if (o.until != null) o.until = r2(Number(o.until) + (at - (Number(o.at) || 0)));
        o.at = r2(at);
      }
      return { scene: c.scene, index: c.index };
    }
    const obj = this.item(c);
    this.itemsOf(c.scene).splice(c.index, 1);
    this.itemsOf(to).push(obj);
    const at = clamp(start - this.sceneStart(to), 0, Math.max(0, this.sceneDur(to) - 0.2));
    const old = Number(obj.at) || 0;
    obj.at = r2(at);
    if (obj.until != null) obj.until = r2(at + (Number(obj.until) - old));
    return { scene: to, index: this.itemsOf(to).length - 1 };
  }

  /** Trims `c` to [start, end] within its scene: a route's travel time, anything else's time on screen. */
  trimClip(c, start, end) {
    const obj = this.item(c);
    const s0 = this.sceneStart(c.scene);
    const d = this.sceneDur(c.scene);
    const at = clamp(start - s0, 0, Math.max(0, d - 0.3));
    const until = Math.max(at + 0.3, Math.min(end - s0, d));
    obj.at = r2(at);
    if (travels(obj)) obj.dur = r2(until - at);
    else obj.until = r2(until);
  }

  deleteClip(c) {
    const legs = (c.legs || [c.index]).slice().sort((a, b) => b - a);
    for (const j of legs) this.itemsOf(c.scene).splice(j, 1);
  }

  duplicate(c) {
    const copy = JSON.parse(JSON.stringify(this.item(c)));
    delete copy.id;
    this.itemsOf(c.scene).push(copy);
    const ref = { scene: c.scene, index: this.itemsOf(c.scene).length - 1 };
    return this.moveClip({ ...c, ...ref, legs: null, route: null }, c.end);
  }

  /** Add `item` at film time `t`; returns where it went. */
  addItem(item, t) {
    const i = this.sceneIndexAt(t);
    item.at = r2(clamp(t - this.sceneStart(i), 0, Math.max(0, this.sceneDur(i) - 0.3)));
    this.itemsOf(i).push(item);
    return { scene: i, index: this.itemsOf(i).length - 1 };
  }

  // ---- scenes

  setSceneLength(i, seconds) {
    this.scenes[i].duration = r2(clamp(seconds, 1, 600));
  }
  renameScene(i, caption) {
    if (caption) this.scenes[i].caption = caption;
    else delete this.scenes[i].caption;
  }
  /** a new scene after the last, where the last one's camera starts */
  addScene() {
    const last = this.scenes[this.scenes.length - 1];
    const view = last?.camera?.view ? { ...last.camera.view } : { lon: 0, lat: 20, dist: 3 };
    this.scenes.push({ duration: 6, caption: `Scene ${this.scenes.length + 1}`, camera: { view, move: "fly" }, items: [] });
    return this.scenes.length - 1;
  }
  deleteScene(i) {
    if (this.scenes.length > 1) this.scenes.splice(i, 1);
  }
  sceneMove(i) {
    return this.scenes[i]?.camera?.move || "cut";
  }
  setSceneMove(i, move) {
    this.cameraOf(i).move = move;
  }
  motion(seg) {
    return seg.key != null ? null : this.scenes[seg.scene]?.camera?.motion || "still";
  }
  setMotion(seg, motion) {
    this.cameraOf(seg.scene).motion = motion;
  }
  transition(i) {
    return this.scenes[i]?.transition?.type || "";
  }
  setTransition(i, type) {
    if (type) this.scenes[i].transition = { type, dur: 1.0 };
    else delete this.scenes[i].transition;
  }
  // ---- the camera's keys (the Camera lane): each scene opens on its own view, then each key in turn. A view
  // key arrives at `at`, its move starting `dur` before; a shot key cuts at `at` to its rig, blending in over
  // `dur`. Each holds until the next key.

  keysOf(scene) {
    const k = this.scenes[scene]?.camera?.keys;
    return Array.isArray(k) ? k : [];
  }

  /**
   * The Camera lane: { scene, key (null: the scene's own view), start, end, ramp: [a, b] (its move, film
   * time; null for none), kind: "base" | "view" | "shot", move, label }.
   */
  cameraClips() {
    const out = [];
    this.scenes.forEach((sc, i) => {
      const s0 = this.sceneStart(i);
      const d = this.sceneDur(i);
      const keys = this.keysOf(i);
      const cam = sc.camera || {};
      const firstAt = keys.length ? Math.min(d, Number(keys[0].at) || 0) : d;
      if (firstAt > 0.05) {
        const dur = Math.min(Number(cam.dur) || 0, firstAt);
        out.push({ scene: i, key: null, start: s0, end: s0 + firstAt, ramp: i > 0 && cam.move && cam.move !== "cut" && dur > 0 ? [s0, s0 + dur] : null, kind: "base", move: cam.move || "cut", label: `${sc.caption || `Scene ${i + 1}`} · ${cam.motion || "still"}` });
      }
      keys.forEach((k, j) => {
        const at = Math.max(0, Math.min(d, Number(k.at) || 0));
        const end = j + 1 < keys.length ? Math.min(d, Number(keys[j + 1].at) || d) : d;
        const dur = Math.max(0, Number(k.dur) || 0);
        const shot = !!k.shot;
        const ramp = k.move === "cut" || dur <= 0 ? null : shot ? [s0 + at, s0 + Math.min(end, at + dur)] : [s0 + Math.max(0, at - dur), s0 + at];
        const what = shot ? (k.shot.preset || k.shot.rig || "shot").replace(/-/g, " ") : "view";
        out.push({ scene: i, key: j, start: s0 + at, end: s0 + Math.max(at + 0.1, end), ramp, kind: shot ? "shot" : "view", move: k.move || "cut", label: k.editorIntro ? "Opening · flies in" : `${cap(k.move || "cut")} · ${what}` });
      });
    });
    return out;
  }

  /**
   * How the film opens. The engine opens a first scene on a wide globe view and flies in unless it cuts, so:
   *  "space"    the engine's own: fly in from the globe (`camera.move` fly, its `dur` and `start`)
   *  "straight" open right on the scene's view (`camera.move` cut)
   *  "custom"   open on `start` (a view) and fly to the scene's view: the scene's own view becomes a first
   *             camera key, marked `editorIntro` (the engine keeps fields it doesn't know)
   */
  opening() {
    const cam = this.scenes[0]?.camera || {};
    const intro = this.keysOf(0).find((k) => k.editorIntro);
    if (intro) return { kind: "custom", start: cam.view || null, dur: Number(intro.dur) || 3, wait: Math.max(0, (Number(intro.at) || 0) - (Number(intro.dur) || 3)) };
    if ((cam.move || "cut") === "cut") return { kind: "straight" };
    return { kind: "space", dur: Number(cam.dur) || 3.4, wait: cam.start != null ? Number(cam.start) : 0.6 };
  }

  setOpening(kind, start) {
    const cam = this.cameraOf(0);
    const keys = (cam.keys ||= []);
    // an earlier custom opening: its target is the scene's view again
    const j = keys.findIndex((k) => k.editorIntro);
    if (j >= 0) {
      cam.view = keys[j].view;
      keys.splice(j, 1);
    }
    if (!keys.length) delete cam.keys;
    if (kind === "straight") {
      cam.move = "cut";
      delete cam.dur;
      delete cam.start;
    } else if (kind === "space") {
      cam.move = cam.move && cam.move !== "cut" ? cam.move : "fly";
      cam.dur ??= 3.4;
      cam.start ??= 0.6;
    } else if (kind === "custom" && start) {
      const target = cam.view || start;
      const dur = clamp(Number(cam.dur) || 3.4, 0.5, 10);
      delete cam.start;
      delete cam.dur;
      cam.view = start;
      cam.move = "cut";
      const first = { at: r2(0.6 + dur), view: target, move: "fly", dur, editorIntro: true };
      const list = (cam.keys ||= []);
      let at = list.findIndex((k) => (Number(k.at) || 0) > first.at);
      if (at < 0) at = list.length;
      list.splice(at, 0, first);
    }
  }

  /** the opening's timing: `wait` seconds, then `dur` seconds of flying in */
  setOpeningTiming(wait, dur) {
    const cam = this.cameraOf(0);
    const intro = this.keysOf(0).find((k) => k.editorIntro);
    if (intro) {
      intro.dur = r2(clamp(dur, 0.3, 12));
      intro.at = r2(clamp(wait, 0, 20) + intro.dur);
    } else {
      cam.dur = r2(clamp(dur, 0.3, 12));
      cam.start = r2(clamp(wait, 0, 10));
    }
  }

  /** How long key `key` holds: until the next camera key, or the scene's end. */
  holdEnd(scene, key) {
    const keys = this.keysOf(scene);
    return key + 1 < keys.length ? Number(keys[key + 1].at) || 0 : this.sceneDur(scene);
  }

  /** Camera `key` (null: the scene's own view) now holds until scene time `end`: the next key arrives then. */
  setHoldEnd(scene, key, end) {
    const keys = this.keysOf(scene);
    const next = (key == null ? 0 : key + 1);
    if (next >= keys.length) return;
    const from = key == null ? 0.1 : (Number(keys[key].at) || 0) + 0.1;
    const to = next + 1 < keys.length ? (Number(keys[next + 1].at) || 0) - 0.1 : this.sceneDur(scene) - 0.1;
    keys[next].at = r2(clamp(end, from, Math.max(from, to)));
  }

  /** Key `key` of `scene` arrives (or cuts) at scene time `at`, kept between its neighbours. */
  moveKey(scene, key, at) {
    const keys = this.keysOf(scene);
    const lo = key > 0 ? (Number(keys[key - 1].at) || 0) + 0.1 : 0;
    const hi = key + 1 < keys.length ? (Number(keys[key + 1].at) || 0) - 0.1 : this.sceneDur(scene) - 0.1;
    keys[key].at = r2(clamp(at, lo, Math.max(lo, hi)));
  }

  /** How long key `key`'s move takes (0: a cut's length; its move word stays). */
  setKeyDur(scene, key, dur) {
    const k = this.keysOf(scene)[key];
    k.dur = r2(clamp(dur, 0, 30));
    // (a cut has no length: stretching it makes a glide)
    if (k.dur > 0 && (k.move || "cut") === "cut" && !k.shot) k.move = "glide";
  }

  /** A new view key at film time `t`, arriving at `view` (gliding there over two seconds); its index. */
  addKey(t, view) {
    const i = this.sceneIndexAt(t);
    const at = r2(clamp(t - this.sceneStart(i), 0.1, Math.max(0.1, this.sceneDur(i) - 0.1)));
    const keys = (this.cameraOf(i).keys ||= []);
    const same = keys.findIndex((k) => Math.abs((Number(k.at) || 0) - at) < 0.05);
    const key = { at, view, move: "glide", dur: 2 };
    if (same >= 0) {
      keys[same] = { ...keys[same], view };
      delete keys[same].shot;
      return { scene: i, key: same };
    }
    let j = keys.findIndex((k) => (Number(k.at) || 0) > at);
    if (j < 0) j = keys.length;
    keys.splice(j, 0, key);
    return { scene: i, key: j };
  }

  deleteKey(scene, key) {
    const keys = this.keysOf(scene);
    keys.splice(key, 1);
    if (!keys.length) delete this.scenes[scene].camera.keys;
  }

  /** Where the camera at `t` lives: its scene, and the camera key in force (null: the scene's own view). */
  cameraSlot(t) {
    const i = this.sceneIndexAt(t);
    const local = t - this.sceneStart(i);
    const keys = this.scenes[i]?.camera?.keys;
    let key = null;
    if (Array.isArray(keys)) keys.forEach((k, j) => { if ((Number(k.at) || 0) <= local + 1e-3) key = j; });
    const name = this.scenes[i]?.caption || `Scene ${i + 1}`;
    return { scene: i, key, label: key == null ? name : `${name} · shot ${key + 1}` };
  }

  /**
   * What steers the camera at `t` instead of its view, if anything: a shot rig on the camera key, or a route
   * whose camera follows its model while it travels. Hand-framing there has to let go of it first.
   */
  follower(t) {
    const slot = this.cameraSlot(t);
    if (slot.key != null && this.cameraOf(slot.scene).keys[slot.key]?.shot) return "the shot's rig";
    const local = t - this.sceneStart(slot.scene);
    for (const it of this.itemsOf(slot.scene)) {
      const follows =
        it.type === "leg" ? (it.camera ?? (it.vehicle ? "chase" : "none")) !== "none"
        : it.type === "route" || it.type === "sea" ? !!it.model && (it.follow === true || typeof it.follow === "string")
        : false;
      const at = Number(it.at) || 0;
      if (follows && local >= at && local <= at + (Number(it.dur) || 4)) return nameOf(it);
    }
    return null;
  }

  /** Let the camera at `t` go from what steers it (`follower`): the hand-framed view rules there. */
  releaseFollower(t) {
    const slot = this.cameraSlot(t);
    if (slot.key != null) delete this.cameraOf(slot.scene).keys[slot.key].shot;
    const local = t - this.sceneStart(slot.scene);
    for (const it of this.itemsOf(slot.scene)) {
      const at = Number(it.at) || 0;
      if (local < at || local > at + (Number(it.dur) || 4)) continue;
      if (it.type === "leg") it.camera = "none";
      else if (it.type === "route" || it.type === "sea") delete it.follow;
    }
  }

  /** Writes a hand-framed camera (lon, lat degrees, dist, pitch, bearing radians) where the camera at `t` lives. */
  setCamera(t, cam) {
    const slot = this.cameraSlot(t);
    const r = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
    const view = { lon: r(cam[0], 4), lat: r(cam[1], 4), dist: r(cam[2], 5), pitch: r(cam[3], 4), bearing: r(cam[4], 4) };
    const c = this.cameraOf(slot.scene);
    if (slot.key == null) c.view = view;
    else c.keys[slot.key].view = view;
  }

  /** the view the scene's camera starts from (a new pin or title goes there) */
  viewAt(t) {
    const i = this.sceneIndexAt(t);
    return this.scenes[i]?.camera?.view || this.root.map?.view || { lon: 0, lat: 20 };
  }

  // ---- the look: the whole film (`scene` null), or one scene, which shows the film's until it has its own

  setting(scene, key) {
    const own = scene == null ? undefined : this.scenes[scene]?.map?.[key];
    return own !== undefined ? own : this.root.map[key];
  }
  setSetting(scene, key, value) {
    const target = scene == null ? this.root.map : (this.scenes[scene].map ||= {});
    if (value == null) delete target[key];
    else target[key] = value;
    if (scene != null && !Object.keys(target).length) delete this.scenes[scene].map;
  }
  overrides(scene) {
    return Object.keys(this.scenes[scene]?.map || {}).length > 0;
  }
  /** a photo ground (satellite, relief, night lights): its look's own OSM layer goes */
  setGround(scene, basemap) {
    this.setSetting(scene, "basemap", basemap);
    this.clearOsm(scene);
    this.followFilm(scene, ["style", "basemap"]);
  }
  /** a styled map: shown whole (no photo ground under it), with its own OSM layer */
  setLook(scene, style) {
    this.setSetting(scene, "style", style);
    this.setSetting(scene, "basemap", null);
    this.clearOsm(scene);
    this.followFilm(scene, ["style", "basemap"]);
  }
  /** a choice for the whole film (scene null) is also each scene's: their own `keys` for it are dropped, or they would hide it */
  followFilm(scene, keys) {
    if (scene != null) return;
    this.scenes.forEach((_, i) => {
      keys.forEach((k) => this.setSetting(i, k, null));
      this.clearOsm(i);
    });
  }
  clearOsm(scene) {
    const details = this.setting(scene, "details");
    if (details && typeof details === "object" && "osm" in details) {
      const d = { ...details };
      delete d.osm;
      this.setSetting(scene, "details", Object.keys(d).length ? d : null);
    }
  }
}

/** A film to start from: one scene over `view`. */
export function blankStory(title = "", view = { lon: 14.48, lat: 40.62, dist: 0.6, pitch: 0.5236, bearing: 0 }) {
  // (pitch and bearing are radians, as the engine's camera: 30° of tilt)
  return {
    title,
    map: { style: "Maps", livingOcean: true, shadows: true },
    scenes: [{ duration: 12, caption: "Opening", camera: { view, move: "cut", motion: "swing" }, items: [] }],
  };
}
