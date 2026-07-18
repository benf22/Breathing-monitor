// Data contracts shared across the browser pipeline.
//
// This is the JS mirror of `breathing_monitor/core/types.py`. Kept free of any
// camera / MediaPipe / DOM types so the pure math ports 1:1 from Python and can
// be unit-tested standalone. A normalized landmark is just [x, y, z] in 0..1
// image coordinates.

/** @typedef {[number, number, number]} Point */

/** Reported mouth state. UNKNOWN = no usable face this frame. */
export const LipState = Object.freeze({
  OPEN: "open",
  CLOSED: "closed",
  UNKNOWN: "unknown",
});

/**
 * A confirmed open<->closed transition after smoothing.
 * @typedef {Object} StateChange
 * @property {number} timestamp      seconds
 * @property {number} frameIndex
 * @property {string} fromState
 * @property {string} toState
 * @property {number} prevDuration   seconds the previous state was held
 */

/**
 * Everything produced for one processed frame.
 * @typedef {Object} FrameResult
 * @property {number} timestamp
 * @property {number} frameIndex
 * @property {?Object} face      {bbox, landmarks, confidence} or null (gated out)
 * @property {?Object} lips      {mar, vertical, horizontal, isOpen} or null
 * @property {string} rawState   per-frame decision
 * @property {string} state      smoothed state
 * @property {?StateChange} stateChange
 */

export function makeStatsSummary() {
  return {
    totalChanges: 0,
    openCount: 0,
    closedCount: 0,
    totalOpenSeconds: 0,
    totalClosedSeconds: 0,
    framesProcessed: 0,
    framesWithFace: 0,
    recentChanges: [],
  };
}
