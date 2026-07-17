"""FastAPI app: dashboard, live MJPEG preview, status/stats, settings — component 5.

The web UI is intentionally minimal for this phase: an entrance/dashboard screen
showing the live OPEN/CLOSED state, MAR and preview, plus a settings form that
writes back to ``settings.local.json`` and restarts the pipeline.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    Response,
    StreamingResponse,
)

from ..config.settings import Settings, save_settings
from ..pipeline.pipeline import PipelineController

_STATIC_DIR = Path(__file__).parent / "static"


def create_app(
    controller: PipelineController, settings_path: Path
) -> FastAPI:
    app = FastAPI(title="Breathing Monitor", version="0.1.0")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(_STATIC_DIR / "index.html")

    @app.get("/api/status")
    def status() -> JSONResponse:
        payload = controller.get_status()
        payload["stats"] = controller.get_stats()
        return JSONResponse(payload)

    @app.get("/api/settings")
    def get_settings() -> JSONResponse:
        return JSONResponse(controller.settings.to_dict())

    @app.post("/api/settings")
    def update_settings(update: Dict[str, Any]) -> JSONResponse:
        controller.settings.apply_updates(update)
        save_settings(controller.settings, settings_path)
        controller.restart()
        return JSONResponse(
            {"ok": True, "settings": controller.settings.to_dict()}
        )

    @app.post("/api/control/start")
    def control_start() -> JSONResponse:
        controller.start()
        return JSONResponse({"ok": True})

    @app.post("/api/control/stop")
    def control_stop() -> JSONResponse:
        controller.stop()
        return JSONResponse({"ok": True})

    @app.get("/api/preview.jpg")
    def preview_frame() -> Response:
        jpeg = controller.get_preview_jpeg()
        if jpeg is None:
            return Response(status_code=503)
        return Response(content=jpeg, media_type="image/jpeg")

    @app.get("/api/preview.mjpeg")
    def preview_stream() -> StreamingResponse:
        boundary = "frame"

        def gen():
            while True:
                jpeg = controller.get_preview_jpeg()
                if jpeg is not None:
                    yield (
                        b"--" + boundary.encode() + b"\r\n"
                        b"Content-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
                    )
                # ~10 fps preview cap; independent of capture interval.
                time.sleep(0.1)

        return StreamingResponse(
            gen(),
            media_type=f"multipart/x-mixed-replace; boundary={boundary}",
        )

    return app
