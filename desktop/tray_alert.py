#!/usr/bin/env python3
"""Breathing Monitor — desktop tray alert (Windows/macOS/Linux).

Subscribes to your ntfy topic and turns the **tray/menu-bar icon RED** on an
alert, back to green after a hold time. No popups. This is the only reliable way
to get a color-changing taskbar icon — a browser/PWA can't recolor its icon.

Usage:
    pip install -r requirements.txt
    python tray_alert.py <your-topic>
    python tray_alert.py <your-topic> --hold 60 --server https://ntfy.sh

Right-click the tray icon to Clear or Quit.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time

import requests
from PIL import Image, ImageDraw
import pystray

GREEN = (57, 217, 138, 255)
RED = (255, 92, 122, 255)


def make_icon(color: tuple[int, int, int, int]) -> Image.Image:
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((6, 6, 58, 58), fill=color)
    return img


class Tray:
    def __init__(self, topic: str, server: str, hold: float) -> None:
        self.topic = topic
        self.server = server.rstrip("/")
        self.hold = hold
        self._last_alert = 0.0
        self.icon = pystray.Icon(
            "breathing-alerts",
            make_icon(GREEN),
            "Breathing Alerts — waiting",
            menu=pystray.Menu(
                pystray.MenuItem("Clear", self._clear),
                pystray.MenuItem("Quit", self._quit),
            ),
        )

    # -- icon state --------------------------------------------------------
    def _set(self, color, title):
        self.icon.icon = make_icon(color)
        self.icon.title = title

    def _clear(self, *_):
        self._last_alert = 0.0
        self._set(GREEN, "Breathing Alerts — waiting")

    def _alert(self, msg: str):
        self._last_alert = time.time()
        self._set(RED, f"ALERT: {msg}")

    def _quit(self, *_):
        self.icon.stop()
        sys.exit(0)

    # -- background loops --------------------------------------------------
    def _listen(self):
        url = f"{self.server}/{self.topic}/json"
        while True:
            try:
                with requests.get(url, stream=True, timeout=(10, None)) as r:
                    r.raise_for_status()
                    for line in r.iter_lines(decode_unicode=True):
                        if not line:
                            continue
                        try:
                            d = json.loads(line)
                        except ValueError:
                            continue
                        if d.get("event") == "message":
                            self._alert(d.get("message", "alert"))
            except Exception:
                time.sleep(3)  # reconnect after a network hiccup

    def _hold_loop(self):
        while True:
            time.sleep(1)
            if self._last_alert and time.time() - self._last_alert > self.hold:
                self._clear()

    def run(self):
        threading.Thread(target=self._listen, daemon=True).start()
        threading.Thread(target=self._hold_loop, daemon=True).start()
        self.icon.run()


def main() -> None:
    p = argparse.ArgumentParser(description="Breathing Monitor tray alert")
    p.add_argument("topic", help="ntfy topic (must match the phone's Config)")
    p.add_argument("--server", default="https://ntfy.sh", help="ntfy server base URL")
    p.add_argument("--hold", type=float, default=60, help="seconds the icon stays red after an alert")
    args = p.parse_args()
    Tray(args.topic, args.server, args.hold).run()


if __name__ == "__main__":
    main()
