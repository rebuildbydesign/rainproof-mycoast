/* Everything a resident's file goes through before it leaves their phone.

   Three jobs, in order of why they matter:

   1. PRIVACY. A phone photo carries EXIF, including the GPS coordinates where
      it was taken — usually the person's home. Those were going into a public
      bucket, on anonymous stories too. Re-drawing an image through a canvas
      strips every EXIF tag as a side effect, so photos are ALWAYS re-encoded
      here, even when the original is already small. Nothing else in the app
      removes that metadata.

   2. EGRESS. Cards and the gallery show every story's lead image, so a visitor
      scrolling the list pays for each one. A full-size phone photo is ~3.5 MB;
      twenty of them is ~70 MB for one visit, which is most of a free Supabase
      month. Each photo therefore also gets a small thumbnail, and the list
      views load that instead.

   3. THE UPLOAD CEILING. Supabase rejects anything over the bucket's size cap
      (50 MB on the free plan). Video blows past it in seconds at 4K. We try to
      re-encode it down; when we cannot, we say so at the moment the file is
      chosen rather than after the form is filled in.

   Everything is measured against `tenant.form.media.limits` so the numbers can
   be retuned — for a paid plan, or for a tenant on a different connection —
   without touching this file. Nothing here knows what a story is. */

const DEFAULTS = {
  photoMaxEdge: 1600,
  photoQuality: 0.82,
  /* Sized for the largest place a thumbnail is painted, on a retina screen.
     The story card's hero strip measures 301 x 132 CSS px, which is 602 x 264
     real pixels at devicePixelRatio 2 — so a 400px thumbnail was being upscaled
     2x and looked visibly soft. The cost of fixing it is small: on a real
     iPhone photo, 400px was 31 KB and 1000px is under 100 KB, still roughly six
     times lighter than serving the full image. */
  thumbMaxEdge: 1000,
  thumbQuality: 0.80,
  /* MUST match what the bucket will actually accept, never what the plan
     permits. Supabase enforces the smaller of a project-wide upload limit and
     the bucket's own, and the project one stays at its old value after an
     upgrade until somebody raises it by hand. Setting this higher than the
     server's real limit is the worst option available: the file is accepted in
     the picker, the resident writes their whole story, and the upload then
     fails. Currently 200 MB, matching the project setting raised 30 July 2026.

     Deliberately far below what Pro permits (500 GB). 200 MB is about a minute
     of 4K or several minutes of 1080p, and pushes over cellular in a couple of
     minutes; past that a resident is likelier to abandon the upload than finish
     it, and a failed 900 MB attempt is worse than a clear refusal up front. */
  maxUploadBytes: 200 * 1024 * 1024,
  videoMaxEdge: 1280,                 // 720p on the long side
  videoBitsPerSecond: 1_800_000,      // ceiling; long clips get less, see below
  videoMinBitsPerSecond: 500_000,     // below this it stops being worth watching
  /* Long-form testimony is a first-class case: someone talking to camera for
     five minutes about the night their basement flooded. Raised from 180s by
     decision, 30 July 2026, with the costs understood — a re-encode runs in
     real time, so a five minute clip takes five minutes to prepare. */
  videoMaxSeconds: 300,
  /* Voice carries the long-form testimony, and costs almost nothing doing it —
     about 2.5 MB for ten minutes. The cap exists so a phone left in a pocket
     does not upload an hour of nothing, and applies to uploaded audio files as
     well as the in-browser recorder. */
  audioMaxSeconds: 600,
  audioMaxBytes: 30 * 1024 * 1024,   // backstop when a browser hides the duration
};

export const limits = cfg => ({ ...DEFAULTS, ...(cfg || {}) });

/* A re-encode runs in real time and stops if the page goes away, so while one
   is in flight the browser should warn on navigation and closing the tab. The
   standard pattern, and the standard caveat: browsers ignore custom text and
   show their own wording, so the on-screen note has to carry the real message.

   Reference-counted, because two files can be preparing at once. */
let holdCount = 0;
const beforeUnload = e => { e.preventDefault(); e.returnValue = ''; return ''; };
export function holdPage() {
  if (holdCount++ === 0) window.addEventListener('beforeunload', beforeUnload);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holdCount === 0) window.removeEventListener('beforeunload', beforeUnload);
  };
}

/* Sizes as a person would say them. A compressed photo is often well under a
   megabyte, and "0.0 MB" reads like the file vanished. */
const MB = n => (n < 1024 * 1024
  ? `${Math.max(1, Math.round(n / 1024))} KB`
  : `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`);
export const humanSize = MB;

/* Durations as a person would say them. Rounding everything to whole minutes
   produced "that video is 5 minutes long, and the limit is 5 minutes", which
   tells the resident nothing about how much to trim. */
const DUR = s => {
  s = Math.round(s);
  if (s < 60) return `${s} seconds`;
  const m = Math.floor(s / 60), r = s % 60;
  if (!r) return `${m} minute${m === 1 ? '' : 's'}`;
  return `${m} min ${r} sec`;
};

/* Longest-edge-bounded dimensions. Never upscales: a small image stays small,
   it just loses its metadata on the way through. */
function fit(w, h, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

function toBlob(canvas, type, quality) {
  return new Promise((res, rej) =>
    canvas.toBlob(b => (b ? res(b) : rej(new Error('canvas encode failed'))), type, quality));
}

/* Decode to something drawable, with EXIF rotation APPLIED.

   This matters more than it looks: stripping EXIF without honouring the
   orientation tag first is how portrait photos end up sideways on the map.
   `createImageBitmap` does it natively; the <img> fallback relies on the
   browser having already applied orientation at decode time, which every
   current engine does. */
async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* Safari < 15 and friends: fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('image decode failed'));
      img.src = url;
    });
    return img;
  } finally {
    // Revoking immediately is safe: the bitmap/img has already decoded.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function draw(src, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return canvas;
}

/* One photo → a stripped, resized JPEG plus its thumbnail.

   Always returns a NEW file. If re-encoding somehow produced something larger
   than the original we still keep ours, because the original is the one
   carrying the GPS tag. Size is the secondary goal here; the metadata is the
   point. */
/* HEIC is what an iPhone shoots by default.

   Picking one straight off the phone is usually fine: iOS transcodes to JPEG
   on its way through `<input type=file>`. The broken case is a .heic that
   reached a desktop some other way — AirDrop, a cable, a shared album — where
   `accept="image/*"` still takes it and no browser but Safari can decode it.

   Named explicitly rather than left to the decoder because the advice is
   specific and worth giving (REB-498, Rifal's ".HEIC double check"). */
const isHeic = file =>
  /^image\/(heic|heif)/i.test(file?.type || '') || /\.(heic|heif)$/i.test(file?.name || '');

async function preparePhoto(file, L) {
  const src = await decodeImage(file);
  const sw = src.width, sh = src.height;

  const full = fit(sw, sh, L.photoMaxEdge);
  const fullBlob = await toBlob(draw(src, full.w, full.h), 'image/jpeg', L.photoQuality);

  const thumb = fit(sw, sh, L.thumbMaxEdge);
  const thumbBlob = await toBlob(draw(src, thumb.w, thumb.h), 'image/jpeg', L.thumbQuality);

  src.close?.();

  const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
  return {
    file: new File([fullBlob], `${base}.jpg`, { type: 'image/jpeg' }),
    thumb: new File([thumbBlob], `${base}-thumb.jpg`, { type: 'image/jpeg' }),
    note: `Photo optimised — ${MB(file.size)} → ${MB(fullBlob.size)}, location data removed`,
  };
}

/* Can this browser re-encode video at all?

   Chrome and Firefox: yes. Safari and iOS are the risk — MediaRecorder arrived
   late and canvas.captureStream support is uneven — which is why every caller
   must be able to fall back to the plain size guard. */
export function canReencodeVideo() {
  return typeof MediaRecorder !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function'
    && !!pickVideoMime();
}

function pickVideoMime() {
  const want = [
    'video/mp4;codecs=avc1',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return want.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || null;
}

/* Re-encode a clip down to 720p by playing it and recording the canvas.

   This is real time — a 40 second clip takes 40 seconds — so the caller shows
   progress and the whole thing is bounded by a timeout. Audio is routed
   through a WebAudio destination node and merged in; if that fails we still
   produce a silent-but-usable video rather than dropping the file, and the
   caller can decide.

   Rejects on anything unexpected. Callers treat a rejection as "use the size
   guard instead", never as "the resident cannot add a video". */
/* Open a media element on a file and read what we need to decide anything:
   how long it is and how big its frame is. Cheap — metadata only, no decode of
   the stream itself. Used for audio too, where the frame size is simply 0. */
async function probeMedia(file, kind = 'video') {
  const url = URL.createObjectURL(file);
  // An <audio> element for audio: a <video> element can hold an audio-only file
  // but is the less reliable route, and this runs on whatever browser a resident
  // happens to have.
  const video = document.createElement(kind === 'audio' ? 'audio' : 'video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  try {
    await new Promise((res, rej) => {
      // `durationchange` as well as `loadedmetadata`: some containers report the
      // duration only on the second event, and either is enough to proceed.
      video.onloadedmetadata = res;
      video.ondurationchange = () => { if (Number.isFinite(video.duration)) res(); };
      video.onerror = () => rej(new Error('media decode failed'));
      setTimeout(() => rej(new Error('media metadata timeout')), 15000);
    });
    /* WebM written by MediaRecorder carries no duration in its header, so the
       element reports Infinity until something forces it to scan to the end.
       Seeking past the end and waiting for `durationchange` is the standard
       coax. Real phone footage (mp4/mov) reports duration immediately and
       skips all of this. */
    let dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) {
      dur = await new Promise(res => {
        const give = setTimeout(() => res(NaN), 4000);
        video.ondurationchange = () => {
          if (Number.isFinite(video.duration)) {
            clearTimeout(give);
            video.ondurationchange = null;
            video.currentTime = 0;
            res(video.duration);
          }
        };
        video.currentTime = 1e101;
      });
    }
    return { duration: dur, width: video.videoWidth, height: video.videoHeight };
  } finally {
    video.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}

/* The bitrate to aim for on a clip of this length.

   Not a constant, because a constant cannot satisfy both ends: 1.8 Mbps is
   right for a 30 second clip and produces a 64 MB file at five minutes, which
   is over the upload ceiling. So the target is whatever fits the ceiling with
   headroom, capped at the configured maximum and floored where quality stops
   being worth having. A long clip is therefore softer rather than rejected. */
function targetBitrate(durationSec, L) {
  const budget = L.maxUploadBytes * 0.85;          // headroom for container + audio
  const fit = (budget * 8) / Math.max(1, durationSec);
  return Math.max(L.videoMinBitsPerSecond, Math.min(L.videoBitsPerSecond, fit));
}

async function prepareVideo(file, L, onProgress, probe) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;              // required for programmatic play()
  video.playsInline = true;
  video.preload = 'auto';

  const cleanup = [];
  try {
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('video decode failed'));
      setTimeout(() => rej(new Error('video metadata timeout')), 15000);
    });

    const dur = probe.duration;
    const { w, h } = fit(video.videoWidth, video.videoHeight, L.videoMaxEdge);
    const canvas = draw(video, w, h);          // also sizes the canvas
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(30);

    // Merge the original audio in. Optional by design: a muted re-encode still
    // carries the thing that matters, which is what the street looked like.
    let audioCtx = null;
    let routed = false;   // true once the element's audio feeds the graph
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        audioCtx = new AC();
        cleanup.push(() => audioCtx.close().catch(() => {}));
        const source = audioCtx.createMediaElementSource(video);
        const dest = audioCtx.createMediaStreamDestination();
        source.connect(dest);
        dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
        routed = true;
      }
    } catch { /* no audio track, or the browser refused — carry on silent */ }

    const mimeType = pickVideoMime();
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: targetBitrate(dur, L) });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };

    const done = new Promise((res, rej) => {
      rec.onstop = res;
      rec.onerror = () => rej(new Error('recorder failed'));
      // Real time plus generous headroom for slow phones.
      setTimeout(() => rej(new Error('reencode timeout')), (dur * 1000 * 2) + 20000);
    });

    rec.start(250);
    await video.play();

    /* `muted` is required for programmatic play(), and it also zeroes what
       createMediaElementSource hands the graph — so every re-encode was silent.
       Unmute once playback is running: the element's output is redirected into
       the AudioContext, so nothing reaches the speaker. If unmuting pauses it
       (some browsers do that to an autoplaying element), take silent over stalled. */
    if (routed) {
      video.muted = false;
      if (video.paused) { video.muted = true; video.play().catch(() => {}); }
    }

    /* Copy each decoded frame onto the canvas the recorder is watching.

       Deliberately NOT requestAnimationFrame: rAF is tied to display refresh
       and stops entirely when a tab is hidden, so a resident who switches apps
       or locks their phone half way through would stall the re-encode until the
       timeout killed it — and lose the video. `requestVideoFrameCallback` fires
       per decoded video frame instead, which is exactly this job; where it is
       missing, a plain interval keeps running in the background (throttled, but
       never stopped). */
    /* Playback tops out at 95%, not 99%. What follows is the encoder flush —
       stopping the recorder, waiting for the last chunks, assembling the blob —
       which has no measurable progress and took long enough on a real phone to
       look like a hang at "99%, about 1s left". The last stretch is reported as
       a separate, indeterminate phase instead of a number that stops moving. */
    const paint = () => {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      onProgress?.(Math.min(0.95, video.currentTime / dur), 'encoding');
    };
    if (typeof video.requestVideoFrameCallback === 'function') {
      let handle = 0;
      const step = () => {
        if (video.ended) return;
        paint();
        handle = video.requestVideoFrameCallback(step);
      };
      handle = video.requestVideoFrameCallback(step);
      cleanup.push(() => video.cancelVideoFrameCallback?.(handle));
    } else {
      const timer = setInterval(() => { if (!video.ended) paint(); }, 1000 / 30);
      cleanup.push(() => clearInterval(timer));
    }

    /* `ended` is the only signal here, and a stalled decode never fires it.
       Nick, 25 Aug: one stalled clip hung this forever, which left the form's
       `preparing` counter above zero and parked submit on "Finishing your
       video..." for the rest of the page's life. Rejecting instead reaches the
       caller's catch, which uploads the original file as it is. */
    await new Promise((res, rej) => {
      video.onended = res;
      video.onerror = () => rej(new Error('video playback failed'));
      let last = -1, still = 0;
      const watch = setInterval(() => {
        if (video.ended) return;
        if (video.currentTime > last) { last = video.currentTime; still = 0; return; }
        if (++still >= 15) rej(new Error('video playback stalled'));
      }, 1000);
      cleanup.push(() => clearInterval(watch));
    });
    onProgress?.(0.95, 'finishing');
    if (rec.state !== 'inactive') rec.stop();
    await done;
    onProgress?.(1, 'done');

    const blob = new Blob(chunks, { type: mimeType });
    if (!blob.size) throw new Error('empty re-encode');

    const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
    const base = (file.name || 'video').replace(/\.[^.]+$/, '');
    return {
      file: new File([blob], `${base}-720p.${ext}`, { type: mimeType }),
      note: `Video optimised — ${MB(file.size)} → ${MB(blob.size)}`,
    };
  } finally {
    cleanup.forEach(fn => { try { fn(); } catch { /* best effort */ } });
    video.pause?.();
    video.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}

/* The one entry point.

   Returns either { ok: true, file, thumb?, note? } with whatever should
   actually be uploaded, or { ok: false, reason, message } with copy written for
   the resident rather than for a log. Never throws: a file the pipeline cannot
   improve is still a file we would rather accept than lose, as long as it is
   under the ceiling. */
/* A still from the clip, so a video story has a face in the feed.

   Without one the card hero is empty: it is built from photos, so a
   video-only story rendered as a text block with a "Video" chip and nothing to
   look at. Photos have carried a thumbnail since REB-407 for egress reasons;
   this gives videos the same field so `thumbOf()` works for both and the card
   needs no special case.

   Seeks a little way in rather than taking frame zero, which on a phone clip is
   usually the shutter still closing. Best-effort throughout: a poster is worth
   having and never worth failing an upload over, so every path resolves null
   rather than throwing. */
async function captureVideoPoster(file, L) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  try {
    const meta = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('poster: metadata timeout')), 8000);
      video.onloadedmetadata = () => { clearTimeout(t); res({ w: video.videoWidth, h: video.videoHeight, d: video.duration }); };
      video.onerror = () => { clearTimeout(t); rej(new Error('poster: video load failed')); };
      video.src = url;
    });
    if (!meta.w || !meta.h) return null;

    // A tenth of the way in, capped at one second, and never past the end.
    const target = Math.min(1, Number.isFinite(meta.d) && meta.d > 0 ? meta.d * 0.1 : 0);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('poster: seek timeout')), 8000);
      video.onseeked = () => { clearTimeout(t); res(); };
      video.onerror = () => { clearTimeout(t); rej(new Error('poster: seek failed')); };
      try { video.currentTime = target; } catch { clearTimeout(t); res(); }
    });

    const box = fit(meta.w, meta.h, L.thumbMaxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = box.w;
    canvas.height = box.h;
    canvas.getContext('2d').drawImage(video, 0, 0, box.w, box.h);
    const blob = await toBlob(canvas, 'image/jpeg', L.thumbQuality);
    if (!blob?.size) return null;
    const base = (file.name || 'video').replace(/\.[^.]+$/, '');
    return new File([blob], `${base}-thumb.jpg`, { type: 'image/jpeg' });
  } catch (e) {
    console.warn('video poster unavailable:', e);
    return null;
  } finally {
    video.removeAttribute('src');
    video.load?.();
    URL.revokeObjectURL(url);
  }
}

export async function prepareFile(file, kind, cfg, onProgress) {
  const L = limits(cfg);
  /* "Try a shorter clip" is wrong advice for the commonest case. A phone set to
     4K makes ~26 Mbps files, so eighteen seconds is already 59 MB and halving
     the length would not save it — the size is coming from the resolution. When
     the clip is short and still over the ceiling, say what will actually work. */
  const tooBig = (durationSec = null) => {
    const head = `That ${kind} is too large to upload (${MB(file.size)} — the limit is ${MB(L.maxUploadBytes)}).`;
    if (kind !== 'video') return { ok: false, reason: 'too-large', message: `${head} Try a smaller file.` };
    const shortAlready = Number.isFinite(durationSec) && durationSec <= 60;
    return {
      ok: false,
      reason: 'too-large',
      message: shortAlready
        ? `${head} It is only ${DUR(durationSec)} long, so this is your camera's quality setting rather than the length — `
          + 'recording a clip right here in the form will be much smaller, or you can lower Record Video in your camera settings.'
        : `${head} Try a shorter clip, or record one right here in the form.`,
    };
  };

  try {
    if (kind === 'photo') {
      /* A PHOTO WE CANNOT RE-ENCODE IS REFUSED, NOT PASSED THROUGH.

         This used to fall to the catch at the bottom, whose rule is "accept the
         original if it fits, so a resident is never blocked by our
         optimisation". That rule is right for a PDF and for audio. It is wrong
         here, because for a photo the re-encode is not an optimisation — it IS
         the privacy mechanism. Redrawing through a canvas is what strips EXIF,
         and the GPS tag lives in EXIF.

         So the old behaviour was: an undecodable photo uploads untouched, with
         its location tag intact, no thumbnail, and a broken image on the map —
         silently, with no note. Every iPhone .heic took that path in Chrome.
         Meanwhile the privacy notice tells the resident, and the NYU review
         records, that hidden location data is removed before upload. It was
         not. Refusing is the only honest option: we cannot keep the promise
         for this file, so we do not take the file. */
      if (isHeic(file)) {
        return {
          ok: false,
          reason: 'heic',
          message: 'This browser cannot read iPhone HEIC photos, and we will not upload one '
            + 'without first removing its location tag. Re-save it as a JPEG, or set '
            + 'Settings → Camera → Formats to "Most Compatible" on the iPhone and take it again.',
        };
      }
      let out;
      try {
        out = await preparePhoto(file, L);
      } catch (e) {
        console.warn('photo could not be re-encoded:', e);
        return {
          ok: false,
          reason: 'undecodable',
          message: 'We could not read that image, and we will not upload a photo without first '
            + 'removing its location tag. Try re-saving it as a JPEG or PNG.',
        };
      }
      // A re-encoded photo over the ceiling means something extraordinary;
      // better to say so than to fail at submit.
      return out.file.size > L.maxUploadBytes ? tooBig() : { ok: true, ...out };
    }

    if (kind === 'video') {
      /* Decide from the clip's actual bitrate, not its size.

         The old test was "bigger than 8 MB, so re-encode it", which was wrong in
         a way that cost the resident real time: iOS pre-compresses in-form
         recordings to about 0.9 Mbps, so anything over ~75 seconds tripped the
         threshold and got re-encoded at a HIGHER bitrate — several minutes of
         waiting to produce a larger file. Now we only re-encode when the source
         is genuinely heavier than what we would produce. */
      let probe = null;
      try { probe = await probeMedia(file); } catch (e) { console.warn('video probe failed:', e); }

      const dur = probe?.duration;
      if (Number.isFinite(dur) && dur > L.videoMaxSeconds) {
        return {
          ok: false,
          reason: 'too-long',
          message: `That video is ${DUR(dur)} long, and the limit is ${DUR(L.videoMaxSeconds)}. `
            + `Trim about ${DUR(dur - L.videoMaxSeconds)} off it, or record a shorter one here in the form.`,
        };
      }

      const srcRate = Number.isFinite(dur) && dur > 0 ? (file.size * 8) / dur : Infinity;
      const wantRate = Number.isFinite(dur) && dur > 0 ? targetBitrate(dur, L) : 0;
      // 1.1 is slack: re-encoding to shave a few percent is never worth minutes.
      const alreadyLean = srcRate <= wantRate * 1.1;

      if (!alreadyLean && canReencodeVideo() && Number.isFinite(dur)) {
        try {
          /* Say how long BEFORE it starts, not at the first progress tick.

             REB-498, and the closest thing to a root cause for Jill's "it
             booted me off when I tried to add a 1.5 minute video". A re-encode
             runs in real time, so her 90-second clip meant about 90 seconds in
             which the only visible change was a picker that had gone dim —
             and `holdPage()` arms a beforeunload whose wording the browser
             controls and which reads as alarming. Nothing told her it was
             working, or that leaving would lose it.

             The estimate is the clip's own duration, which is what real-time
             means, rounded up a little for the muxing tail. */
          onProgress?.(0, 'starting', { seconds: Math.ceil(dur * 1.15) });
          const out = await prepareVideo(file, L, onProgress, probe);
          if (out.file.size <= L.maxUploadBytes) {
            // Poster from the re-encoded clip, so it matches what will play.
            const thumb = await captureVideoPoster(out.file, L);
            return { ok: true, ...out, ...(thumb ? { thumb } : {}) };
          }
          return tooBig(dur);   // re-encoded and still over: nothing more a browser can do
        } catch (e) {
          console.warn('video re-encode unavailable, falling back to size check:', e);
        }
      }
      // Already efficient, or this browser cannot re-encode — size guard only.
      if (file.size > L.maxUploadBytes) return tooBig(dur);
      const thumb = await captureVideoPoster(file, L);
      return { ok: true, file, ...(thumb ? { thumb } : {}) };
    }

    /* Audio needs no compression — voice at ~35 kbps is about 2.5 MB for ten
       minutes — but an UPLOADED file still needs the same length limit as the
       in-browser recorder, or the cap is only enforced on whichever path the
       resident happens to take. */
    if (kind === 'audio' && L.audioMaxSeconds) {
      let dur = null;
      try { dur = (await probeMedia(file, 'audio')).duration; } catch (e) { console.warn('audio probe failed:', e); }
      const tooLong = extra => ({
        ok: false,
        reason: 'too-long',
        message: `That recording is too long — the limit is ${DUR(L.audioMaxSeconds)}. ${extra}`,
      });
      if (Number.isFinite(dur) && dur > L.audioMaxSeconds) {
        return {
          ok: false,
          reason: 'too-long',
          message: `That recording is ${DUR(dur)} long, and the limit is ${DUR(L.audioMaxSeconds)}. `
            + `Trim about ${DUR(dur - L.audioMaxSeconds)} off it, or record a new one here in the form.`,
        };
      }
      /* If the browser would not tell us the duration, fall back to a size
         bound so the limit still means something. Generous on purpose: ten
         minutes of voice is ~2.5 MB at the rate phones actually record, and
         ~24 MB even at 320 kbps, so this only catches files that are long by
         any reading. */
      if (!Number.isFinite(dur) && L.audioMaxBytes && file.size > L.audioMaxBytes) {
        return tooLong('Trim it, or record a new one here in the form.');
      }
    }

    // PDFs cannot be usefully compressed client-side; ceiling check only.
    return file.size > L.maxUploadBytes ? tooBig() : { ok: true, file };
  } catch (e) {
    console.warn(`could not prepare ${kind}:`, e);
    // Preparation failed for a reason we did not anticipate. Accept the
    // original if it fits, so a resident is never blocked by our optimisation.
    return file.size > L.maxUploadBytes ? tooBig() : { ok: true, file };
  }
}
