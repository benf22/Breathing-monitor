"""Locate (and, on first run, download) the FaceLandmarker model file.

The same ``face_landmarker.task`` bundle is published by Google for both the
Python and Android MediaPipe Tasks APIs, so the Android port reuses this exact
file. It is ~3.7 MB and git-ignored (fetched on demand).
"""

from __future__ import annotations

import os
from pathlib import Path

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
MODEL_FILENAME = "face_landmarker.task"
DEFAULT_MODEL_DIR = Path("models")


def _download(url: str, dest: Path) -> None:
    import requests  # local import: only needed on first run

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with requests.get(url, stream=True, timeout=60) as resp:
        resp.raise_for_status()
        with open(tmp, "wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 16):
                if chunk:
                    fh.write(chunk)
    os.replace(tmp, dest)  # atomic: avoids leaving a half-written model


def ensure_model(model_dir: Path = DEFAULT_MODEL_DIR, allow_download: bool = True) -> Path:
    """Return a path to the model file, downloading it if missing.

    Set ``allow_download=False`` (or env ``BM_NO_DOWNLOAD=1``) to require a
    pre-placed file and raise instead of hitting the network.
    """
    model_path = model_dir / MODEL_FILENAME
    if model_path.exists() and model_path.stat().st_size > 0:
        return model_path

    if not allow_download or os.environ.get("BM_NO_DOWNLOAD") == "1":
        raise FileNotFoundError(
            f"Model not found at {model_path} and downloads are disabled. "
            f"Download it manually from {MODEL_URL} and place it there."
        )

    _download(MODEL_URL, model_path)
    return model_path
