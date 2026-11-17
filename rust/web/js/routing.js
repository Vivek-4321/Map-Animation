// Real routes: the way a leg actually goes on the ground (roads, paths, rails), from free OpenStreetMap
// routers that need no key and answer a page directly. For each way of travel the routers are asked in
// turn, each only when those before it failed (busy, down, or no way found): the first answer is the
// route. They are community servers with fair-use rules (about a request a second, no heavy commercial
// use); the list is this one place, so a self-hosted or paid router replaces them here.
import { metres, simplify } from "./gpx.js";

/** a router's answer is given up after this long, and the next is asked */
const TIMEOUT_MS = 15000;
/** a route whose ends land farther than this from the leg's stops is not this leg's (an island, open sea) */
const SNAP_M = 3000;
/** a routed line is kept to within this of the router's (metres): close enough for any frame */
const TOLERANCE_M = 8;

/** OSRM's answer: its first route's line */
const osrm = (base, profile) => async ([a, b], signal) => {
  const r = await fetch(`${base}/route/v1/${profile}/${a[0]},${a[1]};${b[0]},${b[1]}?overview=full&geometries=geojson`, { signal });
  const d = await r.json();
  return d.code === "Ok" ? d.routes?.[0]?.geometry?.coordinates ?? null : null;
};

/** BRouter's answer (its GeoJSON track; the third number of each point is the height) */
const brouter = (profile) => async ([a, b], signal) => {
  const r = await fetch(`https://brouter.de/brouter?lonlats=${a[0]},${a[1]}|${b[0]},${b[1]}&profile=${profile}&alternativeidx=0&format=geojson`, { signal });
  if (!r.ok) return null; // (it answers a way it can't find with an error text)
  return (await r.json()).features?.[0]?.geometry?.coordinates?.map(([lon, lat]) => [lon, lat]) ?? null;
};

/** Valhalla's answer: its trip's legs, each an encoded line (six decimals) */
const valhalla = (costing) => async ([a, b], signal) => {
  const q = { locations: [{ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] }], costing, directions_options: { units: "kilometers" } };
  const r = await fetch(`https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(q))}`, { signal });
  if (!r.ok) return null;
  const legs = (await r.json()).trip?.legs;
  return legs?.length ? legs.flatMap((l) => decode6(l.shape)) : null;
};

/** An encoded polyline (precision 6, Valhalla's) as [lon, lat] points. */
function decode6(text) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let shift = 0, value = 0, byte;
    do {
      byte = text.charCodeAt(i++) - 63;
      value |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return value & 1 ? ~(value >> 1) : value >> 1;
  };
  while (i < text.length) {
    lat += next();
    lon += next();
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}

/** The routers for each way of travel, in the order they are asked, each with the name it is shown by. */
const ROUTERS = {
  foot: [
    ["BRouter", brouter("hiking-mountain")],
    ["OSRM", osrm("https://routing.openstreetmap.de/routed-foot", "foot")],
    ["Valhalla", valhalla("pedestrian")],
  ],
  bike: [
    ["BRouter", brouter("trekking")],
    ["OSRM", osrm("https://routing.openstreetmap.de/routed-bike", "bike")],
    ["Valhalla", valhalla("bicycle")],
  ],
  car: [
    ["OSRM", osrm("https://routing.openstreetmap.de/routed-car", "driving")],
    ["OSRM demo", osrm("https://router.project-osrm.org", "driving")],
    ["Valhalla", valhalla("auto")],
    ["BRouter", brouter("car-fast")],
  ],
  train: [["BRouter", brouter("rail")]],
};

/** Whether `mode` (foot, bike, car, train) has a real route to find. */
export const routable = (mode) => Boolean(ROUTERS[mode]);

/**
 * The real route from `from` to `to` ([lon, lat] each) by `mode`: { points, by } (`points` the line between,
 * the ends left out, as a leg's track is; `by` the router that found it), or null when none of the
 * routers found one near both ends.
 */
export async function realRoute(from, to, mode) {
  for (const [by, ask] of ROUTERS[mode] || []) {
    try {
      const line = await ask([from, to], AbortSignal.timeout(TIMEOUT_MS));
      if (!line || line.length < 2) continue;
      if (metres(line[0], from) > SNAP_M || metres(line.at(-1), to) > SNAP_M) continue;
      return { points: simplify(line, TOLERANCE_M).slice(1, -1), by };
    } catch {
      /* busy, down, too slow or refused: the next one */
    }
  }
  return null;
}
