# Breathing Monitor — Web / PWA (Phase 2)

Run the breathing monitor on your **phone** (Android or iOS) with **no native
app**. Everything — camera capture *and* the MediaPipe foundation model — runs
in the browser on the device. Only small metadata is uploaded to a central store
so you can track your status across days.

This targets the **"phone on my desk watching me while I work"** use case
(screen on). Background / screen-off monitoring is *not* possible in a browser
and would require a native app — see the note at the bottom.

## Install on your Android phone (simplest — GitHub Pages)

Once the **Deploy PWA to GitHub Pages** workflow (`.github/workflows/deploy-pages.yml`)
has run, the app is live at:

```
https://benf22.github.io/Breathing-monitor/
```

On the phone:

1. Open that URL in **Chrome**.
2. Tap **⋮ → Add to Home Screen** (a.k.a. *Install app*).
3. Launch it from the new icon, tap **Start monitoring**, allow the camera.

Nothing is installed on the phone beyond a home-screen shortcut — no Play Store,
no APK, no `pip`. All capture + model inference run in the browser, on-device.

> GitHub Pages serves the static app only; it can't host the central store, so
> the **Statistics** (cross-day) tab stays empty until you run the backend
> somewhere and point **Config → API base URL** at it. Live monitoring,
> per-session stats, and notifications all work without a backend.

## Run it locally (full features, incl. the central store)

From the repo root:

```bash
pip install -r requirements.txt
python cloud_main.py            # serves this PWA + the central store on :8000
```

Open the printed LAN URL on your phone (same Wi-Fi), tap **Start monitoring**,
allow the camera, and prop the phone facing you.

> Browsers require a **secure context** for the camera: `https://` or
> `localhost`. Plain-HTTP LAN IPs are blocked on many phones — put a TLS
> terminator (Caddy / ngrok / cloudflared) in front for real use.

## Architecture

```
FaceSensor  ──emits SensorFrame──▶  Pipeline  ──▶  core (lips → smoothing → stats)
(camera + model, one module)                          │
                                                      ├─▶ UI (Monitor tab)
                                                      ├─▶ Notifier (alerts)
                                                      └─▶ MetadataUploader ──▶ /api/ingest
                                                                                   │
                                                              Central store (SQLite) ──▶ /api/stats/daily ──▶ Statistics tab
```

### The separated capture + model module

`js/vision/faceSensor.js` owns **both** the camera (`js/capture/camera.js`) and
the foundation model (`js/vision/faceLandmarker.js`) and exposes one contract:

```js
const sensor = new FaceSensor({ intervalMs: 200 });
await sensor.start((frame) => {
  // frame = { timestampSeconds, hasFace, landmarks, bbox, aspectRatio }
});
sensor.videoElement; // live <video> for preview
sensor.stop();
```

The analysis code never imports MediaPipe or `getUserMedia`. To swap the model,
replace `faceLandmarker.js` (keep `detect(video, tsMs)`), or inject a custom
`engine` into `FaceSensor`.

### Ported pure-logic core

`js/core/{lips,smoothing,stats,types}.js` are a direct port of
`breathing_monitor/core/*`. The MediaPipe Face Mesh landmark indices are
identical across the Python, Android and Web builds of the same
`face_landmarker.task` model, so the MAR math and the hysteresis + min-duration
state machine behave the same as the desktop app.

Run the port's tests (no dependencies):

```bash
node web/tests/core.test.mjs
```

## Tabs

- **Monitor** — live OPEN/CLOSED, preview with face box + lip landmarks, session
  stats, recent changes, and notifications.
- **Definitions** — glossary.
- **Config** — thresholds, capture interval, notification rules, central-store
  URL. Saved to `localStorage`.
- **Statistics** — cross-day aggregation from the central store.

## What gets uploaded

Only **confirmed open↔closed changes** and **periodic stats rollups** (every
~30 s). No video frames, no landmarks, no images. Uploads are batched and
buffered in `localStorage` so a brief network drop loses nothing.

Point the phone at a shared server by setting **Config → API base URL** (e.g.
`https://breathing.example.com`); leave it blank to use the same server that
served the page.

## Offline / installability

`manifest.webmanifest` + `sw.js` make the app installable ("Add to Home
Screen"). The app shell is cached for offline load; the MediaPipe WASM/model is
runtime-cached after first use. Metadata uploads are never cached and retry when
back online.

## Why not background / screen-off?

A browser cannot use the camera while backgrounded or with the screen off, and a
front camera can't see your lips in the dark or from a pocket anyway. If you
later need passive monitoring, that requires a **native app** (Kotlin +
MediaPipe Tasks for Android, reusing this same `.task` model and the ported
`core/` logic) — or switching to a sensor better suited to it (microphone /
accelerometer).
