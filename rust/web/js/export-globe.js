// The export's picture: a small pixel globe turning under the film's own route. While the map downloads a
// band of light sweeps it; while the frames render the route draws itself as far as they have got, the
// globe turning to keep its head in view; when the film is done the last stop lights up. A chart globe
// (sea and graticule, no coastlines), dithered like the landing page (dither.js, coast.js).
import { hex, threshold, tone } from "./dither.js";
import { hash, WATER } from "./coast.js";

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const PAPER = hex("#F2F0EA"), PIN = hex("#191917"), EMBER = hex("#E0733A"), LAMP = hex("#F4C95D");
const RAD = Math.PI / 180;
const CELL = 3; // CSS px a cell
const wrap = (a) => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
const unit = (lon, lat) => [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];

/**
 * The picture on `canvas`: `start(stops)`, then `set(phase, f)` as the export moves (phase "tiles" or
 * "frames", f in 0..1), `finish()` when the film is done, `stop()` when the dialog closes.
 */
export function exportGlobe(canvas) {
  const ctx = canvas.getContext("2d");
  let w = 0, h = 0, img = null;
  let pins = [], pinAt = [], route = []; // pins [lon, lat] and how far along the route each is; route [lon, lat, how far]
  let phase = "tiles", f = 0, shown = 0, done = false, running = false;
  let lon0 = 0, lat0 = 0.35, t = 0, last = 0;
  let mid = [0, 0], spread = Math.PI / 2; // the route's middle, and how far from it its farthest point lies
  let length = 0; // the route's, in radians

  // each leg along its great circle, sampled about every degree
  function chart(stops) {
    pins = stops.map((s) => [s.lon * RAD, s.lat * RAD]);
    route = [];
    pinAt = [0];
    let total = 0;
    for (let i = 0; i < pins.length - 1; i++) {
      const a = unit(...pins[i]), b = unit(...pins[i + 1]);
      const ang = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
      const n = Math.max(2, Math.ceil(ang / (0.1 * RAD))); // a tenth of a degree: unbroken even when near
      for (let k = i ? 1 : 0; k <= n; k++) {
        const u = k / n, sa = Math.sin((1 - u) * ang), sb = Math.sin(u * ang), s = Math.sin(ang) || 1;
        const p = ang < 1e-6 ? a : a.map((_, c) => (sa * a[c] + sb * b[c]) / s);
        route.push([Math.atan2(p[1], p[0]), Math.asin(Math.max(-1, Math.min(1, p[2]))), total + u * ang]);
      }
      total += ang;
      pinAt.push(total);
    }
    length = total;
    for (const r of route) r[2] = total ? r[2] / total : 1;
    pinAt = pinAt.map((g) => (total ? g / total : 1));
    // its middle: the mean of its points, and the widest angle from there to any of them
    const m = [0, 0, 0];
    for (const [lon, lat] of route) unit(lon, lat).forEach((v, c) => (m[c] += v));
    const ml = Math.hypot(...m) || 1, mu = m.map((v) => v / ml);
    mid = [Math.atan2(mu[1], mu[0]), Math.asin(mu[2])];
    spread = Math.max(0.02, ...route.map(([lon, lat]) => Math.acos(Math.min(1, unit(lon, lat).reduce((a, v, c) => a + v * mu[c], 0)))));
    [lon0, lat0] = whole() ? [pins[0]?.[0] ?? 0, Math.max(-0.6, Math.min(0.6, (pins[0]?.[1] ?? 0) * 0.7))] : mid;
  }

  /** the globe's radius in cells: as close as the route allows, so it fills the picture; whole for long ones */
  const radius = () => Math.max(h * 0.4, Math.min(h * 6, (Math.min(w, h * 1.6) * 0.34) / Math.sin(Math.min(spread, 1.4))));
  /** the whole globe shows (and turns to follow the route) only when the route reaches round it */
  const whole = () => spread > 1.1;

  /** where on the route `g` (0..1) of it is */
  function at(g) {
    for (let i = 1; i < route.length; i++) if (route[i][2] >= g) return route[i];
    return route.at(-1) ?? [lon0, lat0, 0];
  }

  function draw() {
    const r = canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width / CELL)), H = Math.max(1, Math.round(r.height / CELL));
    if (W !== w || H !== h || !img) {
      w = canvas.width = W;
      h = canvas.height = H;
      img = ctx.createImageData(w, h);
    }
    const R = radius(), cx = w / 2, cy = h / 2;
    // a graticule line about a cell wide: every 30 degrees on the whole globe, closer when near
    const step = R > h * 2.5 ? 5 : R > h ? 10 : 30, line = (0.6 / R) / RAD;
    const s0 = Math.sin(lat0), c0 = Math.cos(lat0);
    const band = phase === "tiles" && !done ? ((t * 0.35) % 1.4) * 2 - 1.2 : null; // the scan, top to bottom
    const d = img.data;
    for (let y = 0, i = 0; y < h; y++)
      for (let x = 0; x < w; x++, i += 4) {
        const nx = (x + 0.5 - cx) / R, ny = (cy - y - 0.5) / R, r2 = nx * nx + ny * ny;
        let c = null;
        if (r2 > 1) {
          const halo = (1.12 - Math.sqrt(r2)) / 0.12;
          if (halo > 0 && halo * 0.6 > threshold(x, y)) c = WATER[4];
        } else {
          const nz = Math.sqrt(1 - r2);
          const lat = Math.asin(nz * s0 + ny * c0), lon = lon0 + Math.atan2(nx, nz * c0 - ny * s0);
          // lit from the upper left; the scan sweeps the picture, near or far; the graticule dotted
          let v = 0.5 + Math.max(0, -nx * 0.5 + ny * 0.45 + nz * 0.75) * 3.6;
          if (band != null) v += Math.exp(-(((y + 0.5) / h * 2 - 1 - band) ** 2) * 30) * 1.6;
          const glat = Math.abs(lat / RAD / step - Math.round(lat / RAD / step)) * step;
          const glon = Math.abs(wrap(lon) / RAD / step - Math.round(wrap(lon) / RAD / step)) * step * Math.cos(lat);
          if ((glat < line || glon < line) && (x + y) % 2 === 0) v = Math.max(v + 1.1, 3.2);
          c = tone(WATER, v, threshold(x, y));
        }
        if (c) {
          d[i] = c[0];
          d[i + 1] = c[1];
          d[i + 2] = c[2];
          d[i + 3] = 255;
        } else d[i + 3] = 0;
      }
    // the route: drawn as far as the frames, a faint dotted course ahead
    const put = (lon, lat, col, size = 0) => {
      const cl = Math.cos(lat), dl = lon - lon0;
      if (s0 * Math.sin(lat) + c0 * cl * Math.cos(dl) <= 0) return null; // behind the globe
      const X = Math.floor(cx + cl * Math.sin(dl) * R), Y = Math.floor(cy - (c0 * Math.sin(lat) - s0 * cl * Math.cos(dl)) * R);
      for (let dy = -size; dy <= size; dy++)
        for (let dx = -size; dx <= size; dx++) {
          const px = X + dx, py = Y + dy;
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          const k = (py * w + px) * 4;
          [d[k], d[k + 1], d[k + 2], d[k + 3]] = [col[0], col[1], col[2], 255];
        }
      return [X, Y];
    };
    route.forEach(([lon, lat, g]) => {
      if (g <= shown) put(lon, lat, EMBER);
      else if ((g * length * R) % 4 < 1.2) put(lon, lat, WATER[5]); // dashes a cell long, four apart, however near
    });
    pins.forEach(([lon, lat], k) => {
      put(lon, lat, PIN, 1);
      const reached = pinAt[k] <= shown + 1e-3;
      put(lon, lat, done && k === pins.length - 1 ? LAMP : reached ? PAPER : WATER[3]);
    });
    // the head of the route, or sparks from the last stop when it's done
    if (route.length && phase === "frames" && !done) {
      const [lon, lat] = at(shown);
      const p = put(lon, lat, PAPER, 1);
      if (p && !still) ring(d, p[0], p[1], 2 + ((t * 4) % 4), PAPER);
    }
    if (done && pins.length) {
      const [lon, lat] = pins.at(-1);
      const p = put(lon, lat, LAMP);
      if (p) for (let k = 0; k < 2; k++) ring(d, p[0], p[1], 2 + ((t * 3 + k * 2.5) % 5), k ? EMBER : LAMP);
    }
    ctx.putImageData(img, 0, 0);
  }

  function ring(d, x, y, r, col) {
    for (let a = 0; a < 24; a++) {
      const q = (a / 24) * Math.PI * 2;
      const px = Math.round(x + Math.cos(q) * r), py = Math.round(y + Math.sin(q) * r);
      if (px < 0 || py < 0 || px >= w || py >= h || hash(a, Math.floor(r)) > 0.7) continue;
      const k = (py * w + px) * 4;
      [d[k], d[k + 1], d[k + 2], d[k + 3]] = [col[0], col[1], col[2], 255];
    }
  }

  const loop = (now) => {
    if (!running) return;
    requestAnimationFrame(loop);
    if (now - last < 50) return; // 20 a second: the export has the GPU, this the main thread
    const dt = last ? Math.min(0.2, (now - last) / 1000) : 0;
    last = now;
    if (!still) t += dt;
    const goal = done ? 1 : phase === "frames" ? f : 0;
    shown += (goal - shown) * Math.min(1, dt * 3);
    // a near globe holds on the route's middle; the whole one turns toward its head while it draws, else drifts
    if (!whole()) {
      lon0 += wrap(mid[0] - lon0) * Math.min(1, dt * 2);
      lat0 += (mid[1] - lat0) * Math.min(1, dt * 2);
    } else if (phase === "frames" && !done && route.length) {
      const [lon, lat] = at(shown);
      lon0 += wrap(lon - lon0) * Math.min(1, dt * 1.5);
      lat0 += (Math.max(-0.6, Math.min(0.6, lat * 0.7)) - lat0) * Math.min(1, dt * 1.5);
    } else if (!still) lon0 += dt * 0.15;
    draw();
  };

  return {
    start(stops) {
      chart(stops);
      phase = "tiles";
      f = shown = 0;
      done = false;
      t = last = 0;
      if (!running) {
        running = true;
        requestAnimationFrame(loop);
      }
    },
    set(p, g) {
      if (p !== phase) f = 0;
      phase = p;
      f = Math.max(f, g);
    },
    finish() {
      done = true;
    },
    stop() {
      running = false;
    },
    /** A still of `stops`' route, whole, its last stop lit (the library's picture of it): drawn once, at the
     * canvas's size as laid out. */
    picture(stops) {
      running = false;
      chart(stops);
      phase = "frames";
      f = shown = 1;
      done = true;
      t = 0;
      draw();
    },
  };
}
