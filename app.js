/* ===========================================================================
 * Trolling speedometer
 *
 * Design note — why we read coords.speed instead of differencing positions:
 * at 1.3 MPH the boat covers about 3.5 m in six seconds, which is *smaller*
 * than a typical GPS position fix error (±5 m). Deriving speed from successive
 * lat/lon fixes at trolling speed therefore produces mostly noise. GPS reports
 * velocity separately, from Doppler shift on the satellite carrier, and that is
 * good to roughly ±0.1 m/s no matter how slowly you are going. So coords.speed
 * is the primary source; position differencing is only a fallback.
 * =========================================================================== */

'use strict';

/* --- constants ----------------------------------------------------------- */

const UNITS = {
  mph: { label: 'MPH',  perMs: 2.2369362920544, sliderMax: 8,  step: 0.1 },
  kn:  { label: 'KN',   perMs: 1.9438444924406, sliderMax: 7,  step: 0.1 },
  kmh: { label: 'KM/H', perMs: 3.6,             sliderMax: 13, step: 0.1 },
};

const MEDIAN_WINDOW   = 5;      // samples; rejects single-fix GPS spikes
const SPREAD_WINDOW_MS = 10000; // window used for the ± figure
const SAMPLE_KEEP_MS  = 20000;  // ring buffer retention
const DEADBAND_MS     = 0.089;  // ~0.2 MPH. Below this, show a hard 0.0
const STALE_MS        = 12000;  // no contact from the receiver at all for this long
const AGING_MS        = 4000;   // fix older than this -> downgrade signal quality
const STOPPED_MS      = 0.223;  // ~0.5 MPH. Below this we were moored, not moving
const RENDER_MS       = 200;

const ACC_GOOD = 10;            // metres
const ACC_FAIR = 30;

/* Smoothing is stored as the EMA time constant, but shown to the user as a
 * settle time, because "6 seconds" on a slider naturally reads as "takes six
 * seconds to catch up" and a time constant does not mean that — an EMA reaches
 * only 63% of a step in one tau, and ~95% in three. SETTLE_FACTOR is that 3x. */
const SETTLE_FACTOR = 3;

const DEFAULTS = {
  unit: 'mph',
  tau: 1,                       // smoothing time constant, seconds (~3 s to settle)
  wake: true,
  sim: false,
  scenario: 'manual',
  simSpeed: 1.3,                // in whatever unit was active when set
  launched: false,              // has the start screen been through once?
};

const SCENARIO_NOTES = {
  manual:  'Holds whatever speed you set on the slider, with a little GPS noise on top.',
  troll:   'Sweeps slowly between a crawl and about 3 MPH, the way a troll pass tends to go.',
  chop:    'Steady 1.3 MPH with wave action fighting you — the noisiest realistic case.',
  dropout: 'Good signal, then degraded accuracy, then a total loss of fix. Shows every failure state.',
};

/* --- element handles ----------------------------------------------------- */

const $ = (id) => document.getElementById(id);

const el = {
  speedValue: $('speedValue'),
  unitLabel:  $('unitLabel'),
  statusLine: $('statusLine'),
  gpsDot:     $('gpsDot'),
  gpsAcc:     $('gpsAcc'),
  speedVar:   $('speedVar'),
  varLabel:   $('varLabel'),
  liveSpeed:  $('liveSpeed'),
  startOverlay: $('startOverlay'),
  startBtn:   $('startBtn'),
  wakeHint:   $('wakeHint'),
  menuBtn:    $('menuBtn'),
  doneBtn:    $('doneBtn'),
  sheet:      $('sheet'),
  backdrop:   $('backdrop'),
  unitSeg:    $('unitSeg'),
  tauSlider:  $('tauSlider'),
  tauValue:   $('tauValue'),
  wakeToggle: $('wakeToggle'),
  wakeNote:   $('wakeNote'),
  simToggle:  $('simToggle'),
  simOptions: $('simOptions'),
  scenarioSeg: $('scenarioSeg'),
  scenarioNote: $('scenarioNote'),
  simSpeedGroup: $('simSpeedGroup'),
  simSpeedGroupLabel: $('simSpeedGroupLabel'),
  simSpeedSlider: $('simSpeedSlider'),
  simSpeedValue: $('simSpeedValue'),
  simSpeedMax: $('simSpeedMax'),
};

/* --- persisted settings -------------------------------------------------- */

const settings = loadSettings();

function loadSettings() {
  try {
    const raw = localStorage.getItem('speedo.settings');
    return raw ? Object.assign({}, DEFAULTS, JSON.parse(raw)) : Object.assign({}, DEFAULTS);
  } catch (_) {
    return Object.assign({}, DEFAULTS);
  }
}

function saveSettings() {
  try { localStorage.setItem('speedo.settings', JSON.stringify(settings)); } catch (_) {}
}

/* --- filter state -------------------------------------------------------- */

const state = {
  samples: [],        // { t, v (m/s), acc (m) }
  ema: null,          // smoothed speed, m/s
  emaAt: 0,           // timestamp of last EMA advance
  lastFixAt: 0,       // last *usable speed* sample
  lastContactAt: 0,   // last time the receiver called us at all (see noteContact)
  lastRaw: null,      // most recent unfiltered speed, m/s
  lastAcc: null,
  error: null,        // human-readable fatal error, or null
  started: false,
};

/**
 * Fold one fix into the filter.
 *
 * Two stages: a median over the last few samples kills isolated GPS spikes,
 * then a time-aware exponential moving average smooths what's left. The EMA is
 * time-aware (alpha derived from the actual gap between fixes) rather than a
 * fixed N-sample average because iOS delivers fixes at irregular intervals —
 * a plain rolling average silently changes its own time constant whenever the
 * fix rate drops.
 */
function pushSample(speedMs, accuracy, when) {
  const t = when || Date.now();

  state.samples.push({ t, v: speedMs, acc: accuracy });
  while (state.samples.length && t - state.samples[0].t > SAMPLE_KEEP_MS) state.samples.shift();

  state.lastRaw = speedMs;
  state.lastAcc = accuracy;
  state.lastFixAt = t;
  state.lastContactAt = t;
  state.error = null;

  const recent = state.samples.slice(-MEDIAN_WINDOW).map((s) => s.v);
  const med = median(recent);

  if (state.ema === null) {
    state.ema = med;
  } else {
    const dt = Math.max(0, (t - state.emaAt) / 1000);
    const alpha = 1 - Math.exp(-dt / Math.max(0.25, settings.tau));
    state.ema += alpha * (med - state.ema);
  }
  state.emaAt = t;
}

/**
 * A position callback arrived but carried no usable speed.
 *
 * This matters more than it sounds. A boat sitting still produces fixes whose
 * speed iOS reports as null, and whose position hasn't moved enough to derive
 * one from — and Core Location throttles updates hard when nothing is moving.
 * Treating that silence as "signal lost" makes the display flap between a
 * number and an error every few seconds while you're tied up. Contact is
 * therefore tracked separately from usable speed.
 */
function noteContact(accuracy, when) {
  state.lastContactAt = when || Date.now();
  if (accuracy != null) state.lastAcc = accuracy;
  state.error = null;
}

function resetFilter() {
  state.samples.length = 0;
  state.ema = null;
  state.emaAt = 0;
  state.lastFixAt = 0;
  state.lastContactAt = 0;
  state.lastRaw = null;
  state.lastAcc = null;
  state.error = null;
}

function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Spread of the recent raw readings — this is what feeds the "± x.x" figure.
 *
 * Worth being clear about: the Geolocation API does not expose a speed accuracy
 * value (it gives positional accuracy only), so this is not the receiver's own
 * error estimate. It is the observed standard deviation of the raw speed
 * samples over the last few seconds — i.e. how much the reading is actually
 * bouncing around right now, which is the number you want when deciding whether
 * to trust the big digits.
 */
function speedSpread(now) {
  const win = state.samples.filter((s) => now - s.t <= SPREAD_WINDOW_MS);
  if (win.length < 3) return null;
  const mean = win.reduce((a, s) => a + s.v, 0) / win.length;
  const varc = win.reduce((a, s) => a + (s.v - mean) * (s.v - mean), 0) / (win.length - 1);
  return Math.sqrt(Math.max(0, varc));
}

/* --- speed sources ------------------------------------------------------- */

let watchId = null;

function startGps() {
  if (!('geolocation' in navigator)) {
    state.error = 'GPS NOT SUPPORTED';
    return;
  }
  stopGps();
  watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 20000,
  });
}

function stopGps() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  lastPos = null;
}

let lastPos = null;   // for the position-differencing fallback

function onPosition(pos) {
  const c = pos.coords;
  const t = pos.timestamp || Date.now();
  let v = c.speed;

  // Core Location signals "no valid speed" as null through the web API, but a
  // negative value has been seen in the wild too. Treat anything non-finite or
  // negative as missing.
  if (typeof v !== 'number' || !isFinite(v) || v < 0) v = null;

  if (v === null) {
    // Fallback: differentiate position. Poor at trolling speed, but better than
    // showing nothing if the receiver withholds Doppler velocity.
    if (lastPos) {
      const dt = (t - lastPos.t) / 1000;
      if (dt > 0.2) v = haversine(lastPos.lat, lastPos.lon, c.latitude, c.longitude) / dt;
    }
  }
  lastPos = { t, lat: c.latitude, lon: c.longitude };

  if (v === null) { noteContact(c.accuracy, Date.now()); return; }
  pushSample(v, c.accuracy, t);

  // Deliberately arrival time, not pos.timestamp. iOS can hand back a position
  // carrying an older timestamp, and keying staleness off that makes a fix look
  // expired the instant it arrives.
  state.lastContactAt = Date.now();
}

function onGpsError(err) {
  if (err.code === 1) state.error = 'LOCATION ACCESS DENIED';
  else if (err.code === 2) state.error = 'GPS UNAVAILABLE';
  // code 3 (timeout) is transient — let the staleness logic handle it.
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLon = (lon2 - lon1) * p;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* --- simulator ----------------------------------------------------------- */

let simTimer = null;
let simTick = 0;

function startSim() {
  stopGps();
  stopSim();
  simTick = 0;
  simTimer = setInterval(simStep, 1000);
  simStep();
}

function stopSim() {
  if (simTimer) { clearInterval(simTimer); simTimer = null; }
}

/**
 * Emits invented fixes through pushSample(), the same entry point real GPS
 * uses — so what you see on the dock is genuinely what the filter will do on
 * the water, not a separate display path that happens to look similar.
 */
function simStep() {
  simTick++;
  const u = UNITS[settings.unit];
  const s = settings.scenario;

  let targetMs, noise, acc;

  if (s === 'manual') {
    targetMs = settings.simSpeed / u.perMs;
    noise = 0.06;
    acc = 4 + Math.random() * 3;
  } else if (s === 'troll') {
    const mph = 1.75 + 1.45 * Math.sin((simTick / 90) * 2 * Math.PI);
    targetMs = mph / UNITS.mph.perMs;
    noise = 0.08;
    acc = 4 + Math.random() * 4;
  } else if (s === 'chop') {
    targetMs = 1.3 / UNITS.mph.perMs;
    noise = 0.25;
    acc = 6 + Math.random() * 6;
  } else { // dropout — cycles good / degraded / no fix at all
    targetMs = 1.3 / UNITS.mph.perMs;
    const phase = simTick % 26;
    if (phase < 14)      { noise = 0.08; acc = 5 + Math.random() * 3; }
    else if (phase < 21) { noise = 0.45; acc = 40 + Math.random() * 50; }
    else                 { return; }   // fix lost entirely
  }

  // Occasional single-fix spike, so the median stage has something to earn its keep.
  let v = targetMs + gaussian() * noise;
  if (Math.random() < 0.02) v += 1.5 + Math.random() * 2;

  pushSample(Math.max(0, v), acc, Date.now());
}

function gaussian() {
  let a = 0, b = 0;
  while (a === 0) a = Math.random();
  while (b === 0) b = Math.random();
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
}

/* --- rendering ----------------------------------------------------------- */

const shown = {};   // cache so we only touch the DOM when text actually changes

function setText(node, key, text) {
  if (shown[key] === text) return;
  shown[key] = text;
  node.textContent = text;
}

// Step the type size down for four-character readings so a fast run, or km/h,
// can never push the number off the edge of the screen.
function setSpeed(text) {
  setText(el.speedValue, 'speed', text);
  const wide = text.length > 3;
  if (shown.wide !== wide) {
    shown.wide = wide;
    el.speedValue.classList.toggle('wide', wide);
  }
}

function render() {
  const now = Date.now();
  const u = UNITS[settings.unit];
  const age = state.lastContactAt ? now - state.lastContactAt : Infinity;
  const quiet = age > STALE_MS;

  // A GPS that goes quiet while you were essentially stopped means "nothing is
  // moving", not "signal lost" — so hold at 0.0 rather than throwing up an
  // error. Going quiet while you were under way is the case worth shouting
  // about, because that number would otherwise be misleading.
  const wasMoving = state.ema !== null && state.ema >= STOPPED_MS;
  const lost = quiet && wasMoving;
  const stale = quiet && !wasMoving;

  setText(el.unitLabel, 'unit', u.label);
  setText(el.varLabel, 'varLabel', '± ' + u.label);

  document.body.classList.toggle('state-error', !!state.error);
  document.body.classList.toggle('state-stale', !state.error && (lost || state.ema === null));

  // --- the big number ---
  if (state.error) {
    setSpeed('--');
    setText(el.statusLine, 'status', state.error);
  } else if (state.ema === null) {
    setSpeed('--');
    setText(el.statusLine, 'status', 'WAITING FOR FIX');
  } else if (lost) {
    // Never keep displaying an old speed as if it were live — that is the one
    // failure mode that could actually mislead you on the water.
    setSpeed('--');
    setText(el.statusLine, 'status', 'GPS SIGNAL LOST');
  } else {
    const ms = (stale || state.ema < DEADBAND_MS) ? 0 : state.ema;
    setSpeed((ms * u.perMs).toFixed(1));
    setText(el.statusLine, 'status', stale ? 'STOPPED' : '');
  }

  // --- GPS accuracy + quality dot ---
  let cls = '';
  if (!state.error && state.lastAcc != null && !quiet) {
    const aging = age > AGING_MS;
    if (state.lastAcc <= ACC_GOOD) cls = aging ? 'fair' : 'good';
    else if (state.lastAcc <= ACC_FAIR) cls = aging ? 'poor' : 'fair';
    else cls = 'poor';
    setText(el.gpsAcc, 'acc', '±' + Math.round(state.lastAcc) + ' m');
  } else if (!state.error && state.lastAcc != null && stale) {
    // Moored: the fix is old but still the truth, so keep showing it, amber.
    cls = 'fair';
    setText(el.gpsAcc, 'acc', '±' + Math.round(state.lastAcc) + ' m');
  } else {
    cls = state.error || lost ? 'poor' : '';
    setText(el.gpsAcc, 'acc', '--');
  }
  if (shown.dot !== cls) {
    shown.dot = cls;
    el.gpsDot.className = 'dot' + (cls ? ' ' + cls : '');
  }

  // --- ± speed spread ---
  const sd = quiet || state.error ? null : speedSpread(now);
  setText(el.speedVar, 'var', sd === null ? '--' : '±' + (sd * u.perMs).toFixed(1));

  // --- live (unsmoothed) speed ---
  if (state.lastRaw === null || quiet || state.error) {
    setText(el.liveSpeed, 'live', stale ? '0.0' : '--');
  } else {
    setText(el.liveSpeed, 'live', (state.lastRaw * u.perMs).toFixed(1));
  }
}

/* --- wake lock ----------------------------------------------------------- */

let wakeLock = null;

async function acquireWakeLock() {
  if (!settings.wake || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return false;
  if (wakeLock) return true;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    el.wakeHint.hidden = true;
    return true;
  } catch (_) {
    return false;   // usually "needs a user gesture" — handled by the hint
  }
}

async function releaseWakeLock() {
  try { if (wakeLock) await wakeLock.release(); } catch (_) {}
  wakeLock = null;
}

// iOS drops the wake lock whenever the page is backgrounded, so re-take it
// every time we come back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquireWakeLock();
});

/* --- settings sheet ------------------------------------------------------ */

function openSheet() {
  syncSheet();
  el.sheet.classList.add('open');
  el.backdrop.classList.add('open');
}

function closeSheet() {
  el.sheet.classList.remove('open');
  el.backdrop.classList.remove('open');
}

function setSegmented(container, attr, value) {
  container.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset[attr] === value));
  });
}

function syncSheet() {
  const u = UNITS[settings.unit];

  setSegmented(el.unitSeg, 'unit', settings.unit);
  setSegmented(el.scenarioSeg, 'scenario', settings.scenario);

  el.tauSlider.value = settings.tau;
  el.tauValue.textContent = '~' + Math.round(settings.tau * SETTLE_FACTOR) + ' s';

  el.wakeToggle.checked = settings.wake;
  el.simToggle.checked = settings.sim;
  el.simOptions.classList.toggle('hidden-block', !settings.sim);

  el.simSpeedSlider.max = u.sliderMax;
  el.simSpeedSlider.step = u.step;
  el.simSpeedSlider.value = Math.min(settings.simSpeed, u.sliderMax);
  el.simSpeedMax.textContent = String(u.sliderMax);
  el.simSpeedValue.textContent = settings.simSpeed.toFixed(1) + ' ' + u.label;

  const manual = settings.scenario === 'manual';
  el.simSpeedGroup.classList.toggle('hidden-block', !manual);
  el.simSpeedGroupLabel.classList.toggle('hidden-block', !manual);
  el.scenarioNote.textContent = SCENARIO_NOTES[settings.scenario] || '';

  el.wakeNote.textContent = 'wakeLock' in navigator
    ? 'Holds the screen on while the app is in front.'
    : 'This browser has no wake lock. Set Settings › Display & Brightness › Auto-Lock to Never instead.';
}

function applySource() {
  document.body.classList.toggle('sim-on', settings.sim);
  resetFilter();
  if (!state.started) return;
  if (settings.sim) startSim();
  else { stopSim(); startGps(); }
}

/* --- event wiring -------------------------------------------------------- */

el.menuBtn.addEventListener('click', openSheet);
el.doneBtn.addEventListener('click', closeSheet);
el.backdrop.addEventListener('click', closeSheet);

// Tapping the unit under the number cycles it — no need to open Settings.
function cycleUnit() {
  const keys = Object.keys(UNITS);
  const next = keys[(keys.indexOf(settings.unit) + 1) % keys.length];
  changeUnit(next);
}
el.unitLabel.addEventListener('click', cycleUnit);
el.unitLabel.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleUnit(); }
});

function changeUnit(next) {
  // Keep the simulated speed physically the same across a unit change, so
  // switching MPH -> knots doesn't silently speed up the simulation.
  const ms = settings.simSpeed / UNITS[settings.unit].perMs;
  settings.unit = next;
  settings.simSpeed = Math.min(
    Math.round(ms * UNITS[next].perMs * 10) / 10,
    UNITS[next].sliderMax
  );
  saveSettings();
  syncSheet();
}

el.unitSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-unit]');
  if (b) changeUnit(b.dataset.unit);
});

el.scenarioSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-scenario]');
  if (!b) return;
  settings.scenario = b.dataset.scenario;
  saveSettings();
  syncSheet();
  if (settings.sim) { resetFilter(); simTick = 0; }
});

el.tauSlider.addEventListener('input', () => {
  settings.tau = parseFloat(el.tauSlider.value);
  el.tauValue.textContent = '~' + Math.round(settings.tau * SETTLE_FACTOR) + ' s';
  saveSettings();
});

el.simSpeedSlider.addEventListener('input', () => {
  settings.simSpeed = parseFloat(el.simSpeedSlider.value);
  el.simSpeedValue.textContent = settings.simSpeed.toFixed(1) + ' ' + UNITS[settings.unit].label;
  saveSettings();
});

el.wakeToggle.addEventListener('change', () => {
  settings.wake = el.wakeToggle.checked;
  saveSettings();
  if (settings.wake) acquireWakeLock(); else releaseWakeLock();
});

el.simToggle.addEventListener('change', () => {
  settings.sim = el.simToggle.checked;
  saveSettings();
  syncSheet();
  applySource();
});

/* --- start --------------------------------------------------------------- */

function start() {
  if (state.started) return;
  state.started = true;
  el.startOverlay.classList.add('hidden');

  if (!settings.launched) { settings.launched = true; saveSettings(); }

  // Both of these are requested inside the tap handler on first run: iOS is far
  // more reliable about granting the wake lock and showing the location prompt
  // when they originate from a real user gesture.
  acquireWakeLock();
  if (settings.sim) startSim(); else startGps();
}

el.startBtn.addEventListener('click', start);
el.startOverlay.addEventListener('click', start);

/* Once the app has been through its start screen, skip it on every later
 * launch. Geolocation needs no user gesture, so the fix starts acquiring the
 * moment the app opens instead of waiting on a tap. The wake lock may still
 * want a gesture, so if it is refused we surface a small prompt and retry on
 * the first touch rather than letting the screen quietly go dark. */
async function autoStart() {
  start();
  const held = await acquireWakeLock();
  if (!held && settings.wake && 'wakeLock' in navigator) el.wakeHint.hidden = false;
}

/* Any tap anywhere takes the lock, not just the hint button.
 *
 * The event list matters: Safari does not treat pointerdown as a user
 * activation, so a pointerdown-only listener never satisfies the gesture
 * requirement on iOS and the hint would sit there until pressed exactly.
 * touchend and click are the ones iOS reliably counts. */
const retryWakeLock = () => { acquireWakeLock(); };
for (const ev of ['touchend', 'click', 'pointerup']) {
  document.addEventListener(ev, retryWakeLock, { passive: true });
}

if (settings.launched) autoStart();

document.body.classList.toggle('sim-on', settings.sim);
syncSheet();
render();
setInterval(render, RENDER_MS);

/* --- service worker ------------------------------------------------------ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

/* Exposed for the automated checks in tools/verify.mjs — harmless at runtime. */
if (typeof window !== 'undefined') {
  window.__speedo = {
    state, settings, UNITS, SETTLE_FACTOR,
    pushSample, resetFilter, speedSpread, median, render, syncSheet, applySource,
    start, saveSettings,
  };
}
