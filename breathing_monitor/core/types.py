"""Data contracts shared across the pipeline.

These are deliberately plain: a normalized landmark is just ``(x, y, z)`` in
0..1 image coordinates, and every stage consumes/produces one of the
dataclasses below. Keeping the contracts here (and free of numpy/opencv/
mediapipe types) is what lets each component run standalone and lets the
Android port reuse the math.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional, Tuple


# A single normalized landmark: x, y (and z) in 0..1, relative to image size.
Point = Tuple[float, float, float]


class LipState(str, Enum):
    """Reported mouth state. ``UNKNOWN`` = no usable face this frame."""

    OPEN = "open"
    CLOSED = "closed"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class BoundingBox:
    """Axis-aligned face box in normalized (0..1) image coordinates."""

    x: float
    y: float
    width: float
    height: float

    @property
    def area(self) -> float:
        return max(0.0, self.width) * max(0.0, self.height)


@dataclass(frozen=True)
class FaceDetection:
    """The selected (largest, confident-enough) face for a frame.

    ``landmarks`` holds all normalized face-mesh points; ``confidence`` is the
    model's face-presence score in 0..1.
    """

    bbox: BoundingBox
    landmarks: List[Point]
    confidence: float


@dataclass(frozen=True)
class LipMetrics:
    """Raw lip measurements derived from landmarks (component 2c).

    ``mar`` = mouth aspect ratio (vertical opening / horizontal width).
    ``is_open`` is the *instantaneous* threshold decision, before smoothing.
    """

    mar: float
    vertical: float
    horizontal: float
    is_open: bool


@dataclass
class FrameResult:
    """Everything produced for one processed frame.

    ``raw_state`` is the per-frame decision; ``state`` is the smoothed state
    from the high-level algorithm (component 4). ``face`` / ``lips`` are
    ``None`` when the frame was gated out (no/low-confidence/small face).
    """

    timestamp: float
    frame_index: int
    face: Optional[FaceDetection]
    lips: Optional[LipMetrics]
    raw_state: LipState
    state: LipState
    # Populated when the smoothed state changed on this frame (component 3).
    state_change: Optional["StateChange"] = None


@dataclass(frozen=True)
class StateChange:
    """A confirmed open<->closed transition after smoothing."""

    timestamp: float
    frame_index: int
    from_state: LipState
    to_state: LipState
    # Duration (seconds) the previous state was held before this change.
    prev_duration: float


@dataclass
class StatsSummary:
    """Rolling aggregate of lip activity over the session (component 3)."""

    total_changes: int = 0
    open_count: int = 0
    closed_count: int = 0
    total_open_seconds: float = 0.0
    total_closed_seconds: float = 0.0
    frames_processed: int = 0
    frames_with_face: int = 0
    recent_changes: List[StateChange] = field(default_factory=list)
