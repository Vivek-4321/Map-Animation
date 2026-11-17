// Light or dark, one choice for the site: kept in this browser ("studio-theme"), else the system's. A page
// sets it in its <head> before it paints (no flash of the other theme):
//
//   <script>try{const t=localStorage.getItem("studio-theme");if(t)document.documentElement.dataset.theme=t}catch{}</script>
//
// and its stylesheet gives its colours for `:root[data-theme="dark"]` and, unless the page says light, for a
// dark system.

const KEY = "studio-theme";

/** The theme the page shows now: "dark" or "light". */
export function themeNow() {
  return getComputedStyle(document.documentElement).colorScheme === "dark" ? "dark" : "light";
}

/** The other theme, kept for the site. */
function toggleTheme() {
  const next = themeNow() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode: this page only */
  }
}

/** `button` switches the theme, saying which it goes to; `changed()` hears each switch (here, or in another
 * tab of the site). */
export function themeButton(button, changed = () => {}) {
  const say = () => {
    button.title = `Switch to ${themeNow() === "dark" ? "light" : "dark"} mode`;
    button.setAttribute("aria-label", button.title);
  };
  say();
  button.addEventListener("click", () => {
    toggleTheme();
    say();
    changed();
  });
  addEventListener("storage", (e) => {
    if (e.key !== KEY || !e.newValue) return;
    document.documentElement.dataset.theme = e.newValue;
    say();
    changed();
  });
}
