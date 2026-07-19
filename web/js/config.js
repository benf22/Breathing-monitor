// Settings — defaults + load/save, browser equivalent of `config/settings.py`.
//
// Defaults live here in code; user overrides persist to localStorage. The Config
// tab reads/writes this. Values mirror the Python DetectionSettings /
// CaptureSettings so the algorithm behaves identically to the desktop app.

const STORAGE_KEY = "bm.settings.v1";

export const DEFAULT_SETTINGS = Object.freeze({
  capture: {
    intervalMs: 200, // sample one frame every 0.2s (capture.interval_seconds)
    facingMode: "user", // front camera — phone on desk facing you
    frameWidth: 640,
    frameHeight: 480,
    // "auto" rotates the frame upright only when it arrives sideways; or force
    // "0" | "90" | "180" | "270".
    rotation: "auto",
    // Stop monitoring when the app is backgrounded and resume when it returns.
    autoStartStop: true,
  },
  detection: {
    minFaceConfidence: 0.5,
    minFaceAreaRatio: 0.02,
    openThreshold: 0.35,
    closeThreshold: 0.28,
    minOpenSeconds: 0.15,
    minClosedSeconds: 0.15,
  },
  talking: {
    // Vision-only talking detection; ignores frames while you're speaking.
    enabled: true,
    sensitivity: 0.5, // 0..1, higher flags talking more readily
    onsetMs: 200, // t1: raw-talking must persist this long to ENTER talking
    holdMs: 700, // t2: no talking evidence for this long to EXIT talking
  },
  notifications: {
    enabled: true,
    // Alert when the mouth stays OPEN (mouth-breathing) at least this long.
    mouthOpenAlertSeconds: 20,
    // Periodic "take a breathing break" reminder; 0 disables.
    breathingReminderMinutes: 30,
  },
  baseline: {
    // Periodically pause biofeedback to sample the user's unbiased "baseline"
    // habits. On for onMinutes, then off (baseline) for offMinutes, repeating.
    enabled: true,
    onMinutes: 5,
    offMinutes: 1,
  },
  cloud: {
    // "" = same origin as the served PWA. Set to a full URL to point the phone
    // at a central server on your LAN, e.g. "http://192.168.1.20:8000".
    apiBase: "",
    uploadEnabled: true,
    rollupSeconds: 30, // how often to push a stats rollup
  },
});

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    return deepMerge(DEFAULT_SETTINGS, raw);
  } catch {
    return deepMerge(DEFAULT_SETTINGS, {});
  }
}

export function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function resetSettings() {
  localStorage.removeItem(STORAGE_KEY);
  return deepMerge(DEFAULT_SETTINGS, {});
}

/** Stable per-device id so the server can group this device's sessions. */
export function getClientId() {
  let id = localStorage.getItem("bm.clientId");
  if (!id) {
    id = "dev-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem("bm.clientId", id);
  }
  return id;
}

/** A fresh session id per monitoring run. */
export function newSessionId() {
  return "sess-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
