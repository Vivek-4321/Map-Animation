// The website footer's dither, as the Android app draws it (Dither.kt): a 4×4 Bayer threshold picks between
// neighbouring tones of a palette. Cells are one pixel each in a small canvas, scaled up without filtering.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
export const LEAF = ["#142112", "#1F2F1A", "#689246", "#B0CE76"].map(hex);
export const SEA = ["#082830", "#0C4A56", "#1D8696", "#6EC4CC"].map(hex);

export const threshold = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;

/** v in [0, n]: the cell is the lower or upper neighbouring tone by its threshold */
export function tone(pal, v, thr) {
  const n = pal.length - 1;
  const c = Math.max(0, Math.min(n, v));
  let l = Math.floor(c);
  if (c - l > thr) l++;
  return pal[Math.min(n, l)];
}

/** The hills: light rolling over a sky, two ridges; `quiet` darkens the left, where words sit. */
export function landscape(fx, fy, t, quiet) {
  const hush = quiet * Math.max(0, Math.min(1, 1.15 - fx * 1.6));
  const band = (Math.sin(fx * 7 - t * 0.9 + fy * 2.2) * 0.5 + 0.5) ** 2;
  const h1 = 0.5 + 0.13 * Math.sin(fx * 5.3 + 1 + t * 0.05) + 0.06 * Math.sin(fx * 13.1);
  const h2 = 0.74 + 0.08 * Math.sin(fx * 3.1 + 2.2) + 0.05 * Math.sin(fx * 9.7);
  if (fy > h2) return 0.25 + (1 - fy) * 2.2 - hush * 0.4;
  if (fy > h1) return 1.05 + (h2 - fy) * 2 + band * 0.45 - hush * 0.9;
  return 2.05 + (1 - fy) * 0.7 + band * 0.55 - hush * 1.6;
}

/** The map still loading: light swinging across a strip of sea, and back, so it never jumps. */
export function seaLight(fx, fy, t) {
  const at = 0.5 + 0.75 * Math.sin(t * 1.6);
  const d = (fx - at) * 3.2;
  return 0.35 + (1 - fy) * 0.5 + Math.exp(-d * d) * 2.6;
}

/**
 * Fill `canvas` (cells of `cell` CSS px) with `pal` tones from `value(fx, fy, t)`. `animate`: redrawn about
 * 24 times a second while the canvas is shown.
 */
export function ditherBox(canvas, pal, value, { cell = 2, animate = false } = {}) {
  const ctx = canvas.getContext("2d");
  let img = null;
  const paint = (t) => {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width / cell));
    const h = Math.max(1, Math.floor(r.height / cell));
    if (canvas.width !== w || canvas.height !== h || !img) {
      canvas.width = w;
      canvas.height = h;
      img = ctx.createImageData(w, h);
    }
    const px = img.data;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = tone(pal, value(x / w, y / h, t), threshold(x, y));
        const i = (y * w + x) * 4;
        px[i] = c[0];
        px[i + 1] = c[1];
        px[i + 2] = c[2];
        px[i + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
  };
  paint(0);
  if (animate) {
    let last = 0;
    const loop = (now) => {
      if (canvas.isConnected && canvas.offsetParent !== null && now - last > 41) {
        last = now;
        paint(now / 1000);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  return paint;
}

/** value noise in [0, 1] on a fixed permutation, so every picture is the same on every visit */
const PERM = (() => {
  const a = [...Array(256).keys()];
  let s = 7;
  for (let i = 255; i > 0; i--) {
    s = (s * 16807) % 2147483647;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return Uint8Array.from({ length: 512 }, (_, i) => a[i & 255]);
})();
const ease = (f) => f * f * (3 - 2 * f);
export function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = ease(x - xi), v = ease(y - yi);
  const X = xi & 255, Y = yi & 255;
  const a = PERM[PERM[X] + Y], b = PERM[PERM[X + 1] + Y];
  const c = PERM[PERM[X] + Y + 1], d = PERM[PERM[X + 1] + Y + 1];
  return ((a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v) / 255;
}
