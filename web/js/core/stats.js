// Over-time lip-activity aggregation — component 3 (logic half).
//
// JS port of `breathing_monitor/core/stats.py`. Consumes confirmed StateChange
// events and per-frame outcomes to keep a rolling summary. Pure and cheap: no
// IO, bounded memory (only the last N changes are retained for display).

import { LipState, makeStatsSummary } from "./types.js";

const RECENT_LIMIT = 50;

export class StatsAccumulator {
  constructor(recentLimit = RECENT_LIMIT) {
    this._recentLimit = recentLimit;
    this._summary = makeStatsSummary();
  }

  get summary() {
    return this._summary;
  }

  recordFrame(hasFace) {
    this._summary.framesProcessed += 1;
    if (hasFace) this._summary.framesWithFace += 1;
  }

  recordChange(change) {
    const s = this._summary;
    s.totalChanges += 1;

    // Attribute the just-ended state's duration to the correct bucket, and track
    // the longest single continuous span of each state.
    if (change.fromState === LipState.OPEN) {
      s.totalOpenSeconds += change.prevDuration;
      if (change.prevDuration > s.maxOpenSeconds) s.maxOpenSeconds = change.prevDuration;
    } else if (change.fromState === LipState.CLOSED) {
      s.totalClosedSeconds += change.prevDuration;
      if (change.prevDuration > s.maxClosedSeconds) s.maxClosedSeconds = change.prevDuration;
    }

    if (change.toState === LipState.OPEN) s.openCount += 1;
    else if (change.toState === LipState.CLOSED) s.closedCount += 1;

    s.recentChanges.push(change);
    if (s.recentChanges.length > this._recentLimit) {
      s.recentChanges.splice(0, s.recentChanges.length - this._recentLimit);
    }
  }

  /** Serializable view for the UI. Mirrors stats.py::as_dict. */
  asDict(currentState, timeInState) {
    const s = this._summary;
    const faceRate = s.framesProcessed ? s.framesWithFace / s.framesProcessed : 0.0;
    const totalKnown = s.totalOpenSeconds + s.totalClosedSeconds;
    const openPct = totalKnown > 0 ? s.totalOpenSeconds / totalKnown : 0.0;
    // Include the currently-ongoing span so a long open/closed stretch counts
    // even before it flips (and confirms a StateChange).
    let maxOpen = s.maxOpenSeconds;
    let maxClosed = s.maxClosedSeconds;
    if (currentState === LipState.OPEN) maxOpen = Math.max(maxOpen, timeInState);
    else if (currentState === LipState.CLOSED) maxClosed = Math.max(maxClosed, timeInState);
    return {
      currentState,
      timeInStateSeconds: round(timeInState, 2),
      totalChanges: s.totalChanges,
      openEvents: s.openCount,
      closedEvents: s.closedCount,
      totalOpenSeconds: round(s.totalOpenSeconds, 2),
      totalClosedSeconds: round(s.totalClosedSeconds, 2),
      maxOpenSeconds: round(maxOpen, 2),
      maxClosedSeconds: round(maxClosed, 2),
      openPercentage: round(openPct * 100, 1),
      framesProcessed: s.framesProcessed,
      framesWithFace: s.framesWithFace,
      faceDetectionRate: round(faceRate, 3),
      recentChanges: [...s.recentChanges].reverse().map((c) => ({
        timestamp: c.timestamp,
        from: c.fromState,
        to: c.toState,
        prevDurationSeconds: round(c.prevDuration, 2),
      })),
    };
  }
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
