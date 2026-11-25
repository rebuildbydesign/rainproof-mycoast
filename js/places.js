/* Turning a point into a neighbourhood name, and offering those names as
   suggestions when there is no point.

   Why this exists: the neighbourhood field was free text, so "Bed-Stuy",
   "bedford stuyvesant" and "Bedfrod-Stuyvesant" were all one keystroke apart and
   all different to a filter. The map's Area facet, the "more stories nearby"
   list and any borough-level count are only as good as that string. Typing it is
   also work a resident should not have to do when they have just dropped a pin
   on their own block.

   The lookup runs against the NTA boundary file the map already ships
   (`overlays/nta-neighborhoods.geojson`, 262 polygons, ~320 KB), so the answer is
   always an official name spelled exactly one way, and no geocoding service is
   involved — nothing about a resident's location leaves their device.

   Loaded lazily and once: nobody pays for it unless they reach the location
   step. */

let loading = null;
let index = null;   // [{ name, boro, label, rings, bbox }]

export function loadPlaces(url = 'overlays/nta-neighborhoods.geojson') {
  if (index) return Promise.resolve(index);
  if (!loading) {
    loading = fetch(url)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`places ${r.status}`))))
      .then(gj => { index = build(gj); return index; })
      .catch(e => { loading = null; console.warn('neighbourhood lookup unavailable:', e); return null; });
  }
  return loading;
}

function build(gj) {
  const out = [];
  for (const f of gj.features || []) {
    const name = f.properties?.ntaname;
    if (!name || !f.geometry) continue;
    const boro = f.properties?.boroname || '';
    // Polygon → [rings]; MultiPolygon → many. Flatten to a list of ring-sets so
    // the hit test does not care which it was.
    const polys = f.geometry.type === 'MultiPolygon'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    for (const rings of polys) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of rings[0]) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      out.push({ name, boro, label: boro ? `${name}, ${boro}` : name, rings, bbox: [minX, minY, maxX, maxY] });
    }
  }
  return out;
}

/* Standard ray casting. The first ring is the outer boundary; any further rings
   are holes, so a point inside a hole is outside the polygon. */
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(x, y, rings) {
  if (!inRing(x, y, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (inRing(x, y, rings[i])) return false;
  return true;
}

/* The neighbourhood containing a point, or null if it is outside every one of
   them — which is the honest answer for a pin dropped in the harbour, or outside
   the city entirely. Callers must not invent a name in that case. */
export function neighbourhoodAt(lat, lng) {
  if (!index) return null;
  for (const p of index) {
    const [minX, minY, maxX, maxY] = p.bbox;
    if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;  // cheap reject
    if (inPolygon(lng, lat, p.rings)) return p.label;
  }
  return null;
}

/* The borough containing a point, or null outside all five (REB-522). Same
   index and same test as `neighbourhoodAt`; it returns the borough on its own
   rather than "Name, Borough", because the findings panel tabulates by borough
   and splitting that label back apart would break on any NTA whose name has a
   comma in it. Null is the honest answer for a pin in the harbour, and the
   caller must not guess. */
export function boroughAt(lat, lng) {
  if (!index) return null;
  for (const p of index) {
    const [minX, minY, maxX, maxY] = p.bbox;
    if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
    if (inPolygon(lng, lat, p.rings)) return p.boro || null;
  }
  return null;
}

/* NTA names are administrative, not what anyone calls where they live. A pin in
   Red Hook lands in "Carroll Gardens-Cobble Hill-Gowanus-Red Hook", which is
   accurate, unusable as a label, and would not group with the plain "Red Hook,
   Brooklyn" already on the map.

   So a hyphenated NTA is treated as what it is — several neighbourhoods sharing
   one boundary — and split back into them. Parenthetical qualifiers go too:
   "Bushwick (East)" is Bushwick to the person who lives there. */
function splitNta(name) {
  return name
    .replace(/\s*\([^)]*\)/g, '')      // "Bushwick (East)" → "Bushwick"
    .split('-')
    .map(s => s.trim())
    .filter(Boolean);
}

/* The neighbourhoods a point could be described as, best first. One entry means
   we can fill the field outright; several means the resident should choose,
   because the boundary genuinely cannot tell us which of them they mean. */
export function neighbourhoodOptionsAt(lat, lng) {
  if (!index) return [];
  for (const p of index) {
    const [minX, minY, maxX, maxY] = p.bbox;
    if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
    if (!inPolygon(lng, lat, p.rings)) continue;
    const boro = p.boro ? `, ${p.boro}` : '';
    return splitNta(p.name).map(n => `${n}${boro}`);
  }
  return [];
}

/* Every name a resident might reasonably type, for the datalist. Includes both
   the split parts and the full NTA label, so "Red Hook" is offered and anyone
   who wants the official mouthful can still have it. */
export function placeNames() {
  if (!index) return [];
  const out = new Set();
  for (const p of index) {
    const boro = p.boro ? `, ${p.boro}` : '';
    out.add(`${p.name}${boro}`);
    for (const part of splitNta(p.name)) out.add(`${part}${boro}`);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}
