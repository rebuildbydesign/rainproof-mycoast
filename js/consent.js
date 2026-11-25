/* Per-story consent gradient. These levels are an engine capability:
   the database enforces them again server-side (enforce_consent trigger +
   RLS), so this module is UX, not the security boundary. */
import { icon } from './ui/icons.js';

export const CONSENT_LEVELS = [
  {
    id: 'anonymous',
    emoji: icon('eyeOff'),
    label: 'Anonymous',
    desc: 'No name shown. Your story appears with no identifying details.',
  },
  {
    id: 'first_name',
    emoji: icon('user'),
    label: 'First name only',
    desc: 'Shown with your first name and last initial, like “Maria T.”',
  },
  {
    id: 'full_name',
    emoji: icon('speaker'),
    label: 'Full name',
    desc: 'Your full name appears alongside your story.',
  },
  {
    id: 'advocacy_only',
    emoji: icon('lock'),
    label: 'Advocacy only, not public',
    desc: 'Your story never appears on the public map. The organizing team may use it, anonymized, when advocating on the community’s behalf.',
  },
];

/* Tenant configs may override copy per level: consent.levels[id].{label,desc}
   and pick which levels appear, in what order, with consent.order.

   Rainproof sets order to full_name / first_name / anonymous (REB-505). That
   retires `advocacy_only` FROM THE FORM only — the level still exists in the
   database, the enforce_consent trigger and the admin, and the stories already
   carrying it are untouched. Dropping it here cannot orphan them. */
export function consentLevels(tenant) {
  const overrides = tenant.consent?.levels || {};
  const wanted = tenant.consent?.order;
  const base = wanted?.length
    ? wanted.map(id => CONSENT_LEVELS.find(l => l.id === id)).filter(Boolean)
    : CONSENT_LEVELS;
  return base.map(l => ({ ...l, ...(overrides[l.id] || {}) }));
}

/* A level label may carry `{neighborhood}`, so the anonymous option names the
   place the pin actually landed in ("A Red Hook Resident") rather than an
   abstraction. Falls back to a generic when no pin has been dropped yet. */
export function levelLabel(level, hood) {
  const place = (hood || '').split(',')[0].trim();
  return (level.label || '').replace('{neighborhood}',
    place ? titleCasePlace(place) : 'Neighborhood').replace(/^A (?=[AEIOU])/, 'An ');
}

/* Only ever applied to a PLACE name, never to a person's.

   The neighbourhood can arrive lowercased from the free-text box, and it is
   being dropped into a Title Case byline, so it gets normalised. A person's
   name does not: this is a naive word-capitaliser and real names break it —
   "o'brien" becomes "O'brien", "de la cruz" becomes "De La Cruz", "van der
   Berg" becomes "Van Der Berg". Publishing somebody's name wrong on a map
   about their own home is worse than publishing it lowercase, and they typed
   it the way they wanted it. */
function titleCasePlace(s) {
  return (s || '').replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1));
}

/* What actually appears next to the story, in the resident's own casing.

   `first_name` is first name plus last initial ("Maria T."). Judy settled this
   on 19 August by asking for the byline options to show the real values —
   "Full Name, or First Name, First Initial of their Last name, or Neighborhood
   Resident" — which is also what the option now reads as on screen, so the
   label and the function say the same thing either way round.

   The name is NOT title-cased. This would be a naive word-capitaliser and real
   names break it: "o'brien" becomes "O'brien", "de la cruz" becomes "De La
   Cruz". Publishing somebody's name wrong on a map about their own home is
   worse than publishing it the way they typed it.

   Stories submitted earlier keep whatever `display_name` was written at the
   time — it is stored on the row, never recomputed on read. */
export function computeDisplayName(level, name) {
  const trimmed = (name || '').trim();
  if (level === 'anonymous' || level === 'advocacy_only') return null;
  if (!trimmed) return null;
  if (level === 'first_name') {
    const [first, second] = trimmed.split(/\s+/);
    return second ? `${first} ${second[0].toUpperCase()}.` : first;
  }
  return trimmed;
}

/* True when the chosen level needs a name typed in. */
export function consentNeedsName(level) {
  return level === 'first_name' || level === 'full_name';
}
