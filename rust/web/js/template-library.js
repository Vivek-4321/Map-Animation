// The Map Editor's library: what has been made in it, kept in this browser. Each item is the editor's state
// as it was left (title, shape, colour, length, camera, stops; photos are not kept), and the list holds what
// the home screen shows of each (its title, its stops' names and places, when it was last changed), so
// listing never reads every item. Every read and write is guarded: in private mode, or with the browser's
// storage full, the editor still works, unkept.

const INDEX = "map-editor-library";
const ITEM = (id) => `map-editor-library:${id}`;
/** where the editor kept its one state before there was a library: taken in once, as its first item */
const EARLIER = "route-film";

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** What the home screen shows of a state: its template, its title, and its stops (names and places, for
 * the picture). */
function summary(state) {
  const stops = (state.stops || []).filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat));
  return {
    template: state.template || "orbit",
    title: String(state.title || "").trim(),
    stops: stops.map((s) => ({ name: String(s.name || ""), lon: s.lon, lat: s.lat })),
    color: state.color || "#00a9df",
  };
}

/** Whether a state is worth keeping: something has been put in it. */
export const worthKeeping = (state) => (state.stops || []).length > 0 || String(state.title || "").trim() !== "";

/** The library, the latest changed first: { id, template, title, stops: [{ name, lon, lat }], color, created, updated }. */
export function libraryItems() {
  let items = read(INDEX);
  if (!Array.isArray(items)) {
    items = [];
    const earlier = read(EARLIER);
    if (earlier && worthKeeping(earlier)) {
      const id = newLibraryId();
      if (write(ITEM(id), earlier)) {
        items.push({ id, ...summary(earlier), created: Date.now(), updated: Date.now() });
        try { localStorage.removeItem(EARLIER); } catch { /* kept either way */ }
      }
    }
    write(INDEX, items);
  }
  return items.filter((it) => it?.id).sort((a, b) => b.updated - a.updated);
}

/** A new item's id: unique in this browser. */
export function newLibraryId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** An item's state as it was left, or null. */
export const libraryItem = (id) => read(ITEM(id));

/** Keep `state` as item `id` (added to the library if it is new). False: the browser would not keep it. */
export function keepInLibrary(id, state) {
  if (!write(ITEM(id), state)) return false;
  const items = libraryItems();
  const at = items.findIndex((it) => it.id === id);
  const now = Date.now();
  const item = { ...(items[at] ?? { id, created: now }), ...summary(state), updated: now };
  if (at >= 0) items[at] = item;
  else items.push(item);
  return write(INDEX, items);
}

/** Item `id` taken out of the library. */
export function removeFromLibrary(id) {
  try { localStorage.removeItem(ITEM(id)); } catch { /* gone either way */ }
  write(INDEX, libraryItems().filter((it) => it.id !== id));
}
