/* End-to-end checks. Dev-only — the app itself has no build or test dependency.
 *
 *   node tools/verify.mjs [--shots <dir>]
 *
 * Uses the globally-installed Playwright, so there is nothing to npm install.
 * Drives the real page rather than a stubbed copy: the filter assertions call
 * pushSample()/render() on the live app through window.__speedo.
 */

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const shotsFlag = process.argv.indexOf('--shots');
const SHOTS = shotsFlag > -1 ? resolve(process.argv[shotsFlag + 1]) : resolve(root, '.shots');
mkdirSync(SHOTS, { recursive: true });

const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
const { chromium } = require(join(globalRoot, 'playwright'));

/* --- tiny static server (service workers need a real origin, not file://) -- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const served = [];                 // request log, for the update-freshness check

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    served.push(p);
    if (p.endsWith('/')) p += 'index.html';
    const file = resolve(root, '.' + p);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

/* --- result tracking ------------------------------------------------------ */

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const near = (v, target, tol) => Number.isFinite(v) && Math.abs(v - target) <= tol;

const MPH = 2.2369362920544;
const mphToMs = (m) => m / MPH;

/* --- browser -------------------------------------------------------------- */

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});

/* Seed settings before any script runs, so the app boots into a known state.
 * The object is built here in Node and double-encoded, so the injected script
 * is a plain literal with nothing to evaluate (and nothing to get wrong). */
const SEED_BASE = {
  unit: 'mph', tau: 3, wake: false, sim: false,
  scenario: 'manual', simSpeed: 1.3, launched: false,
};
const seed = (over = {}) => {
  const payload = JSON.stringify(Object.assign({}, SEED_BASE, over));
  return `localStorage.setItem('speedo.settings', ${JSON.stringify(payload)});`;
};

async function newPage(over = {}) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
  await ctx.addInitScript(seed(over));
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__speedo);
  return { ctx, page };
}

/* ==========================================================================
   1. Filter behaviour
   ========================================================================== */
{
  const { ctx, page } = await newPage();

  // --- spike rejection ---
  const spike = await page.evaluate((v13) => {
    const S = window.__speedo;
    S.resetFilter();
    S.settings.tau = 3;
    const now = Date.now(), N = 30;
    for (let i = 0; i < N; i++) {
      S.pushSample(i === 20 ? 8 : v13, 5, now - (N - 1 - i) * 1000);
    }
    S.render();
    return document.getElementById('speedValue').textContent;
  }, mphToMs(1.3));
  check('spike rejected: 8 m/s glitch never reaches display',
    near(parseFloat(spike), 1.3, 0.06), `showed ${spike}`);

  // --- cold start: a garbage first fix must not reach the display ---
  const cold = await page.evaluate((v13) => {
    const S = window.__speedo;
    S.resetFilter();
    S.settings.tau = 3;
    const now = Date.now();
    S.pushSample(8, 40, now - 6000);          // nonsense first fix, as GPS does
    S.render();
    const afterFirst = document.getElementById('speedValue').textContent;
    for (let i = 1; i < 7; i++) S.pushSample(v13, 5, now - 6000 + i * 1000);
    S.render();
    return { afterFirst, settled: document.getElementById('speedValue').textContent };
  }, mphToMs(1.3));
  check('cold start: a junk first fix never reaches the display',
    cold.afterFirst === '--' && near(parseFloat(cold.settled), 1.3, 0.15),
    JSON.stringify(cold));

  // --- deadband ---
  const dead = await page.evaluate(() => {
    const S = window.__speedo;
    S.resetFilter();
    const now = Date.now(), N = 20;
    for (let i = 0; i < N; i++) S.pushSample(0.05, 5, now - (N - 1 - i) * 1000);
    S.render();
    return document.getElementById('speedValue').textContent;
  });
  check('deadband: GPS drift while tied up reads 0.0', dead === '0.0', `showed ${dead}`);

  // --- step response settles within the advertised time ---
  const step = await page.evaluate((sp) => {
    const S = window.__speedo;
    S.resetFilter();
    S.settings.tau = 3;
    const now = Date.now();
    const settle = 3 * S.SETTLE_FACTOR;           // seconds shown as "settles in"
    const total = 30 + settle;
    for (let i = 0; i < total; i++) {
      const v = i < 30 ? sp.a : sp.b;
      S.pushSample(v, 5, now - (total - 1 - i) * 1000);
    }
    S.render();
    return document.getElementById('speedValue').textContent;
  }, { a: mphToMs(1.3), b: mphToMs(3.0) });
  check('step response: reaches ~95% of a 1.3 -> 3.0 change in the stated settle time',
    near(parseFloat(step), 3.0, 0.25), `showed ${step}`);

  // --- unit conversion ---
  const units = await page.evaluate((v13) => {
    const S = window.__speedo;
    const out = {};
    for (const u of ['mph', 'kn', 'kmh']) {
      S.resetFilter();
      S.settings.unit = u;
      const now = Date.now(), N = 25;
      for (let i = 0; i < N; i++) S.pushSample(v13, 5, now - (N - 1 - i) * 1000);
      S.render();
      out[u] = {
        speed: document.getElementById('speedValue').textContent,
        label: document.getElementById('unitLabel').textContent,
      };
    }
    S.settings.unit = 'mph';
    return out;
  }, mphToMs(1.3));
  check('units: 1.3 MPH converts to 1.1 kn and 2.1 km/h',
    units.mph.speed === '1.3' && units.kn.speed === '1.1' && units.kmh.speed === '2.1',
    JSON.stringify(units));
  check('units: label follows the selection',
    units.kn.label === 'KN' && units.kmh.label === 'KM/H', JSON.stringify(units));

  // --- spread tracks actual noise ---
  const spread = await page.evaluate((v13) => {
    const S = window.__speedo;
    const measure = (amp) => {
      S.resetFilter();
      S.settings.unit = 'mph';
      const now = Date.now(), N = 10;
      for (let i = 0; i < N; i++) {
        S.pushSample(v13 + (i % 2 ? amp : -amp), 5, now - (N - 1 - i) * 1000);
      }
      S.render();
      return document.getElementById('speedVar').textContent;
    };
    return { calm: measure(0.02), rough: measure(0.2) };
  }, mphToMs(1.3));
  const calmV = parseFloat(spread.calm.replace('±', ''));
  const roughV = parseFloat(spread.rough.replace('±', ''));
  check('± figure tracks real noise (calm < rough)',
    calmV < 0.15 && roughV > 0.35, `calm ${spread.calm}, rough ${spread.rough}`);

  await ctx.close();
}

/* ==========================================================================
   2. Degraded states — the ones that could actually mislead on the water
   ========================================================================== */
{
  const { ctx, page } = await newPage();

  // Moored: GPS goes quiet because nothing is moving. This must NOT flap into
  // an error — that was the "GPS signal lost every few seconds" bug.
  const moored = await page.evaluate(() => {
    const S = window.__speedo;
    S.resetFilter();
    const now = Date.now();
    for (let i = 0; i < 10; i++) S.pushSample(0.02, 5, now - (9 - i) * 1000);
    S.state.lastContactAt = now - 20000;        // receiver silent for 20 s
    S.render();
    return {
      speed: document.getElementById('speedValue').textContent,
      status: document.getElementById('statusLine').textContent,
      acc: document.getElementById('gpsAcc').textContent,
      dot: document.getElementById('gpsDot').className,
    };
  });
  check('moored + GPS quiet: holds 0.0, never claims signal lost',
    moored.speed === '0.0' && moored.status === 'STOPPED'
      && moored.acc === '±5 m' && moored.dot.includes('fair'),
    JSON.stringify(moored));

  // A fix carrying an older timestamp than its arrival must not read as stale
  // the instant it lands — that was the other half of the same bug.
  const backdated = await page.evaluate((v13) => {
    const S = window.__speedo;
    S.resetFilter();
    const now = Date.now();
    for (let i = 0; i < 10; i++) S.pushSample(v13, 5, now - 30000 - (9 - i) * 1000);
    S.state.lastContactAt = now;                // ...but it only just arrived
    S.render();
    return {
      speed: document.getElementById('speedValue').textContent,
      status: document.getElementById('statusLine').textContent,
    };
  }, mphToMs(1.3));
  check('back-dated fix: judged on arrival time, not its own timestamp',
    near(parseFloat(backdated.speed), 1.3, 0.06) && backdated.status === '',
    JSON.stringify(backdated));

  const stale = await page.evaluate((v13) => {
    const S = window.__speedo;
    S.resetFilter();
    const now = Date.now();
    for (let i = 0; i < 10; i++) S.pushSample(v13, 5, now - (9 - i) * 1000);
    S.state.lastContactAt = now - 20000;        // under way, then went quiet
    S.render();
    return {
      speed: document.getElementById('speedValue').textContent,
      status: document.getElementById('statusLine').textContent,
      live: document.getElementById('liveSpeed').textContent,
      acc: document.getElementById('gpsAcc').textContent,
      dot: document.getElementById('gpsDot').className,
    };
  }, mphToMs(1.3));
  check('under way then signal lost: blanks instead of showing an old speed as live',
    stale.speed === '--' && stale.status === 'GPS SIGNAL LOST', JSON.stringify(stale));
  check('under way then signal lost: every secondary readout blanks too',
    stale.live === '--' && stale.acc === '--' && stale.dot.includes('poor'),
    JSON.stringify(stale));

  const denied = await page.evaluate(() => {
    const S = window.__speedo;
    S.resetFilter();
    S.state.error = 'LOCATION ACCESS DENIED';
    S.render();
    return {
      speed: document.getElementById('speedValue').textContent,
      status: document.getElementById('statusLine').textContent,
      cls: document.body.className,
    };
  });
  check('permission denied: says so in words, not an error code',
    denied.speed === '--' && denied.status === 'LOCATION ACCESS DENIED'
      && denied.cls.includes('state-error'), JSON.stringify(denied));

  // Signal-quality dot thresholds
  const dots = await page.evaluate((v13) => {
    const S = window.__speedo;
    const at = (acc) => {
      S.resetFilter();
      const now = Date.now();
      for (let i = 0; i < 6; i++) S.pushSample(v13, acc, now - (5 - i) * 1000);
      S.render();
      return document.getElementById('gpsDot').className;
    };
    return { good: at(6), fair: at(20), poor: at(60) };
  }, mphToMs(1.3));
  check('signal dot: green / amber / red track GPS accuracy',
    dots.good.includes('good') && dots.fair.includes('fair') && dots.poor.includes('poor'),
    JSON.stringify(dots));

  await ctx.close();
}

/* ==========================================================================
   3. Simulator, driven through the real UI
   ========================================================================== */
{
  const { ctx, page } = await newPage();
  await page.click('#startBtn');
  await page.click('#menuBtn');
  await page.waitForTimeout(500);
  await page.click('#simToggle');
  await page.click('#doneBtn');
  await page.waitForTimeout(6000);

  const sim = await page.evaluate(() => ({
    speed: document.getElementById('speedValue').textContent,
    live: document.getElementById('liveSpeed').textContent,
    variance: document.getElementById('speedVar').textContent,
    acc: document.getElementById('gpsAcc').textContent,
    badge: getComputedStyle(document.querySelector('.sim-badge')).opacity,
  }));
  check('simulator: hamburger toggle produces a live number without moving',
    near(parseFloat(sim.speed), 1.3, 0.4), JSON.stringify(sim));
  check('simulator: secondary readouts all populate',
    sim.live !== '--' && sim.variance !== '--' && sim.acc !== '--', JSON.stringify(sim));
  check('simulator: badge visible so it can never be mistaken for real GPS',
    parseFloat(sim.badge) > 0.9, `opacity ${sim.badge}`);

  await ctx.close();
}

/* Persistence needs a context with no addInitScript — that hook re-runs on every
 * navigation, so a seeded context would overwrite localStorage on reload and the
 * check would test the harness rather than the app. */
{
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__speedo);

  await page.click('#startBtn');
  await page.click('#menuBtn');
  await page.waitForTimeout(400);
  await page.click('#simToggle');
  await page.click('[data-unit="kn"]');
  await page.click('#doneBtn');
  await page.waitForTimeout(300);

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__speedo);
  const after = await page.evaluate(() => ({
    sim: window.__speedo.settings.sim,
    unit: window.__speedo.settings.unit,
    label: document.getElementById('unitLabel').textContent,
  }));
  check('settings survive a relaunch (simulator + units)',
    after.sim === true && after.unit === 'kn' && after.label === 'KN',
    JSON.stringify(after));

  await ctx.close();
}

/* ==========================================================================
   3b. Start screen shows once, then gets out of the way
   ========================================================================== */
{
  const { ctx, page } = await newPage();                 // launched: false
  const first = await page.evaluate(() => ({
    overlayShown: !document.getElementById('startOverlay').classList.contains('hidden'),
    started: window.__speedo.state.started,
  }));
  check('first run: start screen is shown and nothing begins until tapped',
    first.overlayShown && first.started === false, JSON.stringify(first));

  await page.click('#startBtn');
  const marked = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('speedo.settings')).launched);
  check('first run: tapping Start records that it has been through once',
    marked === true, `launched=${marked}`);
  await ctx.close();
}
{
  const { ctx, page } = await newPage({ launched: true, sim: true });
  await page.waitForTimeout(4000);                       // no click at all
  const relaunch = await page.evaluate(() => ({
    overlayShown: !document.getElementById('startOverlay').classList.contains('hidden'),
    started: window.__speedo.state.started,
    speed: document.getElementById('speedValue').textContent,
  }));
  check('relaunch: start screen skipped, fix acquiring immediately with no tap',
    !relaunch.overlayShown && relaunch.started === true
      && /^\d+\.\d$/.test(relaunch.speed), JSON.stringify(relaunch));
  await ctx.close();
}

/* ==========================================================================
   3c. Wake lock refused without a gesture (what iOS actually does)
   ========================================================================== */
{
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
  await ctx.addInitScript(seed({ launched: true, sim: true, wake: true }));

  // Stand in for Safari: reject the request until a real tap has happened.
  await ctx.addInitScript(() => {
    let allow = false;
    window.__allowWake = () => { allow = true; };
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: () => allow
          ? Promise.resolve({ addEventListener() {}, release: () => Promise.resolve() })
          : Promise.reject(new DOMException('gesture required', 'NotAllowedError')),
      },
    });
  });

  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__speedo);
  await page.waitForTimeout(600);

  const refused = await page.evaluate(() => document.getElementById('wakeHint').hidden);
  check('wake lock refused on launch: the hint appears rather than failing silently',
    refused === false, `hintHidden=${refused}`);

  // Tap somewhere that is NOT the hint — this is the case Safari was missing.
  await page.evaluate(() => window.__allowWake());
  await page.click('.metrics');
  await page.waitForTimeout(400);

  const held = await page.evaluate(() => document.getElementById('wakeHint').hidden);
  check('a tap anywhere on screen takes the lock and clears the hint',
    held === true, `hintHidden=${held}`);

  await ctx.close();
}

/* ==========================================================================
   4. Offline / PWA
   ========================================================================== */
{
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
  await ctx.addInitScript(seed({ sim: true }));
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(
    () => navigator.serviceWorker.controller || navigator.serviceWorker.ready,
    null, { timeout: 10000 }
  );
  await page.evaluate(() => navigator.serviceWorker.ready);

  // Poll rather than sleeping a fixed amount: precaching finishes whenever it
  // finishes, and a fixed wait makes this check flaky on a loaded machine.
  const readCache = () => page.evaluate(async () => {
    const names = await caches.keys();
    if (!names.length) return null;
    const c = await caches.open(names[0]);
    return (await c.keys()).map((r) => new URL(r.url).pathname).sort();
  });
  const wanted = ['app.js', 'index.html', 'icon-192.png', 'manifest.webmanifest'];
  let cached = null;
  for (let i = 0; i < 40; i++) {
    cached = await readCache();
    if (cached && wanted.every((w) => cached.some((p) => p.endsWith(w)))) break;
    await page.waitForTimeout(250);
  }
  check('service worker precached the whole shell',
    cached && wanted.every((w) => cached.some((p) => p.endsWith(w))),
    JSON.stringify(cached));

  // With a service worker installed and the network up, a reload must still go
  // out for the code. Pure cache-first served the previous version on every
  // launch, so a change was always one launch late — that regression is what
  // this check exists to catch.
  served.length = 0;
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__speedo);
  const refetched = served.some((p) => p.endsWith('app.js'))
                 && served.some((p) => p.endsWith('/') || p.endsWith('index.html'));
  check('update freshness: a reload re-fetches the code, so changes land at once',
    refetched, JSON.stringify(served));

  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  const offline = await page.evaluate(() => ({
    has: !!window.__speedo,
    unit: document.getElementById('unitLabel').textContent,
  }));
  check('app boots with the network cut (this is the on-the-water case)',
    offline.has && offline.unit === 'MPH', JSON.stringify(offline));

  await ctx.setOffline(false);
  await ctx.close();
}

/* ==========================================================================
   4b. Four-character readings must not run off the narrowest screen
   ========================================================================== */
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
  await ctx.addInitScript(seed());
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__speedo);

  const wide = await page.evaluate(() => {
    const S = window.__speedo;
    S.settings.unit = 'kmh';
    S.resetFilter();
    const now = Date.now();
    for (let i = 0; i < 25; i++) S.pushSample(3.5, 5, now - (24 - i) * 1000);  // ~12.6 km/h
    S.render();
    const el = document.getElementById('speedValue');
    const r = el.getBoundingClientRect();
    return {
      text: el.textContent,
      wideClass: el.classList.contains('wide'),
      inside: r.left >= -1 && r.right <= window.innerWidth + 1,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  check('four-character reading (12.6 km/h) steps down and stays on screen',
    wide.text.length === 4 && wide.wideClass && wide.inside && !wide.overflowX,
    JSON.stringify(wide));

  await ctx.close();
}

/* ==========================================================================
   4c. Nothing throws while actually using the thing
   ========================================================================== */
{
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__speedo);
  await page.click('#startBtn');
  await page.click('#menuBtn');
  await page.waitForTimeout(400);

  // Exercise every control in the sheet.
  await page.click('#simToggle');
  for (const s of ['troll', 'chop', 'dropout', 'manual']) {
    await page.click(`[data-scenario="${s}"]`);
    await page.waitForTimeout(250);
  }
  for (const u of ['kn', 'kmh', 'mph']) {
    await page.click(`[data-unit="${u}"]`);
    await page.waitForTimeout(150);
  }
  await page.fill('#tauSlider', '7');
  await page.dispatchEvent('#tauSlider', 'input');
  await page.fill('#simSpeedSlider', '4.2');
  await page.dispatchEvent('#simSpeedSlider', 'input');
  await page.click('#wakeToggle');
  await page.click('#doneBtn');
  await page.waitForTimeout(1500);

  // And the tap-to-cycle-units shortcut on the main screen.
  await page.click('#unitLabel');
  await page.click('#unitLabel');
  await page.waitForTimeout(500);

  check('no console errors or exceptions while driving every control',
    problems.length === 0, problems.join(' | '));

  await ctx.close();
}

/* ==========================================================================
   4d. Privacy: the app must never talk to anyone
   ========================================================================== */
{
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const page = await ctx.newPage();

  const external = [];
  const origin = new URL(BASE).origin;
  ctx.on('request', (r) => {
    const url = r.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (new URL(url).origin !== origin) external.push(r.method() + ' ' + url);
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__speedo);
  await page.click('#startBtn');
  await page.click('#menuBtn');
  await page.waitForTimeout(400);
  await page.click('#simToggle');
  await page.click('[data-scenario="troll"]');
  await page.click('#doneBtn');
  await page.waitForTimeout(4000);

  check('privacy: zero cross-origin requests — no analytics, CDN, fonts or beacons',
    external.length === 0, external.join(' | '));

  // Nothing but the user's own settings should ever be written to storage.
  const stored = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    cookies: document.cookie,
  }));
  // A link that navigates the app itself would strand you: an iOS standalone
  // web app has no back button to return from GitHub with.
  const link = await page.evaluate(() => {
    const a = document.getElementById('repoLink');
    return a && { href: a.getAttribute('href'), target: a.target, rel: a.rel };
  });
  check('settings links to the source, and opens outside the app so it cannot strand you',
    link && /^https:\/\/github\.com\//.test(link.href)
      && link.target === '_blank' && link.rel.includes('noopener'),
    JSON.stringify(link));

  check('privacy: stores only its own settings, and sets no cookies',
    stored.local.length === 1 && stored.local[0] === 'speedo.settings'
      && stored.session.length === 0 && stored.cookies === '',
    JSON.stringify(stored));

  await ctx.close();
}

/* ==========================================================================
   5. Layout screenshots
   ========================================================================== */
const DEVICES = [
  ['iphone-se',      375, 667],
  ['iphone-15',      393, 852],
  ['iphone-15-pmax', 430, 932],
  ['landscape',      852, 393],
];

for (const [name, w, h] of DEVICES) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 2,
  });
  await ctx.addInitScript(seed({ sim: true, scenario: 'chop' }));
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__speedo);
  await page.click('#startBtn');
  await page.waitForTimeout(5000);

  await page.screenshot({ path: join(SHOTS, `${name}.png`) });

  const fits = await page.evaluate(() => {
    const el = document.getElementById('speedValue');
    const v = el.getBoundingClientRect();
    const m = document.querySelector('.metrics').getBoundingClientRect();
    const r = document.querySelector('.readout').getBoundingClientRect();
    return {
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      numberInside: v.left >= -1 && v.right <= window.innerWidth + 1,
      metricsInside: m.bottom <= window.innerHeight + 1,
      clearsMetrics: r.bottom <= m.top + 1,
      // Guard against the whole check passing vacuously against a "--" placeholder.
      text: el.textContent,
      isNumber: /^\d+\.\d$/.test(el.textContent),
      height: v.height,
    };
  });
  check(`layout ${name}: a real number renders, fits, and nothing overflows`,
    fits.isNumber && !fits.overflowX && fits.numberInside
      && fits.metricsInside && fits.clearsMetrics, JSON.stringify(fits));

  if (name === 'iphone-15') {
    await page.click('#menuBtn');
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(SHOTS, 'settings-sheet.png') });
  }
  await ctx.close();
}

/* --- report --------------------------------------------------------------- */

await browser.close();
server.close();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
