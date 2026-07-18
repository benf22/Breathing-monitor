// On-device metadata store (IndexedDB) — the no-backend "central file".
//
// The Monitor tab writes one record per monitoring session (its latest
// cumulative totals); the Statistics tab reads them back and aggregates by day.
// Because IndexedDB is shared across tabs of the same origin and persists across
// app restarts, this covers the "save small metadata centrally and read it from
// another tab" need with no server and no network.
//
// The method surface (recordRollup / daily / sessions) is deliberately the same
// shape a future cloud store (e.g. Google Drive) would implement, so Statistics
// doesn't care where the data lives.

const DB_NAME = "breathing-monitor";
const DB_VERSION = 1;
const STORE = "sessionTotals";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqAsync(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** Local calendar day (YYYY-MM-DD) so days line up with the user's clock. */
function localDay(epochMs) {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Ask the browser to keep this data from being evicted under storage pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* best effort */
  }
  return false;
}

/**
 * Upsert a session's latest cumulative totals. Called periodically while
 * monitoring; the newest call wins (totals are cumulative within a session).
 */
export async function recordRollup(sessionId, clientId, snapshot, startedAtMs) {
  const db = await openDB();
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  const existing = await reqAsync(store.get(sessionId));
  const started = existing?.startedAt ?? startedAtMs ?? Date.now();
  const record = {
    id: sessionId,
    clientId,
    startedAt: started,
    lastSeen: Date.now(),
    day: localDay(started),
    openSeconds: snapshot.totalOpenSeconds ?? 0,
    closedSeconds: snapshot.totalClosedSeconds ?? 0,
    changes: snapshot.totalChanges ?? 0,
    framesProcessed: snapshot.framesProcessed ?? 0,
    framesWithFace: snapshot.framesWithFace ?? 0,
  };
  await reqAsync(store.put(record));
  db.close();
}

async function allSessions() {
  const db = await openDB();
  const store = db.transaction(STORE, "readonly").objectStore(STORE);
  const rows = await reqAsync(store.getAll());
  db.close();
  return rows || [];
}

/**
 * Cross-day aggregate, same shape as the server's /api/stats/daily response so
 * the Statistics renderer is storage-agnostic.
 */
export async function daily(days = 30) {
  const rows = await allSessions();
  const cutoff = localDay(Date.now() - days * 86400_000);

  const byDay = new Map();
  for (const s of rows) {
    if (s.day < cutoff) continue;
    const e = byDay.get(s.day) || { open: 0, closed: 0, sessions: 0 };
    e.open += s.openSeconds || 0;
    e.closed += s.closedSeconds || 0;
    e.sessions += 1;
    byDay.set(s.day, e);
  }

  const daysOut = [];
  let totOpen = 0, totClosed = 0, totSessions = 0;
  for (const date of [...byDay.keys()].sort()) {
    const e = byDay.get(date);
    const known = e.open + e.closed;
    daysOut.push({
      date,
      sessions: e.sessions,
      open_seconds: round(e.open, 1),
      closed_seconds: round(e.closed, 1),
      open_percentage: known > 0 ? round((e.open / known) * 100, 1) : 0,
    });
    totOpen += e.open;
    totClosed += e.closed;
    totSessions += e.sessions;
  }

  const known = totOpen + totClosed;
  return {
    days: daysOut,
    totals: {
      days: daysOut.length,
      sessions: totSessions,
      total_open_seconds: round(totOpen, 1),
      total_closed_seconds: round(totClosed, 1),
      open_percentage: known > 0 ? round((totOpen / known) * 100, 1) : 0,
    },
  };
}

/** Remove everything (handy for a "clear my data" action). */
export async function clearAll() {
  const db = await openDB();
  await reqAsync(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
  db.close();
}
