/* ============================================================================
 * ScreenFX — service worker
 * ----------------------------------------------------------------------------
 * Owns three things the popup cannot:
 *   1. scheduled effects (chrome.alarms)
 *   2. the keyboard shortcut (a real user gesture, so activeTab applies)
 *   3. the optional <all_urls> grant that scheduled effects need
 *
 * Service workers are ephemeral — they are torn down after ~30s idle. So:
 *   - every listener is registered synchronously at the top level, or Chrome
 *     will not know to wake us for that event
 *   - nothing lives in a module-scope variable between events; state is read
 *     from chrome.storage on every handler run
 *   - timers are chrome.alarms, never setTimeout — a setTimeout dies with the
 *     worker and the schedule would silently never fire
 * ========================================================================== */

const ALARM_PREFIX = 'sfx:';
const ALL_URLS = { origins: ['<all_urls>'] };

const DEFAULT_SETTINGS = {
  duration: 6000,     // ms an effect stays on screen
  theme: 'auto',      // auto | dark | light
  lastEffect: null,
  randomPool: null    // ids Surprise me may pick; null = all
};

/* Effects that have been retired, and what a schedule pointing at one plays
   instead. Flood was removed in 2.0. */
const RETIRED = { waterfall: 'underwater' };

/* ---------- listeners: all registered synchronously, top level ----------- */

chrome.runtime.onInstalled.addListener(handleInstalled);
chrome.runtime.onStartup.addListener(syncAlarms);   // alarms do not survive a browser restart
chrome.alarms.onAlarm.addListener(handleAlarm);
chrome.storage.onChanged.addListener(handleStorageChanged);
chrome.commands.onCommand.addListener(handleCommand);
chrome.runtime.onMessage.addListener(handleMessage);

/* ---------- storage ------------------------------------------------------ */

async function getSettings() {
  try {
    const { settings } = await chrome.storage.sync.get('settings');
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  } catch (err) {
    // sync storage can be unavailable (profile without sign-in, quota, policy)
    console.warn('[ScreenFX] settings read failed:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

async function getSchedules() {
  try {
    const { schedules } = await chrome.storage.sync.get('schedules');
    return Array.isArray(schedules) ? schedules : [];
  } catch (err) {
    console.warn('[ScreenFX] schedules read failed:', err);
    return [];
  }
}

/* ---------- scheduling --------------------------------------------------- */

/**
 * Next wall-clock time this schedule should fire, or null if it never will.
 * Walks forward day by day so DST shifts and "later today vs tomorrow" both
 * fall out of the same loop rather than needing special cases.
 */
function nextOccurrence(schedule, from = Date.now()) {
  const [hh, mm] = String(schedule.time || '').split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;

  const days = Array.isArray(schedule.days) && schedule.days.length
    ? schedule.days
    : [0, 1, 2, 3, 4, 5, 6];

  for (let add = 0; add <= 7; add++) {
    const d = new Date(from);
    d.setDate(d.getDate() + add);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= from) continue;
    if (days.includes(d.getDay())) return d.getTime();
  }
  return null;
}

/** Rebuild every alarm from storage. Cheap, and the only way to stay correct
 *  after an edit, a delete, a browser restart, or a sync from another device. */
async function syncAlarms() {
  const schedules = await getSchedules();
  await chrome.alarms.clearAll();

  for (const s of schedules) {
    if (!s.enabled) continue;
    const when = nextOccurrence(s);
    if (when) chrome.alarms.create(ALARM_PREFIX + s.id, { when });
  }
}

async function handleInstalled(details) {
  if (details.reason === 'install') {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS, schedules: [] });
  } else if (details.reason === 'update') {
    await migrateRetired();
  }
  await syncAlarms();
}

/** Point schedules (and the random pool) at effects that still exist. */
async function migrateRetired() {
  try {
    const schedules = await getSchedules();
    let changed = false;
    for (const s of schedules) {
      if (RETIRED[s.effect]) { s.effect = RETIRED[s.effect]; changed = true; }
    }
    if (changed) await chrome.storage.sync.set({ schedules });

    const settings = await getSettings();
    if (Array.isArray(settings.randomPool) && settings.randomPool.some((id) => RETIRED[id])) {
      settings.randomPool = settings.randomPool.filter((id) => !RETIRED[id]);
      await chrome.storage.sync.set({ settings });
    }
  } catch (err) {
    console.warn('[ScreenFX] migration skipped:', err);
  }
}

async function handleStorageChanged(changes, area) {
  if (area === 'sync' && changes.schedules) await syncAlarms();
}

async function handleAlarm(alarm) {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;

  const id = alarm.name.slice(ALARM_PREFIX.length);
  const schedules = await getSchedules();
  const schedule = schedules.find((s) => s.id === id);
  if (!schedule || !schedule.enabled) return;

  const settings = await getSettings();
  await fireOnActiveTab(RETIRED[schedule.effect] || schedule.effect,
    schedule.duration || settings.duration, true, settings.randomPool);

  // Re-arm immediately. A repeating alarm cannot express "09:00 on Mon/Wed",
  // so each firing schedules its own successor.
  const when = nextOccurrence(schedule);
  if (when) chrome.alarms.create(alarm.name, { when });
}

/* ---------- injection ---------------------------------------------------- */

/**
 * Play an effect on whatever tab the user is looking at.
 * @param {string} effect  effect id, or 'random'
 * @param {number} duration ms
 * @param {boolean} scheduled true when there was no user gesture, so the call
 *        depends on the optional host grant rather than activeTab
 * @param {string[]|null} pool ids 'random' may pick from
 */
async function fireOnActiveTab(effect, duration, scheduled, pool = null) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) return false;

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (name, ms, p) => window.__screenFX && window.__screenFX.play(name, { duration: ms, pool: p }),
      args: [effect, duration, pool]
    });
    await flashBadge('', '');
    return true;
  } catch (err) {
    // Expected on chrome://, the Web Store, other extensions and the PDF
    // viewer — and on every page if the schedule grant was revoked.
    console.warn('[ScreenFX] injection skipped:', err && err.message);
    if (scheduled) {
      const granted = await chrome.permissions.contains(ALL_URLS).catch(() => false);
      await flashBadge(granted ? '·' : '!', granted ? '#8B8470' : '#FF6A46');
    }
    return false;
  }
}

async function flashBadge(text, color) {
  try {
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
    if (text) setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  } catch { /* action API unavailable — not worth failing the effect over */ }
}

/* ---------- keyboard shortcut ------------------------------------------- *
 * A commands shortcut IS a direct user gesture, so activeTab covers it and no
 * host permission is involved. This is the one way to fire an effect without
 * opening the popup.                                                        */

async function handleCommand(command) {
  if (command !== 'surprise-me') return;
  const settings = await getSettings();
  await fireOnActiveTab('random', settings.duration, false, settings.randomPool);
}

/* ---------- messages ----------------------------------------------------- */

function handleMessage(message, sender, sendResponse) {
  // chrome.permissions.request() must be the FIRST thing this listener does.
  // The click gesture survives exactly one sendMessage hop; any await before
  // the call burns it and Chrome throws "must be called during a user gesture".
  if (message && message.type === 'REQUEST_SCHEDULE_PERMISSION') {
    chrome.permissions.request(ALL_URLS).then(sendResponse).catch(() => sendResponse(false));
    return true;
  }

  if (message && message.type === 'DROP_SCHEDULE_PERMISSION') {
    chrome.permissions.remove(ALL_URLS).then(sendResponse).catch(() => sendResponse(false));
    return true;
  }

  if (message && message.type === 'HAS_SCHEDULE_PERMISSION') {
    chrome.permissions.contains(ALL_URLS).then(sendResponse).catch(() => sendResponse(false));
    return true;
  }

  if (message && message.type === 'NEXT_RUN') {
    (async () => {
      const schedules = await getSchedules();
      const next = schedules
        .filter((s) => s.enabled)
        .map((s) => nextOccurrence(s))
        .filter(Boolean)
        .sort((a, b) => a - b)[0];
      sendResponse(next || null);
    })();
    return true;
  }

  return false;   // nothing async pending, let the channel close
}
