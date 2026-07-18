// Mouth Aspect Ratio (MAR) and open/closed decision — component 2c.
//
// JS port of `breathing_monitor/core/lips.py`. Pure math on normalized
// landmarks. The MediaPipe Face Mesh landmark indices are identical across the
// Python, Android and Web builds of the same face_landmarker.task model, so this
// ports as-is.
//
// MAR = mean(vertical inner-lip openings) / (inner mouth width).
//
// Normalized landmark x/y are in 0..1 relative to image width/height. Because a
// non-square frame scales x and y differently, callers pass `aspectRatio`
// (= imageWidth / imageHeight) so the ratio is measured in a consistent unit.

/** @typedef {import('./types.js').Point} Point */

// Inner-lip vertical pairs (upper, lower) — center + two off-center columns.
// Averaging three columns makes the opening estimate robust to small head
// rotation and single-point landmark jitter.
const VERTICAL_PAIRS = [
  [13, 14],
  [81, 178],
  [311, 402],
];

// Inner mouth corners, used as the horizontal (width) reference.
const LEFT_CORNER = 78;
const RIGHT_CORNER = 308;

// Highest index we touch; used to validate the landmark list up front.
const MAX_INDEX = Math.max(
  LEFT_CORNER,
  RIGHT_CORNER,
  ...VERTICAL_PAIRS.flat()
);

function dist(a, b, aspectRatio) {
  const dx = (a[0] - b[0]) * aspectRatio;
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy);
}

/**
 * Return {mar, vertical, horizontal} for the given landmarks.
 * @param {Point[]} landmarks
 * @param {number} [aspectRatio=1.0]
 */
export function mouthAspectRatio(landmarks, aspectRatio = 1.0) {
  if (landmarks.length <= MAX_INDEX) {
    throw new Error(
      `expected at least ${MAX_INDEX + 1} landmarks, got ${landmarks.length}`
    );
  }
  const verticals = VERTICAL_PAIRS.map(([u, l]) =>
    dist(landmarks[u], landmarks[l], aspectRatio)
  );
  const vertical = verticals.reduce((s, v) => s + v, 0) / verticals.length;
  const horizontal = dist(landmarks[LEFT_CORNER], landmarks[RIGHT_CORNER], aspectRatio);

  // Guard against a degenerate (zero-width) mouth.
  const mar = horizontal > 1e-6 ? vertical / horizontal : 0.0;
  return { mar, vertical, horizontal };
}

/**
 * Compute lip metrics, deciding open/closed by `openThreshold`.
 * This is the *instantaneous* decision; temporal smoothing happens in smoothing.js.
 * @param {Point[]} landmarks
 * @param {number} openThreshold
 * @param {number} [aspectRatio=1.0]
 */
export function lipMetrics(landmarks, openThreshold, aspectRatio = 1.0) {
  const { mar, vertical, horizontal } = mouthAspectRatio(landmarks, aspectRatio);
  return { mar, vertical, horizontal, isOpen: mar >= openThreshold };
}

/** Indices this module reads — handy for debug overlays in the UI. */
export function lipLandmarkIndices() {
  const idx = new Set([LEFT_CORNER, RIGHT_CORNER]);
  for (const [u, l] of VERTICAL_PAIRS) {
    idx.add(u);
    idx.add(l);
  }
  return [...idx].sort((a, b) => a - b);
}
