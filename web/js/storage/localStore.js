// On-device metadata store (IndexedDB) — the no-backend "central file".
//
// Base data is recorded at the FINEST resolution: one bucket per wall-clock
// hour, accumulating open/closed seconds and the longest continuous closed span
// within that hour. The Statistics selector (hour/day/week/month) is purely a
// visualization roll-up over these hour buckets — the stored data is identical
// regardless of what the selector shows.
//
// IndexedDB is shared across tabs and persists across app restarts, so this
// covers "save metadata centrally, read it from another tab" with no server.

const DB_NAME = "breathing-monitor";
const DB_VERSION = 2;
const HOURS = "hours"; // keyed by hour key "YYYY-MM-DDTHH"
const META = "meta"; // singleton { id:"meta", sessions }

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HOURS)) db.createObjectStore(HOURS, { keyPath: "key" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
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

const pad = (n) => String(n).padStart(2, "0");
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** Bucket key + display label for a timestamp at the given resolution. */
function bucketOf(ms, res) {
  const d = new Date(ms);
  const y = d.getFullYear(), mo = d.getMonth() + 1, day = d.getDate(), hr = d.getHours();
  if (res === "hour") {
    return { key: `${y}-${pad(mo)}-${pad(day)}T${pad(hr)}`, label: `${pad(mo)}-${pad(day)} ${pad(hr)}:00` };
  }
  if (res === "week") {
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    const m = new Date(d);
    m.setDate(day - dow);
    m.setHours(0, 0, 0, 0);
    return {
      key: `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`,
      label: `${pad(m.getMonth() + 1)}-${pad(m.getDate())}`,
    };
  }
  if (res === "month") return { key: `${y}-${pad(mo)}`, label: `${y}-${pad(mo)}` };
  return { key: `${y}-${pad(mo)}-${pad(day)}`, label: `${pad(mo)}-${pad(day)}` };
}

/** The hour-bucket key for a timestamp — the base storage granularity. */
export function hourKey(ms) {
  return bucketOf(ms, "hour").key;
}

function hourKeyToMs(key) {
  const [d, h] = key.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  return new Date(y, mo - 1, da, Number(h), 0, 0, 0).getTime();
}

// How far back each resolution looks (kept modest so charts stay readable).
const WINDOW_MS = {
  hour: 48 * 3600_000,
  day: 45 * 86400_000,
  week: 26 * 7 * 86400_000,
  month: 13 * 31 * 86400_000,
};

/** Ask the browser to keep this data from being evicted under storage pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* best effort */
  }
  return false;
}

/** Bump the session counter (call once per monitoring run). */
export async function startSession() {
  const db = await openDB();
  const store = db.transaction(META, "readwrite").objectStore(META);
  const m = (await reqAsync(store.get("meta"))) || { id: "meta", sessions: 0 };
  m.sessions += 1;
  await reqAsync(store.put(m));
  db.close();
}

/**
 * Add activity to an hour bucket. open/closed seconds ACCUMULATE; maxClosed is a
 * running MAX (so re-sending the same value is idempotent, and separate sessions
 * touching the same hour combine correctly).
 */
export async function addHourly(key, openInc, closedInc, maxClosed) {
  const db = await openDB();
  const store = db.transaction(HOURS, "readwrite").objectStore(HOURS);
  const cur = (await reqAsync(store.get(key))) || { key, open: 0, closed: 0, maxClosed: 0 };
  // Increments may be negative (retroactive correction, e.g. talking onset);
  // clamp so a bucket never goes below zero.
  cur.open = Math.max(0, cur.open + (openInc || 0));
  cur.closed = Math.max(0, cur.closed + (closedInc || 0));
  cur.maxClosed = Math.max(cur.maxClosed, maxClosed || 0);
  await reqAsync(store.put(cur));
  db.close();
}

async function allHours() {
  const db = await openDB();
  const rows = await reqAsync(db.transaction(HOURS, "readonly").objectStore(HOURS).getAll());
  const meta = await reqAsync(db.transaction(META, "readonly").objectStore(META).get("meta"));
  db.close();
  return { rows: rows || [], meta };
}

/**
 * Roll the hour buckets up to the requested resolution for display. The stored
 * data is unchanged; only the grouping differs.
 * @param {"hour"|"day"|"week"|"month"} resolution
 */
export async function aggregate(resolution = "day") {
  const { rows, meta } = await allHours();
  const cutoff = Date.now() - (WINDOW_MS[resolution] ?? WINDOW_MS.day);

  const byKey = new Map();
  for (const h of rows) {
    const ms = hourKeyToMs(h.key);
    if (ms < cutoff) continue;
    const { key, label } = bucketOf(ms, resolution);
    const e = byKey.get(key) || { key, label, open: 0, closed: 0, maxClosed: 0 };
    e.open += h.open || 0;
    e.closed += h.closed || 0;
    e.maxClosed = Math.max(e.maxClosed, h.maxClosed || 0);
    byKey.set(key, e);
  }

  const daysOut = [];
  let totOpen = 0, totClosed = 0, overallMaxClosed = 0;
  for (const key of [...byKey.keys()].sort()) {
    const e = byKey.get(key);
    const known = e.open + e.closed;
    daysOut.push({
      date: e.key,
      label: e.label,
      open_seconds: round(e.open, 1),
      closed_seconds: round(e.closed, 1),
      open_percentage: known > 0 ? round((e.open / known) * 100, 1) : 0,
      max_closed_seconds: round(e.maxClosed, 1),
    });
    totOpen += e.open;
    totClosed += e.closed;
    overallMaxClosed = Math.max(overallMaxClosed, e.maxClosed);
  }

  const known = totOpen + totClosed;
  return {
    resolution,
    days: daysOut,
    totals: {
      days: daysOut.length,
      sessions: meta?.sessions || 0,
      total_open_seconds: round(totOpen, 1),
      total_closed_seconds: round(totClosed, 1),
      open_percentage: known > 0 ? round((totOpen / known) * 100, 1) : 0,
      max_closed_seconds: round(overallMaxClosed, 1),
    },
  };
}

/** Remove all stored data (handy for a "clear my data" action). */
export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction([HOURS, META], "readwrite");
  await reqAsync(tx.objectStore(HOURS).clear());
  await reqAsync(tx.objectStore(META).clear());
  db.close();
}
