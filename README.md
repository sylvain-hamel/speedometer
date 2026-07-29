# Speed

A GPS speedometer for slow-speed trolling. One very large number, sized to be read at a
glance from the helm, plus just enough detail to know whether to trust it.

Installable as a PWA and works with no cell service — GPS is on-device, so the network is
only needed to install and update.

<img src="icons/icon-192.png" width="72" alt="">

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
| **GPS** | Position accuracy reported by the receiver, with a green / amber / red dot for signal quality. |
| **± MPH** | How much the raw reading is currently bouncing around. Small means the big number is solid; large means take it with a pinch of salt. |
| **LIVE** | The unfiltered reading, straight from the GPS with no smoothing. Useful for seeing what the filter is doing for you. |

Tap **MPH** under the number to cycle through MPH, knots and km/h.

When the fix goes stale or permission is refused, the number blanks to `--` and says why.
It deliberately never keeps showing an old speed as though it were live.

## Install on iPhone

1. Open the site in **Safari** (it must be Safari — Chrome on iOS cannot install PWAs).
2. Share → **Add to Home Screen**.
3. Launch it from the new icon, and allow location when asked.

Launching from the home-screen icon rather than the Safari tab is what gives you the
full-screen, no-browser-chrome view.

**Keeping the screen on** is handled automatically on iOS 16.4 and later. On anything
older, set Settings → Display & Brightness → **Auto-Lock → Never** while you're out.

## Simulator

Hamburger → **Simulate movement**. It feeds invented GPS fixes through the exact same
filter the real thing uses, so you can see how the display behaves without leaving the
dock. An orange **SIMULATOR** badge stays on screen the whole time so it can't be mistaken
for a real reading.

| Scenario | What it does |
|---|---|
| **Manual** | Holds whatever the slider is set to. |
| **Troll** | Sweeps slowly between a crawl and about 3 MPH. |
| **Chop** | Steady 1.3 MPH with wave action fighting you — the noisiest realistic case. |
| **Dropout** | Good signal → degraded accuracy → total loss of fix. Shows every failure state. |

## Hosting on GitHub Pages

There is no build step, so Pages can serve the repository directly. Two one-time steps:

1. **Settings → General → Change visibility → Public.**
   Free GitHub Pages only serves public repositories; a private one needs a paid plan.
2. **Settings → Pages → Source: "Deploy from a branch" → `main` / `(root)`.**

It'll be live at `https://<user>.github.io/speedometer/` a minute or so later. Pushes to
`main` republish automatically.

## How the speed is worked out

The number comes from `position.coords.speed`, not from differencing successive positions.
At 1.3 MPH the boat covers about 3.5 m in six seconds, which is *smaller* than a typical
GPS position error (±5 m) — so position differencing at trolling speed produces mostly
noise. GPS reports velocity separately, derived from Doppler shift on the satellite
carrier, and that stays good to roughly ±0.1 m/s no matter how slowly you're going.
Position differencing is kept only as a fallback for receivers that withhold it.

That reading is then filtered in two stages: a median across the last few fixes to throw
out isolated glitches, then an exponential moving average to smooth what's left. The EMA
is time-aware — its coefficient is derived from the actual gap between fixes — because iOS
delivers fixes at irregular intervals, and a plain N-sample average would silently change
its own time constant whenever the fix rate dropped.

Below about 0.2 MPH the display is pinned to `0.0`, since stationary GPS drift otherwise
reads as a phantom few tenths.

**One caveat on the ± figure.** The Geolocation API exposes positional accuracy but *not*
speed accuracy, so that number is not the receiver's own error estimate. It is the observed
standard deviation of the raw speed samples over the last ten seconds — how much the
reading is actually bouncing around right now. In practice that's the more useful of the
two, but it is a measurement, not a manufacturer's figure.

## Development

Plain HTML, CSS and JavaScript. No build, no dependencies, no framework — open
`index.html` through any static server and it runs.

```bash
npx http-server -p 8000     # or: python3 -m http.server 8000

node tools/verify.mjs       # 21 end-to-end checks + layout screenshots
node tools/make-icons.mjs   # regenerate PNGs after editing icons/icon.svg
```

`tools/` needs Playwright and Chromium; the app itself needs neither. `verify.mjs` drives
the real page — the filter assertions call into the live app rather than a copy — and
covers spike rejection, the deadband, step response, unit conversion, every degraded
state, service-worker precaching, offline boot, and layout across four iPhone viewports.

After changing any shipped file, bump `CACHE_VERSION` in `sw.js` so installed copies pick
up the update on their next launch.
