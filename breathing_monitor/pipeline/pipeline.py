"""Background pipeline controller — ties components 1-4 + storage together.

A single worker thread samples one frame every ``interval_seconds``, runs it
through detection -> lips -> smoothing, updates stats, persists metadata, and
publishes the latest annotated preview + status for the web app to read.

Design goals: minimal, steady memory (each frame processed then dropped; only
metadata appended to disk), and graceful degradation (a bad frame or transient
detection error is logged and skipped, never crashes the loop).
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

from ..config.settings import Settings
from ..core.lips import lip_metrics
from ..core.smoothing import LipStateSmoother, SmoothingConfig
from ..core.stats import StatsAccumulator
from ..core.types import FrameResult, LipState
from ..storage.debug_frames import DebugFrameWriter
from ..storage.events import MetadataWriter
from .overlay import draw_overlay

log = logging.getLogger("breathing_monitor.pipeline")


@dataclass
class _Latest:
    """Thread-shared snapshot of the most recent result + preview JPEG."""

    result: Optional[FrameResult] = None
    preview_jpeg: Optional[bytes] = None
    error: Optional[str] = None
    running: bool = False


class PipelineController:
    """Owns the worker thread and the shared latest-state."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._latest = _Latest()
        self._frame_index = 0
        self._stats: Optional[StatsAccumulator] = None
        self._smoother: Optional[LipStateSmoother] = None

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="bm-pipeline", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5.0)
        self._thread = None

    def restart(self) -> None:
        """Apply changed settings (camera/model/thresholds) by cycling the loop."""
        self.stop()
        self.start()

    # -- readers for the web app ------------------------------------------

    def get_status(self) -> dict:
        with self._lock:
            latest = self._latest
            result = latest.result
            running = latest.running
            error = latest.error
        return {
            "running": running,
            "error": error,
            "state": (result.state.value if result else LipState.UNKNOWN.value),
            "raw_state": (result.raw_state.value if result else LipState.UNKNOWN.value),
            "mar": (result.lips.mar if result and result.lips else None),
            "has_face": bool(result and result.face is not None),
            "confidence": (result.face.confidence if result and result.face else None),
            "frame_index": (result.frame_index if result else 0),
        }

    def get_preview_jpeg(self) -> Optional[bytes]:
        with self._lock:
            return self._latest.preview_jpeg

    def get_stats(self) -> dict:
        stats = self._stats
        smoother = self._smoother
        if stats is None or smoother is None:
            return {"current_state": LipState.UNKNOWN.value, "total_changes": 0}
        return stats.as_dict(smoother.state, smoother.time_in_state(time.time()))

    # -- worker ------------------------------------------------------------

    def _run(self) -> None:
        import cv2

        from ..capture.camera import build_source
        from ..vision.face_landmarker import FaceLandmarkerEngine

        det = self.settings.detection
        cap = self.settings.capture
        data_dir = Path(self.settings.data_dir)

        source = None
        engine = None
        metadata: Optional[MetadataWriter] = None
        debug: Optional[DebugFrameWriter] = None
        try:
            source = build_source(self.settings.camera)
            engine = FaceLandmarkerEngine(
                min_face_confidence=det.min_face_confidence,
                min_face_area_ratio=det.min_face_area_ratio,
            )
            metadata = MetadataWriter(data_dir)
            debug = DebugFrameWriter(
                data_dir,
                debug_frame_ratio=cap.debug_frame_ratio,
                snapshot_on_change=cap.snapshot_on_change,
            )
            smoother = LipStateSmoother(
                SmoothingConfig(
                    open_threshold=det.open_threshold,
                    close_threshold=det.close_threshold,
                    min_open_seconds=det.min_open_seconds,
                    min_closed_seconds=det.min_closed_seconds,
                )
            )
            stats = StatsAccumulator()
            self._smoother = smoother
            self._stats = stats

            with self._lock:
                self._latest.running = True
                self._latest.error = None

            while not self._stop.is_set():
                loop_start = time.time()
                frame = source.read()
                if frame is None:
                    time.sleep(cap.interval_seconds)
                    continue

                result = self._process_frame(frame, engine, det, smoother, stats)

                # Persist metadata (component 2d) + sampled/snapshot frames.
                metadata.write_frame(result)
                debug.maybe_save_frame(frame, result.timestamp)
                if result.state_change is not None:
                    metadata.write_change(result.state_change)
                    debug.save_snapshot(frame, result.timestamp, result.state)

                self._publish(cv2, frame, result)

                # Sleep the remainder of the interval (component 1: low CPU).
                elapsed = time.time() - loop_start
                remaining = cap.interval_seconds - elapsed
                if remaining > 0:
                    self._stop.wait(remaining)
        except Exception as exc:  # noqa: BLE001 - surface any startup/loop failure
            log.exception("pipeline stopped on error")
            with self._lock:
                self._latest.error = str(exc)
        finally:
            with self._lock:
                self._latest.running = False
            for closer in (engine, metadata, source):
                try:
                    if closer and hasattr(closer, "close"):
                        closer.close()
                    elif closer and hasattr(closer, "release"):
                        closer.release()
                except Exception:
                    pass

    def _process_frame(self, frame, engine, det, smoother, stats) -> FrameResult:
        import cv2

        timestamp = time.time()
        self._frame_index += 1
        idx = self._frame_index

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        aspect_ratio = frame.shape[1] / frame.shape[0] if frame.shape[0] else 1.0

        face = None
        lips = None
        raw_state = LipState.UNKNOWN
        mar_for_smoother = None
        try:
            face = engine.detect(rgb)
        except Exception:
            log.exception("detection error on frame %d", idx)

        if face is not None:
            lips = lip_metrics(face.landmarks, det.open_threshold, aspect_ratio)
            raw_state = LipState.OPEN if lips.is_open else LipState.CLOSED
            mar_for_smoother = lips.mar

        state, change = smoother.update(timestamp, mar_for_smoother)
        if change is not None:
            change = _stamp_change(change, idx)

        stats.record_frame(has_face=face is not None)
        if change is not None:
            stats.record_change(change)

        return FrameResult(
            timestamp=timestamp,
            frame_index=idx,
            face=face,
            lips=lips,
            raw_state=raw_state,
            state=state,
            state_change=change,
        )

    def _publish(self, cv2, frame, result: FrameResult) -> None:
        preview_jpeg = None
        if self.settings.server.enable_preview:
            annotated = draw_overlay(frame.copy(), result)
            ok, buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 70])
            if ok:
                preview_jpeg = buf.tobytes()
        with self._lock:
            self._latest.result = result
            if preview_jpeg is not None:
                self._latest.preview_jpeg = preview_jpeg


def _stamp_change(change, frame_index: int):
    """Fill the frame_index the smoother couldn't know (it's stateless of it)."""
    from ..core.types import StateChange

    return StateChange(
        timestamp=change.timestamp,
        frame_index=frame_index,
        from_state=change.from_state,
        to_state=change.to_state,
        prev_duration=change.prev_duration,
    )
