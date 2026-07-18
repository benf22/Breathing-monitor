// High-level temporal algorithm — component 4.
//
// JS port of `breathing_monitor/core/smoothing.py`. Turns the noisy per-frame
// open/closed decision into a stable reported state using:
//
//  * Hysteresis — separate open/close MAR thresholds. Once OPEN, the mouth must
//    drop below the (lower) close threshold to flip back, and vice-versa. Kills
//    chatter when the MAR hovers around a single threshold.
//  * Minimum duration — a candidate flip must persist for a configured number of
//    seconds before it is *confirmed*. Brief flickers never reach the state.
//
// Pure and deterministic: feed it (timestamp, mar) and it returns the smoothed
// LipState plus a StateChange on confirmed flips.

import { LipState } from "./types.js";

export const DEFAULT_SMOOTHING = Object.freeze({
  openThreshold: 0.35, // MAR at/above which a closed mouth may open
  closeThreshold: 0.28, // MAR at/below which an open mouth may close
  minOpenSeconds: 0.15, // hold before confirming a flip to OPEN
  minClosedSeconds: 0.15, // hold before confirming a flip to CLOSED
});

export class LipStateSmoother {
  /** @param {Partial<typeof DEFAULT_SMOOTHING>} [config] */
  constructor(config = {}) {
    this.config = { ...DEFAULT_SMOOTHING, ...config };
    if (this.config.closeThreshold > this.config.openThreshold) {
      throw new Error("closeThreshold must be <= openThreshold (hysteresis)");
    }
    this._state = LipState.UNKNOWN;
    this._stateSince = 0.0;
    this._pending = null;
    this._pendingSince = 0.0;
  }

  get state() {
    return this._state;
  }

  timeInState(now) {
    if (this._state === LipState.UNKNOWN) return 0.0;
    return Math.max(0.0, now - this._stateSince);
  }

  reset() {
    this._state = LipState.UNKNOWN;
    this._stateSince = 0.0;
    this._pending = null;
    this._pendingSince = 0.0;
  }

  /** Instantaneous target state given hysteresis around the current state. */
  _desired(mar) {
    const cfg = this.config;
    if (this._state === LipState.OPEN) {
      return mar <= cfg.closeThreshold ? LipState.CLOSED : LipState.OPEN;
    }
    if (this._state === LipState.CLOSED) {
      return mar >= cfg.openThreshold ? LipState.OPEN : LipState.CLOSED;
    }
    // Bootstrap from UNKNOWN: single-threshold split.
    return mar >= cfg.openThreshold ? LipState.OPEN : LipState.CLOSED;
  }

  _minHold(target) {
    return target === LipState.OPEN
      ? this.config.minOpenSeconds
      : this.config.minClosedSeconds;
  }

  /**
   * Advance the state machine.
   * `mar` is null when the frame had no usable face; the last confirmed state is
   * held and any pending flip is cancelled.
   * @returns {{state: string, change: ?import('./types.js').StateChange}}
   */
  update(timestamp, mar) {
    if (mar === null || mar === undefined) {
      this._pending = null;
      return { state: this._state, change: null };
    }

    const desired = this._desired(mar);

    // First usable reading: establish a baseline immediately and emit a change
    // from UNKNOWN so the session gets an initial snapshot.
    if (this._state === LipState.UNKNOWN) {
      this._state = desired;
      this._stateSince = timestamp;
      this._pending = null;
      return {
        state: this._state,
        change: {
          timestamp,
          frameIndex: -1,
          fromState: LipState.UNKNOWN,
          toState: desired,
          prevDuration: 0.0,
        },
      };
    }

    if (desired === this._state) {
      this._pending = null;
      return { state: this._state, change: null };
    }

    // Candidate differs from the confirmed state — start / continue the hold.
    if (this._pending !== desired) {
      this._pending = desired;
      this._pendingSince = timestamp;
    }

    if (timestamp - this._pendingSince >= this._minHold(desired)) {
      const prevDuration = Math.max(0.0, this._pendingSince - this._stateSince);
      const change = {
        timestamp,
        frameIndex: -1,
        fromState: this._state,
        toState: desired,
        prevDuration,
      };
      this._state = desired;
      // Attribute the new state's start to when the candidate first appeared,
      // so successive durations tile the timeline exactly.
      this._stateSince = this._pendingSince;
      this._pending = null;
      return { state: this._state, change };
    }

    return { state: this._state, change: null };
  }
}
