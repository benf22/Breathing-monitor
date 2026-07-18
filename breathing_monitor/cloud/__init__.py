"""Centralized metadata store for the PWA.

The mobile/web client does all detection on-device and posts only lightweight
metadata (confirmed open<->closed changes + periodic stats rollups) here, so
sessions across many days aggregate into one place. This package has NO camera /
MediaPipe / OpenCV dependency — just FastAPI + stdlib sqlite3.
"""
