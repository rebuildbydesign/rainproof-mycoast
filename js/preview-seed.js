/* Local preview seed — injected ONLY when the URL carries ?preview.
   Client-side and in-memory: these stories are never submitted and never
   touch Supabase. They exist so the team can eyeball multi-media rendering
   (card hero + "+N", gallery tiles, the detail photo grid) without needing an
   approved story on the live map. Real visitors never see this — it is gated
   on the query flag in app.js.

   Media are inline SVG data URIs (the storage-bucket trigger only applies to
   real DB submissions, so data URIs render fine here). */

const photo = (label, c1, c2) =>
  'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
      <rect width="800" height="600" fill="url(#g)"/>
      <rect y="410" width="800" height="190" fill="#0b3a4a" opacity="0.5"/>
      <path d="M0 450 Q200 420 400 450 T800 450 V600 H0 Z" fill="#1f6f8b" opacity="0.7"/>
      <text x="40" y="80" font-family="sans-serif" font-size="34" font-weight="700" fill="#ffffff">${label}</text>
      <text x="40" y="122" font-family="sans-serif" font-size="20" fill="#e6f6fb">preview · placeholder</text>
    </svg>`);

/* Returns fake, in-memory stories to prepend to the feed in preview mode.
   submitted_at is a fixed literal (Date.now() is intentionally avoided). */
export function previewStories() {
  return [
    {
      id: 'preview-woodside-1',
      display_name: 'Maria T.',
      consent_level: 'first_name',
      answers: {
        type: 'experience',
        category: 'basement',
        event: 'ida',
        public_contact: '@maria_woodside (demo)',
        story:
          'During Ida the water came up through the basement floor drain faster than we could bail. ' +
          'By the time we got downstairs it was past our knees — the boiler, the water heater, my kids’ ' +
          'baby photos, all gone in under an hour. We’ve flooded twice more in smaller storms since. ' +
          'The block needs real drainage, not another pump we buy ourselves.',
      },
      lat: 40.745,
      lng: -73.905,
      location_label: 'Woodside, Queens',
      submitted_at: '2026-07-15T09:00:00.000Z',
      me_too: 12,
      media: [
        { kind: 'photo', url: photo('Basement, 6am', '#7fb8cc', '#2c6b82') },
        { kind: 'photo', url: photo('Curb, Woodside Ave', '#9ec6d4', '#3a7d94') },
        { kind: 'photo', url: photo('Boiler line', '#88bccb', '#255d73') },
      ],
    },
  ];
}
