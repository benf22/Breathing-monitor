// FaceSensor — the SEPARATED "capture + foundation model" module.
//
// This is the single seam the user asked for: it owns BOTH the camera and the
// MediaPipe model, and exposes one small contract:
//
//     sensor.videoElement                      -> the live <video> (for preview)
//     await sensor.start(onFrame)              -> begins emitting SensorFrame
//     sensor.stop()
//
// where onFrame receives:
//
//     {
//       timestampSeconds, timestampMs,
//       hasFace,                 // false when the frame was gated out
//       landmarks | null,        // number[][] normalized [x,y,z]
//       bbox | null,
//       aspectRatio,             // videoWidth / videoHeight
//     }
//
// The analysis half (lips.js / smoothing.js / stats.js) consumes SensorFrame and
// never imports MediaPipe or getUserMedia. To swap the model, replace only
// faceLandmarker.js (or provide a different engine implementing detect()).

import { CameraCapture } from "../capture/camera.js";
import { FaceLandmarkerEngine } from "./faceLandmarker.js";

export class FaceSensor {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.intervalMs=200]   sample period (component 1)
   * @param {number} [opts.minFaceConfidence]
   * @param {number} [opts.minFaceAreaRatio]
   * @param {number} [opts.width]
   * @param {number} [opts.height]
   * @param {string} [opts.facingMode]
   * @param {string} [opts.modelUrl]
   * @param {string} [opts.wasmBase]
   * @param {Object} [opts.engine]   inject a custom engine (must have init/detect/close)
   */
  constructor(opts = {}) {
    this.intervalMs = opts.intervalMs ?? 200;
    this._camera = new CameraCapture({
      width: opts.width,
      height: opts.height,
      facingMode: opts.facingMode,
    });
    this._engine =
      opts.engine ??
      new FaceLandmarkerEngine({
        minFaceConfidence: opts.minFaceConfidence,
        minFaceAreaRatio: opts.minFaceAreaRatio,
        modelUrl: opts.modelUrl,
        wasmBase: opts.wasmBase,
      });
    this._timer = null;
    this._running = false;
    this._lastTsMs = -1;
    this._busy = false;
  }

  get videoElement() {
    return this._camera.video;
  }

  /**
   * Boot the camera + model, then emit a SensorFrame every intervalMs.
   * @param {(frame: Object) => void} onFrame
   */
  async start(onFrame) {
    await this._camera.start();
    await this._engine.init();
    this._running = true;

    const tick = () => {
      if (!this._running) return;
      this._processOnce(onFrame);
      this._timer = setTimeout(tick, this.intervalMs);
    };
    tick();
  }

  _processOnce(onFrame) {
    const video = this._camera.video;
    if (!video || video.readyState < 2) return;
    if (this._busy) return; // don't overlap inference
    this._busy = true;
    try {
      // detectForVideo requires a strictly increasing timestamp.
      let tsMs = performance.now();
      if (tsMs <= this._lastTsMs) tsMs = this._lastTsMs + 1;
      this._lastTsMs = tsMs;

      const face = this._engine.detect(video, tsMs);
      const aspectRatio = this._camera.aspectRatio;
      onFrame({
        timestampSeconds: tsMs / 1000,
        timestampMs: tsMs,
        hasFace: face !== null,
        landmarks: face ? face.landmarks : null,
        bbox: face ? face.bbox : null,
        aspectRatio,
      });
    } catch (err) {
      console.error("FaceSensor detect failed:", err);
    } finally {
      this._busy = false;
    }
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._engine.close();
    this._camera.stop();
  }
}
