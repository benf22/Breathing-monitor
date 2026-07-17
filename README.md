# Breathing Monitor

A lightweight, CPU-only app that watches your webcam, decides whether your
**lips are open or closed** over time, collects statistics, and (in a later
phase) reminds you to do breathing exercises.

This is **Phase 1 — the detection core**: background image collection, face &
landmark detection, lip open/closed analysis with temporal smoothing, flat-file
metadata logging, and a minimal local web dashboard.

It runs as a Windows-first Python app, but is structured so the pure-logic core
and the ML model file can be reused in a future Android app with minimal effort.

---

## Quick start (Windows / Linux / macOS)

```bash
git clone <your-repo-url>
cd Breathing-monitor

python -m venv .venv
# Windows:  .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate

pip install -r requirements.txt
python main.py
```

Then open **http://127.0.0.1:8000** (it also tries to open automatically).

- The first run downloads the ~3.7 MB `face_landmarker.task` model into `models/`.
- Everything runs on the **CPU**. Frames are sampled every ~0.2 s (configurable)
  and discarded after processing, so memory stays flat.

### Try it without a webcam

```bash
python main.py --offline path/to/an/image_or_folder
```

---

## What you get

- **Live dashboard** — a big OPEN / CLOSED indicator, the current Mouth Aspect
  Ratio (MAR), a camera preview with the face box and lip landmarks drawn on,
  running stats, and a list of recent open↔closed changes.
- **Settings screen** (right panel) — camera source, capture interval,
  open/close thresholds, minimum-duration smoothing, confidence gate, and the
  debug-frame ratio. Saving restarts the pipeline and persists to
  `settings.local.json`.
- **Debug data** under `data/`:
  - `metadata.jsonl` — one record per frame (lip variables + 478 landmarks). No
    raw image is stored here.
  - `changes.csv` — one row per confirmed open↔closed transition.
  - `frames/` — a small sampled fraction of raw frames.
  - `snapshots/` — one image saved on **every** confirmed state change.

---

## How it maps to the five components

| # | Component | Where |
|---|-----------|-------|
| 1 | Background image collection (low memory, every X s, fraction saved) | `capture/camera.py`, `pipeline/pipeline.py`, `storage/debug_frames.py` |
| 2 | Foundation-model feature extraction (face → landmarks → lips, metadata only) | `vision/face_landmarker.py`, `core/lips.py`, `storage/events.py` |
| 3 | Over-time open/closed analysis + snapshot on each change | `core/stats.py`, `storage/debug_frames.py` |
| 4 | High-level algorithm: hysteresis + minimum-duration smoothing | `core/smoothing.py` |
| 5 | Easy-to-run app with entrance + settings screens | `app/server.py`, `app/static/index.html`, `main.py` |

Each component is separable: e.g. you can feed a single image straight through
`FaceLandmarkerEngine → lip_metrics` without the capture loop or web server (see
the tests).

---

## Architecture (built for a later Android port)

```
breathing_monitor/
  core/      pure, portable logic — NO camera/web/ML imports (Android-reusable)
             types.py · lips.py · smoothing.py · stats.py
  vision/    MediaPipe FaceLandmarker wrapper + model download
  capture/   OpenCV webcam / offline image source
  pipeline/  background worker wiring the components together
  storage/   JSONL/CSV metadata + debug frame writers
  config/    settings load/save (defaults in code, overrides in JSON)
  app/       FastAPI dashboard + settings API
main.py      entrypoint (starts pipeline thread + web server)
tests/       unit tests for the pure-logic core (no webcam needed)
```

The `core/` package has zero framework dependencies, so on Android you reuse the
**same `face_landmarker.task` model file** and reimplement only the thin camera
+ UI layer; the lip math, smoothing state machine, and stats port directly.

---

## Configuration

Defaults live in `breathing_monitor/config/settings.py`. Overrides are saved to
`settings.local.json` (git-ignored) via the settings screen, or edit that file
directly. Key knobs:

| Setting | Meaning |
|---------|---------|
| `camera.source` | Webcam index (`0`) or a file/stream path |
| `capture.interval_seconds` | Seconds between sampled frames (CPU/memory) |
| `capture.debug_frame_ratio` | Fraction of frames saved to `frames/` |
| `detection.open_threshold` / `close_threshold` | MAR hysteresis band |
| `detection.min_open_seconds` / `min_closed_seconds` | Min hold before a flip is confirmed |
| `detection.min_face_confidence` / `min_face_area_ratio` | Ignore low-confidence / tiny faces |

---

## Development

```bash
pip install -r requirements.txt
pytest tests/         # pure-logic tests (no webcam / no model needed)
```

## Roadmap (later phases)

- Richer statistics dashboard and history charts
- Breathing-exercise reminders / notifications
- Android app reusing `core/` + the model file
