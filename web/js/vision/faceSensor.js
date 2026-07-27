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
//       blendshapes | null,      // {categoryName: score} ARKit action units (0..1)
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
    // Rotation: "auto" | "0" | "90" | "180" | "270". "auto" rotates only when the
    // camera frame's orientation doesn't match the screen (some devices deliver
    // sensor-oriented, i.e. sideways, video).
    this.rotationMode = opts.rotation ?? "auto";
    this._rotCanvas = null;
    this._frameSource = null;
    this._timer = null;
    this._running = false;
    this._lastTsMs = -1;
    this._busy = false;
  }

  setRotation(mode) {
    this.rotationMode = mode || "auto";
  }

  get videoElement() {
    return this._camera.video;
  }

  /** The image actually processed/previewed (raw video, or the rotated canvas). */
  get displaySource() {
    return this._frameSource || this._camera.video;
  }

  /** Degrees to rotate the raw frame so the face is upright. */
  _rotationDegrees(video) {
    const m = this.rotationMode;
    if (m === "90" || m === "180" || m === "270") return Number(m);
    if (m === "0" || m === "off" || m === "none") return 0;
    // auto
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return 0;
    const videoPortrait = vh > vw;
    const type = (typeof screen !== "undefined" && screen.orientation && screen.orientation.type) || "";
    const angle =
      (typeof screen !== "undefined" && screen.orientation && typeof screen.orientation.angle === "number"
        ? screen.orientation.angle
        : (typeof window !== "undefined" && window.orientation) || 0);
    const screenPortrait = type ? type.startsWith("portrait") : window.innerHeight >= window.innerWidth;
    if (videoPortrait === screenPortrait) {
      return angle === 180 ? 180 : 0; // orientation matches; only flip if upside-down
    }
    return angle === 90 ? 270 : 90; // 90° off — rotate to align
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

      // Rotate the frame upright before detection so MAR (vertical vs
      // horizontal) stays valid, and preview the same oriented image.
      const deg = this._rotationDegrees(video);
      let source, aspectRatio;
      if (!deg) {
        source = video;
        aspectRatio = this._camera.aspectRatio;
      } else {
        const vw = video.videoWidth, vh = video.videoHeight;
        const swap = deg === 90 || deg === 270;
        if (!this._rotCanvas) this._rotCanvas = document.createElement("canvas");
        const c = this._rotCanvas;
        c.width = swap ? vh : vw;
        c.height = swap ? vw : vh;
        const ctx = c.getContext("2d");
        ctx.save();
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate((deg * Math.PI) / 180);
        ctx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
        ctx.restore();
        source = c;
        aspectRatio = c.width / c.height;
      }
      this._frameSource = source;

      const face = this._engine.detect(source, tsMs);
      onFrame({
        timestampSeconds: tsMs / 1000,
        timestampMs: tsMs,
        hasFace: face !== null,
        landmarks: face ? face.landmarks : null,
        bbox: face ? face.bbox : null,
        blendshapes: face ? face.blendshapes : null,
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
