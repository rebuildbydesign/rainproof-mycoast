/* Supabase data access. Plain PostgREST/GoTrue/Storage fetch — no SDK.
   The publishable key is safe to ship to the client; row-level security
   is the actual boundary (see supabase/migrations/001_init.sql). */

/* Storage validates the Content-Type against the bucket's allowed list and
   compares the WHOLE header, so any codecs parameter is a rejection:

     video/webm;codecs=vp9,opus  -> 415 InvalidMimeType
     video/webm                  -> 200

   MediaRecorder always hands back a parameterised type, and media.js sets the
   re-encoded File's `type` to exactly that string, so every video that went
   through the re-encode has been failing to upload since the pipeline shipped.
   Audio recordings carry audio/webm;codecs=opus and failed the same way.

   Clips small enough to skip the re-encode kept their original video/mp4 or
   video/quicktime and uploaded fine, which is why this looked like an iOS
   problem rather than a bucket problem: it fails on every browser, but only for
   files big enough to be re-encoded.

   Strip parameters and keep the essence. The codecs hint is optional metadata
   for playback, not part of the type. */
/* The storage bucket enforces an allowed-MIME list and answers 415 to anything
   off it, which reaches the resident as "couldn't be uploaded" with no way to
   act on it. Two normalizations keep real files off that path.

   The `;codecs=` parameter first: MediaRecorder hands back `video/mp4;codecs=
   avc1`, and the bucket matches the whole string, so the parameter has to go.

   Then `audio/x-m4a`. It is the same MP4 container as `audio/mp4`, which the
   bucket does take, and which OS reports which name is not something a resident
   can control — an iPhone voice memo arrives as one or the other depending on
   the browser. Audio is the one kind we never re-encode, so whatever name the
   file came with is the name that goes up. Measured against the live bucket on
   19 August: `audio/mp4` accepted, `audio/x-m4a` rejected, same bytes. */
const MIME_ALIAS = { 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4' };

export function uploadContentType(file, kind) {
  const fallback = { photo: 'image/jpeg', video: 'video/mp4', audio: 'audio/webm', document: 'application/pdf' };
  const essence = String(file?.type || '').split(';')[0].trim().toLowerCase();
  return MIME_ALIAS[essence] || essence || fallback[kind] || 'application/octet-stream';
}

export function createApi(platform, tenant) {
  const base = platform.supabaseUrl;
  const key = platform.publishableKey;
  let tenantId = null;

  const headers = (token) => ({
    apikey: key,
    Authorization: `Bearer ${token || key}`,
    'Content-Type': 'application/json',
  });

  async function rest(path, opts = {}, token) {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      ...opts,
      headers: { ...headers(token), ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`);
    }
    if (res.status === 204 || opts.headers?.Prefer === 'return=minimal') return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async function resolveTenantId() {
    if (tenantId) return tenantId;
    const rows = await rest(`tenants?slug=eq.${encodeURIComponent(tenant.slug)}&select=id`);
    if (!rows?.length) throw new Error(`tenant '${tenant.slug}' not found in database`);
    tenantId = rows[0].id;
    return tenantId;
  }

  async function fetchApprovedStories() {
    const tid = await resolveTenantId();
    return rest(
      `stories?tenant_id=eq.${tid}&status=eq.approved` +
      `&select=id,display_name,consent_level,answers,lat,lng,location_label,media,submitted_at` +
      `&order=submitted_at.desc&limit=500`
    );
  }

  /* "Me too" engagement counts (see supabase/migrations/002_story_reactions.sql).
     Returns a { [story_id]: count } map. Resolves to {} — never throws — when
     the feature table doesn't exist yet, so the UI simply shows no counters
     until the migration is run. `enabled` tells the caller whether the backend
     is provisioned (so it can hide the buttons entirely pre-migration). */
  async function fetchReactions() {
    const tid = await resolveTenantId();
    try {
      const rows = await rest(`story_reactions?tenant_id=eq.${tid}&select=story_id,me_too_count`);
      const map = {};
      (rows || []).forEach(r => { map[r.story_id] = r.me_too_count; });
      return { enabled: true, counts: map };
    } catch (e) {
      // 404 / PGRST205 (relation missing) → feature not provisioned yet.
      return { enabled: false, counts: {} };
    }
  }

  /* Register one "me too" on an approved story. Returns the new total.
     The device-level dedup lives in the client (localStorage); the server
     just counts, so this is intentionally simple. */
  async function bumpReaction(storyId) {
    const res = await rest('rpc/bump_story_reaction', {
      method: 'POST',
      body: JSON.stringify({ p_story_id: storyId }),
    });
    // PostgREST returns the scalar function result directly.
    return typeof res === 'number' ? res : (res?.[0] ?? null);
  }

  /* Write one file into the tenant's storage folder and return its public URL.
     `suffix` distinguishes derivatives of the same pick, so a photo's thumbnail
     lands beside it rather than overwriting it. */
  async function putObject(file, kind, suffix = '') {
    const extByKind = { photo: 'jpg', video: 'mp4', audio: 'webm', document: 'pdf' };
    const nameExt = (file.name || '').split('.').pop()?.toLowerCase();
    const ext = (nameExt && nameExt.length <= 5 ? nameExt : null) || extByKind[kind] || 'bin';
    const path = `${tenant.slug}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}${suffix}.${ext}`;
    const res = await fetch(`${base}/storage/v1/object/story-media/${path}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': uploadContentType(file, kind),
      },
      body: file,
    });
    if (!res.ok) throw new Error(`media upload failed: ${res.status} ${await res.text()}`);
    return `${base}/storage/v1/object/public/story-media/${path}`;
  }

  /* Photos ship as two objects: the display image and a small thumbnail the
     card and gallery lists load instead. Those lists render every story's lead
     image at once, so serving full-size there is what actually spends the
     storage egress budget (see REB-407).

     The thumbnail is best-effort. If it fails to upload we keep the story
     rather than the optimisation — readers fall back to the full image, which
     is exactly what happens for media that predates this pipeline. */
  async function uploadMedia(file, kind, thumb) {
    const url = await putObject(file, kind);
    const out = { url, kind };
    if (thumb) {
      try {
        out.thumb = await putObject(thumb, kind, '-thumb');
      } catch (e) {
        console.warn('thumbnail upload failed, falling back to full image:', e);
      }
    }
    // documents keep their filename so the story can label the download
    if (kind === 'document' && file.name) out.name = file.name;
    return out;
  }

  /* Generalize a pin to roughly a block before it is ever stored.

     A resident who taps "use my location" hands us their GPS fix, which at a
     flooded home IS their home address. `stories_public_read` lets anyone
     select any column of an approved row, so an exact lat/lng on that row is
     published whether or not the map draws it that way. RLS is row-level and
     cannot hide a column, so the precision has to be given up here rather than
     hidden later.

     Three decimal places is about 111m north-south and 84m east-west at New
     York's latitude, so a pin lands in a cell about the size of a block. The
     map draws stories at neighbourhood zoom and the half-mile panel is 805m
     wide, so nothing on screen can tell the difference.

     The database rounds again in a trigger (migration 007). This copy is what
     keeps the exact fix from crossing the network at all; the trigger is what
     holds if somebody posts to PostgREST directly. Neither is redundant.

     NOTE: this is lossy and deliberately so. There is no exact copy kept
     anywhere — not in story_originals, which captures the row as it arrived
     and so captures the rounded value too. */
  const PIN_DP = 3;
  function generalize(lat, lng) {
    const snap = v => (Number.isFinite(v) ? Math.round(v * 10 ** PIN_DP) / 10 ** PIN_DP : v);
    return { lat: snap(lat), lng: snap(lng) };
  }

  /* Submit a story (always lands as 'pending'; moderation is not optional).
     PII goes to the quarantined story_contacts table, never to stories.

     The caller supplies `id` (crypto.randomUUID(), reused across retries) so a
     retry after a network hiccup can never double-submit: a duplicate-key 409
     from PostgREST means the first attempt actually landed, and is success.

     When the platform has Turnstile enabled, submission goes through the
     /api/submit Worker (which verifies the token, then inserts under the same
     anon key + RLS). Otherwise it posts straight to PostgREST.

     THE ENDPOINT IS ABSOLUTE NOW, and it has to be. This site is on GitHub
     Pages, which is static, so a relative `/api/submit` on this origin can only
     ever 404 — there is nothing here that runs code. `platform.submitUrl`
     points at the Supabase Edge Function in supabase/functions/submit, on the
     project that already holds the stories.

     AND IT FAILS CLOSED. It used to fall through to a direct PostgREST insert
     when the endpoint answered 404/405, so that a forgotten deployment lost
     spam protection instead of losing stories. That was the right trade when
     the captcha was ours to schedule. It is the wrong one now: NYU's provost
     office compliance review requires the captcha, privacy.html tells residents
     there is one, and a submission path that is unprotected while looking
     protected is the single outcome that cannot be allowed to ship quietly.

     So a missing endpoint is now a loud, visible failure on the form. The cost
     of that trade is real and worth naming: this exact mismatch — a siteKey
     configured against a Worker that was never deployed — silently ate every
     story submitted in July 2026. Getting it wrong now stops submissions
     instead. GET `${submitUrl}/health` before launch and after any config
     change; it reports whether the real Turnstile secret is in use. */
  async function submitStory({ id, consentLevel, displayName, answers, lat, lng, locationLabel, media, contact, source, turnstileToken }) {
    const here = generalize(lat, lng);
    const storyRow = {
      id,
      status: 'pending',
      consent_level: consentLevel,
      display_name: displayName,
      answers,
      lat: here.lat,
      lng: here.lng,
      location_label: locationLabel || null,
      media: media || [],
      source: source || null,
    };
    const contactRow = contact && (contact.full_name || contact.email || contact.phone)
      ? { full_name: contact.full_name || null, email: contact.email || null, phone: contact.phone || null }
      : null;

    if (platform.turnstile?.siteKey) {
      const endpoint = platform.submitUrl || '/api/submit';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: tenant.slug, token: turnstileToken, story: storyRow, contact: contactRow }),
      });
      /* A 404 or 405 here means the endpoint is not deployed, or submitUrl is
         wrong, or the function's "Verify JWT" toggle is still on. It does NOT
         mean carry on without the captcha — see the note above. Named
         separately from an upstream error so the message can say which of
         those it is instead of telling a resident to try again at something
         that will never work. */
      if (res.status === 404 || res.status === 405) {
        console.error(`submit: ${endpoint} is not answering (${res.status}). Deploy the submit function, or check platform.submitUrl.`);
        const err = new Error('The story could not be sent. Please try again shortly.');
        err.code = 'endpoint';
        throw err;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        const err = new Error(body.error || `submit failed (${res.status})`);
        err.code = body.code || (res.status === 403 ? 'turnstile' : 'upstream');
        throw err;
      }
      // Parity with the direct path: a dropped contact row is not a silent
      // success. The story id is stable, so a retry re-posts (409 → ok) and
      // re-attempts the contact — the resident never loses their reachback.
      if (contactRow && body.contactSaved === false) {
        const err = new Error('contact not saved');
        err.code = 'contact';
        throw err;
      }
      return id;
    }

    const tid = await resolveTenantId();
    try {
      await rest('stories', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ ...storyRow, tenant_id: tid }),
      });
    } catch (e) {
      // 409 duplicate key: this exact submission already landed on a prior try.
      if (!/409/.test(e.message)) throw e;
    }
    if (contactRow) {
      await rest('story_contacts', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ ...contactRow, story_id: id, tenant_id: tid }),
      }).catch(e => { if (!/409/.test(e.message)) throw e; });
    }
    return id;
  }

  return { base, key, rest, resolveTenantId, fetchApprovedStories, fetchReactions, bumpReaction, uploadMedia, submitStory };
}

/* Turn a submission failure into something a resident can act on.
   Returns { text, retryable } — every failure path keeps the user's work. */
export function explainSubmitError(e) {
  if (!navigator.onLine) {
    return { text: 'You appear to be offline. Your story is safe on this screen — reconnect and try again.', retryable: true };
  }
  if (e?.code === 'turnstile') {
    return { text: 'We couldn’t confirm you’re human just now. Please try again.', retryable: true };
  }
  /* The submit endpoint is missing or misconfigured. Nothing the resident does
     will fix it, so the message does not pretend otherwise or send them round
     the retry loop: it tells them their words are safe and to come back. The
     console line beside it names the actual cause for whoever is on call. */
  if (e?.code === 'endpoint') {
    return { text: 'We can’t send stories right now — this is our problem, not yours. Your words are still on this screen. Please try again in a little while.', retryable: true };
  }
  if (e?.code === 'contact') {
    return { text: 'Your story was saved, but we couldn’t save your contact details. Please try again so the team can reach you.', retryable: true };
  }
  // Worker path sets code 'too-large'; the direct-PostgREST path surfaces the
  // DB size-cap trigger text inside a 400, so match that here too.
  if (e?.code === 'too-large' || /413|payload too large|too large|value too long|exceeds/i.test(e?.message || '')) {
    return { text: 'Your submission is too large — a shorter story or smaller photos will go through.', retryable: true };
  }
  return { text: 'Something went wrong sending your story. Nothing was lost — please try again.', retryable: true };
}
