// Metadata uploader — ships session metadata to the CENTRALIZED web store so
// sessions across days aggregate together.
//
// Design goals:
//  * Never block the pipeline: events are queued and flushed on an interval.
//  * Survive flaky networks: an unsent batch is buffered in localStorage and
//    retried; nothing is dropped just because the phone briefly went offline.
//  * Cheap payloads: we upload confirmed state changes + periodic rollups, NOT
//    every frame or any landmarks/images.

const BUFFER_KEY = "bm.upload.buffer.v1";

export class MetadataUploader {
  /**
   * @param {Object} opts
   * @param {string} opts.apiBase        e.g. "" (same origin) or "http://host:8000"
   * @param {string} opts.sessionId
   * @param {string} opts.clientId
   * @param {number} [opts.flushMs=5000]
   */
  constructor({ apiBase, sessionId, clientId, flushMs = 5000 }) {
    this.apiBase = apiBase.replace(/\/$/, "");
    this.sessionId = sessionId;
    this.clientId = clientId;
    this.flushMs = flushMs;
    this._queue = this._loadBuffer();
    this._timer = null;
    this._sessionAnnounced = false;
  }

  start() {
    this._timer = setInterval(() => this.flush(), this.flushMs);
    // Best-effort flush when the tab is hidden/closed.
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flush(true);
    });
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.flush(true);
  }

  /** Queue a confirmed open<->closed change. */
  enqueueChange(change) {
    this._queue.push({
      kind: "change",
      ts: change.timestamp,
      from_state: change.fromState,
      to_state: change.toState,
      prev_duration: round(change.prevDuration, 3),
    });
    this._persistBuffer();
  }

  /** Queue a periodic stats rollup (a snapshot() dict from the pipeline). */
  enqueueRollup(snapshot) {
    this._queue.push({
      kind: "rollup",
      ts: Date.now() / 1000,
      current_state: snapshot.currentState,
      total_open_seconds: snapshot.totalOpenSeconds,
      total_closed_seconds: snapshot.totalClosedSeconds,
      open_percentage: snapshot.openPercentage,
      total_changes: snapshot.totalChanges,
      frames_processed: snapshot.framesProcessed,
      frames_with_face: snapshot.framesWithFace,
    });
    this._persistBuffer();
  }

  async flush(useBeacon = false) {
    if (this._queue.length === 0 && this._sessionAnnounced) return;
    const batch = this._queue.splice(0, this._queue.length);
    const body = JSON.stringify({
      session_id: this.sessionId,
      client_id: this.clientId,
      user_agent: navigator.userAgent,
      events: batch,
    });
    const url = `${this.apiBase}/api/ingest`;

    try {
      if (useBeacon && navigator.sendBeacon) {
        const ok = navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
        if (!ok) throw new Error("beacon rejected");
      } else {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: useBeacon,
        });
        if (!res.ok) throw new Error(`ingest HTTP ${res.status}`);
      }
      this._sessionAnnounced = true;
      this._persistBuffer();
    } catch (err) {
      // Put the batch back at the front and keep it buffered for next time.
      this._queue.unshift(...batch);
      this._persistBuffer();
      console.warn("Metadata upload failed (buffered for retry):", err.message);
    }
  }

  _loadBuffer() {
    try {
      return JSON.parse(localStorage.getItem(BUFFER_KEY)) || [];
    } catch {
      return [];
    }
  }

  _persistBuffer() {
    try {
      localStorage.setItem(BUFFER_KEY, JSON.stringify(this._queue));
    } catch {
      /* storage full / disabled — best effort */
    }
  }
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
