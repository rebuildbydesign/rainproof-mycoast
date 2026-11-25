/* Inline SVG icon set — the engine's neutral chrome iconography.
   Replaces hardcoded emoji so every layout (including the solemn ones) can
   carry the same components without inheriting a chatty tone. Stroke-based,
   drawn on a 24×24 grid, colored by currentColor so CSS themes them.
   Tenant-config emoji (field options, CTA copy) are tenant voice and are
   NOT rendered through this set. */

/* Story-type glyphs (REB-455).

   Kept as bare path `d` strings rather than SVG markup, because these are drawn
   two ways: as inline SVG in the side pane, and onto a canvas for the map pin.
   `Path2D` accepts a `d` string and nothing else — no <circle>, no <line> — so
   anything with those elements cannot be a pin. Every glyph here is paths only,
   which is why the eyes are zero-length segments with a round cap rather than
   circles.

   Drawn to read inside the bulb of a raindrop, so they are simple by necessity:
   a face at that size is three marks, not seven, and a plant is a stem and two
   leaves without a ground line. Every mark that can go, goes — the stroke has
   to stay thin to look considered rather than stamped, and a thin stroke only
   survives when there is nothing crowding it. */
export const GLYPH_D = {
  /* Centred by measurement, not by eye. The previous pair spanned x 3.5–16.3 and
     y 9.1–16.5, putting its centre at (9.9, 12.8) when the transform maps glyph
     (12, 12) to the middle of the drop's bulb — so it sat 2.1 left and 0.8 low.
     Shifted by exactly that. */
  wave:    ['M5.6 10.7c1.6 0 1.6-2.4 3.2-2.4s1.6 2.4 3.2 2.4 1.6-2.4 3.2-2.4 1.6 2.4 3.2 2.4',
            'M5.6 15.7c1.6 0 1.6-2.4 3.2-2.4s1.6 2.4 3.2 2.4 1.6-2.4 3.2-2.4 1.6 2.4 3.2 2.4'],
  /* Replaced the `worried` face on 19 Aug when the type became "I have a
     question about flooding". No enclosing circle: the raindrop already
     encloses it, and at ~11px a circle steals the room the hook needs.
     Scaled 1.2x off Feather's help mark so it carries the same optical
     width the face did. The dot is a zero-length segment with a round cap
     and its own heavier `{d, w}` width, or it reads as a smudge. */
  question: ['M8.6 8.3a3.6 3.6 0 0 1 7 1.2c0 2.4-3.6 3.6-3.6 3.6',
             { d:'M12 17h.01', w:2.9 }],
  plant:   ['M12 20.5V11', 'M12 13.5c0-3.4-2.8-6.2-6.2-6.2 0 3.4 2.8 6.2 6.2 6.2z',
            'M12 11.5c0-3.4 2.8-6.2 6.2-6.2 0 3.4-2.8 6.2-6.2 6.2z'],
  bulb:    ['M12 2.8a5.1 5.1 0 0 0-2.9 9.3c.5.4.8 1 .8 1.6v.4h4.2v-.4c0-.6.3-1.2.8-1.6A5.1 5.1 0 0 0 12 2.8z',
            'M9.9 17.2h4.2', 'M10.6 19.8h2.8'],
};
const asSvg = d => d.map(x => (typeof x === 'string'
  ? `<path d="${x}"/>`
  : `<path d="${x.d}" stroke-width="${x.w}"/>`)).join('');

const PATHS = {
  chat:    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  menu:    '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  list:    '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  grid:    '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  pin:     '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  search:  '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  camera:  '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  video:   '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
  mic:     '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
  stop:    '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  gps:     '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>',
  check:   '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  map:     '<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>',
  upload:  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  image:   '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  wave:    asSvg(GLYPH_D.wave),
  question: asSvg(GLYPH_D.question),
  plant:   asSvg(GLYPH_D.plant),
  bulb:    asSvg(GLYPH_D.bulb),
  eyeOff:  '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  user:    '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  speaker: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  lock:    '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  /* REB-472. A funnel, for the side pane's filter button. Drawn as one open
     polygon rather than the usual three-bar "sliders" mark: sliders read as
     settings, and this opens filters. It carries no glyph inside it, so it is
     `icon()` and not `dropMark` — the raindrop is the map's language and a
     control is not an echo of the map (REB-464's rule). */
  filter:  '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  plus:    '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  chevronL: '<polyline points="15 18 9 12 15 6"/>',
  chevronR: '<polyline points="9 18 15 12 9 6"/>',
  file:    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/><line x1="9" y1="18" x2="13" y2="18"/>',
  calendar:'<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  hand:    '<path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  // Added for the admin/moderation desk (July 2026) — one shared set, so admin
  // and map chrome draw from the same file and never diverge into emoji again.
  bell:    '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  clock:   '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  x:       '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  mail:    '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  phone:   '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.94.36 1.86.68 2.75a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.89.32 1.81.55 2.75.68A2 2 0 0 1 22 16.92z"/>',
  trash:   '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  alert:   '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  inbox:   '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  external:'<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  link:    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  // Added for the persistence layer's year scrubber (August 2026).
  play:    '<polygon points="7 4 20 12 7 20 7 4"/>',
  pause:   '<line x1="9" y1="5" x2="9" y2="19"/><line x1="15" y1="5" x2="15" y2="19"/>',
  // Added for moderator editing and its trail (REB-441, August 2026).
  edit:    '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/><polyline points="12 7 12 12 15 14"/>',
};

/* icon('pin')            → inline svg string, 1em, baseline-friendly
   icon('pin', 18)        → fixed pixel size */
export function icon(name, size) {
  const d = PATHS[name];
  if (!d) return '';
  const s = size ? `width="${size}" height="${size}"` : 'width="1em" height="1em"';
  return `<svg class="ico ico-${name}" ${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}
