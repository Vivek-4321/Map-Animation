// The app's icons, drawn as strokes on a 24 grid: the same paths as the Android app's (Icons.kt).
const circle = (cx, cy, r) => `M${cx + r} ${cy}a${r} ${r} 0 1 1 ${-2 * r} 0a${r} ${r} 0 1 1 ${2 * r} 0z`;
const stroke = (...d) => ({ d, fill: false, w: 1.7 });
const fill = (...d) => ({ d, fill: true });

export const Icons = {
  back: stroke("M15 5 8 12l7 7"),
  plus: stroke("M12 5v14M5 12h14"),
  minus: stroke("M6 12h12"),
  chev: stroke("m9 6 6 6-6 6"),
  close: stroke("M6 6l12 12M18 6 6 18"),
  check: { ...stroke("m5.5 12.5 4 4 9-9.5"), w: 2.2 },
  play: fill("M7 4.8v14.4a1 1 0 0 0 1.5.86l12-7.2a1 1 0 0 0 0-1.72l-12-7.2A1 1 0 0 0 7 4.8z"),
  pause: fill("M6 4.5h4.2v15H6z", "M13.8 4.5H18v15h-4.2z"),
  film: stroke("M6.5 5h11a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z", "M3.5 9.5h17M8 5v4.5M12 5v4.5M16 5v4.5"),
  camera: stroke("M5.6 6.5h7.3a2.6 2.6 0 0 1 2.6 2.6v5.8a2.6 2.6 0 0 1-2.6 2.6H5.6A2.6 2.6 0 0 1 3 14.9V9.1a2.6 2.6 0 0 1 2.6-2.6z", "M15.5 10.5 21 7.5v9l-5.5-3"),
  pin: stroke("M12 21s-6.5-5.6-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z", circle(12, 9.8, 2.3)),
  route: stroke(circle(6, 18, 2), circle(18, 6, 2), "M8 18h6.5a3 3 0 0 0 0-6h-5a3 3 0 0 1 0-6H16"),
  text: stroke("M5.5 7V5.5h13V7M12 5.5v13M9 18.5h6"),
  globe: stroke(circle(12, 12, 8.5), "M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5S9.6 5.9 12 3.5z"),
  cloud: stroke("M7.5 18.5h9.2a4 4 0 0 0 .6-7.95 5.6 5.6 0 0 0-10.8 1.1A3.5 3.5 0 0 0 7.5 18.5z"),
  arrow: stroke("M7 17 17 7M9 7h8v8"),
  download: stroke("M12 4.5v11M7 11l5 5 5-5M5 19.5h14"),
  info: stroke(circle(12, 12, 8.5), "M12 11v5M12 8h.01"),
  compass: stroke(circle(12, 12, 8.5), "m15.2 8.8-1.9 4.5-4.5 1.9 1.9-4.5 4.5-1.9z"),
  more: stroke(circle(6, 12, 1.2), circle(12, 12, 1.2), circle(18, 12, 1.2)),
  flag: stroke("M6 20.5V4.5", "M6 5h11l-2.5 4 2.5 4H6"),
  spark: stroke("M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.6 2.6M15.4 15.4 18 18M18 6l-2.6 2.6M8.6 15.4 6 18"),
  drop: stroke("M12 3.8s6 6.4 6 10.4a6 6 0 0 1-12 0c0-4 6-10.4 6-10.4z"),
  undo: stroke("M9 14 4.5 9.5 9 5", "M5 9.5h9.5a5 5 0 0 1 0 10H11"),
  redo: stroke("M15 14l4.5-4.5L15 5", "M19 9.5H9.5a5 5 0 0 0 0 10H13"),
  trash: stroke("M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7"),
  copy: stroke("M9 9h9.5v10.5H9z", "M15 9V4.5H5.5V15H9"),
  pencil: stroke("M4.5 19.5l1-4.2L15.8 5a1.8 1.8 0 0 1 2.6 0l.6.6a1.8 1.8 0 0 1 0 2.6L8.7 18.5z", "M13.5 7.3l3.2 3.2"),
  area: stroke("M4.5 7.5 9 4.5l6 3 4.5-3v12l-4.5 3-6-3-4.5 3z", "M9 4.5v12M15 7.5v12"),
  photo: stroke("M6 5h12a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-9A2.5 2.5 0 0 1 6 5z", "m4 17 5-4.5 4 3.5 3-2.5 4 3.5", circle(9, 10, 1.8)),
  sticker: stroke("M19.5 13.5V6A1.5 1.5 0 0 0 18 4.5H6A1.5 1.5 0 0 0 4.5 6v12A1.5 1.5 0 0 0 6 19.5h7.5z", "M13.5 19.5v-4.5a1.5 1.5 0 0 1 1.5-1.5h4.5"),
  chart: stroke("M5 19.5V11M10 19.5V5M15 19.5v-6M20 19.5V8.5M3.5 19.5h17"),
  cube: stroke("M12 3.5 19.5 7.7v8.6L12 20.5l-7.5-4.2V7.7L12 3.5z", "M4.5 7.7 12 12l7.5-4.3M12 12v8.5"),
  moon: stroke("M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"),
  gear: stroke(circle(12, 12, 3), "M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"),
  library: stroke("M5 5v14M9.5 5v14M14 5.5l4.5 13"),
};

/** An icon as inline SVG, in `currentColor`. */
export function glyph(icon, size = 20) {
  const paths = icon.d
    .map((d) =>
      icon.fill
        ? `<path d="${d}" fill="currentColor"/>`
        : `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${icon.w}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("");
  return `<svg class="glyph" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
}
