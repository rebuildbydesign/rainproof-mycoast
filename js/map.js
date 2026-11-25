/* Map + overlays. Everything rendered here comes from the tenant config:
   basemap style, camera, and the overlay list (which may be empty).

   Layouts that demote the map (Record's collapsed inset) pass { defer: true }:
   nothing touches Mapbox — no basemap tiles, no token use — until init() is
   called on first reveal. Every method is safe to call before then; the
   latest stories are kept and applied once the map exists. */
import { storyPinColor, storyIcon } from './config.js';
import { GLYPH_D } from './ui/icons.js';
import { monthYear as apMonthYear } from './dates.js';

export function createMapController(tenant, { onStoryClick, onMapClick, onOverlayLoading, onPartnerClick }, { defer = false } = {}) {
  const partnerLayers = []; // clickable partner pins; a click on one is not "add a story here"
  let map = null;
  let started = false;
  const overlayGeo = {};   // labelled overlay data, for neighbourhood highlight
  const lazyLayers = {};   // overlays with a `source`: fetched on first toggle, not at load
  const loading = new Set(); // guards against double-fetching a live overlay
  let lastStories = [];
  let pinMarker = null;

  const overlayState = {};
  (tenant.overlays?.layers || []).forEach(l => { overlayState[l.id] = !!l.defaultOn; });

  // Radius focus (an open story): the unclipped data per live layer, plus the
  // on/off state to put back when the story closes.
  const fullData = {};
  let focusSaved = null;
  // Base icon-size stops per shaped layer, so `focusScale` can rebuild them.
  const shapeSize = {};

  const hoverReg = [];   // { layerId, layer } — invisible hit layers for map tooltips
  let tipEl = null;

  // Per-layer hover/selected feature ids for boundary layers (council,
  // community), plus the fill layer ids so the empty-map click handler
  // knows to yield to them instead of opening "add a story here".
  const boundaryState = new Map();   // layer.id -> { hoveredId, selectedId }
  const boundaryHitLayers = [];

  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });

  /* Judy, 17 August: on load, Staten Island and the Bronx were cut off — the
     old center/zoom pair was tuned by eye, not fit to the five boroughs. This
     is the padding both the initial `bounds` fit below and the "return to
     default view" reset in focusNeighborhood() use, so the two never drift
     into showing a different "default" from each other.

     A static width check, not a measured `.side.open` rect like fitRadius
     uses — at construction time the side pane has not opened yet (atlas.js
     opens it on a delay on desktop, never automatically on a phone), so
     there is nothing to measure. Matches atlas.js's own `>= 768` breakpoint
     for whether the pane opens at all. */
  function defaultPadding() {
    const desktop = window.innerWidth >= 768;
    // Phone: nothing is beside the map any more, the bar and the count pill
    // are under it (direction B), so the reserve moved from left to bottom.
    return desktop
      ? { top: 70, bottom: 40, left: 404, right: 16 }
      : { top: 70, bottom: 150, left: 16, right: 16 };
  }

  function init() {
    if (started) return ready;
    started = true;

    mapboxgl.accessToken = tenant.map.mapboxToken;
    map = new mapboxgl.Map({
      container: 'map',
      style: tenant.map.styleUrl,
      // `bounds` + `fitBoundsOptions` replaces center/zoom when the tenant
      // gives a bounding box, so "default view" means "all five boroughs
      // fit", computed once at construction rather than an eyeballed pair.
      ...(tenant.map.bounds
        ? { bounds: tenant.map.bounds, fitBoundsOptions: { padding: defaultPadding() } }
        : { center: tenant.map.center, zoom: tenant.map.zoom }),
      minZoom: tenant.map.minZoom ?? 2,
    });

    /* `?debugmap` exposes the Mapbox instance for inspection. Opt-in, so it is
       absent from every normal page load.

       It exists because this project's canvas cannot be trusted to paint in an
       automation browser — repeatedly today a screenshot came back blank while
       the app was working perfectly, which makes "did that layer render?"
       unanswerable by eye. With this, the question is answerable exactly:
       `__map.getLayer(id).type`, `__map.hasImage(name)`,
       `__map.queryRenderedFeatures({layers:[id]}).length`. A layer that fails
       to add is otherwise invisible in every other way — the toggle works, the
       panel fills, the key renders, and only the map is empty. */
    if (new URLSearchParams(location.search).has('debugmap')) window.__map = map;

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(
      new mapboxgl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }),
      'bottom-right'
    );

    // 'load' can be slow (or stall entirely in headless contexts) on some
    // basemap styles; 'idle' also fires once rendering settles. Set up on
    // whichever arrives first.
    let setUp = false;
    const setup = async () => {
      if (setUp) return;
      setUp = true;
      map.addSource('stories', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      // Story raindrops are a GL symbol layer (not DOM markers): they stay
      // pinned to the map like any geo point — no per-frame repositioning as
      // you pan or zoom — and hundreds render cheaply. No glow halo behind them.
      map.addLayer({
        id: 's-drops',
        type: 'symbol',
        source: 'stories',
        layout: {
          'icon-image': ['get', 'dropImg'],
          'icon-size': 1,
          'icon-allow-overlap': true,     // show every story, like the DOM markers did
          'icon-ignore-placement': true,
          'icon-anchor': 'center',
        },
      });
      // Click a raindrop → open its story; the cursor shows it's tappable.
      map.on('click', 's-drops', e => {
        const f = e.features?.[0];
        if (f) onStoryClick?.(f.properties.storyId);
      });
      map.on('mouseenter', 's-drops', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 's-drops', () => { map.getCanvas().style.cursor = ''; });
      // A click on empty map (not a raindrop) offers add-a-story-here.
      map.on('click', e => {
        // A click that selects a council district or community board is not
        // a click to start a story here — the boundary layers get first say.
        const blockers = ['s-drops', ...[...boundaryHitLayers, ...partnerLayers].filter(id => map.getLayer(id))];
        if (map.queryRenderedFeatures(e.point, { layers: blockers }).length) return;
        onMapClick?.(e.lngLat.lat, e.lngLat.lng);
      });
      map.on('contextmenu', e => onMapClick?.(e.lngLat.lat, e.lngLat.lng));
      setupHover();

      await loadOverlays();
      applyStories();
      resolveReady();
    };
    map.on('load', setup);
    map.once('idle', setup);
    // Neither event fires until the map first RENDERS — and a canvas that
    // sits below the fold at construction (Story's companion map lives
    // under the hero) may not render until scrolled into view. The style
    // still loads either way, so poll for it as the fallback trigger.
    const poll = setInterval(() => {
      if (setUp) { clearInterval(poll); return; }
      if (map.isStyleLoaded()) { clearInterval(poll); setup(); }
    }, 250);
    return ready;
  }

  if (!defer) init();

  async function loadOverlays() {
    for (const layer of tenant.overlays?.layers || []) {
      /* A layer with a `source` is lazy: fetched on the first toggle, never on
         page load, so it costs nothing until asked for.

         Keyed on HAVING a source, not on its type. REB-414 froze the four bulk
         layers from `socrata` to `columns`, and this gate still read the
         literal string — so they registered as neither lazy nor static and
         were simply never loaded. Nothing errored, because nothing ran: the
         layers toggled on, drew nothing, and reported an empty badge. */
      if (layer.source) {
        lazyLayers[layer.id] = layer; continue;
      }
      try {
        if (layer.type === 'geojson') {
          const res = await fetch(layer.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          // generateId: true only for boundary layers that need per-feature
          // hover/select — it's what lets setFeatureState target one district
          // or board rather than the whole layer.
          map.addSource(`ov-${layer.id}`, {
            type: 'geojson', data,
            ...(layer.hoverHighlight ? { generateId: true } : {}),
          });
          /* The unclipped copy, same as the Socrata path keeps. Without it a
             static layer can be named in `cityData.focusLayers` and silently
             never clip, because `focusRadius` clips from here rather than from
             the source. */
          fullData[layer.id] = data;
          addOverlayLayer(layer);
          /* REB-448. A static overlay never passes through `addLazyLayer`, so
             it never reported a count and its panel badge stayed empty — which
             is why FloodNet showed the word "Measured" instead of 479.
             Opt-in via `countFeatures`, not automatic: counting features on the
             flood-extent layers would put a polygon tally in a slot that reads
             as a record total. */
          if (layer.countFeatures) onOverlayLoading?.(layer.id, false, data.features?.length ?? 0, data.meta || null);
          // labelled boundary layers get a dissolved-outline companion source,
          // present but empty until an Area is selected (see focusNeighborhood).
          if (layer.labelField) {
            overlayGeo[layer.id] = { data, field: layer.labelField };
            map.addSource(`ov-${layer.id}-outline`, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({
              id: `ov-${layer.id}-outline`,
              type: 'line',
              source: `ov-${layer.id}-outline`,
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: { 'line-color': layer.highlightColor || '#D63B3B', 'line-width': 2.5, 'line-dasharray': [2, 1.5], 'line-opacity': 0.95 },
            }, 's-drops');
          }
        }
      } catch (e) {
        console.warn(`overlay '${layer.id}' failed to load:`, e);
      }
    }
  }

  // Which property a stepped layer paints from.
  const stepField = layer => layer.steps?.field || 'value';

  function stepRamp(layer, field) {
    const stops = layer.steps?.stops || [];
    const ramp = ['step', ['get', field], stops[0]?.color || layer.color];
    stops.slice(1).forEach(s => ramp.push(s.at, s.color));
    return ramp;
  }

  /* Radius grows with the step as well as the colour, so the heaviest blocks
     stay findable when zoomed out and the pale one-call blocks recede instead
     of speckling the whole city.

     The domain comes from the configured stops, not a constant: painting by
     call count runs 1..20+ where painting by years ran 1..5, and a hardcoded
     top of 5 would draw a 5-call block and a 78-call block at the same size. */
  const stepRadius = (field, layer) => {
    const stops = layer?.steps?.stops || [];
    const hi = Math.max(2, stops[stops.length - 1]?.at ?? 5);
    /* The bottom of the size domain is the first configured stop, not a
       constant 1. The 311 layers start at 1 (a block with no calls is simply
       not in the data), so nothing changes for them. FloodNet starts at 0,
       because "installed, has never measured flooding" is a real value there
       and 193 of 479 sensors hold it — REB-352's trap 3, do not render "no
       data" and "no flooding" the same way. Anchoring at 0 lets those dots be
       genuinely smaller instead of clamping up to the size of a sensor that
       has measured water once. */
    const lo = stops[0]?.at ?? 1;
    /* One layer can be drawn bigger than the rest without forking this scale.
       FloodNet is 479 points where the 311 layers are 15,000-plus blocks, so
       the size that keeps the city legible for them leaves it nearly invisible
       — which is what Judy rejected on 10 August, and what the diamond was
       introduced to fix. The sensors are circles again as of 12 August, so the
       size has to come from somewhere: `steps.radiusScale`. Absent, nothing
       changes for anyone.

       It FADES OUT as you zoom in, and that is the point rather than a detail.
       The problem it solves only exists at the citywide view: at zoom 10 a
       stepped dot is 1.4–3.4px and a sensor is a speck, while by zoom 16 it is
       already 7–15px and a flat multiplier would paint 57px discs over the
       street they sit on. Full strength at 10, half at 13, gone by 16. */
    const k = layer?.steps?.radiusScale ?? 1;
    const at = (small, big, mul) =>
      ['interpolate', ['linear'], ['get', field], lo, small * mul, hi, big * mul];
    return ['interpolate', ['linear'], ['zoom'],
      10, at(1.4, 3.4, k),
      13, at(3, 7, 1 + (k - 1) / 2),
      16, at(7, 15, 1)];
  };

  /* A plain circle layer can scale with zoom too (REB-423). The DEP assets were
     a fixed 2px: right for the whole-city view, and all but invisible at the
     block scale, which is exactly where someone is asking "is there anything on
     my street". Config gives [[zoom, radius], …]; a layer with no radiusByZoom
     keeps its single fixed radius. */
  const zoomRadius = layer =>
    Array.isArray(layer.radiusByZoom) && layer.radiusByZoom.length
      ? ['interpolate', ['linear'], ['zoom'], ...layer.radiusByZoom.flat()]
      : layer.radius ?? 6;


  /* Only the top steps get a stroke; outlining 15,000 pale dots turns the city
     into static. Both of these are data-only expressions, so they are legal
     anywhere — including nested inside a zoom interpolation, which is the one
     direction Mapbox allows. */
  const stepStroke = (st, field) => ['step', ['get', field], 0, (st.strokeFrom ?? 4), 0.8];
  const flagStroke = (st, field, w) =>
    ['case', ['to-boolean', ['get', st.flagField]], w, stepStroke(st, field)];

  /* REB-479. Which features a stepped layer actually DRAWS. Extracted because
     the tooltip has to ask the same question the paint does: the hit layer had
     no filter, so a cell with 0 street-flooding calls still answered for the
     street layer, and the tooltip said "0 calls" while the dot under the
     cursor belonged to a different layer entirely. Judy caught it hovering.

     Same rule as before: a first stop above 0 means 0 is not in the domain and
     the feature is not drawn. FloodNet's first stop is deliberately at 0
     because "installed, never measured a flood" is a real value it has to
     draw, and that value renders slate — grey, not a step on the ramp. */
  const stepFilter = layer => {
    const st = layer.steps || {};
    return (st.stops?.[0]?.at ?? 0) > 0
      ? ['>=', ['get', stepField(layer)], st.stops[0].at]
      : ['all'];
  };

  // Add the render layer for an overlay whose source already exists.
  // renderAs: 'steps' | 'circle' | 'line' | (default) 'fill'.
  function addOverlayLayer(layer) {
    const vis = overlayState[layer.id] ? 'visible' : 'none';
    /* WHERE THIS LAYER SITS IN THE STACK. Everything defaults to sitting directly
       under the story pins, which means paint order is really TOGGLE order: the
       last overlay switched on lands on top of the ones before it.

       That is fine until two layers are meant to be read against each other.
       `f2100` has no `defaultOn`, so it is always added after `current` and always
       covered it — and REORDERING `overlays.layers` DOES NOT FIX THAT, which cost a
       round of trying. Judy, 17 August: put today's flooding on top of 2100 so the
       difference between them is visible.

       `stackUnder` names another layer this one must sit beneath. Falls back to
       's-drops' when that layer has not been added yet, so toggling in either order
       is safe — and the one case that matters, `current` being on at load, always
       has it there first. */
    const under = layer.stackUnder && map.getLayer(`ov-${layer.stackUnder}`)
      ? `ov-${layer.stackUnder}`
      : 's-drops';
    // Partner pin drawn from the partner's own SVG; click opens their report.
    if (layer.renderAs === 'icon') {
      addIconLayer(layer, under);
      return;
    }
    /* A stepped choropleth of points: circle colour comes from a field rather
       than from the layer's single colour. This is what the three 311 layers
       use, and the whole reason they are not heatmaps: a density blur paints the
       sum of everything inside its radius, so two blocks with identical counts
       render differently depending on how busy their neighbours are (REB-417).

       Every ramp is a stock ColorBrewer sequential scheme taken verbatim from
       colorbrewer2.org rather than hand-mixed (Judy's call, 12 Aug): street
       flooding Reds, clogged storm drains RdPu, water in basements Purples,
       FloodNet YlOrBr, DEP assets Greens.

       Each one is a five-step WINDOW onto that scheme's 7-class version, not
       its 5-class version. Judy's read of the 5-class ramps was that they
       looked mute, and the reason is structural rather than a matter of taste:
       most blocks in this data report once or twice, so the bulk of every layer
       paints in its two palest classes, which at 5 classes are near-white on a
       91%-grey basemap. Sliding the window one notch up the 7-class scheme
       (classes 2-6) keeps the published, colour-blind-safe scheme and moves the
       common case into a colour you can actually see: the palest street step
       went 1.02:1 to 1.34:1 against the basemap.

       Do not nudge an individual step. Slide the whole window, or re-pick the
       whole scheme — a hand-tuned step is no longer ColorBrewer and nobody
       downstream can tell which ones were touched.

       The palest steps still fall below 3:1 against the basemap, which is
       intended for a "reported once" block but means colour can never do the
       work alone: the legend carries written labels and the hover gives the
       real count. */
    if (layer.renderAs === 'steps') {
      const st = layer.steps || {};
      const field = stepField(layer);
      const ramp = stepRamp(layer, field);

      /* A stepped layer can render as marks instead of circles when its config
         asks for a shape. Everything else about it is unchanged — same source,
         same field, same stops, same hover — so the panel scale that reads
         `steps.stops` keeps describing it correctly. */
      if (st.shape === 'diamond') {
        const stops = st.stops || [];
        /* Every image registered before the layer is added: `icon-image` names
           an image, and a name the style cannot resolve renders nothing at all
           rather than erroring, which would look exactly like the layer being
           broken. Two per stop, plain and flagged. */
        const named = stops.map(s => ({
          at: s.at,
          plain: markImgName(s.color, null),
          flagged: markImgName(s.color, st.flagColor || '#1B5FBF'),
        }));
        const pick = key => {
          const e = ['step', ['get', field], named[0][key]];
          named.slice(1).forEach(n => e.push(n.at, n[key]));
          return e;
        };
        /* Size grows with the step as well as the colour, the way the circle
           radius did, so a sensor that has measured water twenty times is not
           the same mark as one that never has. `interpolate` over zoom on the
           outside, `step` on the data inside each stop — Mapbox rejects zoom
           anywhere but the top level, which cost a shipped-broken layer once
           already today. */
        const hi = Math.max(2, stops[stops.length - 1]?.at ?? 5);
        const lo = stops[0]?.at ?? 1;
        const sizeAt = (small, big) =>
          ['interpolate', ['linear'], ['get', field], lo, small, hi, big];
        map.addLayer({
          id: `ov-${layer.id}`,
          type: 'symbol',
          source: `ov-${layer.id}`,
          layout: {
            'icon-image': st.flagField
              ? ['case', ['to-boolean', ['get', st.flagField]], pick('flagged'), pick('plain')]
              : pick('plain'),
            'icon-size': ['interpolate', ['linear'], ['zoom'],
              10, sizeAt(0.30, 0.46),
              13, sizeAt(0.44, 0.70),
              16, sizeAt(0.62, 1.00)],
            // Show every sensor. Mapbox hides colliding symbols by default,
            // which on a 479-point layer silently drops the dense clusters —
            // and the dense clusters are the finding.
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            visibility: vis,
          },
        }, under);
        addHitLayer(layer);
        return;
      }
      map.addLayer({
        id: `ov-${layer.id}`,
        type: 'circle',
        source: `ov-${layer.id}`,
        /* Anything below the first configured step is not in this layer's
           domain and must not draw. It became load-bearing with REB-414: the
           three 311 layers now share one `flood311.json`, so every block in the
           city is a feature in all three sources and only its `s`/`d`/`h`
           column says whether it belongs to this one. Without the filter, the
           23,171 blocks with no street-flooding call would paint in the palest
           "1 call" colour and the layer would claim the whole city.

           A live Socrata layer is unaffected — a grouped count query only ever
           returned blocks with at least one call, so the filter is a no-op
           there. FloodNet is unaffected too but for the opposite reason: its
           first stop is deliberately at 0, because "installed, never measured
           a flood" is a real value it has to draw (REB-432). */
        filter: stepFilter(layer),
        paint: {
          'circle-radius': stepRadius(field, layer),
          'circle-color': ramp,
          'circle-opacity': layer.opacity ?? 0.85,
          /* Only the top steps get a stroke; outlining 15,000 pale dots turns
             the city into static.

             `flagField` overrides that for marks carrying a confound the colour
             cannot express. NOTHING USES IT RIGHT NOW. FloodNet did until 12
             August, when Judy took the tidal ring off the map as too technical
             for this round.

             Read this before wiring it to anything, because the reason it was
             built has not gone away: 64 of 479 sensors (13%) are tidally
             influenced and they account for **70% of every flood event in the
             dataset** — the entire top fifteen by flood count. Sizing by flood
             count without saying so draws the Rockaways and Broad Channel as
             the worst-hit places on a map whose subject is rain that cannot
             drain, which is a different phenomenon measured by the same
             instrument. That is the state the map is in today, knowingly. The
             caveat still stands in the half-mile panel (`cityData.tidalNote`)
             and in the methodology note, which is where it survives for now. */
          /* The flag ring scales with zoom, because the dot it rings does. At
             the citywide view a stepped dot is 1.4–3.4px, so a flat ring would
             be wider than its own dot and the 64 tidal sensors would read as
             blue blobs — a fourth category rather than an annotation on the
             amber one. These three stops track `stepRadius`'s own breakpoints.

             `interpolate` on the OUTSIDE and `case` within each stop, never the
             other way round. Mapbox rejects a `zoom` expression anywhere but
             the top level of a step/interpolate, and the inverted version threw
             at addLayer — which `loadOverlays` catches, so the layer simply
             never existed and the map drew nothing at all with no sign of why. */
          'circle-stroke-width': st.flagField
            ? ['interpolate', ['linear'], ['zoom'],
                10, flagStroke(st, field, 0.8),
                13, flagStroke(st, field, 1.4),
                16, flagStroke(st, field, 2.2)]
            : stepStroke(st, field),
          'circle-stroke-color': st.flagField
            ? ['case', ['to-boolean', ['get', st.flagField]], st.flagColor || '#1B5FBF', 'rgba(255,255,255,0.9)']
            : 'rgba(255,255,255,0.9)',
        },
        layout: { visibility: vis },
      }, under);
      addHitLayer(layer);
      return;
    }
    /* A CIRCLE layer can ask for a shape too.

       NOTHING USES THIS RIGHT NOW, exactly like the diamond branch above it. The
       DEP assets were triangles for about an hour on 17 August, so they could not
       be mistaken for a 311 dot, and Judy reverted it after seeing the two layers
       together: "I regret making them triangles. It's actually worse when 311 calls
       are toggled on." The differentiation argument was tested on the real map and
       lost. Re-doing it is `"shape": "triangle"` plus `"shapePxByZoom"` in the
       layer's `steps` block, and the note there records why not to.

       Why this is here and not in the stepped renderer's `shape` branch above:
       that one sizes each mark by its own field value, which is right for a count
       (a sensor with twenty floods is a bigger mark) and WRONG for a status code.
       Built and in-progress are categories, not magnitudes; sizing them
       differently would say one matters more. Size comes from `radiusByZoom` only.

       SIZE IS ITS OWN NUMBER IN CONFIG, in plain pixels, via
       `steps.shapePxByZoom`. It was first derived from `radiusByZoom` times 1.18,
       which was wrong twice over: it coupled the triangle to a radius that only
       ever described a circle, and 1.18 was far too timid — Judy, 17 August: "the
       triangles are very tiny compared to geopoints".

       Measured, which is why the first attempt lost. A 311 dot is 2.8–6.8px across
       at zoom 10, 6–14px at 13 and 14–30px at 16 (`stepRadius`, doubled for
       diameter). The derived triangles were 5.2 / 8.0 / 15.3px tall, so at the
       citywide view they were SMALLER than a busy 311 block while representing one
       asset each — and a triangle of a given height reads smaller than a circle of
       that diameter anyway, because it carries less ink in the same box.

       These heights sit at or above the top of the 311 range instead. Anyone
       retuning them should do it here in config, in pixels, and not go looking for
       a multiplier in the JS. A 56px image at pixelRatio 2 is 28 CSS px at
       icon-size 1, which is the only conversion this code does. */
    const shape = layer.steps?.shape;
    if (layer.renderAs === 'circle' && (shape === 'triangle' || shape === 'diamond')) {
      const imgFor = shape === 'diamond' ? (c => markImgName(c, null)) : triImgName;
      const field = layer.steps ? stepField(layer) : null;
      const stops = layer.steps?.stops || [];
      /* NO STOPS IS A REAL AND SUPPORTED CASE, not an oversight to guard against.
         FloodNet is drawn this way from 17 August: one flat colour, no ramp, so the
         panel prints no colour key for it — `layerScales` keys off
         `steps.stops?.length`, so removing the stops removes the scale. Judy: "no
         color scale when layer is selected, the toolbar is helpful enough", meaning
         the hover already says how many times that sensor measured water.

         A one-stop `step` expression is NOT the way to do that: Mapbox requires at
         least one stop pair after the fallback, so `['step', input, colour]` alone
         throws at addLayer, and `loadOverlays` swallows it — the layer would simply
         never exist, which is the exact failure mode `?debugmap` was added for. */
      const iconExpr = stops.length
        ? (() => {
            const e = ['step', ['get', field], imgFor(stops[0].color)];
            stops.slice(1).forEach(s => e.push(s.at, imgFor(s.color)));
            return e;
          })()
        : imgFor(layer.color || '#333');
      const px = Array.isArray(layer.steps?.shapePxByZoom) && layer.steps.shapePxByZoom.length
        ? layer.steps.shapePxByZoom
        // Fallback for a shaped layer that gives no sizes: derive from the radius
        // it would have drawn at, scaled up because a triangle carries less ink.
        : (Array.isArray(layer.radiusByZoom) && layer.radiusByZoom.length
            ? layer.radiusByZoom
            : [[10, layer.radius ?? 3], [16, (layer.radius ?? 3) * 2]]
          ).map(([z, r]) => [z, r * 2 * 1.8]);
      const sizeStops = px.flatMap(([z, h]) => [z, +(h / 28).toFixed(3)]);
      shapeSize[layer.id] = { stops: sizeStops, focusScale: layer.steps?.focusScale || 1 };
      map.addLayer({
        id: `ov-${layer.id}`,
        type: 'symbol',
        source: `ov-${layer.id}`,
        layout: {
          'icon-image': iconExpr,
          'icon-size': ['interpolate', ['linear'], ['zoom'], ...sizeStops],
          /* Draw every asset. Mapbox hides colliding symbols by default, which on
             a 13,959-point layer silently drops exactly the dense clusters that
             are the finding — the same reason the FloodNet diamonds set both. */
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          visibility: vis,
        },
      }, under);
      addHitLayer(layer);
      return;
    }

    // Default (no renderAs) is 'fill' — matches the flood-risk overlays; 'circle'
    // and 'line' are opt-in.
    map.addLayer({
      id: `ov-${layer.id}`,
      type: layer.renderAs === 'circle' ? 'circle' : layer.renderAs === 'line' ? 'line' : 'fill',
      source: `ov-${layer.id}`,
      paint: layer.renderAs === 'circle'
        ? {
            'circle-radius': zoomRadius(layer),
            /* A circle layer may carry a `steps` ramp for COLOUR while keeping a
               plain radius. The stepped renderer above sizes by its field too,
               which is right for a count and wrong for a status code: DEP assets
               are one dot per thing and every dot is the same size whatever its
               status. */
            'circle-color': layer.steps ? stepRamp(layer, stepField(layer)) : layer.color,
            'circle-opacity': layer.opacity ?? 0.8,
            'circle-stroke-width': layer.strokeWidth ?? 1.5,
            'circle-stroke-color': 'white',
          }
        : layer.renderAs === 'line'
        /* `hoverHighlight` layers (council, community) stay their OWN colour at
           every state — the ask was to tell hover/selected apart per boundary
           layer, not to repaint them a shared generic highlight colour. Only
           width and opacity move. */
        ? {
            'line-color': layer.color,
            'line-width': layer.hoverHighlight
              ? ['case',
                  ['boolean', ['feature-state', 'selected'], false], (layer.width ?? 1) + 1.6,
                  ['boolean', ['feature-state', 'hover'], false], (layer.width ?? 1) + 0.9,
                  layer.width ?? 1]
              : layer.width ?? 1,
            'line-opacity': layer.hoverHighlight
              ? ['case',
                  ['boolean', ['feature-state', 'selected'], false], 1,
                  ['boolean', ['feature-state', 'hover'], false], Math.min(1, (layer.opacity ?? 0.6) + 0.2),
                  layer.opacity ?? 0.6]
              : layer.opacity ?? 0.6,
          }
        /* A geojson FILL may carry a `steps` ramp, which until now only the
           circle renderer could read. The persistent-blocks layer needs it:
           census-block polygons shaded by how many years they reported.

           Deliberately reusing `stepRamp`/`stepField` rather than writing a
           second ramp builder, so a stops list means the same thing whatever
           shape draws it. Without a `steps` block this is the flat fill the
           flood-extent layers have always used, so nothing existing changes. */
        : { 'fill-color': layer.steps ? stepRamp(layer, stepField(layer)) : layer.color,
            'fill-opacity': layer.opacity ?? 0.2 },
      layout: { visibility: vis },
    }, under);
    addHitLayer(layer);
    if (layer.renderAs === 'line' && layer.hoverHighlight) addBoundaryInteraction(layer, under);
    if (layer.renderAs === 'line' && layer.labelProp) addBoundaryLabel(layer, under);
  }

  /* A minimal text label per district/board, so a resident can tell which one
     they're looking at without hovering. `labelProp` names the field to read
     — a plain data key, deliberately not `labelField`, which already means a
     different thing here (the Area-selection dissolved-outline companion).
     Text colour is the layer's own colour, matching the boundary/pill colour
     coding rather than adding a third neutral ink. No custom placement or
     decluttering logic: Mapbox's own label collision handling (allow-overlap
     left at its default `false`) thins these out at low zoom and fills back
     in on zoom — the built-in behaviour is already the minimal one. */
  function addBoundaryLabel(layer, under) {
    const id = `ov-${layer.id}-label`;
    if (map.getLayer(id)) return;
    map.addLayer({
      id,
      type: 'symbol',
      source: `ov-${layer.id}`,
      layout: {
        'text-field': ['get', layer.labelProp],
        'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 11.5, 14, 15],
        visibility: overlayState[layer.id] ? 'visible' : 'none',
      },
      paint: {
        'text-color': layer.color,
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.4,
        'text-halo-blur': 0.3,
      },
    }, under);
  }

  /* A transparent fill under a boundary line layer, purely for picking — the
     line itself is too thin a target to hover or click reliably, and the
     natural gesture for "which district is this" is pointing anywhere inside
     it, not tracing its edge. Feature-state (`hover`, `selected`) drives both
     this fill's opacity and the line layer's width/opacity above, so pointing
     anywhere in a district washes its own boundary in its own colour rather
     than a shared highlight colour that would blur council against community. */
  function addBoundaryInteraction(layer, under) {
    const srcId = `ov-${layer.id}`;
    const hitId = `${srcId}-hitfill`;
    boundaryState.set(layer.id, { hoveredId: null, selectedId: null });
    map.addLayer({
      id: hitId,
      type: 'fill',
      source: srcId,
      layout: { visibility: overlayState[layer.id] ? 'visible' : 'none' },
      paint: {
        'fill-color': layer.color,
        'fill-opacity': ['case',
          ['boolean', ['feature-state', 'selected'], false], 0.22,
          ['boolean', ['feature-state', 'hover'], false], 0.10,
          0],
      },
    }, under);
    boundaryHitLayers.push(hitId);

    const st = boundaryState.get(layer.id);
    map.on('mousemove', hitId, e => {
      const f = e.features?.[0];
      if (!f || st.hoveredId === f.id) return;
      if (st.hoveredId != null) map.setFeatureState({ source: srcId, id: st.hoveredId }, { hover: false });
      st.hoveredId = f.id;
      map.setFeatureState({ source: srcId, id: st.hoveredId }, { hover: true });
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', hitId, () => {
      if (st.hoveredId != null) map.setFeatureState({ source: srcId, id: st.hoveredId }, { hover: false });
      st.hoveredId = null;
      map.getCanvas().style.cursor = '';
    });
    // Click to select, click the selected one again to clear it.
    map.on('click', hitId, e => {
      const f = e.features?.[0];
      if (!f) return;
      if (st.selectedId != null) map.setFeatureState({ source: srcId, id: st.selectedId }, { selected: false });
      st.selectedId = st.selectedId === f.id ? null : f.id;
      if (st.selectedId != null) map.setFeatureState({ source: srcId, id: st.selectedId }, { selected: true });
    });
  }

  // Clears hover/selected state and hides the pick layer when a boundary
  // layer is switched off, so it starts clean if switched on again.
  function clearBoundaryState(id) {
    const st = boundaryState.get(id);
    if (!st) return;
    const srcId = `ov-${id}`;
    if (st.hoveredId != null) map.setFeatureState({ source: srcId, id: st.hoveredId }, { hover: false });
    if (st.selectedId != null) map.setFeatureState({ source: srcId, id: st.selectedId }, { selected: false });
    st.hoveredId = null;
    st.selectedId = null;
  }

  // A transparent, always-present circle layer over a hoverable overlay's source
  // so the tiny block marks can drive a tooltip. Registered once.
  // Mapbox can't load SVG directly, so rasterise it at 2x the tallest size used.
  function svgToImage(url, hPx) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const h = hPx * 2, w = Math.round(h * (img.naturalWidth || 1) / (img.naturalHeight || 1));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const g = cv.getContext('2d'); g.drawImage(img, 0, 0, w, h);
        res(g.getImageData(0, 0, w, h));
      };
      img.onerror = rej;
      img.src = url;
    });
  }

  async function addIconLayer(layer, under) {
    const id = `ov-${layer.id}`, imgName = `icon-${layer.id}`;
    const px = layer.iconPxByZoom?.length ? layer.iconPxByZoom : [[10, 18], [16, 34]];
    const maxPx = Math.max(...px.map(([, h]) => h));
    try {
      if (!map.hasImage(imgName)) map.addImage(imgName, await svgToImage(layer.icon, maxPx), { pixelRatio: 2 });
    } catch (e) { console.warn(`${layer.id} icon failed:`, e); return; }
    if (map.getLayer(id)) return;
    map.addLayer({
      id, type: 'symbol', source: id,
      layout: {
        'icon-image': imgName,
        'icon-anchor': 'bottom',
        'icon-size': ['interpolate', ['linear'], ['zoom'], ...px.flatMap(([z, h]) => [z, +(h / maxPx).toFixed(3)])],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        visibility: overlayState[layer.id] ? 'visible' : 'none',
      },
    }, map.getLayer(under) ? under : undefined);
    if (!layer.partner) return;
    partnerLayers.push(id);
    map.on('click', id, e => {
      // A raindrop drawn on top of this pin takes the click; don't open both.
      if (map.getLayer('s-drops') && map.queryRenderedFeatures(e.point, { layers: ['s-drops'] }).length) return;
      const f = e.features?.[0];
      if (f) onPartnerClick?.(layer, f.properties, f.geometry.coordinates);
    });
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }

  function addHitLayer(layer) {
    if (!layer.hover || map.getLayer(`ov-${layer.id}-hit`)) return;
    map.addLayer({
      id: `ov-${layer.id}-hit`,
      type: 'circle',
      source: `ov-${layer.id}`,
      /* REB-479. The hit target has to cover exactly what the layer draws and
         nothing else. Without this it covered every feature in the SOURCE —
         and the three 311 layers share one file, so hovering a block with 60
         basement calls and no street calls could read "0 calls" off the street
         layer while the dot you were pointing at was purple. */
      filter: layer.renderAs === 'steps' ? stepFilter(layer) : ['all'],
      paint: { 'circle-radius': 8, 'circle-opacity': 0 },
    }, 's-drops');
    hoverReg.push({ layerId: `ov-${layer.id}-hit`, layer });
  }

  // A minimal cursor tooltip driven by the hit layers. For a "count" hover
  // (311) it sums the report weights under the cursor; for a "field" hover
  // (green infra) it shows that property, mapped to a friendly label.
  function setupHover() {
    tipEl = document.createElement('div');
    tipEl.className = 'map-tip';
    tipEl.style.display = 'none';
    map.getContainer().appendChild(tipEl);
    map.on('mousemove', e => hoverAt(e.point));
    map.getCanvas().addEventListener('mouseout', () => { if (tipEl) tipEl.style.display = 'none'; });
  }

  /* The whole tooltip decision, split out of the mousemove listener so it can be
     called with a point instead of an event.

     THAT SPLIT IS THE ONLY WAY THIS IS TESTABLE, and it is the same reason
     `__ui.openPlace(lat, lng)` exists. Mapbox's own `mousemove` never fires in
     the automation browser: a real hover produces a DOM `mousemove` on the canvas
     and zero Mapbox events, and synthetic Mouse/Pointer events dispatched at the
     canvas, the canvas container and the map container are all swallowed the same
     way. So a tooltip bug cannot be reproduced through the event system at all,
     which is how one survived several rounds of "it looks correct to me".

     `debugHoverAt` on the `?e2e` hook calls this directly and returns what it
     decided, so the decision can be inspected without a mouse. */
  function hoverAt(point, debug) {
    const say = (reason, extra) => debug ? { shown: false, reason, ...extra } : undefined;
    const live = hoverReg.filter(h => overlayState[h.layer.id] && map.getLayer(h.layerId));
    if (!live.length) {
      tipEl.style.display = 'none';
      return say('no hoverable overlay is on', { registered: hoverReg.map(h => h.layer.id) });
    }
    {
      const box = [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]];
      /* A THING YOU ARE POINTING AT BEATS THE AREA IT SITS IN.
         Hit layers stack in the order their overlays were switched on, and
         `queryRenderedFeatures` returns topmost first — so before this, whichever
         hoverable layer you toggled LAST won every tooltip. Turn on Green
         Infrastructure and then Street Flooding and hovering a green dot returned
         the 311 block under it, which made the asset hover look broken rather
         than outranked. Reproduced 17 August: the topmost feature at a green dot
         was `ov-flood_street-hit`.

         `hasWeight` is the same distinction addLazyLayer already draws for the
         panel badge: a layer whose source carries a per-block `weight` is a
         DENSITY of reports, and one without it draws individual objects — a DEP
         asset, a FloodNet sensor. Those are what a cursor points AT; a block
         density is the ground they stand on, and it covers most of the city, so
         it can only ever be the fallback. Within each group paint order still
         decides, which keeps REB-479's fix intact. */
      const isArea = h => h.layer.source?.fields?.weight != null || h.layer.source?.point?.weight != null;
      const things = live.filter(h => !isArea(h));
      const areas = live.filter(isArea);
      let feats = things.length
        ? map.queryRenderedFeatures(box, { layers: things.map(h => h.layerId) })
        : [];
      if (!feats.length && areas.length) {
        feats = map.queryRenderedFeatures(box, { layers: areas.map(h => h.layerId) });
      }
      if (!feats.length) {
        tipEl.style.display = 'none';
        return say('nothing under the cursor', { queried: live.map(h => h.layerId) });
      }
      const reg = hoverReg.find(h => h.layerId === feats[0].layer.id);
      const same = feats.filter(f => f.layer.id === feats[0].layer.id);
      const text = renderHover(reg.layer, same);
      tipEl.textContent = text;
      tipEl.style.left = point.x + 'px';
      tipEl.style.top = point.y + 'px';
      tipEl.style.display = 'block';
      if (debug) {
        return { shown: true, layer: reg.layer.id, hitLayer: feats[0].layer.id,
                 text, textLength: text.length, props: feats[0].properties,
                 featuresMatched: same.length };
      }
    }
  }
  /* "2024-08-14" → "August 2024". The `T00:00:00` matters: a bare YYYY-MM-DD
     parses as UTC midnight, which in any negative offset — New York included
     — formats as the previous
     day. A sensor installed on the 1st of a month would read as the month
     before. Day precision is dropped on purpose: to the sentence "measured
     water 14 times since it was installed", the month is the honest resolution
     and the exact day is noise. */
  const monthYear = s => apMonthYear(s, String(s));

  function renderHover(layer, feats) {
    const h = layer.hover;
    if (h.count) {
      const total = feats.reduce((a, f) => a + (+f.properties[h.count] || 0), 0);
      return total.toLocaleString() + (h.suffix || '');
    }
    /* A `lines` hover reads several fields off one feature. The persistence
       layer needs this: the colour says how many years, but "5 of 5 years" is
       only meaningful next to the report count and whether anything has been
       built nearby. Colour alone never carries the message (see the ramp note
       in addOverlayLayer). */
    if (h.lines) {
      const p = feats[0].properties;
      return h.lines
        .map(l => {
          /* `let`, NOT `const`, and this is the whole reason the DEP hover was
             dead. The `map` and `fallback` branches below reassign this, so a
             const declaration threw `TypeError: Assignment to constant variable`
             on the FIRST line that carried a `map` — which killed the tooltip for
             the entire layer, silently, because the throw happens inside a Mapbox
             mousemove listener.

             It looked layer-specific and was not: it hit any hover line with a
             `map`. Green Infrastructure has one on both its lines, so it never
             produced a tooltip at all. FloodNet has none on any of its four, so it
             worked perfectly and made this look like a config problem with DEP.
             The single-field path at the bottom of this function has always used
             `let`, which is why the DEP hover worked before it moved from
             `{field, map}` to `{lines}`. */
          let v = p[l.field];
          if (v == null || v === '') return null;
          /* `flag` prints its prefix and nothing else, when the field is truthy,
             and drops the line entirely when it is not. For a boolean-ish
             property like FloodNet's `tidal` there is no number worth showing —
             the sentence IS the value. Without this a flag line renders as
             "Sits where the tide reaches1". */
          if (l.flag) return v && v !== '0' ? (l.prefix || '') : null;
          /* `map` translates a coded value before printing, the same way the
             single-field hover already does. The DEP layer needs it: status
             rides as 0/1 so the colour ramp can read it, and a reader must see
             "Completed" rather than "0". */
          if (l.map && l.map[v] != null) v = l.map[v];
          /* `fallback` covers a value the map does not know. DEP adds asset
             types: 'ROW Porous Concrete' arrived with the in-progress assets
             and is 1,316 of them, so an uncovered type is not a rare edge. A
             raw code in a resident-facing tooltip is worse than a plain
             sentence that says less. */
          else if (l.map && l.fallback) v = l.fallback;
          // `text` and `date` opt out of numeric coercion: a sensor name or an
          // install date run through `+v` come back NaN.
          if (l.text) return `${l.prefix || ''}${v}${l.suffix || ''}`;
          if (l.date) return `${l.prefix || ''}${monthYear(v)}${l.suffix || ''}`;
          /* `zero` replaces the WHOLE line, prefix and suffix included. A prefix
             is written to lead into a number — gluing it onto the zero text gave
             "Measured water No flooding measured here yet" on 193 of FloodNet's
             479 sensors, which is most of the ones a reader will hover over in
             the parts of the city that have not flooded. */
          if (+v === 0 && l.zero) return l.zero;
          // `one` / `many` let a line read "1 report" and "12 reports".
          const noun = l.many ? (Math.abs(+v) === 1 ? l.one : l.many) : '';
          return `${l.prefix || ''}${(+v).toLocaleString()}${noun ? ' ' + noun : ''}${l.suffix || ''}`;
        })
        .filter(Boolean)
        .join('\n');
    }
    let v = feats[0].properties[h.field];
    if (h.map && h.map[v] != null) v = h.map[v];
    return v ?? '';
  }

  /* REB-414 — a precomputed columnar overlay → GeoJSON.

     Restored from `573ab6d^`, where it was deleted along with the timeline
     layer that used to be its only caller. The `cumulative` bitmask expansion
     is deliberately NOT restored: it existed to precompute five per-year
     properties for a scrubber that no longer draws.

     Columns rather than an array of objects because the same information costs
     about a third of the bytes that way, and coordinates ride as integers
     scaled by `meta.scale` for the same reason. `scripts/build-persistence.mjs`
     writes the other half of this contract.

     One parsed copy per URL. The three 311 layers share `flood311.json` and
     differ only in which column they paint, so without this cache switching all
     three on parses 593 KB three times. The HTTP cache would spare the network
     but not the parse. */
  const columnCache = new Map();
  function fetchColumns(src) {
    if (!columnCache.has(src.url)) {
      columnCache.set(src.url, (async () => {
        const res = await fetch(src.url);
        if (!res.ok) throw new Error(`columns ${src.url} ${res.status}`);
        return res.json();
      })().catch(e => { columnCache.delete(src.url); throw e; }));   // a transient failure may retry
    }
    return columnCache.get(src.url).then(d => toFeatures(d, src));
  }

  /* Bin a point file onto a lat/lng grid and count what lands in each cell,
     which turns "here is a thing" into "how much is here" without a second
     data file to keep in step (Judy, 12 August: draw Green Infrastructure the
     way the 311 layers are drawn, by density).

     Done at load rather than in `scripts/build-persistence.mjs` on purpose.
     The DEP overlay is 13,959 rows, one pass, and the half-mile panel still
     needs the individual assets — it counts them by family inside the radius.
     A pre-binned second file would have to agree with the point file forever,
     and the first person to rebuild one and not the other would get a map and
     a panel that quietly disagree about how much the city has built.

     `bin` is the number of decimal places, so it is the same unit as
     `meta.precision` in flood311.json: 3 there, 3 here, the same ~110m cell.
     If that ever changes, these two stop being comparable, and comparing them
     is the entire argument the map makes. */
  function binFeatures(d, src) {
    const S = d.meta?.scale || 1;
    const P = src.bin;
    const field = src.binField || 'n';
    const cells = new Map();
    for (let i = 0; i < d.lat.length; i++) {
      const lat = +(d.lat[i] / S).toFixed(P);
      const lng = +(d.lng[i] / S).toFixed(P);
      const key = `${lat},${lng}`;
      const c = cells.get(key);
      if (c) c.n++; else cells.set(key, { lat, lng, n: 1 });
    }
    return {
      type: 'FeatureCollection',
      features: [...cells.values()].map(c => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
        properties: { [field]: c.n },
      })),
      meta: d.meta,
    };
  }

  function toFeatures(d, src) {
    if (src.bin) return binFeatures(d, src);
    const S = d.meta?.scale || 1;
    const cols = Object.entries(src.fields || {});
    const features = [];
    for (let i = 0; i < d.lat.length; i++) {
      const props = {};
      for (const [name, col] of cols) props[name] = d[col]?.[i];
      /* `lookup` maps a packed integer back through a table in the file's own
         meta — the DEP overlay stores an index into `meta.types` rather than
         repeating 31 asset-type strings across 13,959 rows. Done here so the
         hover reads a real asset name and knows nothing about the packing. */
      if (src.lookup) {
        for (const [name, table] of Object.entries(src.lookup)) {
          const t = d.meta?.[table];
          if (Array.isArray(t) && props[name] != null) props[name] = t[props[name]] ?? props[name];
        }
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [d.lng[i] / S, d.lat[i] / S] },
        properties: props,
      });
    }
    // Carried so a caller can quote the build date and spot a stale asset.
    return { type: 'FeatureCollection', features, meta: d.meta };
  }

  // Set false the first time Socrata rejects the app token, so the rest of the
  // session runs anonymously instead of failing every layer. See fetchSocrata.
  let socrataTokenOk = true;

  // Fetch a Socrata (NYC Open Data) source → GeoJSON FeatureCollection. Either
  // the response is already GeoJSON (src.geojson), or it's rows we turn into
  // points from lat/lng fields (src.point), optionally carrying a per-block weight.
  async function fetchSocrata(src) {
    const u = new URL(src.url);
    // Live date tokens so a filter like created_date>='{yearStart}' always means
    // the current year — no config edit needed each January.
    // `{since}` is the one window shared with the per-story counts in
    // citydata.js, so a drawn layer and the number a resident reads over it can
    // never drift apart — they resolve from the same config field.
    const now = new Date();
    const tok = {
      '{yearStart}': `${now.getFullYear()}-01-01`,
      '{year}': String(now.getFullYear()),
      '{since}': tenant.cityData?.since || `${now.getFullYear()}-01-01`,
    };
    const sub = s => { let o = String(s); for (const [t, r] of Object.entries(tok)) o = o.split(t).join(r); return o; };
    Object.entries(src.params || {}).forEach(([k, v]) => u.searchParams.set(k, sub(v)));
    /* REB-415. Query parameter rather than the X-App-Token header, to keep this
       a simple CORS request and avoid a preflight. A wrong or revoked token
       returns 403 where no token returns 200, so one rejection drops it for the
       rest of the session rather than taking every city layer down with it. */
    const token = socrataTokenOk ? (tenant.cityData?.appToken || '') : '';
    if (token) u.searchParams.set('$$app_token', token);
    let res = await fetch(u.toString());
    if (res.status === 403 && token) {
      console.warn('Socrata rejected the app token; continuing anonymously.');
      socrataTokenOk = false;
      u.searchParams.delete('$$app_token');
      res = await fetch(u.toString());
    }
    if (!res.ok) throw new Error(`socrata ${res.status}`);
    if (src.geojson) return await res.json();
    const rows = await res.json();
    const p = src.point || { lat: 'lat', lng: 'lng' };
    const features = [];
    for (const r of rows) {
      const lat = +r[p.lat], lng = +r[p.lng];
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: p.weight ? { weight: +r[p.weight] } : {} });
      }
    }
    return { type: 'FeatureCollection', features };
  }

  // Lazily fetch + add a live overlay the first time it's switched on.
  async function addLazyLayer(layer) {
    if (loading.has(layer.id) || map.getSource(`ov-${layer.id}`)) return;
    loading.add(layer.id);
    onOverlayLoading?.(layer.id, true);
    let count;
    try {
      const data = layer.source.type === 'columns'
        ? await fetchColumns(layer.source)
        : await fetchSocrata(layer.source);
      /* Total behind the layer: sum the per-block weights (reports), or count
         the point features (assets). Reported back for the panel badge.

         A frozen layer sums the same weights the live query returned, so the
         badge reads identically either way — the reconciliation printed by
         build-persistence.mjs is what keeps that true.

         `hasWeight` matters since REB-414. The 311 layers share one file in
         which every block appears in all three sources, so a block with no
         calls in THIS category carries a real 0 that must count as zero. The
         old `weight ?? 1` read that 0 correctly, but it also read greeninfra's
         absent weight as 1, which is how the asset layer got its count. Coerce
         with `|| 0` instead and greeninfra's badge silently reads 0. So ask the
         source which kind of layer this is rather than inferring it from a
         value that means two different things. */
      const hasWeight = layer.source?.fields?.weight != null || layer.source?.point?.weight != null;
      count = layer.countFeatures || !hasWeight
        ? data.features.length
        : data.features.reduce((a, f) => a + (+f.properties?.weight || 0), 0);
      fullData[layer.id] = data;   // keep the unclipped set for the radius focus
      if (!map.getSource(`ov-${layer.id}`)) {
        map.addSource(`ov-${layer.id}`, { type: 'geojson', data });
        addOverlayLayer(layer);   // visibility follows the current on/off state
      }
    } catch (e) {
      console.warn(`overlay '${layer.id}' failed to load:`, e);
      overlayState[layer.id] = false;
    } finally {
      loading.delete(layer.id);
      // meta rides along so a categorical legend can print a real count per
      // category instead of a number typed into config that goes stale.
      onOverlayLoading?.(layer.id, false, count, fullData[layer.id]?.meta || null);
    }
  }

  /* REB-418. Layers sharing an `exclusiveGroup` are radio buttons, not
     checkboxes: switching one on switches its siblings off.

     Why this is a correctness rule and not a preference. Heatmaps blended when
     stacked, so two of them on at once was cluttered but not wrong. Stepped
     blocks are opaque and occlude instead: 12,247 blocks, 38% of the map,
     report in two or more of the three 311 categories, so with two layers on
     the upper one silently hides the lower and a resident reads a confident
     wrong answer. Cluttered is recoverable, wrong is not.

     REB-434, 7 August: Judy asked for all three on at once and chose blending
     over the alternatives, having read that this is the state the stepped
     blocks replaced. So `overlays.exclusiveGroups: false` switches the rule
     off, and the layers drop to 0.6 opacity so a shared block mixes rather than
     the top one winning outright. The group declarations stay in the config;
     setting that flag back to true restores the old behaviour in one line. */
  const exclusiveOn = () => tenant.overlays?.exclusiveGroups !== false;

  function exclusiveSiblings(id) {
    if (!exclusiveOn()) return [];
    const g = (tenant.overlays?.layers || []).find(l => l.id === id)?.exclusiveGroup;
    if (!g) return [];
    return (tenant.overlays.layers || [])
      .filter(l => l.id !== id && l.exclusiveGroup === g)
      .map(l => l.id);
  }

  function setLayerVis(id, on) {
    if (map?.getLayer(`ov-${id}`)) map.setLayoutProperty(`ov-${id}`, 'visibility', on ? 'visible' : 'none');
    if (map?.getLayer(`ov-${id}-hitfill`)) {
      map.setLayoutProperty(`ov-${id}-hitfill`, 'visibility', on ? 'visible' : 'none');
      if (!on) clearBoundaryState(id);
    }
    if (map?.getLayer(`ov-${id}-label`)) map.setLayoutProperty(`ov-${id}-label`, 'visibility', on ? 'visible' : 'none');
  }

  function setOverlayVisible(id, on) {
    overlayState[id] = on;
    // A live layer switched on for the first time fetches lazily in the
    // background; its visibility follows overlayState when the data arrives.
    if (on && lazyLayers[id] && !map?.getSource(`ov-${id}`)) {
      addLazyLayer(lazyLayers[id]);
    } else if (map?.getLayer(`ov-${id}`)) {
      setLayerVis(id, on);
    }
  }

  function toggleOverlay(id) {
    const on = !overlayState[id];
    // Turn the siblings off first, so the panel never paints two as active.
    if (on) for (const sib of exclusiveSiblings(id)) setOverlayVisible(sib, false);
    setOverlayVisible(id, on);
    return overlayState[id];
  }

  // One raindrop icon image per unique story colour, drawn straight onto a
  // canvas (no SVG rasterisation, no SDF) so the white outline stays crisp.
  // Registered with the map once and cached by colour.
  function raindropImage(color, px, glyph) {
    const c = document.createElement('canvas'); c.width = px; c.height = px;
    const ctx = c.getContext('2d');
    ctx.scale(px / 24, px / 24);                 // draw in the 24×24 viewBox space
    const p = new Path2D('M12 2 C12 2 5 10 5 15 A7 7 0 0 0 19 15 C19 10 12 2 12 2 Z');
    ctx.fillStyle = color; ctx.fill(p);
    ctx.lineJoin = 'round'; ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke(p);

    /* REB-455. The type glyph, white, inside the bulb of the drop.

       Drawn ALWAYS rather than on hover. Judy suggested hover; the trouble is
       that hover does not exist on a phone, and colour used to carry type at a
       glance — so a hover-only glyph would mean the map stops saying what kind
       of story anything is for every touch visitor. One line switches it back
       if it reads as clutter.

       Scaled to ~12.4 of the 24 units and centred on the bulb at (12, 14.6),
       which is where the drop is widest. The glyph paths are stroked, not
       filled, so they hold their shape when the whole mark is ~26px. */
    const path = glyph && GLYPH_D[glyph];
    if (path) {
      ctx.save();
      ctx.translate(12, 14.6);
      ctx.scale(12.4 / 24, 12.4 / 24);
      ctx.translate(-12, -12);
      ctx.strokeStyle = '#fff';
      ctx.fillStyle = 'none';
      // Thin by default: the drop is the mark, the glyph is the label on it.
      // A mark may override with `{d, w}` — the question mark's dot needs to be
      // heavier than its hook or it reads as a smudge.
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const m of path) {
        ctx.lineWidth = typeof m === 'string' ? 1.5 : m.w;
        ctx.stroke(new Path2D(typeof m === 'string' ? m : m.d));
      }
      ctx.restore();
    }
    return ctx.getImageData(0, 0, px, px);
  }
  function dropImgName(color, glyph) {
    const name = `drop-${color.replace(/[^a-z0-9]/gi, '')}-${glyph || 'plain'}`;
    if (map && !map.hasImage(name)) map.addImage(name, raindropImage(color, 64, glyph), { pixelRatio: 2 });
    return name;
  }

  /* A diamond, for a stepped layer that asks for one (Judy, 10 August: the
     FloodNet points were too small and too easy to mistake for the 311 blocks).

     Shape is doing real work here, not decoration. The three 311 layers and the
     DEP assets are all circles, so a fifth set of round dots in a fifth colour
     is a colour-memory test. A diamond is the only mark on this map that is not
     round, which makes "measured by an instrument" legible at a glance and
     without relying on hue — the thing colour alone was failing at.

     Same canvas approach as the raindrops rather than SVG or SDF, so the
     outline stays crisp at any pixel ratio. The outline is what makes these
     readable over a busy basemap: white normally, and `ring` (blue) for a
     tidally influenced sensor, which is how that flag survives the move from a
     circle's `circle-stroke-color` to an image. */
  function diamondImage(color, px, ring) {
    const c = document.createElement('canvas'); c.width = px; c.height = px;
    const ctx = c.getContext('2d');
    ctx.scale(px / 24, px / 24);                 // draw in the same 24×24 space
    const p = new Path2D('M12 3.5 L20.5 12 L12 20.5 L3.5 12 Z');
    /* Outline first, fill over it: a centred stroke would otherwise eat into
       the fill and leave the colour reading darker than its own swatch. */
    ctx.lineJoin = 'round';
    ctx.lineWidth = ring ? 4.6 : 2.6;
    ctx.strokeStyle = ring || '#fff';
    ctx.stroke(p);
    ctx.fillStyle = color; ctx.fill(p);
    return ctx.getImageData(0, 0, px, px);
  }
  function markImgName(color, ring) {
    const name = `dia-${color.replace(/[^a-z0-9]/gi, '')}-${(ring || 'none').replace(/[^a-z0-9]/gi, '')}`;
    if (map && !map.hasImage(name)) map.addImage(name, diamondImage(color, 56, ring), { pixelRatio: 2 });
    return name;
  }

  /* An upward triangle, for the DEP assets (Judy, 17 August: triangles, to tell
     them apart from the 311 dots). Drawn in the same 24×24 space as the diamond
     and the raindrop so all three marks share one coordinate system.

     THE VERTICES ARE BALANCED ON THE AREA CENTROID, NOT THE BOUNDING BOX, and
     that is the whole trick with a triangle. Mapbox anchors an icon at the centre
     of its image, so a triangle filling the box sits with its centroid about two
     units low and every mark reads as offset from the thing it marks — the same
     class of error as the uncentred wave glyph in REB-455, which was measurable
     rather than a matter of taste. Centroid of (12,2.4) (20.2,17) (3.8,17) is
     (12, 12.13), so the mark lands where the asset is. */
  function triangleImage(color, px) {
    const c = document.createElement('canvas'); c.width = px; c.height = px;
    const ctx = c.getContext('2d');
    ctx.scale(px / 24, px / 24);
    const p = new Path2D('M12 2.4 L20.2 17 L3.8 17 Z');
    /* Outline first, fill over it, exactly as diamondImage does: a centred
       stroke eats into the fill and leaves the colour reading darker than its
       own swatch in the key. */
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = '#fff';
    ctx.stroke(p);
    ctx.fillStyle = color; ctx.fill(p);
    return ctx.getImageData(0, 0, px, px);
  }
  function triImgName(color) {
    const name = `tri-${color.replace(/[^a-z0-9]/gi, '')}`;
    if (map && !map.hasImage(name)) map.addImage(name, triangleImage(color, 56), { pixelRatio: 2 });
    return name;
  }
  function applyStories() {
    if (!map || !map.getSource('stories')) return;   // source is added in setup()
    const shown = lastStories.filter(s => s.lat != null && s.lng != null);
    map.getSource('stories').setData({
      type: 'FeatureCollection',
      features: shown.map(s => {
        /* The `color` property (the per-type hue) is gone as of REB-463. It was
           kept "because the story pane's small affordances still tint by it",
           and those affordances now draw the raindrop instead — so nothing read
           it any more. A feature property nobody reads is a claim the data
           still means something, and the next person to touch this would have
           had to prove it did not. */
        const pin = storyPinColor(tenant, s);
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
          properties: { storyId: s.id, dropImg: dropImgName(pin, storyIcon(tenant, s)) },
        };
      }),
    });
  }

  function setStories(stories) {
    lastStories = stories;
    applyStories();
  }

  function flyTo(lat, lng, zoom = 14) {
    map?.flyTo({ center: [lng, lat], zoom, duration: 700 });
  }

  /* Emphasize one story's dot and dim the rest (null restores everything).
     Used by layouts that sync the map to the page — safe before init. */
  function focusStory(storyId) {
    if (!map?.getLayer('s-drops')) return;
    if (storyId == null) { map.setPaintProperty('s-drops', 'icon-opacity', 1); return; }
    map.setPaintProperty('s-drops', 'icon-opacity',
      ['case', ['==', ['get', 'storyId'], storyId], 1, 0.28]);
  }

  /* REB-475. Judy, 12 August: hovering a story card should grow its raindrop,
     so a reader can find where in the city it is before they commit to opening
     it. Scale rather than opacity, because `focusStory` already owns opacity
     for the OPEN story and two effects fighting over one property is how a
     highlight ends up cancelling a dim.

     `icon-size` is a LAYOUT property, so this is setLayoutProperty. That is
     also why it is one property and not three: a layout change re-lays out
     every symbol in the layer, which is cheap at 50 stories and would not be
     at 5,000. If this layer ever holds thousands, move the highlight to a
     second single-feature source instead of scaling in place.

     HOVER IS AN ENHANCEMENT HERE, NOT A MECHANISM, and that is deliberate.
     REB-455 shipped glyphs that only appeared on hover and the map stopped
     saying what kind of story anything was for every touch visitor. Nothing
     depends on this: the pins, their glyphs and the cards all read exactly the
     same on a phone, where this simply never fires. */
  function hoverStory(storyId) {
    if (!map?.getLayer('s-drops')) return;
    /* 1.25x, down from 1.6 (Judy: too big). Enough to find the pin among its
       neighbours, not so much that the mark jumps out of the block it sits on
       — at 1.6 a hovered raindrop covered its own street. */
    map.setLayoutProperty('s-drops', 'icon-size',
      storyId == null ? 1 : ['case', ['==', ['get', 'storyId'], storyId], 1.25, 1]);
  }

  /* Judy, 19 August: the FloodNet diamonds get lost inside the half-mile ring,
     where five other layers switch on at once. A shaped layer carrying
     `steps.focusScale` draws that much bigger while a radius is open.

     Rebuilt from the stops the layer was ADDED with rather than read back off
     the map, because `setLayoutProperty` overwrites the expression — reading
     the current value would compound the scale on every story opened. */
  function setShapeFocus(id, on) {
    const s = shapeSize[id];
    if (!s || s.focusScale === 1 || !map?.getLayer(`ov-${id}`)) return;
    const m = on ? s.focusScale : 1;
    map.setLayoutProperty(`ov-${id}`, 'icon-size', ['interpolate', ['linear'], ['zoom'],
      ...s.stops.map((v, i) => (i % 2 ? +(v * m).toFixed(3) : v))]);
  }

  /* A container revealed after init (display toggles) needs a manual resize —
     Mapbox only watches the window. */
  function resize() {
    map?.resize();
  }

  // A single "you are here" marker for the submission flow. Re-dropping moves
  // it rather than stacking; clearPin() removes it when the form closes.
  function dropPin(lat, lng) {
    if (!map) return;
    if (pinMarker) pinMarker.remove();
    pinMarker = new mapboxgl.Marker({ color: tenant.theme.primary }).setLngLat([lng, lat]).addTo(map);
  }
  function clearPin() {
    if (pinMarker) { pinMarker.remove(); pinMarker = null; }
  }

  // Click-to-add: a confirm bubble at the tapped point, so a stray tap never
  // opens the form on its own. Drops a temp pin; confirm keeps it, cancel clears.
  let addPopup = null;
  function promptAddHere(lat, lng, onConfirm) {
    if (!map) return;
    cancelAddHere();
    dropPin(lat, lng);
    const el = document.createElement('div');
    el.className = 'add-here';
    el.innerHTML = `<button type="button" class="ah-x" aria-label="Close">\u2715</button>
      <div class="ah-t">Share your story here?</div>
      <button type="button" class="ah-yes">Share story</button>`;
    addPopup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 16, className: 'add-here-pop' })
      .setLngLat([lng, lat]).setDOMContent(el).addTo(map);
    el.querySelector('.ah-yes').addEventListener('click', () => {
      const p = addPopup; addPopup = null; p?.remove(); onConfirm?.();
    });
    el.querySelector('.ah-x').addEventListener('click', () => { cancelAddHere(); clearPin(); });
  }
  function cancelAddHere() { if (addPopup) { addPopup.remove(); addPopup = null; } }

  function eachCoord(geom, cb) {
    const walk = a => { if (typeof a[0] === 'number') cb(a); else a.forEach(walk); };
    if (geom && geom.coordinates) walk(geom.coordinates);
  }
  function matchNbhood(label) {
    const g = overlayGeo['neighborhoods']; if (!g) return [];
    const key = (label || '').split(',')[0].trim().toLowerCase();
    if (!key) return [];
    return g.data.features
      .filter(f => { const n = String(f.properties[g.field] || '').toLowerCase(); return n === key || n.startsWith(key + ' '); })
      .map(f => f.properties[g.field]);
  }
  // Dissolve a set of polygon features into their outer perimeter — no library.
  // Each undirected edge shared by two selected polygons (an internal seam)
  // appears twice and cancels; edges appearing once are the outer boundary
  // (and any holes). Returns a single MultiLineString feature. Relies on NTA
  // polygons sharing coincident vertices (they do); coords are rounded to ~0.1m
  // so float noise still matches.
  function dissolveBoundary(features) {
    const key = (a, b) => {
      const ka = a[0].toFixed(6) + ',' + a[1].toFixed(6);
      const kb = b[0].toFixed(6) + ',' + b[1].toFixed(6);
      return ka < kb ? ka + '|' + kb : kb + '|' + ka;
    };
    const count = new Map(), seg = new Map();
    const addRing = ring => {
      for (let i = 0; i < ring.length - 1; i++) {
        const k = key(ring[i], ring[i + 1]);
        count.set(k, (count.get(k) || 0) + 1);
        if (!seg.has(k)) seg.set(k, [ring[i], ring[i + 1]]);
      }
    };
    const walk = polys => polys.forEach(addRing);   // polys = array of rings
    features.forEach(f => {
      const g = f.geometry; if (!g) return;
      if (g.type === 'Polygon') walk(g.coordinates);
      else if (g.type === 'MultiPolygon') g.coordinates.forEach(walk);
    });
    const lines = [];
    count.forEach((c, k) => { if (c === 1) lines.push(seg.get(k)); });
    return { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: lines } };
  }

  // Sync the map to the Area facet: draw the selected neighbourhoods as a single
  // dissolved outline and fit to the stories there. Accepts one label, an array
  // of labels, or 'all'/empty to reset.
  function focusNeighborhood(labels, points) {
    if (!map) return;
    const src = 'ov-neighborhoods-outline';
    const empty = { type: 'FeatureCollection', features: [] };
    const list = (labels === 'all' || !labels) ? [] : (Array.isArray(labels) ? labels : [labels]);
    if (!list.length) {
      map.getSource(src)?.setData(empty);
      // Same "all five boroughs" default the initial load fits to, not the
      // old fixed center/zoom — a cleared Area filter should return to the
      // same view a fresh page load shows.
      if (tenant.map.bounds) map.fitBounds(tenant.map.bounds, { padding: defaultPadding(), duration: 800 });
      else map.flyTo({ center: tenant.map.center, zoom: tenant.map.zoom, duration: 800 });
      return;
    }
    const names = [...new Set(list.flatMap(l => matchNbhood(l)))];
    const g = overlayGeo['neighborhoods'];
    const feats = g ? g.data.features.filter(f => names.includes(f.properties[g.field])) : [];
    map.getSource(src)?.setData(feats.length
      ? { type: 'FeatureCollection', features: [dissolveBoundary(feats)] }
      : empty);
    const b = new mapboxgl.LngLatBounds(); let has = false;
    (points || []).forEach(p => { b.extend(p); has = true; });
    if (!has && feats.length) {
      feats.forEach(f => eachCoord(f.geometry, c => { b.extend(c); has = true; }));
    }
    if (has) map.fitBounds(b, { padding: { top: 90, bottom: 90, left: 380, right: 70 }, maxZoom: 14.5, duration: 800 });
  }

  /* ── radius focus: the city's record around one open story ──
     Draws the same half mile the story pane counts over, and clips the live
     city layers to it, so the numbers in the pane and the marks on the map are
     visibly the same thing. Layers are switched on for the duration whatever
     their manual state was, and put back on close.

     Clipping is done by re-setting each source's data to the features inside
     the circle (Mapbox filters have no spatial predicate), which is why the
     unclipped set is cached in `fullData` when the layer first loads. */
  /* Which layers an open story switches on. Opening a story used to force all
     three 311 heatmaps on together, which blended. Stepped blocks occlude
     instead (REB-418), so a group contributes only its first listed member —
     otherwise every story would quietly hide two thirds of its own context.
     Order in `cityData.focusLayers` is therefore meaningful. */
  const focusIds = () => {
    const all = tenant.cityData?.focusLayers || [];
    /* With exclusivity off (REB-434) a story shows every kind it is counted
       against, which is what the panel beside it has always reported — the map
       used to draw one of three while the numbers listed all three. */
    if (!exclusiveOn()) return all;
    const seen = new Set();
    const byId = id => (tenant.overlays?.layers || []).find(l => l.id === id);
    return all.filter(id => {
      const g = byId(id)?.exclusiveGroup;
      if (!g) return true;
      if (seen.has(g)) return false;
      seen.add(g);
      return true;
    });
  };

  function circlePolygon(lat, lng, meters, steps = 128) {
    const dLat = meters / 111320;
    const dLng = meters / (111320 * Math.cos(lat * Math.PI / 180) || 1);
    const ring = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * 2 * Math.PI;
      ring.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } };
  }
  const metersBetween = (aLat, aLng, bLat, bLng) => {
    const R = 6371000, r = x => x * Math.PI / 180;
    const dLat = r(bLat - aLat), dLng = r(bLng - aLng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  function clipToCircle(data, lat, lng, meters) {
    return {
      type: 'FeatureCollection',
      features: (data?.features || []).filter(f => {
        const c = f.geometry?.coordinates;
        return Array.isArray(c) && metersBetween(lat, lng, c[1], c[0]) <= meters;
      }),
    };
  }

  /* Everything outside the circle, as one polygon with the circle punched out.

     REB-436. `clipToCircle` filters features by their coordinate, which works
     for the point layers in `focusLayers` and would delete a borough-sized
     flood-extent polygon outright. So the extents are dimmed rather than
     clipped — which is the better answer anyway: an extent that stopped dead at
     an invisible circle edge would read as "the flooding stops here", and this
     is a hazard layer where that is the opposite of what the data says.

     A hole needs the opposite winding to its shell, hence the reversed ring. */
  function maskPolygon(lat, lng, meters) {
    const hole = circlePolygon(lat, lng, meters).geometry.coordinates[0].slice().reverse();
    /* A finite box around the circle, NOT the whole world.

       The shell used to be [-180,-85] to [180,85], and it silently stopped
       rendering: a ring spanning the full antimeridian is degenerate once
       Mapbox splits geometry across tiles, so the fill drew nothing and the
       half mile looked framed by the dashed ring alone. Three degrees is about
       330km, which covers any viewport at this map's minZoom of 9 while
       staying an ordinary, well-formed polygon. */
    const PAD = 3;
    const shell = [
      [lng - PAD, lat - PAD], [lng + PAD, lat - PAD],
      [lng + PAD, lat + PAD], [lng - PAD, lat + PAD], [lng - PAD, lat - PAD],
    ];
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [shell, hole] } };
  }

  function ensureFocusRing() {
    if (map.getSource('focus-ring')) return;
    const empty = { type: 'FeatureCollection', features: [] };
    map.addSource('focus-mask', { type: 'geojson', data: empty });
    /* Under the ring and the pins, over everything else — including the flood
       extents, which is the whole point.

       A DARK scrim, not the white wash this shipped with. White at 62% was
       measured doing nothing at all over most of the city: the basemap is
       already near-white, so washing it whiter changed the pixels by about 4
       points. It looked convincing in East Harlem only because that view is
       full of blue flood extent, and removing blue is a big change. A soft
       darkening reads on any ground — pale street grid, blue extent or park —
       which is what a device meant to say "this half mile, not the rest" has
       to do. Verified by painting it magenta and looking. */
    map.addLayer({
      id: 'focus-mask-fill',
      type: 'fill',
      source: 'focus-mask',
      paint: { 'fill-color': '#0E2630', 'fill-opacity': 0.16 },
    }, 's-drops');
    map.addSource('focus-ring', { type: 'geojson', data: empty });
    // A soft wash so the half mile reads as an area, plus a dashed edge. Both
    // sit under the raindrops so a story is never obscured by its own context.
    map.addLayer({
      id: 'focus-ring-fill',
      type: 'fill',
      source: 'focus-ring',
      paint: { 'fill-color': '#0F7FA0', 'fill-opacity': 0.06 },
    }, 's-drops');
    map.addLayer({
      id: 'focus-ring-line',
      type: 'line',
      source: 'focus-ring',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0F7FA0', 'line-width': 1.6, 'line-dasharray': [3, 2], 'line-opacity': 0.75 },
    }, 's-drops');
  }

  /* Put the camera on the half mile itself rather than near it.

     Opening a story used to fly to a fixed zoom 13.4, which framed roughly four
     miles of city around a circle that is one mile across, so the thing the
     pane is talking about arrived as a small dot in the middle of somewhere
     else. Fitting the ring's bounds instead lands around zoom 15 on a desktop
     and scales itself on a phone, so "the city's record around this story" is
     what fills the screen.

     The padding is measured, not assumed. The side panel is a fixed 340px
     column at desktop widths and the story card takes the bottom of a phone,
     and either one would otherwise centre the circle underneath itself. Reading
     the real geometry keeps this correct at any breakpoint, including ones that
     do not exist yet. */
  function fitRadius(lat, lng, meters) {
    if (!map || lat == null || lng == null) return;
    /* Fit a circle a quarter larger than the ring, so the ring lands at about
       three quarters of the frame rather than pressed against its edges. Fitting
       the ring exactly was correct and looked airless: a boundary reads as a
       boundary only when you can see a little of what is outside it. Expressed
       as a factor rather than extra pixels of padding so the breathing room
       stays proportional on a phone and a desktop alike. */
    const BREATHE = 1.25;
    const m = (meters || tenant.cityData?.radiusMeters || 805) * BREATHE;
    const dLat = m / 111320;
    const dLng = m / (111320 * Math.cos(lat * Math.PI / 180) || 1);
    const b = new mapboxgl.LngLatBounds(
      [lng - dLng, lat - dLat],
      [lng + dLng, lat + dLat],
    );

    const canvas = map.getContainer().getBoundingClientRect();
    const gap = 24;                       // never let the ring sit flush to an edge
    const pad = { top: gap, bottom: gap, left: gap, right: gap };
    /* REB-480. `.layers` is in this list now. It was not, so the ring was
       padded away from the side pane on the left and then slid straight under
       the Map Layers panel on the right — Judy: shift it so it is visible and
       not covered. The panel is fixed top-right and up to 681px tall, so it
       hides a real corner of the circle. */
    for (const sel of ['.side.open', '#storyOverlay.open .sheet', '.layers', '.story-card.open', '.map-bar']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      /* A panel that covers most of the map is not a side panel, it is an
         overlay: on a phone the story pane takes 351 of 390 points and there is
         no "space beside it" to aim at. Padding for it would leave a strip too
         narrow to fit anything, so ignore it and frame the whole viewport. The
         map is then already correct underneath, which is what the resident sees
         the moment they dismiss the pane. */
      if (r.width > canvas.width * 0.7 && r.height > canvas.height * 0.7) continue;
      if (r.bottom > canvas.bottom - 8 && r.width > canvas.width * 0.6) {
        pad.bottom = Math.max(pad.bottom, Math.round(r.height) + gap);   // bottom sheet
      } else if (r.left <= canvas.left + 8) {
        pad.left = Math.max(pad.left, Math.round(r.right - canvas.left) + gap);
      } else if (r.right >= canvas.right - 8) {
        /* REB-480. The right-hand case, which had no branch at all: the loop
           knew about a bottom sheet and a left pane and nothing else, so a
           panel pinned to the right edge was measured and then ignored. */
        pad.right = Math.max(pad.right, Math.round(canvas.right - r.left) + gap);
      }
    }
    /* fitBounds throws if the padding leaves no room. Anything that still gets
       here with no space is centred instead, so a story open can never fail
       silently and leave the camera wherever it happened to be. */
    const usableW = canvas.width - pad.left - pad.right;
    const usableH = canvas.height - pad.top - pad.bottom;
    if (usableW < 60 || usableH < 60) {
      map.easeTo({ center: [lng, lat], zoom: 14.6, duration: 800 });
      return;
    }
    try {
      map.fitBounds(b, { padding: pad, maxZoom: 16.5, duration: 800 });
    } catch (e) {
      console.warn('fitRadius: fitBounds refused, centring instead', e);
      map.easeTo({ center: [lng, lat], zoom: 14.6, duration: 800 });
    }
  }

  async function focusRadius(lat, lng) {
    if (!map || lat == null || lng == null) return;
    await ready;
    const ids = focusIds();
    if (!ids.length) return;
    const meters = tenant.cityData?.radiusMeters || 805;

    // Remember the manual on/off state once, so repeated story opens don't
    // overwrite it with the forced-on values from the previous story.
    if (!focusSaved) focusSaved = Object.fromEntries(ids.map(id => [id, !!overlayState[id]]));

    ensureFocusRing();
    map.getSource('focus-ring').setData({ type: 'FeatureCollection', features: [circlePolygon(lat, lng, meters)] });
    map.getSource('focus-mask').setData({ type: 'FeatureCollection', features: [maskPolygon(lat, lng, meters)] });

    for (const id of ids) {
      /* A focus layer is USUALLY lazy (the four Socrata ones), but it does not
         have to be. FloodNet ships as a static overlay and is loaded up front,
         so it has no `lazyLayers` entry — and the old `if (!layer) continue`
         skipped it outright, leaving it drawing all 479 sensors citywide while
         every other layer was clipped to the ring. REB-436's rule is that an
         open story shows only its half mile on EVERY layer, so the lazy fetch
         is now the conditional part rather than the price of admission. */
      const layer = lazyLayers[id];
      /* Judy, 12 August, second call on this: switch them all on again. Her
         reasoning is that the story pane already carries the same numbers
         broken down in words, so the map showing everything is additive rather
         than confusing. REB-479 had made focus clip-only after she found six
         layers at once overwhelming; the panel and the framing are the parts
         that were actually broken, and both are fixed in REB-480.

         "All except Future Flooding" falls out of the config rather than being
         special-cased: `cityData.focusLayers` is the three 311 layers, the DEP
         assets and FloodNet. The 2100 extent is not a focus layer and so is
         never touched here — which is exactly what she asked for. Do not add
         it to that list without re-reading this. */
      overlayState[id] = true;
      if (layer && !map.getSource(`ov-${id}`)) await addLazyLayer(layer);   // first use: fetch
      // No source, or no cached unclipped copy to clip from: skip quietly. A
      // fetch that failed, or a layer id in config that nothing ever added.
      if (!map.getSource(`ov-${id}`) || !fullData[id]) continue;
      map.getSource(`ov-${id}`).setData(clipToCircle(fullData[id], lat, lng, meters));
      if (map.getLayer(`ov-${id}`)) setLayerVis(id, true);
      setShapeFocus(id, true);
    }
  }

  function clearRadius() {
    if (!map) return;
    map.getSource('focus-ring')?.setData({ type: 'FeatureCollection', features: [] });
    map.getSource('focus-mask')?.setData({ type: 'FeatureCollection', features: [] });
    if (!focusSaved) return;
    for (const [id, wasOn] of Object.entries(focusSaved)) {
      overlayState[id] = wasOn;
      if (map.getSource(`ov-${id}`) && fullData[id]) map.getSource(`ov-${id}`).setData(fullData[id]);
      if (map.getLayer(`ov-${id}`)) setLayerVis(id, wasOn);
      setShapeFocus(id, false);
    }
    focusSaved = null;
  }


  return {
    get map() { return map; },
    /* REB-416. The `meta` block of a loaded overlay — build date, source,
       whatever that file carries — so the methodology panel can state how
       current the data is instead of having it typed into prose that decays.
       Reinstated after `573ab6d` removed the original for want of a caller.

       Null for a lazy layer nobody has switched on yet, which is the honest
       answer: its file has not been fetched, so there is no date to report.
       Callers that need a date regardless read `persistence-summary.json`,
       which is 1.3 KB and written by the same run. */
    overlayMeta: id => fullData[id]?.meta || null,
    /* The whole parsed overlay, for a caller that needs the rows and not just
       the meta (REB-522's findings panel counts a half-mile ring off two of
       them). Null for a lazy layer nobody has switched on, same as above — the
       caller fetches the file itself in that case rather than this triggering
       a megabyte of loads as a side effect of asking. */
    overlayData: id => fullData[id] || null,
    /* Run the real tooltip decision at a screen point and report what it chose,
       without needing a mouse. Mapbox's `mousemove` never fires in the automation
       browser (see the note on `hoverAt`), so this is the only way to exercise the
       hover path — same role `__ui.openPlace` plays for the half-mile panel.
       Exposed only through `?e2e`, alongside __map and __ui. */
    debugHoverAt: (x, y) => hoverAt({ x, y }, true),
    ready, init, resize, toggleOverlay, setStories, flyTo, focusStory, hoverStory, focusNeighborhood, focusRadius, fitRadius, clearRadius, dropPin, clearPin, promptAddHere, cancelAddHere, overlayState,
  };
}
