"""Breathing Monitor entrypoint.

Starts the background detection pipeline and serves the web dashboard.

    python main.py                     # use settings.local.json (or defaults)
    python main.py --offline PATH      # run against an image/folder (no webcam)
    python main.py --port 8000         # override the web port

Open http://127.0.0.1:8000 in a browser once it's running.
"""

from __future__ import annotations

import argparse
import logging
import webbrowser
from pathlib import Path

import uvicorn

from breathing_monitor.app.server import create_app
from breathing_monitor.config.settings import (
    DEFAULT_SETTINGS_PATH,
    load_settings,
    save_settings,
)
from breathing_monitor.pipeline.pipeline import PipelineController


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Breathing Monitor")
    p.add_argument("--settings", type=Path, default=DEFAULT_SETTINGS_PATH)
    p.add_argument("--offline", metavar="PATH",
                   help="run against an image file or folder instead of a webcam")
    p.add_argument("--source", help="camera index or path (overrides settings)")
    p.add_argument("--host", default=None)
    p.add_argument("--port", type=int, default=None)
    p.add_argument("--no-browser", action="store_true",
                   help="do not auto-open the dashboard in a browser")
    p.add_argument("--no-start", action="store_true",
                   help="start the web server but not the pipeline")
    return p.parse_args()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    args = parse_args()

    settings = load_settings(args.settings)
    if args.offline:
        settings.camera.mode = "offline"
        settings.camera.source = args.offline
    elif args.source is not None:
        settings.camera.source = args.source
    if args.host:
        settings.server.host = args.host
    if args.port:
        settings.server.port = args.port

    # Persist so the settings screen reflects the launched configuration.
    save_settings(settings, args.settings)

    controller = PipelineController(settings)
    if not args.no_start:
        controller.start()

    app = create_app(controller, args.settings)

    url = f"http://{settings.server.host}:{settings.server.port}"
    logging.getLogger("breathing_monitor").info("Dashboard: %s", url)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    try:
        uvicorn.run(app, host=settings.server.host, port=settings.server.port,
                    log_level="warning")
    finally:
        controller.stop()


if __name__ == "__main__":
    main()
