"""Frame sources — component 1.

A frame source yields BGR frames (OpenCV convention) one at a time. Two
implementations:

* :class:`CameraSource` — live webcam via ``cv2.VideoCapture``. The pipeline
  sleeps between reads so we sample roughly one frame every ``interval_seconds``
  (low CPU/memory); each frame is processed then discarded.
* :class:`OfflineSource` — a single image or a folder of images, for
  deterministic runs and CI without a webcam.

Both expose the same ``read()`` / ``release()`` interface so the pipeline is
source-agnostic.
"""

from __future__ import annotations

import platform
from pathlib import Path
from typing import Iterator, List, Optional

import numpy as np

_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def _resolve_backend(name: str) -> int:
    """Map a backend name to an OpenCV capture-API flag."""
    import cv2

    name = (name or "auto").lower()
    if name == "auto":
        # DirectShow opens fastest/most reliably on Windows; default elsewhere.
        return cv2.CAP_DSHOW if platform.system() == "Windows" else cv2.CAP_ANY
    return {
        "dshow": cv2.CAP_DSHOW,
        "msmf": cv2.CAP_MSMF,
        "v4l2": cv2.CAP_V4L2,
        "any": cv2.CAP_ANY,
    }.get(name, cv2.CAP_ANY)


class CameraSource:
    """Live webcam frame source."""

    def __init__(
        self,
        source=0,
        backend: str = "auto",
        frame_width: int = 640,
        frame_height: int = 480,
    ) -> None:
        import cv2

        self._cv2 = cv2
        # Numeric strings ("0") are treated as device indices.
        if isinstance(source, str) and source.isdigit():
            source = int(source)

        if isinstance(source, int):
            self._cap = cv2.VideoCapture(source, _resolve_backend(backend))
        else:
            self._cap = cv2.VideoCapture(source)  # path or stream URL

        if not self._cap.isOpened():
            raise RuntimeError(f"Could not open camera source: {source!r}")

        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, frame_width)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, frame_height)
        # Keep the internal buffer tiny so we always read a fresh frame.
        try:
            self._cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass

    def read(self) -> Optional[np.ndarray]:
        ok, frame = self._cap.read()
        if not ok or frame is None:
            return None
        return frame  # BGR

    def release(self) -> None:
        try:
            self._cap.release()
        except Exception:
            pass


class OfflineSource:
    """Yields frames from a single image or a folder of images (looping)."""

    def __init__(self, path, loop: bool = True) -> None:
        import cv2

        self._cv2 = cv2
        self._loop = loop
        self._paths: List[Path] = _list_images(Path(path))
        if not self._paths:
            raise RuntimeError(f"No images found at: {path!r}")
        self._iter: Iterator[Path] = iter(self._paths)

    def read(self) -> Optional[np.ndarray]:
        try:
            p = next(self._iter)
        except StopIteration:
            if not self._loop:
                return None
            self._iter = iter(self._paths)
            p = next(self._iter)
        frame = self._cv2.imread(str(p))
        if frame is None:
            return None
        return frame  # BGR

    def release(self) -> None:
        pass


def _list_images(path: Path) -> List[Path]:
    if path.is_file():
        return [path]
    if path.is_dir():
        return sorted(p for p in path.iterdir() if p.suffix.lower() in _IMAGE_EXTS)
    return []


def build_source(camera_settings) -> "CameraSource | OfflineSource":
    """Factory: build the right source from :class:`CameraSettings`."""
    if camera_settings.mode == "offline":
        return OfflineSource(camera_settings.source)
    return CameraSource(
        source=camera_settings.source,
        backend=camera_settings.backend,
        frame_width=camera_settings.frame_width,
        frame_height=camera_settings.frame_height,
    )
