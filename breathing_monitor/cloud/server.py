"""FastAPI app for the centralized metadata store.

Responsibilities:
  * Serve the PWA (the ``web/`` directory) so the phone loads it same-origin.
  * ``POST /api/ingest``      — receive batched metadata from the client.
  * ``GET  /api/stats/daily`` — cross-day aggregates for the Statistics tab.
  * ``GET  /api/stats/sessions`` — recent sessions.
  * ``GET  /api/health``      — liveness.

CORS is permissive so you can also host the PWA elsewhere and point it here via
the "API base URL" setting in Config. No detection code lives here.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .db import Store

# Repo layout: this file is breathing_monitor/cloud/server.py; the PWA lives in
# <repo>/web.
_WEB_DIR = Path(__file__).resolve().parents[2] / "web"


class Event(BaseModel):
    kind: str
    ts: Optional[float] = None
    # change fields
    from_state: Optional[str] = None
    to_state: Optional[str] = None
    prev_duration: Optional[float] = None
    # rollup fields
    current_state: Optional[str] = None
    total_open_seconds: Optional[float] = None
    total_closed_seconds: Optional[float] = None
    open_percentage: Optional[float] = None
    total_changes: Optional[int] = None
    frames_processed: Optional[int] = None
    frames_with_face: Optional[int] = None

    model_config = {"extra": "ignore"}


class IngestRequest(BaseModel):
    session_id: str
    client_id: str = "unknown"
    user_agent: str = ""
    events: List[Event] = Field(default_factory=list)


def create_app(db_path: Path) -> FastAPI:
    store = Store(db_path)
    app = FastAPI(title="Breathing Monitor — Central Store")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> Dict[str, Any]:
        return {"ok": True}

    @app.post("/api/ingest")
    def ingest(req: IngestRequest) -> Dict[str, Any]:
        counts = store.ingest(
            session_id=req.session_id,
            client_id=req.client_id,
            user_agent=req.user_agent,
            events=[e.model_dump() for e in req.events],
        )
        return {"ok": True, **counts}

    @app.get("/api/stats/daily")
    def stats_daily(days: int = 30, client_id: Optional[str] = None) -> Dict[str, Any]:
        days = max(1, min(days, 365))
        return store.daily(days=days, client_id=client_id)

    @app.get("/api/stats/sessions")
    def stats_sessions(limit: int = 50, client_id: Optional[str] = None) -> Dict[str, Any]:
        return {"sessions": store.sessions(limit=max(1, min(limit, 500)), client_id=client_id)}

    # Serve the PWA last so /api/* wins. html=True makes "/" return index.html.
    if _WEB_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(_WEB_DIR), html=True), name="web")
    else:  # pragma: no cover - only if run from an unexpected layout
        @app.get("/")
        def _missing() -> JSONResponse:
            return JSONResponse(
                {"error": f"web/ not found at {_WEB_DIR}"}, status_code=500
            )

    app.state.store = store
    return app
