"""Breathing Monitor — webcam-based lip open/closed tracking.

Package layout (see README):
    core/     pure, portable logic (no camera/web/model deps) — Android-reusable
    vision/   MediaPipe FaceLandmarker wrapper + model management
    capture/  OpenCV camera / offline image source
    pipeline/ wires the components together
    storage/  flat-file (JSONL/CSV) metadata + debug frame writers
    config/   settings load/save
    app/      FastAPI dashboard + settings UI
"""

__version__ = "0.1.0"
