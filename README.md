# Speed

<img src="icons/icon-192.png" width="72" align="right" alt="">

### ▶ [Open the app](https://sylvain-hamel.github.io/speedometer/)

<sub>sylvain-hamel.github.io/speedometer — open in Safari on iPhone, then Share → Add to Home Screen</sub>

A GPS speedometer for slow-speed boating. One very large number, sized to be read at a
glance from the helm, plus just enough detail to know whether to trust it.

Built for trolling, where holding an exact speed matters and most apps bury the number
under a map. Installs as a PWA and works with no signal — GPS is on-device, so the network
is only needed to install and update.

## The display

```
                    1.3
                    MPH

    ● ±5 m      ±0.4        1.6
      GPS       ± MPH       LIVE
```

| | |
|---|---|
| **Big number** | Smoothed speed — the one you steer by. |
| **GPS** | Position accuracy from the receiver, with a green / amber / red dot for signal quality. |
| **± MPH** | How much the raw reading is currently bouncing around. Small means the big number is solid; large means take it with a pinch of salt. |
| **LIVE** | The unfiltered reading, straight from the GPS. Useful for seeing what the smoothing is doing for you. |

Tap **MPH** under the number to cycle through MPH, knots and km/h. The hamburger opens
units, smoothing and the simulator.

The start screen appears only on the very first launch. After that the app opens straight
into the readout and starts acquiring a fix immediately.

### When the signal isn't good

- **Under way and the fix drops** → the number blanks to `--` and says `GPS SIGNAL LOST`.
  It deliberately never leaves an old speed on screen looking live.
- **Stopped and the fix goes quiet** → holds `0.0` and says `STOPPED`. Receivers throttle
  updates hard when nothing is moving, and treating that as an error would make the
  display flap between a number and a warning while you're tied up.
- **Below about 0.2 MPH** → pinned to `0.0`, so stationary drift doesn't read as a phantom
  few tenths.

## Install on iPhone

1. Open the site in **Safari** — Chrome on iOS cannot install PWAs.
2. Share → **Add to Home Screen**.
3. Launch it from the new icon and allow location.

Launching from the home-screen icon rather than a Safari tab is what gives you the
full-screen view with no browser chrome.

**Keeping the screen on** uses the Screen Wake Lock API (iOS 16.4+). Safari generally only
grants it off a real user gesture, so on launches that skip the start screen a small *Tap
anywhere to keep screen on* prompt appears — one tap, anywhere on screen, and it's held.
iOS releases the lock whenever the app is backgrounded, so it's re-taken on return. On
older iOS there's no wake lock at all: set Settings → Display & Brightness →
**Auto-Lock → Never** instead.

If iOS re-prompts for location on every launch, choose **Allow While Using App** rather
than *Allow Once* when the prompt appears.

## Simulator

Hamburger → **Simulate movement**. It feeds invented fixes through the exact same filter
the real thing uses, so you can see how the display behaves without leaving the dock. An
orange **SIMULATOR** badge stays on screen throughout so it can't be mistaken for a real
reading.

| Scenario | What it does |
|---|---|
| **Manual** | Holds whatever the slider is set to. |
| **Troll** | Sweeps slowly between a crawl and about 3 MPH. |
| **Chop** | Steady 1.3 MPH with wave action fighting you — the noisiest realistic case. |
| **Dropout** | Good signal → degraded accuracy → total loss of fix. Shows every failure state. |

## How the speed is worked out

The number comes from `position.coords.speed`, not from differencing successive positions.
At 1.3 MPH a boat covers about 3.5 m in six seconds, which is *smaller* than a typical GPS
position error (±5 m) — so position differencing at trolling speed produces mostly noise.
GPS reports velocity separately, derived from Doppler shift on the satellite carrier, and
that stays good to roughly ±0.1 m/s no matter how slowly you're going. Position
differencing is kept only as a fallback for receivers that withhold it.

That reading is then filtered in two stages: a median across the last few fixes to throw
out isolated glitches, then an exponential moving average to smooth what's left. The EMA is
time-aware — its coefficient is derived from the actual gap between fixes — because fixes
arrive at irregular intervals, and a plain N-sample average would silently change its own
time constant whenever the fix rate dropped.

The filter waits for a few fixes before it starts, rather than seeding itself from the first
one. A cold GPS start often produces one wildly wrong reading, and seeding from it drags the
display off for several seconds before the average can haul it back.

Staleness is judged on when a fix *arrived*, not on the timestamp it carries. iOS can hand
back a position stamped noticeably earlier than the moment it is delivered, and keying off
that makes a perfectly good fix look expired on arrival.

**One caveat on the ± figure.** The Geolocation API exposes positional accuracy but *not*
speed accuracy, so that number is not the receiver's own error estimate. It is the observed
standard deviation of the raw speed samples over the last ten seconds — how much the
reading is actually bouncing right now. In practice that's the more useful of the two, but
it is a measurement, not a manufacturer's figure.

## Privacy

**This app collects nothing whatsoever.** There is no backend, no analytics, no tracking,
no accounts, no cookies, and no third-party requests.

- **Your position never leaves the device.** It is read from the browser's geolocation API,
  turned into a number on screen, and discarded. It is never stored, logged or transmitted —
  not to me, not to anyone.
- **Nothing is ever uploaded.** No request the app makes carries any data about you. It
  sends no telemetry, no beacons, no error reports.
- **Zero third-party requests.** No analytics, no external CDN, no web fonts, no remote
  images, no third-party scripts. Everything it needs ships in this repository.
- **The only thing saved** is your own settings — units, smoothing, simulator — in
  `localStorage` on your phone. Nothing else touches storage, and no cookies are set.

To be precise rather than flattering: on launch, when online, the app does re-request its
own files (the page and its script) from wherever you installed it from, to pick up updates.
That's an ordinary file download that sends nothing but the request itself, and it's the
same server that served you the app in the first place. Offline it makes no requests at all
and runs entirely from cache.

It's a handful of static files with no server-side component, so you can read the whole
thing in a few minutes. These aren't just promises either: `tools/verify.mjs` asserts that
the running app issues **zero cross-origin requests** and writes nothing to storage beyond
that one settings key, so the claim breaks the build if it ever stops being true.

(It isn't literally one file — a service worker has to be a separate file to work offline —
but there is no server-side anything, and no code runs outside your browser.)

## Running your own copy

Static files with no build step, so any static host works, including GitHub Pages straight
from the repository (Settings → Pages → deploy from a branch, root folder). Geolocation and
service workers both require HTTPS.

```bash
npx http-server -p 8000     # or: python3 -m http.server 8000
```

## Development

Plain HTML, CSS and JavaScript. No build, no dependencies, no framework.

```bash
node tools/verify.mjs       # 34 end-to-end checks + layout screenshots
node tools/make-icons.mjs   # regenerate PNGs after editing icons/icon.svg
```

`tools/` needs Playwright and Chromium; the app itself needs neither. `verify.mjs` drives
the real page — the filter assertions call into the live app rather than a copy — and
covers spike rejection, the deadband, step response, unit conversion, every degraded state,
service-worker precaching, offline boot, and layout across four iPhone viewports.

After changing any shipped file, bump `CACHE_VERSION` in `sw.js`. The service worker is
network-first for code and cache-first for icons, so an online launch picks changes up
immediately; a pure cache-first worker served the previous version on every launch, which
made every change land one launch late.

## Licence

MIT
