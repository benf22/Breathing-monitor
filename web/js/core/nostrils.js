// Nostril / nose ratio (NAR) — experimental nose-breathing signal.
//
// Same idea as the Mouth Aspect Ratio, applied to the nose: measure the
// nostril-flare width and normalize by the (breathing-invariant) nose length so
// the value is scale/distance independent.
//
//   NAR = nostril width (ala-to-ala) / nose length (nasion-to-subnasale)
//
// Nasal inhalation flares the nostrils slightly, nudging the width up. The
// movement is small and noisy, so treat NAR as exploratory: the Calibrate tab
// shows it on an auto-scaled bar so you can see whether it oscillates with your
// breath. Pure math on normalized landmarks, like lips.js — ports as-is.

/** @typedef {import('./types.js').Point} Point */

// Outer alar points (the widest part of each nostril wing).
const LEFT_ALA = 129;
const RIGHT_ALA = 358;
// Nose length reference: nasion (bridge top, between eyes) to subnasale (base).
const NASION = 168;
const SUBNASALE = 2;

const MAX_INDEX = Math.max(LEFT_ALA, RIGHT_ALA, NASION, SUBNASALE);

function dist(a, b, aspectRatio) {
  const dx = (a[0] - b[0]) * aspectRatio;
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy);
}

/**
 * Return {nar, width, length} for the given landmarks.
 * @param {Point[]} landmarks
 * @param {number} [aspectRatio=1.0]  imageWidth / imageHeight
 */
export function nostrilMetrics(landmarks, aspectRatio = 1.0) {
  if (landmarks.length <= MAX_INDEX) {
    throw new Error(`expected at least ${MAX_INDEX + 1} landmarks, got ${landmarks.length}`);
  }
  const width = dist(landmarks[LEFT_ALA], landmarks[RIGHT_ALA], aspectRatio);
  const length = dist(landmarks[NASION], landmarks[SUBNASALE], aspectRatio);
  const nar = length > 1e-6 ? width / length : 0.0;
  return { nar, width, length };
}

/** Indices this module reads — for debug overlays. */
export function nostrilLandmarkIndices() {
  return [SUBNASALE, LEFT_ALA, NASION, RIGHT_ALA].sort((a, b) => a - b);
}
