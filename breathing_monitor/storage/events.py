"""Metadata persistence — component 2d + 3 (flat files, per user's choice).

Two append-only logs under the data directory:

* ``metadata.jsonl`` — one JSON object per processed frame with the lip
  variables and (optionally) landmarks. This is the debug metadata; the raw
  image is *not* stored here.
* ``changes.csv`` — one row per confirmed open<->closed transition, for easy
  spreadsheet inspection of the over-time analysis.

Append-only + line-buffered means bounded memory regardless of session length.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Optional

from ..core.types import FrameResult, StateChange


class MetadataWriter:
    """Appends per-frame metadata (JSONL) and state changes (CSV)."""

    def __init__(self, data_dir: Path, store_landmarks: bool = True) -> None:
        self._dir = Path(data_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._store_landmarks = store_landmarks

        self._jsonl_path = self._dir / "metadata.jsonl"
        self._csv_path = self._dir / "changes.csv"
        self._jsonl = open(self._jsonl_path, "a", encoding="utf-8", buffering=1)

        new_csv = not self._csv_path.exists() or self._csv_path.stat().st_size == 0
        self._csv_file = open(self._csv_path, "a", encoding="utf-8", newline="")
        self._csv = csv.writer(self._csv_file)
        if new_csv:
            self._csv.writerow(
                ["timestamp", "frame_index", "from_state", "to_state", "prev_duration_s"]
            )
            self._csv_file.flush()

    def write_frame(self, result: FrameResult) -> None:
        record = {
            "timestamp": result.timestamp,
            "frame_index": result.frame_index,
            "raw_state": result.raw_state.value,
            "state": result.state.value,
            "has_face": result.face is not None,
        }
        if result.face is not None:
            record["confidence"] = result.face.confidence
            record["bbox"] = {
                "x": result.face.bbox.x,
                "y": result.face.bbox.y,
                "width": result.face.bbox.width,
                "height": result.face.bbox.height,
            }
        if result.lips is not None:
            record["lips"] = {
                "mar": result.lips.mar,
                "vertical": result.lips.vertical,
                "horizontal": result.lips.horizontal,
                "is_open": result.lips.is_open,
            }
        # Landmarks are bulky; store rounded and only when requested (debug).
        if self._store_landmarks and result.face is not None:
            record["landmarks"] = [
                [round(p[0], 5), round(p[1], 5), round(p[2], 5)]
                for p in result.face.landmarks
            ]
        self._jsonl.write(json.dumps(record) + "\n")

    def write_change(self, change: StateChange) -> None:
        self._csv.writerow(
            [
                change.timestamp,
                change.frame_index,
                change.from_state.value,
                change.to_state.value,
                round(change.prev_duration, 3),
            ]
        )
        self._csv_file.flush()

    def close(self) -> None:
        for fh in (getattr(self, "_jsonl", None), getattr(self, "_csv_file", None)):
            try:
                if fh:
                    fh.close()
            except Exception:
                pass
