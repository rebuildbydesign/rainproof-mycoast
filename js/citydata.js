/* The city's own record, read back around a single point.

   The map already DRAWS NYC's flooding data (the 311 block layers and the green
   infrastructure dots in map.js). This reads the same datasets back as
   numbers for one block, so a resident's story sits visibly inside the
   official record: "the city logged 307 flooding complaints within a half
   mile of here, and built one piece of green infrastructure."

   Everything is a live Socrata aggregate — `within_circle(...)` counts, about
   125 bytes a response — so nothing is downloaded in bulk and nothing goes
   stale. Results are memoized per rounded point for the life of the page.

   Every dataset, descriptor, radius and threshold comes from
   `tenant.cityData`; nothing here knows it is about New York. */

/* Shared across ui.js (per-story context) and app.js (Impact totals) so both
   read one cache — the Impact panel's per-story pass is free after a visitor
   has browsed a few stories, and vice versa. */
let instance = null;
export function cityData(cfg) {
  if (!cfg?.complaints?.url) return null;      // tenant hasn't opted in
  if (!instance) instance = build(cfg);
  return instance;
}

function build(cfg) {
  const radius = cfg.radiusMeters || 805;
  const near = new Map();                      // "lat,lng" → Promise of counts
  let totals = null;                           // Promise of the citywide pair

  // SoQL string literals are single-quoted; a quote inside one is doubled.
  const lit = s => `'${String(s).replace(/'/g, "''")}'`;

  /* `{today}` in a config where-clause. The DEP green-infrastructure set carries
     a handful of rows marked Constructed with a completion date in the future
     (2 of 13,955 when checked), so a "built since Ida" count has to close the
     window at today or it reports work that has not happened yet. */
  const today = new Date().toISOString().slice(0, 10);
  const sub = s => String(s).split('{today}').join(today);

  /* REB-415. The Socrata app token, sent as a query parameter rather than the
     X-App-Token header on purpose: a custom header makes this a non-simple
     CORS request, which adds a preflight OPTIONS round trip to every one of
     these. They are already the slowest thing in the story pane at ~2s, and
     they are 13-byte responses, so the round trip would cost more than the
     payload. The token is a public identifier, so a query string is fine.

     `tokenOk` exists because **an invalid token is worse than no token**:
     unauthenticated requests return 200, but a wrong or revoked one returns
     403. Without this, the day someone rotates the token every city-context
     block on the map goes blank. One 403 drops the token for the rest of the
     session and everything carries on anonymously. */
  let tokenOk = true;
  const appToken = () => (tokenOk && cfg.appToken) || '';

  /* One aggregate query. Aborts rather than hanging a panel open on a slow
     network: every caller treats null as "just don't show the block". */
  async function soql(url, params, ms = 9000) {
    const run = async t => {
      const u = new URL(url);
      Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
      if (t) u.searchParams.set('$$app_token', t);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ms);
      try {
        const res = await fetch(u.toString(), { signal: ctl.signal });
        if (!res.ok) throw Object.assign(new Error(`socrata ${res.status}`), { status: res.status });
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    };
    /* Capture the token this call actually sent, rather than re-reading
       `tokenOk` in the catch. `lookup()` fires two of these in parallel, so the
       first 403 flips the flag while the second is still in flight — reading
       the flag afterwards made the second request conclude it had never sent a
       token and rethrow instead of retrying, taking the whole lookup down. */
    const sent = appToken();
    try {
      return await run(sent);
    } catch (e) {
      if (e.status !== 403 || !sent) throw e;
      if (tokenOk) console.warn('Socrata rejected the app token; continuing anonymously.');
      tokenOk = false;
      return run('');
    }
  }

  const c = cfg.complaints;
  const g = cfg.green;
  /* A "kind" is one line in the story pane, and it may cover more than one 311
     descriptor: water coming up into a home is reported as both Sewer Backup and
     Excessive Water In Basement, and a resident should read one number for it.
     `ids` groups them; `id` stays the single-descriptor shorthand. */
  const kindIds = k => (k.ids || (k.id != null ? [k.id] : []));
  // The column the built-asset families group on (DEP: `asset_type`).
  const gField = g?.field || 'asset_type';
  // The descriptor set + time window shared by the point and citywide queries,
  // so the "within a half mile" number and the citywide one always count the
  // same thing.
  const complaintWhere = () => {
    const kinds = (c.kinds || []).flatMap(kindIds).map(lit).join(',');
    const parts = [];
    if (kinds) parts.push(`${c.field || 'descriptor'} in(${kinds})`);
    if (cfg.since) parts.push(`${c.dateField || 'created_date'}>=${lit(cfg.since)}`);
    return parts;
  };

  /* The green-infrastructure filter. `where` is what exists on the ground today
     (any build date, status Constructed) — the right answer to "is my block
     served?", since a rain garden built in 2016 still soaks up rain. `sinceWhere`
     is the narrower "built since Ida" cut, used only for the citywide Impact
     figure, which asks a different question: what has the city done since. */
  const greenWhere = (extra, key = 'where') => {
    const parts = [];
    if (g?.[key]) parts.push(sub(g[key]));
    if (extra) parts.push(extra);
    return parts.join(' and ');
  };

  /* ── FloodNet: measured, not reported (REB-432) ─────────────────────────
     The third dataset, and the only one that MEASURES. 311 is what New Yorkers
     phoned in; DEP is what the city built; FloodNet is what an instrument
     recorded. That is why it reads as its own line rather than joining the
     pair above it.

     Unlike the other two this is NOT a live aggregate. The useful answer needs
     both FloodNet datasets joined — sensors to their events — which is a query
     Socrata cannot do in one round trip, and the story pane already waits ~2s
     on the two it makes. `scripts/build-floodnet.mjs` does the join weekly and
     writes one ~95 KB file, so this costs a single fetch for the whole session
     and every subsequent story is answered from memory.

     Fetched once, lazily, and its failure is isolated: a missing overlay must
     leave the 311 and green numbers standing, so this never joins their
     Promise.all rejection path. */
  let sensorsP = null;
  function loadSensors() {
    const url = cfg.sensors?.overlay;
    if (!url) return Promise.resolve(null);
    if (!sensorsP) {
      sensorsP = fetch(url)
        .then(r => { if (!r.ok) throw new Error(`sensors ${r.status}`); return r.json(); })
        .then(j => (j?.features || []).map(f => ({
          lat: f.geometry?.coordinates?.[1],
          lng: f.geometry?.coordinates?.[0],
          ...f.properties,
        })).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng)))
        .catch(e => { console.warn('FloodNet overlay failed:', e); sensorsP = null; return null; });
    }
    return sensorsP;
  }

  /* Equirectangular, matching build-persistence.mjs. Sub-metre error at city
     scale against an 805 m radius. */
  const R = 6371000, RAD = Math.PI / 180;
  function metresBetween(lat1, lng1, lat2, lng2) {
    const x = (lng2 - lng1) * RAD * Math.cos(lat1 * RAD) * R;
    const y = (lat2 - lat1) * RAD * R;
    return Math.sqrt(x * x + y * y);
  }

  /* Which sensors sit inside the ring, and which one is closest. 479 points is
     a linear scan measured in microseconds — no index earns its complexity.

     `nearest` is the closest sensor, NOT the one with the most floods. That is
     the honest choice and it is deliberately the less impressive one: picking
     the worst sensor in the ring would let any story within half a mile of
     Brookville Blvd borrow its 109 floods. The sentence says "the nearest",
     so it has to be the nearest. */
  async function sensorsNear(lat, lng) {
    const all = await loadSensors();
    if (!all) return null;
    const inside = [];
    for (const s of all) {
      const m = metresBetween(lat, lng, s.lat, s.lng);
      if (m <= radius) inside.push({ ...s, m });
    }
    if (!inside.length) return null;
    inside.sort((a, b) => a.m - b.m);
    return {
      count: inside.length,
      // How many have ever measured water, so the line can distinguish "no
      // sensors here" from "sensors here, and they have stayed dry".
      measured: inside.filter(s => s.n > 0).length,
      tidal: inside.filter(s => s.tidal).length,
      nearest: inside[0],
    };
  }

  /* Complaint counts broken out by kind, plus green-infrastructure assets,
     within `radius` of one point. Returns null if either lookup fails — the
     block is context, never load-bearing, so a Socrata outage is silent. */
  async function nearPoint(lat, lng) {
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (!near.has(key)) near.set(key, lookup(lat, lng).catch(e => {
      console.warn('city data lookup failed:', e);
      near.delete(key);                        // a transient failure may retry
      return null;
    }));
    return near.get(key);
  }

  async function lookup(lat, lng) {
    const field = c.field || 'descriptor';
    /* Started here, awaited at the end. It is a local file against Socrata's
       two round trips, so kicking it off alongside them costs nothing and it
       has always resolved by the time the slow pair does. Its own catch is in
       `loadSensors`, so it cannot reject this Promise.all. */
    const sensorsWork = sensorsNear(lat, lng);
    /* In-progress DEP assets in the same radius — a SEPARATE query, never
       merged into `green`. `status_gro` values match build-persistence.mjs's
       own list for "designed or being built" (`scripts/build-persistence.mjs`,
       the `statuses` array). This is the exact mistake REB-348 was: green's
       total meant "built" and 2,021 not-yet-built assets got counted into it
       anyway. `greenWhere` already answers "is my block served" with
       Constructed-only, correctly — this just gives the panel a second,
       clearly separate number to show alongside it rather than nothing. */
    const inProgressWork = g?.url
      ? soql(g.url, {
          '$select': 'count(*) as n',
          '$where': [
            `status_gro in ('In Construction','Final Design')`,
            `within_circle(${g.geomField || 'the_geom'}, ${lat}, ${lng}, ${radius})`,
          ].join(' and '),
        }).then(r => +r?.[0]?.n || 0).catch(() => 0)
      : Promise.resolve(0);
    const [rows, greenRows, greenInProgress] = await Promise.all([
      soql(c.url, {
        '$select': `${field}, count(*) as n`,
        '$where': [...complaintWhere(), `within_circle(${c.geomField || 'location'}, ${lat}, ${lng}, ${radius})`].join(' and '),
        '$group': field,
      }),
      /* Grouped by asset type when the tenant configures `green.kinds`, so the
         built side can break down the way the 311 side does — one line per
         family instead of a single opaque total. Falls back to a plain count
         when it does not, which keeps this working for a tenant whose dataset
         has no type column. */
      g?.url
        ? soql(g.url, {
            '$select': g.kinds?.length ? `${gField}, count(*) as n` : 'count(*) as n',
            '$where': greenWhere(`within_circle(${g.geomField || 'the_geom'}, ${lat}, ${lng}, ${radius})`),
            ...(g.kinds?.length ? { '$group': gField } : {}),
          })
        : Promise.resolve([{ n: 0 }]),
      inProgressWork,
    ]);
    const kinds = (c.kinds || []).map(k => {
      const ids = kindIds(k);
      return { ...k, n: rows.filter(r => ids.includes(r[field])).reduce((a, r) => a + (+r.n || 0), 0) };
    });
    const reports = kinds.reduce((a, k) => a + k.n, 0);

    /* The green total is the SUM OF THE ROWS, not the sum of the named kinds.
       DEP publishes 31 asset types and the three families Judy asked for cover
       13,144 of 13,959 citywide: green roofs, permeable paving, cisterns and
       subsurface tanks are none of a rain garden, a basin or a planted strip.

       So there is a `rest` kind rather than a quiet reassignment, and the total
       stays whole. Dropping those 815 would have shrunk the count of things
       built near a block, which makes the "flooded and unserved" gap look
       WIDER than it is — the one direction this map must never round in, with
       that finding headed for a press release. */
    const greenKinds = greenKindsFrom(greenRows);
    const green = g?.kinds?.length
      ? greenRows.reduce((a, r) => a + (+r.n || 0), 0)
      : (+greenRows?.[0]?.n || 0);
    const sensors = await sensorsWork;
    return { kinds, reports, green, greenInProgress, greenKinds, sensors, gap: isGap(reports, green) };
  }

  /* Roll the grouped asset-type rows into the configured families. A kind with
     `rest: true` takes everything the named ones did not claim, so the lines
     always add up to the figure above them.

     The `rest` family used to collapse into ONE line with a combined label
     ("2 storage, porous paving and roofs") — Judy, 18 Aug: that reads as "2
     of each", not "2 total". Fixed by NOT merging: one line per DEP
     asset_type this radius actually has, each with its own count, same as
     the three named families already get. Nothing to translate — Socrata's
     `asset_type` values are already plain English ("Green Roof", "Permeable
     Pavers", "Subsurface Storage", ...), the same strings the Data
     Dictionary's own type table shows (`renderDictTypes` in js/app.js).
     Almost every radius only ever has one or two of these; the merged
     version implied roughly that many anyway, just without saying which. */
  function greenKindsFrom(greenRows) {
    if (!g?.kinds?.length || !Array.isArray(greenRows)) return [];
    const claimed = new Set(g.kinds.flatMap(k => kindIds(k)));
    const out = [];
    for (const k of g.kinds) {
      if (k.rest) {
        greenRows
          .filter(r => !claimed.has(r[gField]) && +r.n > 0)
          .forEach(r => out.push({ label: String(r[gField]).toLowerCase(), color: k.color, n: +r.n }));
        continue;
      }
      const n = greenRows.filter(r => kindIds(k).includes(r[gField])).reduce((a, r) => a + (+r.n || 0), 0);
      if (n > 0) out.push({ ...k, n });
    }
    return out;
  }

  /* "Flooded and unserved": the block the city hears from repeatedly but has
     not built for. Thresholds are config (calibrated against the real story
     points, where the split is stark — 307 complaints to 1 asset in Midland
     Beach against 493 to 225 in Bushwick), so a tenant can retune without
     touching this file. */
  function isGap(reports, green) {
    const t = cfg.gap;
    if (!t || reports < (t.minReports ?? 100)) return false;
    return green === 0 || reports / green >= (t.ratio ?? 25);
  }

  /* How many of a set of points sit in a "flooded and unserved" radius — the
     Impact panel's tie-in between the stories and the city's record.

     Runs a few at a time (Socrata throttles unauthenticated bursts) and reuses
     the per-point cache, so a visitor who has already read a few stories has
     paid for most of this. Caps the scan rather than firing hundreds of
     requests at a big collection; `capped` lets the caller say so. */
  async function gapScan(points, { concurrency = 5, max = 60 } = {}) {
    const list = points.filter(p => p.lat != null && p.lng != null).slice(0, max);
    let next = 0, gap = 0, checked = 0;
    const worker = async () => {
      while (next < list.length) {
        const p = list[next++];
        const d = await nearPoint(p.lat, p.lng);
        if (d) { checked++; if (d.gap) gap++; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    return { gap, checked, capped: list.length < points.filter(p => p.lat != null).length };
  }

  /* The same two datasets, citywide, for the Impact panel. */
  function cityTotals() {
    if (!totals) totals = fetchTotals().catch(e => {
      console.warn('city totals failed:', e);
      totals = null;
      return null;
    });
    return totals;
  }
  /* Three numbers, because the green-infrastructure pair answers two different
     questions and conflating them is how a map ends up comparing five years of
     complaints against twenty years of construction. `green` is everything built;
     `greenSince` is the share of it built since the storm the window is anchored
     to. The Impact panel leads on the second and carries the first as context.

     These scan the whole 311 set rather than a circle, so they are the one query
     that can be slow — measured at 0.5s warm but 19s on a cold Socrata cache.
     Hence the long timeout: nothing is waiting on it, since the Impact panel
     opens fully rendered and this section fills in late or not at all. The
     per-story lookups keep the short abort, because there a reader is sitting in
     front of an open pane. */
  const TOTALS_MS = 25000;
  async function fetchTotals() {
    const where = complaintWhere();
    const sinceW = greenWhere('', 'sinceWhere');
    const [rows, greenRows, sinceRows] = await Promise.all([
      soql(c.url, { '$select': 'count(*) as n', ...(where.length ? { '$where': where.join(' and ') } : {}) }, TOTALS_MS),
      g?.url ? soql(g.url, { '$select': 'count(*) as n', ...(greenWhere() ? { '$where': greenWhere() } : {}) }, TOTALS_MS) : Promise.resolve([{ n: 0 }]),
      g?.url && sinceW ? soql(g.url, { '$select': 'count(*) as n', '$where': sinceW }, TOTALS_MS) : Promise.resolve(null),
    ]);
    return {
      reports: +rows?.[0]?.n || 0,
      green: +greenRows?.[0]?.n || 0,
      greenSince: sinceRows ? (+sinceRows?.[0]?.n || 0) : null,
    };
  }

  /* REB-453. The exact `$where` clauses this module sends, for the data
     dictionary to print.

     Deliberately the real closures rather than a second copy assembled from the
     same config: a dictionary that documents a filter the app does not actually
     use is worse than no dictionary, and a printed copy is guaranteed to drift
     the first time somebody adds a descriptor. `sinceWhere` is resolved through
     `sub()` here exactly as it is on the wire, so `{today}` shows as the date
     the reader is looking at it. */
  const filters = () => ({
    complaints: complaintWhere().join(' and '),
    green: greenWhere(),
    greenSince: g?.sinceWhere ? greenWhere(null, 'sinceWhere') : '',
  });

  return { nearPoint, gapScan, cityTotals, radius, filters, config: cfg };
}
