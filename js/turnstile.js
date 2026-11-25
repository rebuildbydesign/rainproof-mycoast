/* Cloudflare Turnstile, as an opt-in platform module.
   Active only when config.platform.turnstile.siteKey is present — tenants never
   configure this (anti-abuse is a horizontal capability, not a per-community
   variation). The widget runs in "interaction-only" appearance, so legitimate
   residents almost never see a challenge; the token is verified server-side by
   the /api/submit Worker before the story insert is forwarded. */

/* Every rejection carries `code`, because explainSubmitError() branches on it
   and these used to be bare Errors — so the honest "we couldn't confirm you're
   human, please try again" was unreachable and a captcha failure reached the
   resident as "something went wrong sending your story". */
const tsError = (msg) => Object.assign(new Error(msg), { code: 'turnstile' });

let scriptLoading = null;

function loadScript() {
  scriptLoading ||= new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = () => { scriptLoading = null; reject(new Error('turnstile script failed to load')); };
    document.head.appendChild(s);
  });
  return scriptLoading;
}

/* Render into `container` and resolve with a fresh token (tokens are single-use
   and short-lived, so this is called per submission attempt). Rejects on
   network/challenge failure — callers surface that honestly and let the user
   retry without losing their story. */
/* `onState` reports what the widget is doing so the caller can stop saying
   "One moment…" at somebody for two and a half minutes:
     'interactive' — a challenge is on screen and needs a human
     'slow'        — nothing has happened for a while and it may not
   Both are advisory. The promise still settles only on a real outcome. */
export async function getTurnstileToken(siteKey, container, onState) {
  /* A content blocker that eats challenges.cloudflare.com lands here, and it is
     a real slice of any thousand people. Without the code it reached the
     resident as "something went wrong sending your story", which points them at
     their words rather than at the check. */
  const ts = await loadScript().catch(e => { throw tsError(e?.message || 'turnstile script failed to load'); });
  return new Promise((resolve, reject) => {
    container.innerHTML = '';
    let settled = false;
    let widgetId = null;
    const cleanup = () => { try { if (widgetId != null) ts.remove(widgetId); } catch { /* already gone */ } };
    const done = (fn, v) => { if (!settled) { settled = true; setTimeout(cleanup, 0); fn(v); } };
    try {
      widgetId = ts.render(container, {
        sitekey: siteKey,
        appearance: 'interaction-only',
        'refresh-expired': 'auto',
        callback: token => done(resolve, token),
        'error-callback': () => done(reject, tsError('turnstile challenge failed')),
        // Turnstile fires this when a solved token expires before use; its own
        // timing (not ours) governs a challenge in progress.
        'timeout-callback': () => done(reject, tsError('turnstile challenge timed out')),
        /* A CHALLENGE THE RESIDENT CANNOT SEE IS A DEAD FORM.

           The widget renders inside #fBody, which scrolls, while Send lives in
           the sheet's pinned footer. So the button can say "One moment…" in
           front of somebody while the puzzle waiting on them sits below the
           fold, with nothing pointing at it. This fires just before an
           interactive challenge appears, which is exactly when to scroll it
           into view and say so. */
        'before-interactive-callback': () => {
          if (settled) return;
          onState?.('interactive');
          try { container.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* older browser */ }
        },
      });
    } catch (e) {
      done(reject, Object.assign(e, { code: 'turnstile' }));
    }
    // Nothing at all after this long is worth saying out loud, even though the
    // promise keeps waiting: silence is what makes a resident close the tab.
    setTimeout(() => { if (!settled) onState?.('slow'); }, 8_000);
    // Last-resort backstop only, for a widget that never calls ANY callback
    // (script wedged). Deliberately long so it can't interrupt a real person
    // working through a visible challenge — Cloudflare's own callbacks handle
    // the normal failure/expiry paths.
    setTimeout(() => done(reject, tsError('turnstile did not respond')), 150_000);
  });
}
