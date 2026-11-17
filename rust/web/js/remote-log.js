// TEMPORARY (Safari black-map diagnosis): `?remotelog` in the page's address sends this thread's console
// and its uncaught errors to the server the page came from, as GET requests a plain static server writes
// to its log (`/__log/<thread>/<n>?<text>`, answered 404). For a browser whose console can't be read from
// here. Remove once the cause is known.

/** Whether the page asked for it (read on the page; workers hear it in their start or init message). */
export const REMOTE_LOG = typeof location !== "undefined" && new URLSearchParams(location.search).has("remotelog");

let sent = 0;
const MAX = 400;
const seen = new Set();

/** One line to the server's log, as `thread` (at most MAX a thread, each text once). */
export function remoteLog(thread, ...args) {
  const text = args
    .map((a) => (a instanceof Error ? `${a.name}: ${a.message} ${a.stack ?? ""}` : typeof a === "object" ? safeJson(a) : String(a)))
    .join(" ")
    .slice(0, 1500);
  if (seen.has(text) || sent >= MAX) return;
  seen.add(text);
  sent++;
  const origin = self.location.origin;
  fetch(`${origin}/__log/${thread}/${sent}?${encodeURIComponent(text)}`).catch(() => {});
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** This thread's console and uncaught errors copied to the server's log, as `thread`. */
export function startRemoteLog(thread) {
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      remoteLog(thread, `[${level}]`, ...args);
    };
  }
  self.addEventListener("error", (e) => remoteLog(thread, "[uncaught]", e.message, `${e.filename}:${e.lineno}:${e.colno}`, e.error ?? ""));
  self.addEventListener("unhandledrejection", (e) => remoteLog(thread, "[rejection]", e.reason ?? ""));
  // the GPU's own complaints (a validation error, a device lost), which the browser prints itself
  // (hooked on each adapter as it is made, and on the prototype too, whichever the engine's calls go through)
  const watch = (device, how) => {
    if (device.__remoteLogged) return device;
    device.__remoteLogged = true;
    let errors = 0;
    device.addEventListener("uncapturederror", (e) => {
      errors++;
      remoteLog(thread, `[gpu error ${errors}]`, e.error?.constructor?.name ?? "", e.error?.message ?? String(e.error));
    });
    device.lost.then((info) => remoteLog(thread, "[gpu lost]", info.reason, info.message));
    remoteLog(thread, "[gpu device]", how);
    return device;
  };
  const requestDevice = self.GPUAdapter?.prototype.requestDevice;
  if (requestDevice) {
    self.GPUAdapter.prototype.requestDevice = async function (...args) {
      return watch(await requestDevice.apply(this, args), "via prototype");
    };
  }
  const requestAdapter = self.GPU?.prototype.requestAdapter;
  if (requestAdapter) {
    self.GPU.prototype.requestAdapter = async function (...args) {
      const adapter = await requestAdapter.apply(this, args);
      remoteLog(thread, "[gpu adapter]", adapter ? `${adapter.info?.vendor ?? ""} ${adapter.info?.architecture ?? ""}` : "none", JSON.stringify(args[0] ?? {}));
      if (adapter) {
        const own = adapter.requestDevice;
        adapter.requestDevice = async (...a) => watch(await own.apply(adapter, a), "via adapter");
      }
      return adapter;
    };
  }
  remoteLog(thread, "[start]", self.navigator?.userAgent ?? "");
}
