// The camera a preview frame drew with (`map_engine::DrawnView`, packed), so the editor can turn a pointer
// on the frame into a place on the map. A port of the Android editor's DrawnView.kt: the same numbers, the
// same projection. Frame points are fractions of the frame, x right and y down.
const DEG = Math.PI / 180;
/** how near (a share of the frame, about a pixel on a 1280 frame) a placed point must come to the pointer */
const PLACE_TOLERANCE = 8e-4;
/** a placed point facing the eye less than this (cosine) is held only in part; at FACING_NONE not at all */
const FACING_FULL = 0.35;
const FACING_NONE = 0.12;

// vectors, as map_core's v3
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => scale(a, 1 / (len(a) || 1));
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// the flat map's shape, as map_core::math has it: wholly Web Mercator near, longitude/latitude far
const FLAT_MERCATOR_NEAR = 0.34;
const FLAT_MERCATOR_FAR = 1.93;
const MERCATOR_CAP = 89.5 * DEG;
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mercatorWeight = (dist) => 1 - smoothstep(Math.log(FLAT_MERCATOR_NEAR), Math.log(FLAT_MERCATOR_FAR), Math.log(Math.max(dist, 1e-12)));
function flatY(lat, merc) {
  const phi = lat * DEG;
  if (merc <= 0) return phi;
  const c = Math.max(-MERCATOR_CAP, Math.min(MERCATOR_CAP, phi));
  const psi = Math.asinh(Math.tan(c)) + (phi - c) / Math.cos(MERCATOR_CAP);
  return phi + (psi - phi) * merc;
}

export class DrawnView {
  /** `p`: the packed view (`map_engine::DRAWN_VIEW_LEN` numbers) */
  constructor(p) {
    this.p = p;
  }
  get t() { return this.p[0]; }
  /** 0 globe .. 1 flat */
  get morph() { return this.p[1]; }
  get lon() { return this.p[5]; }
  get lat() { return this.p[6]; }
  get dist() { return this.p[7]; }
  get pitch() { return this.p[8]; }
  get bearing() { return this.p[9]; }
  /** Geographic editing is supported only on undeformed globe/flat views. */
  get pickingSupported() { return this.p.length >= 43 && this.p[42] === 1; }

  /** The camera as the engine takes it: lon, lat (degrees), dist, pitch, bearing (radians). */
  camera() {
    return [this.lon, this.lat, this.dist, this.pitch, this.bearing];
  }

  /** Where the map point lands on the frame, [x, y], or null when it is behind the eye or the globe. */
  project(lonDeg, latDeg) {
    const p = this.p;
    if (!this.pickingSupported || !Number.isFinite(lonDeg) || !Number.isFinite(latDeg)) return null;
    const a = lonDeg * DEG, b = latDeg * DEG, m = this.morph;
    const x0 = Math.cos(b) * Math.sin(a) * (1 - m) + a * m;
    const y0 = Math.sin(b) * (1 - m) + b * m;
    const z0 = Math.cos(b) * Math.cos(a) * (1 - m) + 1 * m;
    const x = p[10] * x0 + p[14] * y0 + p[18] * z0 + p[22];
    const y = p[11] * x0 + p[15] * y0 + p[19] * z0 + p[23];
    const w = p[13] * x0 + p[17] * y0 + p[21] * z0 + p[25];
    if (w <= 1e-12) return null;
    if (m <= 0.5 && x0 * (p[2] - x0) + y0 * (p[3] - y0) + z0 * (p[4] - z0) <= 0) return null;
    return [(x / w + 1) * 0.5, (1 - y / w) * 0.5];
  }

  /**
   * The map point [lon, lat] under the frame point, or null where it misses the ground. `loose`: on the bare
   * globe (or plane) even where the frame's ground is raised by relief or half morphed, which picking
   * refuses: near enough for moving the camera, whose drag is relative.
   */
  unproject(fx, fy, loose = false) {
    const p = this.p;
    if ((!this.pickingSupported && !loose) || p.length < 43 || !Number.isFinite(fx) || !Number.isFinite(fy)) return null;
    const nx = fx * 2 - 1, ny = 1 - fy * 2;
    let dx = p[26] * nx + p[30] * ny + p[34];
    let dy = p[27] * nx + p[31] * ny + p[35];
    let dz = p[28] * nx + p[32] * ny + p[36];
    const l = Math.max(1e-12, Math.hypot(dx, dy, dz));
    dx /= l; dy /= l; dz /= l;
    const ex = p[2], ey = p[3], ez = p[4];
    if (this.morph > 0.5) {
      if (Math.abs(dz) < 1e-12) return null;
      const s = (1 - ez) / dz;
      return s > 0 ? [(ex + dx * s) / DEG, (ey + dy * s) / DEG] : null;
    }
    const b = ex * dx + ey * dy + ez * dz;
    const disc = b * b - (ex * ex + ey * ey + ez * ez - 1);
    if (disc < 0) return null;
    const s = -b - Math.sqrt(disc);
    if (s <= 0) return null;
    const x = ex + dx * s, y = ey + dy * s, z = ez + dz * s;
    return [Math.atan2(x, z) / DEG, Math.asin(Math.max(-1, Math.min(1, y))) / DEG];
  }

  /** The bare ground's point (world) under frame point (x, y) for camera `cam`, or null off the ground. */
  groundAt(cam, x, y) {
    return this.p.length < 43 ? null : this.hit(this.frameOf(cam), x, y);
  }

  /**
   * Camera `next` ([lon, lat, dist, pitch, bearing]: its distance, tilt and heading set) with the lon and
   * lat that put ground point `a` (world, `groundAt`) under frame point (x, y): the anchor of a zoom or a
   * drag. Null when there is none, or it isn't found within a few steps: the caller then leaves the
   * camera where it stands (a step that moved it elsewhere would be followed by one chasing another point).
   *
   * Turning the camera about the globe's centre doesn't change which frame points meet the globe: so
   * whether (x, y) can show any ground for `next` is one test, and the turn that takes the ground now under
   * (x, y) onto `a` all but gives the answer. Newton's method finishes it in a step or two (on the flat map
   * the same, from the shift on the plane).
   */
  place(a, next, x, y, edgeOn = false) {
    if (!a || this.p.length < 43) return null;
    const p = this.hit(this.frameOf(next), x, y);
    if (!p) return null;
    let lon, lat;
    if (this.morph > 0.5) {
      lon = next[0] + (a[0] - p[0]) / DEG;
      lat = next[1] + (a[1] - p[1]) / DEG;
    } else {
      // the turn about the centre that takes p onto a, applied to the camera's ground point (Rodrigues)
      const pu = norm(p), au = norm(a);
      const k = cross(pu, au), s = len(k), c = dot(pu, au);
      const b = next[1] * DEG, l = next[0] * DEG;
      let t = [Math.cos(b) * Math.sin(l), Math.sin(b), Math.cos(b) * Math.cos(l)];
      if (s > 1e-12) {
        const ku = scale(k, 1 / s);
        t = add(add(scale(t, c), scale(cross(ku, t), s)), scale(ku, dot(ku, t) * (1 - c)));
      }
      lon = Math.atan2(t[0], t[2]) / DEG;
      lat = Math.asin(Math.max(-1, Math.min(1, t[1]))) / DEG;
    }
    const miss = (lo, la) => {
      const f = this.frameOf([lo, la, next[2], next[3], next[4]]);
      const q = this.screen(f, a);
      // (on the globe the point must face the eye)
      if (!q || (this.morph <= 0.5 && dot(a, sub(f.eye, a)) <= 0)) return null;
      return [q[0] - x, q[1] - y];
    };
    const h = Math.max(1e-9, next[2] * 1e-4) / DEG;
    let e = miss(lon, lat);
    for (let i = 0; i < 6 && e && Math.hypot(e[0], e[1]) > PLACE_TOLERANCE / 4; i++) {
      const ex = miss(lon + h, lat), ey = miss(lon, lat + h);
      if (!ex || !ey) return null;
      const j00 = (ex[0] - e[0]) / h, j01 = (ey[0] - e[0]) / h, j10 = (ex[1] - e[1]) / h, j11 = (ey[1] - e[1]) / h;
      const det = j00 * j11 - j01 * j10;
      if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
      lon -= (j11 * e[0] - j01 * e[1]) / det;
      lat = Math.max(-85, Math.min(85, lat - (j00 * e[1] - j10 * e[0]) / det));
      e = miss(lon, lat);
    }
    if (!e || Math.hypot(e[0], e[1]) > PLACE_TOLERANCE) return null;
    if (!edgeOn || this.morph > 0.5) return [lon, lat, next[2], next[3], next[4]];
    // `edgeOn` (a zoom): near the globe's limb a point barely moves on the screen as the globe turns, and
    // keeping one there under the pointer swings the globe round with every step. As the point turns
    // edge-on the camera keeps less of the turn, and none at all from FACING_NONE (always continuous: a
    // share, never a switch). A drag holds one point, and takes it to the edge as asked.
    const eye = this.frameOf([lon, lat, next[2], next[3], next[4]]).eye;
    const facing = dot(norm(a), norm(sub(eye, a)));
    const w = smoothstep(FACING_NONE, FACING_FULL, facing);
    if (w >= 1) return [lon, lat, next[2], next[3], next[4]];
    let dl = (lon - next[0]) % 360;
    if (dl > 180) dl -= 360;
    if (dl < -180) dl += 360;
    return [next[0] + dl * w, next[1] + (lat - next[1]) * w, next[2], next[3], next[4]];
  }

  /** `place` for the ground point under (x0, y0) for camera `cam`: a zoom's anchor. */
  anchored(cam, next, x0, y0, x1, y1) {
    return this.place(this.groundAt(cam, x0, y0), next, x1, y1, true);
  }

  /** This frame's lens, from its ray matrix: the camera's axes, its half-extents and its shift. */
  lens() {
    if (this._lens) return this._lens;
    const p = this.p;
    const m0 = [p[26], p[27], p[28]], m4 = [p[30], p[31], p[32]], m8 = [p[34], p[35], p[36]];
    const x = norm(m0), y = norm(m4);
    this._lens = { x, y, z: cross(x, y), a: len(m0), b: len(m4), sx: dot(m8, x), sy: dot(m8, y) };
    return this._lens;
  }

  /** How high the frame's ground point stands (world units): relief raises the camera's target. */
  ground() {
    const { z } = this.lens();
    const t = sub([this.p[2], this.p[3], this.p[4]], scale(z, this.dist));
    return this.morph > 0.5 ? t[2] - 1 : len(t) - 1;
  }

  /**
   * Where camera `cam` stands and its axes, as the engine's orbit camera has them (map_core's
   * `orbit_frame` and `look_at`), on this frame's ground and morph.
   */
  frameOf(cam) {
    const [lon, lat, dist, pitch, bearing] = cam;
    const m = this.morph, g = this.ground();
    const a = lon * DEG, b = lat * DEG;
    const sphere = [Math.cos(b) * Math.sin(a), Math.sin(b), Math.cos(b) * Math.cos(a)];
    const n = norm(mix(sphere, [0, 0, 1], m));
    let north = mix([-Math.sin(b) * Math.sin(a), Math.cos(b), -Math.sin(b) * Math.cos(a)], [0, 1, 0], m);
    north = norm(sub(north, scale(n, dot(north, n))));
    const east = cross(north, n);
    const fwd = add(scale(north, Math.cos(bearing)), scale(east, Math.sin(bearing)));
    const target = mix(scale(sphere, 1 + g), [a, flatY(lat, mercatorWeight(dist)), 1 + g], m);
    const back = sub(scale(n, Math.cos(pitch)), scale(fwd, Math.sin(pitch)));
    const eye = add(target, scale(back, dist));
    const up = add(scale(fwd, Math.cos(pitch)), scale(n, Math.sin(pitch)));
    const z = norm(sub(eye, target));
    const x = norm(cross(up, z));
    return { eye, x, y: cross(z, x), z };
  }

  /** The bare ground's point (world) under frame point (fx, fy) seen from frame `f`, or null. */
  hit(f, fx, fy) {
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
    const l = this.lens();
    const d = norm(sub(add(scale(f.x, (fx * 2 - 1) * l.a + l.sx), scale(f.y, (1 - fy * 2) * l.b + l.sy)), f.z));
    const e = f.eye;
    if (this.morph > 0.5) {
      if (Math.abs(d[2]) < 1e-12) return null;
      const s = (1 - e[2]) / d[2];
      return s > 0 ? add(e, scale(d, s)) : null;
    }
    const b = dot(e, d);
    const disc = b * b - (dot(e, e) - 1);
    if (disc < 0) return null;
    const s = -b - Math.sqrt(disc);
    return s > 0 ? add(e, scale(d, s)) : null;
  }

  /** Where world point `w` lands on the frame seen from frame `f`, [x, y], or null behind the eye. */
  screen(f, w) {
    const l = this.lens();
    const v = sub(w, f.eye);
    const cz = -dot(v, f.z);
    if (cz <= 1e-12) return null;
    const nx = (dot(v, f.x) / cz - l.sx) / l.a;
    const ny = (dot(v, f.y) / cz - l.sy) / l.b;
    return [(nx + 1) * 0.5, (1 - ny) * 0.5];
  }

  /**
   * The move [dlon, dlat] that keeps the map point under a pointer going from frame point (x0, y0) to
   * (x1, y1), for the camera `cam` being sent (not the one this frame drew with, which trails it): measured
   * on this frame, then scaled by the zoom, turned by the heading and widened by the latitude between the
   * two. Null where the points miss the ground.
   */
  panFor(x0, y0, x1, y1, cam) {
    // (loose: the camera moves on any frame, relief or not; the Android editor's stops on raised ground)
    const a = this.unproject(x0, y0, true);
    const b = this.unproject(x1, y1, true);
    if (!a || !b) return null;
    let dl = a[0] - b[0];
    if (dl > 180) dl -= 360;
    if (dl < -180) dl += 360;
    const e = dl * Math.cos(this.lat * DEG), n = a[1] - b[1];
    const zoom = this.dist > 1e-12 ? cam[2] / this.dist : 1;
    const turn = cam[4] - this.bearing;
    const c = Math.cos(turn), s = Math.sin(turn);
    const e2 = (e * c + n * s) * zoom, n2 = (-e * s + n * c) * zoom;
    const k = Math.max(1e-6, Math.cos(cam[1] * DEG));
    return [e2 / k, n2];
  }
}
