/* ============================================================================
 * ScreenFX settings
 * ----------------------------------------------------------------------------
 * Owns the defaults (duration, appearance) and the schedule list. The service
 * worker owns the alarms — this page only writes chrome.storage.sync, and
 * background.js rebuilds every alarm when it sees the change. One source of
 * truth, and a schedule synced from another device schedules itself.
 * ========================================================================== */

const EFFECT_LABELS = {
  random: 'Random effect',
  prisonBars: 'Prison bars',
  spiderman: 'Web slinger',
  webShooter: 'Web shooter',
  waterfall: 'Flood',
  underwater: 'Underwater',
  glitch: 'Glitch',
  confetti: 'Confetti',
  crack: 'Screen crack'
};

const DURATIONS = [
  { ms: 3000,  label: '3s' },
  { ms: 6000,  label: '6s' },
  { ms: 12000, label: '12s' },
  { ms: 30000, label: '30s' }
];

const THEMES = [
  { id: 'auto',  label: 'Auto' },
  { id: 'light', label: 'Light' },
  { id: 'dark',  label: 'Dark' }
];

const DAYS = [
  { n: 1, short: 'Mon' }, { n: 2, short: 'Tue' }, { n: 3, short: 'Wed' },
  { n: 4, short: 'Thu' }, { n: 5, short: 'Fri' }, { n: 6, short: 'Sat' },
  { n: 0, short: 'Sun' }
];
const WEEKDAYS = [1, 2, 3, 4, 5];

const DEFAULTS = { duration: 6000, theme: 'auto', lastEffect: null };

const $ = (id) => document.getElementById(id);
const listGroup = $('listGroup');
const listFoot = $('listFoot');
const toastEl = $('toast');

let settings = { ...DEFAULTS };
let schedules = [];
let newDays = [...WEEKDAYS];
let toastTimer = null;

/* ---------- storage ------------------------------------------------------- */

async function load() {
  try {
    const data = await chrome.storage.sync.get(['settings', 'schedules']);
    settings = { ...DEFAULTS, ...(data.settings || {}) };
    schedules = Array.isArray(data.schedules) ? data.schedules : [];
  } catch (err) {
    console.warn('[ScreenFX] could not read storage:', err);
    toast('Unable to read your settings. Changes may not be saved.', 'error');
  }
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  try {
    await chrome.storage.sync.set({ settings });
  } catch (err) {
    console.warn('[ScreenFX] could not save settings:', err);
    toast('Unable to save that setting. Try again.', 'error');
  }
}

async function saveSchedules() {
  try {
    await chrome.storage.sync.set({ schedules });
  } catch (err) {
    console.warn('[ScreenFX] could not save schedules:', err);
    toast('Unable to save the schedule. Try again.', 'error');
  }
}

/* ---------- segmented controls -------------------------------------------- */

/** Build a radiogroup plus its sliding thumb. */
function buildSegment(root, items, initial, onPick) {
  const thumb = root.querySelector('.seg-thumb');

  items.forEach((it) => {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'seg-opt';
    opt.dataset.value = it.value;
    opt.setAttribute('role', 'radio');
    opt.setAttribute('aria-checked', String(it.value === String(initial)));
    opt.textContent = it.label;
    root.appendChild(opt);
  });

  const opts = [...root.querySelectorAll('.seg-opt')];

  // animate=false suspends the transition and forces a reflow first, so the
  // thumb snaps into place on first paint instead of springing in from zero
  function move(animate = true) {
    const active = opts.find((o) => o.getAttribute('aria-checked') === 'true') || opts[0];
    if (!animate) { thumb.style.transition = 'none'; void thumb.offsetWidth; }
    thumb.style.width = active.offsetWidth + 'px';
    thumb.style.height = active.offsetHeight + 'px';
    thumb.style.transform = `translateX(${active.offsetLeft - 2}px)`;
    if (!animate) requestAnimationFrame(() => { thumb.style.transition = ''; });
  }

  function set(value, { notify = true } = {}) {
    opts.forEach((o) => o.setAttribute('aria-checked', String(o.dataset.value === String(value))));
    move();
    if (notify) onPick(value);
  }

  root.addEventListener('click', (e) => {
    const opt = e.target.closest('.seg-opt');
    if (opt) set(opt.dataset.value);
  });

  root.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const from = opts.findIndex((o) => o.getAttribute('aria-checked') === 'true');
    const next = opts[(from + step + opts.length) % opts.length];
    set(next.dataset.value);
    next.focus();
  });

  window.addEventListener('resize', () => move(false));
  return { move };
}

/* ---------- schedule list -------------------------------------------------- */

function dayLabel(days) {
  if (!days || days.length === 7) return 'Every day';
  if (days.length === 5 && WEEKDAYS.every((d) => days.includes(d))) return 'Weekdays';
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Weekends';
  return DAYS.filter((d) => days.includes(d.n)).map((d) => d.short).join(', ');
}

/** The footnote under the list is the one place worth spending on status:
 *  when the next effect actually fires, or that nothing is booked yet. */
async function showNextRun() {
  if (!schedules.length) {
    listFoot.textContent = 'No schedules yet. Add one below to have an effect play at a set time.';
    return;
  }
  try {
    const when = await chrome.runtime.sendMessage({ type: 'NEXT_RUN' });
    listFoot.textContent = when
      ? 'Next ' + new Date(when).toLocaleString([], {
          weekday: 'long', hour: 'numeric', minute: '2-digit'
        })
      : 'Every schedule is turned off.';
  } catch {
    listFoot.textContent = '';
  }
}

function timeLabel(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function render({ newId } = {}) {
  listGroup.textContent = '';
  listGroup.hidden = schedules.length === 0;
  showNextRun();

  schedules.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'row' + (s.id === newId ? ' is-new' : '');
    row.dataset.id = s.id;
    row.dataset.enabled = String(!!s.enabled);

    row.innerHTML = `
      <span class="item-time">${timeLabel(s.time)}</span>
      <span class="item-main">
        <span class="item-effect">${EFFECT_LABELS[s.effect] || s.effect}</span>
        <span class="item-days">${dayLabel(s.days)}</span>
      </span>
      <span class="item-actions">
        <button class="icon-btn" type="button" data-act="preview"
                aria-label="Preview ${EFFECT_LABELS[s.effect] || s.effect}">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
               stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5.2 3.6 12.2 8l-7 4.4z"/>
          </svg>
        </button>
        <button class="icon-btn is-danger" type="button" data-act="delete"
                aria-label="Delete the ${timeLabel(s.time)} schedule">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
               stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 4.6h10M6.4 4.6V3.2h3.2v1.4M4.7 4.6l.6 7.6h5.4l.6-7.6"/>
          </svg>
        </button>
        <button class="switch" type="button" role="switch" aria-checked="${!!s.enabled}"
                aria-label="Enable the ${timeLabel(s.time)} schedule"><span class="switch-thumb"></span></button>
      </span>`;

    listGroup.appendChild(row);
  });
}

listGroup.addEventListener('click', async (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const schedule = schedules.find((s) => s.id === row.dataset.id);
  if (!schedule) return;

  const sw = e.target.closest('.switch');
  if (sw) {
    schedule.enabled = !schedule.enabled;
    sw.setAttribute('aria-checked', String(schedule.enabled));
    row.dataset.enabled = String(schedule.enabled);
    await saveSchedules();
    showNextRun();
    toast(schedule.enabled ? 'Schedule turned on.' : 'Schedule turned off.');
    return;
  }

  const act = e.target.closest('[data-act]');
  if (!act) return;

  if (act.dataset.act === 'preview') {
    const ok = await chrome.runtime.sendMessage({
      type: 'PREVIEW',
      effect: schedule.effect,
      duration: schedule.duration || settings.duration
    });
    if (!ok) toast('Unable to preview here. Try the popup on a website.', 'error');
    return;
  }

  if (act.dataset.act === 'delete') {
    row.classList.add('is-leaving');
    schedules = schedules.filter((s) => s.id !== schedule.id);
    await saveSchedules();
    setTimeout(render, 220);
    toast('Schedule deleted.');
  }
});

/* ---------- add form ------------------------------------------------------- */

function buildAddForm() {
  const select = $('addEffect');
  Object.entries(EFFECT_LABELS).forEach(([id, label]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    select.appendChild(opt);
  });

  const dayWrap = $('addDays');
  DAYS.forEach((d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'day';
    b.dataset.day = d.n;
    b.textContent = d.short;
    b.setAttribute('aria-pressed', String(newDays.includes(d.n)));
    dayWrap.appendChild(b);
  });

  dayWrap.addEventListener('click', (e) => {
    const b = e.target.closest('.day');
    if (!b) return;
    const n = Number(b.dataset.day);
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    newDays = on ? [...newDays, n] : newDays.filter((d) => d !== n);
  });
}

$('addSubmit').addEventListener('click', async () => {
  const time = $('addTime').value;
  if (!time) return toast('Choose a time for the schedule.', 'error');
  if (!newDays.length) return toast('Choose at least one day to repeat on.', 'error');

  const schedule = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).slice(0, 12),
    effect: $('addEffect').value,
    time,
    days: [...newDays].sort(),
    duration: null,          // null = follow Time on screen above
    enabled: true
  };

  schedules = [...schedules, schedule].sort((a, b) => a.time.localeCompare(b.time));
  await saveSchedules();
  render({ newId: schedule.id });

  const granted = await hasPermission();
  toast(granted
    ? `${EFFECT_LABELS[schedule.effect]} added at ${timeLabel(time)}.`
    : 'Schedule added. Turn on Allow scheduled effects so it can play.');
});

/* ---------- permission ----------------------------------------------------- */

async function hasPermission() {
  try {
    return await chrome.runtime.sendMessage({ type: 'HAS_SCHEDULE_PERMISSION' });
  } catch {
    return false;
  }
}

function showPermission(granted) {
  $('permSwitch').setAttribute('aria-checked', String(granted));
  $('permState').textContent = granted ? 'On' : 'Off';
}

$('permSwitch').addEventListener('click', async (e) => {
  const on = e.currentTarget.getAttribute('aria-checked') === 'true';
  // The click gesture survives exactly one sendMessage hop, and the service
  // worker calls permissions.request() as its first statement. Nothing may be
  // awaited on this side before the message goes out.
  const ok = await chrome.runtime.sendMessage({
    type: on ? 'DROP_SCHEDULE_PERMISSION' : 'REQUEST_SCHEDULE_PERMISSION'
  });

  if (on) {
    showPermission(!ok);
    if (ok) toast('Scheduled effects turned off.');
  } else {
    showPermission(ok);
    toast(ok ? 'Scheduled effects turned on.' : 'Permission declined, so schedules will not play.',
      ok ? undefined : 'error');
  }
});

/* ---------- misc ----------------------------------------------------------- */

$('shortcut').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

function toast(text, tone) {
  clearTimeout(toastTimer);
  toastEl.textContent = text;
  toastEl.dataset.tone = tone || 'info';
  toastEl.classList.add('is-open');
  toastTimer = setTimeout(() => toastEl.classList.remove('is-open'), 3400);
}

/* ---------- boot ----------------------------------------------------------- */

(async function init() {
  await load();

  if (settings.theme && settings.theme !== 'auto') {
    document.documentElement.dataset.theme = settings.theme;
  }

  const durSeg = buildSegment(
    $('dur'),
    DURATIONS.map((d) => ({ value: String(d.ms), label: d.label })),
    settings.duration,
    (value) => {
      saveSettings({ duration: Number(value) });
      toast(`Effects now last ${DURATIONS.find((d) => String(d.ms) === value).label}.`);
    }
  );

  const themeSeg = buildSegment(
    $('theme'),
    THEMES.map((t) => ({ value: t.id, label: t.label })),
    settings.theme,
    (value) => {
      if (value === 'auto') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = value;
      saveSettings({ theme: value });
    }
  );

  buildAddForm();
  render();
  showPermission(await hasPermission());

  // Two frames: one for layout, one for font metrics to settle, so each thumb
  // measures its option at its final width.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    durSeg.move(false);
    themeSeg.move(false);
  }));
})();
