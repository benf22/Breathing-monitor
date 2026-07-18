// Standalone checks for the ported pure-logic core. Run with: node web/tests/core.test.mjs
// No dependencies — mirrors the Python unit tests' intent (MAR + smoothing).

import assert from "node:assert/strict";
import { mouthAspectRatio, lipMetrics, lipLandmarkIndices } from "../js/core/lips.js";
import { LipStateSmoother } from "../js/core/smoothing.js";
import { StatsAccumulator } from "../js/core/stats.js";
import { LipState } from "../js/core/types.js";

// --- lips: build a landmark array where only the indices we read matter. ---
function landmarksWithOpening(vertical, width = 0.2) {
  const pts = Array.from({ length: 478 }, () => [0, 0, 0]);
  // horizontal corners 78 / 308 at y=0.5, separated by `width`
  pts[78] = [0.4, 0.5, 0];
  pts[308] = [0.4 + width, 0.5, 0];
  // three vertical pairs, each separated by `vertical`
  for (const [u, l] of [[13, 14], [81, 178], [311, 402]]) {
    pts[u] = [0.5, 0.5 - vertical / 2, 0];
    pts[l] = [0.5, 0.5 + vertical / 2, 0];
  }
  return pts;
}

// aspectRatio 1.0: mar = vertical / width
let { mar } = mouthAspectRatio(landmarksWithOpening(0.05, 0.2), 1.0);
assert.ok(Math.abs(mar - 0.25) < 1e-9, `mar=${mar}`);

// closed mouth -> low mar -> not open
let m = lipMetrics(landmarksWithOpening(0.02, 0.2), 0.35, 1.0);
assert.equal(m.isOpen, false);
// wide opening -> open
m = lipMetrics(landmarksWithOpening(0.10, 0.2), 0.35, 1.0);
assert.equal(m.isOpen, true);

// too-short list raises
assert.throws(() => mouthAspectRatio([[0, 0, 0]], 1.0));
assert.deepEqual(lipLandmarkIndices(), [13, 14, 78, 81, 178, 308, 311, 402]);

// --- smoothing: hysteresis + minimum duration ---
const sm = new LipStateSmoother({
  openThreshold: 0.35,
  closeThreshold: 0.28,
  minOpenSeconds: 0.15,
  minClosedSeconds: 0.15,
});

// First reading bootstraps immediately (change from UNKNOWN).
let r = sm.update(0.0, 0.20);
assert.equal(r.state, LipState.CLOSED);
assert.ok(r.change && r.change.fromState === LipState.UNKNOWN);

// A single high frame within min-duration must NOT flip yet.
r = sm.update(0.05, 0.40);
assert.equal(r.state, LipState.CLOSED, "flip should not confirm before min hold");
assert.equal(r.change, null);

// Held past min_open_seconds -> confirm OPEN.
r = sm.update(0.25, 0.40);
assert.equal(r.state, LipState.OPEN);
assert.ok(r.change && r.change.toState === LipState.OPEN);

// Hysteresis: a value between close(0.28) and open(0.35) keeps it OPEN.
r = sm.update(0.30, 0.31);
assert.equal(r.state, LipState.OPEN, "hysteresis should hold OPEN");

// Drop below close threshold, held -> CLOSED.
sm.update(0.35, 0.20);
r = sm.update(0.55, 0.20);
assert.equal(r.state, LipState.CLOSED);

// face-loss (mar=null) cancels pending flip and holds state.
sm.update(0.60, 0.40); // start pending open
r = sm.update(0.62, null);
assert.equal(r.state, LipState.CLOSED);

// --- stats ---
const acc = new StatsAccumulator();
acc.recordFrame(true);
acc.recordFrame(false);
acc.recordChange({ timestamp: 1, frameIndex: -1, fromState: LipState.CLOSED, toState: LipState.OPEN, prevDuration: 4 });
acc.recordChange({ timestamp: 2, frameIndex: -1, fromState: LipState.OPEN, toState: LipState.CLOSED, prevDuration: 6 });
const d = acc.asDict(LipState.CLOSED, 1.0);
assert.equal(d.totalChanges, 2);
assert.equal(d.totalOpenSeconds, 6);
assert.equal(d.totalClosedSeconds, 4);
assert.equal(d.maxClosedSeconds, 4, "longest closed span");
assert.equal(d.maxOpenSeconds, 6, "longest open span");
assert.equal(d.openPercentage, 60);
assert.equal(d.framesProcessed, 2);
assert.equal(d.framesWithFace, 1);

// --- nostril ratio (NAR) ---
const { nostrilMetrics, nostrilLandmarkIndices } = await import("../js/core/nostrils.js");
function noseLandmarks(width, length) {
  const pts = Array.from({ length: 478 }, () => [0, 0, 0]);
  pts[129] = [0.5 - width / 2, 0.5, 0]; // left ala
  pts[358] = [0.5 + width / 2, 0.5, 0]; // right ala
  pts[168] = [0.5, 0.5 - length / 2, 0]; // nasion
  pts[2] = [0.5, 0.5 + length / 2, 0]; // subnasale
  return pts;
}
let nm = nostrilMetrics(noseLandmarks(0.2, 0.4), 1.0);
assert.ok(Math.abs(nm.nar - 0.5) < 1e-9, `nar=${nm.nar}`);
assert.ok(Math.abs(nm.width - 0.2) < 1e-9 && Math.abs(nm.length - 0.4) < 1e-9);
// wider nostrils (flare) -> higher NAR
assert.ok(nostrilMetrics(noseLandmarks(0.24, 0.4), 1.0).nar > nm.nar);
assert.throws(() => nostrilMetrics([[0, 0, 0]], 1.0));
assert.deepEqual(nostrilLandmarkIndices(), [2, 129, 168, 358]);

// --- pipeline live threshold update ---
const { Pipeline } = await import("../js/pipeline/pipeline.js");
const fakeSensor = { start() {}, stop() {}, get videoElement() { return null; } };
const pl = new Pipeline(fakeSensor, {
  openThreshold: 0.35, closeThreshold: 0.28, minOpenSeconds: 0.15, minClosedSeconds: 0.15,
});
pl.updateDetection({ openThreshold: 0.5, closeThreshold: 0.4 });
assert.equal(pl.detection.openThreshold, 0.5);
assert.equal(pl.smoother.config.openThreshold, 0.5);
assert.equal(pl.smoother.config.closeThreshold, 0.4);
// hysteresis invariant is preserved when close would exceed open
pl.updateDetection({ openThreshold: 0.3 });
assert.equal(pl.smoother.config.closeThreshold, 0.3, "close clamped to open");

console.log("ALL JS CORE TESTS PASSED");
