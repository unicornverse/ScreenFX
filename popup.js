/* ============================================================================
 * ScreenFX popup
 * ----------------------------------------------------------------------------
 * Renders the effect grid, owns the duration setting, and injects content.js
 * into the active tab on click.
 *
 * ADDING A 7TH EFFECT: append one entry to EFFECTS below, matching the function
 * name registered in content.js. The grid, the numbering and the keyboard
 * shortcut all follow from that.
 *
 * Glyphs: 24x24 viewBox, monoline, stroke = currentColor at 1.6 with round caps
 * and joins, sized to read at 24px. One stroke weight across the whole set —
 * a glyph that is heavier than its neighbours looks like a different icon set.
 * ========================================================================== */

const EFFECTS = [
  {
    id: 'prisonBars',
    label: 'Prison bars',
    glyph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3.5 3.6h17"/>
      <path d="M5.4 6.4v14"/><path d="M9.8 6.4v14"/><path d="M14.2 6.4v14"/><path d="M18.6 6.4v14"/>
    </svg>`
  },
  {
    id: 'spiderman',
    label: 'Web drop',
    glyph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 3.2 9.6 4.4M3 3.2 5.6 9.2M3 3.2 3.9 10.4" opacity=".55"/>
      <path d="M5.6 4.1 5 7.4 3.5 9.1" opacity=".4"/>
      <path d="M14.4 2.8v10.4"/>
      <circle cx="14.4" cy="16.8" r="3.5" fill="currentColor" stroke="none"/>
    </svg>`
  },
  {
    id: 'waterfall',
    label: 'Flood',
    glyph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2.4 10.4q2.4-2.6 4.8 0t4.8 0 4.8 0 4.8 0"/>
      <path d="M2.4 15.2q2.4-2.6 4.8 0t4.8 0 4.8 0 4.8 0" opacity=".55"/>
      <path d="M2.4 20q2.4-2.6 4.8 0t4.8 0 4.8 0 4.8 0" opacity=".3"/>
    </svg>`
  },
  {
    id: 'glitch',
    label: 'Glitch',
    glyph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2.6" y="4" width="18.8" height="13.2" rx="2.6"/>
      <path d="M6.4 8.6h7.2"/>
      <path d="M9.2 12.2h8.4" opacity=".6"/>
      <path d="M6.4 15.4h4.4" opacity=".4"/>
      <path d="M9 20.4h6"/>
    </svg>`
  },
  {
    id: 'confetti',
    label: 'Confetti',
    glyph: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <rect x="3" y="2.6" width="3.6" height="4.8" rx=".9" transform="rotate(-20 4.8 5)"/>
      <circle cx="12.4" cy="4.4" r="1.8"/>
      <rect x="18.6" y="2.8" width="1.8" height="5.6" rx=".9" transform="rotate(26 19.5 5.6)"/>
      <rect x="3.6" y="13.2" width="1.8" height="5.4" rx=".9" transform="rotate(32 4.5 15.9)" opacity=".75"/>
      <rect x="10.4" y="13.4" width="4" height="4" rx=".9" transform="rotate(-27 12.4 15.4)" opacity=".75"/>
      <circle cx="19.6" cy="17.4" r="1.7" opacity=".75"/>
      <circle cx="12" cy="20.8" r="1.3" opacity=".5"/>
    </svg>`
  },
  {
    id: 'crack',
    label: 'Screen crack',
    glyph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 12 15 7.6 14.1 4.8 16.3 1.8"/>
      <path d="M12 12 18.3 11.2 21.5 13.3"/>
      <path d="M12 12 15.8 16 15.3 19 17.5 21.8"/>
      <path d="M12 12 11.2 17.1 8.9 20.4"/>
      <path d="M12 12 7.4 14.5 3.3 13.8"/>
      <path d="M12 12 7.8 9 6.5 5.4"/>
      <path d="M12 12 11.5 7.2 12.8 3.8"/>
      <path d="M15 7.6 18.3 11.2" stroke-width="1.2" opacity=".45"/>
      <path d="M11.2 17.1 15.8 16" stroke-width="1.2" opacity=".45"/>
      <path d="M7.4 14.5 7.8 9" stroke-width="1.2" opacity=".45"/>
    </svg>`
  }
];

/** How long an effect stays on screen. Four steps is the most the row fits
 *  without the labels turning into abbreviations. */
const DURATIONS = [
  { ms: 3000,  label: '3s' },
  { ms: 6000,  label: '6s' },
  { ms: 12000, label: '12s' },
  { ms: 30000, label: '30s' }
];
const DEFAULT_MS = 6000;

const grid = document.getElementById('grid');
const seg = document.getElementById('dur');
const thumb = seg.querySelector('.seg-thumb');
const hint = document.getElementById('hint');
const live = document.getElementById('live');
const nextRun = document.getElementById('nextRun');

let duration = DEFAULT_MS;
let busy = false;

/* ---------- render (synchronous, before any storage await) ---------------- *
 * The popup is rebuilt every time it opens, so first paint must not wait on
 * anything. Draw with the defaults, correct once storage answers.            */

EFFECTS.forEach((fx, i) => {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  tile.dataset.fx = fx.id;
  tile.innerHTML =
    `<span class="tile-glyph">${fx.glyph}</span>` +
    `<span class="tile-label">${fx.label}</span>`;
  // The visible position already communicates the shortcut; the label only has
  // to carry it for screen-reader users.
  tile.setAttribute('aria-keyshortcuts', String(i + 1));
  grid.appendChild(tile);
});

const tiles = [...grid.querySelectorAll('.tile')];

DURATIONS.forEach((d) => {
  const opt = document.createElement('button');
  opt.type = 'button';
  opt.className = 'seg-opt';
  opt.dataset.ms = d.ms;
  opt.setAttribute('role', 'radio');
  opt.setAttribute('aria-checked', String(d.ms === duration));
  opt.textContent = d.label;
  seg.appendChild(opt);
});

const opts = [...seg.querySelectorAll('.seg-opt')];

/* ---------- duration ------------------------------------------------------ */

/** Move the thumb under the active option. `animate = false` suspends the
 *  transition and forces a reflow first, so it snaps into place on first paint
 *  instead of springing in from zero width. */
function moveThumb(animate = true) {
  const active = opts.find((o) => o.getAttribute('aria-checked') === 'true') || opts[0];
  if (!animate) {
    thumb.style.transition = 'none';
    void thumb.offsetWidth;
  }
  thumb.style.width = active.offsetWidth + 'px';
  thumb.style.height = active.offsetHeight + 'px';
  thumb.style.transform = `translateX(${active.offsetLeft - 2}px)`;
  if (!animate) requestAnimationFrame(() => { thumb.style.transition = ''; });
}

function setDuration(ms, { persist = true, animate = true } = {}) {
  duration = ms;
  opts.forEach((o) => o.setAttribute('aria-checked', String(Number(o.dataset.ms) === ms)));
  moveThumb(animate);
  if (persist) save({ duration: ms });
}

seg.addEventListener('click', (e) => {
  const opt = e.target.closest('.seg-opt');
  if (!opt) return;
  setDuration(Number(opt.dataset.ms));
  live.textContent = `Effects now last ${opt.textContent}`;
});

seg.addEventListener('keydown', (e) => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const from = opts.findIndex((o) => o.getAttribute('aria-checked') === 'true');
  const next = opts[(from + step + opts.length) % opts.length];
  setDuration(Number(next.dataset.ms));
  next.focus();
});

/* ---------- storage ------------------------------------------------------- */

async function save(patch) {
  try {
    const { settings } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...(settings || {}), ...patch } });
  } catch (err) {
    // Not worth interrupting for — the setting just will not stick.
    console.warn('[ScreenFX] could not save settings:', err);
  }
}

async function restore() {
  let settings = {};
  try {
    ({ settings = {} } = await chrome.storage.sync.get('settings'));
  } catch (err) {
    console.warn('[ScreenFX] could not read settings:', err);
  }

  if (settings.theme && settings.theme !== 'auto') {
    document.documentElement.dataset.theme = settings.theme;
  }
  const known = DURATIONS.some((d) => d.ms === settings.duration);
  setDuration(known ? settings.duration : DEFAULT_MS, { persist: false, animate: false });
}

async function showNextRun() {
  try {
    const when = await chrome.runtime.sendMessage({ type: 'NEXT_RUN' });
    nextRun.textContent = when
      ? 'Next ' + new Date(when).toLocaleString([], {
          weekday: 'short', hour: 'numeric', minute: '2-digit'
        })
      : 'No schedules yet';
  } catch {
    nextRun.textContent = 'No schedules yet';
  }
}

/* ---------- play ---------------------------------------------------------- */

function fail(text) {
  hint.textContent = text;
  hint.classList.add('is-error');
  live.textContent = text;
  busy = false;
}

async function play(id) {
  if (busy) return;
  busy = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return fail('No active tab to play on.');

    // activeTab covers this: the grant was made when the toolbar icon was
    // clicked to open this popup, and it covers exactly this tab.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (name, ms) => window.__screenFX && window.__screenFX.play(name, { duration: ms }),
      args: [id, duration]
    });

    save({ lastEffect: id });
    // Let the press state finish reading before the popup disappears.
    setTimeout(() => window.close(), 110);
  } catch (err) {
    console.warn('[ScreenFX]', err);
    fail('ScreenFX can’t run on this page. Open a website and try again.');
  }
}

grid.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (tile) play(tile.dataset.fx);
});

document.getElementById('openOptions').addEventListener('click', openSettings);
document.getElementById('schedulesRow').addEventListener('click', openSettings);

async function openSettings() {
  // openOptionsPage resolves once the tab is actually opening. Closing the
  // popup first tears down this context mid-call and the tab never appears —
  // which is exactly what "clicking Schedules just closes the popup" was.
  try {
    await chrome.runtime.openOptionsPage();
  } catch (err) {
    console.warn('[ScreenFX] could not open settings:', err);
    await chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
  window.close();
}

/* ---------- keyboard ------------------------------------------------------ */

document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;

  const n = Number(e.key);
  if (n >= 1 && n <= EFFECTS.length) {
    e.preventDefault();
    tiles[n - 1].focus();
    play(EFFECTS[n - 1].id);
    return;
  }

  // Arrow keys walk the grid, but only when focus is in it — the duration
  // radiogroup handles its own arrows.
  const from = tiles.indexOf(document.activeElement);
  if (from < 0) return;
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 }[e.key];
  if (!step) return;
  e.preventDefault();
  tiles[(from + step + tiles.length) % tiles.length].focus();
});

/* ---------- boot ---------------------------------------------------------- */

restore();
showNextRun();
// Two frames: one for layout, one for font metrics to settle, so the thumb
// measures its option at its final width.
requestAnimationFrame(() => requestAnimationFrame(() => moveThumb(false)));
