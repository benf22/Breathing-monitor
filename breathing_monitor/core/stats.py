"""Over-time lip-activity aggregation — component 3 (logic half).

Consumes confirmed :class:`StateChange` events and per-frame outcomes to keep a
rolling :class:`StatsSummary`. Pure and cheap: no IO, bounded memory (only the
last N changes are retained for display).
"""

from __future__ import annotations

from typing import Optional

from .types import LipState, StateChange, StatsSummary

_RECENT_LIMIT = 50


class StatsAccumulator:
    """Maintains a :class:`StatsSummary` as frames and changes stream in."""

    def __init__(self, recent_limit: int = _RECENT_LIMIT) -> None:
        self._recent_limit = recent_limit
        self._summary = StatsSummary()

    @property
    def summary(self) -> StatsSummary:
        return self._summary

    def record_frame(self, has_face: bool) -> None:
        self._summary.frames_processed += 1
        if has_face:
            self._summary.frames_with_face += 1

    def record_change(self, change: StateChange) -> None:
        s = self._summary
        s.total_changes += 1

        # Attribute the just-ended state's duration to the correct bucket.
        if change.from_state is LipState.OPEN:
            s.total_open_seconds += change.prev_duration
        elif change.from_state is LipState.CLOSED:
            s.total_closed_seconds += change.prev_duration

        if change.to_state is LipState.OPEN:
            s.open_count += 1
        elif change.to_state is LipState.CLOSED:
            s.closed_count += 1

        s.recent_changes.append(change)
        if len(s.recent_changes) > self._recent_limit:
            del s.recent_changes[: len(s.recent_changes) - self._recent_limit]

    def as_dict(self, current_state: LipState, time_in_state: float) -> dict:
        """Serializable view for the API / dashboard."""
        s = self._summary
        face_rate = (
            s.frames_with_face / s.frames_processed if s.frames_processed else 0.0
        )
        return {
            "current_state": current_state.value,
            "time_in_state_seconds": round(time_in_state, 2),
            "total_changes": s.total_changes,
            "open_events": s.open_count,
            "closed_events": s.closed_count,
            "total_open_seconds": round(s.total_open_seconds, 2),
            "total_closed_seconds": round(s.total_closed_seconds, 2),
            "frames_processed": s.frames_processed,
            "frames_with_face": s.frames_with_face,
            "face_detection_rate": round(face_rate, 3),
            "recent_changes": [
                {
                    "timestamp": c.timestamp,
                    "from": c.from_state.value,
                    "to": c.to_state.value,
                    "prev_duration_seconds": round(c.prev_duration, 2),
                }
                for c in reversed(s.recent_changes)
            ],
        }
