// Background worker wiring the components together — browser equivalent of
// `pipeline/pipeline.py`. Consumes abstract SensorFrame objects from a FaceSensor
// and runs the pure core: lip metrics -> smoothing -> stats. Emits per-frame
// results and confirmed state changes to subscribers (the UI + the uploader).
//
// It is deliberately blind to how frames are produced: any object with
// start(onFrame)/stop()/videoElement satisfies the `sensor` contract.

import { lipMetrics } from "../core/lips.js";
import { nostrilMetrics } from "../core/nostrils.js";
import { LipStateSmoother } from "../core/smoothing.js";
import { TalkingDetector } from "../core/talking.js";
import { StatsAccumulator } from "../core/stats.js";
import { LipState } from "../core/types.js";

export class Pipeline {
  /**
   * @param {Object} sensor  a FaceSensor (or anything with start/stop/videoElement)
   * @param {Object} detection {openThreshold, closeThreshold, minOpenSeconds, minClosedSeconds}
   */
  constructor(sensor, detection = {}, options = {}) {
    this.sensor = sensor;
    this.detection = detection;
    this.smoother = new LipStateSmoother(detection);
    this.stats = new StatsAccumulator();
    this.talkingDetector = new TalkingDetector(options.talking || {});
    this._frameIndex = 0;
    this._startedAt = null;
    this._listeners = { frame: new Set(), change: new Set(), status: new Set() };
    this.lastResult = null;
  }

  /** Update talking-detection config live (enabled / sensitivity). */
  setTalkingConfig(cfg) {
    this.talkingDetector.setConfig(cfg);
  }

  /** @param {"frame"|"change"|"status"} event */
  on(event, fn) {
    this._listeners[event].add(fn);
    return () => this._listeners[event].delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this._listeners[event]) {
      try {
        fn(payload);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /**
   * Update detection thresholds on a running pipeline (no restart needed).
   * Keeps the instantaneous decision and the smoother's hysteresis in sync.
   * @param {{openThreshold?:number, closeThreshold?:number,
   *          minOpenSeconds?:number, minClosedSeconds?:number}} partial
   */
  updateDetection(partial) {
    this.detection = { ...this.detection, ...partial };
    const c = this.smoother.config;
    for (const k of ["openThreshold", "closeThreshold", "minOpenSeconds", "minClosedSeconds"]) {
      if (partial[k] !== undefined) c[k] = partial[k];
    }
    // Preserve the hysteresis invariant so _desired() stays well-defined.
    if (c.closeThreshold > c.openThreshold) c.closeThreshold = c.openThreshold;
  }

  async start() {
    this._startedAt = Date.now();
    this._emit("status", { running: true });
    await this.sensor.start((frame) => this._onSensorFrame(frame));
  }

  stop() {
    this.sensor.stop();
    this._emit("status", { running: false });
  }

  _onSensorFrame(frame) {
    const ts = frame.timestampSeconds;
    const openThreshold = this.detection.openThreshold ?? 0.35;

    let lips = null;
    let nose = null;
    let rawState = LipState.UNKNOWN;
    let mar = null;

    if (frame.hasFace && frame.landmarks) {
      try {
        lips = lipMetrics(frame.landmarks, openThreshold, frame.aspectRatio);
        rawState = lips.isOpen ? LipState.OPEN : LipState.CLOSED;
        mar = lips.mar;
      } catch (e) {
        // Landmark list too short / malformed — treat as no usable face.
        lips = null;
      }
      try {
        nose = nostrilMetrics(frame.landmarks, frame.aspectRatio);
      } catch (e) {
        nose = null;
      }
    }

    const { state, change } = this.smoother.update(ts, mar);

    // Talking detection runs on the raw MAR dynamics (independent of the ignore
    // gate) so it keeps working while the mouth is moving.
    const talking = this.talkingDetector.update(frame.timestampMs, mar);

    this.stats.recordFrame(frame.hasFace);
    if (change) this.stats.recordChange(change);

    const result = {
      timestamp: ts,
      frameIndex: this._frameIndex++,
      face: frame.hasFace
        ? { bbox: frame.bbox, landmarks: frame.landmarks, confidence: 1.0 }
        : null,
      lips,
      nose,
      talking,
      talkingScore: this.talkingDetector.score,
      rawState,
      state,
      stateChange: change,
    };
    this.lastResult = result;

    this._emit("frame", result);
    if (change) this._emit("change", change);
  }

  snapshot() {
    const now = this.lastResult ? this.lastResult.timestamp : 0;
    return this.stats.asDict(this.smoother.state, this.smoother.timeInState(now));
  }
}
