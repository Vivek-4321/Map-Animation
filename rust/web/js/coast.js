// The coast the website draws in pixels: a dithered sea breaking into foam on a specked beach, and a sailing
// boat seen from above. The landing page draws its coasts with it; the route film's export globe takes its sea.
import { hex, noise } from "./dither.js";

/** a cell's own number in [0, 1): the sand's specks, the wake's spray, the rain's columns */
export function hash(x, y) {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// Deep to foam; SAND is the pages' --paper, so a beach runs on into the page.
export const WATER = ["#123A40", "#1C4E53", "#2C6563", "#4F8580", "#8FB5AC", "#DDE8E1"].map(hex);
const SAND = hex("#F2F0EA"), WET = hex("#E3DFD3"), SPECK = hex("#CBC5B6"), SPECK_SEA = hex("#A9C3BB");
const HULL = hex("#22393A"), DECK = hex("#C9A877"), PLANK = hex("#B48F5C"), CABIN = hex("#7A5A3A");
export const SAIL = hex("#F1EBDC");
const MAST = hex("#3A2C1E"), SAIL_SHADE = hex("#D6CCB5");

// ---- the sea and the sand
/** the sea's tone `d` cells out from the waterline: darker with depth, streaked, swells breaking into foam */
export function seaValue(x, y, d, t, deep) {
  let v = 3.7 - 3.6 * Math.sqrt(Math.min(1, d / deep));
  v += (noise(x * 0.05 + t * 0.04, y * 0.16 - t * 0.02) + 0.5 * noise(x * 0.13 - t * 0.07, y * 0.4) - 0.75) * 1.4;
  // swells rolling in: crests move toward the shore as t grows
  const crest = Math.max(0, Math.sin(d * 0.11 + t * 1.3 + noise(x * 0.03, y * 0.03) * 3));
  v += crest ** 6 * 1.6 * Math.exp(-d / 45);
  const lace = noise(x * 0.3, t * 0.8 + y * 0.05);
  if (d < 2 + lace * 4) return 5;
  if (d < 5 + lace * 6) return Math.max(v, 4.2);
  return v;
}
/** sand `up` cells from the waterline: wet as far as the last wave reached, then specks thinning out */
export function sandCell(x, y, up, reached, thr) {
  if ((reached - up) / 3 > thr) return WET;
  const near = Math.exp(-up / 12);
  const r = hash(x, y);
  return r < 0.012 + 0.11 * near ? (r < 0.04 * near ? SPECK_SEA : SPECK) : SAND;
}

// ---- the boat, top down
const WIND = -0.6; // the sail swings to the side away from it
const half = (u) => (u < 2 ? 3.1 - Math.max(0, -u - 5.5) * 1.6 : (3.1 * (8 - u)) / 6);
function inSail(u, v, side) {
  const ax = 1.8, ay = 0, bx = -5.5, by = 4.6 * side, qx = -4.2, qy = 1.1 * side;
  const s1 = (bx - ax) * (v - ay) - (by - ay) * (u - ax);
  const s2 = (qx - bx) * (v - by) - (qy - by) * (u - bx);
  const s3 = (ax - qx) * (v - qy) - (ay - qy) * (u - qx);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}
export const sailSide = (hx, hy) => (Math.sin(Math.atan2(hy, hx) - WIND) > 0 ? -1 : 1);
/** the part of the boat at (u, v), u toward the bow and v across, in boat units (it is 15 long); null for none */
export function boatPart(u, v, side) {
  if (inSail(u, v, side)) return v * side > 2.2 ? SAIL_SHADE : SAIL;
  if (u > 0.6 && u < 2 && Math.abs(v) < 0.9) return MAST;
  if (!(u > -7 && u < 8 && Math.abs(v) <= half(u))) return null;
  if (Math.abs(v) > half(u) - 1 || u < -6) return HULL;
  if (u > -5 && u < -1 && Math.abs(v) < 1.7) return CABIN;
  return Math.floor(v + 10) % 2 ? DECK : PLANK;
}
/** a boat at (bx, by) heading (hx, hy), `scale` cells a boat unit, at time `t`, as a picture asks it cell by cell */
export function boatAt(bx, by, hx, hy, scale, t) {
  const side = sailSide(hx, hy);
  return (x, y) => {
    const dx = x + 0.5 - bx, dy = y + 0.5 - by;
    const u = (dx * hx + dy * hy) / scale, v = (-dx * hy + dy * hx) / scale;
    if (u < -32 || u > 9 || Math.abs(v) > 12) return undefined;
    const part = boatPart(u, v, side);
    if (part) return part;
    // the wake: two arms opening behind the stern
    const back = -u - 7;
    if (back > 0 && back < 24 && Math.abs(Math.abs(v) - back * 0.35 - 0.6) < 0.55 && hash(x, y + Math.floor(t * 8)) < 0.75 * (1 - back / 24))
      return WATER[5];
    return undefined;
  };
}
