/* ============================================================================
 * Screenick popup
 * ----------------------------------------------------------------------------
 * Renders the effect grid from effects.js, owns the duration setting, and
 * injects content.js into the active tab on click.
 * ========================================================================== */

/* global SFX_EFFECTS, SFX_RANDOM, SFX_DURATIONS, SFX_KEYS, sfxIcon, sfxLabel, sfxPlayInTab */

const DEFAULT_MS = 6000;

const grid = document.getElementById('grid');
const seg = document.getElementById('dur');
const thumb = seg.querySelector('.seg-thumb');
const hint = document.getElementById('hint');
const live = document.getElementById('live');
const nextRun = document.getElementById('nextRun');
const heroSub = document.getElementById('heroSub');
const sub = document.getElementById('sub');

let duration = DEFAULT_MS;
let pool = null;          // null = every effect
let busy = false;

/* ---------- render (synchronous, before any storage await) ---------------- *
 * The popup is rebuilt every time it opens, so first paint must not wait on
 * anything. Draw with the defaults, correct once storage answers.            */

SFX_EFFECTS.forEach((fx, i) => {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  tile.dataset.fx = fx.id;
  tile.title = fx.blurb;
  tile.style.setProperty('--i', i);
  const key = SFX_KEYS[i];
  if (key) tile.setAttribute('aria-keyshortcuts', key);

  const img = document.createElement('img');
  img.className = 'tile-icon';
  img.src = sfxIcon(fx.id);
  img.alt = '';
  img.width = img.height = 42;

  const label = document.createElement('span');
  label.className = 'tile-label';
  label.textContent = fx.label;

  tile.append(img, label);
  if (key) {
    const k = document.createElement('kbd');
    k.className = 'key';
    k.setAttribute('aria-hidden', 'true');
    k.textContent = key;
    tile.appendChild(k);
  }
  grid.appendChild(tile);
});

const tiles = [...grid.querySelectorAll('.tile')];

SFX_DURATIONS.forEach((d) => {
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
  opts.forEach((o) => {
    const on = Number(o.dataset.ms) === ms;
    o.setAttribute('aria-checked', String(on));
    o.tabIndex = on ? 0 : -1;
  });
  moveThumb(animate);
  updateSub();
  if (persist) save({ duration: ms });
}

function updateSub() {
  const d = SFX_DURATIONS.find((x) => x.ms === duration);
  sub.textContent = `${SFX_EFFECTS.length} effects · ${d ? d.label : duration / 1000 + 's'} each`;
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
  e.stopPropagation();
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
    console.warn('[Screenick] could not save settings:', err);
  }
}

async function restore() {
  let settings = {};
  try {
    ({ settings = {} } = await chrome.storage.sync.get('settings'));
  } catch (err) {
    console.warn('[Screenick] could not read settings:', err);
  }

  if (settings.theme && settings.theme !== 'auto') {
    document.documentElement.dataset.theme = settings.theme;
  }
  const known = SFX_DURATIONS.some((d) => d.ms === settings.duration);
  setDuration(known ? settings.duration : DEFAULT_MS, { persist: false, animate: false });

  if (Array.isArray(settings.randomPool)) {
    pool = settings.randomPool.filter((id) => SFX_EFFECTS.some((e) => e.id === id));
    if (!pool.length || pool.length === SFX_EFFECTS.length) pool = null;
  }
  heroSub.textContent = pool
    ? `A random pick from your ${pool.length} favourites`
    : 'A random effect from all ' + SFX_EFFECTS.length;
  if (settings.lastEffect && settings.lastEffect !== 'random' && !pool) {
    heroSub.textContent += ` · last: ${sfxLabel(settings.lastEffect)}`;
  }
}

async function showNextRun() {
  try {
    const when = await chrome.runtime.sendMessage({ type: 'NEXT_RUN' });
    nextRun.textContent = when
      ? 'Next ' + new Date(when).toLocaleString([], {
          weekday: 'short', hour: 'numeric', minute: '2-digit'
        })
      : 'Book an effect for later';
  } catch {
    nextRun.textContent = 'Book an effect for later';
  }
}

/* ---------- play ---------------------------------------------------------- */

function fail(text) {
  hint.textContent = text;
  hint.classList.add('is-error');
  live.textContent = text;
  tiles.forEach((t) => t.classList.remove('is-playing'));
  busy = false;
}

async function play(id) {
  if (busy) return;
  busy = true;
  const tile = tiles.find((t) => t.dataset.fx === id);
  if (tile) tile.classList.add('is-playing');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return fail('No active tab to play on.');

    // activeTab covers this: the grant was made when the toolbar icon was
    // clicked to open this popup, and it covers exactly this tab.
    // play() reports whether it actually started. Without checking it, a tab
    // still holding an older build just does nothing when asked for an effect
    // that build has never heard of, and the popup closes as if it worked.
    const ok = await sfxPlayInTab(tab, id, duration, pool);
    if (!ok) {
      fail('That effect didn’t start. Reload the page and try again.');
      return;
    }

    save({ lastEffect: id });
    // Let the press state finish reading before the popup disappears.
    setTimeout(() => window.close(), 120);
  } catch (err) {
    console.warn('[Screenick]', err);
    fail('Screenick can’t run on this page. Open a website and try again.');
  }
}

grid.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (tile) play(tile.dataset.fx);
});

document.getElementById('surprise').addEventListener('click', () => play(SFX_RANDOM.id));
document.getElementById('openOptions').addEventListener('click', openSettings);
document.getElementById('schedulesRow').addEventListener('click', openSettings);

async function openSettings() {
  // openOptionsPage resolves once the tab is actually opening. Closing the
  // popup first tears down this context mid-call and the tab never appears.
  try {
    await chrome.runtime.openOptionsPage();
  } catch (err) {
    console.warn('[Screenick] could not open settings:', err);
    await chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
  window.close();
}

/* ---------- keyboard ------------------------------------------------------ */

document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;

  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    play(SFX_RANDOM.id);
    return;
  }

  const n = SFX_KEYS.indexOf(e.key);
  if (n >= 0 && n < tiles.length) {
    e.preventDefault();
    tiles[n].focus();
    play(tiles[n].dataset.fx);
    return;
  }

  // Arrow keys walk the grid, but only when focus is in it — the duration
  // radiogroup handles its own arrows.
  const from = tiles.indexOf(document.activeElement);
  if (from < 0) return;
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 }[e.key];
  if (!step) return;
  e.preventDefault();
  const to = from + step;
  if (to >= 0 && to < tiles.length) tiles[to].focus();
});

/* ---------- boot ---------------------------------------------------------- */

updateSub();
restore();
showNextRun();
// Two frames: one for layout, one for font metrics to settle, so the thumb
// measures its option at its final width.
requestAnimationFrame(() => requestAnimationFrame(() => moveThumb(false)));
