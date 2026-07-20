"""MediaPipe FaceLandmarker wrapper — components 2a + 2b.

Runs the pre-trained ``face_landmarker.task`` model on a single RGB frame,
selects the **largest** face, applies the confidence/size gate, and returns a
plain :class:`FaceDetection` (or ``None`` when the frame should be ignored).

Confidence gating note: the MediaPipe Tasks FaceLandmarker does not surface a
per-face score in its Python result; instead it drops faces below
``min_face_detection_confidence`` / ``min_face_presence_confidence`` internally.
We pass the user's threshold through to those options (so "ignore low-confidence
faces" is honored at the model level) and additionally gate on bounding-box
area here. The reported ``confidence`` field is therefore a pass/near-1.0
sentinel — the meaningful gate is the threshold + the area check.
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional

import numpy as np

from ..core.types import BoundingBox, FaceDetection, Point
from .model import ensure_model


class FaceLandmarkerEngine:
    """Thin, reusable wrapper around MediaPipe's FaceLandmarker (IMAGE mode)."""

    def __init__(
        self,
        min_face_confidence: float = 0.5,
        min_face_area_ratio: float = 0.02,
        model_path: Optional[Path] = None,
        allow_download: bool = True,
    ) -> None:
        # Imported lazily so the pure-core tests never need mediapipe installed.
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision

        self._mp = mp
        self.min_face_area_ratio = min_face_area_ratio

        path = model_path or ensure_model(allow_download=allow_download)
        base_options = mp_python.BaseOptions(model_asset_path=str(path))
        options = mp_vision.FaceLandmarkerOptions(
            base_options=base_options,
            running_mode=mp_vision.RunningMode.IMAGE,
            num_faces=3,  # detect a few, then we pick the largest
            min_face_detection_confidence=min_face_confidence,
            min_face_presence_confidence=min_face_confidence,
            output_face_blendshapes=False,
            output_facial_transformation_matrixes=False,
        )
        self._landmarker = mp_vision.FaceLandmarker.create_from_options(options)

    def detect(self, rgb_image: np.ndarray) -> Optional[FaceDetection]:
        """Return the gated largest face for an RGB uint8 image, or ``None``."""
        mp_image = self._mp.Image(
            image_format=self._mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb_image)
        )
        result = self._landmarker.detect(mp_image)
        faces = getattr(result, "face_landmarks", None)
        if not faces:
            return None  # no face passed the model's confidence gate (2a)

        best_points: Optional[List[Point]] = None
        best_bbox: Optional[BoundingBox] = None
        best_area = -1.0
        for landmarks in faces:
            points: List[Point] = [(lm.x, lm.y, lm.z) for lm in landmarks]
            bbox = _bbox_from_points(points)
            if bbox.area > best_area:
                best_area = bbox.area
                best_points = points
                best_bbox = bbox

        assert best_points is not None and best_bbox is not None
        # Size gate: ignore faces whose box is too small a fraction of frame (2a).
        if best_bbox.area < self.min_face_area_ratio:
            return None

        return FaceDetection(bbox=best_bbox, landmarks=best_points, confidence=1.0)

    def close(self) -> None:
        try:
            self._landmarker.close()
        except Exception:
            pass


def _bbox_from_points(points: List[Point]) -> BoundingBox:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    return BoundingBox(x=x0, y=y0, width=x1 - x0, height=y1 - y0)
