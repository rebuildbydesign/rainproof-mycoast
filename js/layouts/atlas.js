/* Layout module: ATLAS — full-bleed map, side story feed, filter chips,
   layers panel, FAB + floating CTA. The default layout.

   The layout-module contract (every engine/js/layouts/<name>.js):
     export function mount(ctx) → view

   ctx (provided by app.js — the layout must not construct these itself):
     tenant        the tenant config
     mode          'map' | 'kiosk' (URL-selected; app.js owns kiosk
                   behavior — layouts only arrange chrome)
     mapCtl        the app-owned map controller. A layout that exports
                   `deferMap = true` gets it uninitialized and calls
                   mapCtl.init() on first reveal (and mapCtl.resize()
                   on re-reveal); layouts never construct their own.
     onStoryOpen   (storyId) open a story's detail
     onFilterChange()        active filter changed — app re-syncs the map
     onOverlayToggle(id)     toggle a map overlay; returns new on/off state
     onOverlayYear(id, year) move a timeline overlay to a year
     onOverlayMeta(id)       the overlay asset's own meta block, or null
     onShare()               open the submission flow

   view (what app.js consumes):
     renderStories(stories)  (re)render from the full approved list
     openStory(story) / closeStory()
     get filteredStories     the currently visible subset (drives map pins)
     onPinRequest()          optional: the intake asked for a map tap — a
                             layout whose map isn't full-bleed reveals it
     onMapStoryClick(id)     optional: claim map-dot clicks (Story scrolls
                             to the card); absent = dot opens the detail

   Rules: no tenant names, no fetches, no submission logic — shared modules
   own those. The shared intake partial's ids (formOverlay, storyOverlay,
   pinHint, lightbox) exist in every layout's shell. */
import { createUi } from '../ui.js';
import { icon } from '../ui/icons.js';

const $ = id => document.getElementById(id);

/* Chrome copy is layout-supplied (not hardcoded in the engine templates) so
   other layouts can strike a different register — Record says "accounts on
   the record", Atlas says "stories". app.js applies the shared-partial
   strings (pinHint, backToMap); createUi applies the rest. */
export const strings = {
  fabLabel: 'Stories',
  fabBackLabel: 'Back to story',
  // PLACEHOLDER WORDING — awaiting Judy. The phone card shows the opening
  // lines; this is the button that opens the whole thing.
  cardMoreLabel: 'Read the full story',
  allChip: 'All',
  noun: ['story', 'stories'],
  pinHint: 'Tap the map to pin your story',
  backToMap: '← Back to Map',
  // 18 August: dropped at Judy's ask — the sidepane's own Share Your Story
  // CTA is now the entry point, so a one-time toast repeating it is dead
  // weight, not a second nudge.
};

export function mount({ tenant, mode, onStoryOpen, onStoryHover, onFilterChange, onOverlayToggle, onOverlayYear, onOverlayMeta, onNeighborhood, onAddNear, onMeToo, onStoryClose, onLocate, onShare, onPlaceOpen, onPlaceClose, onOpenMethod }) {
  const ui = createUi(tenant, { onStoryOpen, onStoryHover, onFilterChange, onOverlayToggle, onOverlayYear, onOverlayMeta, onNeighborhood, onAddNear, onMeToo, onStoryClose, onLocate, onPlaceOpen, onPlaceClose, onOpenMethod }, strings);
  ui.renderChrome();

  // this layout's own chrome iconography
  $('fabBtn').innerHTML = `${icon('chat')} ${strings.fabLabel} <span class="fab-n" id="fabN">0</span>`;
  // 18 August: icon + caption, not icon alone — the toolbar reads as four
  // labelled controls now (List/Photos/Search/Filter), not four bare glyphs.
  document.querySelector('.view-btn[data-view="list"]').innerHTML = `${icon('list', 15)}<span>List</span>`;
  document.querySelector('.view-btn[data-view="gallery"]').innerHTML = `${icon('grid', 15)}<span>Photos</span>`;

  // chrome events (this layout's own DOM)
  // 17 August: the floating #ctaBtn is gone; #sideShareBtn in the pane itself
  // is what now calls onShare() with no location pre-set. Map tap and the
  // address bar are the other two entry points, both of which already have
  // a place before the form opens.
  /* The phone header's menu. The nav itself is unchanged and keeps all its
     own wiring — this only shows and hides it. */
  const burger = $('hdrBurger');
  if (burger) {
    burger.innerHTML = icon('menu');
    const nav = $('hdrNav');
    const setOpen = on => {
      nav.classList.toggle('open', on);
      burger.setAttribute('aria-expanded', String(on));
    };
    burger.addEventListener('click', e => {
      e.stopPropagation();
      setOpen(!nav.classList.contains('open'));
    });
    // Picking anything, tapping away, or Escape all close it.
    nav.addEventListener('click', () => setOpen(false));
    document.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
  }

  $('sideShareBtn')?.addEventListener('click', () => onShare?.());
  // The phone bar's round button is the same door, with the label as its
  // accessible name because there is no room for it on the face.
  const mbShare = $('mbShareBtn');
  if (mbShare) {
    mbShare.innerHTML = icon('chat');
    mbShare.setAttribute('aria-label', tenant.cta?.share || 'Share Your Story');
    mbShare.addEventListener('click', () => onShare?.());
  }
  $('fabBtn').addEventListener('click', () => $('side').classList.toggle('open'));
  $('closeSide').addEventListener('click', () => $('side').classList.remove('open'));
  document.querySelectorAll('.view-btn').forEach(b =>
    b.addEventListener('click', () => ui.setSideView(b.dataset.view)));

  // desktop: the feed presents itself once the visitor has their bearings
  if (mode === 'map' && window.innerWidth >= 768) {
    setTimeout(() => $('side').classList.add('open'), 500);
  }

  return ui;
}
