// MediaPipe FaceLandmarker (Web) wrapper — components 2a + 2b.
//
// Browser equivalent of `vision/face_landmarker.py`. Runs the pre-trained
// face_landmarker.task model on a <video> frame, selects the LARGEST face,
// applies the confidence/size gate, and returns a plain FaceDetection-like
// object ({bbox, landmarks, confidence}) or null when the frame is ignored.
//
// The .task model file is the SAME bundle Google publishes for the Python and
// Android APIs, so the landmark indices used by lips.js are identical.
//
// This is the ONE place that imports MediaPipe. Swap this file (keeping the
// detect(video, tsMs) contract) to use a different foundation model.

// Default CDN pins. Overridable via config for offline/self-hosting.
const TASKS_VISION_VERSION = "0.10.21"; // matches Python mediapipe==0.10.21
export const DEFAULT_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
export const DEFAULT_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/" +
  "face_landmarker/float16/1/face_landmarker.task";

export class FaceLandmarkerEngine {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.minFaceConfidence=0.5]
   * @param {number} [opts.minFaceAreaRatio=0.02]
   * @param {number} [opts.numFaces=3]
   * @param {string} [opts.modelUrl]
   * @param {string} [opts.wasmBase]
   */
  constructor(opts = {}) {
    this.minFaceConfidence = opts.minFaceConfidence ?? 0.5;
    this.minFaceAreaRatio = opts.minFaceAreaRatio ?? 0.02;
    this.numFaces = opts.numFaces ?? 3;
    this.modelUrl = opts.modelUrl ?? DEFAULT_MODEL_URL;
    this.wasmBase = opts.wasmBase ?? DEFAULT_WASM_BASE;
    this._landmarker = null;
  }

  /** Load the WASM fileset + model. ~3.7 MB model, fetched once (SW-cacheable). */
  async init() {
    const { FaceLandmarker, FilesetResolver } = await import(
      /* @vite-ignore */
      `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}`
    );
    const fileset = await FilesetResolver.forVisionTasks(this.wasmBase);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: this.modelUrl, delegate },
      runningMode: "VIDEO",
      numFaces: this.numFaces,
      minFaceDetectionConfidence: this.minFaceConfidence,
      minFacePresenceConfidence: this.minFaceConfidence,
      minTrackingConfidence: this.minFaceConfidence,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
    // Prefer GPU; fall back to CPU on devices/browsers that reject the delegate.
    try {
      this._landmarker = await FaceLandmarker.createFromOptions(fileset, opts("GPU"));
    } catch (err) {
      console.warn("GPU delegate unavailable, falling back to CPU:", err);
      this._landmarker = await FaceLandmarker.createFromOptions(fileset, opts("CPU"));
    }
  }

  /**
   * Detect the gated largest face for a video frame.
   * @param {HTMLVideoElement} video
   * @param {number} timestampMs monotonic ms (must strictly increase)
   * @returns {?{bbox:Object, landmarks:number[][], confidence:number}}
   */
  detect(video, timestampMs) {
    if (!this._landmarker) throw new Error("FaceLandmarkerEngine.init() not called");
    const result = this._landmarker.detectForVideo(video, timestampMs);
    const faces = result?.faceLandmarks;
    if (!faces || faces.length === 0) return null; // none passed the model gate (2a)

    let bestPoints = null;
    let bestBbox = null;
    let bestArea = -1.0;
    for (const landmarks of faces) {
      const points = landmarks.map((lm) => [lm.x, lm.y, lm.z]);
      const bbox = bboxFromPoints(points);
      if (bbox.area > bestArea) {
        bestArea = bbox.area;
        bestPoints = points;
        bestBbox = bbox;
      }
    }

    // Size gate: ignore faces whose box is too small a fraction of the frame (2a).
    if (bestBbox.area < this.minFaceAreaRatio) return null;

    return { bbox: bestBbox, landmarks: bestPoints, confidence: 1.0 };
  }

  close() {
    try {
      this._landmarker?.close();
    } catch {
      /* ignore */
    }
    this._landmarker = null;
  }
}

function bboxFromPoints(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const width = x1 - x0;
  const height = y1 - y0;
  return { x: x0, y: y0, width, height, area: Math.max(0, width) * Math.max(0, height) };
}
