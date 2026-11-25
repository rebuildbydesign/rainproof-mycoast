/* THE FINDINGS PANEL (REB-522).

   What Rebuild by Design's analysis of the city's data found. It carried a
   second section tabulating the stories on the map until 19 August, when Judy
   took it out along with two findings that were true but not compelling — the
   sensor install-date chart and green infrastructure per resident by borough.
   What replaced them is the five deepest readings with their surroundings, on
   the same principle: a number is worth printing when it implies an action.
   Language follows
   RBD's published reports (NJ Flood Risk = Financial Risk, Selling Flood Risk)
   — a plain "Findings" heading, each finding a number-led declarative opening
   with the dataset analyzed, and no metaphor.

   NOT ONE FIGURE IN THIS FILE IS TYPED. Every number is read from a file the
   map already loads, or counted from the live stories it is already drawing.
   The rule is the persistence layer's, in config.json: a number typed into
   markup is wrong one rebuild later, and this panel has forty of them. Even the
   percentages are divided here rather than written, so a headline and the chart
   under it cannot disagree. If you are about to type a digit into a template
   string in this file, it belongs in an overlay's meta instead.

   Where each figure comes from:
     overlays/findings-blocks.json  reports, reportKinds, greenAssets,
                                    greenSinceIda, radiusMeters, pulledOn,
                                    currentThrough, since, idaYears
     overlays/floodnet.json         meta.sensors / events / sensorsWithFloods /
                                    newestEvent, and per-sensor since, depth,
                                    last, boro, geometry
     overlays/greeninfra.json       meta.inProgress, meta.built, asset coords
     overlays/flood311.json         the 311 grid, for the half-mile rings

   The per-borough figures come from `findings-blocks.json` too, and NOT from
   findings/csv/borough.csv where they are also written: `findings/csv/` is
   gitignored — it is a working directory, not part of the site — so a panel
   reading that CSV works on localhost and 404s in production. The build writes
   the five numbers into the overlay as well, which is the file the map already
   downloads.

   The city figures are one frozen pull. The lead sentence carries the date they
   are current through; the separate mono dateline came out on 19 August, so
   that sentence is now the only place currency is stated. */

import { esc } from './ui.js';
import { longDate, monthYear } from './dates.js';

const N = n => (n || 0).toLocaleString();

/* Fetched at most once per page. `mapCtl.overlayData` hands back the copy the
   map already parsed when that layer has been drawn; these fetches are the
   fallback for a panel opened before any of them was switched on. */
const files = {};
function loadFile(url, parse) {
  if (!files[url]) {
    files[url] = fetch(url)
      .then(r => { if (!r.ok) throw new Error(`${url} ${r.status}`); return parse ? r.text().then(parse) : r.json(); })
      .catch(e => { delete files[url]; throw e; });
  }
  return files[url];
}
const overlay = (mapCtl, id, url) =>
  Promise.resolve(mapCtl?.overlayData?.(id) || loadFile(url));

/* The COLUMNAR file, never the map's copy. `overlayData` hands back what the
   map drew, and for a `columns` layer that is GeoJSON features. The lat/lng
   arrays this file counts over are gone by then, and greeninfra's are binned as
   well, so per-asset status cannot be read from it at all. Asking for the file
   costs nothing beyond the first panel open: the HTTP cache answers, and
   `loadFile` parses once per page. */
const columns = (mapCtl, id, url) => {
  const drawn = mapCtl?.overlayData?.(id);
  return Array.isArray(drawn?.lat) ? Promise.resolve(drawn) : loadFile(url);
};

/* Metres between two points, equirectangular. At the 805 m this is used for it
   agrees with haversine to well under a metre, and it is the same
   approximation the map's own `clipToCircle` makes. */
function metres(aLat, aLng, bLat, bLng) {
  const K = Math.PI / 180;
  const y = (bLat - aLat) * K * 6371000;
  const x = (bLng - aLng) * K * 6371000 * Math.cos((aLat + bLat) / 2 * K);
  return Math.hypot(x, y);
}

/* ── components ─────────────────────────────────────────────────────────
   Built on the .imp-* names the Impact panel already defines, so the two
   panels cannot drift into two bar charts. `.f-*` is only for the pieces
   Impact has no equivalent of. */

/* One bar. Width is a share of the LARGEST value in the set, never of the
   total: these are comparisons between categories, and scaling to the total
   leaves every bar unreadable as soon as the leader takes half. A zero draws
   full width in a hatch, because a hairline and an empty track look the same
   and the zeroes here are the finding. */
/* ONE ROW OF A QUIET TABLE, not a chart with its own furniture.

   Width is a share of the LARGEST value in the set, never of the total: these
   are comparisons between categories, and scaling to the total leaves every bar
   unreadable as soon as the leader takes half.

   One hue for the whole set, deliberately. These four rows are magnitudes of a
   single measure, not four different things, and four colours were inventing an
   identity the data does not have — which was most of what made the old panel
   look busy. */
function row(label, value, max, { shown = null, note = '' } = {}) {
  const pct = Math.max((value / max) * 100, 1.5);
  return `<tr>
    <td class="f-t-lab">${esc(label)}</td>
    <td class="f-t-plot"><span class="f-t-bar" style="width:${pct.toFixed(1)}%"></span></td>
    <td class="f-t-val">${esc(shown ?? String(value))}${note ? ` · ${esc(note)}` : ''}</td>
  </tr>`;
}
const table = rows => `<table class="f-tbl">${rows.join('')}</table>`;

/* A finding is a kicker, a statement, and its evidence, separated from the one
   above it by a hairline. `lead` is escaped; `tail` is escaped and then set in
   the accent, so a headline can end on the phrase that carries it without
   config or data ever reaching the page as markup. */
const find = (kicker, lead, tail = '', body = '', extra = '') =>
  `<div class="f-find">
     <div class="f-kicker">${esc(kicker)}</div>
     <h3 class="f-find-h">${esc(lead)}${tail ? ` <em>${esc(tail)}</em>` : ''}</h3>
     ${body}${extra}
   </div>`;
const para = html => `<p class="f-p">${html}</p>`;
/* One place, divided rather than written, so a headline and its chart cannot
   round the same ratio two different ways. */
const pct1 = (part, whole) => (whole ? (part / whole * 100).toFixed(1) : '0.0');

/* ── section 1: what the city's data shows ─────────────────────────────── */

function findingReportKinds(fb) {
  const kinds = fb.reportKinds || [];
  if (!kinds.length) return '';
  const top = kinds[0];
  const max = Math.max(...kinds.map(k => k.reports));
  return find(
    'Finding 01 · 311',
    `${top.share}% of flooding reports to 311 were`,
    top.plural || top.label.toLowerCase(),
    para(`We analyzed <b>${N(fb.reports)}</b> flooding reports made to 311 in the ${fb.idaYears} `
      + `years since Hurricane Ida. ${esc(top.label)} was the largest category, at `
      + `${N(top.reports)} reports.`),
    table(kinds.map(k => row(k.label, k.reports, max, { shown: N(k.reports), note: `${k.share}%` })))
  );
}

/* Prose, not three number tiles. Direction A's rule: a figure that needs no
   comparison does not need a chart, and these three read better in a sentence
   than in boxes that repeat the panel's own styling three times. */
function findingGreen(fb, giMeta) {
  const share = pct1(fb.greenSinceIda, fb.greenAssets);
  return find(
    'Finding 02 · DEP',
    `${share}% of the city's green infrastructure was built`,
    'after Ida',
    para(`We analyzed DEP green infrastructure assets. Of <b>${N(fb.greenAssets)}</b> built assets `
      + `citywide, <b>${N(fb.greenSinceIda)}</b> were installed after ${longDate(fb.since)}.`
      // Dropped rather than guessed when the greeninfra overlay has not loaded.
      + (giMeta?.inProgress != null
        ? ` A further <b>${N(giMeta.inProgress)}</b> are designed or under construction and not yet built.`
        : ''))
  );
}

/* THE FIVE DEEPEST. Judy, 19 August: one deepest reading was a fact; five with
   what surrounds each is an argument. A sensor that has measured four feet of
   water on a block with hundreds of 311 reports and nothing built is the whole
   case for this map in one row.

   The rings are the only figures here not read straight off a file. They are
   counted from the same two overlays the map draws, at the radius the half-mile
   panel uses, so a reader who taps the sensor sees the same numbers. */
function findingDeepest(fn) {
  const feats = (fn?.features || []).filter(f => Number.isFinite(f.properties?.depth));
  if (!feats.length) return { html: '', sensors: [] };
  const top = [...feats].sort((a, b) => b.properties.depth - a.properties.depth).slice(0, 5);

  /* Say "all in Queens" only when it is true. It is true today, and it is the
     most useful sentence on this panel, but it is one pull away from not
     being. */
  const boros = [...new Set(top.map(f => f.properties.boro).filter(Boolean))];
  const rows = top.map((f, i) => {
    const p = f.properties;
    return `<div class="f-deep-row">
      <div class="f-deep-depth">${p.depth}<small>in</small></div>
      <div class="f-deep-mid">
        <div class="f-deep-place">${esc(p.name || 'Unnamed sensor')}</div>
        <div class="f-deep-meta">${p.since ? `Installed ${monthYear(p.since)}` : 'Installation date not published'}${
          p.last ? ` · deepest ${longDate(p.last)}` : ''}</div>
      </div>
      <div class="f-deep-ring" id="fRing${i}"></div>
    </div>`;
  }).join('');

  return {
    sensors: top,
    html: find(
      'Finding 03 · FloodNet',
      'The five deepest floods FloodNet has measured were',
      boros.length === 1 ? `all in ${boros[0]}` : '',
      para(`Across ${N(fn?.meta?.events)} flood events on `
        + `${N(fn?.meta?.sensors ?? (fn?.features || []).length)} sensors. Counted within half a mile `
        + `of each sensor, the radius the map's own panel uses.`),
      `<div class="f-deep">${rows}</div>`
    ),
  };
}

/* Counted off the frozen overlays, not queried live. A live count would move
   under a reader comparing it against the frozen figures above it, which is the
   disagreement the frozen pull exists to prevent.

   A failure removes the rings rather than printing zeros. "0 green
   infrastructure assets built" is the finding here, and it must never be able
   to mean "the file did not load". Both overlays are fetched ONCE for all five
   sensors — they are about a megabyte together. */
async function fillRing(sensors, fb, mapCtl) {
  const list = (sensors || []).filter(s => Number.isFinite(s.geometry?.coordinates?.[0]));
  if (!list.length) return;
  const first = document.getElementById('fRing0');
  if (!first) return;
  const R = fb.radiusMeters || 805;

  let f3, gi;
  try {
    [f3, gi] = await Promise.all([
      columns(mapCtl, 'flood_street', 'overlays/flood311.json'),
      columns(mapCtl, 'greeninfra', 'overlays/greeninfra.json'),
    ]);
  } catch { return; }
  if (document.getElementById('fRing0') !== first) return;   // reopened while fetching
  // Say so rather than half-filling the column and leaving no trace.
  if (!Array.isArray(f3?.lat) || !Array.isArray(gi?.lat)) {
    console.warn('findings: half-mile rings skipped, overlay is not columnar');
    return;
  }

  // The four 311 columns, whichever of them this build wrote.
  // meta.scale, like greeninfra below. The literal is only a last resort.
  const S = f3.meta?.scale || f3.scale || 1000;
  const cols = ['s', 'd', 'h', 'b'].filter(c => Array.isArray(f3[c]));
  // `s` is 0 for a constructed asset, 1 for one in design or under construction.
  const GS = gi.meta?.scale || 1e5;

  list.forEach((sensor, idx) => {
    const slot = document.getElementById(`fRing${idx}`);
    if (!slot) return;
    const [lng, lat] = sensor.geometry.coordinates;
    let reports = 0;
    for (let i = 0; i < f3.lat.length; i++) {
      if (metres(lat, lng, f3.lat[i] / S, f3.lng[i] / S) > R) continue;
      for (const c of cols) reports += f3[c][i] || 0;
    }
    let built = 0;
    for (let i = 0; i < gi.lat.length; i++) {
      if (gi.s[i] === 0 && metres(lat, lng, gi.lat[i] / GS, gi.lng[i] / GS) <= R) built++;
    }
    /* One line, right-aligned against the depth. A zero is the finding on this
       row, so it is the one figure that takes a colour of its own. */
    slot.innerHTML =
      `<b>${N(reports)}</b> reports · <b class="${built ? '' : 'is-none'}">${N(built)}</b> built`;
  });
}

export async function renderFindings({ el, tenant, stories, mapCtl }) {
  if (!el) return;
  const LEAD = 'Rebuild by Design analyzed NYC 311 flooding reports, DEP green infrastructure '
    + 'assets, and the FloodNet sensor network';
  const head = lead =>
    `<div class="ab-eyebrow">Findings</div>`
    + `<h2 class="ab-h">What we analyzed, and what we found</h2>`
    + `<p class="ab-lead">${lead}</p>`;

  el.innerHTML = head('Reading the city’s record…');

  let fb, fn, gi;
  try {
    [fb, fn, gi] = await Promise.all([
      loadFile('overlays/findings-blocks.json'),
      overlay(mapCtl, 'floodnet', 'overlays/floodnet.json'),
      // Its meta carries the in-progress count and its own build date; the same
      // copy is what `fillRing` counts assets from, so this is one fetch.
      overlay(mapCtl, 'greeninfra', 'overlays/greeninfra.json').catch(() => null),
    ]);
  } catch (e) {
    el.innerHTML = head(`${LEAD}.`)
      + para(`The findings could not be loaded just now. ${esc(e.message)}`);
    return;
  }
  if (!document.body.contains(el)) return;

  const deepest = findingDeepest(fn);
  const giMeta = gi?.meta || null;

  const lead = `${LEAD} since Hurricane Ida (Sept 2021).`;

  el.innerHTML = head(lead)
    + findingReportKinds(fb)
    + findingGreen(fb, giMeta)
    + deepest.html;

  fillRing(deepest.sensors, fb, mapCtl);
}
