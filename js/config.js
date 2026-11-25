/* Config loading + theming.
   Every deployment directory contains a config.json produced by the build:
   { platform: { supabaseUrl, publishableKey }, tenant: { ...tenant.json } }
   The engine renders everything from this object; there is no tenant-specific
   code anywhere in engine/. */

const REQUIRED = ['slug', 'name', 'theme', 'map', 'storySchema', 'cta'];

export async function loadConfig() {
  const res = await fetch('./config.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`config.json missing (${res.status})`);
  const cfg = await res.json();
  const missing = REQUIRED.filter(k => !(k in (cfg.tenant || {})));
  if (!cfg.platform?.supabaseUrl || !cfg.platform?.publishableKey) {
    throw new Error('config.platform is incomplete');
  }
  if (missing.length) throw new Error(`tenant config missing: ${missing.join(', ')}`);
  return cfg;
}

const THEME_VARS = {
  primary: '--primary',
  primaryDark: '--primary-d',
  primaryLight: '--primary-l',
  accent: '--accent',
  danger: '--danger',
  text: '--text',
  muted: '--muted',
  border: '--border',
  bg: '--bg',
};

export function applyTheme(tenant) {
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(THEME_VARS)) {
    if (tenant.theme[key]) root.style.setProperty(cssVar, tenant.theme[key]);
  }
  if (tenant.theme.font) root.style.setProperty('--font', tenant.theme.font);
  // Optional display face for brand + section titles (falls back to --font).
  if (tenant.theme.fontDisplay) root.style.setProperty('--font-display', tenant.theme.fontDisplay);
  // Optional call-to-action styling, independent of the primary brand color,
  // so a tenant can lead with a different, more inviting color on "share".
  if (tenant.theme.cta) root.style.setProperty('--cta', tenant.theme.cta);
  if (tenant.theme.ctaText) root.style.setProperty('--cta-text', tenant.theme.ctaText);
  if (tenant.theme.ctaShadow) root.style.setProperty('--cta-shadow', tenant.theme.ctaShadow);
  // Optional header treatment: "clean" swaps the gradient bar for a light,
  // solid surface. Default (unset) keeps the gradient.
  if (tenant.theme.headerStyle) root.dataset.header = tenant.theme.headerStyle;
  if (tenant.theme.headerBg) root.style.setProperty('--header-bg', tenant.theme.headerBg);
  // Optional logo tile treatment (accepts any CSS background, gradients welcome).
  if (tenant.theme.logoBg) root.style.setProperty('--logo-bg', tenant.theme.logoBg);

  /* The story-type palette, published as CSS variables (REB-463).

     One colour represents a story everywhere — map pin, side pane, card,
     detail header, form, admin — and the TYPE is carried by a glyph. Before
     this, that idea lived in five config keys per option (`color`, `gradient`,
     `tint`, `ink`, `icon`) read from eight places, so REB-455 changed the map
     and left every other surface on the old hues. This is the one statement of
     it, and CSS is where a colour belongs.

     `deep` exists because the brand blue cannot carry white text: measured at
     2.43:1 against white, well under the 4.5 a label needs. Any surface that
     wants white on blue uses `--story-blue-deep` (6.07:1). Any surface that
     wants the brand blue as a background pairs it with the theme's ink
     (6.45:1). Both pairs are measured, not chosen by eye. */
  const brand = storyBrandColor(tenant);
  root.style.setProperty('--story-blue', brand);
  root.style.setProperty('--story-blue-deep', storyBrandDeep(tenant));
  root.style.setProperty('--story-blue-text', storyBrandText(tenant));
  root.style.setProperty('--story-tile', storyBrandTile(tenant));
  root.style.setProperty('--story-tile-active', storyBrandTileActive(tenant));
  /* The filter row is NOT a story surface. It had been sharing the tile's
     active token, so changing the tile hover colour would have silently
     repainted the filters too (REB-468). */
  root.style.setProperty('--filter-color', storyFilterColor(tenant));
  document.title = tenant.branding?.title || tenant.name;
  if (tenant.branding?.language) {
    document.documentElement.lang = tenant.branding.language;
  }
}

/* Convenience accessors over the story schema. */
export function schemaField(tenant, id) {
  return tenant.storySchema.fields.find(f => f.id === id) || null;
}

export function roleField(tenant, role) {
  const id = tenant.storySchema.roles?.[role];
  return id ? schemaField(tenant, id) : null;
}

/* `retiredOptions` are choices no longer OFFERED but still held by stories
   already submitted — tenure lost "Public housing (NYCHA)" on 7 Aug (REB-438).
   Dropping the option without keeping its label would leave the admin and the
   CSV export showing a bare id like `nycha` for every resident who picked it,
   which is a silent data-quality loss disguised as a copy change. Lookup falls
   back to them; nothing renders them as a choice. */
export function fieldOption(field, optionId) {
  return field?.options?.find(o => o.id === optionId)
    || field?.retiredOptions?.find(o => o.id === optionId)
    || null;
}

/* Color for a story pin: option color of the "color"-role field. */
export function storyColor(tenant, story, fallback) {
  const field = roleField(tenant, 'color');
  const opt = fieldOption(field, story.answers?.[field?.id]);
  return opt?.color || fallback || tenant.theme.primary;
}

/* ── The one colour a story wears (REB-455, extended in REB-463) ──────────
   Every story is one brand blue everywhere it appears, and the story TYPE is
   carried by a glyph instead of a hue.

   Why: four coloured raindrops competed with four city-data layers already
   spending red, pink, purple, green and amber, so "what kind of story" and
   "what kind of city data" were being said in the same visual language. One
   calm colour lets the stories read as a single voice, and shape carries the
   distinction the way it does for the FloodNet diamonds.

   REB-455 applied that to the map alone. These two accessors exist so the rest
   of the app can say the same thing without each surface deciding for itself —
   which is exactly how the side pane, the cards, the detail header, the form
   and the admin were all left on the old hues for a week.

   `storyBrandColor` takes no story on purpose. It used to, and a function that
   accepts a story implies the answer might depend on it. It does not. */
export function storyBrandColor(tenant) {
  return tenant.storySchema?.pinColor || tenant.theme?.primary;
}

/* The same blue, dark enough to carry white text.

   Measured, not picked: the brand blue against white is 2.43:1, well under the
   4.5 a label needs, so any surface that wants white-on-blue has to use this
   one (6.07:1). Configurable, with a fallback so a tenant that sets only
   `pinColor` still gets something legible rather than something pretty. */
export function storyBrandDeep(tenant) {
  return tenant.storySchema?.pinColorDeep || tenant.theme?.primaryDark || storyBrandColor(tenant);
}

/* The same blue again, dark enough to be TEXT on a light surface.

   Judy asked for the story-type label on a card to match the raindrop's blue.
   It cannot, literally: the brand blue on white measures 2.43:1 against the 4.5
   a label needs, and so does every blue between it and this one. This is the
   lightest member of the hue family that passes, at 4.60:1, so it reads as the
   drop's colour without being unreadable. Configurable for the same reason the
   other two are. */
export function storyBrandText(tenant) {
  return tenant.storySchema?.pinColorText || storyBrandDeep(tenant);
}

/* The filter tiles: Judy's exact brand pair (REB-466).

   The resting tile IS the raindrop blue, so the pane and the map pins are the
   same colour, which was the whole point. The active tile is the Rainproof
   green, the other end of the brand gradient.

   What could not follow her brief is the ink. White measures 2.43:1 on the blue
   and 2.68:1 on the green, both far under the 4.5 a label needs and under the 3
   a graphic needs, so the glyph and label are dark (6.45:1 and 5.85:1). There is
   no size or weight at which white on either of these is legal.

   These two are only 1.10:1 apart in lightness, so the state change is carried
   almost entirely by hue. That is fine for most readers and unreliable for a
   colour-blind one, which is why `.tpill.on` also draws a ring — the state has
   a non-colour cue and does not depend on telling cyan from green. */
export function storyBrandTile(tenant) {
  return tenant.storySchema?.pinColorTile || storyBrandColor(tenant);
}
export function storyBrandTileActive(tenant) {
  return tenant.storySchema?.pinColorTileActive || storyBrandDeep(tenant);
}

/* The Category / Event / Year / Area buttons. Judy: "too much blue on the
   sidepane." Deliberately its own value rather than a story colour: these are
   filters, not stories, and the two only looked alike for one afternoon. */
export function storyFilterColor(tenant) {
  return tenant.storySchema?.filterColor || tenant.theme?.accent;
}

/* Kept for engine compatibility: other layouts still call it with a story.
   Delegates, so there is one definition of the colour and not two. */
export function storyPinColor(tenant, story) {
  return tenant.storySchema?.pinColor || storyColor(tenant, story);
}

/* Which glyph names this story's type. Null when the tenant has not given its
   options icons, which is the signal to fall back to a plain drop. */
export function storyIcon(tenant, story) {
  const field = roleField(tenant, 'color');
  return fieldOption(field, story.answers?.[field?.id])?.icon || null;
}

export function storyGradient(tenant, story) {
  const field = roleField(tenant, 'color');
  const opt = fieldOption(field, story.answers?.[field?.id]);
  return opt?.gradient || [tenant.theme.primary, tenant.theme.accent || tenant.theme.primaryDark];
}

export function storyText(tenant, story) {
  const field = roleField(tenant, 'text');
  return (field && story.answers?.[field.id]) || '';
}

/* Optional "fun prompts" pack: playful conversation starters a tenant can
   supply to inspire submissions. Each entry is a string or { text, emoji }.
   Returns a normalized [{ text, emoji }] (emoji optional). Empty when unset,
   so every consumer degrades to its plain default. This is what re-skins the
   same collection for a wedding vs. family history vs. a trip diary. */
export function promptPack(tenant) {
  const raw = tenant.prompts;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(p => (typeof p === 'string' ? { text: p } : p && typeof p.text === 'string' ? { text: p.text, emoji: p.emoji } : null))
    .filter(Boolean);
}
