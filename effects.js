/* ============================================================================
 * Screenick — effect catalogue
 * ----------------------------------------------------------------------------
 * The one list of effects the UI knows about. Loaded by popup.html and
 * options.html before their own scripts; content.js owns the implementations
 * and must register a function under every id here.
 *
 * Order is the grid order, and the grid order is the keyboard order: the
 * twelve keys along the number row, 1 through =.
 * Icons live at icons/fx/<id>.svg.
 * ========================================================================== */

/* exported SFX_EFFECTS, SFX_RANDOM, SFX_DURATIONS, SFX_KEYS, SFX_FILES, sfxIcon, sfxLabel, sfxCapture */

const SFX_EFFECTS = [
  { id: 'prisonBars',   label: 'Prison bars',   blurb: 'Rusted steel slams down and casts shadows on the page.' },
  { id: 'crack',        label: 'Screen crack',  blurb: 'The glass shatters and bends the page through every crack.' },
  { id: 'glitch',       label: 'Glitch',        blurb: 'The page itself corrupts: datamosh, tearing, lost blocks.' },
  { id: 'confetti',     label: 'Confetti',      blurb: 'Paper flutters down and piles up on the page’s own edges.' },
  { id: 'fireworks',    label: 'Fireworks',     blurb: 'Night falls and every burst lights up the page.' },
  { id: 'bugs',         label: 'Bug invasion',  blurb: 'Insects explore the page’s layout. Click one to squash it.' },
  { id: 'spiderman',    label: 'Web slinger',   blurb: 'A masked hero drops from the page’s own header on a line.' },
  { id: 'webShooter',   label: 'Web shooter',   blurb: 'Click anything on the page to web it.' },
  { id: 'underwater',   label: 'Underwater',    blurb: 'Water rises and the page wobbles under caustics and fish.' },
  { id: 'snowstorm',    label: 'Deep freeze',   blurb: 'Frost grows over the glass and blurs the page behind it.' },
  { id: 'thunderstorm', label: 'Thunderstorm',  blurb: 'Rain runs down the glass and lightning lights the page.' },
  { id: 'blackhole',    label: 'Black hole',    blurb: 'Bends the page around it, then swallows it whole.' }
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

/** What gets injected into a tab, in order: the runtime first, then every
 *  effect module (each registers itself with the runtime). */
const SFX_FILES = [
  'content.js',
  'fx/prisonBars.js', 'fx/crack.js', 'fx/glitch.js', 'fx/confetti.js', 'fx/fireworks.js',
  'fx/bugs.js', 'fx/webs.js', 'fx/underwater.js', 'fx/snowstorm.js', 'fx/thunderstorm.js',
  'fx/blackhole.js'
];

const sfxIcon = (id) => `icons/fx/${id}.svg`;

/**
 * Screenshot the visible tab so effects can act on the real page. Needs the
 * activeTab grant (toolbar click, keyboard shortcut) or the optional
 * <all_urls> grant (schedules). Returns a JPEG data URL, or null — every
 * effect has a fallback, so a failed capture never blocks playback.
 */
async function sfxCapture(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 92 });
  } catch (err) {
    console.warn('[Screenick] capture skipped:', err && err.message);
    return null;
  }
}

/**
 * Inject the runtime into a tab and play. If an effect is already up it is
 * stopped first and the capture waits a frame, so the screenshot shows the
 * page and not the previous overlay.
 */
async function sfxPlayInTab(tab, effect, duration, pool) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: SFX_FILES });
  const [prev] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const s = window.__screenick;
      const was = !!(s && s.isPlaying && s.isPlaying());
      if (s) s.stop();
      return was;
    }
  });
  if (prev && prev.result) await new Promise((r) => setTimeout(r, 90));
  const snapshot = await sfxCapture(tab.windowId);
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (name, ms, p, snap) =>
      !!(window.__screenick && await window.__screenick.play(name, { duration: ms, pool: p, snapshot: snap })),
    args: [effect, duration, pool || null, snapshot]
  });
  return !!(res && res.result === true);
}

/** Label for any id, including ones from older versions that no longer exist. */
function sfxLabel(id) {
  if (id === SFX_RANDOM.id) return SFX_RANDOM.label;
  const fx = SFX_EFFECTS.find((e) => e.id === id);
  return fx ? fx.label : 'Retired effect';
}
