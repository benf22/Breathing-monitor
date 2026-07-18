"""Entrypoint for the centralized metadata store + PWA host.

    python cloud_main.py                 # http://0.0.0.0:8000  (LAN-reachable)
    python cloud_main.py --port 9000
    python cloud_main.py --db data/breathing.db

Open the printed URL on your desktop, or on your phone using the desktop's LAN
IP (e.g. http://192.168.1.20:8000). The phone runs all detection locally in the
browser and posts only small metadata here so days aggregate together.

This process needs only FastAPI + uvicorn (already in requirements.txt); it does
NOT import mediapipe/opencv.
"""

from __future__ import annotations

import argparse
import logging
import socket
from pathlib import Path

import uvicorn

from breathing_monitor.cloud.server import create_app


def _lan_ip() -> str:
    """Best-effort primary LAN IP for the "open on your phone" hint."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def main() -> None:
    p = argparse.ArgumentParser(description="Breathing Monitor — central store")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--db", type=Path, default=Path("data/breathing.db"))
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
    app = create_app(args.db)

    log = logging.getLogger("breathing_monitor.cloud")
    log.info("Central store DB: %s", args.db.resolve())
    log.info("Desktop:  http://127.0.0.1:%d", args.port)
    if args.host in ("0.0.0.0", "::"):
        log.info("On your phone (same Wi-Fi):  http://%s:%d", _lan_ip(), args.port)

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
