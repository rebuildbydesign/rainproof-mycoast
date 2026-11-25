/* Shared story renderers — layout-agnostic, DOM-free.
   Every layout renders stories through these functions so UGC escaping and
   consent-derived bylines live in exactly one place. Nothing here touches
   document or assumes an element id: callers pass data in, HTML comes out. */
import { roleField, fieldOption, storyPinColor, storyIcon, storyText } from '../config.js';
import { icon, GLYPH_D } from './icons.js';
import { longDate, shortDate } from '../dates.js';

export const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* A small filled raindrop mark, coloured per story type — used on the map,
   the legend, the type chips, and each card so the taxonomy reads the same
   everywhere. Colours come from config (trusted), not user input. */
/* List views load one image per story, all at once, which is where the storage
   egress budget actually goes: twenty full-size phone photos is ~70 MB for a
   single visit. Cards and the gallery therefore read the small thumbnail the
   upload pipeline writes alongside each photo, and fall back to the full image
   for anything uploaded before that existed (REB-407). Detail views and the
   lightbox always use the full one. */
export const thumbOf = m => m?.thumb || m?.url;

/* The raindrop, matching the map pin exactly (REB-455): one brand colour, with
   the story type carried by a white glyph rather than by hue. `glyph` is a key
   into GLYPH_D; without one this falls back to the plain drop, so a tenant that
   has not given its options icons is unaffected.

   `ink` is the outline and glyph colour, white by default because the drop
   normally sits on a light surface. It exists for the inverse case (REB-463):
   on a brand-blue background a blue drop with a white outline washes out at
   2.43:1, so the selected type pill draws a WHITE drop with blue ink instead.
   Same mark, same geometry, legible either way round — rather than a second
   function that would drift from this one.

   The glyph is scaled to 12.4/24 and centred on (12, 14.6) — the widest part of
   the bulb — which is the same transform `raindropImage` applies on canvas.
   Change one and change the other, or the pane and the map stop agreeing. */
export const dropMark = (color, size = 12, glyph = null, ink = '#fff') => {
  const paths = (glyph && GLYPH_D[glyph]) || [];
  const inner = paths.length
    ? `<g transform="translate(12 14.6) scale(0.5167) translate(-12 -12)" fill="none"
         stroke="${ink}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
        >${paths.map(m => (typeof m === 'string'
            ? `<path d="${m}"/>`
            : `<path d="${m.d}" stroke-width="${m.w}"/>`)).join('')}</g>`
    : '';
  return `<svg class="dropmark" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 C12 2 5 10 5 15 A7 7 0 0 0 19 15 C19 10 12 2 12 2 Z" fill="${color}" stroke="${ink}" stroke-width="1.4" stroke-linejoin="round"/>${inner}</svg>`;
};

/* The glyph on its own, with no raindrop around it (REB-464).

   NOTHING USES THIS as of the evening of 18 August. Earlier that same day
   this briefly became the feed avatar (a plain circle behind the bare
   glyph, floating over a hero photo like a byline avatar) — Judy's reply on
   seeing it live: "let the raindrop be visible ... NO CIRCLE." The card went
   back to `dropMark` within the day. Its only other caller (the side-pane
   type tiles) left this for teardrops back on 12 August. Kept, not deleted,
   same as then. Delete it if a third round settles the question.

   `dropMark` scales the glyph to 0.5167 so it fits inside the drop's bulb, so a
   15px raindrop renders a 7.8px glyph — which is why the side-pane filters were
   unreadable however carefully the glyphs were drawn. Taking the drop away
   hands the whole footprint back: the same 15px box now renders a 15px glyph.

   Use this on FLAT surfaces where the mark only has to name a type — filter
   tiles, and anywhere else a legend would go. Use `dropMark` where the mark has
   to read as a pin, which is the map and anything echoing it. The raindrop is
   the map's language and should not be spent on a button.

   `weight` is the stroke: 1.5 matches the drop's interior at its own scale, but
   at tile size a slightly heavier line holds up better against a coloured
   ground, so it is a parameter rather than a constant. */
export const glyphMark = (color, size = 22, glyph = null, weight = 1.7) => {
  const paths = (glyph && GLYPH_D[glyph]) || [];
  if (!paths.length) return '';
  return `<svg class="glyphmark" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"
    fill="none" stroke="${color}" stroke-width="${weight}" stroke-linecap="round" stroke-linejoin="round"
    >${paths.map(m => (typeof m === 'string'
        ? `<path d="${m}"/>`
        : `<path d="${m.d}" stroke-width="${m.w}"/>`)).join('')}</svg>`;
};

/* Seeded demo content, marked wherever a reader sees a byline.

   The map is shown to city agencies and community boards as evidence, so
   illustrative stories must never be able to pass as resident testimony —
   especially since the Impact panel computes real spatial statistics against
   whatever pins are loaded. Matching is by id prefix (the seed rows are
   `5eed0001-…`), so a genuine submission, which gets a random uuid, can never
   be labelled an example by accident. Drop the `examples` block from config
   once the seed rows are gone. */
export const isExample = (tenant, story) => {
  const p = tenant.examples?.idPrefix;
  return !!p && String(story?.id || '').startsWith(p);
};
export function exampleBadge(tenant, story) {
  if (!isExample(tenant, story)) return '';
  const e = tenant.examples;
  return `<span class="ex-badge" title="${esc(e.title || '')}">${esc(e.label || 'Example')}</span>`;
}

/* The public byline is whatever the consent trigger let through — never the
   contact name. Layouts must not compose bylines any other way.

   `anonymousLabel` may carry `{neighborhood}`, filled from the story's own
   `location_label`. 19 August: the form's anonymous option is worded "A Red
   Hook Resident" and shows that as a live preview, so the card has to say the
   same thing — it read "Anonymous" while the form promised a neighbourhood,
   which is the form making a promise the map does not keep. `display_name`
   stays null for these rows, so nothing about the anonymity changed; only what
   the card prints when there is no name. Falls back when a story has no
   neighbourhood, which the seeded and earliest rows do not. */
export function byline(tenant, story) {
  if (story.display_name) return story.display_name;
  const label = tenant.consent?.anonymousLabel;
  if (!label) return 'Anonymous';
  if (!label.includes('{neighborhood}')) return label;
  const place = (story.location_label || '').split(',')[0].trim();
  if (!place) return 'Anonymous';
  return label.replace('{neighborhood}', place).replace(/^A (?=[AEIOU])/, 'An ');
}

export function emptyState(text) {
  return `<div style="padding:24px;text-align:center;color:var(--muted);font-size:.8rem">${esc(text)}</div>`;
}

/* Shorten UGC for a tile or row without chopping mid-word: cut at the last
   word break past 60% of the budget, drop a dangling comma/period, add …. */
export function excerpt(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const brk = cut.lastIndexOf(' ');
  return (brk > max * 0.6 ? cut.slice(0, brk) : cut).trimEnd().replace(/[,;:.!?]+$/, '') + '…';
}

/* Read a possibly-multi answer as an array — tolerates the old single-value
   shape so pre-existing stories still render/filter. */
export const asArray = v => (Array.isArray(v) ? v : (v || v === 0 ? [v] : []));
const fieldOptions = (f, v) => asArray(v).map(id => fieldOption(f, id)).filter(Boolean);

const MEDIA_ICON = { photo: 'camera', video: 'video', audio: 'mic', document: 'file' };

/* "Street flooding" -> "#Street flooding". Replaces the dot-pill tag chips
   on the card. Tried CamelCase-and-squash first ("#StreetFlooding") but
   Judy asked for the entire category name back — squashing cost clarity on
   the longer/joined ones ("Housing & displacement" -> "#HousingAndDisplacement"
   read as a run-on) for a line-width saving she'd rather not make. Just the
   "#" plus the label verbatim; the tag row wraps, so a longer name costs a
   line, not a truncation. */
export function hashtag(label) {
  return '#' + label;
}

/* Both dates a card can show: when it was submitted, and — if the resident
   gave one — when the flooding itself happened, the exact date if given,
   else the storm's own label. `storyDetail` computes the same two pieces
   inline for its long-form header; kept separate here since the two format
   dates differently (short "Aug 12" on the card vs. long-form there) and
   this is the only other caller. */
export function storyWhen(tenant, s) {
  const eventField = roleField(tenant, 'event');
  const eventOpt = fieldOption(eventField, s.answers?.[eventField?.id]);
  const dateField = tenant.storySchema.fields.find(f => f.kind === 'date');
  const storyDateRaw = dateField && s.answers?.[dateField.id];
  const storyDate = storyDateRaw ? longDate(storyDateRaw) : null;
  const submitted = shortDate(s.submitted_at);
  return { submitted, eventLabel: storyDate || eventOpt?.label || null };
}

/* Feather's thumbs-up, matching icon()'s own wrapper (js/ui/icons.js) almost
   exactly. Not folded into that file's generic PATHS set because the
   reacted state needs a FILLED variant (fill=currentColor) — every icon in
   that set is stroke-only, so a second parameter didn't fit its signature. */
export function thumbIcon(size = 14, filled = false) {
  const d = 'M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3';
  return `<svg class="ico ico-thumb" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

/* One story card (the feed unit). Clicks are the caller's job: the card
   carries data-story, and any [data-lightbox] child opens the image. */
export function storyCard(tenant, s, opts = {}) {
  const filterField = roleField(tenant, 'filter');
  const media = s.media || [];
  const imgs = media.filter(m => m.kind === 'photo');
  const cats = fieldOptions(filterField, s.answers?.[filterField?.id]);
  const color = storyPinColor(tenant, s);
  const glyph = storyIcon(tenant, s);
  /* The hero used to be photos only, so a video-only story rendered as a block
     of text with a "Video" chip and nothing to look at.

     Three tiers, in order of what costs the reader least:
       a photo                     the thumbnail, as before
       a video WITH a poster       that poster, an <img>, same weight as a photo
       a video with NO poster      the clip itself at preload="metadata", so the
                                   browser paints its first frame

     The third tier exists for clips uploaded before posters were captured.
     It costs a metadata range request per card rather than a whole video, and
     it is the only way to show anything for media already in the bucket. */
  const vidsAll = media.filter(m => m.kind === 'video');
  const posterVid = vidsAll.find(m => m.thumb);
  let heroInner = '';
  if (imgs.length) heroInner = `<img src="${esc(thumbOf(imgs[0]))}" loading="lazy" alt="" oncontextmenu="return false" draggable="false">`;
  else if (posterVid) heroInner = `<img src="${esc(posterVid.thumb)}" loading="lazy" alt="" oncontextmenu="return false" draggable="false">`;
  else if (vidsAll.length) heroInner = `<video src="${esc(vidsAll[0].url)}" preload="metadata" muted playsinline tabindex="-1" aria-hidden="true" oncontextmenu="return false"></video>`;
  const hasHero = !!heroInner;
  const hood = s.location_label || '';

  /* Every media KIND present gets counted, not just the hero's own — a story
     with four photos and a voice note used to say only "camera, 4" (or
     nothing, if a video happened to become the hero). Each kind is its own
     small pill so "4 photos and a video" reads as two facts, not one number
     that quietly drops the rest. Audio/document chips repeat in the footer's
     .scard-mtag row below for the no-hero case, where this badge never
     renders at all. */
  const counts = {};
  media.forEach(m => { counts[m.kind] = (counts[m.kind] || 0) + 1; });
  const heroBadges = hasHero
    ? Object.entries(counts).map(([kind, n]) => `<span class="scard-hero-count">${icon(MEDIA_ICON[kind])} ${n}</span>`).join('')
    : '';

  /* Doubles up with the hero badge above only when there's no hero to carry
     it — a photo/video hero already accounts for its own kind. */
  const mediaTags =
    (media.some(m => m.kind === 'video') && !hasHero ? `<span class="scard-mtag">${icon('video')} Video</span>` : '') +
    (media.some(m => m.kind === 'audio') ? `<span class="scard-mtag">${icon('mic')} Voice</span>` : '') +
    (media.some(m => m.kind === 'document') ? `<span class="scard-mtag">${icon('file')} File</span>` : '');
  /* The card says its type in words now (REB-464).

     REB-463 removed the coloured rail and grew the raindrop, and Judy's reply
     was that it still was not obvious. The reason: **the card never named the
     type at all.** The only clue was a mark, and a reader has to already know
     that a wave means "I experienced flooding" before a wave can tell them
     anything. So the words go in, under the name.

     The type text is `--story-blue-text`, the closest blue to the raindrop that
     a label can legally be. The raindrop's own #2db4d9 measures 2.43:1 on white
     and fails, and so does every blue between it and this one. Judy asked for
     the text to match the drop; this is as close as matching gets while staying
     readable. */
  const typeField = roleField(tenant, 'color');
  const typeOpt = fieldOption(typeField, s.answers?.[typeField?.id]);
  /* Back to the actual raindrop, not the circle this card briefly used
     earlier the same day (18 August). Judy's reply on seeing that version
     live: "let the raindrop be visible ... NO CIRCLE." `.scard-drop` carries
     no fill or ring of its own — `dropMark`'s
     own SVG paints the drop — so floating it over a photo is just a position
     and a drop-shadow (for legibility against a bright image), never a chip
     behind it. One size (40) either way — it used to be 32 inline, next to
     the name, and 40 floating over a hero; Judy asked for the two to match. */
  const avatar = `<span class="scard-drop${hasHero ? ' float' : ''}">${dropMark(color, 40, glyph, '#fff')}</span>`;
  const hero = hasHero
    ? `<div class="scard-hero">${heroInner}${heroBadges ? `<span class="scard-hero-badges">${heroBadges}</span>` : ''}${avatar}</div>`
    : '';
  /* Feed cards show only the submitted date now (18 August, Judy: cut the
     "Happened" line to shrink the card's vertical footprint — it's still on
     the open story, this trims the list view specifically). */
  const { submitted } = storyWhen(tenant, s);
  return `<div class="scard${hasHero ? ' has-hero' : ''}" data-story="${esc(s.id)}"
    role="button" tabindex="0" aria-label="Open story from ${esc(byline(tenant, s))}">
    ${hero}
    <div class="scard-main">
      <div class="scard-head">
        ${hasHero ? '' : avatar}
        <div class="scard-idwrap">
          <span class="scard-name">${esc(byline(tenant, s))}</span>${exampleBadge(tenant, s)}
          ${typeOpt ? `<span class="scard-type">${esc(typeOpt.label)}</span>` : ''}
          ${hood ? `<button type="button" class="scard-hood" data-hood="${esc(hood)}" title="See all stories in ${esc(hood)}">${esc(hood)}</button>` : ''}
        </div>
      </div>
      <!-- Judy, 17 August: shorter preview so more cards fit per scroll.
           excerpt() cuts at a word break rather than relying on the CSS
           line-clamp alone to hide the rest -- the full story is one tap
           away in the detail pane, so nothing here needs the whole thing. -->
      <p class="scard-body">${esc(excerpt(storyText(tenant, s), 180))}</p>
      <!-- Real filters, not decoration (18 August) -- data-filtercat is the
           same attribute storyDetail's category badges already use, so one
           click handler in js/ui.js's renderFeed covers both. -->
      ${cats.length ? `<div class="scard-tags">${cats.map(c =>
        `<button type="button" class="scard-tag" data-filtercat="${esc(c.id)}" title="See stories tagged ${esc(c.label)}">${esc(hashtag(c.label))}</button>`
      ).join('')}</div>` : ''}
      <div class="scard-foot">
        <span class="scard-when">Submitted ${submitted}</span>
        ${mediaTags}
        ${opts.reactions ? upvoteButton(s, 'scard-metoo') : ''}
      </div>
    </div>
  </div>`;
}

/* The "Me too" echo — a low-friction, Reddit-style acknowledgement that lives
   apart from "Add your story". A thumbs-up count now, not a labelled button
   (18 August) -- Judy's ask, closer to an upvote. `data-metoo` and the story
   id are kept from the old control on purpose: same dedup key, same wiring in
   js/ui.js, just a new face. Toggles both ways -- see reactMetoo in
   js/ui.js for what "undo" actually does (short version: the +1 persists to
   the server, the -1 does not yet; flagged there, not silently faked). */
export function upvoteButton(s, cls) {
  const n = s.me_too || 0;
  return `<button type="button" class="${cls}" data-metoo="${esc(s.id)}" aria-pressed="false">
    ${thumbIcon(14)}<span class="mt-n"${n ? '' : ' hidden'}>${n}</span><span class="mt-undo">Undo</span>
  </button>`;
}

/* One gallery tile for a single media item ({ ...media, story }).
   Tiles act as buttons (they open the story), so they carry the role and
   are focusable; callers bind click AND Enter/Space. */
export function galleryItem(tenant, item) {
  const color = storyPinColor(tenant, item.story);
  const glyph = storyIcon(tenant, item.story);
  const attrs = `data-story="${esc(item.story.id)}" role="button" tabindex="0" style="--tc:${esc(color)}" aria-label="Open story from ${esc(byline(tenant, item.story))}"`;
  // Same raindrop as the map, legend and cards. 30px, up from 16 (Judy, 19
  // August): the white chip that used to hold it is gone, so the drop is the
  // whole mark and the glyph inside it is what names the type.
  const badge = `<span class="gal-drop">${dropMark(color, 30, glyph)}</span>`;
  const overlay = `<div class="gal-overlay">
      <span class="gal-name">${esc(byline(tenant, item.story))}</span>${exampleBadge(tenant, item.story)}
      <span class="gal-hood">${esc(item.story.location_label || '')}</span>
    </div>`;
  if (item.kind === 'photo') {
    return `<div class="gal-item" ${attrs}>${badge}
      <img src="${esc(thumbOf(item))}" loading="lazy" alt="" oncontextmenu="return false" draggable="false">${overlay}</div>`;
  }
  if (item.kind === 'video') {
    return `<div class="gal-item gal-vid" ${attrs}>${badge}
      <video src="${esc(item.url)}" muted preload="metadata" controlsList="nodownload" disablePictureInPicture oncontextmenu="return false"></video>
      <div class="gal-play">▶</div>${overlay}</div>`;
  }
  if (item.kind === 'document') {
    return `<div class="gal-item gal-aud gal-doc" ${attrs}>${badge}
      <div class="gal-aud-ico">${icon('file', 26)}<span class="gal-aud-lbl">${esc(item.name || 'File')}</span></div>${overlay}</div>`;
  }
  return `<div class="gal-item gal-aud" ${attrs}>${badge}
    <div class="gal-aud-ico">${icon('mic', 28)}<span class="gal-aud-lbl">Voice note</span></div>${overlay}</div>`;
}

/* The story detail (popup body). Returns pieces, not a whole overlay, so
   each layout can host it in its own shell: { headStyle, headHtml, bodyHtml }.
   Callers bind [data-lightbox] clicks after insertion. */
export function storyDetail(tenant, s) {
  const colorField = roleField(tenant, 'color');
  const filterField = roleField(tenant, 'filter');
  const eventField = roleField(tenant, 'event');
  const media = s.media || [];
  const imgs = media.filter(m => m.kind === 'photo');
  const vids = media.filter(m => m.kind === 'video');
  const auds = media.filter(m => m.kind === 'audio');
  const docs = media.filter(m => m.kind === 'document');
  const typeOpt = fieldOption(colorField, s.answers?.[colorField?.id]);
  const cats = fieldOptions(filterField, s.answers?.[filterField?.id]);
  const eventOpt = fieldOption(eventField, s.answers?.[eventField?.id]);
  const dt = longDate(s.submitted_at);
  // event/story date (a schema field of kind 'date') — shown as "when it happened"
  const dateField = tenant.storySchema.fields.find(f => f.kind === 'date');
  const storyDateRaw = dateField && s.answers?.[dateField.id];
  const storyDate = storyDateRaw ? longDate(storyDateRaw) : null;

  /* ── 1. PERSON ────────────────────────────────────────────────
     Judy's order, 7 Aug: Person, Account, Evidence, Action. The header is the
     Person: who is speaking, where they are, and when it happened. Nothing
     else. Tags and storm chips used to live here too, which made the header a
     third thing competing with the story.

     Solid, not a gradient (Judy's call). The gradient also had a bug worth
     retiring: `future` rendered violet while its pin is blue.

     The solid colour is the story type's TINT with its `ink` for text, not a
     darkened version of the pin colour. Two reasons, both measured in REB-438:
     white text needs the hue dark enough to pass 4.5:1, and for the orange that
     is #AD651A, which is brown, and Judy has rejected brown before. The tint and
     ink pair is already measured at 4.55 to 4.66 against each other, so it is
     accessible without inventing a new colour. The raindrop keeps the true pin
     colour, so the header still says which type this is at full strength. */
  /* REB-463, Judy: "the header background for the name area needs editing since
     we moved away from story-type colours. Make it one colour specific to
     stories; it could be blue, something that helps it stand out."

     It was the type's own `tint` with its `ink`, so the header was the last
     place still saying "this is the orange kind of story". One colour now, and
     it is the deep story blue rather than the brand blue: brand blue against
     white measures 2.43:1 and fails, deep blue is 6.07:1. The values come from
     CSS variables `applyTheme` publishes from config, so this is not a hex
     typed into a template.

     The raindrop keeps the true brand blue. Its white outline and white glyph
     are what read against the deep blue, which is the same mark the map draws. */
  const tint = 'var(--story-blue-deep)';
  const ink = '#fff';
  const color = storyPinColor(tenant, s);   // the true pin colour, for the raindrop
  const glyph = storyIcon(tenant, s);
  /* 18 August, Judy: the header never got the card's own raindrop treatment
     — it was still 16px (REB-463, "to match the card and the pills"), from
     when the card's own avatar was that small too. The card moved to 40px
     rounds ago; this didn't move with it. Restructured to the same shape
     the card's own head uses (drop left, type-over-name stacked right)
     rather than left inline and tiny in the eyebrow row. Colour is
     unchanged — still the true brand blue against the deep-blue banner,
     white outline doing the separating, exactly as REB-463 decided; only
     the size and position moved. */
  const headHtml = `
    <div class="sp-head-top">
      ${typeOpt ? `<span class="sp-drop">${dropMark(color, 36, glyph)}</span>` : ''}
      <div class="sp-head-id">
        ${typeOpt ? `<div class="sp-type">${esc(typeOpt.label)}</div>` : ''}
        <div class="sp-name">${esc(byline(tenant, s))}${exampleBadge(tenant, s)}</div>
      </div>
    </div>
    ${isExample(tenant, s) && tenant.examples?.paneNote
      ? `<p class="sp-exnote">${esc(tenant.examples.paneNote)}</p>` : ''}
    <div class="sp-meta">
      ${s.location_label ? `<span class="sp-place">${icon('pin')}${esc(s.location_label)}</span><span class="sp-sep" aria-hidden="true">·</span>` : ''}
      ${storyDate ? `<span class="sp-place">${icon('calendar')}${esc(storyDate)}</span>` : `<span class="sp-date">${esc(dt)}</span>`}
    </div>`;

  /* ── 2. ACCOUNT ───────────────────────────────────────────────
     The resident's words, alone, directly under who said them.

     The cap is 5,000 characters now (REB-438), room for a transcribed
     five-minute account. At that length the story would push the media, the
     city's record and every action off the bottom of the pane, so a long one is
     clamped with a control to open it. The threshold is generous: most stories
     are nowhere near it and must not be interrupted by a button they do not
     need. Clamping is CSS, so the whole text is always in the DOM and a find on
     the page still hits it. */
  const storyBody = esc(storyText(tenant, s)).replace(/\n/g, '<br>');
  const isLong = storyText(tenant, s).length > 900;
  let bodyHtml = `<section class="sd-sec sd-account" data-sec="account">
    <p class="sp-text${isLong ? ' sd-clamp' : ''}" id="sdStoryText">${storyBody}</p>
    ${isLong ? '<button type="button" class="sd-more" data-readmore aria-expanded="false">Read the whole story</button>' : ''}
  </section>`;

  /* ── 3. EVIDENCE ──────────────────────────────────────────────
     What backs the account up: first what the resident brought, then what the
     city's own record says about the same half mile. The caller fills #sdCity.

     The city block is context and NEVER load-bearing: a Socrata outage makes it
     disappear silently, so this section has to still read as complete with only
     the resident's media in it, and as complete again with neither. */
  bodyHtml += '<section class="sd-sec sd-evidence" data-sec="evidence">';

  if (imgs.length) {
    /* First photo leads full-width so it gets the full-size file; the rest are
       a small grid, so they load thumbnails. The lightbox target is always the
       full image — a reader who taps to enlarge should get the real thing. */
    bodyHtml += `<div class="sp-gallery">${imgs.map((m, i) =>
      `<img class="sp-photo" src="${esc(i === 0 ? m.url : thumbOf(m))}" data-lightbox="${esc(m.url)}" loading="lazy" alt="" oncontextmenu="return false" draggable="false">`).join('')}</div>`;
  }
  if (vids.length) {
    /* controlsList/disablePictureInPicture remove Download and Picture-in-Picture
       from the browser's own ⋯ menu, and contextmenu blocks "Save video as".
       This is a speed bump on the obvious route, NOT protection: every object
       sits at a public URL in a public bucket, so anyone who opens the network
       tab still has the file. Worth doing because the ⋯ menu is what a casual
       reader finds, and not worth mistaking for a control. */
    bodyHtml += vids.map(m => `<video class="sp-video" controls playsinline controlsList="nodownload noplaybackrate" disablePictureInPicture oncontextmenu="return false"><source src="${esc(m.url)}"></video>`).join('');
  }
  if (auds.length) {
    bodyHtml += auds.map(m => `<div class="sp-audio-wrap">
        <div class="sp-audio-label">${icon('mic')} Voice note</div>
        <audio class="sp-audio" controls controlsList="nodownload" oncontextmenu="return false" src="${esc(m.url)}"></audio></div>`).join('');
  }
  if (docs.length) {
    bodyHtml += docs.map(m => `<a class="sp-doc" href="${esc(m.url)}" target="_blank" rel="noopener">${icon('file')}<span>${esc(m.name || 'Document')}</span></a>`).join('');
  }

  /* The city's own record for this half mile. Filled by the caller after the
     data arrives, and left hidden if it never does. Inside Evidence, next to
     the resident's media, because they are the same kind of claim from two
     sources. */
  bodyHtml += '<div class="sd-city" id="sdCity" hidden></div>';
  bodyHtml += '</section>';

  /* ── 4. ACTION ────────────────────────────────────────────────
     Everything a reader can DO, in one place. These used to be scattered: the
     locate button opened the pane, the tags sat mid-body, reactions and the
     copy link came after the city block, and "more nearby" was last. Four
     places asking "what now" is why the pane read as competing parts.

     The caller injects its own items into #sdActionExtra: the locate button on
     a phone, the reactions, the copy link and the nearby list. */
  bodyHtml += '<section class="sd-sec sd-action" data-sec="action">';

  // Tappable tags: storm + tags. Still filter the whole map.
  if (cats.length || eventOpt) {
    /* The storm badge used to be a solid filled pill beside the hashtags'
       plain green text -- two treatments for what reads as one kind of
       thing (18 August, Judy's audit). A calendar icon now does the
       distinguishing instead of a different fill. */
    bodyHtml += `<div class="sp-tags">
      ${eventOpt ? `<button type="button" class="sp-event" data-filterevent="${esc(eventOpt.id)}" title="See all ${esc(eventOpt.label)} stories">${icon('calendar', 12)}${esc(eventOpt.label)}</button>` : ''}
      ${cats.map(c => `<button type="button" class="sp-cat-badge" data-filtercat="${esc(c.id)}" title="See all ${esc(c.label)} stories">${esc(hashtag(c.label))}</button>`).join('')}
    </div>`;
  }

  /* Extra config-defined answers beyond the roles (custom questions).

     A field marked `internal` is collected and kept, and moderators still see it
     in the admin card and the CSV export, but it never appears on the public
     map. Tenure is the case this exists for: whether someone rents or owns is
     useful for matching a story to the right policy ask, and is nobody else's
     business on a public page. */
  const roleIds = new Set(Object.values(tenant.storySchema.roles || {}));
  for (const f of tenant.storySchema.fields) {
    if (f.internal) continue;
    if (roleIds.has(f.id) || f.kind === 'date') continue;   // dates render in the header
    const v = s.answers?.[f.id];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    const label = asArray(v).map(x => fieldOption(f, x)?.label || x).join(', ');
    bodyHtml += `<div class="sp-section-title">${esc(f.label)}</div>
      <p class="sp-text" style="font-size:.8rem">${esc(label)}</p>`;
  }

  // Public reachback: the resident chose to be contactable about this story.
  // Click-to-reveal (a mild speed-bump against bulk scraping); the value is
  // UGC and escaped. The caller wires the reveal after insertion.
  const reach = s.answers?.public_contact;
  if (reach) {
    bodyHtml += `<div class="sp-reach">
      <div class="sp-reach-t">${icon('user')} Get in touch</div>
      <p class="sp-reach-cap">This resident chose to be reachable about this story. Please be respectful.</p>
      <button type="button" class="sp-reach-btn" data-reveal>Show contact</button>
      <span class="sp-reach-val" hidden>${esc(reach)}</span>
    </div>`;
  }

  // The caller's action items land here: locate, reactions, copy link, nearby.
  bodyHtml += '<div id="sdActionExtra"></div>';
  bodyHtml += '</section>';

  /* Solid, per Judy. `headStyle` keeps its name and its contract so the caller
     does not change; only what it carries does. A tenant whose config predates
     `tint`/`ink` falls back to CSS variables rather than to an unreadable
     header, so no option can produce white-on-white by omission. */
  return {
    headStyle: `background:${tint};color:${ink}`,
    headHtml,
    bodyHtml,
  };
}

/* Partner report pane (MyCoast NY). Same shell as a story; the words are the
   reporter's, the links go back to the partner. Copy lives in the layer's
   `partner` block in config.json. */
const safeUrl = u => (/^https:\/\//.test(u || '') ? u : '');
export function partnerDetail(layer, p) {
  const c = layer.partner || {};
  const where = [p.place, p.hood].filter(Boolean).join(', ');
  const when = p.date ? longDate(p.date) : '';
  const mark = `<img src="${esc(layer.icon)}" alt="" width="28" height="37" style="display:block">`;
  const headHtml = `
    <div class="sp-head-top">
      <span class="sp-drop">${mark}</span>
      <div class="sp-head-id">
        <div class="sp-type">${esc(c.typeLabel || layer.label)}</div>
        <div class="sp-name">${esc(c.byline || '')}</div>
      </div>
    </div>
    <div class="sp-meta">
      ${where ? `<span class="sp-place">${icon('pin')}${esc(where)}</span>` : ''}
      ${where && when ? '<span class="sp-sep" aria-hidden="true">·</span>' : ''}
      ${when ? `<span class="sp-place">${icon('calendar')}${esc(when)}</span>` : ''}
    </div>`;

  let bodyHtml = p.text
    ? `<section class="sd-sec sd-account"><p class="sp-text">${esc(p.text).replace(/\n/g, '<br>')}</p></section>`
    : '';
  const img = safeUrl(p.img);
  const facts = [
    p.depth != null && p.depth !== '' && [c.depthLabel || 'Water depth', `${esc(p.depth)} ${esc(c.depthUnit || 'inches')}`],
    p.flooded && [c.floodedLabel || 'What flooded', esc(p.flooded)],
    p.rain24 != null && p.rain24 !== '' && [c.rainLabel || 'Rain in the 24 hours before', `${esc(p.rain24)} inches`],
  ].filter(Boolean);
  if (img || facts.length) {
    bodyHtml += '<section class="sd-sec sd-evidence">';
    if (img) bodyHtml += `<div class="sp-gallery"><img class="sp-photo" src="${esc(img)}" data-lightbox="${esc(img)}" loading="lazy" alt=""></div>`;
    if (facts.length) bodyHtml += `<dl class="sp-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
    bodyHtml += '</section>';
  }
  const report = safeUrl(p.url), tool = safeUrl(c.toolUrl);
  bodyHtml += `<section class="sd-sec sp-partner">
    ${c.credit ? `<p class="sp-partner-credit">${esc(c.credit)}</p>` : ''}
    <div class="sp-partner-links">
      ${report ? `<a class="sp-partner-btn" href="${esc(report)}" target="_blank" rel="noopener">${esc(c.reportLink || 'See this report')}</a>` : ''}
      ${tool ? `<a class="sp-partner-link" href="${esc(tool)}" target="_blank" rel="noopener">${esc(c.toolLink || 'Visit the partner')}</a>` : ''}
    </div>
  </section>`;
  return { headStyle: 'background:var(--story-blue-deep);color:#fff', headHtml, bodyHtml };
}
