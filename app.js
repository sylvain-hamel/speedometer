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
const MIN_SEED_SAMPLES = 3;     // fixes required before the filter starts
const SPREAD_WINDOW_MS = 10000; // window used for the ± figure
const SAMPLE_KEEP_MS  = 20000;  // ring buffer retention
const DEADBAND_MS     = 0.089;  // ~0.2 MPH. Below this, show a hard 0.0
const STALE_MS        = 12000;  // no contact from the receiver at all for this long
const AGING_MS        = 4000;   // fix older than this -> downgrade fix quality
const STOPPED_MS      = 0.223;  // ~0.5 MPH. Below this we were moored, not moving
const RENDER_MS       = 200;

/* Fix-quality bands, in metres of reported position accuracy.
 *
 * Each boundary has a separate enter and exit threshold. Without that gap a
 * reading sitting on a boundary flips the dot at the fix rate — accuracy
 * wobbling either side of 10 m is routine in chop, and the dot would blink
 * green/amber roughly once a second with nothing actually changing. A light
 * that flickers for no reason is one you learn to ignore, which costs you the
 * red state too, and red is the one that matters. */
const ACC_GOOD_ENTER = 8;       // metres; become green at or below this
const ACC_GOOD_EXIT  = 12;      // ...and stay green until above this
const ACC_POOR_ENTER = 35;      // become red above this
const ACC_POOR_EXIT  = 25;      // ...and stay red until at or below this

/* Smoothing is stored as the EMA time constant, but shown to the user as a
 * settle time, because "6 seconds" on a slider naturally reads as "takes six
 * seconds to catch up" and a time constant does not mean that — an EMA reaches
 * only 63% of a step in one tau, and ~95% in three. SETTLE_FACTOR is that 3x. */
const SETTLE_FACTOR = 3;

/* --- trolling target ------------------------------------------------------
 *
 * Species ranges are stored in m/s, not MPH. Everything else in the filter is
 * already m/s, and — more to the point — a unit-agnostic store is the only way
 * switching MPH -> knots can't quietly rewrite a range you spent a season
 * tuning. (settings.simSpeed does store a display-unit value, and needs the
 * conversion dance in changeUnit() to stay honest; this avoids that entirely.)
 *
 * The defaults below are written in MPH purely because that's the unit anyone
 * would quote them in. They are a starting guess, not doctrine — every one is
 * editable, and the list is add/remove as well.
 */
const DEFAULT_SPECIES = [
  ['Brook trout / omble',         0.5, 1.3],
  ['Rainbow trout / arc-en-ciel', 0.8, 1.8],
  ['Largemouth bass / achigan',   1.0, 2.0],
  ['Musky, small / maskinongé',   2.0, 3.5],
];

const fromMph = (mph) => mph / UNITS.mph.perMs;

function defaultSpecies() {
  return DEFAULT_SPECIES.map(([name, min, max], i) => ({
    id: 'd' + i, name, min: fromMph(min), max: fromMph(max),
  }));
}

/* Water temperature is the real physical lever — cold water slows fish
 * metabolism, so you troll slower for the same fish. Season is deliberately a
 * gentle trim rather than a second strong multiplier: the two are correlated
 * (cold water largely *is* spring and late fall), and stacking two big factors
 * would produce nonsense like -40% for a cold spring. As tuned, the extremes
 * are -29% and +21%, which are defensible. */
const WATER_FACTORS  = { cold: 0.75, normal: 1, warm: 1.15 };
const SEASON_FACTORS = { spring: 0.95, summer: 1, fall: 1.05 };

const WATER_WORDS = { cold: 'Cold', normal: 'Normal', warm: 'Warm' };

const AMBER_FRACTION = 0.25;    // amber band, as a fraction of the range width
const AMBER_FLOOR = fromMph(0.1);  // ...but never so tight it's unusable
const ZONE_HYST = 0.02;         // m/s (~0.04 MPH) of stickiness on a colour change

const DEFAULTS = {
  unit: 'mph',
  tau: 1,                       // smoothing time constant, seconds (~3 s to settle)
  wake: true,
  sim: false,
  scenario: 'manual',
  simSpeed: 1.3,                // in whatever unit was active when set
  launched: false,              // has the start screen been through once?
  targetOn: false,              // trolling target is opt-in
  species: null,                // seeded from defaultSpecies() on first load
  speciesId: 'd0',
  speciesSeq: 0,                // counter behind generated ids
  water: 'normal',
  season: 'summer',
};

const SCENARIO_NOTES = {
  manual:  'Holds whatever speed you set on the slider, with a little GPS noise on top.',
  troll:   'Sweeps slowly between a crawl and about 3 MPH, the way a troll pass tends to go.',
  chop:    'Steady 1.3 MPH with wave action fighting you — the noisiest realistic case.',
  dropout: 'Good fix, then degraded accuracy, then a total loss of fix. Shows every failure state.',
};

/* --- element handles ----------------------------------------------------- */

const $ = (id) => document.getElementById(id);

const el = {
  speedValue: $('speedValue'),
  unitLabel:  $('unitLabel'),
  statusLine: $('statusLine'),
  gpsDot:     $('gpsDot'),
  gpsAcc:     $('gpsAcc'),
  gpsMetric:  $('gpsMetric'),
  speedVar:   $('speedVar'),
  varLabel:   $('varLabel'),
  liveSpeed:  $('liveSpeed'),
  startOverlay: $('startOverlay'),
  startBtn:   $('startBtn'),
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
  debugSheet: $('debugSheet'),
  debugDoneBtn: $('debugDoneBtn'),
  dbgDot:     $('dbgDot'),
  dbgQuality: $('dbgQuality'),
  dbgWhy:     $('dbgWhy'),
  dbgAcc:     $('dbgAcc'),
  dbgContact: $('dbgContact'),
  dbgFix:     $('dbgFix'),
  dbgRate:    $('dbgRate'),
  dbgSamples: $('dbgSamples'),
  dbgSmoothed: $('dbgSmoothed'),
  dbgRaw:     $('dbgRaw'),
  dbgSpread:  $('dbgSpread'),
  dbgSource:  $('dbgSource'),
  dbgStatus:  $('dbgStatus'),
  dbgPermission: $('dbgPermission'),
  targetLine:   $('targetLine'),
  targetToggle: $('targetToggle'),
  targetOptions: $('targetOptions'),
  speciesList:  $('speciesList'),
  addSpeciesBtn: $('addSpeciesBtn'),
  speciesEditor: $('speciesEditor'),
  editorTitle:  $('editorTitle'),
  speciesName:  $('speciesName'),
  minSlider:    $('minSlider'),
  maxSlider:    $('maxSlider'),
  minValue:     $('minValue'),
  maxValue:     $('maxValue'),
  editorCancel: $('editorCancel'),
  editorSave:   $('editorSave'),
  editorDelete: $('editorDelete'),
  deleteGroup:  $('deleteGroup'),
  waterSeg:     $('waterSeg'),
  seasonSeg:    $('seasonSeg'),
  waterNote:    $('waterNote'),
  targetNote:   $('targetNote'),
  resetSpecies: $('resetSpecies'),
};

/* --- persisted settings -------------------------------------------------- */

const settings = loadSettings();

function loadSettings() {
  let s;
  try {
    const raw = localStorage.getItem('speedo.settings');
    s = raw ? Object.assign({}, DEFAULTS, JSON.parse(raw)) : Object.assign({}, DEFAULTS);
  } catch (_) {
    s = Object.assign({}, DEFAULTS);
  }

  // An empty *array* is a list the user deliberately emptied and must survive a
  // relaunch; only a missing one gets seeded. Re-seeding [] would make deleting
  // the last species impossible.
  const cleaned = normalizeSpecies(s.species);
  s.species = cleaned || defaultSpecies();

  if (!s.species.some((x) => x.id === s.speciesId)) {
    s.speciesId = s.species.length ? s.species[0].id : null;
  }
  return s;
}

/* localStorage is user-writable and survives across versions, so nothing coming
 * out of it is trusted: a corrupt entry should cost you that one species, not
 * wedge the whole app on a NaN range. Returns null only for a missing list. */
function normalizeSpecies(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const min = Number(s.min);
    const max = Number(s.max);
    if (!isFinite(min) || !isFinite(max) || min < 0 || max < 0) continue;
    const name = typeof s.name === 'string' && s.name.trim()
      ? s.name.trim().slice(0, 32) : 'Unnamed';
    out.push({
      id: typeof s.id === 'string' && s.id ? s.id : 'u' + (out.length + 1),
      name,
      min: Math.min(min, max),
      max: Math.max(min, max),
    });
  }
  return out;
}

function currentSpecies() {
  return settings.species.find((s) => s.id === settings.speciesId) || null;
}

/**
 * The recommended range right now, in m/s, with the amber margin — or null if
 * the feature is off or there's no species to aim at.
 */
function targetRange() {
  if (!settings.targetOn) return null;
  const sp = currentSpecies();
  if (!sp) return null;

  const f = (WATER_FACTORS[settings.water] || 1) * (SEASON_FACTORS[settings.season] || 1);
  const min = sp.min * f;
  const max = sp.max * f;
  return {
    min,
    max,
    // A margin proportional to the range keeps a wide species forgiving and a
    // narrow one tight. The floor only bites on a range under ~0.4 MPH wide,
    // where a proportional margin would leave almost no amber at all.
    margin: Math.max((max - min) * AMBER_FRACTION, AMBER_FLOOR),
    species: sp,
  };
}

/**
 * Which colour the number should be: 'in' | 'near' | 'out', or '' for no verdict.
 *
 * `prev` is the zone currently displayed, and it matters — without hysteresis a
 * speed sitting exactly on a boundary flickers between two colours several
 * times a second, which is far more distracting than being slightly wrong.
 */
function zoneOf(ms, range, prev) {
  if (!range) return '';

  // Below the deadband the display already reads a hard 0.0. You're tied up or
  // drifting, not trolling badly, so there is no verdict to give — a standstill
  // glowing red would just be nagging.
  if (ms < DEADBAND_MS) return '';

  // Leaving a zone takes a slightly bigger move than entering it.
  const gi = prev === 'in'   ? ZONE_HYST : 0;
  const gn = prev === 'near' ? ZONE_HYST : 0;

  if (ms >= range.min - gi && ms <= range.max + gi) return 'in';
  if (ms >= range.min - range.margin - gn && ms <= range.max + range.margin + gn) return 'near';
  return 'out';
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
  accBand: null,      // last accuracy band shown, so the thresholds can be sticky
  error: null,        // human-readable fatal error, or null
  started: false,
  zone: '',           // displayed target zone: 'in' | 'near' | 'out' | ''
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
    // Don't seed the filter from a single fix. The first reading after a cold
    // start is frequently garbage, and seeding from it drags the display off
    // for several seconds before the average can pull it back. Waiting for
    // enough samples to make the median meaningful costs a second or two of
    // "WAITING FOR FIX" and removes the whole failure mode.
    if (state.samples.length < MIN_SEED_SAMPLES) return;
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
 * Treating that silence as a lost fix makes the display flap between a number
 * and an error every few seconds while you're tied up. Contact is therefore
 * tracked separately from usable speed.
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
  state.accBand = null;
  state.error = null;
}

/**
 * Which fix-quality band an accuracy reading falls in, given the band currently
 * on screen.
 *
 * Improving needs the tighter ENTER threshold, degrading the looser EXIT one,
 * so a reading hovering on a boundary holds whatever it is already showing. On
 * the first fix after a reset there is no previous band and the ENTER
 * thresholds decide.
 *
 * Worth being clear about what this measures: it is the receiver's *position*
 * error estimate, not reception quality and not speed accuracy. The Geolocation
 * API exposes no satellite count, no signal strength and no speed accuracy, so
 * this figure plus the age of the fix is genuinely all the app has to go on.
 */
function accuracyBand(acc, prev) {
  const goodMax = prev === 'good' ? ACC_GOOD_EXIT : ACC_GOOD_ENTER;
  const fairMax = prev === 'poor' ? ACC_POOR_EXIT : ACC_POOR_ENTER;
  if (acc <= goodMax) return 'good';
  if (acc <= fairMax) return 'fair';
  return 'poor';
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
  const range = targetRange();
  let zone = '';

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
    setText(el.statusLine, 'status', 'GPS FIX LOST');
  } else {
    const ms = (stale || state.ema < DEADBAND_MS) ? 0 : state.ema;
    setSpeed((ms * u.perMs).toFixed(1));
    setText(el.statusLine, 'status', stale ? 'STOPPED' : '');
    // Judged on the value actually displayed, not on state.ema, so the colour
    // can never disagree with the digits underneath it. Nothing to say while
    // stopped.
    if (!stale) zone = zoneOf(ms, range, state.zone);
  }

  // --- target range + verdict colour ---
  state.zone = zone;
  if (shown.zone !== zone) {
    shown.zone = zone;
    el.speedValue.classList.remove('zone-in', 'zone-near', 'zone-out');
    if (zone) el.speedValue.classList.add('zone-' + zone);
  }

  const targetText = range
    ? 'TARGET ' + (range.min * u.perMs).toFixed(1) + ' – ' + (range.max * u.perMs).toFixed(1)
    : '';
  if (shown.target !== targetText) {
    shown.target = targetText;
    el.targetLine.textContent = targetText;
    el.targetLine.hidden = !targetText;
  }

  // --- GPS accuracy + fix-quality dot ---
  //
  // Two separate things feed this: how precisely the receiver reports knowing
  // your position, and how long ago it last said anything. Neither is reception
  // quality — GPS is receive-only, so there is no link to be up or down, and
  // sitting still doesn't change what the phone can hear.
  let cls = '';
  let why = '';
  if (!state.error && state.lastAcc != null && !quiet) {
    const band = accuracyBand(state.lastAcc, state.accBand);
    state.accBand = band;

    // An aging fix is downgraded a step on top of whatever the accuracy says:
    // a precise reading several seconds old still describes where you were.
    const aging = age > AGING_MS;
    cls = !aging ? band : band === 'good' ? 'fair' : 'poor';
    why = aging
      ? 'Position accuracy is ' + band + ', but the fix is more than '
        + Math.round(AGING_MS / 1000) + ' s old — downgraded a step.'
      : 'Position accuracy is ' + band + ', and the fix is current.';
    setText(el.gpsAcc, 'acc', '±' + Math.round(state.lastAcc) + ' m');
  } else if (!state.error && state.lastAcc != null && stale) {
    // Moored: the fix is old but still the truth, so keep showing it, amber.
    state.accBand = null;
    cls = 'fair';
    why = 'Holding the last fix. You are stopped, so the receiver went quiet — '
        + 'normal, and not a reception problem.';
    setText(el.gpsAcc, 'acc', '±' + Math.round(state.lastAcc) + ' m');
  } else {
    state.accBand = null;
    cls = state.error || lost ? 'poor' : '';
    why = state.error ? 'No fix — ' + state.error.toLowerCase() + '.'
      : lost ? 'Nothing from the receiver for over ' + Math.round(STALE_MS / 1000)
        + ' s while under way.'
      : 'Waiting for a first fix.';
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

  renderDebug(now, u, { cls, why, sd, lost, stale });
}

/* --- GPS status panel ---------------------------------------------------- */

/**
 * Tapping the GPS reading opens this. The strip at the bottom has room for one
 * number per metric; this is where the rest of it goes — in particular *when*
 * the last fix actually landed, which is the thing the dot compresses into a
 * colour and which explains most surprising readings.
 */
let debugOpen = false;

const BAND_WORDS = { good: 'Good', fair: 'Fair', poor: 'Poor', '': 'None' };

/** "3.4 seconds ago" — deliberately not a clock time; the age is the useful part. */
function agoText(ts, now) {
  if (!ts) return 'never';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return s.toFixed(1) + ' seconds ago';
  const m = Math.floor(s / 60);
  return m + ' min ' + Math.round(s - m * 60) + ' s ago';
}

/** Mean gap between the fixes still in the buffer, in seconds. */
function fixInterval() {
  const s = state.samples;
  if (s.length < 2) return null;
  return (s[s.length - 1].t - s[0].t) / (s.length - 1) / 1000;
}

function renderDebug(now, u, r) {
  if (!debugOpen) return;

  const statusWord = state.error ? state.error
    : state.ema === null ? 'Waiting for a first fix'
    : r.lost ? 'Fix lost'
    : r.stale ? 'Stopped — receiver quiet'
    : 'Live';

  setText(el.dbgSource, 'dbgSource',
    settings.sim ? 'Simulator — ' + settings.scenario : 'Device GPS');
  setText(el.dbgStatus, 'dbgStatus', statusWord);

  setText(el.dbgQuality, 'dbgQuality', BAND_WORDS[r.cls] || 'None');
  if (shown.dbgDot !== r.cls) {
    shown.dbgDot = r.cls;
    el.dbgDot.className = 'dot' + (r.cls ? ' ' + r.cls : '');
  }
  setText(el.dbgWhy, 'dbgWhy', r.why);

  setText(el.dbgAcc, 'dbgAcc',
    state.lastAcc == null ? '--' : '±' + state.lastAcc.toFixed(1) + ' m');
  setText(el.dbgContact, 'dbgContact', agoText(state.lastContactAt, now));
  setText(el.dbgFix, 'dbgFix', agoText(state.lastFixAt, now));

  const iv = fixInterval();
  setText(el.dbgRate, 'dbgRate', iv === null ? '--' : 'every ' + iv.toFixed(1) + ' s');
  setText(el.dbgSamples, 'dbgSamples', String(state.samples.length));

  setText(el.dbgSmoothed, 'dbgSmoothed',
    state.ema === null ? '--' : (state.ema * u.perMs).toFixed(2) + ' ' + u.label);
  setText(el.dbgRaw, 'dbgRaw',
    state.lastRaw === null ? '--' : (state.lastRaw * u.perMs).toFixed(2) + ' ' + u.label);
  setText(el.dbgSpread, 'dbgSpread',
    r.sd === null ? '--' : '±' + (r.sd * u.perMs).toFixed(2) + ' ' + u.label);
}

/* Safari has historically not answered permissions.query for geolocation, so
 * this is best-effort and reads "unavailable" rather than failing the panel. */
async function refreshPermission() {
  let text = 'unavailable';
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const st = await navigator.permissions.query({ name: 'geolocation' });
      text = st.state;
    }
  } catch (_) {}
  setText(el.dbgPermission, 'dbgPerm', text);
}

/* --- wake lock ----------------------------------------------------------- */

let wakeLock = null;

async function acquireWakeLock() {
  if (!settings.wake || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return false;
  if (wakeLock) return true;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
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

  el.targetToggle.checked = settings.targetOn;
  el.targetOptions.classList.toggle('hidden-block', !settings.targetOn);
  setSegmented(el.waterSeg, 'water', settings.water);
  setSegmented(el.seasonSeg, 'season', settings.season);
  el.waterNote.textContent =
    'Cold is roughly below 10 °C / 50 °F, warm above 20 °C / 68 °F. Cold water slows a ' +
    'fish down, and the speed it will chase drops with it — this is the bigger of the ' +
    'two adjustments. Season is only a nudge on top.';
  renderSpeciesList();
  syncTargetNote();

  el.wakeNote.textContent = 'wakeLock' in navigator
    ? 'Holds the screen on while the app is in front.'
    : 'This browser has no wake lock. Set Settings › Display & Brightness › Auto-Lock to Never instead.';
}

/* --- species list -------------------------------------------------------- */

/* Constant markup only. Every user-supplied string on these rows goes in via
 * textContent — a species called "<img onerror=...>" has to stay a daft name
 * rather than becoming script. */
const TICK_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M2.5 8.4 6 12l7.5-8"></path></svg>';

const PENCIL_SVG =
  '<svg viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12.2 2.3a1.6 1.6 0 0 1 2.3 2.3L5.9 13.2l-3.1.8.8-3.1z"></path></svg>';

function renderSpeciesList() {
  const u = UNITS[settings.unit];
  el.speciesList.textContent = '';

  if (!settings.species.length) {
    const empty = document.createElement('div');
    empty.className = 'species-empty';
    empty.textContent = 'No species — add one below.';
    el.speciesList.appendChild(empty);
    return;
  }

  for (const sp of settings.species) {
    const row = document.createElement('div');
    row.className = 'row species-row';
    row.dataset.id = sp.id;
    row.setAttribute('role', 'button');

    const tick = document.createElement('div');
    tick.className = 'species-tick';
    tick.dataset.on = String(sp.id === settings.speciesId);
    tick.innerHTML = TICK_SVG;

    const name = document.createElement('div');
    name.className = 'species-name';
    name.textContent = sp.name;

    const rng = document.createElement('div');
    rng.className = 'species-range';
    rng.textContent = (sp.min * u.perMs).toFixed(1) + ' – ' +
                      (sp.max * u.perMs).toFixed(1) + ' ' + u.label;

    const text = document.createElement('div');
    text.className = 'species-text';
    text.append(name, rng);

    const edit = document.createElement('button');
    edit.className = 'species-edit';
    edit.dataset.edit = sp.id;
    edit.setAttribute('aria-label', 'Edit ' + sp.name);
    edit.innerHTML = PENCIL_SVG;

    row.append(tick, text, edit);
    el.speciesList.appendChild(row);
  }
}

function syncTargetNote() {
  const u = UNITS[settings.unit];
  const sp = currentSpecies();

  if (!sp) {
    el.targetNote.textContent = settings.species.length
      ? 'Pick a species above to set a target.'
      : 'No species left, so there is nothing to target. Add one, or reset to the defaults below.';
    return;
  }

  const f = (WATER_FACTORS[settings.water] || 1) * (SEASON_FACTORS[settings.season] || 1);
  const lo = (sp.min * f * u.perMs).toFixed(1);
  const hi = (sp.max * f * u.perMs).toFixed(1);
  const pct = Math.round((f - 1) * 100);
  const head = 'Targeting ' + sp.name + ' at ' + lo + '–' + hi + ' ' + u.label + '. ';

  el.targetNote.textContent = pct === 0
    ? head + 'Normal water in summer, so the base range is used as it stands.'
    : head + WATER_WORDS[settings.water] + ' water in ' + settings.season +
      ' shifts the base range by ' + (pct > 0 ? '+' : '') + pct + '%.';
}

/* --- species editor ------------------------------------------------------ */

let editingId = null;         // null while adding a new one

function openEditor(id) {
  const u = UNITS[settings.unit];
  const sp = id ? settings.species.find((s) => s.id === id) : null;
  editingId = sp ? sp.id : null;

  el.editorTitle.textContent = sp ? 'Edit species' : 'New species';
  el.speciesName.value = sp ? sp.name : '';

  for (const slider of [el.minSlider, el.maxSlider]) {
    slider.max = u.sliderMax;
    slider.step = u.step;
  }
  const clamp = (ms) => Math.min(ms * u.perMs, u.sliderMax).toFixed(1);
  el.minSlider.value = clamp(sp ? sp.min : fromMph(0.8));
  el.maxSlider.value = clamp(sp ? sp.max : fromMph(1.8));
  document.querySelectorAll('.editor-cap').forEach((c) => {
    c.textContent = String(u.sliderMax);
  });

  el.deleteGroup.classList.toggle('hidden-block', !sp);
  el.speciesEditor.classList.remove('hidden-block');
  resetConfirms();
  syncEditorValues();

  // The editor opens below the fold on a small screen, so bring it into view
  // rather than leaving it looking like nothing happened.
  el.speciesEditor.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closeEditor() {
  editingId = null;
  el.speciesEditor.classList.add('hidden-block');
  resetConfirms();
}

function syncEditorValues() {
  const label = UNITS[settings.unit].label;
  el.minValue.textContent = parseFloat(el.minSlider.value).toFixed(1) + ' ' + label;
  el.maxValue.textContent = parseFloat(el.maxSlider.value).toFixed(1) + ' ' + label;
}

function saveEditor() {
  const u = UNITS[settings.unit];
  const name = el.speciesName.value.trim().slice(0, 32) || 'Unnamed';
  const a = parseFloat(el.minSlider.value) / u.perMs;
  const b = parseFloat(el.maxSlider.value) / u.perMs;
  const min = Math.min(a, b);
  const max = Math.max(a, b);

  if (editingId) {
    const sp = settings.species.find((s) => s.id === editingId);
    if (sp) { sp.name = name; sp.min = min; sp.max = max; }
  } else {
    const id = newSpeciesId();
    settings.species.push({ id, name, min, max });
    settings.speciesId = id;      // one you just added is the one you meant to use
  }

  saveSettings();
  closeEditor();
  renderSpeciesList();
  syncTargetNote();
}

function newSpeciesId() {
  let id;
  do { id = 'u' + (++settings.speciesSeq); }
  while (settings.species.some((s) => s.id === id));
  return id;
}

function deleteEditing() {
  const i = settings.species.findIndex((s) => s.id === editingId);
  if (i > -1) settings.species.splice(i, 1);
  if (!settings.species.some((s) => s.id === settings.speciesId)) {
    settings.speciesId = settings.species.length ? settings.species[0].id : null;
  }
  saveSettings();
  closeEditor();
  renderSpeciesList();
  syncTargetNote();
}

/* Destructive buttons arm on the first tap and fire on the second.
 *
 * A native confirm() blocks the whole page and looks like a browser dialog in
 * what is meant to pass for an app, and losing a species you spent a season
 * tuning to one stray tap is worse than an extra tap. Arming resets whenever
 * anything else happens. */
const CONFIRMS = new Map();

function armConfirm(btn, prompt, action) {
  if (CONFIRMS.get(btn)) {
    resetConfirms();
    action();
    return;
  }
  resetConfirms();
  CONFIRMS.set(btn, btn.textContent);
  btn.textContent = prompt;
}

function resetConfirms() {
  for (const [btn, label] of CONFIRMS) btn.textContent = label;
  CONFIRMS.clear();
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
el.backdrop.addEventListener('click', () => { closeSheet(); closeDebug(); });

// Tapping the GPS reading opens the status panel — the dot is one colour
// standing in for several different situations, and this says which one.
function openDebug() {
  debugOpen = true;
  render();               // populate before the sheet slides in, not after
  refreshPermission();
  el.debugSheet.classList.add('open');
  el.backdrop.classList.add('open');
}

function closeDebug() {
  debugOpen = false;
  el.debugSheet.classList.remove('open');
  el.backdrop.classList.remove('open');
}

el.gpsMetric.addEventListener('click', openDebug);
el.gpsMetric.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDebug(); }
});
el.debugDoneBtn.addEventListener('click', closeDebug);

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
  // The editor's sliders are denominated in the old unit and its edits are
  // unsaved, so there is nothing sensible to carry across — drop it rather than
  // silently reinterpreting 1.3 knots as 1.3 MPH.
  closeEditor();
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

/* --- trolling target ----------------------------------------------------- */

el.targetToggle.addEventListener('change', () => {
  settings.targetOn = el.targetToggle.checked;
  saveSettings();
  closeEditor();
  syncSheet();
  render();                     // don't wait up to 200 ms for the colour to appear
});

el.waterSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-water]');
  if (!b) return;
  settings.water = b.dataset.water;
  saveSettings();
  setSegmented(el.waterSeg, 'water', settings.water);
  syncTargetNote();
});

el.seasonSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-season]');
  if (!b) return;
  settings.season = b.dataset.season;
  saveSettings();
  setSegmented(el.seasonSeg, 'season', settings.season);
  syncTargetNote();
});

// Delegated: the rows are rebuilt whenever the list changes.
el.speciesList.addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) { openEditor(edit.dataset.edit); return; }

  const row = e.target.closest('.species-row');
  if (!row) return;
  settings.speciesId = row.dataset.id;
  saveSettings();
  closeEditor();
  renderSpeciesList();
  syncTargetNote();
});

el.addSpeciesBtn.addEventListener('click', () => openEditor(null));

// Min and max share one range and can't cross: shove the other one along rather
// than letting you build a backwards range that silently reads as empty.
el.minSlider.addEventListener('input', () => {
  if (parseFloat(el.minSlider.value) > parseFloat(el.maxSlider.value)) {
    el.maxSlider.value = el.minSlider.value;
  }
  syncEditorValues();
});

el.maxSlider.addEventListener('input', () => {
  if (parseFloat(el.maxSlider.value) < parseFloat(el.minSlider.value)) {
    el.minSlider.value = el.maxSlider.value;
  }
  syncEditorValues();
});

el.editorSave.addEventListener('click', saveEditor);
el.editorCancel.addEventListener('click', closeEditor);

el.editorDelete.addEventListener('click', () => {
  armConfirm(el.editorDelete, 'Tap again to delete', deleteEditing);
});

el.resetSpecies.addEventListener('click', () => {
  armConfirm(el.resetSpecies, 'Tap again to reset — this discards your edits', () => {
    settings.species = defaultSpecies();
    settings.speciesId = settings.species[0].id;
    saveSettings();
    closeEditor();
    renderSpeciesList();
    syncTargetNote();
  });
});

// iOS slides the keyboard over the bottom half of the screen, which is exactly
// where a bottom sheet lives — without this the field you're typing in ends up
// underneath it. The delay lets the keyboard finish animating first.
el.speciesName.addEventListener('focus', () => {
  setTimeout(() => el.speciesName.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
});

el.speciesName.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  el.speciesName.blur();
  saveEditor();
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
 * launch, so the fix starts acquiring the moment the app opens rather than
 * waiting on a tap. Neither the wake lock nor the location prompt is reliably
 * granted without a gesture behind it, so both are re-armed on the first touch
 * (see below) instead of being left refused. */
async function autoStart() {
  start();
  acquireWakeLock();
}

/* Re-arm on the first real tap whatever iOS refused for want of a gesture.
 *
 * The event list matters: Safari does not treat pointerdown as a user
 * activation, so a pointerdown-only listener never satisfies the gesture
 * requirement and nothing here would ever fire on iOS. touchend and click are
 * the ones it reliably counts. */
const retryOnGesture = () => {
  acquireWakeLock();

  // The location prompt wants a gesture too, and iOS withholds it *silently* —
  // no callback, no error, the watch simply never produces a thing. A launch
  // that skips the start screen calls watchPosition with no gesture behind it,
  // so when iOS takes that badly the app sits on WAITING FOR FIX forever with
  // nothing on screen to say why. If the receiver has not said a word by the
  // time a tap arrives, start the watch again from inside the gesture.
  if (state.started && !settings.sim && !state.error && !state.lastContactAt) startGps();
};
for (const ev of ['touchend', 'click', 'pointerup']) {
  document.addEventListener(ev, retryOnGesture, { passive: true });
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
    start, saveSettings, accuracyBand, openDebug, closeDebug, agoText,
    targetRange, zoneOf, currentSpecies, defaultSpecies, normalizeSpecies,
    WATER_FACTORS, SEASON_FACTORS, AMBER_FRACTION,
  };
}
