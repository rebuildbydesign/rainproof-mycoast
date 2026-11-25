/* One-page submission form, rendered entirely from the tenant config.

   It was three steps until 19 August. Judy's ask: be transparent about what is
   being asked rather than reveal it a screen at a time, and make the whole
   thing more minimal. What that turned into:

   - one modal, two columns, in her order — name, email, location, story,
     tags, media, privacy
   - the four media tabs collapsed into ONE rectangle that takes photos,
     video, voice notes and documents, with the kind read off the file
   - the byline reduced from four radio cards with a paragraph each to a
     segmented control where every option is the byline it produces
   - phone and social handle dropped (the handle was never transmitted)
   - the privacy notice collapsible, with the consent checkbox outside it
   - every promise stated ONCE. The pin-rounding, EXIF-stripping, and
     never-published lines were each being made three or four times across
     field hints, status chips and the notice; they live in the notice now
     and the hints that echoed them are gone.

   Chips, tags, the byline, media and the consent tick all restyle IN PLACE
   rather than re-rendering. On a one-page form a re-render is expensive in ways
   it was not per-step: #fBody scrolls, so it resets the resident's position;
   it closes the privacy details; it destroys the live video-encoding warning;
   and it re-runs wireLocationBlock, which leaks a document click listener each
   time. render() still runs on open, on a resolved neighbourhood file, and on
   setPinLocation — all of which are before or outside typing.
*/
import { esc } from './ui.js';
import { asArray, dropMark, hashtag } from './ui/render.js';
import { storyBrandColor } from './config.js';
import { consentLevels, computeDisplayName, consentNeedsName, levelLabel } from './consent.js';
import { explainSubmitError } from './data.js';
import { getTurnstileToken } from './turnstile.js';
import { prepareFile, holdPage } from './media.js';
import { loadPlaces, neighbourhoodOptionsAt, placeNames } from './places.js';
import { icon } from './ui/icons.js';
import { geocodeNYC } from './geocode.js';

const $ = id => document.getElementById(id);

export function createForm(tenant, { api, platform, mode = 'map', source, stepOrder, onRequestPin, onLocationPicked, onSubmit, onDone, onClose }) {
  let answers = {};
  /* REB-487. First and last are separate fields now, and `name` is composed
     from them at submit — `story_contacts.full_name` is one column and the
     display-name rules read a single string, so splitting the INPUT without
     splitting the storage keeps both honest. Phone and social handle came off
     on 19 August: the handle was collected and never transmitted anywhere, and
     phone was optional and unread. */
  let contact = { first: '', last: '', name: '', email: '' };
  /* The explicit publication consent, required by NYU's compliance review and
     separate from `consent` below. `consent` is HOW MUCH of a resident's name
     travels with their story; this is WHETHER they agree it may be published at
     all. Nothing is submitted until it is true. */
  let agreed = false;
  let consent = 'anonymous';
  let mediaFiles = [];
  let pendingLat = null, pendingLng = null;
  // 17 August: the address typed into the location step, kept so it survives
  // a re-render — same reason pendingLat/pendingLng are held here rather than
  // read back off the DOM. Geocoder suggestion state, same shape as the
  // sidebar's (js/ui.js), a separate instance because the two live in
  // different DOM hosts.
  let pendingAddr = '';
  let geoResults = [], geoHi = -1, geoReq = 0, geoTimer = null;
  // Whether the neighbourhood currently in `answers` was filled from a pin
  // rather than typed, so the "edit it if it looks wrong" note survives a
  // re-render of the step it sits in.
  let autoHood = false;
  let audioRec = null, audioChunks = [], recTimer = null, recSecs = 0, isRec = false;
  let submitting = false;
  // One id per submission, minted at first attempt and reused on retries, so
  // a flaky connection can never file the same story twice.
  let submissionId = null;
  let successTimer = null;
  // Bumped by every reset/wipe/open. A submit() in flight captures the value
  // and bails after each await if it changed — so a kiosk idle-wipe mid-submit
  // can never post a ghost story or repaint the wiped screen.
  let generation = 0;

  /* The one colour a story wears, from config via the same accessor the map,
     the pane and the admin use (REB-463). Read once here rather than per render
     — it cannot change while the form is open. */
  const STORY_BLUE = storyBrandColor(tenant);
  const media = tenant.form?.media || { photo: true, video: true, audio: true };
  const mediaCap = tenant.form?.media?.maxItems || 10;
  const audioMaxSecs = tenant.form?.media?.limits?.audioMaxSeconds || 600;
  /* Shown while a video is being prepared. The browser's own unload prompt uses
     wording we cannot set, so this line has to carry the actual instruction. */
  const prepWarning = tenant.form?.media?.processingWarning
    || 'Please keep this page open and stay in the app — leaving will stop it.';
  /* Per-kind ceilings on top of the shared one. Video is capped because it is
     the expensive kind in every sense — storage, upload time on cellular, and
     the minutes someone has to spend watching it before it can be approved. */
  const perKind = tenant.form?.media?.maxPerKind || {};
  const kindCap = k => perKind[k] ?? mediaCap;

  /* The rules, said before somebody hits one. Every number here is read from
     the value that enforces it, so the sentence cannot drift from the limit —
     `videoHint` and `audioHint` in config were the old way and nothing ever
     rendered them. */
  /* TWO NUMBERS, NOTHING ELSE (Judy, 31 August).

     The previous line was accurate and unreadable: five limits in one grey 12px
     sentence, under two buttons, read by someone standing in a flooded street.
     Her objection to listing them at all is that "2 videos, 5 minutes each" asks
     a person to plan a submission before they have made one. Total files and
     size per file are the only two that change what someone does next.

     The per-kind limits are still enforced; they are just reported when they
     are actually reached, where prepareFile's messages already say what to do
     about it, instead of pre-emptively at everyone. */
  function mediaShortText() {
    const L = tenant.form?.media?.limits || {};
    const size = L.maxUploadBytes ? `, ${Math.round(L.maxUploadBytes / 1048576)} MB each` : '';
    return `Up to ${mediaCap} files${size}.`;
  }

  const countOf = k => mediaFiles.filter(f => f.kind === k).length;
  const kindFull = k => countOf(k) >= kindCap(k);
  const todayISO = new Date().toISOString().slice(0, 10);   // for date-field max

  /* A character count that only becomes a limit when someone is close to one.
     With the story cap at 5,000 for transcribed accounts, opening on "0/5000"
     tells a resident who wanted to write three sentences that they are 0.06%
     of the way to what is expected of them. */
  function charCount(len, cap) {
    if (!cap) return `${len}`;
    return len ? `${(cap - len).toLocaleString()} characters left` : '';
  }
  const locationEnabled = tenant.form?.location?.enabled !== false;
  // Set once the neighbourhood boundary file has landed; see wireLocationBlock.
  let placesReady = false;
  // `hidden` fields stay in the schema (so unhiding is flipping one flag,
  // not re-authoring the field) but never reach the form — 18 August, the
  // tenure question, on tester feedback that less is more.
  const mainFields = tenant.storySchema.fields.filter(f => (f.step || 'story') === 'story' && !f.hidden);
  const locFields = tenant.storySchema.fields.filter(f => f.step === 'location' && !f.hidden);
  // The neighbourhood field's id: the anonymous byline names the place the pin
  // landed in, so it has to read the same value the story stores.
  const hoodId = tenant.storySchema.roles?.locationLabel;
  /* `stepOrder` is still accepted so the engine's other tenants keep working,
     and ignored here: this form is one page (19 August). The step definitions
     it used to order are gone with it; tenant.form.groups names the sections
     instead. */

  function resetState() {
    generation++;
    answers = {};
    contact = { first: '', last: '', name: '', email: '' };
    // Never carried over. A kiosk wipe or a second submission has to be agreed
    // to on its own, by whoever is standing there now.
    agreed = false;
    consent = 'anonymous';
    mediaFiles.forEach(m => { try { URL.revokeObjectURL(m.url); } catch { /* already gone */ } });
    mediaFiles = [];
    pendingLat = pendingLng = null;
    pendingAddr = '';
    geoResults = []; geoHi = -1;
    autoHood = false;
    submitting = false;
    submissionId = null;
    clearTimeout(successTimer);
  }

  // Hard-stop the recorder WITHOUT keeping its blob — for the kiosk wipe, where
  // a late onstop must never push the previous participant's audio into the
  // next person's (freshly reset) mediaFiles.
  function discardRec() {
    clearInterval(recTimer);
    if (audioRec) {
      audioRec.onstop = null;
      try { if (audioRec.state !== 'inactive') audioRec.stop(); } catch { /* already stopped */ }
      try { audioRec.stream.getTracks().forEach(t => t.stop()); } catch { /* mic already released */ }
      audioRec = null;
    }
    isRec = false; recSecs = 0;
  }

  /* `at` is a location the resident has ALREADY given us — they tapped the map
     and confirmed "add your story here", or asked to add one near a story they
     were reading.

     It has to be applied after resetState() rather than before. Both those
     callers used to run `setPinLocation()` and then `open()`, and `resetState()`
     nulls `pendingLat`, so the pin was set and immediately thrown away: the map
     still showed the marker (that is the map's own state), the form did not
     know about it, and the story submitted with no coordinates at all. On a map
     whose whole point is where things happened. */
  function open(at) {
    resetState();
    if (at?.lat != null && at?.lng != null) {
      pendingLat = at.lat;
      pendingLng = at.lng;
    }
    render();
    $('formOverlay').classList.add('open');
    if (pendingLat != null) fillNeighbourhood(pendingLat, pendingLng).then(correctLocationStatus);
  }

  function close() {
    $('formOverlay').classList.remove('open');
    $('pinHint').classList.remove('show');
    stopRec();
    onClose?.();
  }

  /* Privacy wipe for kiosk handoffs: nothing from one participant — state,
     previews, typed contact info, recorded audio, or rendered DOM — survives
     to the next. discardRec() detaches the recorder so a late onstop can't
     resurrect the prior take; resetState() bumps `generation` so any submit()
     still awaiting a network call aborts instead of repainting this screen. */
  function wipe() {
    discardRec();
    resetState();
    $('fHead').innerHTML = '';
    $('fBody').innerHTML = '';
    $('fNav').innerHTML = '';
    $('formOverlay').classList.remove('open');
    $('pinHint').classList.remove('show');
  }

  /* ONE PAGE, two columns (19 August). The form was three steps; Judy's ask was
     to be transparent about what is being asked rather than reveal it a screen
     at a time, so everything is on one surface and nothing appears after you
     start. Reading order is the one she specified: name, email, location,
     story, tags, media, privacy.

     Left column is who and where, right column is the story and its tags, media
     takes a full-width band underneath (a drop target wants to be wide, and it
     otherwise left the left column ~250px shorter), and the byline, notice and
     consent run full width at the foot.

     `render()` repaints EVERYTHING, so it reads typed values back into state
     first — the inputs are about to be replaced. After the first paint almost
     nothing calls it: chips, tags, the byline and the consent tick all restyle
     in place, because a re-render on a one-page form throws away the caret of
     whoever is mid-sentence in the story box. */
  function render() {
    readContactInputs();
    const g = tenant.form?.groups || {};
    /* The ✕ is in the shell (index.html), not here. It used to be rendered into
       this header on every `render()`, which put it beside the heading rather
       than at the sheet's top-right corner where every other panel keeps one,
       and re-bound its listener each time. app.js wires `#fCloseX` once. */
    $('fHead').innerHTML = `<div class="sheet-head">
      <h2>${esc(tenant.cta?.share || 'Share Your Story')}</h2>
    </div>`;
    $('fBody').innerHTML = `
      <div class="err-msg" id="errForm"></div>
      <div class="form-cols">
        <div class="form-col form-col-l">
          ${sectionHtml(g.about || 'About You', contactHtml())}
          ${locationEnabled ? sectionHtml(g.where || 'Where It Happened', locationBlockHtml()) : ''}
          ${typeField ? sectionHtml(g.type || 'Story Type', fieldHtml(typeField, true)) : ''}
        </div>
        <div class="form-col">
          ${sectionHtml(g.story || 'What Happened', storyFieldsHtml())}
          ${tagsField ? sectionHtml(g.tags || 'Tags', fieldHtml(tagsField, true)) : ''}
        </div>
      </div>
      ${Object.values(media).some(Boolean)
        ? `<div class="form-band">${sectionHtml(
            `${esc(g.media || 'Media to Support It')} <span class="grp-opt">(optional)</span>`,
            mediaBlockHtml(), true)}</div>`
        : ''}
      <div class="form-foot">
        ${signatureHtml()}
        ${privacyHtml()}
      </div>`;
    $('fNav').innerHTML = `<button class="btn-nx" id="fNext">${esc(tenant.cta.submit)}</button>`;
    bindAll();
  }

  /* A titled block. The heading is the only text most groups get now — the
     per-field hints that used to sit under it were saying the same four
     promises the privacy notice already makes, four times over. */
  function sectionHtml(title, body, rawTitle = false) {
    return `<section class="form-sec">
      <h3 class="grp">${rawTitle ? title : esc(title)}</h3>
      ${body}
    </section>`;
  }

  function bindAll() {
    bindFieldEvents($('fBody'));
    if (locationEnabled) { wireLocationBlock(); paintNeighbourhood(); }
    bindContactEvents();
    bindSignatureEvents();
    bindMediaEvents();
    bindPrivacyEvents();
    $('fNext')?.addEventListener('click', () => submit());
  }

  // ── story fields ──────────────────────────────────────────────
  function fieldHtml(f, noLabel = false) {
    const v = answers[f.id];
    /* Drop the LABEL when the section heading above already says it. The hint
       is kept: it says something the heading does not, and reads fine directly
       under one. */
    const lbl = t => (noLabel ? '' : t);
    switch (f.kind) {
      /* The choice cards show the resident the mark their story will wear on the
         map, so the choice and its consequence look the same (REB-438's
         principle, REB-463's execution).

         What this used to be: four hues. Each option carried its own colour on
         a left bar and a swatch, its own `tint` as the selected background and
         its own `ink` for the label — the scheme the map retired in REB-455 and
         nothing else had caught up with. A resident picked an orange card and
         then found a blue pin.

         Now every card shows the same raindrop and the type is carried by the
         glyph inside it, exactly as on the map, the pills and the cards. All
         the colour reasoning that used to live in this comment is gone with the
         colours: one blue, one measured pairing, stated once in config. */
      case 'choice':
        return `${lbl(`<label class="flbl mb8">${esc(f.label)} ${f.required ? '<em>*</em>' : ''}</label>`)}
          <div class="types">${(f.options || []).map(o => {
            const sel = v === o.id;
            return `<button type="button" class="tc ${sel ? 'sel' : ''}" data-field="${f.id}" data-opt="${o.id}"
              aria-pressed="${sel}">
              <span class="tc-ico">${dropMark(STORY_BLUE, 40, o.icon)}</span>
              <span class="tc-name">${esc(o.label)}</span>
            </button>`;
          }).join('')}</div>`;
      /* Tags, and they sit under the story now (REB-439). Judy's call: blog post
         first, then tags. Asking someone to categorise before they have written
         makes them shape the account to fit a box, and ten long labels arriving
         mid-form was the "too much at once" complaint. The label is "Tags"
         because hashtags already taught everyone what that means, and the option
         labels are tag-length for the same reason — the ids are untouched, so
         nothing already stored has to move.

         The list stays fixed rather than free text: the map's filter chips read
         these values, so a typed tag would be a filter nobody can select. */
      case 'select-chips': {
        const on = f.multi ? id => asArray(v).includes(id) : id => v === id;
        /* The field the map filters on is the field the card prints as
           hashtags, so it looks like one here too — what you pick is what it
           becomes. Judy, 19 August. `hashtag()` is the card's own helper, so
           the two cannot drift, and it keeps the WHOLE label rather than
           squashing it to CamelCase, which she asked for back on 18 August. */
        const asTag = f.id === tenant.storySchema.roles?.filter;
        return `${lbl(`<label class="flbl mb8">${esc(f.label)} ${f.required ? '<em>*</em>' : ''}</label>`)}
          ${f.hint ? `<span class="fhint">${esc(f.hint)}</span>` : ''}
          <div class="cat-grid">${(f.options || []).map(o =>
            `<button type="button" class="fcat ${asTag ? 'tag' : ''} ${on(o.id) ? 'sel' : ''}" data-field="${f.id}" data-opt="${o.id}"${f.multi ? ' data-multi="1"' : ''}>
              ${o.emoji || ''} ${esc(asTag ? hashtag(o.label) : o.label)}</button>`).join('')}</div>`;
      }
      case 'date':
        return `${lbl(`<label class="flbl mb8">${esc(f.label)}</label>`)}
          ${f.hint ? `<span class="fhint">${esc(f.hint)}</span>` : ''}
          <input class="field mb12" type="date" data-input="${f.id}" value="${esc(v || '')}" max="${todayISO}" style="height:44px">`;
      /* Fields declaring `inlineWith: <this id>` share the row rather than
         stacking under it — the storm and the exact date are two ways to answer
         one question, so they read as a pair with an "or" between them and cost
         one row of height instead of two (REB-438). The schema has carried
         `inlineWith` since REB-426; only the chat intake honoured it, so on the
         stepped form the date sat underneath with its own heading. */
      case 'select': {
        const inlined = tenant.storySchema.fields.filter(x => x.inlineWith === f.id);
        const opts = `<option value="">${esc(f.placeholder || 'Choose one')}</option>`
          + (f.options || []).map(o => `<option value="${o.id}" ${v === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
        if (!inlined.length) {
          return `${lbl(`<label class="flbl mb8">${esc(f.label)} ${f.required ? '<em>*</em>' : ''}</label>`)}
            <select class="field mb8" data-input="${f.id}" style="height:44px">${opts}</select>`;
        }
        const sel = `<select class="field" data-input="${f.id}" style="height:44px">${opts}</select>`;
        return `${lbl(`<label class="flbl mb8">${esc(f.label)} ${f.required ? '<em>*</em>' : ''}</label>`)}
          ${f.hint ? `<span class="fhint">${esc(f.hint)}</span>` : ''}
          <div class="f-pair mb8">
            <div class="f-pair-i">${sel}</div>
            ${inlined.map(x => `<span class="f-pair-or">or</span>
              <div class="f-pair-i">
                <input class="field" type="date" data-input="${x.id}" value="${esc(answers[x.id] || '')}"
                  max="${todayISO}" aria-label="${esc(x.label || 'Date')}" style="height:44px">
              </div>`).join('')}
          </div>`;
      }
      /* The cap is 5,000 now, room for a transcribed five-minute account
         (REB-438). A box still sized for 600 would make a long answer feel
         unwelcome, so the rows follow the cap, and the count stays quiet until
         someone is actually near the limit — "0/5000" as an opening line reads
         as a demand rather than an allowance. */
      case 'longtext': {
        const cap = f.maxLength || 600;
        const rows = f.rows || (cap > 1500 ? 8 : 5);
        return `${lbl(`<label class="flbl mb8">${esc(f.label)} ${f.required ? '<em>*</em>' : ''}</label>`)}
          <textarea class="field mb8" data-input="${f.id}" rows="${rows}" maxlength="${cap}"
            placeholder="${esc(f.placeholder || '')}">${esc(v || '')}</textarea>
          <div class="chr" id="cc-${f.id}">${charCount((v || '').length, cap)}</div>`;
      }
      default: { // shorttext
        /* `suggest: "places"` turns the field into a native combobox backed by
           the NTA neighbourhood list. Still free text — someone can name a block
           or a housing development the city's boundaries do not — but anyone who
           picks from the list produces the same spelling as the pin lookup, so
           the map's Area filter groups them together instead of splitting
           "Bed-Stuy" from "Bedford-Stuyvesant". */
        const list = f.suggest === 'places' ? placeNames() : null;
        const listId = list?.length ? `dl-${f.id}` : null;
        return `${lbl(`<label class="flbl mb8">${esc(f.label)} ${f.required ? '<em>*</em>' : ''}</label>`)}
          ${f.hint ? `<span class="fhint">${esc(f.hint)}</span>` : ''}
          <input class="field mb4" id="f-${f.id}" data-input="${f.id}" placeholder="${esc(f.placeholder || '')}"
            value="${esc(v || '')}" style="height:44px"${listId ? ` list="${listId}" autocomplete="off"` : ''}>
          ${listId ? `<datalist id="${listId}">${list.map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist>` : ''}
          <p class="f-auto" id="f-${f.id}-auto" hidden></p>`;
      }
    }
  }

  function bindFieldEvents(container) {
    /* Restyles the buttons in place. This used to call render(), which was fine
       per-step and is not fine on one page: #fBody scrolls, so replacing its
       innerHTML threw the resident back to the top of the form every time they
       tapped a tag; it snapped the privacy details shut; it destroyed the live
       "Preparing your video — 42%, keep this page open" note mid-encode; and it
       re-ran wireLocationBlock, which adds a document-level click listener that
       is never removed, so every tag tap leaked one. */
    container.querySelectorAll('[data-field]').forEach(el =>
      el.addEventListener('click', () => {
        const fid = el.dataset.field, oid = el.dataset.opt;
        const selClass = el.classList.contains('fcat') ? 'fcat' : 'tc';
        if (el.dataset.multi) {
          const cur = asArray(answers[fid]);
          const on = cur.includes(oid);
          answers[fid] = on ? cur.filter(x => x !== oid) : [...cur, oid];
          el.classList.toggle('sel', !on);
          el.setAttribute('aria-pressed', String(!on));
        } else {
          answers[fid] = oid;
          container.querySelectorAll(`.${selClass}[data-field="${fid}"]`).forEach(o => {
            const on = o === el;
            o.classList.toggle('sel', on);
            o.setAttribute('aria-pressed', String(on));
          });
        }
      }));
    container.querySelectorAll('[data-input]').forEach(el =>
      el.addEventListener('input', () => {
        answers[el.dataset.input] = el.value;
        const cc = $(`cc-${el.dataset.input}`);
        if (cc) {
          const cap = +el.getAttribute('maxlength') || 0;
          cc.textContent = charCount(el.value.length, cap);
          cc.classList.toggle('near', cap > 0 && el.value.length >= cap * 0.9);
        }
        // A neighbourhood the resident types over is theirs, so the note saying
        // the map filled it in stops being true.
        if (autoHood && el.dataset.input === hoodId) {
          autoHood = false;
          const note = document.getElementById(`f-${el.dataset.input}-auto`);
          if (note) note.hidden = true;
        }
        // The anonymous byline names the neighbourhood, so it follows this box.
        if (el.dataset.input === hoodId) paintSignature();
      }));
  }

  /* The spark chips are gone (19 August). They worked by rewriting the story
     box's PLACEHOLDER, and Judy removed that placeholder — "remove placeholder
     text in the textfield" — so the mechanism had nothing left to write to.
     Their click handler had also died with the stepped renderer, leaving
     markup that did nothing when tapped. `promptPack` is still exported from
     config.js for any tenant that wants them back. */

  /* Tags get their own titled section in the right column, so they come out of
     the main run of story fields. Everything else stays in schema order. */
  const tagsField = mainFields.find(f => f.kind === 'select-chips' && f.multi);
  const typeField = mainFields.find(f => f.kind === 'choice');
  const longField = mainFields.find(f => f.kind === 'longtext');
  const storyFields = mainFields.filter(f => !f.inlineWith && f !== tagsField && f !== typeField);

  /* The story box goes first in its section, whatever order the schema lists.
     With the type cards moved to the left column, what was left in schema order
     was the storm/date pair ABOVE the box — asking someone when it happened
     before they have written a word. Same reason the tags sit under the story
     rather than over it (REB-439): make somebody answer metadata first and they
     shape the account to fit it. */
  function storyFieldsHtml() {
    const ordered = longField
      ? [longField, ...storyFields.filter(f => f !== longField)]
      : storyFields;
    return ordered.map(f => fieldHtml(f)).join('');
  }

  /* Contact. Phone and social handle came off on 19 August: the handle was
     collected and never transmitted anywhere (it only ever seeded the reachback
     box, which has since gone too), and phone was optional and unread. Name and
     email are the whole ask now. */
  function contactHtml() {
    return `<div class="fgrid2 mb12">
        <label class="fw"><span class="flbl">First Name <em>*</em></span>
          <input class="field" id="fn" autocomplete="given-name" value="${esc(contact.first)}" style="height:44px"></label>
        <label class="fw"><span class="flbl">Last Name</span>
          <input class="field" id="ln" autocomplete="family-name" value="${esc(contact.last)}" style="height:44px"></label>
      </div>
      <label class="fw"><span class="flbl">Email <em>*</em></span>
        <input class="field" id="em" type="email" autocomplete="email" required value="${esc(contact.email)}" style="height:44px"></label>`;
  }

  function bindContactEvents() {
    ['fn', 'ln', 'em'].forEach(id =>
      $(id)?.addEventListener('input', () => { readContactInputs(); paintSignature(); }));
  }

  /* Everything required, gathered in one pass. A one-page form has no step to
     stop you at, so the check runs at submit and names every missing thing at
     once rather than sending someone round the loop field by field. */
  function validateAll() {
    const missing = [];
    if (locationEnabled && tenant.form?.location?.required === true && pendingLat == null) {
      /* The field's own label is "Address, Intersection or Landmark", which
         reads badly inside a sentence. Name the thing, not the label. */
      missing.push('an address');
    }
    for (const f of mainFields) {
      if (f.required && !(answers[f.id] || '').toString().trim()) {
        missing.push(f.kind === 'choice' ? `a ${f.label.toLowerCase()}` : f.label.toLowerCase());
      }
    }
    return missing;
  }

  // ── media ─────────────────────────────────────────────────────
  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  /* ONE rectangle for every kind (19 August). It was a four-tab picker — Photo,
     Video, Voice, File — where three tabs were the same dashed box with a
     different icon and the fourth was a record button. Judy: it should be one
     placeholder that takes photos, videos, voice notes or files.

     The kinds are unchanged underneath; what a file IS is read from its MIME
     type instead of from which tab you happened to be on. Voice is the one
     thing that cannot be dropped, so recording stays as an explicit button —
     inside the same rectangle rather than behind a tab of its own. */
  const ACCEPT = { photo: 'image/*', video: 'video/*', audio: 'audio/*', document: 'application/pdf' };
  const acceptAttr = () => ['photo', 'video', 'audio', 'document']
    .filter(k => media[k]).map(k => ACCEPT[k]).join(',');

  /* A dropped or picked file names its own kind. `document` is the fallback so
     an unrecognised type is still offered to prepareFile, which does the real
     ceiling check and returns resident-facing copy if it cannot take it. */
  function kindOf(file) {
    const t = (file?.type || '').toLowerCase();
    if (t.startsWith('image/')) return 'photo';
    if (t.startsWith('video/')) return 'video';
    if (t.startsWith('audio/')) return 'audio';
    /* PDF only, not "anything else". The `accept` attribute is a hint for the
       picker and does nothing for a drop, and prepareFile checks a document's
       SIZE and nothing else — so a bare fallthrough here would take any file
       at all, which the four-tab version could not. */
    if (t === 'application/pdf') return 'document';
    return null;
  }

  /* The previews and the note sit OUTSIDE the rectangle, deliberately.

     `.upload-z.is-full` and `.upload-z.busy` both set `pointer-events: none`
     (core.css), which is right for the rectangle itself — a full or busy picker
     should not open. Putting the previews inside it meant every ✕ went dead at
     exactly the moment the label said "Remove one to add another", and again
     for the length of a video re-encode. That is a dead end with no way out but
     closing the form and losing the story. The old markup had `#pp`/`#vp`/`#dp`
     as siblings of the zone, which is why it never happened before.

     The privacy note IS inside, where Judy put it back on 19 August: it is
     static text with nothing to click, so the pointer-events rule costs it
     nothing, and it belongs with the picker it describes. */
  function mediaBlockHtml() {
    const full = mediaFiles.length >= mediaCap;
    return `<div class="upload-z one ${full ? 'is-full' : ''}" id="mediaZone">
        <span class="uz-ico">${icon('image', 26)}</span>
        <span class="uz-lbl">${full ? `${mediaCap} files added` : 'Add photos, video, audio or a PDF'}</span>
        <span class="uz-sub">${mediaSubText()}</span>
        <span class="uz-acts">
          <button type="button" class="uz-btn" id="pickBtn">${icon('image')} Choose Files</button>
          ${media.audio ? `<button type="button" class="uz-btn rec ${isRec ? 'on' : ''}" id="recBtn">
            ${isRec ? icon('stop') : icon('mic')} <span id="recLbl">${isRec ? `Stop · ${fmt(recSecs)}` : 'Record a Voice Note'}</span>
          </button>` : ''}
        </span>
        <p class="uz-rules">${esc(mediaShortText())}</p>
        ${media.privacyNote ? `<p class="uz-fine">${esc(media.privacyNote)}</p>` : ''}
      </div>
      <div class="prevs" id="mp">${mkPrevs()}</div>
      <input type="file" id="mi" accept="${esc(acceptAttr())}" multiple hidden>`;
  }

  /* One place, so a repaint and an in-place update cannot disagree about it. */
  function mediaSubText() {
    if (mediaFiles.length >= mediaCap) return 'Remove one to add another';
    return mediaFiles.length
      ? `${mediaFiles.length} of ${mediaCap} added`
      : 'Drop them here, or choose them below.';
  }

  function bindMediaEvents() {
    const zone = $('mediaZone');
    if (!zone) return;
    /* The buttons live inside the rectangle, so a click on one must not also
       open the file picker behind it. */
    zone.addEventListener('click', e => { if (!e.target.closest('.uz-btn')) $('mi').click(); });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      addFiles(e.dataTransfer.files);
    });
    $('pickBtn')?.addEventListener('click', () => $('mi').click());
    $('mi')?.addEventListener('change', e => addFiles(e.target.files));
    $('recBtn')?.addEventListener('click', toggleRec);
    bindPreviewRemoval();
  }

  /* Update the rectangle in place. Everything about media used to go through a
     full render(); on one page that would wipe the caret out of the story box
     every time a photo finished preparing, and rebuilding this block wholesale
     would take the status note and the file input down with it. */
  function syncMediaCount() {
    const zone = $('mediaZone');
    if (!zone) return;
    const full = mediaFiles.length >= mediaCap;
    zone.classList.toggle('is-full', full);
    const lbl = zone.querySelector('.uz-lbl'), sub = zone.querySelector('.uz-sub');
    if (lbl) lbl.textContent = full ? `${mediaCap} files added` : 'Drag Anything Here';
    if (sub) sub.textContent = mediaSubText();
  }

  /* The record button is the only part that changes while recording, so it is
     the only part that gets repainted — a whole-block repaint mid-take would
     detach the button the resident is about to press to stop. */
  function paintRecorder() {
    const b = $('recBtn');
    if (!b) return;
    b.classList.toggle('on', isRec);
    b.innerHTML = `${isRec ? icon('stop') : icon('mic')} <span id="recLbl">${
      isRec ? `Stop · ${fmt(recSecs)}` : 'Record a Voice Note'}</span>`;
  }

  /* How many files are mid-preparation, and how to wait for them. Photos finish
     in milliseconds; a video re-encode runs in real time, so this is the gap in
     which a resident can reach the submit button before their file exists. */
  let preparing = 0;
  let lastPrepTick = 0;   // a dead job stops ticking; submit uses this to give up
  const preparingWaiters = [];
  const preparingDone = () => (preparing === 0
    ? Promise.resolve()
    : new Promise(res => preparingWaiters.push(res)));
  function endPreparing() {
    preparing = Math.max(0, preparing - 1);
    if (preparing === 0) { preparingWaiters.splice(0).forEach(r => r()); }
  }
  /* Resolves when nothing has reported progress for PREP_SILENCE_MS, i.e. the
     job is dead. Backstop only: media.js settles on its own now. Before it did
     not, and a stalled clip left submit waiting forever (Nick, 25 Aug).

     60s, not 30s. Only a re-encode ticks; a video that is already lean skips
     that branch entirely and reports nothing while it probes (up to 19s) and
     grabs a poster (up to 16s). At 30s a healthy 35s prep looked dead and the
     story posted without the video, silently. This has to sit above every
     bounded wait in media.js, not near them. */
  const PREP_SILENCE_MS = 60000;
  const preparingStalled = () => new Promise(res => {
    const t = setInterval(() => {
      if (preparing === 0 || Date.now() - lastPrepTick > PREP_SILENCE_MS) { clearInterval(t); res(); }
    }, 1000);
  });

  /* One note under the picker: what we did to the file, or why we could not
     take it. There is one rectangle now, so there is one note — it used to be
     per kind so a photo message could not sit under the video picker, and that
     distinction went away with the tabs. Cleared on the next pick.

     `text` may carry a second line after \n — the "keep this page open"
     warning — rendered as its own element so the animated ellipsis can sit at
     the end of the STATUS line rather than after the warning. Both halves are
     set with textContent, never innerHTML. */
  function mediaNote(_kind, text, bad = false, busy = false, dots = false) {
    if (!$('mp')) return;
    let el = document.getElementById('mp-note');
    if (!el) {
      el = document.createElement('p');
      el.id = 'mp-note';
      el.className = 'media-note';
      el.innerHTML = '<span class="mn-main"></span><span class="mn-warn"></span>';
      $('mp').after(el);
    }
    const [main, warn = ''] = String(text || '').split('\n');
    el.querySelector('.mn-main').textContent = main;
    const w = el.querySelector('.mn-warn');
    w.textContent = warn;
    w.hidden = !warn;
    el.classList.toggle('bad', !!bad);
    el.classList.toggle('busy', !!busy);
    el.classList.toggle('dots', !!dots);   // animated ellipsis, drawn in CSS
    el.hidden = !text;
  }

  /* Files are prepared the moment they are chosen, not at submit.

     Three reasons it belongs here: the preview then shows what will actually be
     stored, a file we cannot accept is refused while the resident still has the
     picker open rather than after they have written their story, and the work
     overlaps with them typing instead of stalling the submit button.

     Video re-encoding runs in real time, so it reports progress and the picker
     is disabled while it works. */
  async function addFiles(files) {
    const list = Array.from(files);
    if (!list.length) return;
    mediaNote(null, '');

    const zone = $('mediaZone');
    zone?.classList.add('busy');
    const notes = [];
    try {
      for (const file of list) {
        /* One rectangle takes everything, so the kind comes off the file
           rather than off which tab was open. The recorder does not come
           through here — it writes its blob into mediaFiles directly. */
        const kind = kindOf(file);
        if (!kind) {
          notes.push({ text: `${file.name || 'That file'} is not a kind we can take. Photos, video, audio and PDFs only.`, bad: true });
          continue;
        }
        if (!media[kind]) {
          notes.push({ text: `This form does not take ${kind === 'document' ? 'that kind of file' : `${kind}s`}.`, bad: true });
          continue;
        }
        if (kind === 'audio') mediaFiles = mediaFiles.filter(f => f.kind !== 'audio');
        if (mediaFiles.length >= mediaCap) {
          notes.push({ text: `You can add up to ${mediaCap} files to a story.`, bad: true });
          break;
        }
        if (kindFull(kind)) {
          notes.push({ text: `You can add up to ${kindCap(kind)} ${kind}s to a story.`, bad: true });
          continue;
        }

        /* Preparing a video runs in real time, so a percentage on its own reads
           as a stall. Show the remaining time too, and say plainly that it is
           safe to keep filling the form — the submit button waits for this. */
        const startedAt = Date.now();
        const onProgress = kind === 'video'
          ? (p, phase, info) => {
              lastPrepTick = Date.now();   // proof this job is still alive
              /* Before the first frame is processed: say how long this will
                 take and that it is safe to keep filling the form. Jill lost a
                 story to 90 seconds of apparent nothing (REB-498). */
              if (phase === 'starting') {
                const secs = info?.seconds;
                const howLong = !Number.isFinite(secs) ? 'a moment'
                  : secs >= 90 ? `about ${Math.ceil(secs / 60)} minutes`
                  : `about ${Math.ceil(secs / 5) * 5} seconds`;
                mediaNote(kind, `Getting your video ready — this takes ${howLong}, `
                  + `and you can carry on writing while it runs\n${prepWarning}`, false, true, true);
                return;
              }
              /* The tail of a re-encode has no measurable progress, so it gets
                 words and an animated ellipsis rather than a number that stops
                 moving — a frozen "99%, about 1s left" reads as a hang and is
                 exactly when someone closes the page. The countdown is also
                 dropped below ten seconds, where it is noise. */
              if (phase === 'finishing') {
                mediaNote(kind, `Almost done — finishing your video\n${prepWarning}`, false, true, true);
                return;
              }
              const pct = Math.round(p * 100);
              const elapsed = (Date.now() - startedAt) / 1000;
              const left = p > 0.04 ? Math.ceil((elapsed / p) - elapsed) : null;
              const time = left == null ? 'starting'
                : left >= 60 ? `about ${Math.ceil(left / 60)} min left`
                : left > 10 ? `about ${left}s left`
                : 'nearly there';
              mediaNote(kind, `Preparing your video — ${pct}%, ${time}\n${prepWarning}`, false, true, true);
            }
          : null;

        /* Say something BEFORE the work starts, for every kind.

           The progress copy below only runs inside the re-encode branch, so
           every other slow path was silent: reading a video's metadata can take
           15 seconds and grabbing its poster frame another 8, and for all 23 of
           them the picker was greyed out with nothing on screen saying why.
           That is the same "apparent nothing" that cost REB-498 a story, just
           reached by a different road. Photos are quick and this will flash,
           which is the correct amount of feedback for something quick. */
        mediaNote(kind, kind === 'video'
          ? `Getting your video ready\n${prepWarning}`
          : `Getting your ${kind === 'document' ? 'file' : kind} ready`, false, true, true);

        preparing++;
        lastPrepTick = Date.now();
        // A video re-encode dies if the page unloads, so guard against leaving.
        const release = kind === 'video' ? holdPage() : null;
        let out;
        try {
          out = await prepareFile(file, kind, tenant.form?.media?.limits, onProgress);
        } finally {
          release?.();
          endPreparing();
        }

        if (!out.ok) { notes.push({ text: out.message, bad: true }); continue; }
        if (out.note) notes.push({ text: out.note, bad: false });
        mediaFiles.push({ kind, file: out.file, thumb: out.thumb, url: URL.createObjectURL(out.file) });
      }
    } finally {
      zone?.classList.remove('busy');
    }

    paintPrevs();
    syncMediaCount();
    // A rejection is what the resident most needs to see, so it wins the slot.
    const show = notes.find(n => n.bad) || notes[notes.length - 1];
    mediaNote(null, show?.text || '', show?.bad);
  }

  function paintPrevs() {
    if (!$('mp')) return;
    $('mp').innerHTML = mkPrevs();
    bindPreviewRemoval();
  }

  /* Every kind in one strip, in the order they were added, because they now
     arrive through one rectangle. The remove index is into `mediaFiles`
     itself — it used to be an index into a per-kind filtered copy, which only
     worked because each kind had its own container. */
  function mkPrevs() {
    return mediaFiles.map((f, i) => `
      <div class="pw">
        ${f.kind === 'photo'
          ? `<img class="p-img" src="${f.url}">`
          : f.kind === 'video'
            ? `<video class="p-vid" src="${f.url}" muted></video>`
            : f.kind === 'document'
              ? `<div class="p-file">${icon('file', 22)}<span>${esc((f.file?.name || 'PDF').slice(0, 12))}</span></div>`
              : `<div class="p-file">${icon('mic', 24)}<span>Voice</span></div>`}
        <div class="p-rm" data-rm="${i}">✕</div>
      </div>`).join('');
  }

  function bindPreviewRemoval() {
    $('fBody').querySelectorAll('[data-rm]').forEach(el =>
      el.addEventListener('click', e => {
        e.stopPropagation();   // the whole rectangle opens the picker
        const gone = mediaFiles[+el.dataset.rm];
        if (gone) { try { URL.revokeObjectURL(gone.url); } catch { /* already gone */ } }
        mediaFiles = mediaFiles.filter((_, i) => i !== +el.dataset.rm);
        paintPrevs();
        syncMediaCount();
      }));
  }

  let recFinalized = null; // resolves when the current recording's blob is stored
  async function toggleRec() {
    if (isRec) { await stopRec(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      // Let the browser pick a supported container (Safari/iOS produce mp4/aac,
      // not webm) and label the blob + upload accordingly.
      audioRec = new MediaRecorder(stream);
      recFinalized = new Promise(resolve => {
        audioRec.ondataavailable = e => { if (e.data.size) audioChunks.push(e.data); };
        audioRec.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          const type = audioRec.mimeType || 'audio/webm';
          const ext = /mp4|aac/.test(type) ? 'mp4' : /ogg/.test(type) ? 'ogg' : 'webm';
          const blob = new Blob(audioChunks, { type });
          const file = new File([blob], `voice.${ext}`, { type });
          /* Replace any previous take first, then respect the shared ceiling.
             This path never checked it: ten photos plus a recording made
             eleven files, which the picker refuses and the recorder allowed. */
          mediaFiles.filter(f => f.kind === 'audio')
            .forEach(f => { try { URL.revokeObjectURL(f.url); } catch { /* already gone */ } });
          mediaFiles = mediaFiles.filter(f => f.kind !== 'audio');
          if (mediaFiles.length >= mediaCap) {
            mediaNote(null, `You can add up to ${mediaCap} files to a story.`, true);
          } else {
            mediaFiles.push({ kind: 'audio', file, url: URL.createObjectURL(blob) });
          }
          isRec = false; recSecs = 0; clearInterval(recTimer);
          paintRecorder(); paintPrevs(); syncMediaCount();
          resolve();
        };
      });
      audioRec.start();
      isRec = true; recSecs = 0;
      /* Voice is where long-form testimony lives — someone telling their story
         in their own words, which at ~35 kbps costs about 2.5 MB for ten
         minutes. It still needs an end, or a phone left in a pocket uploads an
         hour of nothing, so the recorder stops itself at the cap rather than
         failing later. The timer counts toward the cap so the limit is visible
         while speaking, not a surprise at the end. */
      recTimer = setInterval(() => {
        recSecs++;
        const l = $('recLbl');
        if (l) l.textContent = `Stop · ${fmt(recSecs)} / ${fmt(audioMaxSecs)}`;
        if (recSecs >= audioMaxSecs) stopRec();
      }, 1000);
      paintRecorder();
    } catch {
      alert('Microphone access denied.');
    }
  }

  // Returns a promise that resolves once any in-flight recording is captured.
  async function stopRec() {
    if (audioRec && isRec) { audioRec.stop(); isRec = false; await recFinalized; }
    clearInterval(recTimer);
  }

  // ── location ──────────────────────────────────────────────────
  /* The address search and the neighbourhood field. Rendered either as its
     own step or at the top of the story step (REB-426), so it lives in one
     function and both hosts wire it the same way.

     17 August, REB-497/REB-507: this used to be "Drop a Pin" (tap the map)
     and "My Location" (GPS). Judy: dropping a pin confuses people — Michael's
     tester note was that the pin never visibly appeared — and GPS errored for
     Amy and most residents will not grant it anyway. Address search is the
     one way in now, the same geocoder the sidebar's address bar uses
     (js/geocode.js), so it autofills the neighbourhood exactly the way
     fillNeighbourhood() already did for a dropped pin. */
  function locationBlockHtml() {
    /* The pin is required from 7 Aug, on Judy's call: required is location,
       story type and story, everything else optional. A story with no
       coordinates cannot appear on a map, which is the whole product, and the
       rows that already have none came from the click-to-add bug fixed in
       24dee3e rather than from anyone choosing to withhold it. */
    const locReq = tenant.form?.location?.required === true;
    return `<label class="flbl mb8">${esc(tenant.form?.location?.label || 'Where did this happen?')} ${locReq ? '<em>*</em>' : ''}</label>
      <span class="fhint">${esc(tenant.form?.location?.hint || '')}</span>
      <div class="loc-addr-wrap">
        <input id="locAddrIn" type="text" class="field" placeholder="Search an address" autocomplete="off"
               value="${esc(pendingAddr)}" aria-expanded="false" aria-controls="locAddrSugg" role="combobox">
        <div class="addr-sugg" id="locAddrSugg" hidden></div>
      </div>
      <div class="loc-st ok" id="locSt" ${pendingLat ? '' : 'hidden'}>✓ Location set</div>
      <div style="margin-top:12px">${locFields.map(f => fieldHtml(f)).join('')}</div>`;
  }
  function wireLocationBlock() {
    /* Warm the boundary file on arrival, then repaint ONCE so the datalist is
       populated before anyone starts typing.

       The `placesReady` latch is load-bearing, not tidiness. loadPlaces()
       resolves truthy on every later call — it hands back the cached index —
       so an unguarded `.then(render)` re-runs this wiring, which calls
       loadPlaces again, which resolves again. That is an unbounded promise
       chain: it starves the event loop and the page stops responding to
       anything, which is exactly what the old Pin Location step did. */
    if (!placesReady) {
      loadPlaces().then(ok => {
        if (!ok) return;
        placesReady = true;
        /* The neighbourhood datalist needs a repaint once the boundary file
           lands. One page now, so there is no host step to compare against —
           the latch above is what stops this resolving into a render loop. */
        render();
      });
    }
    const input = $('locAddrIn');
    if (!input) return;
    input.addEventListener('input', () => {
      pendingAddr = input.value;
      clearTimeout(geoTimer);
      const q = input.value.trim();
      if (q.length < 3) { closeLocSugg(); return; }
      geoTimer = setTimeout(() => runLocGeocode(q), 300);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeLocSugg(); return; }
      if (!geoResults.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); geoHi = Math.min(geoHi + 1, geoResults.length - 1); paintLocSugg(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); geoHi = Math.max(geoHi - 1, 0); paintLocSugg(); }
      else if (e.key === 'Enter') { e.preventDefault(); pickLocSugg(geoHi >= 0 ? geoHi : 0); }
    });
    document.addEventListener('click', e => { if (!e.target.closest('.loc-addr-wrap')) closeLocSugg(); });
  }

  async function runLocGeocode(q) {
    const token = tenant.map?.mapboxToken;
    if (!token) return;
    const req = ++geoReq;
    try {
      const feats = await geocodeNYC(token, q);
      if (req !== geoReq) return;
      geoResults = feats;
      geoHi = -1;
      paintLocSugg();
    } catch (e) {
      if (req !== geoReq) return;
      console.error('geocode failed:', e);
      geoResults = [];
    }
  }

  function paintLocSugg() {
    const list = $('locAddrSugg'); if (!list) return;
    if (!geoResults.length) { closeLocSugg(); return; }
    list.innerHTML = geoResults.map((f, i) =>
      `<button type="button" class="addr-opt ${i === geoHi ? 'hi' : ''}" data-i="${i}">
         ${icon('pin', 14)}<span>${esc(f.place_name)}</span>
       </button>`).join('');
    list.hidden = false;
    $('locAddrIn')?.setAttribute('aria-expanded', 'true');
    list.querySelectorAll('.addr-opt').forEach(el =>
      el.addEventListener('click', () => pickLocSugg(+el.dataset.i)));
  }

  function closeLocSugg() {
    const list = $('locAddrSugg'); if (!list) return;
    list.hidden = true;
    list.innerHTML = '';
    geoResults = []; geoHi = -1;
    $('locAddrIn')?.setAttribute('aria-expanded', 'false');
  }

  /* Sets the pin without going through setPinLocation()/render() — the same
     discipline fillNeighbourhood()'s own comment warns about: re-rendering
     from inside an async continuation is how the old Pin Location step froze
     the page for days. Painting the status line and the field directly is
     the whole fix. */
  function pickLocSugg(i) {
    const f = geoResults[i]; if (!f) return;
    const [lng, lat] = f.center;
    pendingLat = lat; pendingLng = lng;
    pendingAddr = f.place_name;
    const input = $('locAddrIn'); if (input) input.value = f.place_name;
    closeLocSugg();
    onLocationPicked?.(lat, lng);          // moves the map's own pin here too
    const st = $('locSt');
    // hidden until there is something to say — see locationBlockHtml
    if (st) { st.className = 'loc-st ok'; st.textContent = '✓ Location set'; st.hidden = false; }
    fillNeighbourhood(lat, lng).then(correctLocationStatus);
  }

  function setPinLocation(lat, lng) {
    pendingLat = lat;
    pendingLng = lng;
    $('pinHint').classList.remove('show');
    $('formOverlay').classList.add('open');
    render();
    fillNeighbourhood(lat, lng).then(correctLocationStatus);
  }

  /* Name the neighbourhood from the point the resident just gave us.

     Two reasons this is worth doing rather than leaving the field blank: it is
     work they should not have to repeat when they have already shown us the
     spot, and a typed name is a free-text string, so "Bed-Stuy" and "Bedford-
     Stuyvesant" split what should be one place everywhere the map groups by it.

     Only ever fills an EMPTY field — someone who typed their own answer keeps
     it — and says where the value came from, so it reads as a suggestion rather
     than the form overruling them.

     This writes to `answers` whether or not the field is on screen (REB-437).
     It used to return early when the note element was missing, which meant the
     whole thing silently did nothing on the click-to-add path, because the form
     had not been rendered yet when it ran. Resolving into state and painting
     separately means the caller no longer has to care about render order. */
  /* Returns whether the point resolved to a neighbourhood — false only means
     "the boundary file has nothing here" (outside NYC, or a gap in the NTA
     polygons over water/parkland), not that the coordinates are bad. Callers
     use this to correct the "✓ Location set" status: capturing a lat/lng is
     not the same claim as finding what neighbourhood it is in, and painting
     both as one green checkmark is how REB-51x's silent-failure bug happened
     — Judy caught it 18 August testing a Yonkers address at the edge of the
     bbox (the box is a rectangle; NYC's border there is not, so a couple of
     blocks of Westchester geocode inside it). */
  async function fillNeighbourhood(lat, lng) {
    const f = locFields.find(x => x.id === tenant.storySchema.roles?.locationLabel);
    if (!f) return true;                                // no such field configured — nothing to resolve
    /* Capture the generation BEFORE awaiting. loadPlaces() can resolve after a
       reset — the kiosk wipe, or the resident closing and reopening the form —
       and without this the previous participant's neighbourhood would land in
       the next person's blank form. */
    const gen = generation;
    await loadPlaces();
    if (gen !== generation) return true;                // reset mid-flight — caller's context is gone

    const opts = neighbourhoodOptionsAt(lat, lng);
    const already = (answers[f.id] || '').trim();

    /* A SECOND ADDRESS HAS TO MOVE THE NEIGHBOURHOOD WITH IT.

       Correcting a mistyped address left the first address's neighbourhood
       sitting in the box, because the only test here was "is it already
       filled". `autoHood` is the difference and it was already being tracked
       for the note: true means we put the value there, false means the
       resident typed it. Ours is replaced, theirs is kept. */
    if (!opts.length) {
      // Off the boundary file now. A name we filled in is wrong rather than
      // stale, so it goes, and correctLocationStatus says so.
      if (autoHood) {
        delete answers[f.id];
        autoHood = false;
        paintNeighbourhood(f);
        return false;
      }
      return !!already;                                  // theirs — outside the city, but theirs
    }

    if (already && !autoHood && !opts.includes(already)) return true; // their own words win

    /* Judy, 7 Aug: fill it in, do not ask. A hyphenated NTA covers several
       neighbourhoods and the boundary genuinely cannot tell which one is meant,
       so this takes the first and leans on the field staying editable and on
       the note saying where the value came from. The picker that used to stand
       here was more accurate and cost every resident a decision they did not
       ask for. */
    answers[f.id] = opts[0];
    autoHood = true;
    paintNeighbourhood(f);
    return true;
  }

  /* Paints `#locSt` honestly once fillNeighbourhood's async lookup lands.
     Optimistic "✓ Location set" is what the click handler paints immediately
     (address search, like everything else in this step, should feel instant);
     this only ever downgrades it, and only if the step is still on screen. */
  function correctLocationStatus(resolved) {
    if (resolved) return;
    const st = $('locSt');
    if (!st) return;                                     // form was closed mid-lookup
    st.className = 'loc-st warn';
    st.hidden = false;
    st.textContent = "Address set, but we couldn't match a neighborhood here — add one below.";
  }

  /* Reflect a resolved neighbourhood into whatever is currently on screen.
     Deliberately does NOT call render(): the value is already in `answers`, and
     re-rendering from inside an async continuation is how the Pin Location step
     froze the page for days. */
  function paintNeighbourhood(f = locFields.find(x => x.id === hoodId)) {
    paintSignature();
    if (!f) return;
    const el = $(`f-${f.id}`);
    if (el) el.value = answers[f.id] || '';
    const note = document.getElementById(`f-${f.id}-auto`);
    if (!note) return;
    // Hide as well as show: the note used to be one-way, so clearing an
    // auto-filled name left "Filled in from your location" over an empty box.
    if (!autoHood) { note.hidden = true; return; }
    note.textContent = 'Filled in from your location — edit it if it looks wrong';
    note.hidden = false;
  }

  /* ── byline, consent + contact ────────────────────────────────
     REB-487, Judy's order: DETAILS FIRST, then how you appear, then whether
     neighbors may contact you.

     It used to open with "How should your story appear?" and reveal a name box
     underneath once you picked a level that needed one. That asks somebody to
     decide how much of themselves to attach before they have typed any of it,
     and it moves the page under them when they choose. Filling the boxes first
     and deciding afterwards is both calmer and more standard.

     First and last are separate inputs and always visible. `computeDisplayName`
     still takes one string, so they are composed before it sees them — which
     also makes "first name and initial" exact instead of a guess at where a
     space falls. */
  /* The byline, on one line (REB-505, 19 August).

     It was four radio cards with a paragraph of description each — the
     heaviest thing on the old step 3, and what both testers named when asked
     what to cut. Now it is a segmented control where each option is the byline
     it produces, plus a live "Appears as" line so nothing is abstract.

     `advocacy_only` is gone from the choices, per Judy's note on Nick's sheet.
     Anonymous survives as "A {neighborhood} Resident" — the route she decided
     on 17 August to keep — and is still the default, so the quietest option is
     the one you get by not choosing. */
  function signatureHtml() {
    const levels = consentLevels(tenant);
    const c = tenant.consent || {};
    return `<div class="sign-row">
      <span class="sign-lbl">${esc(c.question || 'Sign It')} <em>*</em></span>
      <div class="seg" id="signSeg">${levels.map(l => `
        <button type="button" data-consent="${esc(l.id)}" aria-pressed="${consent === l.id}"
          >${esc(signLabel(l))}</button>`).join('')}</div>
    </div>
    <p class="sign-hint" id="signHint" hidden></p>`;
  }

  /* Each option reads as the byline it produces, filled in from what they have
     typed: "Maria Torres" / "Maria T." / "A Red Hook Resident". Judy, 19
     August. Until there is a name to show, the generic config labels stand in,
     so the choice is still legible on an empty form. */
  function signLabel(level) {
    if (level.id === 'anonymous') return levelLabel(level, answers[hoodId] || '');
    return computeDisplayName(level.id, contact.name) || levelLabel(level, '');
  }

  /* Restyles in place. A re-render here would move the page under somebody at
     the moment they are deciding how their name travels with their story. */
  function paintSignature() {
    const seg = $('signSeg');
    if (!seg) return;
    const levels = consentLevels(tenant);
    seg.querySelectorAll('[data-consent]').forEach((b, i) => {
      b.setAttribute('aria-pressed', String(b.dataset.consent === consent));
      b.textContent = signLabel(levels[i]);
    });
    /* The two named options need a name to show. Said once, next to the choice
       that needs it, rather than as a permanent hint under the name boxes. */
    const hint = $('signHint');
    if (hint) {
      const needs = consentNeedsName(consent) && !contact.first.trim();
      hint.textContent = needs ? 'That choice shows your name, so add a first name above.' : '';
      hint.hidden = !needs;
    }
  }

  function bindSignatureEvents() {
    $('signSeg')?.querySelectorAll('[data-consent]').forEach(el =>
      el.addEventListener('click', () => { consent = el.dataset.consent; paintSignature(); }));
    paintSignature();

  }

  function bindPrivacyEvents() {
    /* Restyles in place rather than re-rendering: a re-render here would move
       the page under somebody at the exact moment they are agreeing to it. */
    $('pnOk')?.addEventListener('change', e => {
      agreed = e.target.checked;
      $('pnBox')?.querySelector('.pn-agree')?.classList.toggle('sel', agreed);
      if (agreed) $('errForm')?.classList.remove('show');
    });
  }

  // Read every contact input in one place, so a re-render can never drop a box.
  function readContactInputs() {
    contact.first = $('fn')?.value ?? contact.first;
    contact.last = $('ln')?.value ?? contact.last;
    contact.email = $('em')?.value ?? contact.email;
    contact.name = [contact.first, contact.last].map(x => x.trim()).filter(Boolean).join(' ');
    // Picking a consent level re-renders the whole step, so a tick already
    // given has to survive it. Read here for the same reason the boxes are.
    agreed = $('pnOk')?.checked ?? agreed;
  }

  /* The public-reachback opt-in is gone (19 August, Judy). It offered to
     publish a contact ON the story so neighbours could reach the resident —
     the only field on the form that made something public which nothing else
     did, and an extra decision on a form the whole round was about shortening.
     `answers.public_contact` is therefore never set now. The config block
     (tenant.form.reachback) and the admin's handling of existing values are
     left alone, so the stories that already carry one still render. */

  /* The publication notice and its consent checkbox.

     Required by NYU's provost office compliance review, August 2026. Three
     things have to be said in plain language before somebody sends anything:
     that the story and the pin become public, that contact details do not, and
     how to get something taken down. The full version lives at privacy.html;
     this is the short one, at the moment of the decision, where it is actually
     read.

     Copy is config-driven like the rest of the form (tenant.consent.privacy) so
     it can be corrected without a code change. The defaults here are safe but
     unreviewed — config.json is the one that ships. */
  function privacyHtml() {
    const p = tenant.consent?.privacy || {};
    const points = Array.isArray(p.points) && p.points.length ? p.points : [
      'Your story, the pin you place and any photos you add are published on a public map after review.',
      'Your pin is rounded to about a block. We never publish an exact address.',
      'Your contact details are only so the team can reach you. They are never published.',
      'You can ask us to fix or take down your story at any time.',
    ];
    const email = tenant.org?.privacyEmail;
    const href = p.linkHref || 'privacy.html';
    /* Collapsible as of 19 August, and the consent checkbox stays OUTSIDE it.

       That split is what keeps this compliant while shortening it. REB-12's
       requirement is that a resident can read what happens to their story
       before they send it, not that six sentences are permanently on screen —
       the summary line here states the four promises the notice makes, the
       checkbox carries the load-bearing claim in full and is never collapsed,
       and the six sentences are one click away and open in place. Collapsing
       the CHECKBOX would break the requirement; collapsing the detail does
       not. If the provost office reviewed exact placement rather than
       substance, this is the line to revisit. */
    return `<div class="pn" id="pnBox">
      <details class="pn-more-wrap">
        <summary class="pn-sum">
          <span class="pn-ico">${icon('lock')}</span>
          <span class="pn-sum-t">${esc(p.heading || 'What Happens to Your Story')}
            <small>${esc(p.summary
              || 'It goes on a public map after the team reads it. Your pin is rounded to a block, photos have their location data stripped, and your contact details are never published.')}</small>
          </span>
          <span class="pn-caret">${icon('chevron')}</span>
        </summary>
        <div class="pn-in">
          <ul class="pn-list">${points.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
          <p class="pn-more">
            <a href="${esc(href)}" target="_blank" rel="noopener">${esc(p.linkLabel || 'Read the full privacy notice')}</a>${
            email ? ` &middot; ${esc(p.contactLead || 'Questions, corrections or removals:')} <a href="mailto:${esc(email)}">${esc(email)}</a>` : ''}
          </p>
        </div>
      </details>
      <label class="pn-agree ${agreed ? 'sel' : ''}">
        <input type="checkbox" id="pnOk" ${agreed ? 'checked' : ''}>
        <span>${esc(p.checkbox || 'I have read this. I agree my story, my pin and any photos I add can be published on a public map.')} <em>*</em></span>
      </label>
    </div>`;
  }

  // ── submit ────────────────────────────────────────────────────
  /* Column ceilings, mirrored from js/admin-edit.js. Returns the sentence to
     show, or null when everything fits. */
  const COL = { answers: 20000, display_name: 120, location_label: 200, contact_full_name: 160, contact_email: 200 };

  function sizeProblem() {
    const storyField = mainFields.find(f => f.kind === 'longtext');
    const storyText = String(answers[storyField?.id] || '');
    if (storyField?.maxLength && storyText.length > storyField.maxLength) {
      return `Your story is ${storyText.length.toLocaleString()} characters and the limit is `
        + `${storyField.maxLength.toLocaleString()}. Please shorten it.`;
    }
    const hoodId = tenant.storySchema.roles?.locationLabel;
    if (hoodId && String(answers[hoodId] || '').length > COL.location_label) {
      return `That neighborhood name is too long — please keep it under ${COL.location_label} characters.`;
    }
    const name = String(contact.name || '').trim();
    if (name.length > COL.contact_full_name) return 'That name is too long. Please shorten it.';
    // computeDisplayName returns NULL at the anonymous level — there is no
    // byline to measure. Nothing here may assume a string.
    if (String(computeDisplayName(consent, name) || '').length > COL.display_name) {
      return 'That name is too long to show on the map. Please shorten it, or choose the anonymous option.';
    }
    if (String(contact.email || '').trim().length > COL.contact_email) {
      return 'That email address is too long. Please check it.';
    }
    // Bytes, not characters: this is what the database measures.
    if (new Blob([JSON.stringify(answers)]).size > COL.answers) {
      return 'Your story is too long to store. Please shorten it and try again.';
    }
    return null;
  }

  function showError(text) {
    const err = $('errForm');
    if (!err) return;
    err.innerHTML = esc(text);
    err.classList.add('show');
  }

  function restoreSubmitBtn() {
    submitting = false;
    const btn = $('fNext');
    if (btn) { btn.disabled = false; btn.textContent = tenant.cta.submit; }
  }

  /* One upload failed. Be honest and keep the resident in control: retry the
     upload, or send the story without that file — never a dead end. */
  function mediaFailure(m) {
    restoreSubmitBtn();
    const err = $('errForm');
    err.innerHTML = `${esc(`Your ${m.kind} couldn’t be uploaded. Your story is still here — you can try again or send it without the ${m.kind}.`)}
      <div class="err-actions">
        <button type="button" class="err-btn" id="errRetry">Try again</button>
        <button type="button" class="err-btn ghost" id="errDrop">Send without ${esc(m.kind)}</button>
      </div>`;
    err.classList.add('show');
    $('errRetry').addEventListener('click', () => { err.classList.remove('show'); submit(); });
    $('errDrop').addEventListener('click', () => {
      mediaFiles = mediaFiles.filter(f => f !== m);
      err.classList.remove('show');
      submit();
    });
  }

  async function submit() {
    if (submitting) return;
    await stopRec(); // capture any recording still running, and release the mic
    /* A file is not in `mediaFiles` until preparation finishes, and preparing a
       five minute video takes five minutes. Submitting mid-way would post the
       story without it and say nothing — the resident would believe their video
       was sent. Wait for it instead, and say why the button is waiting. */
    if (preparing > 0) {
      const btn = $('fNext');
      const restore = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Finishing your video…';
      await Promise.race([preparingDone(), preparingStalled()]);
      btn.disabled = false;
      btn.textContent = restore;
      // Backstop won: say the file is not coming rather than post as if it were.
      if (preparing > 0) mediaNote(null, 'Your video could not be prepared in time, so it is not attached. Send the story, then add it again.', true);
    }
    readContactInputs();
    /* One page means no step boundary to stop anyone at, so the story fields
       and the pin are checked here alongside the contact ones. Everything
       missing is named at once rather than sending somebody round the loop a
       field at a time. */
    const missing = validateAll();
    if (missing.length) {
      showError(missing.length === 1
        ? `Please add ${missing[0]}.`
        : `Please add ${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}.`);
      $('fBody')?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (consentNeedsName(consent) && !contact.first.trim()) {
      showError('Please add your first name, or choose the anonymous option.');
      $('fn')?.focus();
      return;
    }
    /* EMAIL IS REQUIRED. Judy, 12 August, restoring the 7 August rule after
       briefly lifting it earlier the same day: it is required going forward.

       Checked here rather than left to the browser because the field lives in a
       div and not a <form>, so `required` alone would never fire. Format is
       checked loosely on purpose: the job is catching a typo or an empty box,
       not adjudicating what a valid address looks like. */
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim())) {
      showError(contact.email.trim()
        ? 'That email address does not look right. Please check it.'
        : 'Please add an email address so we can follow up. It is never shown publicly.');
      $('em')?.focus();
      return;
    }
    /* The publication consent. Last check before anything is sent, and there is
       no path around it: `agreed` resets on every wipe and is read back on
       every re-render, so it can only be true because somebody ticked it on
       this submission. */
    if (!agreed) {
      showError(tenant.consent?.privacy?.error || 'Please tick the box to say you agree your story can be published.');
      $('pnOk')?.focus();
      $('pnBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    /* The database's own column limits, checked here so a resident is told
       which box is too long instead of watching an upload finish and then
       getting "your submission is too large".

       `maxlength` on the inputs is not enough and was only on the story box
       anyway: dictation and some autofills write past it, and the answers
       ceiling is a BYTE count, so 5,000 characters of emoji clears the
       character limit and fails the column. The numbers match `LIMITS` in
       js/admin-edit.js — the same columns, so the same ceilings. */
    const tooLong = sizeProblem();
    if (tooLong) { showError(tooLong); return; }

    submitting = true;
    submissionId ||= crypto.randomUUID();
    const gen = generation; // if a kiosk wipe bumps this mid-submit, bail out
    const btn = $('fNext');
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    // Uploads first, one at a time; already-uploaded files are not re-sent on
    // a retry, so a second attempt only redoes what actually failed.
    const uploaded = [];
    for (const m of mediaFiles) {
      if (!m.remote) {
        btn.textContent = `Uploading ${m.kind}...`;
        try {
          m.remote = await api.uploadMedia(m.file, m.kind, m.thumb);
        } catch (e) {
          if (gen !== generation) return;
          console.error(e);
          mediaFailure(m);
          return;
        }
      }
      if (gen !== generation) return; // wiped mid-upload — abandon this submit
      uploaded.push(m.remote);
    }

    try {
      let turnstileToken = null;
      if (platform?.turnstile?.siteKey) {
        btn.textContent = 'One moment…';
        /* Say what the wait is for. The widget is invisible to almost everyone,
           so "One moment…" over a disabled button was the only thing on screen
           whether the check took a second or never answered at all. */
        turnstileToken = await getTurnstileToken(platform.turnstile.siteKey, tsBox(), state => {
          if (gen !== generation) return;
          if (state === 'interactive') {
            btn.textContent = 'Waiting for the check';
            tsNote('Please complete the check below, then your story will send.');
          } else if (state === 'slow') {
            tsNote('Still checking you are human. This is us, not you — give it a moment.');
          }
        });
        tsNote('');
      }
      if (gen !== generation) return;
      btn.textContent = 'Submitting...';
      // The reachback field was removed on 19 August, so nothing on this form
      // can set a public contact. Deleted rather than left, in case a value
      // ever survives a reset.
      delete answers.public_contact;
      const locationField = locFields[0];
      await onSubmit({
        id: submissionId,
        consentLevel: consent,
        displayName: computeDisplayName(consent, contact.name),
        answers,
        lat: pendingLat,
        lng: pendingLng,
        locationLabel: locationField ? answers[locationField.id] || null : null,
        media: uploaded,
        source,
        turnstileToken,
        contact: {
          // Composed from the two inputs; `story_contacts.full_name` is one column.
          full_name: contact.name.trim() || null,
          email: contact.email.trim() || null,
        },
      });
      if (gen !== generation) return; // participant walked away; don't repaint
      showSuccess();
    } catch (e) {
      if (gen !== generation) return;
      console.error(e);
      restoreSubmitBtn();
      showError(explainSubmitError(e).text);
    }
  }

  /* Turnstile needs a live element to render into. It goes at the end of the
     footer band, so a challenge appears with the consent tick and the submit
     button rather than at the bottom of a page the resident has scrolled past.
     (It used to append to #fBody, which on the stepped form WAS the consent
     step; on one page that put it below everything.) */
  /* A line beside the captcha, not in #errForm: nothing has gone wrong yet, and
     an error-styled box is its own small alarm. Cleared when the token lands. */
  function tsNote(text) {
    const box = $('tsBox');
    if (!box) return;
    let el = document.getElementById('tsNote');
    if (!el) {
      el = document.createElement('p');
      el.id = 'tsNote';
      el.className = 'ts-note';
      box.before(el);
    }
    el.textContent = text || '';
    el.hidden = !text;
  }

  function tsBox() {
    let box = $('tsBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'tsBox';
      box.className = 'ts-box';
      ($('fBody')?.querySelector('.form-foot') || $('fBody')).appendChild(box);
    }
    return box;
  }

  function showSuccess() {
    const ref = submissionId.slice(-6).toUpperCase();
    const kiosk = mode === 'kiosk';
    /* The email sentence names the address back to them, so it only runs when
       there is one. Email is required on the public form, so this is really the
       kiosk case — and a kiosk must not leave somebody's address on screen for
       the next person anyway. */
    const showEmail = !!contact.email && !kiosk;
    $('fHead').innerHTML = '';
    $('fBody').innerHTML = `
      <div class="success-wrap">
        <span class="s-ico">${icon('check', 44)}</span>
        <h3>${esc(tenant.cta.successTitle || 'Story submitted!')}</h3>
        <p>${esc(tenant.cta.successBody || 'Thank you for sharing. The team will review your story before it appears publicly.')}</p>
        ${showEmail ? `<p>${esc(tenant.cta.successEmail || 'We will email you at {email} once it is published.')
            .replace('{email}', contact.email)}</p>` : ''}
        <p class="s-ref">${esc(tenant.cta.successRefLead || 'Your story reference is')} <strong>#${ref}</strong></p>
        ${kiosk ? `<p class="s-handoff">Please hand the device back — this screen clears itself for the next person.</p>` : ''}
      </div>`;
    $('fNav').innerHTML = `<button class="btn-nx" id="fDone">Done</button>`;
    $('fDone').addEventListener('click', () => { close(); onDone?.(); });
    if (kiosk) {
      // Never leave a finished submission (with a visible email) on screen.
      successTimer = setTimeout(() => { close(); onDone?.(); }, 30_000);
    }
  }

  return { open, close, wipe, setPinLocation, get pending() { return { lat: pendingLat, lng: pendingLng }; } };
}
