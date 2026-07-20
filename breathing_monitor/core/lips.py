"""Mouth Aspect Ratio (MAR) and open/closed decision — component 2c.

Pure math on normalized landmarks. The MediaPipe Face Mesh landmark indices
used here are stable across the Python and Android builds of the same
``face_landmarker.task`` model, so this file ports as-is.

MAR = mean(vertical inner-lip openings) / (inner mouth width).

Normalized landmark x/y are in 0..1 relative to image width/height. Because a
non-square frame scales x and y differently, callers may pass ``aspect_ratio``
(= image_width / image_height) so the ratio is measured in a consistent unit.
The default of 1.0 is fine for tests and for a roughly square crop; the vision
layer passes the real value.
"""

from __future__ import annotations

import math
from typing import List, Sequence

from .types import LipMetrics, Point

# Inner-lip vertical pairs (upper, lower) — center + two off-center columns.
# Averaging three columns makes the opening estimate robust to small head
# rotation and single-point landmark jitter.
_VERTICAL_PAIRS = ((13, 14), (81, 178), (311, 402))

# Inner mouth corners, used as the horizontal (width) reference.
_LEFT_CORNER = 78
_RIGHT_CORNER = 308

# Highest index we touch; used to validate the landmark list up front.
_MAX_INDEX = max(
    _LEFT_CORNER,
    _RIGHT_CORNER,
    *(i for pair in _VERTICAL_PAIRS for i in pair),
)


def _dist(a: Point, b: Point, aspect_ratio: float) -> float:
    """Euclidean distance in x/y, with x scaled by ``aspect_ratio``."""
    dx = (a[0] - b[0]) * aspect_ratio
    dy = a[1] - b[1]
    return math.hypot(dx, dy)


def mouth_aspect_ratio(
    landmarks: Sequence[Point],
    aspect_ratio: float = 1.0,
) -> tuple[float, float, float]:
    """Return ``(mar, vertical, horizontal)`` for the given landmarks.

    ``vertical`` is the mean inner-lip opening, ``horizontal`` the inner mouth
    width. Raises ``ValueError`` if the landmark list is too short.
    """
    if len(landmarks) <= _MAX_INDEX:
        raise ValueError(
            f"expected at least {_MAX_INDEX + 1} landmarks, got {len(landmarks)}"
        )

    verticals = [
        _dist(landmarks[u], landmarks[l], aspect_ratio) for u, l in _VERTICAL_PAIRS
    ]
    vertical = sum(verticals) / len(verticals)
    horizontal = _dist(landmarks[_LEFT_CORNER], landmarks[_RIGHT_CORNER], aspect_ratio)

    # Guard against a degenerate (zero-width) mouth.
    mar = vertical / horizontal if horizontal > 1e-6 else 0.0
    return mar, vertical, horizontal


def lip_metrics(
    landmarks: Sequence[Point],
    open_threshold: float,
    aspect_ratio: float = 1.0,
) -> LipMetrics:
    """Compute :class:`LipMetrics`, deciding open/closed by ``open_threshold``.

    This is the *instantaneous* decision; temporal smoothing (hysteresis +
    minimum duration) happens later in :mod:`breathing_monitor.core.smoothing`.
    """
    mar, vertical, horizontal = mouth_aspect_ratio(landmarks, aspect_ratio)
    return LipMetrics(
        mar=mar,
        vertical=vertical,
        horizontal=horizontal,
        is_open=mar >= open_threshold,
    )


def lip_landmark_indices() -> List[int]:
    """Indices this module reads — handy for debug overlays in the UI."""
    idx = {_LEFT_CORNER, _RIGHT_CORNER}
    for u, l in _VERTICAL_PAIRS:
        idx.add(u)
        idx.add(l)
    return sorted(idx)
