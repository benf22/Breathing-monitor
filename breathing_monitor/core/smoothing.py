"""High-level temporal algorithm — component 4.

Turns the noisy per-frame open/closed decision into a stable reported state
using two mechanisms:

* **Hysteresis** — separate open/close MAR thresholds. Once OPEN, the mouth
  must drop below the (lower) close threshold to flip back, and vice-versa.
  This kills chatter when the MAR hovers around a single threshold.
* **Minimum duration** — a candidate flip must persist for a configured number
  of seconds before it is *confirmed*. Brief flickers (a single noisy frame,
  a swallow) never reach the reported state.

Pure and deterministic: feed it ``(timestamp, mar)`` and it returns the
smoothed :class:`LipState` plus a :class:`StateChange` on confirmed flips.
Unit-tested with synthetic sequences (no webcam).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

from .types import LipState, StateChange


@dataclass
class SmoothingConfig:
    """Tunable parameters for :class:`LipStateSmoother`."""

    open_threshold: float = 0.35   # MAR at/above which a closed mouth may open
    close_threshold: float = 0.28  # MAR at/below which an open mouth may close
    min_open_seconds: float = 0.15   # hold before confirming a flip to OPEN
    min_closed_seconds: float = 0.15  # hold before confirming a flip to CLOSED

    def __post_init__(self) -> None:
        if self.close_threshold > self.open_threshold:
            raise ValueError("close_threshold must be <= open_threshold (hysteresis)")


class LipStateSmoother:
    """Stateful debouncer converting instantaneous MAR into a stable state."""

    def __init__(self, config: Optional[SmoothingConfig] = None) -> None:
        self.config = config or SmoothingConfig()
        self._state: LipState = LipState.UNKNOWN
        self._state_since: float = 0.0
        self._pending: Optional[LipState] = None
        self._pending_since: float = 0.0

    @property
    def state(self) -> LipState:
        return self._state

    def time_in_state(self, now: float) -> float:
        if self._state is LipState.UNKNOWN:
            return 0.0
        return max(0.0, now - self._state_since)

    def reset(self) -> None:
        self._state = LipState.UNKNOWN
        self._state_since = 0.0
        self._pending = None
        self._pending_since = 0.0

    def _desired(self, mar: float) -> LipState:
        """Instantaneous target state given hysteresis around the current state."""
        cfg = self.config
        if self._state is LipState.OPEN:
            return LipState.CLOSED if mar <= cfg.close_threshold else LipState.OPEN
        if self._state is LipState.CLOSED:
            return LipState.OPEN if mar >= cfg.open_threshold else LipState.CLOSED
        # Bootstrap from UNKNOWN: single-threshold split.
        return LipState.OPEN if mar >= cfg.open_threshold else LipState.CLOSED

    def _min_hold(self, target: LipState) -> float:
        return (
            self.config.min_open_seconds
            if target is LipState.OPEN
            else self.config.min_closed_seconds
        )

    def update(
        self, timestamp: float, mar: Optional[float]
    ) -> Tuple[LipState, Optional[StateChange]]:
        """Advance the state machine.

        ``mar`` is ``None`` when the frame had no usable face; the last
        confirmed state is held and any pending flip is cancelled (so a flip
        can't be confirmed across a face-loss gap).
        """
        if mar is None:
            self._pending = None
            return self._state, None

        desired = self._desired(mar)

        # First usable reading: establish a baseline state immediately and
        # emit a change from UNKNOWN so the session gets an initial snapshot.
        if self._state is LipState.UNKNOWN:
            self._state = desired
            self._state_since = timestamp
            self._pending = None
            change = StateChange(
                timestamp=timestamp,
                frame_index=-1,
                from_state=LipState.UNKNOWN,
                to_state=desired,
                prev_duration=0.0,
            )
            return self._state, change

        if desired == self._state:
            self._pending = None
            return self._state, None

        # Candidate differs from the confirmed state — start / continue the hold.
        if self._pending != desired:
            self._pending = desired
            self._pending_since = timestamp

        if timestamp - self._pending_since >= self._min_hold(desired):
            prev_duration = max(0.0, self._pending_since - self._state_since)
            change = StateChange(
                timestamp=timestamp,
                frame_index=-1,
                from_state=self._state,
                to_state=desired,
                prev_duration=prev_duration,
            )
            self._state = desired
            # Attribute the new state's start to when the candidate first
            # appeared, so successive durations tile the timeline exactly.
            self._state_since = self._pending_since
            self._pending = None
            return self._state, change

        return self._state, None
