// GPX files, read in the browser: each track (or route, or a file of waypoints alone) as its points in order,
// with its name and when it began, simplified so a long recording stays small in the library and on the map
// (a few metres off at most, which no frame shows).

/** a point is kept when the line would otherwise pass farther than this from it (metres) */
const TOLERANCE_M = 5;
/** at most this many points a track: past it, the tolerance doubles until it fits */
const MAX_POINTS = 4000;

const RAD = Math.PI / 180;

/** Metres between two [lon, lat] points (haversine). */
export function metres([lon1, lat1], [lon2, lat2]) {
  const h = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A line's length in kilometres. */
export const lineKm = (points) => points.reduce((d, p, i) => (i ? d + metres(points[i - 1], p) : 0), 0) / 1000;

/**
 * The tracks in a GPX file's `text` (`file`: its name, for what it is called when it names nothing):
 * [{ name, start, points }], `start` the first point's time in ms (null without one), `points` [[lon, lat], …].
 * Throws when the text is not GPX or holds no points.
 */
export function readGpx(text, file = "track.gpx") {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror") || doc.documentElement.localName !== "gpx") throw new Error(`${file} isn't a GPX file`);
  const own = (el, tag) => [...el.children].find((c) => c.localName === tag);
  const named = (el) => own(el, "name")?.textContent.trim() || "";
  const fileName = named(own(doc.documentElement, "metadata") ?? doc.documentElement) || file.replace(/\.gpx$/i, "");
  const pointsOf = (els) => {
    const pts = [];
    let start = null;
    for (const p of els) {
      const lat = Number(p.getAttribute("lat")), lon = Number(p.getAttribute("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) continue;
      if (start == null) {
        const t = Date.parse(own(p, "time")?.textContent || "");
        if (Number.isFinite(t)) start = t;
      }
      // (a repeated point is no part of the line)
      if (!pts.length || pts.at(-1)[0] !== lon || pts.at(-1)[1] !== lat) pts.push([lon, lat]);
    }
    return { start, points: pts };
  };
  const all = (tag) => [...doc.getElementsByTagNameNS("*", tag)];
  let tracks = all("trk").map((trk) => ({ name: named(trk), ...pointsOf(trk.getElementsByTagNameNS("*", "trkpt")) }));
  if (!tracks.some((t) => t.points.length > 1)) tracks = all("rte").map((rte) => ({ name: named(rte), ...pointsOf(rte.getElementsByTagNameNS("*", "rtept")) }));
  if (!tracks.some((t) => t.points.length > 1)) tracks = [{ name: "", ...pointsOf(all("wpt")) }];
  tracks = tracks.filter((t) => t.points.length > 1);
  if (!tracks.length) throw new Error(`${file} has no track in it`);
  return tracks.map((t, i) => ({
    name: t.name || (tracks.length > 1 ? `${fileName} ${i + 1}` : fileName),
    start: t.start,
    points: simplify(t.points),
  }));
}

/** `points` with those the line hardly bends at taken out (Douglas–Peucker, in metres on a local plane). */
export function simplify(points, tolerance = TOLERANCE_M) {
  if (points.length < 3) return points;
  const lat0 = points[0][1] * RAD;
  const xy = points.map(([lon, lat]) => [lon * RAD * Math.cos(lat0) * 6371000, lat * RAD * 6371000]);
  let tol = tolerance;
  for (;;) {
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = xy[a], [bx, by] = xy[b];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let far = -1, worst = tol;
      for (let i = a + 1; i < b; i++) {
        const [px, py] = xy[i];
        const u = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
        const d = Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
        if (d > worst) [worst, far] = [d, i];
      }
      if (far >= 0) {
        keep[far] = 1;
        stack.push([a, far], [far, b]);
      }
    }
    const out = points.filter((_, i) => keep[i]);
    if (out.length <= MAX_POINTS) return out;
    tol *= 2;
  }
}
