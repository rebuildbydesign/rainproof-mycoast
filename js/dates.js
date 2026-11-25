/* ONE DATE FORMAT FOR THE WHOLE SITE (19 August 2026, Judy's call).

   "Sept 1, 2021". US order, because this is a map of New York written for New
   Yorkers, and "1 September 2021" reads as somebody else's document.

   THIS FILE EXISTS BECAUSE THERE WERE THREE FORMATS, and two of them were
   accidents:

   - `app.js`'s own helper hardcoded `en-GB`, which is where "17 August 2026"
     in the methodology panel came from.
   - Everywhere else passed `undefined` as the locale, which means THE VIEWER'S
     browser decides. A story card read "Aug 17, 2026" in New York and
     "17 Aug 2026" in London, off the same data, and nobody could see it from
     here. A public record should not change shape depending on who opens it.
   - The findings panel wrote its own AP formatter on 19 August, which is the
     one that was right and is now here.

   Months follow AP style, which is not what any locale gives you and is why
   these are written out rather than handed to `toLocaleDateString`:

   - The four long months abbreviate — Jan, Feb, Aug, Sept, Oct, Nov, Dec.
   - March, April, May, June and July are spelled out.
   - No period after the abbreviation, matching the "Sept 1, 2021" Judy wrote.
   - A month WITHOUT a day is spelled out in full ("August 2026"), which is
     also AP: the abbreviation is for use alongside a specific date.

   Every parser here forces T00:00:00 on a bare `YYYY-MM-DD`. Without it the
   string parses as UTC and formats as the PREVIOUS DAY in New York, which is
   how a report filed on the 29th ends up published as the 28th. A value that
   already carries a time (`submitted_at`) is left alone, because it is a real
   instant and converting it to local time is the correct thing. */

const ABBR = ['Jan', 'Feb', 'March', 'April', 'May', 'June', 'July',
              'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
              'August', 'September', 'October', 'November', 'December'];

/* A bare date is a calendar day in New York; anything with a time in it is an
   instant and keeps its own parsing. */
function toDate(v) {
  if (v instanceof Date) return Number.isNaN(+v) ? null : v;
  const s = String(v ?? '');
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10)) && s.length <= 10
    ? new Date(`${s.slice(0, 10)}T00:00:00`)
    : new Date(s);
  return Number.isNaN(+d) ? null : d;
}

/** "Aug 17, 2026" — a full date. */
export function longDate(v, fallback = '') {
  const d = toDate(v);
  return d ? `${ABBR[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : fallback;
}

/** "Aug 17" — a date whose year the sentence around it has already given. */
export function shortDate(v, fallback = '') {
  const d = toDate(v);
  return d ? `${ABBR[d.getMonth()]} ${d.getDate()}` : fallback;
}

/** "August 2026" — spelled out, because there is no day beside it. */
export function monthYear(v, fallback = '') {
  const d = toDate(v);
  return d ? `${FULL[d.getMonth()]} ${d.getFullYear()}` : fallback;
}

/** "Aug 17, 2026, 3:04 PM" — for the moderation desk, where the time matters. */
export function dateTime(v, fallback = '') {
  const d = toDate(v);
  if (!d) return fallback;
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${longDate(d)}, ${t}`;
}
