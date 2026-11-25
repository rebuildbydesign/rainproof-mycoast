/* Public UI chrome for the current layout: header, overlay panel, legend,
   side-panel feed/gallery, story popup shell.
   All copy, colors, and taxonomies come from the tenant config.
   Story HTML itself comes from the shared renderers in ui/render.js —
   user-generated content is escaped there, in one place. */
import { roleField, storyText, fieldOption, storyBrandColor, storyIcon } from './config.js';
import { esc, storyCard, galleryItem, emptyState, byline, dropMark, storyDetail, partnerDetail, excerpt, upvoteButton, asArray, hashtag } from './ui/render.js';
import { openLightbox } from './ui/detail.js';
import { icon } from './ui/icons.js';
import { cityData } from './citydata.js';
import { loadPlaces, neighbourhoodAt } from './places.js';
import { monthYear } from './dates.js';
import { geocodeNYC } from './geocode.js';

export { esc };

const $ = id => document.getElementById(id);


export function createUi(tenant, { onStoryOpen, onStoryHover, onFilterChange, onOverlayToggle, onNeighborhood, onAddNear, onMeToo, onStoryClose, onLocate, onPlaceOpen, onPlaceClose, onOpenMethod }, strings = {}) {
  const S = { allChip: 'All', noun: ['story', 'stories'], ...strings };

  // Primary chips = the color-role field (the thing that colors the map dots):
  // "Story Types". Category + neighborhood are secondary dropdown filters, and
  // free text search runs across the story, the byline, and the place.
  // Faceted, multi-select filters (e-commerce pattern): each facet holds an
  // array of chosen values — OR within a facet, AND across facets. Empty = no
  // filter on that facet.
  let activeTypes = [];
  let searchText = '';
  let selCats = [];
  let selHoods = [];
  let selEvents = [];
  let selYears = [];       // 'YYYY', or 'none' for stories that never said when
  /* REB-472 round three. Judy: make the filter box vertical, the way a clothing
     store does it. So this is a SET, not a single key — an e-commerce facet list
     lets you have Size and Colour open at once, and an accordion that shuts one
     section to open another is the thing that makes those feel fiddly. */
  const openFacets = new Set();
  let filtersOpen = false; // REB-472: the facet list is behind the header funnel
  // 17 August: free-text search moved behind its own icon beside the funnel,
  // same popover pattern. Mutually exclusive with the filter popover — see
  // setFilters/setSearchOpen.
  let searchOpen = false;
  // 17 August: the address geocoder's own state — the current suggestion
  // list, which one is keyboard-highlighted, and a request counter so a
  // slow, stale fetch can never paint over a faster, newer one.
  let geoResults = [];
  let geoInput = null;       // the address box last typed in (pane, or phone bar)
  let geoList = null;
  let geoHi = -1;
  let geoReq = 0;
  let geoTimer = null;
  let hoodList = [];       // sorted unique neighborhoods, for the "Area" dropdown
  let yearList = [];       // years actually present in the stories, newest first
  let stories = [];
  let controlsWired = false;
  let reactionsOn = false;   // "me too" backend is provisioned (app.js decides)
  let openId = null;         // story currently in the detail pane, for prev/next
  /* Below 768px a story opens as a card over the map instead of a panel over
     everything (direction B). matchMedia rather than a one-off innerWidth read,
     so a rotation is answered rather than baked in at load. */
  let cardStory = null;      // the story in the phone card, for "read the full story"
  let surfaceTimer = null;
  /* Holds every ResizeObserver for the life of the page: one with no strong
     reference is collectable in Chrome even while it has observation targets,
     and a dead observer fails silently rather than loudly. */
  const observers = [];
  let publishHdr = null;     // set by renderChrome; see renderTally
  function observe(el, fn) {
    if (!window.ResizeObserver) { window.addEventListener('resize', fn); return null; }
    const ro = new ResizeObserver(fn);
    ro.observe(el);
    return ro;
  }
  const phoneQ = window.matchMedia('(max-width: 767px)');
  const isPhone = () => phoneQ.matches;

  const typeField = roleField(tenant, 'color');   // colors the dots + primary chips + legend
  const colorField = typeField;                   // legend code below reads colorField
  const catField = roleField(tenant, 'filter');   // secondary dimension (category chips)
  const eventField = roleField(tenant, 'event');  // storm/event — the "Event" facet
  const city = cityData(tenant.cityData);         // live NYC record around a story (may be null)

  // Filters live in the URL so a CBO can link their exact slice of the map
  // (?type=&cat=&event=&hood=&q=). Read once on load; written on every change.
  // Values are ';'-separated in the URL (?type=a;b&cat=x;y&hood=…) so a partner
  // can link any exact slice. ';' (not ',') because neighborhood labels contain
  // commas ("Woodside, Queens"); URLSearchParams handles the encoding.
  (function readUrl() {
    const p = new URLSearchParams(location.search);
    const arr = k => (p.get(k) || '').split(';').map(s => s.trim()).filter(Boolean);
    searchText = p.get('q') || '';
    activeTypes = arr('type');
    selCats = arr('cat');
    selEvents = arr('event');
    selYears = arr('year');
    selHoods = arr('hood');
  })();
  function writeUrl() {
    const p = new URLSearchParams(location.search);
    const setArr = (k, a) => (a.length ? p.set(k, a.join(';')) : p.delete(k));
    if (searchText) p.set('q', searchText); else p.delete('q');
    setArr('type', activeTypes); setArr('cat', selCats);
    setArr('event', selEvents); setArr('year', selYears); setArr('hood', selHoods);
    /* The open story is part of the address (REB-428). One id, three surfaces:
       this map, admin.html?story=, and whatever a share card points at. It is
       the Supabase uuid — ugly in a link but stable, where a slug would break
       the moment a title changed. */
    if (openId) p.set('story', openId); else p.delete('story');
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }

  // ── static chrome ─────────────────────────────────────────────
  function renderChrome() {
    const b = tenant.branding || {};
    // Header logo: a real logo image when the tenant supplies branding.logoUrl,
    // otherwise the text monogram. The image swap is CSS-driven (.has-img).
    /* Three ways to be a wordmark, in order of preference (REB-459):

       1. **Live text**, whenever there is a `headerName`. The name is a config
          string, so it can be re-worded without an export; it is real text, so
          a screen reader announces it and a search engine indexes it; and
          `wordmarkFont` names a family the stylesheet declares, so a tenant
          with a different brand face changes one line rather than shipping a
          new PNG. Set as a font-family on the element, not baked into the CSS
          rule, because the CSS belongs to the layout and the brand belongs to
          the tenant.
       2. **An image**, if a tenant still supplies `logoUrl`. Kept working on
          purpose — this is engine code and other tenants use it.
       3. **The monogram tile**, when there is neither.

       The anchor already carries `title` and is the way home (REB-422). Its
       `aria-label` is gone in the text case: with real text inside, the label
       was overriding the accessible name with a duplicate of it. */
    const logoEl = $('logoText');
    logoEl.classList.remove('has-img', 'has-wordmark');
    logoEl.style.removeProperty('font-family');
    logoEl.style.removeProperty('font-weight');
    logoEl.style.removeProperty('-webkit-text-stroke-width');
    if (b.headerName) {
      logoEl.classList.add('has-wordmark');
      logoEl.textContent = b.headerName;
      logoEl.removeAttribute('aria-label');
      if (b.wordmarkFont) logoEl.style.fontFamily = `'${b.wordmarkFont}', var(--font-display, var(--font, inherit))`;
      if (b.wordmarkWeight) logoEl.style.fontWeight = String(b.wordmarkWeight);
      /* "Bolder" without a bolder cut (REB-459). See the note in config: this
         thickens the outline the face is drawn from, where `font-weight` would
         only get a synthesised bold that closes its counters. */
      if (b.wordmarkStroke) logoEl.style.webkitTextStrokeWidth = `${Number(b.wordmarkStroke)}px`;
    } else if (b.logoUrl) {
      logoEl.classList.add('has-img');
      logoEl.innerHTML = `<img src="${esc(b.logoUrl)}" alt="${esc(tenant.name)}">`;
    } else {
      logoEl.textContent = b.logoText || tenant.name.slice(0, 2).toUpperCase();
    }
    $('hdrName').textContent = b.headerName || tenant.name;
    /* REB-477. The credit is its own full-width strip under the waterline, not
       a subline squeezed into the brand column. That is the whole fix: 151
       characters of partner credit fit on one line at full width and fit at no
       size inside the brand column, which is why REB-476 kept having to hide
       partners to keep the header from ballooning.

       Every part is config. `partners` is an array rather than a sentence so
       the order is data and reordering is not an edit to prose. `#hdrSub` is
       left in the markup and empty — the other layouts share this chrome. */
    const org = tenant.org?.name
      ? `<a class="hdr-org-link" href="${esc(tenant.org.url || '#')}" target="_blank" rel="noopener">${esc(tenant.org.name)}</a>`
      : '';
    /* Each partner is `{ name, url }`, same shape as `about.credits.partners`
       and the same six URLs — a partner with no `url` still renders as plain
       text rather than dropping, so adding a name here never requires finding
       its link before it can ship. */
    const partners = (b.partners || []).filter(p => p?.name);
    const partnerHtml = p => p.url
      ? `<a class="c-partner-link" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>`
      : esc(p.name);
    const credit = $('hdrCredit');
    if (credit) {
      credit.innerHTML = org
        ? `<b>${esc(b.creditPrefix || 'Map created by')} ${org}</b>`
          + (partners.length
              ? `<span class="c-partners"><span class="c-sep">|</span>${esc(b.partnerPrefix || 'With')} ${partners.map(partnerHtml).join(', ')}</span>`
              : '')
        : esc(b.headerSub || '');
      credit.hidden = !credit.innerHTML;
    }
    const sub = $('hdrSub'); if (sub) sub.innerHTML = '';

    /* REB-476. Publish the header's real height as `--hdr-h`, which the side
       pane offsets from. It was a hardcoded 58px in the stylesheet — true on
       the day it was written, false the moment the partner credit made the
       header 90px, and the pane slid under it with the title sliced in half.

       Measured after layout rather than computed from the parts, because the
       parts are a wordmark whose font may still be loading, a credit line whose
       length is config, and a nav whose item count changes. `ResizeObserver`
       rather than a resize listener: the header changes height when the credit
       rewraps, which happens without the window changing size at all. */
    const hdr = document.querySelector('.hdr-wrap') || document.querySelector('.hdr');
    if (hdr) {
      const publish = () =>
        document.documentElement.style.setProperty('--hdr-h', `${Math.round(hdr.getBoundingClientRect().height)}px`);
      publishHdr = publish;
      publish();
      /* Two changes, 19 August, neither of which turned out to be the bug I
         first blamed. The observer is now KEPT in `observers` rather than left
         as an anonymous temporary — a ResizeObserver with no strong reference
         is collectable in Chrome even while it has observation targets, and a
         dead one fails silently. That is worth not risking, but it was NOT the
         cause of the stale --hdr-h I chased: the header grows about a second
         after load, when the 311 total lands from Socrata and the tally wraps
         to two lines, and the observer does follow it. The test was reading
         the value during that window.

         `resize` is added alongside because a rotation changes the header's
         height too, and the observer alone was an either/or with it. */
      observers.push(observe(hdr, publish));
      // Belt and braces, and free: a rotation changes the header's height too.
      window.addEventListener('resize', publish);
      document.fonts?.ready?.then(publish);
    }
    /* 18 August. Same problem, other end: the credit strip is now a fixed
       footer instead of part of the header stack, and `.side`/`.fab` read its
       real height as `--ftr-h` so neither runs under it. `credit` (above) is
       the same element — reused here rather than re-queried. */
    if (credit) {
      const publishFtr = () =>
        document.documentElement.style.setProperty('--ftr-h', `${Math.round(credit.getBoundingClientRect().height)}px`);
      publishFtr();
      observers.push(observe(credit, publishFtr));
      window.addEventListener('resize', publishFtr);
      document.fonts?.ready?.then(publishFtr);
    }
    /* Same shape again, for the keyboard. iOS leaves the layout viewport at
       full height when the keyboard opens and draws it over the top, so a
       sheet fixed to the bottom ends up underneath. `.overlay` sizes itself
       to --vv-h instead (core.css). */
    const vv = window.visualViewport;
    if (vv) {
      // rAF-coalesced: iOS fires vv.scroll continuously through a pinch.
      let vvQueued = false;
      const publishVv = () => {
        if (vvQueued) return;
        vvQueued = true;
        requestAnimationFrame(() => {
          vvQueued = false;
          const st = document.documentElement.style;
          st.setProperty('--vv-h', `${Math.round(vv.height)}px`);
          /* How much of the layout viewport the keyboard has taken. The map
             bar is fixed to the layout viewport, which iOS does not move, so
             it has to lift by this much to stay above the keys. */
          st.setProperty('--vv-gap', `${Math.max(0, Math.round(window.innerHeight - vv.height))}px`);
        });
      };
      publishVv();
      vv.addEventListener('resize', publishVv);
      vv.addEventListener('scroll', publishVv);
    }
    $('sideTitle').textContent = tenant.feed?.title || 'Community Stories';
    const addrPrompt = $('addrPrompt');
    if (addrPrompt) addrPrompt.textContent = tenant.feed?.addressHint || '';
    // 17 August: atlas no longer ships a floating #ctaBtn (see index.html),
    // but renderChrome is shared across layouts and another one may still
    // have it in its own shell — guarded rather than assumed absent.
    const ctaBtn = $('ctaBtn');
    if (ctaBtn) ctaBtn.innerHTML = `${icon('chat')}<span>${esc(tenant.cta.share)}</span>`;
    // 17 August: the CTA's replacement — a persistent "Share Your Story" in
    // the pane itself, so it exists for someone who never touches the
    // address bar above it. Same icon+copy as the old floating button.
    const sideShare = $('sideShareBtn');
    if (sideShare) sideShare.innerHTML = `${icon('chat')}${esc(tenant.cta.share)}`;
    /* Moderator entry: a padlock with no label at the end of the nav, present
       at every width (REB-422). It was gated behind ?admin on 30 July so a
       shared workshop screen would not show a thing to click, but the effect
       was that moderators could not find it anywhere and typed /admin.html
       from memory. admin.html is auth-gated by Supabase, so a visitor who
       clicks it gets a sign-in screen and nothing else. */
    const ad = $('hdrAdmin');
    if (ad) ad.innerHTML = icon('lock');


    // overlay panel: hidden entirely when a tenant has no overlays
    const layers = tenant.overlays?.layers || [];
    const panel = $('layersPanel');
    if (!layers.length && !colorField?.options?.length) {
      panel.style.display = 'none';
    } else {
      $('layersTitle').textContent = tenant.overlays?.title || 'Map Layers';
      // Some overlays load (for the Area highlight) but shouldn't appear as a
      // toggle in the panel — e.g. the NTA boundaries.
      /* The badge (REB-424). A layer that loads from the city gets an empty
         badge slot that fills with its real total once the data lands; it used
         to say "Live" until then, which told a visitor nothing, raised a
         question it did not answer, and is about to stop being true when the
         bulk layers move to frozen overlays. The flood-extent layers keep their
         static badges ("Now", "2100") because those name a period, not a feed.

         A bare number is not a fact either, so the layer that is switched on
         also gets a caption saying what the number counts and since when. Only
         the active layer gets one: seven captions at once is a wall of text in
         a 248px panel, and only one of them is being read. */
      /* REB-448. One row per layer: swatch, name, count. Nothing else, and the
         same height whether the layer is on or off.

         What used to be here and why it went: an active layer expanded a
         caption describing itself, and once its count landed the caption
         switched to saying what the count covered. Both explained at the moment
         someone had already decided to switch the layer on, and seven rows that
         change height on click is a panel that moves under the cursor. That
         text now lives in the methodology panel beside its dataset (REB-450),
         where a reader asking about data actually is.

         The word badges went with them — "Measured" said nothing, and "Now" /
         "2100" are part of what the layer IS, so they read better inside the
         name than in a pill beside it. What is left in `.l-badge` is only ever
         a record count, which is data. */
      /* GROUPED, as of 17 August. Judy: "the layers are all over the place and it
         needs to be cleaned up", and she picked layout D1 out of four mockups.

         Order comes from `overlays.groups`, NOT from the order of `overlays.layers`.
         That is deliberate: the array's order already means other things in other
         places (a lazy layer's index has never set its draw order, and Green
         Infrastructure was moved to the end of it for panel reasons that no longer
         apply), so reading position as intent here would make two unrelated
         concerns fight. A layer says which group it belongs to and the group says
         where it sits.

         A layer whose `group` matches nothing falls into a final unlabelled bucket
         rather than vanishing — the failure mode to avoid is a config typo silently
         removing a layer from the panel while it still draws on the map. */
      const groups = tenant.overlays?.groups?.length
        ? tenant.overlays.groups
        : [{ id: null, label: null }];
      const shown = layers.filter(l => !l.panelHidden);
      const claimed = new Set();
      const rowHtml = l => `
        <div class="l-item ${l.defaultOn ? 'on' : ''}" data-overlay="${esc(l.id)}"
          role="button" tabindex="0" aria-pressed="${l.defaultOn ? 'true' : 'false'}">
          ${l.icon
            ? `<div class="l-dot l-dot-icon" style="background-image:url('${esc(l.icon)}')"></div>`
            : `<div class="l-dot" style="background:${esc(l.color)}"></div>`}
          <div class="l-label" title="${esc(l.label)}">${esc(l.label)}</div>
          <div class="l-badge" hidden></div>
          <div class="l-scale" hidden></div>
        </div>`;
      /* Pills for the boundary layers. A district outline is wayfinding, not a
         hazard, and a full row with a colour swatch makes it look like a fifth kind
         of flooding. They keep `data-overlay` and the `on` class, so the one click
         handler below drives them without knowing which shape it clicked. */
      const pillHtml = l => `
        <button type="button" class="l-pill ${l.defaultOn ? 'on' : ''}" data-overlay="${esc(l.id)}"
          style="--pill-c:${esc(l.color)}"
          aria-pressed="${l.defaultOn ? 'true' : 'false'}">${esc(l.label)}</button>`;

      const sections = groups.map(g => {
        const mine = shown.filter(l => (l.group ?? null) === (g.id ?? null));
        mine.forEach(l => claimed.add(l.id));
        if (!mine.length) return '';
        const head = g.label
          ? `<div class="l-grp">${esc(g.label)}`
            + (g.note ? `<span class="l-grp-n">${esc(g.note)}</span>` : '')
            + `</div>`
          : '';
        return head + (g.style === 'pill'
          ? `<div class="l-pills">${mine.map(pillHtml).join('')}</div>`
          : mine.map(rowHtml).join(''));
      });
      const orphans = shown.filter(l => !claimed.has(l.id));
      $('layerItems').innerHTML = sections.join('') + orphans.map(rowHtml).join('');
      layers.forEach(l => { overlayOn[l.id] = !!l.defaultOn; });
      // `[data-overlay]` rather than `.l-item`, so rows and pills share one handler.
      $('layerItems').querySelectorAll('[data-overlay]').forEach(el => {
        // The pills are real buttons and fire on Enter/Space themselves; the rows are divs.
        if (el.tagName !== 'BUTTON') el.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
        });
        el.addEventListener('click', e => {
          const id = el.dataset.overlay;
          const on = onOverlayToggle?.(id);
          el.classList.toggle('on', !!on);
          if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', String(!!on));
          /* Layers in an exclusiveGroup switch each other off in the map module,
             so the panel cannot just flip the one that was clicked — its
             siblings changed too and would otherwise stay lit. */
          overlayOn[id] = !!on;
          if (on && tenant.overlays?.exclusiveGroups !== false) {
            const g = layers.find(x => x.id === id)?.exclusiveGroup;
            if (g) layers.forEach(x => {
              if (x.id !== id && x.exclusiveGroup === g) {
                overlayOn[x.id] = false;
                const sib = $('layerItems').querySelector(`[data-overlay="${x.id}"]`);
                sib?.classList.remove('on');
                if (sib?.hasAttribute('aria-pressed')) sib.setAttribute('aria-pressed', 'false');
              }
            });
          }
          layerScales();
          syncLayerBadges();
        });
      });
      layerScales();
      syncLayerBadges();
      // Source attribution is optional and currently unset: where the data
      // comes from belongs in the About / Methodology modal, not repeated in
      // the layers panel. Collapse the line entirely when there is no text,
      // so it costs no space rather than leaving an empty padded row.
      /* Two different things can land in this line. `attribution` is where the
         data came from; `caveat` is what the reader must not conclude from it —
         currently that heat density is normalised per layer, so two layers
         cannot be ranked against each other by colour. That is exactly the
         comparison a community board reaches for ("is my district worse?"), and
         the honest answer is the per-story counts, so say so here rather than
         letting the map imply otherwise. */
      const note = [tenant.overlays?.attribution, tenant.overlays?.caveat].filter(Boolean).join(' ');
      /* THE "How this map works" LINK IS GONE FROM HERE. Judy, 17 August:
         redundant, and she is keeping this panel minimal.

         REB-431 put it here on the reasoning that "where does this come from" is
         the question a layer panel provokes. Still true, but it is no longer the
         only place to ask: the dictionary now has three other doors — the
         Methodology item in the header nav, a link inside About, and the layout's
         own `onOpenMethod`. A fourth at the foot of a panel that just lost its
         caveat lines and gained four group headers was the one paying least.

         The footer itself stays and renders only when a tenant sets `attribution`
         or `caveat`, which this one does not — so it collapses to nothing rather
         than leaving an empty bordered strip under the pills. */
      $('lSrc').innerHTML = note ? esc(note) : '';
      $('lSrc').hidden = !note;
      /* REB-456. The story-type legend is gone from this panel.

         It was a legend, not a control, sitting next to the side pane's type
         chips which do the same job and can be clicked. It also cost ~200px in
         a panel that has twice had to be capped to stop it burying the map
         controls, and REB-455 removed the thing it was explaining — pins are
         one colour now, with the type carried by a glyph shown in the pane. */
      // Collapsible on every screen: the header chevron hides/shows the body and
      // stays visible when collapsed, so the panel is easy to reopen. Starts
      // folded on phones to save room.
      $('layersToggle').innerHTML = icon('chevron');
      $('layersHead').addEventListener('click', () => panel.classList.toggle('collapsed'));
      if (window.innerWidth < 768) panel.classList.add('collapsed');
    }
    wireControls();
    renderControls();
  }

  // ── filtering ─────────────────────────────────────────────────
  function matchSearch(s) {
    if (!searchText) return true;
    const q = searchText.toLowerCase();
    return (storyText(tenant, s) || '').toLowerCase().includes(q)
      || (byline(tenant, s) || '').toLowerCase().includes(q)
      || (s.location_label || '').toLowerCase().includes(q);
  }
  /* When the flooding happened, as a year (REB-427).

     Deliberately NOT `submitted_at`. That is when someone sat down to write,
     which for this map is mostly 2026 regardless of which storm they are
     describing — a year filter built on it would look like it worked and be
     wrong about every Sandy story. Two honest sources instead:

       1. `story_date`, the exact date the resident gave, if they gave one
       2. the year of the storm they picked, carried on the option in config

     A story with neither is 'none' and shows up in the dropdown as "Date not
     given", so the gap is visible rather than silently filtered away. Most
     stories are in that bucket today. */
  const eventYears = Object.fromEntries(
    (eventField?.options || []).filter(o => o.year).map(o => [o.id, String(o.year)]));
  function storyYear(s) {
    const d = s.answers?.story_date;
    if (d && /^\d{4}/.test(d)) return d.slice(0, 4);
    return eventYears[s.answers?.[eventField?.id]] || 'none';
  }

  // OR within a facet (any chosen value matches); empty facet = passes everything.
  const matchType  = s => !activeTypes.length || activeTypes.includes(s.answers?.[typeField?.id]);
  // category can be multi-valued per story — match if any chosen tag is present
  const matchCat   = s => !selCats.length     || asArray(s.answers?.[catField?.id]).some(c => selCats.includes(c));
  const matchEvent = s => !selEvents.length   || selEvents.includes(s.answers?.[eventField?.id]);
  const matchYear  = s => !selYears.length    || selYears.includes(storyYear(s));
  const matchHood  = s => !selHoods.length    || selHoods.includes(s.location_label || '');

  // Faceted counts: to count the options of one facet, apply every OTHER active
  // filter but not that facet's own — so each chip shows what it would yield.
  const M = { search: matchSearch, type: matchType, cat: matchCat, event: matchEvent, year: matchYear, hood: matchHood };
  const poolExcept = key => stories.filter(s => Object.entries(M).every(([k, fn]) => k === key || fn(s)));
  const filtered   = () => stories.filter(s => Object.values(M).every(fn => fn(s)));

  const toggle = (arr, v) => (arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]);
  const hoodArg = () => (selHoods.length ? selHoods : 'all');
  function apply() { renderStories(stories); onFilterChange?.(); writeUrl(); }
  // Setters used by clickable badges inside the story detail — add/remove that
  // value from the facet (so you can build a filter up from stories you read).
  function setCat(id)   { selCats = toggle(selCats, id); closeStory(); apply(); }
  function setEvent(id) { selEvents = toggle(selEvents, id); closeStory(); apply(); }
  function setHood(label) { selHoods = toggle(selHoods, label); onNeighborhood?.(hoodArg()); apply(); }

  // ── controls: search + explore bar (wired once) ───────────────
  function wireControls() {
    if (controlsWired) return;
    controlsWired = true;
    const si = $('searchIn');
    if (si) { si.value = searchText; si.addEventListener('input', e => { searchText = e.target.value.trim(); apply(); }); }
    $('sdBack')?.addEventListener('click', closeStory);
    $('pdBack')?.addEventListener('click', closePlace);
    $('sdPrev')?.addEventListener('click', () => storyStep(-1));
    $('sdNext')?.addEventListener('click', () => storyStep(1));
    // The phone card: same stepper, same close, plus the way into the full view.
    $('scPrev')?.addEventListener('click', () => storyStep(-1));
    $('scNext')?.addEventListener('click', () => storyStep(1));
    $('scClose')?.addEventListener('click', closeStory);
    $('scMore')?.addEventListener('click', () => { if (cardStory) openStoryFull(cardStory); });
    // Arrow keys do the same on a keyboard, which is how anyone reading a run
    // of stories on a laptop will reach for it. Ignored while typing in the
    // search box or a form field, and while the intake or a modal is up.
    document.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!$('sideDetail')?.classList.contains('open')) return;
      if (!$('side')?.classList.contains('open')) return;   // panel is off-screen
      const t = e.target;
      if (t?.closest?.('input, textarea, select, [contenteditable]')) return;
      if (document.querySelector('.overlay.open, #lightbox.open')) return;
      e.preventDefault();
      storyStep(e.key === 'ArrowLeft' ? -1 : 1);
    });
    // REB-472. The funnel opens and closes the facet panel.
    $('filterBtn')?.addEventListener('click', e => { e.stopPropagation(); setFilters(!filtersOpen); });
    // 17 August. Same for the search icon beside it. Static, unlike the
    // funnel's own icon() call — it carries no badge/count, so it never
    // needs a re-render.
    const sb = $('searchBtn');
    if (sb) sb.innerHTML = `${icon('search', 15)}<span>Search</span>`;
    sb?.addEventListener('click', e => { e.stopPropagation(); setSearchOpen(!searchOpen); });
    /* Escape collapses any open sections first, then closes the popover — one
       key, one layer at a time, so it never yanks the window away from under a
       list somebody is reading. Ignored while typing, or the search box loses
       its own clear-on-Escape.

       The search popover is the one exception: it IS an input, so the usual
       "ignore Escape while typing" guard below would trap it open forever.
       Checked first, and only for that one field. */
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (searchOpen && (e.target === si || $('searchWrap')?.contains(e.target))) { setSearchOpen(false); return; }
      if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
      if (openFacets.size) { openFacets.clear(); renderFacets(); }
      else if (filtersOpen) setFilters(false);
    });
    /* One click outside dismisses the popover. Click-away is the gesture people
       reach for before they find the funnel again, and a popover you can only
       close from the control that opened it feels stuck. There is no inner layer to peel
       any more — the sections are part of the list, not a dropdown floating on
       top of it — so this is a single rule now instead of two. */
    document.addEventListener('click', e => {
      if (filtersOpen && !e.target.closest('#filterWrap') && !e.target.closest('#filterBtn')) setFilters(false);
      if (searchOpen && !e.target.closest('#searchWrap') && !e.target.closest('#searchBtn')) setSearchOpen(false);
    });
    wireGeocoder();
  }

  /* ── address geocoder (17 August) ──────────────────────────────
     Replaces free-text search as the pane's primary control. A resident
     doesn't know the half-mile place panel exists until they tap the map OR
     land here — so picking a suggestion runs the exact same path a map tap
     does: `openPlace(lat, lng)`, half-mile counts and "Add your story here"
     both anchored to that address, no drop-pin/GPS guessing needed.

     The actual Mapbox call lives in geocode.js — REB-507's own note that the
     form's location step wants the identical lookup, so it is built once. */
  /* Two hosts share one geocoder: the pane's address bar on desktop and the
     phone's map bar. Whichever was last typed in is the active pair, so the
     results always paint into the box the resident is looking at. */
  function wireGeocoder() {
    wireGeoHost($('addrIn'), $('addrSugg'), $('addrIco'));
    wireGeoHost($('mbAddrIn'), $('mbAddrSugg'), $('mbIco'));
    document.addEventListener('click', e => {
      if (!e.target.closest('.side-search') && !e.target.closest('.mb-search')) closeSugg();
    });
  }

  function wireGeoHost(input, list, ico) {
    if (!input || !list) return;
    // 18 August: the address bar's pin icon (Direction C's mockup treatment).
    if (ico) ico.innerHTML = icon('pin', 15);
    const claim = () => { geoInput = input; geoList = list; };
    input.addEventListener('focus', claim);
    input.addEventListener('input', () => {
      claim();
      clearTimeout(geoTimer);
      const q = input.value.trim();
      if (q.length < 3) { closeSugg(); return; }
      geoTimer = setTimeout(() => runGeocode(q), 300);
    });
    input.addEventListener('keydown', e => {
      claim();
      if (e.key === 'Escape') { closeSugg(); return; }
      if (!geoResults.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); geoHi = Math.min(geoHi + 1, geoResults.length - 1); paintSugg(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); geoHi = Math.max(geoHi - 1, 0); paintSugg(); }
      else if (e.key === 'Enter') { e.preventDefault(); pickSugg(geoHi >= 0 ? geoHi : 0); }
    });
  }

  async function runGeocode(q) {
    const token = tenant.map?.mapboxToken;
    if (!token) return;
    const req = ++geoReq;
    try {
      const feats = await geocodeNYC(token, q);
      if (req !== geoReq) return;          // a later keystroke moved on
      geoResults = feats;
      geoHi = -1;
      paintSugg();
    } catch (e) {
      if (req !== geoReq) return;
      console.error('geocode failed:', e);
      geoResults = [];
      paintSugg(true);
    }
  }

  function paintSugg(failed) {
    const list = geoList; if (!list) return;
    if (failed) {
      list.innerHTML = `<div class="addr-empty">Couldn’t look up that address.</div>`;
      list.hidden = false;
      geoInput?.setAttribute('aria-expanded', 'true');
      return;
    }
    if (!geoResults.length) { closeSugg(); return; }
    list.innerHTML = geoResults.map((f, i) =>
      `<button type="button" class="addr-opt ${i === geoHi ? 'hi' : ''}" data-i="${i}">
         ${icon('pin', 14)}<span>${esc(f.place_name)}</span>
       </button>`).join('');
    list.hidden = false;
    geoInput?.setAttribute('aria-expanded', 'true');
    list.querySelectorAll('.addr-opt').forEach(el =>
      el.addEventListener('click', () => pickSugg(+el.dataset.i)));
  }

  function closeSugg() {
    const list = geoList; if (!list) return;
    list.hidden = true;
    list.innerHTML = '';
    geoResults = []; geoHi = -1;
    geoInput?.setAttribute('aria-expanded', 'false');
  }

  function pickSugg(i) {
    const f = geoResults[i]; if (!f) return;
    const [lng, lat] = f.center;
    if (geoInput) { geoInput.value = f.place_name; geoInput.blur(); }
    closeSugg();
    openPlace(lat, lng);
  }

  // Via fieldOption so a retired option still resolves to its label rather than
  // showing a raw id in a filter chip.
  const optLabel = (f, id) => fieldOption(f, id)?.label || id;
  const yearLabel = y => (y === 'none' ? 'Date not given' : y);

  // Areas are an expansive, curated list of NYC neighborhoods (config.areas)
  // merged with any neighborhood that already has a story — so a resident can
  // pick their block even when nobody has posted there yet.
  function renderHoods() {
    const fromStories = stories.map(s => s.location_label).filter(Boolean);
    hoodList = [...new Set([...(tenant.areas || []), ...fromStories])].sort((a, b) => a.localeCompare(b));
    /* Years come from the stories themselves, never from a fixed range: an
       empty year in a dropdown is a dead end, and a map with 11 stories would
       otherwise offer fifteen of them. Newest first, with "Date not given"
       last so it reads as the remainder rather than a year. */
    /* REB-482. The years the MAP knows about, not only the years stories have
       landed in. Every configured storm carries a `year` — Sandy 2012 through
       the June 2026 cloudburst — and those are the years this archive is
       collecting against, so they belong in the filter whether or not somebody
       has filed against one yet.

       Judy found this the same way she found Event: deleting the seed stories
       emptied the facet, and a map whose subject is "every major storm since
       Sandy" stopped offering a single one of them. A year with no stories
       shows a 0 and the existing dim, same as an unused storm.

       Story dates still contribute, so a story filed with a date outside the
       storm list still gets its own year. "Date not given" stays last and only
       when a story actually has no date, because it is a remainder, not a
       year. */
    const ys = [...new Set(stories.map(storyYear))];
    const known = new Set([...ys, ...Object.values(eventYears)]);
    known.delete('none');
    yearList = [...known].sort((a, b) => b.localeCompare(a));
    if (ys.includes('none')) yearList.push('none');
  }

  // Explore bar (Airbnb / Google-Maps pattern): compact Type / Category / When /
  // Area buttons behind the funnel, then a removable row of active filters.
  // One control language, everything tap-to-filter.
  //
  // Judy, 17 August (REB-503): story types used to be their own row of four
  // raindrop tiles above this — dropped for the same reason Category/Event/Year
  // already live behind the funnel: they took up room the story cards should
  // have, and "type" is now just a fifth facet (see facetSpec/facetKeys below).
  function renderControls() {
    renderFacets();
    renderFilterBtn();
    renderActive();
  }

  /* REB-477. The counts under the wordmark, replacing the pill that used to
     float mid-bar with nothing anchoring it.

     ONE raindrop, always. An earlier study drew one drop per story and capped
     the row; Judy's call is that counting in dots is fluff, and she is right —
     the drop's job is to say "these are stories", and the number counts.

     Both figures are COMPUTED, never typed. `n` is the live table. The 311
     total arrives from `overlays/findings-blocks.json` via `setCityTotal`,
     the same file the methodology panel reads, so the header cannot state a
     number the rest of the page disagrees with. Until it lands the tally shows
     the story count alone rather than a placeholder — a number that is not
     known yet should be absent, not zero. */
  let cityReports = null;

  function setCityTotal(reports) {
    cityReports = Number.isFinite(reports) ? reports : null;
    renderTally(stories.length);
  }

  function renderTally(n) {
    const host = $('hdrTally'); if (!host) return;
    /* This is what makes the header taller: the 311 total arrives from the
       network and the line wraps to two. Everything that offsets from --hdr-h
       (.side, .layers, .l-body) is wrong until it is republished, and a stale
       value puts the layers card under the header. The ResizeObserver in
       renderChrome should catch it and usually does; this is the direct route,
       from the function that actually caused the change. rAF so it measures
       after layout rather than before. */
    requestAnimationFrame(() => publishHdr?.());
    const b = tenant.branding || {};
    const drop = `<svg class="t-drop" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 C12 2 5 10 5 15 A7 7 0 0 0 19 15 C19 10 12 2 12 2 Z" fill="currentColor"/></svg>`;
    /* Judy, 17 August: "11 stories" said nothing about what they were stories
       OF. `tallyAbout` names the subject, config like the other tally strings
       rather than typed here, so it can be reworded without a code change. */
    const storyBit = n
      ? `<b>${n.toLocaleString()}</b> ${esc(n === 1 ? S.noun[0] : S.noun[1])} ${esc(b.tallyAbout || 'about flooding')}`
      : esc(b.tallyEmpty || 'No stories yet');
    /* Two labels, one number. The long sentence wraps the tally onto a second
       line below ~700px and took the header to 135px at 600px wide, so the
       narrow case gets a shorter clause — swapped in CSS, not by measuring the
       window here, so it follows a resize without JavaScript. The FIGURE is
       rendered once either way: two copies of a number is how they drift. */
    const cityBit = cityReports == null ? ''
      : `<span class="t-div">|</span><span><b>${cityReports.toLocaleString()}</b>`
        + ` <span class="t-rep-long">${esc(b.tallyReports || 'flooding reports to 311 since Hurricane Ida')}</span>`
        + `<span class="t-rep-short">${esc(b.tallyReportsShort || 'reports to 311')}</span></span>`;
    host.innerHTML = `${drop}<span>${storyBit}</span>${cityBit}`;
  }

  /* One statement of what a facet IS: its name, where its chosen values live,
     what it can offer, and how to count a value against the current results.
     `renderFacets` reads this and nothing else, so adding a fifth facet is one
     entry here rather than four edits spread across a renderer. */
  function facetSpec(key) {
    /* REB-503, 17 August. The four story-type tiles used to be their own row
       above the feed; they are just a fifth facet now, same shape as the rest.
       `typeField.options` carries `icon`, which nothing here reads any more —
       a facet option is text and a count, like every other one in this list. */
    if (key === 'type') return {
      label: 'Story Type', sel: () => activeTypes,
      opts: () => (typeField?.options || []).map(o => ({ id: o.id, label: o.label })),
      count: pool => id => pool.filter(s => s.answers?.[typeField.id] === id).length,
      pick: oid => { activeTypes = toggle(activeTypes, oid); },
      clear: () => { activeTypes = []; },
    };
    if (key === 'cat') return {
      label: 'Category', sel: () => selCats,
      opts: () => (catField?.options || []).map(o => ({ id: o.id, label: o.label })),
      count: pool => id => pool.filter(s => asArray(s.answers?.[catField.id]).includes(id)).length,
      pick: oid => { selCats = toggle(selCats, oid); },
      clear: () => { selCats = []; },
    };
    if (key === 'event') return {
      /* REB-482. EVERY configured storm, not only the ones a story has used
         yet. Judy noticed Event had vanished: the list used to be filtered to
         options present in the data, so deleting the seed stories took the
         whole facet with it — and the storms are the point. Superstorm Sandy,
         Ida, Henri, Elsa, Isaias, Ophelia, Elliott and the June 2026
         cloudburst are what this map collects against, and a resident opening
         the filter should see that whether or not somebody has filed against
         each one yet.

         A storm with no stories renders with a 0 and the existing `.z` dim,
         which is what a shopping filter does with a size nobody has in stock:
         still listed, visibly empty. */
      label: 'Event', sel: () => selEvents,
      opts: () => (eventField?.options || []).map(o => ({ id: o.id, label: o.label })),
      count: pool => id => pool.filter(s => asArray(s.answers?.[eventField.id]).includes(id)).length,
      pick: oid => { selEvents = toggle(selEvents, oid); },
      clear: () => { selEvents = []; },
    };
    if (key === 'year') return {
      label: 'Year', sel: () => selYears,
      opts: () => yearList.map(y => ({ id: y, label: yearLabel(y) })),
      count: pool => id => pool.filter(s => storyYear(s) === id).length,
      pick: oid => { selYears = toggle(selYears, oid); },
      clear: () => { selYears = []; },
    };
    return {
      label: 'Area', sel: () => selHoods,
      opts: () => hoodList.map(h => ({ id: h, label: h })),
      count: pool => id => pool.filter(s => (s.location_label || '') === id).length,
      pick: oid => { selHoods = toggle(selHoods, oid); onNeighborhood?.(hoodArg()); },
      clear: () => { selHoods = []; onNeighborhood?.('all'); },
    };
  }

  /* Which facets are worth showing at all. Year needs the stories to span more
     than one year or it is a list with one choice in it; Area needs somewhere
     to list. Both of these are load-bearing right now: with the seed stories
     gone, this is why only two sections render (REB-474). */
  function facetKeys() {
    const keys = [];
    // Story type first — it's the facet with the most weight to it, and used
    // to be the row of tiles that sat above everything else.
    if (typeField && (typeField.options || []).length) keys.push('type');
    keys.push('cat');
    /* REB-482. Event shows whenever the tenant has configured storms to file
       against — it is a property of the map, not of how many stories have
       arrived. It used to require a story to already exist for some option,
       which meant the facet disappeared exactly when the archive was newest.

       Year and Area stay derived from the data, because they have no
       configured list to fall back on: a year nobody has filed in is not a
       year this map knows about. Year needs one real year rather than two now,
       so a young archive still shows the dimension. */
    if (eventField && (eventField.options || []).length) keys.push('event');
    if (yearList.filter(y => y !== 'none').length) keys.push('year');
    if (hoodList.length) keys.push('hood');
    return keys;
  }

  /* A vertical list of expanding sections, one per facet — the shape every
     shopping filter uses, and the reason it is worth copying is that the facet
     NAMES stay readable in a column. Across a row they were four buttons whose
     labels changed to the chosen value, so the row stopped saying what could be
     filtered as soon as you filtered anything. */
  function renderFacets() {
    const host = $('filterBar'); if (!host) return;
    host.innerHTML = facetKeys().map(key => {
      const f = facetSpec(key);
      const sel = f.sel();
      const open = openFacets.has(key);
      /* Counts exclude this facet's own choices, so each option says what it
         would yield rather than what it already did. */
      const countFor = f.count(poolExcept(key));
      const body = !open ? '' : `<div class="facet-body">${
        (f.opts().map(o => {
          const on = sel.includes(o.id);
          const c = countFor(o.id);
          return `<button type="button" class="pop-opt ${on ? 'on' : ''} ${c ? '' : 'z'}" data-facet="${esc(key)}" data-pick="${esc(o.id)}">
            <span class="pop-box" aria-hidden="true"></span>
            <span class="pop-opt-l">${esc(o.label)}</span>
            <span class="pop-opt-n">${c}</span></button>`;
        }).join('') || `<div class="pop-empty">Nothing here yet.</div>`)
        + (sel.length ? `<button type="button" class="pop-clear" data-facetclear="${esc(key)}">Clear ${sel.length} selected</button>` : '')
      }</div>`;
      return `<div class="facet ${open ? 'open' : ''}">
        <button type="button" class="facet-h" data-pop="${esc(key)}" aria-expanded="${open}">
          <span class="facet-l">${esc(f.label)}</span>
          ${sel.length ? `<span class="facet-n">${sel.length}</span>` : ''}
          <span class="facet-cv" aria-hidden="true">${icon('chevron', 14)}</span>
        </button>${body}</div>`;
    }).join('');
    host.querySelectorAll('[data-pop]').forEach(el =>
      el.addEventListener('click', e => { e.stopPropagation(); toggleFacet(el.dataset.pop); }));
    /* Picking stays inside the open section (multi-pick): apply() re-renders
       with fresh checks and counts while the results move behind the popover. */
    host.querySelectorAll('[data-pick]').forEach(el =>
      el.addEventListener('click', e => { e.stopPropagation(); facetSpec(el.dataset.facet).pick(el.dataset.pick); apply(); }));
    host.querySelectorAll('[data-facetclear]').forEach(el =>
      el.addEventListener('click', e => { e.stopPropagation(); facetSpec(el.dataset.facetclear).clear(); apply(); }));
  }

  function toggleFacet(key) {
    if (openFacets.has(key)) openFacets.delete(key); else openFacets.add(key);
    renderFacets();
  }

  /* The dot on the funnel counts CHOSEN FACETS, not chips. Story type moved in
     here 17 August (REB-503) and has to count now, or turning one on becomes
     invisible state — search stays out, it has its own visible box (behind
     its own icon now, but still its own control, not a facet). */
  function facetCount() {
    return activeTypes.length + selCats.length + selEvents.length + selYears.length + selHoods.length;
  }

  function renderFilterBtn() {
    const btn = $('filterBtn'); if (!btn) return;
    const n = facetCount();
    btn.innerHTML = `${icon('filter', 15)}<span>Filter</span>` + (n ? '<span class="fdot"></span>' : '');
    btn.classList.toggle('open', filtersOpen);
    btn.setAttribute('aria-expanded', String(filtersOpen));
    btn.setAttribute('aria-label', n ? `Filters, ${n} on` : 'Filters');
  }

  /* The popover hangs below the toolbar, so a flat 60vh cap overflows a short
     viewport. Measure the room actually left under it and hand that to CSS. */
  function fitPopover(wrap) {
    if (!wrap || wrap.hidden) return;
    const top = wrap.getBoundingClientRect().top;
    // The credit footer is fixed to the bottom, so the floor is its top edge, not the viewport's.
    const cr = $('hdrCredit')?.getBoundingClientRect();
    const floor = cr && cr.height ? Math.min(innerHeight, cr.top) : innerHeight;
    // 110 is the floor: two rows and a scrollbar. Landscape leaves about that much,
    // because the header takes half a 393px screen.
    wrap.style.setProperty('--pop-max', Math.max(110, Math.round(floor - top - 8)) + 'px');
  }
  function refitPopovers() { fitPopover($('filterWrap')); fitPopover($('searchWrap')); }
  addEventListener('resize', refitPopovers);
  addEventListener('orientationchange', () => setTimeout(refitPopovers, 120));

  function setFilters(open) {
    filtersOpen = open;
    const wrap = $('filterWrap');
    if (wrap) { wrap.hidden = !open; fitPopover(wrap); }
    /* Sections stay as they were left. Reopening the popover to the same shape
       you closed it in is the whole point of a list you scroll rather than a
       dropdown you dismiss. */
    renderFilterBtn();
    if (open) setSearchOpen(false);   // only one popover open at a time
  }

  // 17 August. Same popover pattern as setFilters, for the search box now
  // sitting behind its own icon.
  function setSearchOpen(open) {
    searchOpen = open;
    const wrap = $('searchWrap');
    if (wrap) { wrap.hidden = !open; fitPopover(wrap); }
    const btn = $('searchBtn');
    if (btn) { btn.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); }
    if (open) { setFilters(false); $('searchIn')?.focus(); }
  }

  function renderActive() {
    const row = $('activeRow'); if (!row) return;
    // One removable chip per chosen value, across every facet.
    const chips = [];
    if (searchText) chips.push({ k: 'q', v: '', label: `“${searchText}”` });
    activeTypes.forEach(id => chips.push({ k: 'type', v: id, label: optLabel(typeField, id) }));
    selCats.forEach(id => chips.push({ k: 'cat', v: id, label: optLabel(catField, id) }));
    selEvents.forEach(id => chips.push({ k: 'event', v: id, label: optLabel(eventField, id) }));
    selYears.forEach(y => chips.push({ k: 'year', v: y, label: yearLabel(y) }));
    selHoods.forEach(label => chips.push({ k: 'hood', v: label, label: label.split(',')[0] }));
    row.innerHTML = chips.map(c =>
      `<button type="button" class="achip" data-clear="${esc(c.k)}" data-val="${esc(c.v)}">${esc(c.label)} <span class="achip-x">✕</span></button>`).join('')
      + (chips.length > 1 ? `<button type="button" class="achip clear-all" data-clear="all" data-val="">Clear all</button>` : '');
    row.style.display = chips.length ? 'flex' : 'none';
    row.querySelectorAll('[data-clear]').forEach(el =>
      el.addEventListener('click', () => clearFilter(el.dataset.clear, el.dataset.val)));
  }

  function clearFilter(k, v) {
    const si = $('searchIn');
    if (k === 'all') {
      searchText = ''; activeTypes = []; selCats = []; selEvents = []; selYears = []; selHoods = [];
      openFacets.clear(); if (si) si.value = ''; onNeighborhood?.('all');
    } else if (k === 'q') { searchText = ''; if (si) si.value = ''; }
    else if (k === 'type') activeTypes = activeTypes.filter(x => x !== v);
    else if (k === 'cat') selCats = selCats.filter(x => x !== v);
    else if (k === 'event') selEvents = selEvents.filter(x => x !== v);
    else if (k === 'year') selYears = selYears.filter(x => x !== v);
    else if (k === 'hood') { selHoods = selHoods.filter(x => x !== v); onNeighborhood?.(hoodArg()); }
    apply();
  }

  // ── "me too" engagement ───────────────────────────────────────
  // A one-tap echo, deduped per device in localStorage (the server just
  // counts; identity isn't tracked). The button lives on cards and the detail;
  // reacting in one place syncs the count everywhere that story shows.
  const metooKey = id => `gt-metoo-${tenant.slug}-${id}`;
  const hasReacted = id => { try { return localStorage.getItem(metooKey(id)) === '1'; } catch { return false; } };
  function paintMetoo(btn, n, reacted) {
    const c = btn.querySelector('.mt-n');
    if (c) { if (n > 0) { c.textContent = n; c.hidden = false; } else c.hidden = true; }
    btn.classList.toggle('reacted', reacted);
    btn.setAttribute('aria-pressed', reacted ? 'true' : 'false');
    btn.setAttribute('aria-label', reacted
      ? `You said this happened to you too${n ? `, ${n} echoes so far` : ''}. Tap to undo.`
      : `This happened to me too${n ? `, ${n} echoes so far` : ''}. Tap to add yours.`);
    // No longer disabled once reacted (18 August) -- a reacted button is the
    // undo control now, not a dead end.
  }
  // Reflect a story's current count + reacted state on every button showing it.
  function syncMetoo(id) {
    const s = stories.find(x => x.id === id);
    document.querySelectorAll(`[data-metoo="${CSS.escape(id)}"]`).forEach(btn => paintMetoo(btn, s?.me_too || 0, hasReacted(id)));
  }
  /* Toggles both ways (18 August, Judy's ask -- a thumbs-up you can take
     back). Reacting still calls bump_story_reaction and persists for real.
     Un-reacting is CLIENT-ONLY: there is no matching decrement RPC in
     js/data.js (`bumpReaction` only ever adds one), so the count shown here
     can drift below the true server total between an undo and the next
     reload -- another visitor loading the page fresh sees the server's
     number, not this device's rollback. Re-reacting after an undo bumps the
     server again rather than silently no-op'ing, so the device's own dedup
     flag never lies about whether IT has echoed. A real undo needs a
     decrement RPC -- a migration, not a client fix -- flagged here rather
     than faked. */
  async function reactMetoo(btn) {
    const id = btn.dataset.metoo;
    const reacting = !hasReacted(id);
    const s = stories.find(x => x.id === id);
    const prev = s?.me_too || 0;
    try {
      if (reacting) localStorage.setItem(metooKey(id), '1');
      else localStorage.removeItem(metooKey(id));
    } catch { /* private mode — still toggles for this session */ }
    if (s) s.me_too = Math.max(0, prev + (reacting ? 1 : -1));   // optimistic
    syncMetoo(id);
    if (!reacting) return;                     // undo: no server call, see comment above
    const server = await onMeToo?.(id);         // persist + reconcile
    if (server != null) {
      if (s) s.me_too = server;
    } else {                                     // save failed — roll back cleanly
      try { localStorage.removeItem(metooKey(id)); } catch { /* ignore */ }
      if (s) s.me_too = prev;
    }
    syncMetoo(id);
  }
  // Bind (and pre-paint) every me-too button inside a freshly rendered container.
  function wireMetoo(container) {
    if (!container) return;
    container.querySelectorAll('[data-metoo]').forEach(btn => {
      const id = btn.dataset.metoo;
      paintMetoo(btn, stories.find(x => x.id === id)?.me_too || 0, hasReacted(id));
      btn.addEventListener('click', e => { e.stopPropagation(); reactMetoo(btn); });
    });
  }
  // Reveal a public reachback contact on demand — it stays hidden in the DOM
  // until the reader explicitly asks (a mild speed-bump against bulk scraping).
  function wireReveal(container) {
    container?.querySelectorAll('[data-reveal]').forEach(btn =>
      btn.addEventListener('click', () => {
        const val = btn.parentElement?.querySelector('.sp-reach-val');
        if (val) val.hidden = false;
        btn.remove();
      }));
  }

  // ── stories ───────────────────────────────────────────────────
  function setReactions(on) { reactionsOn = !!on; }

  /* Judy, 19 August: the pill should count what you are looking at. In the
     gallery that is media, not stories, and the two numbers differ a lot (one
     story can carry ten files). Named by the kinds actually present, so it
     never says "photos" over a wall of video. Three or more kinds is too long
     for a pill that shares its row with the title and the ✕. */
  const MEDIA_N = { photo: ['photo', 'photos'], video: ['video', 'videos'],
                    audio: ['voice note', 'voice notes'], document: ['file', 'files'] };
  function galleryCount(items) {
    const n = items.length;
    if (!n) return '0';
    const words = ['photo', 'video', 'audio', 'document']
      .filter(k => items.some(i => i.kind === k))
      .map(k => MEDIA_N[k][n === 1 ? 0 : 1]);
    return words.length > 2 ? `${n} media` : `${n} ${words.join(' & ')}`;
  }
  let sideView = 'list';
  let galleryItems = [];
  function paintCount() {
    const n = stories.length, list = filtered();
    $('sideCount').textContent = sideView === 'gallery'
      ? galleryCount(galleryItems)
      : (list.length === n ? `${n}` : `${list.length} of ${n}`);
  }

  function renderStories(all) {
    const dataChanged = all !== stories;
    stories = all;
    if (dataChanged) renderHoods();
    const list = filtered();
    const n = stories.length;
    renderTally(n);
    const fn = $('fabN'); if (fn) fn.textContent = n;   // absent while the FAB reads "Back to story"
    /* REB-457. The count sits on the title line now, so it has to earn its
       width: "11 of 11 stories" beside "Community Stories" says "stories"
       twice and pushes the view toggle off the row. Unfiltered it is the total
       alone; filtered it is the pair, which is the only time the second number
       tells anyone anything. */
    renderControls(); // chips carry live per-type counts
    renderFeed(list);
    renderGallery(list);   // sets galleryItems, which paintCount reads
    paintCount();
    if (openId) renderStoryNav();   // "3 of 11" has to follow the filtered count
    return list;
  }

  // Empty feed. An area with no stories is an invitation, not a dead end:
  // name the place and encourage the resident to be the first to post there.
  function feedEmptyHtml() {
    const anyFilter = searchText || selCats.length || selEvents.length || selHoods.length || activeTypes.length;
    // A single chosen area with nothing in it is an invitation to be first.
    if (selHoods.length === 1 && selCats.length === 0 && selEvents.length === 0 && activeTypes.length === 0 && !searchText) {
      const area = selHoods[0].split(',')[0];
      return `<div class="feed-empty">
        <span class="fe-drop">${dropMark('#9DB6C2', 34)}</span>
        <div class="fe-title">No stories in ${esc(area)} yet</div>
        <div class="fe-sub">Be the first to share what flooding looks like here. Your story helps make the case for a rainproof ${esc(area)}.</div>
        <button type="button" class="fe-cta" id="feAdd">Be the first to share</button>
      </div>`;
    }
    if (anyFilter) {
      return `<div class="feed-empty">
        <div class="fe-title">No stories match these filters</div>
        <div class="fe-sub">Try clearing a filter to see more of the map.</div>
        <button type="button" class="fe-cta ghost" id="feClear">Clear filters</button>
      </div>`;
    }
    return emptyState(tenant.feed?.emptyText || 'No stories yet in this view.');
  }

  function renderFeed(list) {
    $('feed').innerHTML = list.map(s => storyCard(tenant, s, { reactions: reactionsOn })).join('') || feedEmptyHtml();
    wireMetoo($('feed'));

    /* REB-475. Hovering a card grows its raindrop on the map, so a reader can
       place a story in the city before deciding to open it.

       On the card, not on its inner parts: `mouseenter`/`mouseleave` do not
       bubble, so moving between the photo, the text and the tags inside one
       card never flickers the pin off and on.

       Cleared on leave rather than tracked, so a card removed by a filter
       while the pointer is on it cannot leave a pin stuck at 1.6x. */
    $('feed').querySelectorAll('.scard').forEach(el => {
      el.addEventListener('mouseenter', () => onStoryHover?.(el.dataset.story));
      el.addEventListener('mouseleave', () => onStoryHover?.(null));
    });
    $('feed').querySelectorAll('.scard').forEach(el =>
      el.addEventListener('keydown', e => {
        // Only the card itself: a tag or the me-too pill inside it handles its own keys.
        if (e.target !== el) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStoryOpen?.(el.dataset.story); }
      }));
    $('feed').querySelectorAll('.scard').forEach(el =>
      el.addEventListener('click', e => {
        // Tapping the card photo opens the STORY, not the lightbox: the
        // fullscreen viewer lives inside the detail, so a photo click always
        // lands on its context first (better than a bare image with no story).
        const hd = e.target.closest('[data-hood]');
        if (hd) { e.stopPropagation(); setHood(hd.dataset.hood); return; }
        // A card's hashtags apply the same category filter storyDetail's own
        // tag badges already do (data-filtercat) — same attribute, same setCat.
        const tag = e.target.closest('[data-filtercat]');
        if (tag) { e.stopPropagation(); setCat(tag.dataset.filtercat); return; }
        onStoryOpen?.(el.dataset.story);
      }));
    // 17 August: used to click the floating #ctaBtn, which is gone and opened
    // the form with no location anyway. Pointing at the address bar keeps
    // "be the first to share" anchored to a place instead of a blank form.
    $('feAdd')?.addEventListener('click', () => $('addrIn')?.focus());
    $('feClear')?.addEventListener('click', () => clearFilter('all'));
  }

  function renderGallery(list) {
    const items = list.flatMap(s => (s.media || []).map(m => ({ ...m, story: s })));
    galleryItems = items;
    $('gallery').innerHTML = items.length
      ? items.map(item => galleryItem(tenant, item)).join('')
      : emptyState('No photos or media shared yet.');
    $('gallery').querySelectorAll('.gal-item').forEach(el => {
      el.addEventListener('click', () => onStoryOpen?.(el.dataset.story));
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStoryOpen?.(el.dataset.story); }
      });
    });
  }

  // ── story detail: hosted in the side pane so the map stays visible ──
  function distKm(a, b) {
    const R = 6371, r = x => x * Math.PI / 180;
    const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  /* A plain row, not a card. Four bordered mini-cards made the discovery list
     compete with everything above it; a dot, a name and a clipped line is
     enough to invite a tap. */
  function miniCard(x) {
    /* The dot was the story type's own hue (REB-463): a bare 8px circle that
       named a type only if the reader had memorised four colours, and one of
       the last places still using the retired scheme. It is the raindrop now,
       so the glyph says which kind of story it is. */
    return `<div class="sd-near-item" data-story="${esc(x.id)}" role="button" tabindex="0">
      <span class="sd-near-dot">${dropMark(storyBrandColor(tenant), 16, storyIcon(tenant, x))}</span>
      <span class="sd-near-txt"><b>${esc(byline(tenant, x))}</b> ${esc(excerpt(storyText(tenant, x), 54))}</span>
      <span class="sd-near-hood">${esc((x.location_label || '').split(',')[0])}</span>
    </div>`;
  }
  // Stories near this one — same neighbourhood or within ~1.2km, topped up by
  // same-category matches. Feeds the "more stories nearby" list.
  function nearby(s) {
    if (s.lat == null) return [];
    const rows = stories.filter(x => x.id !== s.id && x.lat != null).map(x => ({
      x, d: distKm(s, x),
      sameHood: !!(s.location_label && x.location_label === s.location_label),
      sameCat: catField && x.answers?.[catField.id] === s.answers?.[catField.id],
    }));
    const near = rows.filter(o => o.d <= 1.2 || o.sameHood);
    const byId = {}; near.forEach(o => (byId[o.x.id] = o));
    rows.filter(o => o.sameCat).forEach(o => { if (!byId[o.x.id]) byId[o.x.id] = o; });
    return Object.values(byId).sort((a, b) => a.d - b.d).slice(0, 4);
  }

  /* One action row, unframed. The old bordered "Add your voice" card was one
     of four boxes stacked down the pane; dropping the frame lets the story
     stay the only thing that looks important. Primary first, echo second. */
  /* Short labels, with the fuller wording moved to a hover tip. The buttons
     used to wrap onto two lines and carry an explanatory caption underneath;
     between them they cost more vertical space in the pane than the story.
     The visible text stays the accessible name (no aria-label override), so
     the tip is genuinely supplementary rather than a replacement. */
  /* A clean link to one story: the page url with every filter stripped and
     just ?story= left, so what someone sends is the story and not whatever
     slice of the map they happened to be looking at. Falls back to a select-
     and-copy when the clipboard is unavailable, which is any page not served
     over https and Safari in some embedded contexts. */
  function storyLink(id) {
    return `${location.origin}${location.pathname}?story=${encodeURIComponent(id)}`;
  }
  async function copyStoryLink(btn) {
    const url = storyLink(btn.dataset.copylink);
    /* The button is an icon at rest, so the confirmation expands it briefly
       rather than replacing a label that is no longer there. Empty again after,
       which collapses it back — `.sd-link-txt:empty` is display:none. */
    const label = btn.querySelector('.sd-link-txt');
    const done = ok => {
      label.textContent = ok ? 'Link copied' : 'Press ⌘C to copy';
      btn.classList.toggle('copied', ok);
      setTimeout(() => { label.textContent = ''; btn.classList.remove('copied'); }, 2600);
    };
    try {
      await navigator.clipboard.writeText(url);
      done(true);
    } catch {
      const inp = document.createElement('input');
      inp.value = url;
      inp.className = 'sd-link-fallback';
      btn.after(inp);
      inp.select();
      done(false);
      setTimeout(() => inp.remove(), 8000);
    }
  }

  function engagementHtml(s) {
    const canAddNear = s.lat != null;
    // The row always renders now: even with no reactions and no pin, the copy
    // link belongs to every story.
    const hood = (s.location_label || '').split(',')[0];
    const where = hood ? `in ${esc(hood)}` : 'in this neighborhood';
    // "N neighbors shared stories near here" removed 18 August, Judy: less
    // is more, and the "More stories nearby" list right below already shows
    // the same thing directly instead of summarizing it first.
    return `<div class="sd-act">
      <div class="sd-act-row">
        ${canAddNear ? `<button type="button" class="sd-addnear" data-lat="${s.lat}" data-lng="${s.lng}" title="Share your story ${where}. It takes about two minutes.">${icon('plus')} Share your story</button>` : ''}
        ${reactionsOn ? upvoteButton(s, 'sd-metoo') : ''}
        <!-- Every story has an address now (REB-428). The url already carries
             it, but nobody reads an address bar on a phone, so the link is a
             button. -->
        <!-- Icon only, so "Share your story" keeps its label on one line (Judy,
             7 Aug). Two consequences handled rather than inherited: the visible
             text WAS the accessible name, so there is an aria-label now; and
             the copy confirmation used to overwrite that text, so it goes in a
             span that is empty at rest and announced when it fills. -->
        <button type="button" class="sd-link" data-copylink="${esc(s.id)}"
          aria-label="Copy a link to this story"
          title="Copy a link straight to this story">${icon('link')}<span class="sd-link-txt" role="status"></span></button>
      </div>
    </div>`;
  }

  /* ── the city's own record around this story ──
     What NYC's 311 log and DEP's built green infrastructure say about the
     same half mile the resident just described. It sits between the story and
     "Add your voice" on purpose: read what happened here, see the official
     record agree, then add yours.

     The numbers are a live third-party lookup, so the pane never waits on
     them — the block renders as an empty placeholder and fills in, and simply
     stays hidden if the lookup fails or times out. */
  let cityReq = 0;
  /* The two numbers side by side. The whole reason this block exists is the
     imbalance between them, so they sit at equal size with a hairline between:
     the reader gets it in one glance. Deliberately NOT a chart — nothing
     honest can plot a 307-to-1 ratio — and deliberately no accent colour,
     because teal means "this is a control" everywhere else in the pane. */
  /* Direction C of the 18 August mockup round (Judy: "cleanup, not a
     rebuild") — same two-column pair this panel has always had, with the
     audit's specific complaints fixed: every category is a fixed small-caps
     NAME now ("Reported to 311", "Green Infrastructure"), not a
     count-agreeing noun phrase, which is what put Title Case ("Green
     Infrastructure asset") directly above lowercase breakdown rows ("1
     subsurface storage") in the same block. `labelHalfMile` on each dataset
     in config, not a [singular, plural] pair — there is nothing left to
     agree in number once the label is a name rather than a noun. */
  function cityContextHtml(d) {
    const cfg = tenant.cityData || {};
    const reportsLabel = cfg.complaints?.labelHalfMile || 'Reported to 311';
    const greenLabel = cfg.green?.labelHalfMile || 'Green Infrastructure';
    const since = cfg.sinceLabel ? `since ${cfg.sinceLabel}` : '';
    /* The 311 breakdown, demoted to one quiet line under the figure it splits.
       Each count carries its map-layer colour as a small dot, so a reader ties
       the number to the layer they can switch on. The dot is the only thing
       wearing the colour: the text stays ink, which keeps the block from
       looking interactive and keeps it legible for colour-blind readers, who
       always have the label right beside the swatch. */
    const dot = (c, cls) => `<i class="sd-city-dot${cls ? ` ${cls}` : ''}" style="background:${esc(c || 'var(--faint)')}"></i>`;
    const splitOf = (list, forceColor) => (list || []).filter(k => k.n > 0)
      .map(k => `<span class="sd-city-key">${dot(forceColor || k.color)}${k.n.toLocaleString()} ${esc(k.label)}</span>`).join('');
    const split = splitOf(d.kinds);
    /* The built side breaks down the same way (Judy, 7 Aug): four families
       with their own counts rather than one opaque total.

       18 August: one dot colour for all of them now, `colorBuilt`
       (`#0f7f12`) — was four different shades of green, one per asset-type
       family. Judy's audit: the Map Layers panel only ever draws TWO greens
       (built / in progress), never four, so a reader comparing this list to
       the map saw shades here that meant nothing there. Colour now encodes
       STATUS only, matching the map exactly; which asset type each line is
       stays in the label text, same as it always did.

       The fourth family is a `rest: true` catch-all and is load-bearing
       (REB-452): DEP publishes 31 asset types and the three named families
       cover 13,144 of 13,959, so three lines would total less than the figure
       above them. Never narrow the query to the three. */
    let greenSplit = splitOf(d.greenKinds, cfg.green?.colorBuilt);
    /* In-progress DEP assets, as one more line in the same list — never
       folded into the total above it. `d.green` stays Constructed-only (see
       the note on `greenWhere` in citydata.js); this is a second, separate
       fact for a radius that has both, coloured light green
       (`colorInProgress`) against the built total's dark green
       (`colorBuilt`) — Judy's own values from the map layer's steps, reused
       here so the panel and the map agree. REB-348 was built and not-yet-
       built counted as one number; keeping this a distinct line, not a
       distinct colour on the same number, is how that doesn't happen again. */
    if (d.greenInProgress > 0) {
      greenSplit += `<span class="sd-city-key">${dot(cfg.green?.colorInProgress)}${d.greenInProgress.toLocaleString()} in progress</span>`;
    }
    const cell = (n, label, desc, sub, color) => `<div class="sd-city-cell">
        <span class="sd-city-n">${n.toLocaleString()}</span>
        <span class="sd-city-l">${color ? dot(color) : ''}${esc(label)}</span>
        ${desc ? `<span class="sd-city-desc">${esc(desc)}</span>` : ''}
        ${sub ? `<span class="sd-city-sub">${sub}</span>` : ''}
      </div>`;
    /* 18 August, Judy: name the two sources in one line under the heading,
       rather than let the reader infer "reports" vs "built" from the numbers
       alone. Config-driven (`cityData.subheading`) like `heading` itself, so
       a tenant without one just gets nothing here. Not the REB-458 caveat
       paragraph back — that was three caveats delivered before anyone asked
       a question; this is one line naming what the two counts are. Plain
       weight, no italic — Judy: nothing else in this app is italicised, so
       this shouldn't be the first thing that is. */
    return `<div class="sd-city-h">${esc(cfg.heading || 'Nearby')}</div>
      ${cfg.subheading ? `<div class="sd-city-caption">${esc(cfg.subheading)}</div>` : ''}
      <div class="sd-city-pair">
        ${cell(d.reports, reportsLabel, since, split, '')}
        <div class="sd-city-div" aria-hidden="true"></div>
        ${cell(d.green, greenLabel, '', greenSplit, greenSplit ? '' : cfg.green?.colorBuilt)}
      </div>`
      /* FloodNet goes LAST, on purpose (REB-432) — a measurement that
         corroborates the pair above is evidence underneath it, not a
         headline above it. This used to sit under a "gap" flag paragraph
         (removed 18 August, Judy's ask) that made the same point in prose;
         the reasoning for FloodNet's position outlives that paragraph.
         REB-352's standing rule is that FloodNet corroborates 311 and never
         contradicts it, and where it sits on the page is part of honouring
         that — a sensor that has stayed dry must not read as a rebuttal of the
         neighbours who have been calling 311 for five years. */
      + sensorsHtml(d.sensors);
  }

  /* "2024-08-14" → "August 2024". Day precision is dropped deliberately: to the
     sentence "measured water 14 times since it was installed", the month is the
     honest resolution. The explicit T00:00:00 stops a bare date parsing as UTC
     and formatting as the previous day in New York. */

  /* The measured line. Three things are load-bearing here and none is decoration:

     1. **The install date.** "Measured water 14 times" is meaningless without
        it — a 2021 sensor and a 2026 sensor are not comparable, and REB-352
        found that exactly this comparison makes rising deployment look like
        rising flooding. The count never appears without its window.
     2. **Zero is a sentence, not a blank.** 193 of 479 sensors have never
        measured a flood. Rendering that as nothing would let a reader take
        silence for dryness; it is far more often a sensor installed last year.
     3. **Tidal sensors say so.** 13% of the network sits where the tide
        reaches and they carry 70% of all measured flooding. On a map about rain
        that cannot drain, an unlabelled tidal reading is the wrong number in
        the right place. */
  /* 18 August, Judy: unbold the sentence, bold and colour only the numbers,
     so the eye lands on the figures instead of the whole line shouting.
     #2db4d9 is the brand blue (the map pin / hover colour), not the story
     green — this section measures rather than reports, so it gets its own
     colour rather than borrowing the reactions' or the hashtags' green. */
  const numSpan = n => `<b class="sd-city-num">${n}</b>`;
  /* The FloodNet dot is a diamond, not a circle (18 August, Judy: sync it
     with the map, where FloodNet draws as black diamonds on purpose — see
     the note on `cityData.sensors.color` in config.json). `.diamond` is a
     rotated square; every other swatch in this panel stays a plain circle,
     which is itself the point — shape says "this one measures, the rest
     count what was reported or built". */
  const sensorDot = c => `<i class="sd-city-dot diamond" style="background:${esc(c || 'var(--faint)')}"></i>`;
  function sensorsHtml(sn) {
    const cfg = tenant.cityData?.sensors;
    if (!cfg) return '';
    const nn = cfg.noun || ['flood sensor', 'flood sensors'];
    /* A radius can genuinely have none — 434 sensors citywide, an 805m
       ring often misses them (18 August, Judy: this used to just vanish,
       which read as "no data" rather than "checked, and there are zero
       here"). Same big-number shape as a real count, just 0, so absence
       reads as a fact instead of a hole in the panel. */
    if (!sn) {
      return `<div class="sd-city-block">
          <div class="sd-city-top">
            <span class="sd-city-n">0</span>
            <span class="sd-city-l">${sensorDot(cfg.color)}${esc(nn[1])}</span>
          </div>
        </div>`;
    }
    const s = sn.nearest;
    const name = s.name ? esc(s.name) : '';
    /* One formatted month, phrased by whichever branch uses it. Holding a
       pre-built " since March 2021" instead produced "since it was installed
       since July 2024" on every dry sensor — the two branches need the date,
       not the same clause. */
    const when = s.since ? esc(monthYear(s.since)) : '';
    /* "The nearest" is a comparison, so it needs others to be nearest among.
       With one sensor in the ring there are none, and it reads as a slip. */
    const subject = sn.count === 1
      ? (name ? `It sits at ${name} and` : 'It')
      : (name ? `The nearest, at ${name},` : 'The nearest');

    let body;
    if (s.n > 0) {
      body = `${subject} has measured water ${numSpan(s.n.toLocaleString())} time${s.n === 1 ? '' : 's'}${when ? ` since ${when}` : ''}.`
        + (s.depth ? ` The deepest was ${numSpan(esc(String(s.depth)))} inches.` : '');
    } else {
      /* Reads as "installed and quiet", never as "here it does not flood".
         The install date carries the whole weight of that distinction. */
      body = `${subject} has not measured any flooding${when ? ` since it was installed in ${when}` : ' yet'}.`;
    }
    const tidal = s.tidal && cfg.tidalNote ? ` ${esc(cfg.tidalNote)}` : '';
    /* Same big-number treatment as the reports/green pair above it (18
       August, Judy: the sensor count read small next to them, as if it
       mattered less). `.sd-city-n`/`.sd-city-l` are the exact classes the
       pair cells use — reused, not matched by eye, so a change to one
       changes both. */
    return `<div class="sd-city-block">
        <div class="sd-city-top">
          <span class="sd-city-n">${sn.count.toLocaleString()}</span>
          <span class="sd-city-l">${sensorDot(cfg.color)}${esc(sn.count === 1 ? nn[0] : nn[1])}</span>
        </div>
        <p class="sd-city-desc-p">${body}${tidal}</p>
      </div>`;
  }
  async function renderCityContext(s) {
    if (!city || s.lat == null || s.lng == null) return;
    const req = ++cityReq;
    const d = await city.nearPoint(s.lat, s.lng);
    if (!d || req !== cityReq) return;      // lookup failed, or a newer story opened
    /* Nothing in ANY of the three datasets means the pin is off the city's map
       entirely (a story from outside NYC, a demo pin). Say nothing rather than
       "0". A sensor counts: a block can have no 311 history and no rain garden
       and still be instrumented, and that is a real thing to be able to say. */
    if (!d.reports && !d.green && !d.sensors) return;
    const el = $('sdCity');                 // re-query: the pane may have re-rendered
    if (!el) return;
    el.innerHTML = cityContextHtml(d);
    el.hidden = false;
  }

  /* ── The half-mile panel for a tapped place (REB-442) ──────────

     Same evidence a story carries, for a spot nobody has written about yet.
     It reuses `cityContextHtml`, deliberately: a resident should not have to
     learn two ways of reading the same two numbers.

     `placeReq` guards against a slow lookup landing after the reader has moved
     on — Socrata takes ~2s and someone tapping around the map will out-run it.
     Every render checks its own sequence number before touching the DOM. */
  let placeReq = 0;
  let placeAt = null;               // {lat, lng} currently shown, for the CTA

  function closePlace() {
    placeReq++;                     // abandon anything in flight
    placeAt = null;
    $('placeDetail')?.classList.remove('open');
    onPlaceClose?.();
  }

  async function openPlace(lat, lng) {
    const panel = $('placeDetail');
    if (!panel || !city || lat == null || lng == null) return;
    closeStory();                   // the two panes occupy the same space
    const req = ++placeReq;
    placeAt = { lat, lng };
    panel.classList.add('open');
    /* After closeStory(), never before: closing a story clears the radius
       focus, so drawing the new circle first would have it wiped a line later.
       This is the same ordering trap that made click-to-add submit stories with
       no coordinates — a setter followed by a reset that undoes it. */
    onPlaceOpen?.(lat, lng);

    /* Same text as the sidebar's own CTA now (`tenant.cta.share`, not a
       second hardcoded string) — Judy, 18 August: it should read as the
       same button, not a location-flavoured variant of it. */
    const cta = `<button type="button" class="pd-cta" id="pdAdd">${icon('chat')} ${esc(tenant.cta.share)}</button>`;

    $('pdHead').innerHTML = `<div class="pd-eyebrow">This spot</div>
      <h2 class="pd-title" id="pdTitle">Looking up this block…</h2>`;
    $('pdBody').innerHTML = `<div class="sd-city" id="pdCity"><p class="pd-wait">Reading what New Yorkers reported near here…</p></div>`;
    wirePlaceCta();

    /* The neighbourhood name, so the panel is about somewhere rather than about
       a coordinate. Resolved separately from the counts and rendered as soon as
       it lands, because the boundary file is local and instant while the counts
       are a network round trip. */
    loadPlaces().then(() => {
      if (req !== placeReq) return;
      const name = neighbourhoodAt(lat, lng);
      const t = $('pdTitle');
      if (t) t.textContent = name || 'This half mile';
    });

    const d = await city.nearPoint(lat, lng);
    if (req !== placeReq) return;               // the reader moved on
    const body = $('pdBody');
    if (!body) return;

    if (!d || (!d.reports && !d.green && !d.sensors)) {
      /* Nothing in either dataset means the tap landed outside the city's
         record, not that the block is dry. Saying "0 reports" would be a
         finding; this is an absence of data and has to read as one. */
      body.innerHTML = `<div class="sd-city">
          <p class="pd-empty">NYC Open Data has no flooding reports and nothing built to soak up rain within half a mile
          of here. That usually means the spot is outside New York City, or on water.</p>
        </div>${cta}`;
      wirePlaceCta();
      return;
    }

    /* REB-458. There was a three-caveat paragraph here — the half mile, the 311
       lag, and quiet-is-not-dry — delivered before the reader had asked a single
       question. All of it is true and none of it is what someone wants at the
       moment they tap a block. The caveats live in the methodology panel now,
       which has a door in the nav and a section that exists for exactly this.

       What carries the meaning on the card is the heading `cityContextHtml`
       already draws, "Within a half mile of here": five words, and it says what
       the numbers cover.

       The "Where these numbers come from" link that used to sit here is gone —
       removed 18 August, Judy: "less is more". `onOpenMethod` and the
       Methodology nav item are still doors to the same panel; this was the
       third and the one most likely to go unused, sitting after a "Does this
       match?" prompt that was cut the same evening for the same reason. */
    /* The "Does this match what you have seen?" prompt was here — removed
       18 August, Judy's ask (same request Mylene made on REB-506: it read as
       a question nobody had asked yet, the same problem REB-458 already
       fixed once for the caveat paragraph above). */
    body.innerHTML = `<div class="sd-city">${cityContextHtml(d)}</div>` + cta;
    wirePlaceCta();
  }

  /* Bound here rather than delegated from document, on purpose: every .sheet in
     the shell carries onclick="event.stopPropagation()", so a delegated handler
     silently does nothing inside a panel. Same rule app.js states for the
     layers-panel methodology link — one rule, applied in both places. Called
     after every render of the place body, since the body is replaced wholesale. */
  function wirePlaceCta() {
    $('pdAdd')?.addEventListener('click', () => {
      const at = placeAt;
      closePlace();
      if (at) onAddNear?.(at.lat, at.lng);
    });
  }

  // A visually separate discovery list — reading others, not a call to act.
  function similarHtml(list) {
    if (!list.length) return '';
    return `<div class="sd-near">
      <div class="sd-near-h">${icon('map')} More stories nearby</div>
      ${list.map(o => miniCard(o.x)).join('')}
    </div>`;
  }
  /* ── reading one story after another ──────────────────────────
     A resident who opens a story is reading, not searching, so the pane
     carries its own prev/next instead of making them go back to the list
     each time. The sequence IS the filtered feed order, so whatever they
     filtered to is what they step through, and the counter tells them how
     far in they are. Ends are disabled rather than wrapping: silently
     looping back to the first story reads as a bug. */
  function storyStep(delta) {
    const list = filtered();
    const i = list.findIndex(x => x.id === openId);
    const next = i < 0 ? null : list[i + delta];
    if (next) onStoryOpen?.(next.id);
  }
  function renderStoryNav() {
    const list = filtered();
    const i = list.findIndex(x => x.id === openId);
    // A story reached from a map pin can sit outside the current filter; then
    // there is no position to step from, so the whole control stands down.
    const orphan = i < 0;
    // Two steppers now: the panel's and the phone card's. Same numbers.
    [['sdPrev', 'sdNext', 'sdCount'], ['scPrev', 'scNext', 'scCount']].forEach(([p, n, c]) => {
      const prev = $(p), next = $(n), count = $(c);
      if (!prev || !next || !count) return;
      prev.innerHTML = icon('chevronL', 16);
      next.innerHTML = icon('chevronR', 16);
      count.textContent = orphan ? '' : `${i + 1} of ${list.length}`;
      prev.disabled = orphan || i === 0;
      next.disabled = orphan || i === list.length - 1;
    });
  }

  /* The FAB is the way back into the panel, so it has to say what it reopens.
     While a story is open that is the story, not the list — on a phone the
     panel covers the map, so "see this on the map" and this button are the
     two halves of one round trip. */
  function syncFab() {
    const b = $('fabBtn');
    if (!b) return;
    b.innerHTML = $('sideDetail')?.classList.contains('open')
      ? `${icon('chevronL')} ${esc(S.fabBackLabel || 'Back to story')}`
      : `${icon('chat')} ${esc(S.fabLabel || 'Stories')} <span class="fab-n" id="fabN">${stories.length}</span>`;
  }

  /* One entry point, two destinations. Every caller (map pin, feed card,
     permalink, prev/next) still calls openStory and does not need to know
     which one it gets. */
  function openStory(s) {
    if (isPhone() && $('storyCard')) { openStoryCard(s); return; }
    openStoryFull(s);
  }

  /* The card. Name, place, one photo, the opening lines and the tags — enough
     to know whether to read on, in the bottom third, with the pin still on
     screen above it. */
  function openStoryCard(s) {
    const card = $('storyCard');
    openId = s.id;
    cardStory = s;
    $('scDrop').innerHTML = dropMark(storyBrandColor(tenant, s), 27, storyIcon(tenant, s));
    $('scWho').textContent = byline(tenant, s);
    $('scHood').textContent = s.location_label || '';
    const media = s.media || [];
    // A video's poster stands in for a photo; a story with neither gives its
    // text the full width rather than leaving a grey box.
    const shot = media.find(m => m.kind === 'photo') || media.find(m => m.kind === 'video' && m.thumb);
    const src = shot ? (shot.thumb || shot.url) : '';
    const text = storyText(tenant, s) || '';
    $('scBody').innerHTML =
      (src ? `<img class="sc-thumb" src="${esc(src)}" loading="lazy" alt="">` : '') +
      `<div class="sc-text">${esc(excerpt(text, 190))}</div>`;
    // Same chips as the feed card, same job: tapping one filters the map.
    const filterField = roleField(tenant, 'filter');
    const cats = asArray(s.answers?.[filterField?.id]).map(id => fieldOption(filterField, id)).filter(Boolean);
    $('scTags').innerHTML = cats.length
      ? `<div class="scard-tags">${cats.map(c =>
          `<button type="button" class="scard-tag" data-filtercat="${esc(c.id)}">${esc(hashtag(c.label))}</button>`).join('')}</div>`
      : '';
    $('scTags').querySelectorAll('[data-filtercat]').forEach(el =>
      el.addEventListener('click', () => setCat(el.dataset.filtercat)));
    $('scMore').innerHTML = `${esc(S.cardMoreLabel || 'Read the full story')} ${icon('chevronR', 15)}`;
    card.classList.add('open');
    $('sideDetail')?.classList.remove('open');   // stepping back from the full view
    /* The list is a destination you come back FROM. Reached from a card in the
       feed, it would otherwise stay open behind the story card and keep the
       map covered, which is the one thing this card exists to prevent. */
    $('side')?.classList.remove('open');
    renderStoryNav();
    syncFab();
    writeUrl();
  }

  function closeStoryCard() {
    $('storyCard')?.classList.remove('open');
    cardStory = null;
  }

  /* Rotating a phone to landscape crosses 768 and the card goes display:none,
     which would lose the open story with nothing shown in its place. Move it to
     whichever surface the new width owns, both directions.

     Idempotent, and driven by BOTH the media query and a plain resize: the two
     do not fire together on every engine, and doing the work twice is a no-op
     while missing it entirely leaves a story open on a surface nobody can see. */
  function syncStorySurface() {
    if (!openId) return;
    const s = stories.find(x => x.id === openId);
    if (!s) return;
    const wantCard = isPhone() && !!$('storyCard');
    if (wantCard) {
      if (!$('storyCard').classList.contains('open')) openStoryCard(s);
    } else if (!$('sideDetail')?.classList.contains('open')) {
      openStoryFull(s);
    }
  }
  phoneQ.addEventListener('change', syncStorySurface);
  window.addEventListener('resize', () => {
    clearTimeout(surfaceTimer);
    surfaceTimer = setTimeout(syncStorySurface, 120);
  });

  function openStoryFull(s) {
    closeStoryCard();
    $('side').classList.add('open');          // a map-pin click must reveal the panel
    openId = s.id;
    const { headStyle, headHtml, bodyHtml } = storyDetail(tenant, s);
    $('sdHead').style.cssText = headStyle;
    $('sdHead').innerHTML = headHtml;
    const list = nearby(s);
    // Phone only: the panel covers the map, so a story arrives with no sense of
    // where it is. This hands the map back with the pin already framed; the FAB
    // brings the story back. Hidden on desktop, where the map never left.
    const locateHtml = (s.lat != null && s.lng != null)
      ? `<button type="button" class="sd-locate" id="sdLocate">${icon('map')} See where this is on the map</button>`
      : '';
    /* Person, Account, Evidence, Action (REB-443). storyDetail owns the four
       sections and leaves two slots: #sdCity inside Evidence, #sdActionExtra at
       the end of Action. Everything the caller adds is an action, so it all
       goes in the second slot rather than being appended after the sections.

       The locate button used to OPEN the pane, above the story, which put a
       control before the thing it acts on. It is an action like the others now. */
    $('sdBody').innerHTML = bodyHtml;
    const actionSlot = $('sdBody').querySelector('#sdActionExtra');
    if (actionSlot) {
      actionSlot.innerHTML = locateHtml + engagementHtml(s) + similarHtml(list);
    } else {
      // A layout hosting an older storyDetail still gets everything, in order.
      $('sdBody').insertAdjacentHTML('beforeend', locateHtml + engagementHtml(s) + similarHtml(list));
    }
    $('sdLocate')?.addEventListener('click', () => {
      $('side').classList.remove('open');     // the detail stays open underneath
      syncFab();
      onLocate?.(s);
    });
    renderCityContext(s);
    wireMetoo($('sdBody'));
    wireReveal($('sdBody'));
    /* Long stories are clamped in CSS, so the whole text is always in the DOM
       and a find-on-page still hits it (REB-443). One-way on purpose: someone
       who asked for the rest is not then asked to fold it away again. */
    $('sdBody').querySelector('[data-readmore]')?.addEventListener('click', ev => {
      $('sdBody').querySelector('#sdStoryText')?.classList.remove('sd-clamp');
      ev.currentTarget.setAttribute('aria-expanded', 'true');
      ev.currentTarget.remove();
    });
    $('sdBody').querySelectorAll('[data-lightbox]').forEach(el =>
      el.addEventListener('click', e => { e.stopPropagation(); openLightbox(el.dataset.lightbox); }));
    // The category and storm tags moved out of the header and into the body,
    // so their filter wiring follows them. Reading one story is still the way
    // to find every other like it.
    $('sdBody').querySelectorAll('[data-filtercat]').forEach(el =>
      el.addEventListener('click', () => setCat(el.dataset.filtercat)));
    $('sdBody').querySelectorAll('[data-filterevent]').forEach(el =>
      el.addEventListener('click', () => setEvent(el.dataset.filterevent)));
    $('sdBody').querySelectorAll('.sd-near-item[data-story]').forEach(el => {
      el.addEventListener('click', () => onStoryOpen?.(el.dataset.story));
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStoryOpen?.(el.dataset.story); }
      });
    });
    const an = $('sdBody').querySelector('.sd-addnear');
    if (an) an.addEventListener('click', () => onAddNear?.(parseFloat(an.dataset.lat), parseFloat(an.dataset.lng)));
    $('sdBody').querySelector('[data-copylink]')?.addEventListener('click', ev => copyStoryLink(ev.currentTarget));
    $('sideDetail').classList.add('open');
    $('sdBody').scrollTop = 0;
    renderStoryNav();
    syncFab();
    writeUrl();
  }
  // A partner report (MyCoast NY) in the story panel: no reactions, nearby or nav.
  function openPartner(layer, props) {
    closeStoryCard();
    $('side').classList.add('open');
    openId = null;
    const { headStyle, headHtml, bodyHtml } = partnerDetail(layer, props);
    $('sdHead').style.cssText = headStyle;
    $('sdHead').innerHTML = headHtml;
    $('sdBody').innerHTML = bodyHtml;
    $('sdBody').querySelectorAll('[data-lightbox]').forEach(el =>
      el.addEventListener('click', e => { e.stopPropagation(); openLightbox(el.dataset.lightbox); }));
    $('sideDetail').classList.add('open');
    $('sdBody').scrollTop = 0;
    renderStoryNav();
    syncFab();
  }
  function closeStory() {
    closeStoryCard();
    $('sideDetail').classList.remove('open');
    $('sdBody').innerHTML = '';
    openId = null;
    syncFab();
    writeUrl();
    onStoryClose?.();   // drops the radius focus; every close path routes here
  }

  /* Re-paint the layers panel from the map's own on/off state. The radius
     focus switches the city layers on for as long as a story is open, so the
     panel has to follow it or the checkmarks lie about what's drawn. */
  /* Which overlays are on, mirrored here so the map key can be drawn without
     reaching into the map module. Kept in step from three places: the initial
     render, a click in the panel, and syncLayerPanel (which is how opening a
     story reports the layers it forced on). */
  const overlayOn = {};

  /* The key for the layer currently on, drawn bottom-right over the map.

     A stepped layer needs its ramp spelled out, because its palest steps sit
     below 3:1 against the basemap. That is deliberate — a block that reported
     once should recede — but it means colour can never be the only carrier of
     the message, so every step keeps a written label and the hover gives the
     real number.

     This used to render inside every row of the Map Layers panel. With three
     stepped layers that is fifteen swatch rows at once, most of them describing
     layers that are switched off. The key belongs where the colours are, and
     only for what is actually drawn. */
  /* The colour scale, inline under the layer it belongs to.

     Judy, 10 August: "move the key into the map layers and keep the colour
     coded colour scale". This replaces the floating key that used to sit
     bottom-right — two panels of chrome explaining one list became one.

     It also dissolves the problem REB-449 spent a commit fighting. A separate
     key had to be positioned against the panel, capped so it did not bury it,
     and made scrollable without swallowing map clicks; a scale that lives in
     the row it describes has none of those questions. The panel scrolls if it
     must, like any list.

     Stepped layers only: a graded scale is the thing that genuinely cannot be
     read without a key, where a flat single colour is carried by the row's own
     swatch. All active ones, not the first (REB-434) — the three 311 layers
     blend, and showing one scale for three sets of dots would explain a third
     of the map and misattribute the rest. */

  /* Overlay meta, keyed by layer id, published by map.js when a layer loads.
     A categorical key needs a count per category, and typing those into config
     is how the persistent-blocks caption went stale one rebuild after it was
     written. */
  const overlayMeta = {};
  function setOverlayMeta(id, meta) { overlayMeta[id] = meta; layerScales(); }

  function layerScales() {
    const layers = tenant.overlays?.layers || [];
    const on = layers.filter(x => !x.panelHidden && overlayOn[x.id] && x.steps?.stops?.length);

    document.querySelectorAll('#layerItems .l-item').forEach(el => {
      const box = el.querySelector('.l-scale');
      if (!box) return;
      const l = layers.find(x => x.id === el.dataset.overlay);
      const show = l && on.includes(l);
      if (!show) { box.hidden = true; box.innerHTML = ''; return; }
      const stops = l.steps.stops;
      /* A CATEGORICAL key is drawn as separate rows, never as a joined strip.
         The strip means "one thing, more of it to the right", which is true of
         the 311 density layers and false of DEP, where the two colours are
         different KINDS: built, and not built yet. Judy, 14 August: it read as
         a bar chart. Rows with their own swatch and their own count cannot.

         Order is reversed on purpose. The ramp needs ascending stops or the
         Mapbox `step` expression breaks, but the key reads better with the
         uncertain thing first and the finished thing last. */
      if (l.steps.categorical) {
        const meta = overlayMeta[l.id] || {};
        const seq = l.steps.legendReverse ? [...stops].reverse() : stops;
        box.innerHTML = `<div class="l-cats">${seq.map(st => {
          const n = st.countFrom != null ? meta[st.countFrom] : null;
          const num = Number.isFinite(+n) ? ` (${(+n).toLocaleString()})` : '';
          return `<div class="l-cat"><span class="l-cat-dot" style="background:${esc(st.color)}"></span>`
            + `<span class="l-cat-label">${esc(String(st.label ?? st.at))}${num}</span></div>`;
        }).join('')}</div>`;
        box.hidden = false;
        return;
      }
      /* Every break point stays a visible colour and the two ends are named.
         The exact counts are a hover away on the blocks themselves, which is
         what keeps this to two lines instead of one row per stop — three
         layers at five stops each would be fifteen rows in a 248px panel. */
      box.innerHTML =
        `<div class="l-scale-strip">${stops.map(s =>
          `<span class="l-seg" style="background:${esc(s.color)}" title="${esc(String(s.label ?? s.at))}"></span>`).join('')}</div>`
        + `<div class="l-scale-ends"><span>${esc(String(stops[0]?.label ?? ''))}</span>`
        + `<span>${esc(String(stops[stops.length - 1]?.label ?? ''))}</span></div>`;
      box.hidden = false;
    });

    /* The caveats at the foot of the panel, once each, deduped because the three
       311 layers used to carry the same sentence.

       JUDY REMOVED THE CAVEAT COPY ON 17 AUGUST: "no need for caveats." The
       mixed-colour line that used to be pushed in here unconditionally is gone with
       it, and so are the `keyFoot` values on the three 311 layers and on the DEP
       assets. The mechanism stays, and a layer that sets `keyFoot` still prints it,
       because a future caveat should not need this rebuilt — but nothing sets one
       on a visible layer now, so the block renders hidden. Do not reintroduce a
       sentence here without asking her. */
    const notes = $('layerNotes');
    if (notes) {
      const lines = [...new Set(on.map(l => l.keyFoot).filter(Boolean))];
      notes.innerHTML = lines.map(f => `<div class="l-note">${esc(f)}</div>`).join('');
      notes.hidden = !lines.length;
    }
  }

  function syncLayerBadges() {
    document.querySelectorAll('#layerItems .l-item').forEach(el => {
      const badge = el.querySelector('.l-badge');
      if (!badge) return;
      badge.hidden = !(overlayOn[el.dataset.overlay] && badge.classList.contains('l-badge-num'));
    });
  }

  function syncLayerPanel(state) {
    if (!state) return;
    /* `[data-overlay]`, not `.l-item`: the boundary layers render as pills and the
       map can turn a layer on without the panel being clicked — opening a story
       switches layers on, and `focusRadius` touches them too. Matching only rows
       would leave a pill lit while its layer was off, or dark while it drew. */
    document.querySelectorAll('#layerItems [data-overlay]').forEach(el => {
      const id = el.dataset.overlay;
      if (id in state) {
        el.classList.toggle('on', !!state[id]);
        if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', String(!!state[id]));
      }
    });
    Object.assign(overlayOn, state);
    layerScales();
    syncLayerBadges();
  }

  function setSideView(view) {
    sideView = view;
    $('feed').style.display = view === 'list' ? 'block' : 'none';
    $('gallery').style.display = view === 'gallery' ? 'grid' : 'none';
    document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('on', b.dataset.view === view));
    paintCount();
  }

  /* Clear every facet without touching the open story. A permalink that lands
     on a story hidden by an inherited filter has to choose between showing the
     story and honouring the filter; the story wins, because that is what the
     link was for. Used only by the ?story= path in app.js. */
  function clearAllFilters() {
    searchText = ''; activeTypes = []; selCats = []; selEvents = []; selYears = []; selHoods = [];
    openFacets.clear();
    const si = $('searchIn'); if (si) si.value = '';
    onNeighborhood?.('all');
    renderStories(stories); onFilterChange?.(); writeUrl();
  }

  return {
    renderChrome, renderStories, setCityTotal, setOverlayMeta, openStory, openPartner, closeStory, openPlace, closePlace, setSideView, setReactions, syncLayerPanel,
    syncLayerBadges,
    clearAllFilters,
    get openStoryId() { return openId; },
    get activeFilter() { return activeTypes.slice(); },
    get filteredStories() { return filtered(); },
    get activeHoods() { return selHoods.slice(); },
  };
}
