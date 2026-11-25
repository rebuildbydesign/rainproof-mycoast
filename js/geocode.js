/* One NYC lookup, shared by the map's search card, the phone's map bar
   (js/ui.js) and the submission form's location field (js/form.js) — REB-507:
   "the address field in REB-497 is the same geocoding capability pointed at the
   submission form. Build the lookup once and use it in both places."

   IT IS TWO REQUESTS, NOT ONE, AND THAT IS NOT AN ACCIDENT.

   Mapbox split this capability across two products and neither half is enough
   on its own. Measured against this account's token on 19 August:

     Geocoding v5     neighbourhoods and addresses rank correctly. NO POI AT
                      ALL — `types=poi` returns zero for Empire State Building,
                      and dropping the type filter entirely returns zero for
                      Barclays Center. POI was moved out of Geocoding, and v6
                      does not have it either.
     Search Box       has the POI. But "Windsor Terrace" answers with a yoga
                      studio and a martial arts school before the neighbourhood,
                      because everything it holds is a business.

   So: ask both, in parallel, and take what each is good at. Wall clock is the
   slower of the two, not the sum, and Search Box failing leaves the v5 results
   standing rather than breaking the field.

   `bbox` is a hard clip in v5, not a bias, so a search for "Main St" cannot
   resolve to New Jersey — the same five-borough box `tenant.map.bounds` frames
   the map to (config.json), so "where an address can resolve to" and "the map's
   own extent" are one number, not two. */
const NYC_BBOX = '-74.2591,40.4774,-73.7002,40.9176';

/* `place` is deliberately absent: it resolves to the city or the borough, and a
   story pinned in the middle of Brooklyn is a story about nowhere. */
const V5_TYPES = 'address,neighborhood,locality';

async function geocodeV5(token, query) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`
    + `?access_token=${encodeURIComponent(token)}&country=us&bbox=${NYC_BBOX}`
    + `&types=${V5_TYPES}&autocomplete=true&limit=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geocode ${res.status}`);
  const data = await res.json();
  return (data.features || []).map(f => ({ place_name: f.place_name, center: f.center, kind: 'v5' }));
}

/* Landmarks. The field has promised "Landmark" since it was written and could
   never return one. `forward` rather than `suggest`/`retrieve` because it hands
   back coordinates in a single call, which keeps the shape below identical to
   what v5 returns and the two call sites unchanged. */
async function searchBoxPOI(token, query) {
  const url = `https://api.mapbox.com/search/searchbox/v1/forward?q=${encodeURIComponent(query)}`
    + `&access_token=${encodeURIComponent(token)}&country=US&bbox=${NYC_BBOX}&limit=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`searchbox ${res.status}`);
  const data = await res.json();
  return (data.features || [])
    .filter(f => f.properties?.feature_type === 'poi' && f.geometry?.coordinates)
    .map(f => {
      const p = f.properties;
      const where = p.place_formatted || p.full_address || '';
      return {
        place_name: where ? `${p.name}, ${where}` : p.name,
        name: p.name,
        center: f.geometry.coordinates,
        kind: 'poi',
      };
    });
}

export async function geocodeNYC(token, query) {
  const [v5, poi] = await Promise.all([
    geocodeV5(token, query),
    // A landmark we cannot reach is a missing suggestion; an address we cannot
    // reach is a resident who cannot submit. Only the first one is allowed to
    // fail quietly.
    searchBoxPOI(token, query).catch(() => []),
  ]);

  /* A POI outranks everything only when the query IS its name. "Barclays
     Center" and "New York University" are what somebody typing a landmark
     means. "Windsor Terrace" is not "Windsor Terrace Martial Arts", so the
     neighbourhood keeps the top of the list — which is the case Judy asked
     for first and the more common one by far. */
  const q = query.trim().toLowerCase();
  /* One row per landmark NAME. A big campus or arena is half a dozen points in
     Search Box — "New York University" comes back five times, one per building
     — and five identical lines push everything else off a six-row list while
     asking the resident to choose between rows they cannot tell apart. */
  const byName = new Set();
  const poi1 = poi.filter(f => {
    const n = (f.name || '').trim().toLowerCase();
    if (byName.has(n)) return false;
    byName.add(n);
    return true;
  });
  const exact = poi1.filter(f => (f.name || '').trim().toLowerCase() === q);
  const rest = poi1.filter(f => !exact.includes(f));

  const seen = new Set();
  return [...exact, ...v5, ...rest].filter(f => {
    const key = `${f.place_name}@${f.center.map(n => n.toFixed(4)).join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}
