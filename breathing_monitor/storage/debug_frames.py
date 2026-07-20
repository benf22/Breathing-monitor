"""Debug image writer — components 1 + 3.

Saves only a *fraction* of processed frames (``debug_frame_ratio``) plus a
guaranteed snapshot on every confirmed state change. Keeping the sampled-frame
fraction low is what keeps disk/CPU minimal while still leaving a debuggable
trail.

Frame sampling uses a deterministic counter (every Nth frame) rather than a
random draw, so behavior is reproducible and doesn't depend on an RNG.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import numpy as np

from ..core.types import LipState


def _timestamp_tag(timestamp: float) -> str:
    # Millisecond-resolution, filesystem-safe tag derived from the frame time.
    return f"{timestamp:.3f}".replace(".", "_")


class DebugFrameWriter:
    """Writes sampled frames and state-change snapshots to disk."""

    def __init__(
        self,
        data_dir: Path,
        debug_frame_ratio: float = 0.05,
        snapshot_on_change: bool = True,
    ) -> None:
        import cv2

        self._cv2 = cv2
        self._frames_dir = Path(data_dir) / "frames"
        self._snapshots_dir = Path(data_dir) / "snapshots"
        self._frames_dir.mkdir(parents=True, exist_ok=True)
        self._snapshots_dir.mkdir(parents=True, exist_ok=True)

        self._snapshot_on_change = snapshot_on_change
        # Convert a fraction into "save 1 of every N". 0 disables sampling.
        ratio = max(0.0, min(1.0, debug_frame_ratio))
        self._sample_every = int(round(1.0 / ratio)) if ratio > 0 else 0
        self._counter = 0

    def maybe_save_frame(self, bgr_frame: np.ndarray, timestamp: float) -> Optional[Path]:
        """Save this frame if it lands on the sampling interval."""
        if self._sample_every <= 0:
            return None
        self._counter += 1
        if self._counter % self._sample_every != 0:
            return None
        path = self._frames_dir / f"frame_{_timestamp_tag(timestamp)}.jpg"
        self._cv2.imwrite(str(path), bgr_frame)
        return path

    def save_snapshot(
        self, bgr_frame: np.ndarray, timestamp: float, to_state: LipState
    ) -> Optional[Path]:
        """Always-save snapshot marking a confirmed state change (component 3)."""
        if not self._snapshot_on_change:
            return None
        name = f"change_{_timestamp_tag(timestamp)}_{to_state.value}.jpg"
        path = self._snapshots_dir / name
        self._cv2.imwrite(str(path), bgr_frame)
        return path
