// The route film maker: a Mult.dev-style recap from a list of stops. The stops (searched or tapped on a flat
// MapLibre map over satellite imagery), each leg's transport, a stop's photos and marker are all the page
// keeps; the engine's own template (map-web's `multdev_story`, the CLI's `template`) turns them into the
// story, so the camera, timing and cards are the template's, and the preview and the MP4 are the engine's.
import { startEngine } from "./engine.js";
import { placeSearch, placeAt } from "./places.js";
import { ditherBox, hex, landscape, noise, seaLight, threshold, tone, LEAF, SEA } from "./dither.js";
import { exportGlobe } from "./export-globe.js";
import { keepInLibrary, libraryItem, libraryItems, newLibraryId, removeFromLibrary, worthKeeping } from "./template-library.js";
import { themeButton, themeNow } from "./theme.js";
import { lineKm, metres, readGpx } from "./gpx.js";
import { realRoute, routable } from "./routing.js";
import { legVias, routeLine, wrapLon } from "./route-line.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** a small pixel icon: rows of "#" and "." drawn as square cells in the text's colour, as the landing page draws */
function pxIcon(rows, cell = 2) {
  const d = rows.flatMap((r, y) => [...r].map((c, x) => (c === "#" ? `M${x} ${y}h1v1h-1z` : ""))).join("");
  return `<svg class="px" viewBox="0 0 ${rows[0].length} ${rows.length}" width="${rows[0].length * cell}" height="${rows.length * cell}" aria-hidden="true"><path d="${d}"/></svg>`;
}
const ICON = {
  plane: pxIcon(["....##...", "....##...", "#...###..", "#########", "#...###..", "....##...", "....##..."]),
  car: pxIcon(["..####...", ".##..##..", "#########", "#########", ".##...##."]),
  train: pxIcon([".#####.", "#.....#", "#.....#", "#######", "#.#.#.#", "#######", ".#...#.", "#.....#"]),
  bike: pxIcon(["....##...", "...#.....", ".##.#.##.", "#..#.#..#", "#..#.#..#", ".##...##."]),
  up: pxIcon(["...#...", "..###..", ".##.##.", "##...##"]),
  down: pxIcon(["##...##", ".##.##.", "..###..", "...#..."]),
  del: pxIcon(["#...#", ".#.#.", "..#..", ".#.#.", "#...#"]),
  plus: pxIcon(["..#..", "..#..", "#####", "..#..", "..#.."]),
  play: pxIcon(["#....", "##...", "###..", "####.", "###..", "##...", "#...."]),
  pause: pxIcon(["##.##", "##.##", "##.##", "##.##", "##.##", "##.##", "##.##"]),
  sun: pxIcon(["...#...", ".#...#.", "..###..", "#.###.#", "..###..", ".#...#.", "...#..."]),
  moon: pxIcon(["..###..", ".##....", "##.....", "##.....", "##.....", ".##...#", "..####."]),
  undo: pxIcon(["..#....", ".##....", "######.", ".##...#", "..#...#", "......#", "..####."]),
  redo: pxIcon(["....#..", "....##.", ".######", "#...##.", "#...#..", "#......", ".####.."]),
  spark: pxIcon(["...#...", "...#...", ".#.#.#.", "..###..", ".#.#.#.", "...#...", "...#..."]),
  label: pxIcon(["####...", "#...#..", "#....#.", "#.....#", "#....#.", "#...#..", "####..."]),
  photo: pxIcon(["#######", "#.....#", "#.#...#", "#...#.#", "#..####", "#######"]),
  road: pxIcon(["#..#..#", "#.....#", "#..#..#", "#.....#", "#..#..#"]),
};

/** a leg's transport: auto lets the template choose (a plane past 900 km, else a car) */
const TRANSPORT = [["auto", "Auto", "Auto"], ["plane", "Plane", ICON.plane], ["car", "Car", ICON.car], ["train", "Train", ICON.train], ["bike", "Bike", ICON.bike]];
/** a stop's marker (the engine's Marker), and its size: a spot lies flat and tilts away, the others stand */
const MARKERS = { spot: ["Ring", 4], pin: ["Pin", 2.2], dot: ["Dot", 2.4], star: ["Star", 2.2], heart: ["Heart", 2.2], flag: ["Flag", 2.2], pulse: ["Pulse", 2.2] };
const MAX_PHOTOS = 4;
/** a stop's photos: up to four (Orbit's cards), one in a Story (it fills the screen; not at the start) */
const maxPhotos = (i) => (isStory() ? (i > 0 ? 1 : 0) : MAX_PHOTOS);
/** the preview's resolution (engine.js PREVIEW_SIZES), kept per browser */
const QUALITY_KEY = "route-film-preview";
/**
 * The Region template's example: the Eiger Ultra 101, a 101 km loop from Grindelwald with 6,700 m of climb,
 * through its viewpoints in race order. The places are real, the line between them straight: the race's
 * own GPX gives the trail exactly.
 */
const EIGER_ULTRA = {
  title: "Eiger Ultra 101",
  stops: [
    { name: "Grindelwald", lon: 8.0414, lat: 46.6242 },
    { name: "Grosse Scheidegg", lon: 8.102, lat: 46.654 },
    { name: "First", lon: 8.0542, lat: 46.6597 },
    { name: "Bachalpsee", lon: 8.0244, lat: 46.6694 },
    { name: "Berghotel Faulhorn", lon: 7.9975, lat: 46.6753 },
    { name: "Schynige Platte", lon: 7.9119, lat: 46.6531 },
    { name: "Wengen", lon: 7.9217, lat: 46.6058 },
    { name: "Männlichen", lon: 7.9406, lat: 46.6125 },
    { name: "Eiger North Face", lon: 8.0019, lat: 46.6047 },
    { name: "Grindelwald", lon: 8.0414, lat: 46.6242 },
  ],
};
const EXAMPLE = [
  { name: "Rome", lon: 12.4964, lat: 41.9028 },
  { name: "Florence", lon: 11.2558, lat: 43.7696 },
  { name: "Paris", lon: 2.3522, lat: 48.8566 },
  { name: "London", lon: -0.1276, lat: 51.5072 },
];

/**
 * The templates, by their names on the site: what each makes of the stops (the engine's own templates).
 * Orbit: city to city on the globe, each leg flown (`multdev_story`). Region: one trail through a
 * landscape, low over the terrain (`trail_story`), its camera orbiting, flying ahead or following.
 */
const TEMPLATES = {
  story: { name: "Story", about: "A road trip on a flat map, TravelBoast style: your own vehicles on each leg, swaps at the stops, place labels, photos that fill the screen, flags and road effects.", example: { title: "", stops: [] } },
  orbit: { name: "Orbit", about: "City to city. The camera flies each leg across the globe, with planes, cars and trains between the stops.", example: { title: "", stops: EXAMPLE } },
  region: { name: "Region", about: "A trail through one landscape, low over the satellite terrain. The camera orbits, flies ahead like a drone, or follows.", example: EIGER_ULTRA },
};
/**
 * The Story template's choices (vehicles, effects, swaps, highlights, labels, photo entrances) come from the
 * engine's catalogue (`showcase_catalog`), each shown by the engine itself in the picker. Until it is in, a
 * choice is called by its word.
 */
let catalog = null;
const STORY_CAMERAS = [["steady", "Steady"], ["follow", "Follow"]];
/** the picker's title and what each kind is called */
const KINDS = {
  vehicle: ["Vehicle", "Pick a vehicle"],
  effect: ["Road effect", "Pick a road effect"],
  swap: ["Vehicle swap", "How vehicles hand over"],
  highlight: ["Country highlight", "How countries light up"],
  label: ["Place labels", "How place names come in"],
  entrance: ["Photo entrance", "How the photo comes in"],
};
/** a stop's or leg's own choice "": the trip's; the trip's own "none" where the catalogue has no such choice */
const TRIPS = { key: "", name: "Trip's choice", about: "As set for the whole trip, in Story." };
const NO_LABELS = { key: "none", name: "None", about: "No place names come in." };
function choices(kind, own) {
  const list = catalog?.[kind] || [];
  if (kind === "label") return own ? [TRIPS, ...list] : [NO_LABELS, ...list];
  if (kind === "effect" && own) return [TRIPS, ...list];
  if (kind === "entrance") return [{ key: "", name: "Auto", about: "The template's own, stop by stop: rise, fly, develop, unfold." }, ...list];
  return list;
}
const choiceName = (kind, key) =>
  [TRIPS, NO_LABELS, ...(catalog?.[kind] || [])].find((c) => c.key === key && (key || kind !== "vehicle"))?.name
  ?? (kind === "entrance" && !key ? "Auto" : key ? key.replace(/^.*\//, "").replace(/\.glb$/, "").replace(/[-_]/g, " ") : kind === "vehicle" ? "Default" : "Trip's choice");

/** the Story example: a road trip across Europe, Amsterdam to Lisbon, a different vehicle each leg */
const EUROPE_TRIP = {
  title: "",
  stops: [
    { name: "Amsterdam", lon: 4.9041, lat: 52.3676 },
    { name: "Brussels", lon: 4.3517, lat: 50.8503, transport: "car", model: "glb/car/Ferrari_F40.glb" },
    { name: "Paris", lon: 2.3522, lat: 48.8566, transport: "car", model: "glb/car/Mustang_Mach1_1969.glb", labelStyle: "postcard" },
    { name: "Lyon", lon: 4.8357, lat: 45.764, transport: "car", model: "glb/car/Own_Camper.glb", effect: "flowers" },
    { name: "Nice", lon: 7.262, lat: 43.7102, transport: "car", model: "glb/car/Porsche_911_GT3RS_2023.glb", labelStyle: "neon" },
    { name: "Barcelona", lon: 2.1734, lat: 41.3851, transport: "car", model: "glb/car/McLaren_P1_GTR.glb" },
    { name: "Madrid", lon: -3.7038, lat: 40.4168, transport: "car", model: "glb/car/Mercedes_AMG_GT3.glb", labelStyle: "postcard" },
    { name: "Lisbon", lon: -9.1393, lat: 38.7223, transport: "car", model: "glb/car/Own_Tuk_Tuk.glb" },
  ],
};
TEMPLATES.story.example = EUROPE_TRIP;

/** the Region template's cameras */
const TRAIL_CAMERAS = [["orbit", "Orbit"], ["drone", "Drone"], ["follow", "Follow"]];
const templateOf = (name) => (TEMPLATES[name] ? name : "orbit");
/** Whether a template's legs curve through its stops (route-line.js's Catmull-Rom), on the map and in the
 * film. The Orbit template's run straight from stop to stop, for now. */
const curvedLegs = () => state.template !== "orbit";
const isStory = () => state.template === "story";

const state = { template: "orbit", title: "", shape: "16:9", color: "#00a9df", duration: 0, camera: "fit", trailCamera: "orbit", trailDistance: 1,
  swap: "smooth", highlight: "flag", labelStyle: "stamp", effect: "none", storyCamera: "steady", stops: [] };
let nextId = 1;
let preview = null;
let rebuildVersion = 0;
let tab = "map";
let built = null; // the story text last given to the engine
let updating = false; // a change is being made into the film (from the edit until the engine has it)

// ---- the stops

function newStop({ name, lon, lat }) {
  // track: the leg's line between the stops (a GPX's, or a real route's: trackKind "gpx" or "route");
  // real: its real route is wanted (routeKey: the ends and way it was found for; routeBy: which router)
  // (the Story template's: the leg's vehicle `model`, its road `effect`, the stop's `labelStyle` and its photo's
  // `enter`; "" each: the trip's own; autoName: its name is the map's for where it is, and goes with it)
  return { id: nextId++, name, lon, lat, transport: "auto", marker: "spot", images: [], country: null, track: null, trackKind: null, real: false, routeKey: null, routeBy: null, routeFailed: false,
    model: "", effect: "", labelStyle: "", enter: "", autoName: false };
}

/** The whole trip as the film goes: every stop, and each leg's way between them (route-line.js). */
function tripPoints() {
  const vias = legVias(state.stops, curvedLegs());
  return state.stops.flatMap((s, i) => [...vias[i], [s.lon, s.lat]]);
}

/** A stop from the search: the map goes to it. */
function addStop(place) {
  recordEdit();
  const s = newStop(place);
  state.stops.push(s);
  changed();
  flyTo(s, state.stops.length === 1 ? 4 : null);
  countryOf(s);
}

// ---- undo: the stops as they were before each edit, the newest 20

const UNDO_STEPS = 20;
const edits = { past: [], future: [] };
const stopsNow = () => state.stops.map((s) => ({ ...s, images: [...s.images] }));

/** Call before an edit of the stops. */
function recordEdit() {
  edits.past.push(stopsNow());
  if (edits.past.length > UNDO_STEPS) edits.past.shift();
  edits.future.length = 0;
  showHistory();
}

function stepHistory(from, to) {
  if (!from.length) return;
  to.push(stopsNow());
  state.stops = from.pop();
  showHistory();
  changed();
  state.stops.forEach(countryOf);
}

function forgetHistory() {
  edits.past.length = edits.future.length = 0;
  showHistory();
}

function showHistory() {
  $("undoBtn").disabled = !edits.past.length;
  $("redoBtn").disabled = !edits.future.length;
}

$("undoBtn").innerHTML = ICON.undo;
$("redoBtn").innerHTML = ICON.redo;
$("undoBtn").onclick = () => stepHistory(edits.past, edits.future);
$("redoBtn").onclick = () => stepHistory(edits.future, edits.past);
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || e.target.closest?.("input, textarea, select")) return;
  e.preventDefault();
  if (e.shiftKey) stepHistory(edits.future, edits.past);
  else stepHistory(edits.past, edits.future);
});

// ---- GPX: recorded tracks as legs

/** a track's start this close to the last stop goes on from it; its finish this close to its start is a loop */
const SAME_PLACE_M = 500;
/** a loop's finish, by the start it is named with (until both have their place's name; never kept) */
const loopStart = new WeakMap();

/** What a stop at a looked-up place is called: a landmark by its own name, else the town it is in (not the
 * nearest café). */
const placeName = (p) => (p.landmark ? p.name : p.area || p.name)?.trim();

/**
 * `files` (GPX) added to the trip: each track a leg along it, appended in the order they were recorded (or
 * by file name, without times). A track that starts away from the last stop gets a stop at its start
 * first; its finish is a stop, named for the place (a loop's for its start). An untitled trip takes the
 * first track's name.
 */
async function addGpx(files) {
  recordEdit();
  const tracks = [];
  const failed = [];
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      tracks.push(...readGpx(await f.text(), f.name));
    } catch (err) {
      failed.push(err.message);
    }
  }
  if (tracks.every((t) => t.start != null)) tracks.sort((a, b) => a.start - b.start);
  const named = [];
  for (const t of tracks) {
    const first = t.points[0], last = t.points.at(-1);
    let from = state.stops.at(-1);
    if (!from || metres([from.lon, from.lat], first) > SAME_PLACE_M) {
      from = newStop({ name: "Start", lon: first[0], lat: first[1] });
      state.stops.push(from);
      named.push(from);
    }
    const loop = metres(first, last) <= SAME_PLACE_M;
    const end = newStop({ name: loop ? from.name : "Finish", lon: last[0], lat: last[1] });
    end.track = t.points.slice(1, -1);
    end.trackKind = "gpx";
    if (loop) loopStart.set(end, from);
    state.stops.push(end);
    if (!loop) named.push(end);
  }
  if (tracks.length && !state.title) {
    state.title = tracks[0].name;
    $("title").value = state.title;
  }
  if (tracks.length) {
    changed();
    fitStops();
    const km = tracks.reduce((d, t) => d + lineKm(t.points), 0);
    toast(`Added ${tracks.length === 1 ? "a GPX track" : `${tracks.length} GPX tracks`} · ${km < 10 ? km.toFixed(1) : Math.round(km)} km${failed.length ? ` · ${failed[0]}` : ""}`);
  } else if (failed.length) toast(failed[0]);
  // the new stops named for their places; a loop's finish with its start. Two more tries, further apart, when the lookup fails (the
  // geocoder limits how often it is asked).
  const nameFor = async (stop, tries = 3) => {
    const p = await placeAt(stop.lon, stop.lat);
    if (!p) return tries > 1 && setTimeout(() => nameFor(stop, tries - 1), (4 - tries) * 2000);
    const name = placeName(p);
    if (!name || !["Start", "Finish"].includes(stop.name)) return;
    stop.name = name;
    for (const o of state.stops) if (loopStart.get(o) === stop) o.name = name;
    changed();
  };
  named.forEach((stop) => nameFor(stop));
  state.stops.forEach(countryOf);
}

$("gpxBtn").onclick = () => $("gpxFile").click();
$("gpxFile").onchange = (e) => {
  if (e.target.files.length) addGpx(e.target.files);
  e.target.value = "";
};
// GPX files dropped on the stops panel
{
  const side = document.querySelector(".side");
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  side.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    side.classList.add("dropping");
  });
  side.addEventListener("dragleave", (e) => !side.contains(e.relatedTarget) && side.classList.remove("dropping"));
  side.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    side.classList.remove("dropping");
    const gpx = [...e.dataTransfer.files].filter((f) => /\.gpx$/i.test(f.name));
    if (gpx.length) addGpx(gpx);
    else toast("Only GPX files can be dropped here");
  });
}

/** the stop's country as the map names it (the engine's own), for the flag on its card */
async function countryOf(s) {
  if (!preview) return;
  try {
    const name = await preview.countryAt(s.lon, s.lat);
    if (name !== s.country) {
      s.country = name || null;
      changed(false);
    }
  } catch {}
}

function km([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** each kind of Story choice by its icon on a chip (its word is in the chip's tooltip) */
const CHIP_ICONS = { vehicle: ICON.car, effect: ICON.spark, label: ICON.label, entrance: ICON.photo };
/** a stop's or leg's Story choice, as a chip that opens its picker */
const chip = (kind, i, key) => {
  // (one that follows the trip shows the trip's, dimmed: what the film will have)
  const follows = key === "" && kind !== "vehicle" && kind !== "entrance";
  const name = follows ? choiceName(kind, state[TRIP_FIELD[kind]]) : choiceName(kind, key);
  const title = `${KINDS[kind][0]}: ${name}${follows ? " (the trip's choice)" : ""}`;
  return `<button type="button" class="chip${follows ? " follows" : ""}" data-act="pick" data-kind="${kind}" data-i="${i}" title="${esc(title)}">${CHIP_ICONS[kind]}<b>${esc(name)}</b></button>`;
};

function renderStops() {
  const list = $("stops");
  const n = state.stops.length;
  $("empty").hidden = n >= 2;
  $("empty").querySelector("p").textContent = n === 1 ? "Add one more stop." : "Add at least two stops.";
  $("stopCount").textContent = n ? `${n} stop${n === 1 ? "" : "s"}` : "";
  const vias = legVias(state.stops, curvedLegs());
  list.innerHTML = state.stops
    .map((s, i) => {
      const story = isStory();
      const legMore = story && i > 0
        ? `<div class="leg-more">${chip("vehicle", i, s.model)}${chip("effect", i, s.effect)}</div>`
        : "";
      // a leg: its transport and its way (the real route's switch, showing the distance), then its choices
      const way = i === 0 ? "" : s.trackKind === "gpx"
        ? `<span class="gpx-tag" title="This leg follows a GPX track">GPX · ${legDistance(i, vias)}<button type="button" data-act="untrack" data-i="${i}" title="Go straight here instead of along the track">${ICON.del}</button></span>`
        : routeButton(i, legDistance(i, vias));
      const leg = i > 0
        ? `<li class="leg"><div class="leg-row"><div class="seg">${TRANSPORT.map(([k, label, icon]) => `<button type="button" class="${s.transport === k ? "on" : ""}" data-act="transport" data-k="${k}" data-i="${i}" title="${label}">${icon}</button>`).join("")}</div>${way}</div>${legMore}</li>`
        : "";
      const photos = s.images.map((img, k) => `<div class="thumb" style="background-image:url('${img.thumb}')"><button type="button" data-act="unphoto" data-i="${i}" data-k="${k}" title="Remove photo">${ICON.del}</button></div>`).join("");
      return `${leg}<li class="stop">
        <div class="stop-top">
          <span class="num">${i + 1}</span>
          <input class="name" value="${esc(s.name)}" data-act="name" data-i="${i}" spellcheck="false">
          ${s.country ? `<span class="flag" title="${esc(s.country)}">${esc(s.country)}</span>` : ""}
          <span class="stop-acts">
          <button type="button" class="icon" data-act="up" data-i="${i}" title="Move up" ${i === 0 ? "disabled" : ""}>${ICON.up}</button>
          <button type="button" class="icon" data-act="down" data-i="${i}" title="Move down" ${i === n - 1 ? "disabled" : ""}>${ICON.down}</button>
          <button type="button" class="icon del" data-act="del" data-i="${i}" title="Remove stop">${ICON.del}</button>
          </span>
        </div>
        <div class="stop-more">
          ${story
            ? `${chip("label", i, s.labelStyle)}${i > 0 && s.images.length ? chip("entrance", i, s.enter) : ""}`
            : `<select data-act="marker" data-i="${i}" title="Marker">${Object.entries(MARKERS).map(([k, [label]]) => `<option value="${k}" ${s.marker === k ? "selected" : ""}>${label}</option>`).join("")}</select>`}
          <div class="photos">${photos}${s.images.length < maxPhotos(i) ? `<button type="button" class="add-photo" data-act="photo" data-i="${i}" title="Add photos (up to ${MAX_PHOTOS})">${ICON.plus}</button>` : ""}</div>
        </div>
      </li>`;
    })
    .join("");
}

/** How stop `i`'s leg goes on the ground, for its real route: on foot along a Region trail, else by its
 * transport (Auto: a car, or a plane past 900 km, which has none). */
function legMode(i) {
  if (state.template === "region") return "foot";
  const s = state.stops[i];
  const t = s.transport === "auto" ? (km([state.stops[i - 1].lon, state.stops[i - 1].lat], [s.lon, s.lat]) > 900 ? "plane" : "car") : s.transport;
  return routable(t) ? t : null;
}

/** the legs whose real route is being found */
const routing = new Set();

/** Stop `i`'s leg's Real route switch, saying where it stands. */
/** A leg's way as one switch, showing its length (`km`): straight, or along the real roads (finding them,
 * found, or none found). A flight has no road: its length alone. */
function routeButton(i, km) {
  const s = state.stops[i];
  const mode = legMode(i);
  if (!mode) return `<span class="route-btn flight" title="A flight has no road: it stays an arc">${km}</span>`;
  const [label, title] = !s.real
    ? [km, "Straight here. Press to follow the real roads or paths"]
    : routing.has(s)
      ? ["Finding…", "Asking the routers for the way"]
      : s.routeFailed
        ? ["No route", "No real route was found here: the leg goes straight. Press to stop trying."]
        : [km, `Along the real roads, found by ${s.routeBy || "an OpenStreetMap router"}. Press to go straight instead.`];
  return `<button type="button" class="route-btn${s.real ? " on" : ""}${s.routeFailed && s.real ? " failed" : ""}" data-act="real" data-i="${i}" title="${title}">${ICON.road}${label}</button>`;
}

/** the key a leg's route is found for: its two ends and how it goes */
const routeKeyOf = (i, mode) => `${state.stops[i - 1].lon},${state.stops[i - 1].lat};${state.stops[i].lon},${state.stops[i].lat};${mode}`;

/** the routers are asked one leg at a time, a second apart (their fair use) */
let routeQueue = Promise.resolve();

/** Every leg that wants its real route and hasn't it for its ends as they now are: asked for (a stale one
 * goes straight meanwhile); a leg no longer wanting one gives its route up. */
function ensureRoutes() {
  state.stops.forEach((s, i) => {
    if (!i) return;
    if (!s.real) {
      if (s.trackKind === "route") Object.assign(s, { track: null, trackKind: null, routeKey: null, routeBy: null });
      s.routeFailed = false;
      return;
    }
    const mode = legMode(i);
    const key = mode && routeKeyOf(i, mode);
    if (s.routeKey === key || routing.has(s)) return;
    if (s.trackKind === "route") Object.assign(s, { track: null, trackKind: null });
    s.routeFailed = false;
    if (!mode) return void (s.routeKey = key);
    routing.add(s);
    routeQueue = routeQueue.then(async () => {
      const at = state.stops.indexOf(s);
      if (at < 1 || !s.real || routeKeyOf(at, mode) !== key) return void routing.delete(s);
      const from = state.stops[at - 1];
      const found = await realRoute([from.lon, from.lat], [s.lon, s.lat], mode);
      routing.delete(s);
      // (the leg changed while it was asked for: the next look asks again)
      if (state.stops.indexOf(s) < 1 || routeKeyOf(state.stops.indexOf(s), mode) !== key || !s.real) return changed();
      s.routeKey = key;
      if (found) Object.assign(s, { track: found.points, trackKind: "route", routeBy: found.by, routeFailed: false });
      else {
        s.routeFailed = true;
        toast(`No real route from ${from.name} to ${s.name}: it goes straight`);
      }
      changed();
      await new Promise((r) => setTimeout(r, 1100));
    });
  });
}

/** Stop `i`'s leg's length along its way there (`vias`), as the stops list says it. */
function legDistance(i, vias) {
  const at = (s) => [s.lon, s.lat];
  const d = lineKm([at(state.stops[i - 1]), ...vias[i], at(state.stops[i])]);
  return `${d < 10 ? d.toFixed(1) : Math.round(d).toLocaleString()} km`;
}

$("stops").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const i = Number(b.dataset.i);
  const s = state.stops[i];
  switch (b.dataset.act) {
    case "transport":
      s.transport = b.dataset.k;
      break;
    case "untrack":
      Object.assign(s, { track: null, trackKind: null });
      break;
    case "real":
      // on: the real way is asked for; off (or "no route", pressed): straight again
      s.real = !s.real;
      break;
    case "up":
    case "down": {
      recordEdit();
      const j = b.dataset.act === "up" ? i - 1 : i + 1;
      [state.stops[i], state.stops[j]] = [state.stops[j], state.stops[i]];
      break;
    }
    case "del":
      recordEdit();
      state.stops.splice(i, 1);
      break;
    case "unphoto":
      s.images.splice(Number(b.dataset.k), 1);
      break;
    case "photo":
      return pickPhotos(s);
    case "pick":
      return openPicker(b.dataset.kind, i);
  }
  changed();
});
$("stops").addEventListener("change", (e) => {
  const t = e.target;
  const s = state.stops[Number(t.dataset.i)];
  if (!s) return;
  if (t.dataset.act === "name") {
    s.name = t.value.trim() || s.name;
    s.autoName = false;
  }
  if (t.dataset.act === "marker") s.marker = t.value;
  changed();
});

/** photos for a stop: scaled to at most 1280 px and kept in the story as JPEG data (the engine reads data: sources) */
function pickPhotos(s) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.onchange = async () => {
    const files = [...input.files].slice(0, maxPhotos(state.stops.indexOf(s)) - s.images.length);
    for (const f of files) {
      try {
        s.images.push(await shrink(f));
      } catch {
        toast(`${f.name} could not be read`);
      }
    }
    changed();
  };
  input.click();
}

async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const draw = (long, quality) => {
    const k = Math.min(1, long / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality);
  };
  const out = { src: draw(1280, 0.85), thumb: draw(96, 0.7) };
  bmp.close();
  return out;
}

// ---- the story, by the engine's template

async function storyJson() {
  if (state.template === "region") return trailJson();
  if (isStory()) return travelJson();
  const markers = state.stops.map(({ marker }) => marker);
  const vias = legVias(state.stops, curvedLegs());
  const stops = state.stops.map((s, i) => {
    const o = { name: s.name, pos: [s.lon, s.lat] };
    if (s.transport !== "auto") o.transport = s.transport;
    if (s.images.length) o.images = s.images.map((img) => img.src);
    if (s.country) o.country = s.country;
    // (each leg goes the way the map draws it)
    if (vias[i].length) o.via = vias[i];
    return o;
  });
  // the film on Esri's satellite imagery (the engine's "satellite" source), as the globe it was planned on
  const meta = { title: state.title, basemap: "satellite", color: state.color, camera: state.camera };
  if (state.duration) meta.duration = state.duration;
  const story = JSON.parse(await preview.multdevStory(stops, meta));
  // TMP debug: switch surface pieces off to time the shader compile
  const dbg = new URLSearchParams(location.search).get("debug") || "";
  if (dbg.includes("nowater")) story.map.look.multdevOcean = false;
  if (dbg.includes("nodepth")) story.map.terrain.depth = false;
  // the template's stop markers (its `spot` cities: each stop's card and the circle that stays, at the
  // stop's place) with each stop's marker
  for (const item of story.scenes?.[0]?.items || []) {
    if (item.type !== "city" || item.marker !== "spot") continue;
    const k = stops.findIndex((s) => s.pos[0] === item.pos?.[0] && s.pos[1] === item.pos?.[1]);
    const marker = markers[k];
    if (marker && marker !== "spot") {
      item.marker = marker;
      item.markerScale = MARKERS[marker][1];
    }
  }
  return JSON.stringify(story);
}

/** The Story template's length when none is set: a few seconds a leg, and each photo's time on screen
 * (its 3 s, in and out, and the vehicle's hop away and back). */
function storyLength() {
  const legs = state.stops.length - 1;
  const photos = state.stops.filter((s, i) => i > 0 && s.images.length).length;
  return Math.max(14, Math.round(5 + legs * 4.5 + photos * 5));
}

/** The Story template's story (the engine's TravelBoast template): each stop, its leg's vehicle and effect,
 * its label and photo; the trip's swap, highlight, labels, effect and camera. */
async function travelJson() {
  const vias = legVias(state.stops, curvedLegs());
  const stops = state.stops.map((s, i) => {
    const o = { name: s.name, pos: [s.lon, s.lat] };
    if (i > 0) {
      if (s.transport !== "auto") o.transport = s.transport;
      if (s.model) o.model = s.model;
      if (s.effect) o.effect = s.effect;
      if (vias[i].length) o.via = vias[i];
      if (s.images.length) o.media = [{ src: s.images[0].src, ...(s.enter ? { enter: s.enter } : {}) }];
    }
    if (s.labelStyle) o.labelStyle = s.labelStyle;
    return o;
  });
  const meta = { title: state.title, color: state.color, camera: state.storyCamera, steady: 3, modelTransition: state.swap,
    duration: state.duration || storyLength() };
  if (state.labelStyle !== "none") meta.labelStyle = state.labelStyle;
  if (state.effect !== "none") meta.effect = state.effect;
  if (state.highlight === "flag") meta.flags = true;
  if (state.highlight === "color") meta.highlight = "color";
  return preview.travelboastStory(stops, meta, state.highlight !== "none");
}

/** How far the Region template evens out the satellite photos' colour (the story's tileLook.balance, 0..1):
 * each place's broad colour from Esri's even coarse mosaic, its detail from the photos, so the near ground's
 * patchwork of grey and hazy captures matches the far ground's green. */
const REGION_BALANCE = 0.8;
/** the Region template's trail, in pixels: wider than the engine template's 7, to read on a phone */
const REGION_LINE_WIDTH = 11;

/** The Region template's story: the stops in order as the trail, each a landmark along it. */
async function trailJson() {
  const meta = {
    camera: state.trailCamera,
    color: state.color,
    // (1, the camera's own distance, needs no setting)
    ...(Math.abs(state.trailDistance - 1) > 0.001 ? { distance: state.trailDistance } : {}),
    // (a loop's finish is its start: one label there)
    landmarks: state.stops
      .filter((s, i) => state.stops.findIndex((o) => o.name === s.name && o.lon === s.lon && o.lat === s.lat) === i)
      .map((s) => ({ label: s.name, pos: [s.lon, s.lat] })),
  };
  // (a trail film runs 12 s at least)
  if (state.duration) meta.duration = Math.max(12, state.duration);
  const story = JSON.parse(await preview.trailStory(tripPoints(), meta));
  story.map.tileLook = { ...story.map.tileLook, balance: REGION_BALANCE };
  for (const item of story.scenes?.[0]?.items || []) if (item.type === "route") item.lineWidth = REGION_LINE_WIDTH;
  return JSON.stringify(story);
}

let loadTimer = null;
/** the stops changed: redraw the list and the globe now, the film a moment later */
function changed(redraw = true) {
  ensureRoutes();
  rebuildVersion++;
  if (redraw) renderStops();
  drawMap();
  save();
  if (preview && state.stops.length >= 2) {
    updating = true;
    showBusy();
  }
  clearTimeout(loadTimer);
  loadTimer = setTimeout(rebuild, 250);
}

async function rebuild() {
  const version = ++rebuildVersion;
  $("exportBtn").disabled = true;
  if (state.stops.length < 2) {
    filmReady(false);
    veil("Add at least two stops to see the film.");
    return;
  }
  if (!preview) return;
  let json;
  try {
    json = await storyJson();
    if (version !== rebuildVersion) return;
  } catch (err) {
    if (version !== rebuildVersion) return;
    filmReady(false);
    veil(String(err.message || err));
    return;
  }
  if (json === built) return filmReady(true);
  try {
    const d = await preview.load(json);
    built = json;
    if (version !== rebuildVersion) return;
    preview.seek(Math.min(preview.t, d));
    filmReady(true);
  } catch (err) {
    built = null;
    if (version !== rebuildVersion) return;
    filmReady(false);
    veil(`The engine refused this film: ${err.message || err}`);
  }
}

/** The film the engine has is the one asked for (`on`), or there is none to play (too few stops, or the
 * engine refused it): play, the timeline (as long as the film) and export go with it, and nothing is being
 * updated any more. */
function filmReady(on) {
  updating = false;
  $("playBtn").disabled = $("scrub").disabled = $("exportBtn").disabled = !on;
  if (on) {
    $("scrub").max = String(preview.duration);
    veil(null);
  }
  updateClock();
}

function veil(text) {
  $("veil").hidden = !text;
  if (text) $("veilText").textContent = text;
  showBusy();
}

/** What the preview waits on, over its corner: a change going into the film, or the map still loading (not
 * while it plays: the clock says when it plays drafts). Nothing over the veil. */
function showBusy() {
  const waiting = preview?.loaded && !preview.playing && preview.pending > 0;
  const text = !$("veil").hidden ? null : updating ? "Updating the film…" : waiting ? "Loading the map…" : null;
  $("busy").hidden = !text;
  if (text && $("busy").textContent !== text) $("busy").textContent = text;
}

// ---- settings

function wireSettings() {
  $("color").value = state.color;
  $("camera").value = state.camera;
  $("duration").value = String(state.duration);
  $("title").value = state.title;
  const durationText = () => ($("durationOut").textContent = state.duration ? `${state.duration} s` : "Auto");
  durationText();
  $("camera").onchange = (e) => ((state.camera = e.target.value), changed(false));
  // the template: its name in the bar, and the settings only it has
  const region = state.template === "region";
  document.body.classList.toggle("tpl-region", region);
  document.body.classList.toggle("tpl-story", isStory());
  renderStoryChoices();
  const storyCams = $("storyCamera");
  storyCams.innerHTML = STORY_CAMERAS.map(([k, label]) => `<button type="button" data-cam="${k}" class="${state.storyCamera === k ? "on" : ""}">${label}</button>`).join("");
  for (const b of storyCams.querySelectorAll("button")) {
    b.onclick = () => {
      state.storyCamera = b.dataset.cam;
      for (const o of storyCams.querySelectorAll("button")) o.classList.toggle("on", o === b);
      changed(false);
    };
  }
  $("camera").hidden = region || isStory();
  const cams = $("trailCamera");
  cams.hidden = !region;
  // how near the Region camera comes: the engine's distance setting, 0.4 (nearer) to 1.6 (farther)
  $("distanceRow").hidden = !region;
  const distanceText = () => {
    const d = state.trailDistance;
    $("distanceOut").textContent = Math.abs(d - 1) < 0.01 ? "As set" : `${d < 1 ? "Closer" : "Farther"} ${Math.round(Math.abs(d - 1) * 100)}%`;
  };
  $("distance").value = String(state.trailDistance);
  distanceText();
  $("distance").oninput = (e) => {
    state.trailDistance = Number(e.target.value);
    distanceText();
    changed(false);
  };
  cams.innerHTML = TRAIL_CAMERAS.map(([k, label]) => `<button type="button" data-cam="${k}" class="${state.trailCamera === k ? "on" : ""}">${label}</button>`).join("");
  for (const b of cams.querySelectorAll("button")) {
    b.onclick = () => {
      state.trailCamera = b.dataset.cam;
      for (const o of cams.querySelectorAll("button")) o.classList.toggle("on", o === b);
      changed(false);
    };
  }
  $("color").oninput = (e) => {
    state.color = e.target.value;
    document.documentElement.style.setProperty("--route", state.color);
    changed(false);
  };
  // (a length under 8 s is as good as none: "Auto")
  $("duration").oninput = (e) => {
    const v = Number(e.target.value);
    state.duration = v < 8 ? 0 : v;
    durationText();
    changed(false);
  };
  $("title").onchange = (e) => ((state.title = e.target.value.trim()), changed(false));
  document.documentElement.style.setProperty("--route", state.color);
  for (const b of $("shape").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.shape === state.shape);
    b.onclick = () => {
      state.shape = b.dataset.shape;
      for (const o of $("shape").querySelectorAll("button")) o.classList.toggle("on", o === b);
      fitFrame();
      save();
    };
  }
  fitFrame();
}

/** the Story block: the trip's swap, highlight, labels and effect, each a card that opens its picker */
const TRIP_CHOICES = [["swap", "swap"], ["highlight", "highlight"], ["label", "labelStyle"], ["effect", "effect"]];
function renderStoryChoices() {
  $("storyChoices").innerHTML = TRIP_CHOICES.map(([kind, field]) =>
    `<button type="button" class="story-choice" data-kind="${kind}"><span>${KINDS[kind][0]}</span><b>${esc(choiceName(kind, state[field]))}</b></button>`).join("");
  for (const b of $("storyChoices").querySelectorAll("button")) b.onclick = () => openPicker(b.dataset.kind, null);
}

// ---- the picker: a Story choice's choices, each shown in the preview by the engine (its showcase) as it is
// pointed at; the film comes back when the picker closes

/** the stop field a kind's choice is kept in (a leg's on the stop it arrives at), and the trip's */
const STOP_FIELD = { vehicle: "model", effect: "effect", label: "labelStyle", entrance: "enter" };
const TRIP_FIELD = Object.fromEntries(TRIP_CHOICES);
const picking = { kind: null, i: null, chosen: null, shown: null, tab: null, timer: null, token: 0 };

/** the photo entrances a Story gives its stops in turn when none is chosen (the template's own order) */
const AUTO_ENTRANCES = ["rise", "fly", "develop", "unfold"];
/** What choice `key` of `kind` looks like in a film: a stop's "" is the trip's own; an entrance's, the one
 * the template gives that stop. */
const resolved = (kind, key) =>
  key !== "" ? key : kind in TRIP_FIELD ? state[TRIP_FIELD[kind]] : kind === "entrance" ? AUTO_ENTRANCES[(picking.i ?? 0) % 4] : key;

/** The kinds whose choices show as pictures (tools/web-picker-thumbs.py renders them with the engine). */
const PICK_PICTURES = new Set(["vehicle", "effect"]);
/** Choice `key` of `kind` as its transparent picture; a stop's "" is the trip's (an effect), or the default
 * vehicle. One not rendered yet is no picture. */
function pickPicture(kind, key) {
  if (!PICK_PICTURES.has(kind)) return "";
  const look = kind === "effect" ? resolved(kind, key) : key;
  const name = kind === "vehicle" ? (look ? look.replace(/^.*\//, "").replace(/\.glb$/, "") : "default") : look;
  return `<img src="media/picks/${kind}/${encodeURIComponent(name)}.webp" alt="" loading="lazy" onerror="this.remove()">`;
}

async function openPicker(kind, i) {
  if (!catalog && preview) catalog = await preview.showcaseCatalog().catch(() => null);
  if (!catalog) return toast("The engine is still starting: try again in a moment");
  const s = i === null ? null : state.stops[i];
  const current = s ? s[STOP_FIELD[kind]] : state[TRIP_FIELD[kind]];
  Object.assign(picking, { kind, i, chosen: current ?? "", shown: null, tab });
  $("pickerEyebrow").textContent = s ? (kind === "vehicle" || kind === "effect" ? `Leg to ${s.name}` : s.name) : "Whole trip";
  $("pickerTitle").textContent = KINDS[kind][1];
  const list = choices(kind, s !== null && kind !== "vehicle" && kind !== "entrance");
  $("pickerList").innerHTML = list.map((c) =>
    `<button type="button" class="pick${PICK_PICTURES.has(kind) ? " has-pic" : ""}${c.key === picking.chosen ? " on" : ""}" role="option" aria-selected="${c.key === picking.chosen}" data-key="${esc(c.key)}" title="${esc(c.about)}">${pickPicture(kind, c.key)}<b>${esc(c.name)}</b></button>`).join("");
  // (the preview changes only when a choice is picked, not as the pointer passes over the others)
  for (const el of $("pickerList").querySelectorAll(".pick")) {
    el.onclick = () => {
      picking.chosen = el.dataset.key;
      for (const o of $("pickerList").querySelectorAll(".pick")) {
        o.classList.toggle("on", o === el);
        o.setAttribute("aria-selected", String(o === el));
      }
      showChoice(el.dataset.key, true);
    };
    el.ondblclick = () => closePicker(true);
  }
  $("picker").hidden = false;
  document.body.classList.add("picking");
  showTab("preview");
  showChoice(picking.chosen, true);
  $("pickerList").querySelector(".pick.on")?.scrollIntoView({ block: "nearest" });
}

/** The engine shows choice `key` (a moment after it is pointed at, unless `now`). */
function showChoice(key, now = false) {
  clearTimeout(picking.timer);
  picking.timer = setTimeout(async () => {
    const kind = picking.kind;
    const look = resolved(kind, key);
    if (look === picking.shown) return;
    const c = [TRIPS, NO_LABELS, ...(catalog[kind] || [])].find((x) => x.key === key);
    for (const o of $("pickerList").querySelectorAll(".pick")) o.classList.toggle("showing", o.dataset.key === key);
    // a choice with nothing to show (no place names at all): the film as it is
    if (kind === "label" && look === "none") return void showCaption(c?.name, "No place names come in.");
    const s = picking.i === null ? null : state.stops[picking.i];
    const photo = kind === "entrance" ? s?.images[0]?.src || "" : "";
    const token = ++picking.token;
    picking.shown = look;
    showCaption(c?.name ?? choiceName(kind, look));
    try {
      $("veil").hidden = true;
      await preview.showcase(kind, look, photo);
      if (token === picking.token) updateClock();
    } catch (err) {
      if (token === picking.token) showCaption(c?.name ?? look, `Couldn't show it: ${err.message || err}`);
    }
  }, now ? 0 : 180);
}

/** The preview's label while a choice shows: its name, and a note only when there is something to say
 * (nothing to show, or it could not be shown). */
function showCaption(name, note) {
  $("showcaseCap").hidden = !name;
  $("showcaseName").textContent = name || "";
  $("showcaseAbout").textContent = note || "";
}

/** The picker away (`use`: its choice taken); the film back as it was, and the tab it was on. */
async function closePicker(use) {
  if ($("picker").hidden) return;
  clearTimeout(picking.timer);
  picking.token++;
  const { kind, i, chosen, tab: back } = picking;
  $("picker").hidden = true;
  $("picker").dispatchEvent(new Event("pickerclosed"));
  document.body.classList.remove("picking");
  showCaption(null);
  picking.shown = null;
  try { await preview.endShowcase(); } catch {}
  if (back !== "preview") showTab(back);
  if (use) {
    if (i === null) state[TRIP_FIELD[kind]] = chosen;
    else state.stops[i][STOP_FIELD[kind]] = chosen;
    renderStoryChoices();
    changed();
  } else {
    // (the film as it was: its veil, its clock)
    built = null;
    changed(false);
  }
}
// dragging the showcase turns its view, as a showroom's turntable (screen-relative, so every size feels alike)
{
  let drag = null;
  const orbit = { bearing: 0, pitch: 0 };
  const canvas = $("canvas");
  canvas.addEventListener("pointerdown", (e) => {
    if ($("picker").hidden) return;
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag || $("picker").hidden) return;
    const r = canvas.getBoundingClientRect();
    orbit.bearing -= ((e.clientX - drag.x) * 300) / r.width;
    orbit.pitch = Math.max(-40, Math.min(25, orbit.pitch - ((e.clientY - drag.y) * 120) / r.height));
    drag = { x: e.clientX, y: e.clientY };
    preview?.orbit(orbit.bearing, orbit.pitch);
  });
  canvas.addEventListener("pointerup", () => (drag = null));
  canvas.addEventListener("pointercancel", () => (drag = null));
  $("picker").addEventListener("pickerclosed", () => Object.assign(orbit, { bearing: 0, pitch: 0 }));
}
$("pickerCancel").onclick = () => closePicker(false);
$("pickerUse").onclick = () => closePicker(true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("picker").hidden) closePicker(false);
});

/** the preview frame in the film's shape, as large as the stage allows */
function fitFrame() {
  const [a, b] = state.shape.split(":").map(Number);
  const frame = $("frame");
  frame.style.setProperty("--shape", `${a} / ${b}`);
  const pane = $("previewPane");
  const room = { w: pane.clientWidth - 48, h: pane.clientHeight - 64 - 20 - 52 - 14 };
  const w = Math.max(1, Math.min(room.w, (room.h * a) / b));
  frame.style.width = `${w}px`;
  frame.style.height = `${(w * b) / a}px`;
}
new ResizeObserver(fitFrame).observe($("previewPane"));

/** the library item being edited (`template-library.js`); null: nothing kept yet, it joins the library once
 * something is in it */
let currentId = null;

/** The state, kept in the library after every change (its photos are not). */
function save() {
  const keep = { ...state, stops: state.stops.map((s) => ({ ...s, images: [] })) };
  if (!currentId) {
    if (!worthKeeping(keep)) return;
    currentId = newLibraryId();
    try { history.replaceState(null, "", `?item=${encodeURIComponent(currentId)}`); } catch {}
  }
  keepInLibrary(currentId, keep);
}

const FRESH = { template: "orbit", title: "", shape: "16:9", color: "#00a9df", duration: 0, camera: "fit", trailCamera: "orbit", trailDistance: 1,
  swap: "smooth", highlight: "flag", labelStyle: "stamp", effect: "none", storyCamera: "steady", stops: [] };

/** A template's own starting look over `FRESH`: a Story trip starts on TravelBoast's red route, flowers along
 * every leg and each country lit by its flag. A kept item's own settings stay its own. */
const TEMPLATE_LOOK = { story: { color: "#ec0003", effect: "flowers", highlight: "flag" } };

/** `kept` (a library item's state, or a fresh one) as the editor's state. */
function takeState(kept) {
  Object.assign(state, FRESH, TEMPLATE_LOOK[templateOf(kept.template)], kept, { stops: (kept.stops || []).map((s) => ({ ...newStop(s), ...s, id: nextId++, images: [] })) });
  state.template = templateOf(state.template);
}

/** `kept` in the editor: its settings, its stops on the globe and in the list, its film rebuilt. */
function applyState(kept) {
  takeState(kept);
  forgetHistory();
  wireSettings();
  renderStops();
  drawMap();
  fitStops();
  state.stops.forEach(countryOf);
  rebuildVersion++;
  clearTimeout(loadTimer);
  loadTimer = setTimeout(rebuild, 0);
}

// ---- the map a trip is plotted on (MapLibre, flat, satellite imagery), edited as travel-animator-android's
// home map is (`HomeMapGestureController.kt`): a tap adds a stop, a stop drags, the line drags a new stop out of
// itself, a double tap removes one. One difference, asked for here: every tap adds, where the app takes two.

/** How near a touch must come to a stop or the line to count as on it, in pixels */
const TOUCH_RADIUS = 15;
/** How far a press on the line travels before it is a drag: under this it is a tap */
const TOUCH_SLOP = 8;
const DOUBLE_TAP_MS = 300;
const ROUTE_LINE_WIDTH = 4;

let map = null;
/** each stop's marker, by the stop's id: kept across redraws, so one being dragged stays in the hand */
const pins = new Map();
/** the line as last drawn (route-line.js), for what a touch lands on */
let drawn = { coords: [], legAt: [] };
/** the stop a finger is moving: the map's redraws leave its marker alone */
let held = null;
let lastPinTap = { id: null, at: 0 };

const stopById = (id) => state.stops.find((s) => s.id === id);
/** A leg with a track is the road itself: a stop can't be added into it, and a recorded one's ends stay put. */
const legHasTrack = (leg) => state.stops[leg + 1]?.track?.length > 0;
const onRecordedTrack = (i) => state.stops[i]?.trackKind === "gpx" || state.stops[i + 1]?.trackKind === "gpx";

/** The map, once the engine is up: MapLibre draws with WebGL, and its start beside the engine's (WebGPU) held
 * the page up for seconds in Chrome. Without WebGL (switched off in the browser) it says so, and stops are
 * still added by search. */
function startMap() {
  try {
    makeMap();
  } catch (err) {
    map = null;
    $("routeMap").innerHTML = `<div class="map-note"><b>The map can't start in this browser.</b><span>Its WebGL is switched off (Chrome turns it off after its graphics crash: see chrome://gpu, or restart Chrome). You can still add stops with the search on the left.</span></div>`;
    console.warn("map:", err?.message || err);
  }
}

function makeMap() {
  map = new maplibregl.Map({
    container: "routeMap",
    style: {
      version: 8,
      // the engine's own satellite imagery (map-render's tile sources), with Esri's place names over it
      sources: {
        imagery: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
        names: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19 },
      },
      layers: [
        { id: "space", type: "background", paint: { "background-color": "#0b1020" } },
        { id: "imagery", type: "raster", source: "imagery" },
        { id: "names", type: "raster", source: "names" },
      ],
    },
    center: [10, 35],
    zoom: 1.6,
    // flat and north up: a plan to draw on (a double click belongs to the stops)
    maxPitch: 0,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    doubleClickZoom: false,
    attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.on("load", () => {
    map.addSource("route", { type: "geojson", data: routeData() });
    map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-width": ROUTE_LINE_WIDTH } });
    drawMap();
    if (state.stops.length) fitStops();
  });
  map.on("click", onTap);
  map.on("mousedown", onPress);
  map.on("touchstart", onPress);
}

function routeData() {
  drawn = routeLine(state.stops, undefined, curvedLegs());
  return { type: "FeatureCollection", features: drawn.coords.length > 1 ? [{ type: "Feature", properties: { color: state.color }, geometry: { type: "LineString", coordinates: drawn.coords } }] : [] };
}

let lineFrame = 0;
/** The line again, at most once a frame, while a stop moves. */
function drawLineSoon() {
  lineFrame ||= requestAnimationFrame(() => {
    lineFrame = 0;
    map?.getSource("route")?.setData(routeData());
  });
}

function drawMap() {
  mapHint();
  if (!map) return;
  map.getSource("route")?.setData(routeData());
  const gone = new Set(pins.keys());
  state.stops.forEach((s, i) => {
    gone.delete(s.id);
    let pin = pins.get(s.id);
    if (!pin) pins.set(s.id, (pin = makePin(s)));
    const el = pin.getElement();
    el.textContent = String(i + 1);
    el.title = s.name;
    const locked = onRecordedTrack(i);
    pin.setDraggable(!locked);
    el.classList.toggle("locked", locked);
    if (held !== s.id) pin.setLngLat([s.lon, s.lat]);
  });
  for (const id of gone) {
    pins.get(id).remove();
    pins.delete(id);
  }
}

function makePin(s) {
  const id = s.id;
  const el = document.createElement("div");
  el.className = "gpin";
  const pin = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([s.lon, s.lat]).addTo(map);
  pin.on("dragstart", () => {
    recordEdit();
    held = id;
  });
  pin.on("drag", () => {
    const stop = stopById(id);
    if (!stop) return;
    const { lng, lat } = pin.getLngLat();
    Object.assign(stop, { lon: lng, lat });
    drawLineSoon();
  });
  pin.on("dragend", () => {
    held = null;
    const stop = stopById(id);
    if (stop) settleStop(stop, pin.getLngLat());
  });
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    const now = performance.now();
    const twice = lastPinTap.id === id && now - lastPinTap.at < DOUBLE_TAP_MS;
    lastPinTap = twice ? { id: null, at: 0 } : { id, at: now };
    if (twice) removeByDoubleTap(id);
  });
  return pin;
}

/** A stop has come to rest at `at`: its place's name goes with it, and the film takes it up. */
function settleStop(stop, { lng, lat }) {
  Object.assign(stop, { lon: wrapLon(lng), lat });
  changed();
  countryOf(stop);
  nameFromMap(stop);
}

/** The start stays: a route's origin is removed from the list, never by accident on the map (as the app). */
function removeByDoubleTap(id) {
  const i = state.stops.findIndex((s) => s.id === id);
  if (i < 0) return;
  if (i === 0) return toast("The start stays on a double tap: remove it from the list");
  recordEdit();
  state.stops.splice(i, 1);
  changed();
}

/** Stop `stop` named for where it is, if the map named it (a hand-given name stays). Only if it's still there. */
async function nameFromMap(stop) {
  if (!stop.autoName) return;
  const { id, lon, lat } = stop;
  const place = await placeAt(lon, lat);
  const name = place && placeName(place);
  const now = stopById(id);
  if (!name || !now?.autoName || now.lon !== lon || now.lat !== lat || now.name === name) return;
  now.name = name;
  changed();
}

/**
 * What a touch at `point` (pixels on the map) lands on: `near`, a stop (or a track's point) within reach, and
 * `line`, the nearest place on the line within reach, with the leg it lies on. Each position is taken on the
 * world copy under the touch, since the map repeats sideways.
 */
function touched(point, lng) {
  const here = (lon, lat) => map.project([lon + 360 * Math.round((lng - lon) / 360), lat]);
  const near = state.stops.some((s, i) => {
    const p = here(s.lon, s.lat);
    return Math.hypot(p.x - point.x, p.y - point.y) <= TOUCH_RADIUS || (i && s.track?.some(([lon, lat]) => {
      const q = here(lon, lat);
      return Math.hypot(q.x - point.x, q.y - point.y) <= TOUCH_RADIUS;
    }));
  });
  let best = TOUCH_RADIUS, line = null;
  let a = null;
  drawn.coords.forEach(([lon, lat], k) => {
    const b = here(lon, lat);
    if (a) {
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      const u = len2 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2)) : 0;
      const d = Math.hypot(a.x + u * dx - point.x, a.y + u * dy - point.y);
      if (d <= best) {
        best = d;
        line = { leg: drawn.legAt[k - 1], at: map.unproject([a.x + u * dx, a.y + u * dy]) };
      }
    }
    a = b;
  });
  return { near, line };
}

/** A new stop in leg `leg`, travelling as the leg it splits does. */
function insertStop(leg, { lng, lat }) {
  recordEdit();
  const after = state.stops[leg + 1];
  const s = newStop({ name: `Stop ${state.stops.length + 1}`, lon: wrapLon(lng), lat });
  Object.assign(s, { autoName: true, transport: after.transport, model: after.model, effect: after.effect, real: after.real });
  state.stops.splice(leg + 1, 0, s);
  return s;
}

/** A tap: a stop where it landed, added on the end, or into the line if it's on the line. A tap never moves the
 * camera (the app's rule): the map stays where it was being worked on. A tap just beside a stop is a miss. */
function onTap(e) {
  if (e.originalEvent.target.closest?.(".gpin")) return;
  const { near, line } = touched(e.point, e.lngLat.lng);
  if (near) return;
  let s;
  if (line) {
    if (legHasTrack(line.leg)) return toast("This leg follows its track: a stop can't go in it");
    s = insertStop(line.leg, line.at);
  } else {
    recordEdit();
    s = newStop({ name: `Stop ${state.stops.length + 1}`, lon: wrapLon(e.lngLat.lng), lat: e.lngLat.lat });
    s.autoName = true;
    state.stops.push(s);
  }
  changed();
  countryOf(s);
  nameFromMap(s);
}

/** A press on the line (not on a stop, not on a leg's track) keeps the map from panning, and past the slop draws
 * a new stop out of the line, following the finger until it lifts. Anywhere else the press is the map's. */
function onPress(e) {
  if (e.originalEvent.target.closest?.(".gpin") || (e.points && e.points.length > 1)) return;
  const { near, line } = touched(e.point, e.lngLat.lng);
  if (near || !line || legHasTrack(line.leg)) return;
  e.preventDefault();
  const box = map.getContainer().getBoundingClientRect();
  const start = e.point;
  let stop = null;
  const follow = (ev) => {
    const point = new maplibregl.Point(ev.clientX - box.left, ev.clientY - box.top);
    if (!stop) {
      if (Math.hypot(point.x - start.x, point.y - start.y) <= TOUCH_SLOP) return;
      stop = insertStop(line.leg, map.unproject(point));
      held = stop.id;
      drawMap();
      renderStops();
    }
    const { lng, lat } = map.unproject(point);
    Object.assign(stop, { lon: lng, lat });
    pins.get(stop.id)?.setLngLat([lng, lat]);
    drawLineSoon();
  };
  const finish = () => {
    document.removeEventListener("pointermove", follow);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
    if (!stop) return;
    held = null;
    settleStop(stop, { lng: stop.lon, lat: stop.lat });
  };
  document.addEventListener("pointermove", follow);
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
}

/** What the map says it can do next. */
function mapHint() {
  const n = state.stops.length;
  $("mapHint").textContent = n === 0 ? "Tap the map to set your start"
    : n === 1 ? "Tap where the trip goes next"
    : "Tap to add · drag a stop to move it · drag the line to add one between · double-tap to remove";
}

function flyTo(s, zoom) {
  if (!map) return;
  map.easeTo({ center: [s.lon, s.lat], zoom: zoom ?? Math.max(map.getZoom(), 2.5), duration: 800 });
}

function fitStops() {
  if (!map || !state.stops.length) return;
  const b = new maplibregl.LngLatBounds();
  for (const p of routeLine(state.stops, 8, curvedLegs()).coords) b.extend(p);
  // (a trail, or a trip with recorded tracks, is seen close: its tracks are its shape)
  const close = state.template === "region" || state.stops.some((s) => s.track);
  map.fitBounds(b, { padding: 80, maxZoom: close ? 12 : 6, duration: 0 });
}

// ---- tabs, preview transport

function showTab(name) {
  tab = name;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $("mapPane").classList.toggle("hidden", name !== "map");
  $("previewPane").classList.toggle("hidden", name !== "preview");
  if (name === "map") {
    preview?.pause();
    map?.resize();
  } else fitFrame();
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

function wirePreview() {
  $("playBtn").onclick = () => {
    if (!preview?.loaded) return;
    if (preview.playing) preview.pause();
    else preview.play();
    updateClock();
  };
  $("scrub").addEventListener("input", (e) => {
    preview?.scrub(true);
    preview?.seek(Number(e.target.value));
    updateClock();
  });
  $("scrub").addEventListener("change", () => preview?.scrub(false));
  $("quality").value = preview.resolution;
  $("quality").onchange = (e) => {
    preview.setResolution(e.target.value);
    try {
      localStorage.setItem(QUALITY_KEY, e.target.value);
    } catch {}
  };
  preview.addEventListener("tick", updateClock);
  preview.addEventListener("error", (e) => {
    filmReady(false);
    veil(`The engine stopped: ${e.detail}. Reload the page.`);
  });
}

function updateClock() {
  if (!preview) return;
  $("playBtn").innerHTML = preview.playing ? ICON.pause : ICON.play;
  if (document.activeElement !== $("scrub")) $("scrub").value = String(preview.t);
  $("time").textContent = `${preview.t.toFixed(1)} / ${preview.duration.toFixed(1)} s${preview.playing && preview.playDraft ? " · draft while the map loads" : ""}`;
  showBusy();
}

// ---- export

const exp = { running: false, url: null };
const art = exportGlobe($("exportArt"));

function exportSize() {
  const [a, b] = state.shape.split(":").map(Number);
  const long = $("exportSize").value === "1080" ? 1920 : 1280;
  const even = (v) => Math.round(v / 2) * 2;
  return a >= b ? [long, even((long * b) / a)] : [even((long * a) / b), long];
}

$("exportBtn").onclick = () => {
  // the preview stops and is hidden while the dialog is up: the film renders on a canvas of its own
  preview?.pause();
  updateClock();
  $("frame").classList.add("hidden");
  if (!exp.running) view("setup");
  $("exportDlg").showModal();
};
$("exportDlg").addEventListener("close", () => {
  $("frame").classList.remove("hidden");
  if (!exp.running) art.stop();
});
// (Escape doesn't close it while the film renders: Cancel does)
$("exportDlg").addEventListener("cancel", (e) => exp.running && e.preventDefault());
$("renderBtn").onclick = () => render();
$("againBtn").onclick = () => render();
$("closeBtn").onclick = () => (exp.running ? preview.cancelExport() : $("exportDlg").close());

/** the dialog's two faces: the film's size, then the render */
function view(name) {
  $("setup").hidden = name !== "setup";
  $("run").hidden = name !== "run";
}

/** what the render says: its title, the percentage and bar, and the facts under them */
function told(title, pct, facts = {}) {
  $("vTitle").textContent = title;
  $("vPct").textContent = String(Math.round(pct));
  $("bar").style.width = `${pct}%`;
  for (const [id, text] of Object.entries(facts)) $(id).textContent = text;
}

// The map's tiles are the first stretch of the bar, the frames the rest.
const TILES_SHARE = 15;

async function render() {
  if (exp.running || !preview?.loaded) return;
  const [w, h] = exportSize();
  const fps = Number($("exportFps").value);
  exp.running = true;
  preview.pause();
  view("run");
  $("downloadLink").hidden = $("againBtn").hidden = true;
  exp.made = false;
  $("closeBtn").textContent = "Cancel";
  $("exportNote").textContent = "";
  $("exportNote").classList.remove("err");
  told("Charting the map", 0, { vPhase: "Charting", progressText: "Starting…", vFrames: "–", vLeftName: "Time left", vLeft: "–", vSize: `${h}p · ${fps} fps` });
  art.start(state.stops);
  let first = null; // the first frame (when, and which): the time left goes at the pace since
  // What is shown holds until something newer comes: the engine's sentences ("status") and its frame counts
  // arrive interleaved, so the line under the bar is the sentences' alone, and the bar and the frame count
  // only ever move forward.
  let shown = 0, frames = 0;
  const name = `${(state.title || state.stops.map((s) => s.name).slice(0, 3).join("-")).replace(/[^\w-]+/g, "-").toLowerCase()}-${h}p.mp4`;
  try {
    const { blob, saved, incomplete } = await preview.exportVideo({ w, h, fps, name }, (m) => {
      const f = m.total ? m.done / m.total : 0;
      if (m.phase === "file") {
        $("exportNote").textContent = `Saving to ${m.name} as it renders. Until it's done, the browser shows it as ${m.name}.crswap; it becomes ${m.name} at the end.`;
        return;
      }
      if (m.phase === "status") {
        if ($("progressText").textContent !== m.text) $("progressText").textContent = m.text;
        return;
      }
      if (m.phase === "tiles") {
        const pct = TILES_SHARE * f;
        if (pct < shown) return;
        shown = pct;
        art.set("tiles", f);
        return told("Charting the map", pct, { progressText: `Downloading the map · ${m.done} of ${m.total} tiles` });
      }
      if (m.done <= frames) return;
      frames = m.done;
      const pct = TILES_SHARE + (100 - TILES_SHARE) * f;
      shown = Math.max(shown, pct);
      art.set("frames", f);
      first ??= { at: performance.now(), done: m.done };
      const pace = (performance.now() - first.at) / Math.max(1, m.done - first.done);
      const left = m.done - first.done >= 5 ? `${Math.ceil((pace * (m.total - m.done)) / 1000)} s` : "–";
      told("Rendering frames", shown, { vPhase: "Rendering", vFrames: `${m.done} / ${m.total}`, vLeft: left });
    });
    if (exp.url) URL.revokeObjectURL(exp.url);
    exp.url = URL.createObjectURL(blob);
    const link = $("downloadLink");
    link.href = exp.url;
    link.download = saved ? blob.name || name : name;
    art.finish();
    exp.made = true;
    const gaps = incomplete ? "Parts of the map hadn't loaded on some frames." : "Every frame is in.";
    if (saved) {
      // in the file chosen at the start already: nothing more to do
      link.hidden = true;
      $("exportNote").textContent = "";
      told("Your film is saved", 100, { vPhase: "Saved", progressText: `Saved as ${blob.name || name}. ${gaps}`, vLeftName: "File", vLeft: `${(blob.size / 1048576).toFixed(1)} MB` });
    } else {
      // made in the browser's own storage: it goes to Downloads now (the button again, should the browser
      // have held the download back)
      link.hidden = false;
      link.click();
      $("exportNote").textContent = "If the download didn't start, press Download MP4.";
      told("Your film is ready", 100, { vPhase: "Done", progressText: `Downloading ${name}. ${gaps}`, vLeftName: "File", vLeft: `${(blob.size / 1048576).toFixed(1)} MB` });
      link.focus();
    }
  } catch (err) {
    const why = String(err.message || err);
    $("vTitle").textContent = why === "cancelled" ? "Cancelled" : "Rendering stopped";
    $("vPhase").textContent = why === "cancelled" ? "Cancelled" : "Stopped";
    $("exportNote").textContent = why === "cancelled" ? "Nothing was saved." : why;
    $("exportNote").classList.toggle("err", why !== "cancelled");
  } finally {
    exp.running = false;
    $("againBtn").hidden = false;
    $("againBtn").textContent = exp.made ? "Render again" : "Try again";
    $("closeBtn").textContent = "Close";
  }
}

// ---- the stage's backdrop

/** paper, then the faint tints of a chart's low ground (Bayer-dithered between them); and the same at night */
const CHART = {
  light: { ground: ["#EAE7DF", "#E3E5DE", "#DCE2DB"].map(hex), line: hex("#DDD9CE"), index: hex("#D2CDC0"), dot: hex("#CDC8BA") },
  dark: { ground: ["#121211", "#131614", "#141916"].map(hex), line: hex("#1D1D1B"), index: hex("#272724"), dot: hex("#2B2B28") },
};
/** the charts drawn, each repainted when the theme changes */
const charts = [];
const CHART_STEPS = 14; // contour lines across the noise's range

/**
 * A faint chart under the map and the preview: crisp one-cell contour lines (every fifth darker), the low
 * ground tinted toward the sea, a sparse dot grid. Drawn once a size, so it costs the engine nothing.
 */
function chart(canvas) {
  const ctx = canvas.getContext("2d");
  const cell = 3;
  const paint = (force) => {
    const r = canvas.getBoundingClientRect();
    const w = Math.ceil(r.width / cell), h = Math.ceil(r.height / cell);
    if (w < 2 || h < 2 || (force !== true && w === canvas.width && h === canvas.height)) return;
    const { ground: CHART_GROUND, line: CHART_LINE, index: CHART_INDEX, dot: CHART_DOT } = CHART[themeNow()];
    canvas.width = w;
    canvas.height = h;
    const e = new Float32Array((w + 1) * (h + 1));
    for (let y = 0; y <= h; y++)
      for (let x = 0; x <= w; x++) e[y * (w + 1) + x] = noise(x * 0.011, y * 0.011) * 0.72 + noise(x * 0.03 + 7, y * 0.03 + 7) * 0.28;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const at = e[y * (w + 1) + x], band = Math.floor(at * CHART_STEPS);
        // a line where the next cell right or below falls in another band
        const edge = band !== Math.floor(e[y * (w + 1) + x + 1] * CHART_STEPS) || band !== Math.floor(e[(y + 1) * (w + 1) + x] * CHART_STEPS);
        let c;
        if (x % 18 === 9 && y % 18 === 9) c = CHART_DOT;
        else if (edge) c = band % 5 === 0 ? CHART_INDEX : CHART_LINE;
        else c = tone(CHART_GROUND, Math.max(0, (0.42 - at) * 16), threshold(x, y));
        const i = (y * w + x) * 4;
        img.data[i] = c[0];
        img.data[i + 1] = c[1];
        img.data[i + 2] = c[2];
        img.data[i + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
  };
  new ResizeObserver(() => paint()).observe(canvas);
  charts.push(paint);
}

// ---- start

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3200);
}

placeSearch($("search"), (p) => {
  addStop({ name: p.name, lon: p.lon, lat: p.lat });
  $("search").value = "";
}, () => {
  const last = state.stops.at(-1);
  return last ? [last.lon, last.lat] : null;
}, { flags: true });

$("exampleBtn").onclick = () => {
  // (a Story example's stops carry their vehicles and labels)
  recordEdit();
  state.stops = TEMPLATES[state.template].example.stops.map((s) => Object.assign(newStop(s), s, { id: nextId++ }));
  changed();
  fitStops();
  state.stops.forEach(countryOf);
};

// ---- the home screen: something new, the library (each item's route on a pixel globe), the example

/** How long ago `t` was, as a person says it. */
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86400) return "yesterday";
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** what a library item is called on its card: its title, else its first and last stops */
function nameOf(it) {
  if (it.title) return it.title;
  const names = it.stops.map((s) => s.name).filter(Boolean);
  if (!names.length) return "Untitled";
  return names.length === 1 ? names[0] : `${names[0]} to ${names.at(-1)}`;
}

function card(it, i) {
  const n = it.stops.length;
  const way = n > 1 && it.title ? `${it.stops[0].name} → ${it.stops.at(-1).name}` : "";
  return `<article class="lib-card" style="--i:${i}" data-id="${esc(it.id)}" tabindex="0" role="button" aria-label="Open ${esc(nameOf(it))}">
    <div class="pic"><canvas aria-hidden="true"></canvas>
      <button class="del" type="button" title="Delete" aria-label="Delete ${esc(nameOf(it))}">${ICON.del}</button>
      <div class="ask" hidden><span>Delete this for good?</span><div><button type="button" class="keep">Keep</button><button type="button" class="yes">Delete</button></div></div>
    </div>
    <span class="tpl-tag on-pic">${TEMPLATES[templateOf(it.template)].name}</span>
    <div class="tx"><b>${esc(nameOf(it))}</b>
      <span class="meta"><span>${n} ${n === 1 ? "stop" : "stops"}${way ? ` · ${esc(way)}` : ""}</span><i>${ago(it.updated)}</i></span></div>
  </article>`;
}

function showHome() {
  const items = libraryItems();
  $("homeHi").textContent = items.length ? "Welcome back" : "Map Editor";
  $("homeCount").textContent = items.length ? String(items.length) : "";
  const list = $("homeList");
  list.innerHTML = items.length
    ? items.map(card).join("")
    : `<div class="home-empty"><b>Nothing here yet</b><span>What you make is kept here, in this browser, as you left it. Create something new, or try the example.</span></div>`;
  $("home").hidden = false;
  document.body.classList.add("at-home");
  $("homeBack").hidden = !worthKeeping(state);
  try { history.replaceState(null, "", location.pathname); } catch {}
  // (the pictures once the cards are laid out: each is drawn at its canvas's size)
  requestAnimationFrame(() => {
    list.querySelectorAll(".lib-card").forEach((el) => {
      const it = items.find((x) => x.id === el.dataset.id);
      el.style.setProperty("--route", it.color);
      exportGlobe(el.querySelector("canvas")).picture(it.stops);
      const ask = el.querySelector(".ask");
      el.addEventListener("click", (e) => !e.target.closest(".del, .ask") && openItem(it.id));
      el.addEventListener("keydown", (e) => {
        if (e.target === el && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          openItem(it.id);
        }
      });
      el.querySelector(".del").onclick = () => {
        ask.hidden = false;
        ask.querySelector(".keep").focus();
      };
      ask.querySelector(".keep").onclick = () => (ask.hidden = true);
      ask.querySelector(".yes").onclick = () => {
        el.classList.add("gone");
        setTimeout(() => {
          removeFromLibrary(it.id);
          if (it.id === currentId) currentId = null;
          showHome();
        }, 220);
      };
    });
  });
}

function hideHome() {
  $("home").hidden = true;
  document.body.classList.remove("at-home");
  fitFrame();
  map?.resize();
}

function openItem(id) {
  const kept = libraryItem(id);
  if (!kept) return toast("That's no longer in this browser");
  currentId = id;
  try { history.replaceState(null, "", `?item=${encodeURIComponent(id)}`); } catch {}
  applyState(kept);
  hideHome();
}

/** Something new with `template`: empty, or `example` (its title and stops; kept at once: something is in
 * it). */
function startNew(template, example = { title: "", stops: [] }) {
  currentId = null;
  template = templateOf(template);
  try { history.replaceState(null, "", `?template=${template}`); } catch {}
  applyState({ template, title: example.title, stops: example.stops });
  if (example.stops.length) save();
  hideHome();
}

/** The template chooser: each template's picture, what it makes, and its two ways in. `example`: the
 * example is the way in offered first. */
function chooseTemplate(example = false) {
  const dlg = $("tplDlg");
  $("tplEyebrow").textContent = example ? "Try an example" : "Create new";
  const grid = $("tplGrid");
  grid.innerHTML = Object.entries(TEMPLATES).map(([k, t]) => `<div class="tpl-card" data-t="${k}">
      <div class="pic"><canvas aria-hidden="true"></canvas></div>
      <div class="tx"><b>${t.name}</b><p>${t.about}</p>
        <div class="tpl-btns">
          <button type="button" class="${example ? "ghost" : "go"}" data-way="new">Start empty</button>
          <button type="button" class="${example ? "go" : "ghost"}" data-way="example">Example</button>
        </div></div>
    </div>`).join("");
  if (!dlg.open) dlg.showModal();
  requestAnimationFrame(() => {
    for (const el of grid.querySelectorAll(".tpl-card")) {
      const canvas = el.querySelector("canvas");
      if (el.dataset.t === "orbit") exportGlobe(canvas).picture(EXAMPLE);
      else if (el.dataset.t === "story") exportGlobe(canvas).picture(EUROPE_TRIP.stops);
      else ditherBox(canvas, LEAF, (x, y) => landscape(x, y, 0, 0.55), { cell: 3 });
      for (const b of el.querySelectorAll("button")) {
        b.onclick = () => {
          dlg.close();
          startNew(el.dataset.t, b.dataset.way === "example" ? TEMPLATES[el.dataset.t].example : undefined);
        };
      }
    }
  });
}
$("tplClose").onclick = () => $("tplDlg").close();

/** the theme buttons say which theme they go to; the charts repaint in the new one */
function themeChanged() {
  const icon = themeNow() === "dark" ? ICON.sun : ICON.moon;
  for (const id of ["themeBtn", "homeTheme"]) $(id).innerHTML = icon;
  charts.forEach((paint) => paint(true));
}
for (const id of ["themeBtn", "homeTheme"]) themeButton($(id), themeChanged);
$("homeBtn").onclick = showHome;
$("homeNew").onclick = () => chooseTemplate();
$("homeExample").onclick = () => chooseTemplate(true);
$("homeBack").onclick = hideHome;

const query = new URLSearchParams(location.search);
const asked = query.get("item");
// an item of the library by its id, or something new with a template (?template=orbit or region)
const opened = asked ? libraryItem(asked) : query.has("template") ? { template: templateOf(query.get("template")) } : null;
if (opened) {
  currentId = asked && libraryItem(asked) ? asked : null;
  takeState(opened);
}
wireSettings();
$("playBtn").innerHTML = ICON.play;
chart($("chart"));
chart($("homeChart"));
themeChanged();
if (!opened) showHome();
ditherBox($("veilSea"), SEA, seaLight, { cell: 4, animate: true });
renderStops();
showTab("map");
showHistory();
$("routeMap").innerHTML = `<div class="map-note"><span>Loading the map…</span></div>`;
veil("Starting the engine…");

let quality = "720";
try {
  quality = localStorage.getItem(QUALITY_KEY) || quality;
} catch {}
startEngine($("canvas"), (note) => veil(note), quality, "multdev")
  .then((p) => {
    preview = p;
    // (`?debug=trace`: the preview within reach of a profiling script, `mapPreview.trace(ms)`)
    if ((query.get("debug") || "").includes("trace")) globalThis.mapPreview = p;
    wirePreview();
    // the Story template's choices, by the engine's own names
    preview.showcaseCatalog().then((c) => {
      catalog = c;
      renderStops();
      renderStoryChoices();
    }).catch(() => {});
    state.stops.forEach(countryOf);
    rebuild();
  })
  .finally(() => {
    $("routeMap").innerHTML = "";
    startMap();
  })
  .catch((err) => veil(gpuWords(err)));

/** Why the engine couldn't start, in a person's words: a browser with no GPU for the page at all (neither
 * WebGPU nor WebGL2: its graphics switched off, often after its graphics process crashed) says what to do
 * about it. */
function gpuWords(err) {
  const why = String(err?.message || err);
  if (/no usable GPU|no adapter|found no adapters|WebGPU|WebGL/i.test(why)) {
    return "This browser isn't giving the page a GPU right now, so the film can't be drawn. Close the browser completely (swipe it away on a phone) and open it again. If that doesn't help, check that graphics acceleration isn't switched off: on a computer, Chrome's Settings → System → \"Use graphics acceleration when available\".";
  }
  return why;
}
