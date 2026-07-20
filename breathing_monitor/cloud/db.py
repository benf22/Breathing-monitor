"""SQLite persistence for the centralized metadata store.

Two event kinds arrive from the client (see web/js/storage/uploader.js):

* ``change`` — a confirmed open<->closed transition.
* ``rollup`` — a periodic cumulative snapshot of a session's stats.

Rollups are cumulative *within* a session, so a session's final contribution is
the MAX of its rollup totals. Cross-day aggregation sums those per-session finals
grouped by the session's (server-assigned) day.

Stdlib ``sqlite3`` only — no extra dependency. A single connection guarded by a
lock is plenty for this single-user, low-rate workload.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    client_id   TEXT,
    user_agent  TEXT,
    started_at  REAL,
    last_seen   REAL,
    day         TEXT
);
CREATE TABLE IF NOT EXISTS changes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT,
    ts          REAL,
    from_state  TEXT,
    to_state    TEXT,
    prev_duration REAL
);
CREATE TABLE IF NOT EXISTS rollups (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        TEXT,
    ts                REAL,
    current_state     TEXT,
    total_open_seconds   REAL,
    total_closed_seconds REAL,
    open_percentage      REAL,
    total_changes        INTEGER,
    frames_processed     INTEGER,
    frames_with_face     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_changes_session ON changes(session_id);
CREATE INDEX IF NOT EXISTS idx_rollups_session ON rollups(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day);
"""


def _day_str(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%d")


class Store:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    # -- ingest ------------------------------------------------------------

    def ingest(
        self,
        session_id: str,
        client_id: str,
        user_agent: str,
        events: List[Dict[str, Any]],
    ) -> Dict[str, int]:
        now = time.time()
        changes = rollups = 0
        with self._lock:
            cur = self._conn.cursor()
            row = cur.execute(
                "SELECT id FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if row is None:
                cur.execute(
                    "INSERT INTO sessions (id, client_id, user_agent, started_at, "
                    "last_seen, day) VALUES (?, ?, ?, ?, ?, ?)",
                    (session_id, client_id, user_agent, now, now, _day_str(now)),
                )
            else:
                cur.execute(
                    "UPDATE sessions SET last_seen = ?, client_id = COALESCE(?, client_id) "
                    "WHERE id = ?",
                    (now, client_id, session_id),
                )

            for ev in events:
                kind = ev.get("kind")
                if kind == "change":
                    cur.execute(
                        "INSERT INTO changes (session_id, ts, from_state, to_state, "
                        "prev_duration) VALUES (?, ?, ?, ?, ?)",
                        (
                            session_id,
                            ev.get("ts"),
                            ev.get("from_state"),
                            ev.get("to_state"),
                            ev.get("prev_duration"),
                        ),
                    )
                    changes += 1
                elif kind == "rollup":
                    cur.execute(
                        "INSERT INTO rollups (session_id, ts, current_state, "
                        "total_open_seconds, total_closed_seconds, open_percentage, "
                        "total_changes, frames_processed, frames_with_face) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            session_id,
                            ev.get("ts"),
                            ev.get("current_state"),
                            ev.get("total_open_seconds"),
                            ev.get("total_closed_seconds"),
                            ev.get("open_percentage"),
                            ev.get("total_changes"),
                            ev.get("frames_processed"),
                            ev.get("frames_with_face"),
                        ),
                    )
                    rollups += 1
            self._conn.commit()
        return {"changes": changes, "rollups": rollups}

    # -- aggregation -------------------------------------------------------

    def daily(self, days: int = 30, client_id: Optional[str] = None) -> Dict[str, Any]:
        """Cross-day aggregate: per-day open/closed seconds and % open."""
        since_day = _day_str(time.time() - days * 86400)
        params: List[Any] = [since_day]
        client_filter = ""
        if client_id:
            client_filter = "AND s.client_id = ?"
            params.append(client_id)

        sql = f"""
            SELECT s.day AS day,
                   COUNT(DISTINCT s.id) AS sessions,
                   SUM(r.open_s)   AS open_s,
                   SUM(r.closed_s) AS closed_s
            FROM sessions s
            JOIN (
                SELECT session_id,
                       MAX(total_open_seconds)   AS open_s,
                       MAX(total_closed_seconds) AS closed_s
                FROM rollups GROUP BY session_id
            ) r ON r.session_id = s.id
            WHERE s.day >= ? {client_filter}
            GROUP BY s.day
            ORDER BY s.day
        """
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()

        days_out: List[Dict[str, Any]] = []
        tot_open = tot_closed = 0.0
        tot_sessions = 0
        for row in rows:
            open_s = row["open_s"] or 0.0
            closed_s = row["closed_s"] or 0.0
            known = open_s + closed_s
            pct = (open_s / known * 100.0) if known > 0 else 0.0
            days_out.append(
                {
                    "date": row["day"],
                    "sessions": row["sessions"],
                    "open_seconds": round(open_s, 1),
                    "closed_seconds": round(closed_s, 1),
                    "open_percentage": round(pct, 1),
                }
            )
            tot_open += open_s
            tot_closed += closed_s
            tot_sessions += row["sessions"]

        total_known = tot_open + tot_closed
        totals = {
            "days": len(days_out),
            "sessions": tot_sessions,
            "total_open_seconds": round(tot_open, 1),
            "total_closed_seconds": round(tot_closed, 1),
            "open_percentage": round(tot_open / total_known * 100.0, 1) if total_known else 0.0,
        }
        return {"days": days_out, "totals": totals}

    def sessions(self, limit: int = 50, client_id: Optional[str] = None) -> List[Dict[str, Any]]:
        params: List[Any] = []
        where = ""
        if client_id:
            where = "WHERE s.client_id = ?"
            params.append(client_id)
        params.append(limit)
        sql = f"""
            SELECT s.id, s.client_id, s.started_at, s.last_seen, s.day,
                   MAX(r.total_open_seconds)   AS open_s,
                   MAX(r.total_closed_seconds) AS closed_s,
                   MAX(r.total_changes)        AS changes
            FROM sessions s
            LEFT JOIN rollups r ON r.session_id = s.id
            {where}
            GROUP BY s.id
            ORDER BY s.started_at DESC
            LIMIT ?
        """
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def close(self) -> None:
        with self._lock:
            self._conn.close()
