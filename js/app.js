/* Public app bootstrap: config → theme → map → data → UI.

   One page, two operating modes, selected by URL — never by engine forks:
     (default)          the public map: explore stories, submit via the CTA
     ?mode=kiosk        attended event mode: attract screen, full-screen intake,
                        idle-timeout wipe, nothing persists between participants
   The questions asked are identical in every mode (they come from the tenant
   config); only the chrome and pacing change.

   18 August: `?mode=share` and the conversational chat intake it drove
   (js/intake-chat.js) are gone, at Judy's ask — everyone now submits through
   the same stepped form this file already used for map and kiosk mode. */
import { loadConfig, applyTheme, promptPack, roleField, storyBrandColor } from './config.js';
import { dropMark, isExample } from './ui/render.js';
import { createApi } from './data.js';
import { createMapController } from './map.js';
import { createForm } from './form.js';
import { esc } from './ui.js';
import { icon } from './ui/icons.js';
import { cityData } from './citydata.js';
import { renderFindings } from './findings.js';
import { longDate, monthYear } from './dates.js';

const $ = id => document.getElementById(id);

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') === 'kiosk' ? 'kiosk' : 'map';
const PREVIEW = params.has('preview');   // ?preview → inject local demo stories (never persisted)

async function main() {
  const { platform, tenant } = await loadConfig();
  applyTheme(tenant);
  document.body.dataset.mode = MODE;

  const api = createApi(platform, tenant);
  let stories = [];
  let pinMode = false;
  let reactionsEnabled = false;   // set true once the story_reactions backend answers
  // Live city record (NYC Open Data). Null when the tenant hasn't configured
  // one; shares its request cache with the per-story block in the side pane.
  const city = cityData(tenant.cityData);

  // The layout module owns the page's chrome and arrangement; app.js owns
  // config, data, the map controller, submission, and the operating modes.
  // `layout` is validated at build time — an unknown value never ships.
  // Imported before the map controller so a layout that demotes the map
  // (deferMap) can keep the basemap from loading until it's asked for.
  const layoutName = tenant.layout || 'atlas';
  const layoutModule = await import(`./layouts/${layoutName}.js`);
  const { mount, strings: layoutStrings = {}, deferMap = false } = layoutModule;

  const mapCtl = createMapController(tenant, {
    onPartnerClick: (layer, props) => ui.openPartner?.(layer, props),
    // Live overlays (311, green infra) fetch on first toggle — reflect that on
    // the Data Layers panel item so the toggle doesn't feel unresponsive.
    onOverlayLoading: (id, isLoading, count, meta) => {
      if (meta) ui.setOverlayMeta?.(id, meta);
      const el = document.querySelector(`[data-overlay="${id}"]`);
      if (!el) return;
      el.classList.toggle('loading', isLoading);
      /* Once loaded the badge slot holds the real total, so a colour scale has
         a magnitude attached to it.

         The number is written here but NOT shown here: whether it is visible
         follows the layer's on/off state, which `ui.syncLayerBadges` owns
         (Judy, 10 August — a count belongs to a layer you have switched on).
         Writing and showing used to be the same step, which is how FloodNet
         came to display 479 while switched off: it is a static overlay, so it
         reports its count the moment the page loads rather than on first
         toggle. The lazy layers had the mirror-image bug — once loaded, their
         count stayed up after the layer was switched off again. */
      if (!isLoading && typeof count === 'number') {
        const badge = el.querySelector('.l-badge');
        if (badge) {
          badge.textContent = count.toLocaleString();
          badge.classList.add('l-badge-num');
        }
        ui.syncLayerBadges?.();
      }
    },
    onStoryClick: id => {
      if (pinMode) return;
      if (MODE === 'kiosk') return; // kiosk is single-purpose: the map is a pin canvas
      // A layout may claim dot clicks (Story scrolls to the card in the page
      // instead of popping the detail); default remains open-the-story.
      if (ui.onMapStoryClick) { ui.onMapStoryClick(id); return; }
      const s = stories.find(x => x.id === id);
      if (s) openStory(s);
    },
    onMapClick: (lat, lng) => {
      if (pinMode) {                 // the intake asked for a pin
        pinMode = false;
        mapCtl.dropPin(lat, lng);
        form.setPinLocation(lat, lng);
        return;
      }
      if (MODE === 'kiosk') return;  // kiosk is single-purpose
      /* Tapping the map opens the city's record for that half mile (REB-442),
         and "Add your story here" is the call to action inside it.

         This replaces the old "Add your story here?" confirm bubble. Judy's
         reasoning: a resident used to get nothing back until they had already
         submitted something, so there was nothing to react to. Now the block's
         own picture comes first and the reaction is what prompts the story.

         The confirm is gone but its coordinate handling is not: the CTA routes
         through onAddNear, which calls form.open({lat, lng}) — the pin goes
         THROUGH open() rather than being set before it, because open() resets
         the form and would throw it away (REB-437, 24dee3e). */
      ui.openPlace(lat, lng);
    },
  }, { defer: deferMap });

  const form = createForm(tenant, {
    api,
    platform,
    mode: MODE,
    source: { mode: MODE },
    // Stepped-form order: tenant config wins, else the layout's default
    // (Gallery leads with media).
    stepOrder: tenant.form?.stepOrder || layoutModule.stepOrder,
    // Layouts where the map isn't full-bleed need to bring it into view
    // before a tap can land on it — hence the optional view hook.
    onRequestPin: () => { pinMode = true; ui.onPinRequest?.(); },
    /* 18 August. The address search inside the location step used to update
       `pendingLat/pendingLng` with no visible confirmation on the map itself
       — Judy: "how can people check if its the accurate pin?" Every other way
       of setting a location (map tap, sidepane search, "Add your story here")
       already drops the same marker; this closes the one gap where it didn't. */
    onLocationPicked: (lat, lng) => { mapCtl.dropPin(lat, lng); mapCtl.flyTo(lat, lng); },
    onSubmit: payload => api.submitStory(payload),
    onDone: () => {
      if (MODE === 'kiosk') { kiosk?.reset(); return; }
      const { lat, lng } = form.pending;
      if (lat != null) mapCtl.flyTo(lat, lng);
      mapCtl.clearPin();
    },
    onClose: () => {
      pinMode = false;
      mapCtl.clearPin();
      if (MODE === 'kiosk') kiosk?.toAttract();
    },
  });

  /* ?story=<uuid> opens that story on load (REB-428).

     Two things bite here and both are handled rather than left to luck.

     A shared link can outlive the story: it can be unpublished or rejected
     after the link went out, and then the id is simply not in the feed. That
     shows a plain note instead of an empty map with no explanation.

     A link can also carry filters that hide its own story — ?hood=X&story=Y
     where Y is not in X, or a filter left over from however the link was
     built. The story wins and the filters are cleared, because showing the
     thing the link points at is the whole purpose of the link. Leaving them on
     produced an open story with a blank, disabled prev/next stepper. */
  function openPermalink() {
    const id = new URLSearchParams(location.search).get('story');
    if (!id) return;
    const s = stories.find(x => x.id === id);
    if (!s) { showGoneNote(); dropParam('story'); return; }
    if (!ui.filteredStories.some(x => x.id === id)) ui.clearAllFilters();
    /* The pane opens straight away; the map framing waits for tiles. A click on
       a card never has to wait like this, but a permalink arrives before the
       basemap is up and focusRadius needs live sources to clip against. */
    ui.openStory(s);
    if (s.lat != null && s.lng != null) {
      mapCtl.ready.then(() => {
        /* Fit the half mile rather than fly to a fixed zoom (7 Aug). 13.4
           framed about four miles around a circle one mile across, so the
           subject of the pane arrived as a dot.

           The camera moves FIRST and does not wait on focusRadius, which
           fetches 311 from Socrata on first use. Framing behind that await
           meant a slow or failed fetch left the map wherever it was. */
        mapCtl.fitRadius(s.lat, s.lng);
        mapCtl.focusRadius(s.lat, s.lng).then(() => ui.syncLayerPanel?.(mapCtl.overlayState));
      });
    }
  }
  function dropParam(k) {
    const p = new URLSearchParams(location.search);
    p.delete(k);
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }
  function showGoneNote() {
    const n = document.createElement('div');
    n.className = 'welcome-hint gone-note';
    n.innerHTML = `<span>That story is no longer public. It may have been taken down by its author or by a moderator.</span><button aria-label="Dismiss">✕</button>`;
    document.body.appendChild(n);
    const bye = () => { n.classList.add('bye'); setTimeout(() => n.remove(), 400); };
    n.querySelector('button').addEventListener('click', bye);
    setTimeout(() => n.classList.add('show'), 500);
    setTimeout(bye, 12_000);
  }

  /* Opening a story also frames the half mile the pane is counting over:
     the radius is drawn and the live city layers are clipped to it, so the
     numbers in the pane and the marks on the map are visibly one thing.
     The camera fits the ring's own bounds (7 Aug), so the half mile fills the
     space left of the side pane instead of sitting in it as a dot. */
  function openStory(s) {
    ui.openStory(s);
    if (s.lat != null && s.lng != null) {
      mapCtl.fitRadius(s.lat, s.lng);
      mapCtl.focusRadius(s.lat, s.lng).then(() => ui.syncLayerPanel?.(mapCtl.overlayState));
    }
  }
  function closeStoryFocus() {
    mapCtl.clearRadius();
    mapCtl.focusStory(null);   // undo any dimming from "see where this is"
    ui.syncLayerPanel?.(mapCtl.overlayState);
  }

  // Impact summary: the "so what" of the collection, computed from the loaded
  // stories. Ties the map back to why a single story matters.
  function renderImpact() {
    const typeField = roleField(tenant, 'color');
    const n = stories.length;
    const hoods = new Set(stories.map(s => s.location_label).filter(Boolean)).size;
    const exampleCount = stories.filter(s => isExample(tenant, s)).length;
    const countBy = f => (f?.options || []).map(o => ({ o, c: stories.filter(s => s.answers?.[f.id] === o.id).length }));
    const types = countBy(typeField);
    // Engagement *within* stories: total "me too" echoes and the most-echoed one.
    const echoes = stories.reduce((a, s) => a + (s.me_too || 0), 0);
    const mostEchoed = stories.filter(s => (s.me_too || 0) > 0).sort((a, b) => b.me_too - a.me_too)[0];
    const maxT = Math.max(1, ...types.map(x => x.c));
    /* One colour for every bar (REB-463). This was the story type's own hue on
       both the mark and the fill — four bars in four colours, which is the
       scheme the map retired and the last place on this layout still using it.
       The glyph in the raindrop and the label say which type each row is; the
       bar's job is length, not identity. */
    const bar = (mark, label, c, max) =>
      `<div class="imp-bar"><div class="imp-bar-lbl">${mark}<span>${esc(label)}</span></div>`
      + `<div class="imp-bar-track"><div class="imp-bar-fill" style="width:${Math.round(c / max * 100)}%"></div></div>`
      + `<div class="imp-bar-n">${c}</div></div>`;
    $('impactBody').innerHTML =
      `<div class="imp-eyebrow">Why your story matters</div>`
      + `<h2 class="imp-h">${n} ${n === 1 ? 'story' : 'stories'}, mapping how New York floods</h2>`
      + `<p class="imp-lead">Every raindrop on this map is a New Yorker's lived experience of flooding. Together they build the case for a rainproof city: where it hits first and hardest, where projects that soak up rain would help most, and what the city's aging sewers can no longer hold. Your story is evidence.</p>`
      /* Two KPIs, not four. "Voices & videos" and "photos" are inventory counts
         of the collection rather than evidence about flooding, and at pilot
         scale they shrink the page's authority instead of building it (2 videos,
         6 photos). Cut per REB-351. */
      + `<div class="imp-kpis imp-kpis-2">`
      + `<div class="imp-kpi"><div class="imp-n">${n}</div><div class="imp-l">stories shared</div></div>`
      + `<div class="imp-kpi"><div class="imp-n">${hoods}</div><div class="imp-l">neighborhoods</div></div>`
      + `</div>`
      // Says plainly that the pins are illustrative while the city data is not.
      + (exampleCount > 0 && tenant.examples?.impactNote
        ? `<p class="imp-exnote">${esc(tenant.examples.impactNote)}</p>` : '')
      + (reactionsEnabled && echoes > 0
        ? `<div class="imp-echo">
            <div class="imp-echo-top"><span class="imp-echo-n">+${echoes}</span>`
            + `<span class="imp-echo-l">“this happened to me too” ${echoes === 1 ? 'response' : 'responses'}</span></div>`
          + `<p class="imp-echo-p">Beyond the ${n} written ${n === 1 ? 'story' : 'stories'}, New Yorkers tapped `
            + `<b>Me too</b> ${echoes} ${echoes === 1 ? 'time' : 'times'}, each tap another household saying the same `
            + `block floods. Quiet corroboration is evidence too.`
            + (mostEchoed && mostEchoed.location_label
              ? ` The most-echoed story is from <b>${esc(mostEchoed.location_label.split(',')[0])}</b>.`
              : '')
          + `</p></div>`
        : '')
      /* The city's record moves ABOVE the story breakdown. It is the strongest
         evidence on the page and it used to sit in eighth position, under two
         charts plotting a 3 against a 1. The "what the stories are about"
         category bars are gone entirely: they duplicate the chips already in the
         explore bar and say nothing at this scale. Both per REB-351. */
      + `<div id="impCity"></div>`
      /* The persistence finding, read live from the weekly rebuild rather than
         typed in (REB-430), and the doorway to the full analysis in REB-431's
         modal. Deliberately a sibling of #impCity rather than a child: that
         block waits on three Socrata calls and can fail, and this reads a
         static file that ships with the map. The strongest sentence on the
         page should not be hostage to a third party being up. */
      + `<div id="impPersist"></div>`
      + `<div class="imp-sec-t">What New Yorkers are sharing</div>`
      + types.map(x => bar(dropMark(storyBrandColor(tenant), 18, x.o.icon), x.o.label, x.c, maxT)).join('')
      + `<div class="imp-sowhat"><div class="imp-sowhat-t">The so-what</div>`
      + `<p>These stories go to Rebuild by Design and its partners to prioritize the neighborhoods that flood first, argue for the projects that soak up rain where it counts, and keep the case for a rainproof city grounded in what New Yorkers actually live through. Nothing about you travels beyond what you chose to share.</p></div>`
      + `<button class="imp-cta" id="impShare">Share your story</button>`;
    $('impShare')?.addEventListener('click', () => { closeImpact(); form.open(); });
    renderImpactCity();
    renderImpactPersistence();
  }

  /* The city's own record, citywide — the counterpart to the per-story block
     in the side pane. Two live totals plus the tie-in that makes the whole
     Stage-3 argument in one sentence: how many of these stories sit somewhere
     the city has heard from repeatedly and still not built for.

     Async and non-blocking: the Impact panel opens instantly with everything
     computed from the stories, and this section appears when NYC Open Data
     answers (or never, silently, if it doesn't). */
  async function renderImpactCity() {
    if (!city) return;
    const el = $('impCity');
    if (!el) return;
    const cfg = tenant.cityData || {};
    /* The gap tie-in is a real half-mile spatial join, so it must not be run
       against illustrative pins: "4 of 11 stories sit somewhere the city has
       heard from repeatedly" is a fabricated finding if the 11 stories are
       demo content, and it would sit directly beneath two genuine city numbers.
       Once even one real story is on the map the sentence returns, counting
       only the real ones. */
    const real = stories.filter(s => !isExample(tenant, s));
    const pts = real.filter(s => s.lat != null && s.lng != null);
    const [totals, scan] = await Promise.all([
      city.cityTotals(),
      pts.length ? city.gapScan(pts) : Promise.resolve(null),
    ]);
    if (!totals || $('impCity') !== el) return;   // failed, or the panel re-rendered
    const since = cfg.sinceLabel ? ` since ${cfg.sinceLabel}` : '';
    const rad = cfg.radiusLabel || 'half mile';
    const greenNoun = n => {
      const nn = cfg.green?.noun || ['thing built to soak up rain', 'things built to soak up rain'];
      return n === 1 ? nn[0] : nn[1];
    };
    el.innerHTML =
      `<div class="imp-sec-t">What New Yorkers told 311</div>`
      + `<div class="imp-kpis imp-kpis-2">`
      + `<div class="imp-kpi"><div class="imp-n">${totals.reports.toLocaleString()}</div>`
      + `<div class="imp-l">flooding reports to 311 across the city${esc(since)}</div></div>`
      /* The green-infrastructure figure here is deliberately the "since Ida"
         cut, not the all-time total the story pane shows: this panel is about
         the five years, so comparing them against 20 years of construction
         would flatter the record. The all-time number rides along underneath as
         context, which is also what stops the smaller figure reading as a
         claim that the city has built almost nothing. */
      + `<div class="imp-kpi"><div class="imp-n">${(totals.greenSince ?? totals.green).toLocaleString()}</div>`
      /* "assets", not "projects" (REB-423): one row is one thing built, and
         the 13,955 of them belong to 492 projects, so the project noun
         oversold this number by about 28x.

         The noun comes from `cityData.green.noun`, the same string the story
         pane uses (REB-452). It was typed here, so when the label was found to
         describe only 94% of the layer there were two places to correct and
         only one of them was obvious. A noun that names a dataset belongs to
         the dataset's config, once. */
      + `<div class="imp-l">${esc(greenNoun(totals.greenSince ?? totals.green))} built${esc(since)}`
      + (totals.greenSince != null && totals.green > totals.greenSince
          ? `<span class="imp-sub">of ${totals.green.toLocaleString()} the city has ever built</span>` : '')
      + `</div></div>`
      + `</div>`
      + (scan?.gap > 0
        /* This said "a block the city has heard from four or five years
           running", and a comment above it claimed that named the actual test.
           It does not. `gapScan` calls `isGap(reports, green)`, which is a
           volume-and-provision test — at least `gap.minReports` reports within
           the radius, and either nothing built or a reports-to-assets ratio
           past `gap.ratio`. Years never enter into it; that is the city-record
           modal's separate persistence reading.

           Fixed rather than reworded: a sentence describing a test the code
           does not run is the same defect as a stale number, and this one was
           being read as a finding. (REB-461.) */
        ? `<p class="imp-city-note"><b>${scan.gap} of ${scan.checked}</b> ${scan.checked === 1 ? 'story on this map sits' : 'stories on this map sit'} `
          + `on a block New Yorkers report flooding on a lot, with almost nothing built within a `
          + `${esc(rad)} to soak up the rain.</p>`
        : `<p class="imp-city-note">Open any story to see what New Yorkers reported near that block.</p>`);
  }

  async function renderImpactPersistence() {
    const el = $('impPersist');
    if (!el) return;
    let m;
    try { m = await loadCityFacts(); } catch { return; }   // silent: it is an extra, not the point
    if ($('impPersist') !== el) return;
    const d = Object.fromEntries((m.distribution || []).map(x => [x.years, x]));
    // The top two buckets, whatever they are numbered (REB-461). See the note
    // in renderCityModal: the year count grows every September and must be read.
    const yrs = m.idaYears || (m.distribution || []).length || 5;
    const cells = (d[yrs - 1]?.blocks || 0) + (d[yrs]?.blocks || 0);
    const share = Math.round((d[yrs - 1]?.shareOfReports || 0) + (d[yrs]?.shareOfReports || 0));
    if (!cells) return;
    el.innerHTML =
      `<button type="button" class="imp-more" data-open-city>`
      + `<span class="imp-more-n">${cells.toLocaleString()}</span>`
      + `<span class="imp-more-t"><b>blocks have flooded in ${yrs - 1} or ${yrs} of the ${yrs} years since Ida</b>`
      + `They carry ${share}% of every flooding report in the city. See the whole record →</span></button>`;
    el.querySelector('[data-open-city]')?.addEventListener('click', () => { closeImpact(); openCity(); });
  }
  function openImpact() { renderImpact(); $('impactOverlay').classList.add('open'); }
  function closeImpact() { $('impactOverlay').classList.remove('open'); }

  // About: what the map is and how the stories are used. Content is tenant
  // config (tenant.about); the nav "About" opens it without leaving the map.
  /* REB-484. About reads as a NARRATIVE, in this order, and the order is the
     design rather than an accident of what got added when:

       Ida                       why this map exists and why now
       How it works              what a resident actually does
       What your story does      what it is for, without promising an outcome
       Share only what you want  how it is kept safe
       -> Share your story       the ask, immediately after the safety answer
       Everyone has a role       for a reader who is not here to write
       the two bios              who "we" is
       credits                   Judy and the partners, quietly, last
       How this map works        the door to the data

     Judy's note was that the Share button "seems random". It was: it sat
     mid-panel between the copy and the credits, asking before the reader had
     been told what happens to what they write. It closes the story now. */
  /* REB-484/485. About reads as a narrative, in this order, and the order is
     the design rather than an accident of what got added when:

       Five years after Ida        why this map exists, and why now
       How it works                what a resident actually does
       What your story does        what it is for, without promising an outcome
       Share only what you want to how it is kept safe
       -> Share your story         the ask
       About Rainproof NYC         who "we" is
       Thank you                   Judy and the six partners
       Everyone has a role to play resources, last

     Two placements are load-bearing and were both Judy's calls. The ask sits
     immediately after the safety answer, because asking somebody to write
     before telling them what happens to what they write is what made it "seem
     random" mid-panel. And the resources card is LAST: it is the door for a
     reader who is not here to write, so it should not interrupt the ones who
     are.

     "How this map works" is gone from here — the dictionary has its own item
     in the header nav (REB-479) and a second door halfway down About was one
     more thing between the reader and the map. */
  function renderAbout() {
    const a = tenant.about || {};
    const org = tenant.org || {};
    /* A section is a heading plus prose. `p` splits on a blank line so approved
       copy keeps its paragraphing, and `list` carries the labelled runs the
       director's text is written as. Config stays plain text; esc() still runs
       on every field, so nothing here can inject markup. */
    const paras = t => String(t || '').split(/\n\s*\n/).filter(Boolean)
      .map(t2 => `<p class="ab-p">${esc(t2.trim())}</p>`).join('');
    const list = items => !items?.length ? '' : `<ul class="ab-list">${items.map(i =>
      (typeof i === 'string'
        ? `<li>${esc(i)}</li>`
        : `<li><b>${esc(i.label)}</b>${esc(i.text || '')}</li>`)).join('')}</ul>`;
    const linkOut = l => !l?.url ? '' :
      `<p class="ab-p">${esc(l.before || '')}<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label || l.url)}</a>${esc(l.after || '')}</p>`;
    const sec = x => `<div class="ab-sec-t">${esc(x.h)}</div>`
      + paras(x.p) + list(x.list) + paras(x.p2) + list(x.list2) + linkOut(x.link);
    /* Link one named organisation inside a run of copy. Only `org.url` reaches
       an href and the name is escaped, so copy can never inject markup.
       Rebuild by Design is a link in exactly one place now that its bio has
       gone: the credit line. */
    const withLink = (text, name) => {
      const body = esc(text);
      return name && org.url
        ? body.replace(esc(name), `<a href="${esc(org.url)}" target="_blank" rel="noopener">${esc(name)}</a>`)
        : body;
    };
    const c = a.credits;
    $('aboutBody').innerHTML =
      `<div class="ab-eyebrow">About</div>`
      + `<h2 class="ab-h">${esc(a.title || `About ${tenant.name}`)}</h2>`
      + (a.lead ? `<p class="ab-lead">${esc(a.lead)}</p>` : '')
      + (a.sections || []).map(sec).join('')
      + `<div class="ab-cta-row"><button class="ab-cta" id="aboutShare">${icon('chat')} ${esc(tenant.cta.share)}</button></div>`
      /* The thank-you is a section like any other, not a footer in small grey
         type — Judy's ask, and right: it names the people who did the work.
         It sits ABOVE the org bio, which is the order the approved text uses. */
      + (c
        ? (c.h ? `<div class="ab-sec-t">${esc(c.h)}</div>` : '')
          + (c.line ? `<p class="ab-p">${withLink(c.line, c.linkName)}</p>` : '')
          + ((c.partners || []).length
            ? `<p class="ab-p">${esc(c.partnerLead || 'With')} `
              + (c.partners).map(x => x.url
                  ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a>`
                  : esc(x.name)).join(', ')
              + `.</p>`
            : '')
          + (c.dataLine
            ? `<p class="ab-p">${esc(c.dataLine)} <a href="#" id="aboutMethod">${esc(c.dataLinkLabel || 'Methodology')}</a></p>`
            : '')
        : '')
      + ((a.orgs?.items || []).length ? `<div class="ab-tail">${(a.orgs.items).map(sec).join('')}</div>` : '')
      + (a.resource?.url
        ? `<a class="ab-more" href="${esc(a.resource.url)}" target="_blank" rel="noopener">${icon('hand')}`
          + `<span><b>${esc(a.resource.label || 'Everyone has a role to play')}</b>`
          + `${esc(a.resource.hint || '')}</span><span class="ab-more-x">↗</span></a>`
        : '');
    $('aboutShare')?.addEventListener('click', () => { closeAbout(); form.open(); });
    // Same destination as the header's Methodology button, so the word means
    // one thing in both places.
    $('aboutMethod')?.addEventListener('click', e => { e.preventDefault(); closeAbout(); openDict(); });
  }
  function openAbout() { renderAbout(); $('aboutOverlay').classList.add('open'); }
  function closeAbout() { $('aboutOverlay').classList.remove('open'); }

  /* ── How this map works (REB-431) ──
     The methodology, in plain language, answering the question Judy actually
     asked: "is it being pulled live from an API? Not sure how it's wired in so
     that needs clarity for the public." The honest answer is more interesting
     than a yes or no, so it leads with it. */
  /* REB-450. Sources first, then what we did to the numbers, then the date, then
     the caveats. Judy's brief: high level, concise, data-objective — "data
     sources, analysis, last date pulled", and nothing about how the app works.

     What came out: two whole sections arguing about what "live" means and how
     the data reaches the page. A reader does not need our architecture, and
     "Pulled 10 August 2026" answers the only question those sections were
     circling. The body prose went from 2,759 characters to 615.

     Order is explicit rather than emergent. `currencyAfter` names the section
     the computed date block follows, so the date sits between the method and
     the caveats where it was approved, instead of wherever the sections array
     happens to end. */
  function renderMethod() {
    const m = tenant.method || {};
    const sections = m.sections || [];
    const section = s => `<div class="ab-sec-t">${esc(s.h)}</div><p class="ab-p">${esc(s.p)}</p>`;
    const cut = m.currencyAfter ? sections.findIndex(s => s.h === m.currencyAfter) : -1;
    // Not found, or not configured: the date block goes last rather than vanishing.
    const head = cut >= 0 ? sections.slice(0, cut + 1) : sections;
    const tail = cut >= 0 ? sections.slice(cut + 1) : [];
    $('methodBody').innerHTML =
      `<div class="ab-eyebrow">Methodology</div>`
      + `<h2 class="ab-h">${esc(m.title || 'How this map works')}</h2>`
      + (m.lead ? `<p class="ab-lead">${esc(m.lead)}</p>` : '')
      + (m.sources?.length
        ? `<div class="ab-sec-t">${esc(m.sourcesHeading || 'Where the data comes from')}</div>`
          + `<div class="src-list">` + m.sources.map(s =>
            `<div class="src-row"><div class="src-h">${esc(s.h)}</div><div class="src-p">${esc(s.p)}</div></div>`).join('')
          + `</div>`
        : '')
      + head.map(section).join('')
      /* REB-416. Filled in after the summary lands, which is why it is a
         placeholder rather than part of the string above: the panel opens
         instantly and this section arrives a beat later, the same bargain the
         city modal already makes. It renders nothing at all if the fetch
         fails — a currency claim that cannot be substantiated should be absent,
         not guessed. */
      + `<div id="methodCurrency"></div>`
      + tail.map(section).join('')
      + `<div class="ab-cta-row"><button class="ab-cta" id="methodCity">${icon('list')} What New Yorkers told 311</button></div>`
      /* REB-453. The second reader gets a second door, not a longer panel.
         A resident wants "where is this from and how old is it", which is what
         everything above answers in 615 characters. A city official or a CBO
         reproducing a figure wants the dataset id and the exact filter, which
         is a page of tables. Growing this panel to serve both would undo
         REB-450 and still serve neither well.

         Drawn as `.ab-more`, the same outlined door About uses to reach this
         panel, rather than a second gradient pill: a pill is a call to action
         and this is a way through to something denser. Same shape, same rung
         down, one pattern for "there is more behind this". */
      + (m.dictionary
        ? `<button class="ab-more" id="methodDict">${icon('list')}<span>`
          + `<b>${esc(m.dictionary.linkLabel || 'Full data dictionary')}</b>`
          + `${esc(m.dictionary.linkHint || '')}</span>`
          + `<span class="ab-more-x">→</span></button>`
        : '');
    $('methodCity')?.addEventListener('click', () => { closeMethod(); openCity(); });
    $('methodDict')?.addEventListener('click', () => { closeMethod(); openDict(); });
    renderCurrency();
  }

  /* ── The data dictionary (REB-453) ─────────────────────────────
     Judy: "methodology is like the data dictionary for this map, it's really
     important if people were to replicate this on their own." The acceptance
     test is literal — someone who has never seen this project should be able to
     read this, go to NYC Open Data, and reproduce any headline figure.

     Everything that can drift is read rather than written. Dataset ids come off
     the endpoints in config, the filters come from `city.filters()` (the actual
     closures that build the requests, not a second copy of them), and every
     count, window and build date comes out of the overlay meta blocks the map
     is drawing from. What is left in config is prose about meaning — what a row
     IS, what is excluded and why — which is the only part a human has to keep
     true.

     One consequence worth stating: this panel can be wrong only if the map is
     also wrong, and it will be wrong in the same direction. That is the whole
     point of not typing it. */

  const socrataPage = id => `https://data.cityofnewyork.us/d/${id}`;

  /* The DEP asset types, counted from the same packed array the map draws.
     `t` is an index into `meta.types`, so this is the layer counting itself —
     there is no second list to keep in step, which is the defect REB-452 was
     opened for in the first place. */
  let greenTypes = null;
  async function loadGreenTypes() {
    if (greenTypes) return greenTypes;
    const url = tenant.overlays?.layers?.find(l => l.id === 'greeninfra')?.source?.url;
    if (!url) throw new Error('no greeninfra overlay configured');
    const r = await fetch(url);
    if (!r.ok) throw new Error(`greeninfra ${r.status}`);
    const g = await r.json();
    const names = g.meta?.types || [];
    const n = new Array(names.length).fill(0);
    for (const i of g.t || []) n[i] = (n[i] || 0) + 1;
    greenTypes = {
      built: g.meta?.built,
      total: g.meta?.assets ?? (g.t || []).length,
      rows: names.map((name, i) => ({ name, n: n[i] || 0 })).sort((a, b) => b.n - a.n),
    };
    return greenTypes;
  }

  /* One dataset, as a definition list. Rows with nothing to say are dropped
     rather than printed empty: "Filter: —" reads as "we did not filter", which
     for a dataset drawn as supplied is true and for one that IS filtered would
     be a lie, so the distinction is carried by the row's presence. */
  function dictRow(label, value, { code = false } = {}) {
    if (value == null || value === '') return '';
    return `<div class="dict-row"><dt class="dict-k">${esc(label)}</dt>`
      + `<dd class="dict-v${code ? ' dict-code' : ''}">${esc(value)}</dd></div>`;
  }

  /* `DELIVERY` was here: five sentences describing how each dataset reached the
     screen — frozen, live, both, static, built. Removed with the dictionary. The
     distinction is real but it is a replicator's question, and the panel now
     states one date per layer instead, which is the part a resident asked. */

  /* THE METHODOLOGY PANEL (REB-453 round two, 19 August).

     Judy: "no one from the public can understand it, it's too technical." The
     data dictionary that used to render here answered a replicator's questions
     — endpoint, SoQL filter, unit of aggregation, delivery model — which is a
     real reader but not the one who taps Methodology. This answers a resident's,
     four questions per layer and nothing else: what it is, who publishes it,
     when we last pulled it, what we filtered.

     ORDER IS COMPUTED, NOT WRITTEN. `methodOrder` walks `overlays.groups` and
     `overlays.layers` with the same rule `syncLayerPanel` uses, so this panel
     and the Map Layers panel list the layers in the same order permanently, and
     a layer added to the map cannot quietly go missing from the methodology.

     DATES ARE READ, NOT TYPED. Every "last pulled" comes from that overlay's own
     `meta.built`. A layer with no meta (the boundary files) prints no date row
     rather than a guess — the same rule `dictRow` has always applied. */
  function methodOrder() {
    const layers = tenant.overlays?.layers || [];
    const groups = tenant.overlays?.groups?.length ? tenant.overlays.groups : [{ id: null, label: null }];
    const out = [], claimed = new Set();
    for (const g of groups)
      for (const l of layers) {
        if (l.panelHidden || (l.group ?? null) !== (g.id ?? null)) continue;
        claimed.add(l.id); out.push({ layer: l, group: g.label || '' });
      }
    /* Everything else at the end, exactly as the panel does — INCLUDING the two
       `panelHidden` layers, which have no toggle but are still data on screen.
       A reader who wonders where their neighbourhood name came from has no
       other place to look, so a layer being hidden from the toggles is not a
       reason to hide where it came from. Their heading comes from their own
       copy entry, since they belong to no group. */
    for (const l of layers) if (!claimed.has(l.id)) out.push({ layer: l, group: '' });
    return out;
  }

  async function renderDict() {
    const d = tenant.method?.methodPanel;
    if (!d) return;
    const copy = d.layers || {};

    /* Which layers each card speaks for. The 311 card covers four, and Judy's
       19 August note is that they have four different colours on the map — so
       the card names them all with their own chips rather than showing one
       chip and four names in a title. */
    const order = methodOrder();
    const members = new Map();
    for (const { layer } of order) {
      const c = copy[layer.id];
      if (!c) continue;
      const key = c.card || layer.id;
      if (!members.has(key)) members.set(key, []);
      members.get(key).push(layer);
    }

    let lastGroup = null;
    const cards = [];
    const seen = new Set();
    for (const { layer, group } of order) {
      const c = copy[layer.id];
      if (!c) continue;
      const key = c.card || layer.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const heading = c.group || group;
      if (heading !== lastGroup) {
        lastGroup = heading;
        if (heading) cards.push(`<div class="ab-sec-t">${esc(heading)}</div>`);
      }
      const links = (c.datasets || []).map(x =>
        `<a href="${esc(socrataPage(x.id))}" target="_blank" rel="noopener">${esc(x.label)}</a>`).join(' · ');
      /* `chips` in config overrides the layer list, for the one case where a
         single layer draws in more than one colour: DEP is one overlay drawn
         in two greens, built and in progress. */
      const mine = c.chips || members.get(key) || [layer];
      const chip = l => `<span class="meth-sw" style="background:${esc(l.color || '#888')}"></span>`;
      cards.push(`<div class="dict-set">`
        + (mine.length > 1
          ? `<div class="dict-set-h">${esc(c.name || layer.label)}</div>`
            + `<div class="meth-keys">${mine.map(l =>
                `<span class="meth-key">${chip(l)}${esc(l.label)}</span>`).join('')}</div>`
          : `<div class="dict-set-h">${chip(layer)}${esc(c.name || layer.label)}</div>`)
        + `<p class="meth-what">${esc(c.what)}</p>`
        + `<dl class="dict-dl">`
        + dictRow('Published by', c.publisher)
        + (links ? `<div class="dict-row"><dt class="dict-k">On NYC Open Data</dt><dd class="dict-v">${links}</dd></div>` : '')
        // Filled by `methodDates` once the overlay meta is in hand, or left empty.
        + `<div id="methDate-${esc(key)}" data-layer="${esc(layer.id)}" data-from="${esc(c.dateFrom || '')}"`
        + ` data-label="${esc(c.dateLabel || 'Last pulled')}"></div>`
        + dictRow('What we filtered', c.filtered)
        + `</dl></div>`);
    }

    $('dictBody').innerHTML =
      `<div class="ab-eyebrow">${esc(d.eyebrow || 'Methodology')}</div>`
      + `<h2 class="ab-h">${esc(d.title || 'Where this data comes from')}</h2>`
      + (d.lead ? `<p class="ab-lead">${esc(d.lead)}</p>` : '')
      + cards.join('');

    methodDates();
  }

  /* The pull dates, filled after the panel is already on screen.

     Two layers cannot answer synchronously and both are lazy overlays, fetched
     on first toggle rather than at boot, so their meta is simply not in hand
     until somebody switches the layer on. Green Infrastructure has its own
     loader; the four 311 layers share a file too large to fetch for one field,
     so their card names `dateFrom: "cityFacts"` and takes the date off the
     findings summary, which is the same pull and is 1.3 KB.

     A slot that resolves to nothing is left empty rather than filled with a
     guess: the boundary files carry no build date because they are used as
     published, and "unknown" would be a worse answer than no row. */
  async function methodDate(el) {
    if (!el || !document.body.contains(el)) return;
    const label = el.dataset.label;
    let built = mapCtl.overlayMeta?.(el.dataset.layer)?.built;
    try {
      if (!built && el.dataset.from === 'cityFacts') built = (await loadCityFacts())?.pulledOn;
      if (!built && el.dataset.layer === 'greeninfra') built = (await loadGreenTypes())?.built;
    } catch { /* no date rather than a wrong one */ }
    if (built && document.body.contains(el)) el.outerHTML = dictRow(label, longDate(built) || built);
  }
  function methodDates() {
    document.querySelectorAll('[id^="methDate-"]').forEach(methodDate);
  }

  /* REB-522. Renders on every open rather than once: the story tabulation is
     counted off `stories`, which changes under it as the table reloads. The
     city figures inside it are fetched once and cached by js/findings.js. */
  function openFindings() {
    renderFindings({ el: $('findingsBody'), tenant, stories, mapCtl });
    $('findingsOverlay').classList.add('open');
  }
  function closeFindings() { $('findingsOverlay').classList.remove('open'); }

  function openDict() { renderDict(); $('dictOverlay').classList.add('open'); }
  function closeDict() { $('dictOverlay').classList.remove('open'); }

  /* Thousands separators for every published figure. Was a local inside the
     city modal; hoisted when the data dictionary needed the same one, so the
     two panels cannot format the same number two ways. */
  const N = n => (n || 0).toLocaleString();

  /* `blockMetres` lived here: it turned the grid's decimal precision into
     "about 110m" for the provenance line. Removed with the grid figures it
     described. Census blocks have no single size to quote — 121 sq ft to 11
     square kilometres — so the panels name the geography and its publisher
     instead, which is both truer and checkable. */

  /* Was a local copy formatting `en-GB` — "29 July 2026" — which is where the
     methodology panel's British dates came from. One formatter for the site
     now; see js/dates.js for why it is written out rather than delegated to a
     locale. */

  /* How current the frozen data is, stated from the data itself.

     This exists because the alternative was prose. The methodology text used to
     read "on 5 August 2026 the newest flooding report was from 29 July" — true
     when written, wrong by the following Monday, and wrong in the direction
     that flatters us. Every date here is read from the overlay that the map is
     actually serving, so it cannot drift from what a reader is looking at.

     The distinction the panel has to carry: the build date is when WE pulled,
     which is not how current the city's own record is. Those are two different
     lags and conflating them is the thing REB-416 was opened to prevent. */
  async function renderCurrency() {
    const el = $('methodCurrency');
    if (!el) return;
    let m;
    try { m = await loadCityFacts(); } catch { return; }
    if ($('methodCurrency') !== el) return;      // the panel was closed and reopened
    const built = longDate(m.built);
    if (!built) return;
    const newest = longDate(m.newestReport);
    // FloodNet ships as an eager overlay, so its meta is in hand without a
    // fetch. Absent on a tenant that has no sensor layer, hence the guard.
    const fnNewest = longDate(mapCtl.overlayMeta?.('floodnet')?.newestEvent);

    /* Three facts, no argument (REB-450). This was a paragraph explaining that
       311 publishes on a lag, so the city's record is behind, so this page is
       behind that — which is the same self-justifying register the rest of the
       panel just lost. The dates say it: a reader who compares "pulled" with
       "newest report" can see the gap without being walked through it.

       No asserted lag figure either. The old prose claimed "roughly seven
       days", measured once on 5 August; the real gap on 10 August was twelve.
       A number that has to be remembered will eventually be wrong. */
    el.innerHTML = `<div class="ab-sec-t">How current this is</div>`
      + `<p class="ab-p"><b>Pulled ${esc(built)}.</b>`
      + (newest ? ` Newest 311 report ${esc(newest)}.` : '')
      + (fnNewest ? ` Newest FloodNet measurement ${esc(fnNewest)}.` : '')
      + `</p>`;
  }
  function openMethod() { renderMethod(); $('methodOverlay').classList.add('open'); }
  function closeMethod() { $('methodOverlay').classList.remove('open'); }

  /* ── What the city's record shows (REB-431) ──
     The citywide analysis, read live from a frozen file so the numbers move
     with the rebuild rather than being typed in and quietly going stale. The
     limits are stated in the modal, not in a footnote: half a mile is a chosen
     radius, not a service area, and absence of a rain garden is not absence of
     investment.

     THE UNIT CHANGED, AND THIS IS THE SEAM.
     This used to read `persistence-summary.json`, which counts the map's
     drawing grid: coordinates rounded to three decimals, a 111 x 84 metre
     rectangle. Every figure on this page says "block", and that rectangle is
     not a block. It follows no street, exists in no city dataset, and cannot be
     looked up by the resident being told about it.

     It now reads `findings-blocks.json`, counted on 2020 census blocks — real,
     street-bounded, shoreline-clipped, each with a public GEOID, and joinable
     to census population. Written by findings/build-findings.py, which also
     produces the published workbook, so the map and the spreadsheet cannot
     disagree.

     The grid did not go away and should not: it is equal-area, which is what a
     density surface needs, and census blocks run from a 121 sq ft sliver to 11
     square kilometres. It draws the heat layers. It is no longer allowed to be
     the source of a number.

     Expect the figures to have MOVED, not broken. A census block is about twice
     the area of a grid cell, so a bigger container catches calls across more
     years: blocks reporting in all five years went 817 -> 1,193. Neither was
     wrong; they counted different things. */
  let cityFacts = null;
  async function loadCityFacts() {
    if (cityFacts) return cityFacts;
    const r = await fetch('overlays/findings-blocks.json');
    if (!r.ok) throw new Error(`findings ${r.status}`);
    cityFacts = await r.json();
    return cityFacts;
  }
  async function renderCityModal() {
    const el = $('cityBody');
    el.innerHTML = `<div class="ab-eyebrow">NYC Open Data</div>`
      + `<h2 class="ab-h">What New Yorkers told 311</h2>`
      + `<p class="ab-lead">Loading the reports…</p>`;
    let m;
    try { m = await loadCityFacts(); } catch (e) {
      el.innerHTML += `<p class="ab-p">The summary could not be loaded just now. ${esc(e.message)}</p>`;
      return;
    }
    if ($('cityBody') !== el) return;
    const d = Object.fromEntries((m.distribution || []).map(x => [x.years, x]));
    /* How many years the build actually counted, read from its own meta rather
       than written here (REB-461). The window is "everything since 1 September
       2021" with no end date, so this grows by one every September — and the
       panel used to say "five" in seven places, all of which would have become
       wrong on the same day without a single thing failing. Same rule as every
       other number on this page: if the data knows it, do not type it.

       "Persistent" means the top two buckets, whatever they are numbered. */
    const YRS = m.idaYears || (m.distribution || []).length || 5;
    const persistentCells = (d[YRS - 1]?.blocks || 0) + (d[YRS]?.blocks || 0);
    const persistentShare = Math.round((d[YRS - 1]?.shareOfReports || 0) + (d[YRS]?.shareOfReports || 0));
    /* Denominator is every census block in the city, not only the ones that have
       reported. It used to be the latter, which made "one block in ten" mean
       "one in ten of the blocks that have already flooded" while reading to
       anybody as "one in ten blocks in New York". Against all 37,588 blocks the
       honest figure is 10.9%, so the headline survives and becomes true. */
    const persistentPct = m.blocksCity ? (persistentCells / m.blocksCity * 100).toFixed(1) : '0';
    const allFive = d[YRS]?.blocks || 0;
    const allFiveUnserved = d[YRS]?.noGreenNearby || 0;
    const unserved = m.unservedBlocks
      ?? (m.distribution || []).reduce((a, x) => a + (x.noGreenNearby || 0), 0);
    const maxCells = Math.max(1, ...(m.distribution || []).map(x => x.blocks));
    /* "two in three" beats "65%" for a resident, but only if the fraction is
       honest. Pick the simplest fraction with a denominator of 5 or less that
       lands within 4 points of the real share, and fall back to the percentage
       when none does — 47% has no clean fraction and should not be forced into
       one. */
    const asFraction = (part, whole) => {
      if (!whole) return '';
      const share = part / whole;
      const words = ['', 'one', 'two', 'three', 'four'];
      let best = null;
      for (let den = 2; den <= 5; den++) {
        for (let num = 1; num < den; num++) {
          const err = Math.abs(num / den - share);
          if (err <= 0.04 && (!best || err < best.err)) best = { num, den, err };
        }
      }
      return best
        ? `${words[best.num]} in ${words[best.den]}`
        : `${Math.round(share * 100)}%`;
    };
    const reportingShare = asFraction(m.blocksReporting, m.blocksCity);

    /* REB-442. Judy: this "did not make sense at first glance" and has to work
       for a New Yorker who does not know what 311 is for, or that the city
       publishes any of this. So the panel now says what 311 is BEFORE it uses a
       number that depends on it, and leads with a proportion — one in ten
       blocks — with the count as the evidence rather than as the headline.
       "3,094 blocks" is a good number and an abstraction; "one block in ten"
       is a fact about the city you live in. */
    const oneIn = persistentCells && m.blocksCity ? Math.round(m.blocksCity / persistentCells) : 0;
    el.innerHTML =
      /* "The city's record" is gone throughout (Judy, 7 Aug). Two reasons, and
         the second matters more: it reads like a newspaper, and it is not
         accurate. 311 is not the city observing New York, it is New Yorkers
         phoning in about their own block. Calling it the city's record hands
         authorship to the city and quietly demotes the resident stories beside
         it to colour, when both are New Yorkers reporting.

         Two tiers, used consistently: "what New Yorkers told 311" for the
         complaint data, and "NYC Open Data" where a line covers both 311 and
         DEP's built assets. */
      `<div class="ab-eyebrow">NYC Open Data</div>`
      + `<h2 class="ab-h">What New Yorkers told 311</h2>`

      + `<p class="ab-lead">When a New Yorker reports flooding to 311, the city writes it down and `
      + `publishes it. Nobody checks the block afterwards, so this is not a survey — it is a record of `
      + `where people reported it. It is still the closest thing the city has to a map of where `
      + `water goes.</p>`

      /* Census blocks are named as such, once, here — and then the panel says
         "block" plainly from that point on. Saying "census block" in every
         sentence is precise and unreadable; saying it never is how a rounded
         coordinate got to call itself a block for months. Name it, define it,
         then talk like a person. */
      + `<p class="ab-p">Since Hurricane Ida in September 2021, that record holds <b>${N(m.reports)}</b> `
      + `flooding reports. <b>${N(m.reportsPlaced)}</b> of them can be placed on a census block — the `
      + `blocks the Census Bureau and the city both use, bounded by the streets you walk — and they `
      + `touch <b>${N(m.blocksReporting)}</b> of the city's ${N(m.blocksCity)} blocks, about `
      + `${reportingShare}. Counting them as ${YRS} separate `
      + `years rather than one pile is what makes the pattern visible.</p>`

      + `<div class="imp-kpis imp-kpis-2">`
      + `<div class="imp-kpi"><div class="imp-n">${oneIn ? `1 in ${oneIn}` : `${persistentPct}%`}</div>`
      + `<div class="imp-l">blocks in the city flood again and again<span class="imp-sub">`
      + `${N(persistentCells)} blocks reported in ${YRS - 1} or ${YRS} years out of ${YRS}, and they carry `
      + `${persistentShare}% of every flooding report in the city</span></div></div>`
      + `<div class="imp-kpi"><div class="imp-n">${N(allFive)}</div>`
      + `<div class="imp-l">reported in all ${YRS} years<span class="imp-sub">${N(allFiveUnserved)} of them with nothing built within half a mile</span></div></div>`
      + `</div>`

      + `<div class="imp-sec-t">How many of the ${YRS} years each block reported</div>`
      + (m.distribution || []).map(x =>
        `<div class="imp-bar"><div class="imp-bar-lbl"><span>${x.years} ${x.years === 1 ? 'year' : 'years'}</span></div>`
        + `<div class="imp-bar-track"><div class="imp-bar-fill" style="width:${Math.round(x.blocks / maxCells * 100)}%;background:var(--primary)"></div></div>`
        + `<div class="imp-bar-n">${N(x.blocks)}</div></div>`).join('')
      + `<p class="ab-p">A block that reported once may have had one bad night. A block that reported in `
      + `${YRS - 1} or ${YRS} separate years is telling you something structural, and this is where the reports `
      + `concentrate: the ${N(persistentCells)} most persistent blocks carry ${persistentShare}% of the city's flooding reports.</p>`

      + `<div class="imp-sec-t">Where the reports and the building do not line up</div>`
      /* REB-452. This said "rain gardens, basins and planted strips", which is
         three of the 31 asset types the unserved figure is actually computed
         against. The sentence has to describe the same set the number counts,
         or it quietly narrows the claim under the reader. */
      + `<p class="ab-p">The city builds rain gardens, basins under the pavement, planted strips, porous paving `
      + `and underground storage to soak rain up before it `
      + `reaches a basement. Across every block that has reported flooding since Ida, <b>${N(unserved)}</b> `
      + `have none of them standing within half a mile. Among the blocks that reported in all ${YRS} years, `
      + `<b>${N(allFiveUnserved)}</b> are in that position.</p>`

      + `<div class="imp-sowhat"><div class="imp-sowhat-t">What this does not prove</div>`
      + `<p>Half a mile is a radius we chose, not a service area: it is roughly a ten minute walk, and it is `
      + `not what any engineer would call a catchment. Nothing built nearby is not absence of investment, `
      + `because sewer upgrades are not in this dataset at all. And 311 only records the flooding someone `
      + `reported, so blocks where people do not report look quieter than they are — a quiet block is not `
      + `necessarily a dry one. The counts also rise and fall with how much it rained in a given year, so a `
      + `quieter year is not a safer one. These numbers are a place to start asking, not a verdict.</p></div>`

      /* Provenance, named. Judy asked for the specific source rather than a
         vague authority, so the datasets are spelled out here once. */
      + `<p class="ab-src">Source: NYC Open Data — 311 Service Requests, and the Department of `
      + `Environmental Protection's record of things built to soak up rain. `
      /* REB-458. The window is read rather than typed: `since` is the anchor
         the build counted from. A provenance line that states a window the
         build did not use is worse than no provenance line.

         The block-size sentence is gone. It said "blocks are about 110m",
         which described the drawing grid, and there is no single size to quote
         now: census blocks run from a 121 sq ft sliver to 11 square kilometres.
         Naming the actual geography and the dataset it comes from is both
         truer and more checkable than any average would be. */
      + `Counted from ${N(m.reportsPlaced)} flooding reports placed on ${N(m.blocksReporting)} `
      + `census blocks, ${esc(longDate(m.since) || m.since || '')} to the latest published data. `
      + `Blocks are the 2020 census blocks published by NYC City Planning, so every figure here can `
      + `be traced to a block you can look up. `
      /* NOT "rebuilt weekly" any more, and the distinction is the point.
     The weekly Action rebuilds the DRAWN layers. These figures come from a
     deliberately frozen pull, findings/snapshot.json, so a number quoted
     from this map still reads true a month later. Saying "rebuilt weekly"
     under a static number invites somebody to check it against the live
     portal, find it lower, and conclude we are wrong. */
      + `Data as of ${esc(longDate(m.pulledOn) || m.pulledOn || 'unknown')}, a fixed snapshot: these figures do not move. 311 publishes on a delay, so the record itself runs to ${esc(longDate(m.currentThrough) || m.currentThrough || '')}.</p>`;
  }
  function openCity() { $('cityOverlay').classList.add('open'); renderCityModal(); }
  function closeCity() { $('cityOverlay').classList.remove('open'); }

  /* REB-477. Fill the header's 311 figure from the same summary the About and
     methodology panels read, so the three can never state different totals.
     Fire-and-forget: the header renders the story count immediately and picks
     the city number up when it lands. A failure leaves the tally reading the
     stories alone, which is honest — better an absent number than a typed one.
     `loadCityFacts` caches, so this costs nothing when About is opened. */
  const fillCityTotal = () => loadCityFacts()
    .then(m => ui.setCityTotal(+m.reports))
    .catch(() => {});

  const ui = mount({
    tenant,
    mode: MODE,
    mapCtl,
    onStoryOpen: id => {
      const s = stories.find(x => x.id === id);
      if (s) openStory(s);
    },
    /* REB-475. Hovering a card grows that story's raindrop. Passed straight
       through: the map owns how a highlight looks, the pane owns when. */
    onStoryHover: id => mapCtl.hoverStory(id),
    onFilterChange: () => mapCtl.setStories(ui.filteredStories),
    onStoryClose: () => closeStoryFocus(),
    /* "See where this is on the map": the panel has just slid away, so the map
       owns the whole screen. Zoom in past the panel-open framing, dim every
       other dot so the one being read is unmistakable, and resize because the
       map's visible box just changed. The half-mile radius stays drawn. */
    onLocate: s => {
      if (s.lat == null || s.lng == null) return;
      mapCtl.resize();
      mapCtl.flyTo(s.lat, s.lng, 15);
      mapCtl.focusStory(s.id);
    },
    onOverlayToggle: id => mapCtl.toggleOverlay(id),
    onNeighborhood: labels => {
      const pts = ui.filteredStories.filter(s => s.lat != null && s.lng != null).map(s => [s.lng, s.lat]);
      mapCtl.focusNeighborhood(labels, pts);
    },
    onAddNear: (lat, lng) => {
      ui.closeStory();
      mapCtl.flyTo(lat, lng);
      mapCtl.dropPin(lat, lng);
      form.open({ lat, lng });          // through open(), see the note above
    },
    /* The half-mile panel for a tapped place (REB-442) frames the same circle a
       story does, so the numbers being read and the area they cover are one
       thing on screen. */
    onPlaceOpen: (lat, lng) => {
      /* Framed exactly as a story's half mile is, via fitRadius rather than a
         plain flyTo: fitRadius pads for the side panel, so the circle lands in
         the strip of map the reader can actually see. A flyTo centres on the
         full map element, which puts the circle half behind the panel. */
      mapCtl.fitRadius(lat, lng);
      /* 18 August, Judy: the circle shows the AREA but not where inside it the
         address or tap actually landed — same marker every other entry point
         already drops, so "where am I on the map" has one consistent answer. */
      mapCtl.dropPin(lat, lng);
      mapCtl.focusRadius(lat, lng).then(() => ui.syncLayerPanel?.(mapCtl.overlayState));
    },
    onPlaceClose: () => {
      mapCtl.clearRadius();
      mapCtl.clearPin();
      ui.syncLayerPanel?.(mapCtl.overlayState);
    },
    /* REB-458. The place panel used to carry the caveats inline; now it carries
       a door to them. Closing the other panels first for the same reason the
       header buttons do: the four modals share one space. */
    onOpenMethod: () => { closeAbout(); closeImpact(); openDict(); },   // REB-479: the dictionary is the methodology
    // "Me too" — a low-friction echo, distinct from adding a story. The UI
    // handles the optimistic bump + device dedup; this persists it and returns
    // the reconciled server total.
    onMeToo: async id => {
      const s = stories.find(x => x.id === id);
      if (!s) return null;
      try {
        const n = await api.bumpReaction(id);
        if (n != null) s.me_too = n;
        return s.me_too;
      } catch (e) {
        console.error('me-too failed:', e);
        return null;
      }
    },
    onShare: () => form.open(),
  });

  // shared intake/story-detail partial: layout-supplied wording + events
  // (these ids exist in every layout's shell)
  $('pinHint').innerHTML = `${icon('pin')} ${esc(layoutStrings.pinHint || 'Tap the map to pin your story')}`;
  $('spClose').textContent = layoutStrings.backToMap || '← Back';
  $('storyOverlay').addEventListener('click', e => { if (e.target.id === 'storyOverlay') ui.closeStory(); });
  $('spClose').addEventListener('click', () => ui.closeStory());
  $('formOverlay')?.addEventListener('click', e => { if (e.target.id === 'formOverlay') form.close(); });
  $('lightbox').addEventListener('click', () => $('lightbox').classList.remove('open'));
  $('impactBtn')?.addEventListener('click', openImpact);
  $('impClose')?.addEventListener('click', closeImpact);
  $('impactOverlay')?.addEventListener('click', e => { if (e.target.id === 'impactOverlay') closeImpact(); });
  $('aboutBtn')?.addEventListener('click', openAbout);
  // Close whatever else is open first: the four panels share the same space,
  // and About already offers a link here, so both doors can be in play.
  /* REB-479. Judy: the data dictionary replaces the entire methodology modal —
     the dictionary IS the methodology, and it is objective, which is what the
     project needs at this stage.

     So every door that said "methodology" opens the dictionary now: the nav
     item, the "How this map works" link in the layers panel, the one inside
     About, and the layout's own `onOpenMethod`. `openMethod` and `renderMethod`
     are left in place and NOTHING CALLS THEM — removing a panel is a separate
     deliberate pass, and the prose in it is the only plain-language account of
     what the map does not show, which has to land somewhere before it is
     deleted rather than after.

     The dictionary's eyebrow already reads "Methodology", so the door and the
     room agree on the word even though the heading says "Data dictionary". */
  $('methodBtn')?.addEventListener('click', () => { closeAbout(); closeImpact(); openDict(); });
  /* REB-522, 19 August. Findings is its own panel now and this is its door.
     It used to open the city's 311 record (REB-442); that panel keeps the door
     inside About (`#methodCity`), so nothing is orphaned by the change. */
  $('findingsBtn')?.addEventListener('click', () => { closeAbout(); closeImpact(); openFindings(); });
  $('findClose')?.addEventListener('click', closeFindings);
  $('findingsOverlay')?.addEventListener('click', e => { if (e.target.id === 'findingsOverlay') closeFindings(); });
  $('aboutClose')?.addEventListener('click', closeAbout);
  $('aboutOverlay')?.addEventListener('click', e => { if (e.target.id === 'aboutOverlay') closeAbout(); });
  /* The two REB-431 modals have no header button of their own: four items plus
     the lock does not fit a phone header, and both are things a reader reaches
     for from inside something else. Methodology hangs off About and off the
     layers panel; the city record hangs off Impact and off methodology. */
  $('methodClose')?.addEventListener('click', closeMethod);
  $('methodOverlay')?.addEventListener('click', e => { if (e.target.id === 'methodOverlay') closeMethod(); });
  // REB-453. The dictionary hangs off methodology only — it is the answer to a
  // question you can only have after reading that panel, and a sixth nav item
  // does not fit a phone header.
  $('dictClose')?.addEventListener('click', closeDict);
  $('dictOverlay')?.addEventListener('click', e => { if (e.target.id === 'dictOverlay') closeDict(); });
  $('cityClose')?.addEventListener('click', closeCity);
  /* Judy, 19 August: the ✕ top-right, one line per panel. Same handlers the
     footer buttons use, so there is one close path per sheet and not two. */
  for (const [id, fn] of [['spX', () => ui.closeStory()], ['impX', closeImpact],
                          ['aboutX', closeAbout], ['methodX', closeMethod],
                          ['dictX', closeDict], ['cityX', closeCity],
                          ['findX', closeFindings], ['fCloseX', () => form.close()]])
    $(id)?.addEventListener('click', fn);
  $('cityOverlay')?.addEventListener('click', e => { if (e.target.id === 'cityOverlay') closeCity(); });
  /* The layers-panel "How this map works" link and its listener are gone — Judy
     removed it on 17 August as redundant, and the dictionary still has three doors
     (the Methodology nav item above, the link inside About, and the layout's
     `onOpenMethod`). The listener that used to sit here queried `#lSrc` with `?.`,
     so it did not throw once the button stopped rendering; it just quietly did
     nothing, which is worse than an error. Deleted rather than left to read as live.

     The half-mile panel's own `[data-open-method]` button ("Where these
     numbers come from") is gone too now, 18 August, same reasoning — Judy:
     "less is more", and `onOpenMethod` plus the Methodology nav item were
     already two other doors to the same panel. No `[data-open-method]`
     button exists anywhere in the app any more. The rule it documented is
     still worth keeping for whatever door gets added next: bind where the
     markup is rendered, never delegate from document. Every `.sheet` in
     index.html carries onclick="event.stopPropagation()", so a click inside
     a modal never reaches document and a delegated handler silently does
     nothing. */

  const kiosk = MODE === 'kiosk' ? setupKiosk(tenant, form, {
    // The idle-wipe path bypasses onClose, so it must clear the map itself:
    // a dropped pin (a sensitive location) and a stuck pinMode must never
    // survive to the next participant.
    clearMap: () => { pinMode = false; mapCtl.clearPin(); },
  }) : null;
  /* Test handle, off unless ?e2e is in the URL. The camera and the focus ring
     are GL state with no DOM to assert against, so an automated check either
     gets a handle or falls back to guessing at screenshot pixels. Gated, so it
     is absent on every real page load. */
  /* `ui` joins them because the panels it owns cannot be reached any other way
     under automation: opening the half-mile place panel needs a real click on
     a canvas that never paints in a headless tab, and a synthetic Mapbox click
     dies inside `queryRenderedFeatures` for want of a rendered frame. With the
     handle, `__ui.openPlace(lat, lng)` exercises the actual render path. */
  /* `__form` joins the handles 19 August. Walking the submission end to end is
     the check this project keeps failing to run (REB-322, REB-492) — it froze
     at step three for days and nobody noticed — and driving it from outside
     needed a click path through the side pane that changes every UX round. */
  if (params.has('e2e')) { window.__map = mapCtl.map; window.__mapCtl = mapCtl; window.__ui = ui; window.__form = form; }
  /* Not on a story permalink: that visitor followed a link to one account and
     a card over the top of it is an obstacle, not a welcome. */
  if (MODE === 'map' && !params.get('story')) {
    showWelcome(tenant, { onShare: () => form.open() });
  }

  // The feed must not wait on basemap tiles: render stories as soon as the
  // data arrives, and drop pins whenever the map finishes loading.
  try {
    stories = await api.fetchApprovedStories();
  } catch (e) {
    console.error('could not load stories:', e);
    stories = [];
  }
  // Local preview stories (?preview) ride in front of the real feed, in memory
  // only. They carry their own me_too, so the merge below must not zero it.
  if (PREVIEW) {
    const { previewStories } = await import('./preview-seed.js');
    stories = [...previewStories(), ...stories];
  }
  // "Me too" counts ride alongside the stories. If the backend isn't
  // provisioned yet the map stays {} and the buttons simply don't render.
  try {
    const reactions = await api.fetchReactions();
    reactionsEnabled = reactions.enabled;
    stories.forEach(s => { s.me_too = reactions.counts[s.id] ?? s.me_too ?? 0; });
  } catch { /* counts stay unset */ }
  ui.setReactions?.(reactionsEnabled);
  ui.renderStories(stories);
  fillCityTotal();   // REB-477: the header's 311 figure, once the stories are up
  openPermalink();
  mapCtl.ready.then(() => {
    mapCtl.setStories(ui.filteredStories);
    // A URL-shared neighborhood (?hood=) frames its boundary once the map and
    // story points are both ready.
    if (ui.activeHoods.length) {
      const pts = ui.filteredStories.filter(s => s.lat != null && s.lng != null).map(s => [s.lng, s.lat]);
      mapCtl.focusNeighborhood(ui.activeHoods, pts);
    }
  });
}

/* ── kiosk mode ──────────────────────────────────────────────────
   An iPad on a folding table. Rules: full-screen attract loop between
   participants; large targets; a hard privacy wipe (state AND DOM) on
   every reset; an idle countdown so a walk-away never leaves someone's
   story on screen for the next person. */
function setupKiosk(tenant, form, { clearMap } = {}) {
  const k = tenant.kiosk || {};
  const prompts = promptPack(tenant);
  const attract = document.createElement('div');
  attract.className = 'kiosk-attract show';
  attract.id = 'kioskAttract';
  attract.innerHTML = `
    <div class="ka-inner">
      <div class="ka-logo">${esc(tenant.branding?.logoText || tenant.name.slice(0, 2).toUpperCase())}</div>
      <h1 class="ka-headline">${esc(k.headline || tenant.cta.share.replace(/^[^\p{L}\p{N}]+/u, ''))}</h1>
      <p class="ka-sub">${esc(k.sub || 'Your story helps make the case for change. It takes about two minutes, and you choose how your name appears, or whether it appears at all.')}</p>
      ${prompts.length ? `<div class="ka-prompts" id="kaPrompts" aria-live="off">
        <span class="ka-spark">${esc(k.promptLabel || 'Not sure where to start?')}</span>
        <span class="ka-prompt" id="kaPrompt">${esc((prompts[0].emoji ? prompts[0].emoji + '  ' : '') + prompts[0].text)}</span>
      </div>` : ''}
      <button class="ka-start" id="kaStart">${esc(k.start || 'Tap to begin')}</button>
      <p class="ka-org">${esc(tenant.org?.name || tenant.name)}</p>
    </div>`;
  document.body.appendChild(attract);

  // Rotate the fun prompts on the attract screen. Reduced-motion users get a
  // single static prompt (no swapping). The timer is cleared with the kiosk.
  let promptTimer = null;
  if (prompts.length > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let pi = 0;
    promptTimer = setInterval(() => {
      pi = (pi + 1) % prompts.length;
      const el = $('kaPrompt');
      if (!el) return;
      el.style.opacity = '0';
      setTimeout(() => {
        el.textContent = (prompts[pi].emoji ? prompts[pi].emoji + '  ' : '') + prompts[pi].text;
        el.style.opacity = '1';
      }, 320);
    }, 3600);
  }

  const warn = document.createElement('div');
  warn.className = 'kiosk-warn';
  warn.id = 'kioskWarn';
  warn.innerHTML = `
    <div class="kw-card">
      <h2>Still there?</h2>
      <p>To protect your privacy, this screen clears itself when no one is using it.</p>
      <div class="kw-count" id="kwCount">15</div>
      <button class="kw-keep" id="kwKeep">I’m still here</button>
    </div>`;
  document.body.appendChild(warn);

  const IDLE_MS = 75_000, WARN_S = 15;
  let idleTimer = null, warnTimer = null, warnLeft = WARN_S, active = false;

  function toAttract() {
    active = false;
    clearTimeout(idleTimer); clearInterval(warnTimer);
    warn.classList.remove('show');
    form.wipe();  // privacy: state AND rendered DOM from the last participant
    clearMap?.(); // and the dropped pin + pinMode, which wipe() can't reach
    attract.classList.add('show');
  }

  function reset() { toAttract(); }

  function start() {
    attract.classList.remove('show');
    active = true;
    armIdle();
    form.open();
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(showWarn, IDLE_MS);
  }

  function showWarn() {
    if (!active) return;
    warnLeft = WARN_S;
    $('kwCount').textContent = warnLeft;
    warn.classList.add('show');
    warnTimer = setInterval(() => {
      warnLeft--;
      $('kwCount').textContent = warnLeft;
      if (warnLeft <= 0) toAttract();
    }, 1000);
  }

  function keepGoing() {
    clearInterval(warnTimer);
    warn.classList.remove('show');
    armIdle();
  }

  $('kaStart').addEventListener('click', start);
  attract.addEventListener('click', start);
  $('kwKeep').addEventListener('click', e => { e.stopPropagation(); keepGoing(); });
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, () => {
      if (!active || warn.classList.contains('show')) return;
      armIdle();
    }, { passive: true }));

  return { toAttract, reset };
}

/* ── FIRST LOAD: SAY WHAT THIS IS, AND POINT AT THE MAP (REB-499) ──────────

   The strongest signal in the UX round, and four testers reached it
   independently: nothing tells a new visitor what this is, or that the map is
   tappable at all. Nick praised the half-mile panel at length and unprompted —
   and that is the feature nobody finds without being told it exists. The panel
   was already built. What was missing was one sentence pointing at it.

   Judy picked direction B of three mockups on 19 August: a card over the map on
   arrival, the map visible behind it, with both doors offered — Explore the Map
   beside Share Your Story. Mylene asked for exactly that pairing, twice.

   THIS REPLACES `showWelcomeHint`, which was a one-line toast with a 10-second
   timeout. Its config string had already been removed on 18 August and its CSS
   deleted with it, so it had been building an unstyled element and appending it
   to the page for a day. Deleted rather than left dormant.

   WHERE IT DOES NOT APPEAR, and each of these is a real case rather than
   defensive coding:
   - kiosk mode, which is a single-purpose pin canvas with nobody to onboard;
   - a `?story=` permalink, where somebody followed a link to one story and a
     card over the top of it is an obstacle, not a welcome.

   EVERY LOAD, DELIBERATELY. Judy, 19 August: "always have the first-load card
   reappear, it helps in case people come back and forget." So there is no
   seen-flag at all — not `localStorage`, which shows it once ever, and not
   `sessionStorage`, which was here first and would go quiet for the rest of a
   browser session.

   The thing that makes this defensible rather than nagging is that the site
   never reloads itself: the only `location.reload` in the tree is the admin
   logout. A visitor sees this once per visit unless they reload by hand, and
   dismissing it is one tap anywhere. If it ever does start to nag, the fix is a
   flag here and not a change to the card. */
function showWelcome(tenant, { onExplore, onShare }) {
  const w = tenant.welcome;
  if (!w?.title) return;                       // a tenant that does not want one

  const el = document.createElement('div');
  el.className = 'welcome';
  el.innerHTML = `
    <div class="welcome-scrim"></div>
    <div class="welcome-card" role="dialog" aria-modal="true" aria-labelledby="wcTitle" tabindex="-1">
      <h2 class="welcome-h" id="wcTitle">${esc(w.title)}</h2>
      ${w.subtitle ? `<p class="welcome-sub">${esc(w.subtitle)}</p>` : ''}
      ${w.lead ? `<p class="welcome-lead">${esc(w.lead)}</p>` : ''}
      <ol class="welcome-steps">${(w.steps || [])
        /* The action is bolded so every step reads as a thing to DO rather than
           a description of a feature. It is a separate field, not markup inside
           the string, so config stays plain text and `esc` can do its job. A
           plain string is still accepted, for a tenant that wants no emphasis. */
        /* ONE element around the whole step, not `<b>` plus a bare text node.
           The `<li>` is a two-column grid, and a grid container makes an
           anonymous item out of every contiguous run of text — so the bold and
           the sentence after it became two items stacked in column two, and the
           tail wrapped one word per line. */
        .map(t => (typeof t === 'string'
          ? `<li><span>${esc(t)}</span></li>`
          : `<li><span><b>${esc(t.action)}</b>${esc(t.rest || '')}</span></li>`)).join('')}</ol>
      <div class="welcome-btns">
        <button type="button" class="welcome-go" id="wcGo">${esc(w.explore || 'Explore the Map')}</button>
        <button type="button" class="welcome-alt" id="wcShare">${esc(w.share || 'Share Your Story')}</button>
      </div>
    </div>`;
  document.body.appendChild(el);

  /* The map is behind this and is the thing the card is telling you to tap, so
     a tap on the scrim closes rather than being swallowed. It does NOT pass the
     tap through to the map: opening the half-mile panel from the same gesture
     that dismissed the card reads as the card having done something wrong. */
  let done = false;
  const close = (then) => {
    if (done) return;
    done = true;
    el.classList.add('bye');
    setTimeout(() => el.remove(), 260);
    then?.();
  };
  el.querySelector('.welcome-scrim').addEventListener('click', () => close());
  el.querySelector('#wcGo').addEventListener('click', () => close(onExplore));
  el.querySelector('#wcShare').addEventListener('click', () => close(onShare));
  document.addEventListener('keydown', function esc2(e) {
    if (e.key !== 'Escape') return;
    document.removeEventListener('keydown', esc2);
    close();
  });
  /* Focus the DIALOG, not the button inside it. Focusing the button moves a
     screen reader to "Explore the Map" and skips the title and the three steps
     that are the entire point of the card — and Chrome paints `:focus-visible`
     on a programmatic focus, so a mouse visitor arrives to an outlined button
     for no reason. The container is `tabindex="-1"` so it can hold focus
     without joining the tab order. */
  requestAnimationFrame(() => { el.classList.add('show'); el.querySelector('.welcome-card').focus(); });
}

main().catch(e => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend',
    `<div style="position:fixed;inset:auto 16px 16px 16px;background:#fff;border:2px solid #D63B3B;border-radius:10px;padding:14px;z-index:99;font-family:sans-serif;font-size:.85rem">
      This site failed to start: ${String(e.message).replace(/[<>]/g, '')}</div>`);
});
