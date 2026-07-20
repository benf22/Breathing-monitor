"""Debug overlay drawing for the live preview (BGR frames).

Kept separate from the algorithm so the core stays image-library-free. Only the
preview and saved debug frames are annotated; metadata is unaffected.
"""

from __future__ import annotations

from typing import Optional

import numpy as np

from ..core.lips import lip_landmark_indices
from ..core.types import FrameResult, LipState

_STATE_COLORS = {
    LipState.OPEN: (0, 200, 0),       # green (BGR)
    LipState.CLOSED: (0, 165, 255),   # orange
    LipState.UNKNOWN: (0, 0, 255),    # red
}
_LIP_INDICES = set(lip_landmark_indices())


def draw_overlay(frame: np.ndarray, result: FrameResult) -> np.ndarray:
    """Annotate ``frame`` in place with face box, lip points, and status text."""
    import cv2

    h, w = frame.shape[:2]
    color = _STATE_COLORS.get(result.state, (200, 200, 200))

    if result.face is not None:
        b = result.face.bbox
        x0, y0 = int(b.x * w), int(b.y * h)
        x1, y1 = int((b.x + b.width) * w), int((b.y + b.height) * h)
        cv2.rectangle(frame, (x0, y0), (x1, y1), color, 2)

        for i, p in enumerate(result.face.landmarks):
            if i in _LIP_INDICES:
                px, py = int(p[0] * w), int(p[1] * h)
                cv2.circle(frame, (px, py), 2, (255, 255, 0), -1)

    mar_text = f"MAR={result.lips.mar:.3f}" if result.lips else "MAR=--"
    label = f"{result.state.value.upper()}  {mar_text}"
    cv2.rectangle(frame, (0, 0), (w, 34), (0, 0, 0), -1)
    cv2.putText(
        frame, label, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2, cv2.LINE_AA
    )
    return frame
