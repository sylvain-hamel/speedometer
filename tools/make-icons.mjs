/* Rasterise icons/icon.svg to the PNG sizes the manifest and iOS need.
 *
 * Dev-only tool — the app itself has no build step. Run it after editing
 * icon.svg:   node tools/make-icons.mjs
 *
 * It drives headless Chromium and downscales through a canvas rather than
 * screenshotting at each size, because Chromium refuses to produce a real
 * screenshot below roughly 500x500 (it silently returns a blank frame).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  ['icons/icon-192.png', 192],
  ['icons/icon-512.png', 512],
  ['icons/apple-touch-icon-180.png', 180],
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('No Chromium found. Set CHROME_PATH to a Chrome/Chromium binary.');
  process.exit(1);
}

const svg = readFileSync(resolve(root, 'icons/icon.svg'), 'utf8');
const svgUri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');

const html = `<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
const sizes = ${JSON.stringify(TARGETS.map((t) => t[1]))};
const img = new Image();
img.onload = () => {
  const out = [];
  for (const s of sizes) {
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, s, s);
    out.push(s + '|' + c.toDataURL('image/png'));
  }
  document.getElementById('out').textContent = out.join('\\n');
};
img.onerror = () => { document.getElementById('out').textContent = 'ERROR'; };
img.src = ${JSON.stringify(svgUri)};
</script>`;

const page = resolve(tmpdir(), 'speedo-icons.html');
writeFileSync(page, html);

const dom = execFileSync(chrome, [
  '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--virtual-time-budget=5000', '--window-size=600,600',
  '--dump-dom', 'file://' + page,
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (dom.includes('>ERROR<')) {
  console.error('Chromium could not decode icons/icon.svg');
  process.exit(1);
}

const found = new Map();
for (const m of dom.matchAll(/(\d+)\|data:image\/png;base64,([A-Za-z0-9+/=]+)/g)) {
  found.set(Number(m[1]), Buffer.from(m[2], 'base64'));
}

let failed = false;
for (const [file, size] of TARGETS) {
  const buf = found.get(size);
  if (!buf) { console.error(`missing ${size}px render`); failed = true; continue; }
  // Sanity-check the PNG header rather than trusting the pipeline blindly.
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w !== size || h !== size) {
    console.error(`${file}: expected ${size}x${size}, got ${w}x${h}`);
    failed = true;
    continue;
  }
  writeFileSync(resolve(root, file), buf);
  console.log(`${file}  ${w}x${h}  ${buf.length} bytes`);
}

process.exit(failed ? 1 : 0);
