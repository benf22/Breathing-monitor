// Background worker wiring the components together — browser equivalent of
// `pipeline/pipeline.py`. Consumes abstract SensorFrame objects from a FaceSensor
// and runs the pure core: lip metrics -> smoothing -> stats. Emits per-frame
// results and confirmed state changes to subscribers (the UI + the uploader).
//
// It is deliberately blind to how frames are produced: any object with
// start(onFrame)/stop()/videoElement satisfies the `sensor` contract.

import { lipMetrics } from "../core/lips.js";
import { LipStateSmoother } from "../core/smoothing.js";
import { StatsAccumulator } from "../core/stats.js";
import { LipState } from "../core/types.js";

export class Pipeline {
  /**
   * @param {Object} sensor  a FaceSensor (or anything with start/stop/videoElement)
   * @param {Object} detection {openThreshold, closeThreshold, minOpenSeconds, minClosedSeconds}
   */
  constructor(sensor, detection = {}) {
    this.sensor = sensor;
    this.detection = detection;
    this.smoother = new LipStateSmoother(detection);
    this.stats = new StatsAccumulator();
    this._frameIndex = 0;
    this._startedAt = null;
    this._listeners = { frame: new Set(), change: new Set(), status: new Set() };
    this.lastResult = null;
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
    }

    const { state, change } = this.smoother.update(ts, mar);

    this.stats.recordFrame(frame.hasFace);
    if (change) this.stats.recordChange(change);

    const result = {
      timestamp: ts,
      frameIndex: this._frameIndex++,
      face: frame.hasFace
        ? { bbox: frame.bbox, landmarks: frame.landmarks, confidence: 1.0 }
        : null,
      lips,
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
