// Camera preview overlay — draws the mirrored video plus the face box and lip
// landmarks, browser equivalent of `pipeline/overlay.py`. Purely presentational.

import { lipLandmarkIndices } from "../core/lips.js";

const LIP_INDICES = lipLandmarkIndices();

// MediaPipe Face Mesh nose landmarks (bridge, tip, base and nostrils). These
// indices are stable across the same face_landmarker.task model, like the lips.
const NOSE_INDICES = [168, 6, 197, 195, 5, 4, 1, 19, 94, 2, 98, 97, 326, 327, 129, 358];
const NOSE_COLOR = "#ffd166";

export class PreviewRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this._video = null;
    this._result = null;
    this._raf = null;
  }

  attach(video) {
    this._video = video;
    this._loop();
  }

  setResult(result) {
    this._result = result;
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._video = null;
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    const video = this._video;
    if (!video || video.readyState < 2) return;

    const cw = this.canvas.clientWidth || 480;
    const ch = Math.round((cw * video.videoHeight) / video.videoWidth) || 360;
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.ctx;

    // Mirror horizontally so it reads like a mirror.
    ctx.save();
    ctx.translate(this.canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);

    const r = this._result;
    if (r && r.face) {
      const { bbox, landmarks } = r.face;
      const open = r.state === "open";
      ctx.strokeStyle = open ? "#ff5c7a" : "#39d98a";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        bbox.x * this.canvas.width,
        bbox.y * this.canvas.height,
        bbox.width * this.canvas.width,
        bbox.height * this.canvas.height
      );
      // Lips — colored by open/closed state.
      ctx.fillStyle = open ? "#ff5c7a" : "#39d98a";
      for (const i of LIP_INDICES) {
        const p = landmarks[i];
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(p[0] * this.canvas.width, p[1] * this.canvas.height, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      // Nose — fixed accent color so it's distinguishable from the lips.
      ctx.fillStyle = NOSE_COLOR;
      for (const i of NOSE_INDICES) {
        const p = landmarks[i];
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(p[0] * this.canvas.width, p[1] * this.canvas.height, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}
