"""Application settings — load/save + defaults (component 5).

Defaults live in code (:class:`Settings`); user overrides are persisted to a
JSON file (``settings.local.json`` by default, git-ignored). The settings
screen reads/writes this. Grouping the tunables here keeps the thresholds,
camera source, and debug ratios out of the algorithm code.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any, Dict, Optional

DEFAULT_SETTINGS_PATH = Path("settings.local.json")


@dataclass
class CameraSettings:
    # ``source`` is a webcam index (int, e.g. 0) or a path/URL (str). It may
    # also be a directory/image path when ``mode`` is "offline".
    source: Any = 0
    mode: str = "camera"        # "camera" | "offline"
    backend: str = "auto"       # "auto" | "dshow" | "msmf" | "v4l2" | "any"
    frame_width: int = 640
    frame_height: int = 480


@dataclass
class DetectionSettings:
    # Face gating (component 2a).
    min_face_confidence: float = 0.5
    min_face_area_ratio: float = 0.02  # min face-box area as fraction of frame
    # Lip open/closed thresholds (components 2c + 4 hysteresis).
    open_threshold: float = 0.35
    close_threshold: float = 0.28
    min_open_seconds: float = 0.15
    min_closed_seconds: float = 0.15


@dataclass
class CaptureSettings:
    # Component 1: sample one frame every ``interval_seconds`` (low CPU/mem).
    interval_seconds: float = 0.2
    # Fraction of processed frames written to disk for debug (0..1).
    debug_frame_ratio: float = 0.05
    # Always save a snapshot when the smoothed state changes (component 3).
    snapshot_on_change: bool = True


@dataclass
class ServerSettings:
    host: str = "127.0.0.1"
    port: int = 8000
    enable_preview: bool = True  # MJPEG live preview in the dashboard


@dataclass
class Settings:
    camera: CameraSettings = field(default_factory=CameraSettings)
    detection: DetectionSettings = field(default_factory=DetectionSettings)
    capture: CaptureSettings = field(default_factory=CaptureSettings)
    server: ServerSettings = field(default_factory=ServerSettings)
    # Where debug frames, snapshots and metadata logs are written.
    data_dir: str = "data"

    # -- (de)serialization -------------------------------------------------

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Settings":
        """Build from a (possibly partial) dict, filling gaps with defaults."""
        groups = {
            "camera": CameraSettings,
            "detection": DetectionSettings,
            "capture": CaptureSettings,
            "server": ServerSettings,
        }
        kwargs: Dict[str, Any] = {}
        for name, klass in groups.items():
            sub = data.get(name, {}) or {}
            valid = {f.name for f in fields(klass)}
            kwargs[name] = klass(**{k: v for k, v in sub.items() if k in valid})
        if "data_dir" in data:
            kwargs["data_dir"] = data["data_dir"]
        return cls(**kwargs)

    def apply_updates(self, data: Dict[str, Any]) -> None:
        """Merge a partial nested dict of overrides into this instance."""
        for group in ("camera", "detection", "capture", "server"):
            sub = data.get(group)
            if not sub:
                continue
            target = getattr(self, group)
            valid = {f.name for f in fields(target)}
            for key, value in sub.items():
                if key in valid:
                    setattr(target, key, value)
        if "data_dir" in data:
            self.data_dir = data["data_dir"]


def load_settings(path: Optional[Path] = None) -> Settings:
    """Load settings from ``path`` (default ``settings.local.json``).

    Missing file → defaults. A corrupt file also falls back to defaults rather
    than crashing the app.
    """
    path = path or DEFAULT_SETTINGS_PATH
    if not path.exists():
        return Settings()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return Settings()
    return Settings.from_dict(data)


def save_settings(settings: Settings, path: Optional[Path] = None) -> None:
    path = path or DEFAULT_SETTINGS_PATH
    path.write_text(json.dumps(settings.to_dict(), indent=2), encoding="utf-8")
