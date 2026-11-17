// Places by name, from Photon (OpenStreetMap's data, the geocoder the Android app uses), and the search box
// that offers them: type a few letters, pick one.
import { esc } from "./timeline.js";

const API = "https://photon.komoot.io";

/** What a place is, to frame it: how far away the camera stands to see it whole. */
const SPAN = { country: 0.9, state: 0.35, region: 0.35, county: 0.12, city: 0.035, town: 0.02, village: 0.012 };

/** an area's name that is an administration's, not a place's ("Kou-Kamma Local Municipality", "Bitou Ward 1") */
const ADMIN = /\b(municipality|community|council|county|district|region|ward)\b|\d/i;

/** The town or village a point is in, as a person names it: its locality (Nature's Valley), else its city
 * unless that is an administration's name, else its district (Te Anau), else whatever city it has. */
function areaOf(p) {
  const locality = p.locality?.split(",")[0].trim();
  return locality || (p.city && !ADMIN.test(p.city) ? p.city : null) || (p.district && !ADMIN.test(p.district) ? p.district : null) || p.city || null;
}

function placeOf(f) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry?.coordinates || [];
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const kind = p.type || p.osm_value || "";
  const where = [p.state, p.country].filter((x) => x && x !== p.name).join(", ");
  return {
    name: p.name || p.street || "Here",
    sub: [kind === "country" ? "Country" : null, where].filter(Boolean).join(" · "),
    lon, lat, kind, dist: SPAN[kind] ?? 0.015,
    code: /^[a-z]{2}$/i.test(p.countrycode || "") ? p.countrycode.toUpperCase() : null,
    // the town it is in, and whether it is a landmark of its own (a peak, a pass, a lake, a viewpoint)
    area: areaOf(p),
    landmark: p.osm_key === "natural" || p.osm_key === "place" || p.osm_value === "viewpoint" || p.osm_value === "alpine_hut",
  };
}

/** The flag emoji of a country's ISO code ("IT" → 🇮🇹): its two letters as regional indicator symbols. */
export const flagOf = (code) => (code ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "");

/** Places named like `q` (those near `near`, [lon, lat], first). */
export async function searchPlaces(q, near, signal) {
  const u = new URL(`${API}/api/`);
  u.searchParams.set("q", q);
  u.searchParams.set("limit", "6");
  u.searchParams.set("lang", "en");
  if (near) {
    u.searchParams.set("lon", near[0].toFixed(3));
    u.searchParams.set("lat", near[1].toFixed(3));
  }
  const r = await fetch(u, { signal });
  if (!r.ok) throw new Error(`place search answered ${r.status}`);
  const d = await r.json();
  const seen = new Set();
  return (d.features || []).map(placeOf).filter((p) => {
    // (a city and its administrative area come as two: the same name, region and spot, kept once)
    const k = p && `${p.name}|${p.sub.replace(/^Country · /, "")}|${p.lon.toFixed(1)},${p.lat.toFixed(1)}`;
    if (!p || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The place at `lon`, `lat` (its name), or null. */
export async function placeAt(lon, lat) {
  try {
    const r = await fetch(`${API}/reverse?lon=${lon}&lat=${lat}&lang=en`);
    if (!r.ok) return null;
    const f = (await r.json()).features?.[0];
    return f ? placeOf({ ...f, geometry: { coordinates: [lon, lat] } }) : null;
  } catch {
    return null;
  }
}

/**
 * A search box: `input` gets a result list under it; picking one calls `onPick(place)`. `near()`: where to
 * look first. `flags`: a country's result shows its flag. Arrow keys move through the results, Enter picks,
 * Escape closes.
 */
export function placeSearch(input, onPick, near = () => null, { flags = false } = {}) {
  const box = document.createElement("div");
  box.className = "place-results";
  box.hidden = true;
  input.after(box);
  input.setAttribute("autocomplete", "off");
  input.setAttribute("role", "combobox");
  let results = [];
  let at = -1;
  let ctl = null;
  let timer = null;
  const show = () => {
    box.hidden = !results.length;
    const flag = (p) => (flags && p.kind === "country" && p.code ? `<i class="flag-emoji" aria-hidden="true">${flagOf(p.code)}</i>` : "");
    box.innerHTML = results.map((p, i) => `<button type="button" class="${i === at ? "on" : ""}" data-i="${i}"><b>${flag(p)}${esc(p.name)}</b><span>${esc(p.sub)}</span></button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.addEventListener("mousedown", (e) => {
      e.preventDefault(); // (before the input's blur closes the list)
      choose(Number(b.dataset.i));
    }));
  };
  const choose = (i) => {
    const p = results[i];
    if (!p) return;
    results = [];
    show();
    input.value = p.name;
    onPick(p);
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return void ((results = []), show());
    timer = setTimeout(async () => {
      ctl?.abort();
      ctl = new AbortController();
      box.hidden = false;
      box.innerHTML = `<div class="place-note">Looking…</div>`;
      try {
        results = await searchPlaces(q, near(), ctl.signal);
        at = results.length ? 0 : -1;
        if (!results.length) box.innerHTML = `<div class="place-note">No place called that</div>`;
        else show();
      } catch (err) {
        if (err.name !== "AbortError") box.innerHTML = `<div class="place-note">Place search is unreachable</div>`;
      }
    }, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      at = Math.max(0, Math.min(results.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
      show();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(at);
    } else if (e.key === "Escape") {
      results = [];
      show();
      input.blur();
    }
    e.stopPropagation();
  });
  input.addEventListener("blur", () => setTimeout(() => ((results = []), show()), 120));
}
