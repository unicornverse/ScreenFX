/* ============================================================================
 * ScreenFX — effect catalogue
 * ----------------------------------------------------------------------------
 * The one list of effects the UI knows about. Loaded by popup.html and
 * options.html before their own scripts; content.js owns the implementations
 * and must register a function under every id here.
 *
 * Order is the grid order, and the grid order is the keyboard order: the
 * twelve keys along the number row, 1 through =.
 * Icons live at icons/fx/<id>.svg.
 * ========================================================================== */

/* exported SFX_EFFECTS, SFX_RANDOM, SFX_DURATIONS, SFX_KEYS, sfxIcon, sfxLabel */

const SFX_EFFECTS = [
  { id: 'prisonBars',   label: 'Prison bars',   blurb: 'Steel bars slam down and lock the page in.' },
  { id: 'crack',        label: 'Screen crack',  blurb: 'A dropped-phone shatter, bleeding ink and dead lines.' },
  { id: 'glitch',       label: 'Glitch',        blurb: 'The signal tears, splits and inverts.' },
  { id: 'confetti',     label: 'Confetti',      blurb: 'Two cannons fire, then it keeps raining paper.' },
  { id: 'fireworks',    label: 'Fireworks',     blurb: 'Night falls and a show goes up over the page.' },
  { id: 'bugs',         label: 'Bug invasion',  blurb: 'Beetles crawl in. Click one to squash it.' },
  { id: 'spiderman',    label: 'Web slinger',   blurb: 'A masked hero is lowered down on a line.' },
  { id: 'webShooter',   label: 'Web shooter',   blurb: 'Aim with the pointer, click to shoot webs.' },
  { id: 'underwater',   label: 'Underwater',    blurb: 'The page sinks. Light shafts, bubbles, fish.' },
  { id: 'snowstorm',    label: 'Deep freeze',   blurb: 'Frost creeps in from the edges as snow falls.' },
  { id: 'thunderstorm', label: 'Thunderstorm',  blurb: 'The sky darkens, rain sheets down, lightning hits.' },
  { id: 'blackhole',    label: 'Black hole',    blurb: 'A singularity opens and starts eating the light.' }
];

const SFX_RANDOM = { id: 'random', label: 'Surprise me', blurb: 'A random effect from your mix.' };

/** How long an effect stays on screen. */
const SFX_DURATIONS = [
  { ms: 3000,  label: '3s' },
  { ms: 6000,  label: '6s' },
  { ms: 12000, label: '12s' },
  { ms: 30000, label: '30s' }
];

/** Number-row keys, in grid order. */
const SFX_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];

const sfxIcon = (id) => `icons/fx/${id}.svg`;

/** Label for any id, including ones from older versions that no longer exist. */
function sfxLabel(id) {
  if (id === SFX_RANDOM.id) return SFX_RANDOM.label;
  const fx = SFX_EFFECTS.find((e) => e.id === id);
  return fx ? fx.label : 'Retired effect';
}
