// The line through a trip's stops: travel-animator-android's plotting line (`RouteSpline.kt`,
// `EditorRouteLine.kt`), the same on the map a trip is plotted on and in the film. A leg with a track of its own
// (a GPX's, a real route's) is that track: it is the road already and is never smoothed. Every other leg is
// the curve through its stops, which still reads a track's points beside it, so the two meet without a kink.

const RAD = Math.PI / 180;
/** where the curve may overshoot a stop near a pole, it stays on the map (a latitude past 90 is no place) */
const MAX_LAT = 89.9;
/** the curve's samples on each leg of a film: fine enough at any zoom a film comes to, and far fewer than the map's */
const FILM_SAMPLES = 32;

/** Samples per edge on the map: fewer as a route grows, to keep a long one quick while a stop is dragged. */
export const segmentSizeFor = (points) => (points > 150 ? 50 : points > 50 ? 100 : 200);

export const wrapLon = (lon) => (lon >= -180 && lon <= 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180);

/** `points` with each longitude on the near side of the one before, so a route over the date line runs past
 * ±180 rather than back across the whole world. */
export function unwrapLongitudes(points) {
  let last = 0;
  return points.map(([lon, lat], i) => {
    if (i) {
      const diff = lon - last;
      if (diff >= 180) lon -= 360;
      else if (diff <= -180) lon += 360;
    }
    last = lon;
    return [lon, lat];
  });
}

/** Metres between two points, floored so that a chord's length never divides by zero. */
function chord([lon1, lat1], [lon2, lat2]) {
  const h = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return Math.max(2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h))), 0.000001);
}

/**
 * One coordinate of an edge. A cubic Hermite with tension 0, as Android's `CurveUtils.getSplinePoints`, and
 * deliberately not the textbook Barry-Goldman form: that is a different, equally plausible curve. `b` is
 * `-3(p1 - p2) - 2 m1 - m2`, and it is right.
 */
function sample(t, t1, t2, t3, p0, p1, p2, p3) {
  const m1 = (t2 - t1) * ((p1 - p0) / t1 - (p2 - p0) / t2 + (p2 - p1) / (t2 - t1));
  const m2 = (t2 - t1) * ((p2 - p1) / (t2 - t1) - (p3 - p1) / (t3 - t1) + (p3 - p2) / (t3 - t2));
  const a = 2 * (p1 - p2) + m1 + m2;
  const b = -3 * (p1 - p2) - m1 - m1 - m2;
  return a * t * t * t + b * t * t + m1 * t + p1;
}

/**
 * The centripetal Catmull-Rom curve through `points` ([lon, lat]), with `segments` + 1 samples an edge. An
 * edge `isRaw(k)` claims (the one leaving control point k) is only its start point. The end tangents come from
 * reflected points, and every edge reads the whole route, a raw neighbour included.
 * Returns the line and, for each of its positions, the control point of the edge it was made for.
 */
export function catmullRom(points, segments, isRaw = () => false) {
  if (points.length < 2) return { coords: unwrapLongitudes(points), edge: points.map((_, i) => i) };
  const raw = unwrapLongitudes(points);
  const reflect = ([ax, ay], [bx, by]) => [2 * ax - bx, 2 * ay - by];
  const closed = [reflect(raw[0], raw[1]), ...raw, reflect(raw.at(-1), raw.at(-2))];
  const coords = [];
  const edge = [];
  for (let k = 0; k < raw.length - 1; k++) {
    if (isRaw(k)) {
      coords.push(raw[k]);
      edge.push(k);
      continue;
    }
    const [p0, p1, p2, p3] = [closed[k], closed[k + 1], closed[k + 2], closed[k + 3]];
    const t1 = Math.sqrt(chord(p0, p1));
    const t2 = Math.sqrt(chord(p1, p2)) + t1;
    const t3 = Math.sqrt(chord(p2, p3)) + t2;
    for (let j = 0; j <= segments; j++) {
      const t = j / segments;
      coords.push([sample(t, t1, t2, t3, p0[0], p1[0], p2[0], p3[0]), sample(t, t1, t2, t3, p0[1], p1[1], p2[1], p3[1])]);
      edge.push(k);
    }
  }
  coords.push(raw.at(-1));
  edge.push(raw.length - 1);
  return { coords, edge };
}

/**
 * The trip's line: `coords`, longitudes unwrapped, and `legAt`, the leg of each position (a leg numbered by the
 * stop it leaves). `samples`: per edge; by default as the map draws it, by how long the route is. `curved`
 * false: every leg straight from stop to stop, no curve through them.
 */
export function routeLine(stops, samples, curved = true) {
  const controls = [];
  const legOf = [];
  stops.forEach((s, i) => {
    if (i && s.track?.length) {
      for (const p of s.track) {
        controls.push(p);
        legOf.push(i - 1);
      }
    }
    controls.push([s.lon, s.lat]);
    legOf.push(Math.min(i, stops.length - 2));
  });
  const tracked = (k) => stops[legOf[k] + 1]?.track?.length > 0;
  // (straight: every edge is only its start point, as a track's are, and the line goes point to point)
  const raw = curved ? tracked : () => true;
  const { coords, edge } = catmullRom(controls, samples ?? segmentSizeFor(controls.length), raw);
  for (const p of coords) p[1] = Math.max(-MAX_LAT, Math.min(MAX_LAT, p[1]));
  return { coords, legAt: edge.map((k) => legOf[k]) };
}

/**
 * For the film, what each stop's arriving leg goes through between its two stops (`vias[i]`, for stop i;
 * none for the first): its track as it is, or the curve's samples. Longitudes within ±180, as a story's are.
 * Two stops alone have no curve to follow: a straight leg, untouched; nor has a trip not `curved`.
 */
export function legVias(stops, curved = true) {
  const vias = stops.map((s, i) => (i && s.track?.length ? s.track : []));
  if (stops.length < 3 || !curved) return vias;
  const { coords, legAt } = routeLine(stops, FILM_SAMPLES);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  coords.forEach(([lon, lat], p) => {
    const i = legAt[p] + 1;
    const s = stops[i];
    if (s.track?.length) return;
    const from = stops[i - 1];
    const end = (o) => near(wrapLon(lon), wrapLon(o.lon)) && near(lat, o.lat);
    if (end(from) || end(s)) return;
    vias[i].push([wrapLon(lon), lat]);
  });
  return vias;
}
