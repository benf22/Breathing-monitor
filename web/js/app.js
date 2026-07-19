// App orchestrator — wires the tabs, the monitor controls, the pipeline, the
// notifier, the uploader and the statistics view together.

import { FaceSensor } from "./vision/faceSensor.js";
import { Pipeline } from "./pipeline/pipeline.js";
import { MetadataUploader } from "./storage/uploader.js";
import * as localStore from "./storage/localStore.js";
import { Notifier } from "./notifications.js";
import { PreviewRenderer } from "./ui/overlay.js";
import { initTabs } from "./ui/tabs.js";
import { lineChart, stateRibbon, bioChart, LiveTrace } from "./ui/charts.js";
import { isIgnored, ignoreLabels, ignoreReasons } from "./core/ignore.js";
import { APP_VERSION } from "./version.js";
import {
  loadSettings,
  saveSettings,
  resetSettings,
  getClientId,
  newSessionId,
  DEFAULT_SETTINGS,
} from "./config.js";

const $ = (sel) => document.querySelector(sel);

let settings = loadSettings();
let pipeline = null;
let sensor = null;
let uploader = null;
let notifier = null;
let preview = null;
let rollupTimer = null;
let statusTimer = null;
let lastMar = null; // most recent instantaneous MAR (for Calibrate capture buttons)
let currentSessionId = null;
let currentClientId = null;
let currentResolution = localStorage.getItem("bm.stats.res") || "day";

// Fine-grained (per wall-clock hour) accounting accumulated in memory during a
// session and flushed to the store. This is the base resolution; the Statistics
// selector only rolls these up for display.
let accByHour = new Map(); // hourKey -> { open, closed } seconds since last flush
let maxByHour = new Map(); // hourKey -> longest continuous closed span (session)
let closedRun = 0; // current ongoing closed-span length (s), excludes ignored time
let openRun = 0; // current ongoing open-span length (s), excludes ignored time
let sessionOpen = 0; // session open seconds (ignore-gated) for the Monitor tiles
let sessionClosed = 0; // session closed seconds (ignore-gated)
let lastAccMs = null;
let prevAccState = null;
let ignoredNow = false; // whether the latest frame is being ignored

// Live real-time MAR trace for the Monitor tab (online feedback).
const liveTrace = new LiveTrace();
let liveTimer = null;
let liveRes = localStorage.getItem("bm.live.res") || "sec";

function renderLive() {
  const series = liveRes === "sec" ? liveTrace.seconds(90) : liveTrace.minutes(60);
  const winEl = $("#live-window");
  if (winEl) winEl.textContent = liveRes === "sec" ? "90s" : "60 min";
  stateRibbon($("#live-chart"), series, {
    res: liveRes,
    emptyMsg: pipeline ? "Waiting for a face…" : "Start monitoring to see live state.",
  });
}

// Moving average of closed-span durations over the last hour, including the
// CURRENTLY-ongoing closed span so the number rises live while the mouth is
// closed (not only when a span ends).
let closedSpans = []; // completed spans: [{ t: endMs, dur }]
let avgTrace = []; // biofeedback samples: [{ t, value }]
let lastAvgPushSec = 0;

function currentAvgCloseSeconds() {
  const cutoff = Date.now() - 3600_000;
  closedSpans = closedSpans.filter((s) => s.t >= cutoff);
  let sum = 0, count = 0;
  for (const s of closedSpans) { sum += s.dur; count += 1; }
  // Fold in the ongoing closed span (excludes ignored time via closedRun).
  if (!ignoredNow && closedRun > 0) { sum += closedRun; count += 1; }
  return count ? sum / count : null;
}

function updateAvgClose() {
  const avg = currentAvgCloseSeconds();
  const txt = avg != null ? avg.toFixed(1) + "s" : "—";
  const a = $("#stat-avg-close");
  const b = $("#ambient-metric");
  if (a) a.textContent = txt;
  if (b) b.textContent = txt;
  // Sample once per second into the biofeedback trace (keep ~3 min).
  const nowSec = Math.floor(Date.now() / 1000);
  if (avg != null && nowSec !== lastAvgPushSec) {
    lastAvgPushSec = nowSec;
    avgTrace.push({ t: Date.now(), value: avg });
    const cutoff = Date.now() - 180_000;
    while (avgTrace.length && avgTrace[0].t < cutoff) avgTrace.shift();
  }
}

function renderBio() {
  bioChart($("#bio-chart"), avgTrace.slice(), {
    unit: "s",
    emptyMsg: pipeline ? "Building trace…" : "Start monitoring to see the biofeedback trace.",
  });
}

function renderLiveViews() {
  renderLive();
  renderBio();
}

// Distraction-free ambient tab: green = closed, red = open, gray = ignored/not
// detected.
function updateAmbient(result, ignored, talkingIgnored) {
  const amb = $("#ambient");
  if (!amb) return;
  const st = !result || ignored ? "unknown" : result.state === "open" ? "open" : result.state === "closed" ? "closed" : "unknown";
  amb.dataset.state = st; // ignored → gray (talking is treated as an ignore)
  $("#ambient-state").textContent = talkingIgnored
    ? "TALKING"
    : st === "open"
    ? "OPEN"
    : st === "closed"
    ? "CLOSED"
    : "NOT DETECTED";
}

function bumpMax(hk, val) {
  if (val > 0) maxByHour.set(hk, Math.max(maxByHour.get(hk) || 0, val));
}

// Attribute the time since the previous frame to the current wall-clock hour and
// the smoothed state. IGNORED frames (see core/ignore.js) are never aggregated:
// they pause accounting and close out any ongoing run, exactly like a face loss.
function accountFrame(result, ignored) {
  const now = Date.now();
  if (ignored) {
    if (closedRun > 0) bumpMax(localStore.hourKey(now), closedRun);
    closedRun = 0;
    openRun = 0;
    prevAccState = null;
    lastAccMs = null;
    return;
  }
  const st = result.state;
  if (lastAccMs != null) {
    const dt = (now - lastAccMs) / 1000;
    if (dt > 0 && dt < 5) {
      const hk = localStore.hourKey(now);
      const e = accByHour.get(hk) || { open: 0, closed: 0 };
      if (st === "open") {
        e.open += dt;
        openRun += dt;
        sessionOpen += dt;
      } else if (st === "closed") {
        e.closed += dt;
        closedRun += dt;
        sessionClosed += dt;
      }
      accByHour.set(hk, e);
    }
  }
  // A closed span just ended by opening → record it (max + avg-close metric).
  // The duration is the ignore-gated run, so ignored gaps never inflate it.
  if (prevAccState === "closed" && st !== "closed") {
    bumpMax(localStore.hourKey(now), closedRun);
    if (closedRun > 0) closedSpans.push({ t: now, dur: closedRun });
    closedRun = 0;
  }
  if (st !== "closed") closedRun = 0;
  if (st !== "open") openRun = 0;
  prevAccState = st;
  lastAccMs = now;
}

function resetAccounting() {
  accByHour = new Map();
  maxByHour = new Map();
  closedRun = 0;
  openRun = 0;
  sessionOpen = 0;
  sessionClosed = 0;
  lastAccMs = null;
  prevAccState = null;
}

async function flushAccounting() {
  // Reflect any ongoing closed run into the current hour's max.
  if (closedRun > 0) bumpMax(localStore.hourKey(Date.now()), closedRun);
  const keys = new Set([...accByHour.keys(), ...maxByHour.keys()]);
  for (const hk of keys) {
    const inc = accByHour.get(hk) || { open: 0, closed: 0 };
    const mx = maxByHour.get(hk) || 0;
    try {
      await localStore.addHourly(hk, inc.open, inc.closed, mx);
    } catch (e) {
      console.warn("local store:", e);
    }
  }
  // Increments are now persisted; clear them. Keep maxByHour (re-adds are
  // idempotent since the store takes a max).
  accByHour.clear();
}

const MAR_SCALE = 1.0; // meter/threshold display range (MAR is ~0..0.8+)
const round2 = (v) => Math.round(v * 100) / 100;
const marPct = (v) => Math.max(0, Math.min(100, (v / MAR_SCALE) * 100));

// ---- toast ---------------------------------------------------------------
function toast(msg, level = "info") {
  const wrap = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast toast-${level}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 6000);
}

// ---- monitor -------------------------------------------------------------
async function startMonitoring() {
  if (pipeline) return;
  const btn = $("#toggle-btn");
  btn.disabled = true;
  btn.textContent = "Starting…";

  try {
    sensor = new FaceSensor({
      intervalMs: settings.capture.intervalMs,
      facingMode: settings.capture.facingMode,
      width: settings.capture.frameWidth,
      height: settings.capture.frameHeight,
      minFaceConfidence: settings.detection.minFaceConfidence,
      minFaceAreaRatio: settings.detection.minFaceAreaRatio,
    });

    pipeline = new Pipeline(
      sensor,
      {
        openThreshold: settings.detection.openThreshold,
        closeThreshold: settings.detection.closeThreshold,
        minOpenSeconds: settings.detection.minOpenSeconds,
        minClosedSeconds: settings.detection.minClosedSeconds,
      },
      { talking: { ...settings.talking } }
    );

    notifier = new Notifier(settings.notifications, toast);
    if (settings.notifications.enabled) await notifier.requestPermission();

    currentSessionId = newSessionId();
    currentClientId = getClientId();
    resetAccounting();
    liveTrace.reset();
    avgTrace = [];
    lastAvgPushSec = 0;
    localStore.startSession().catch((e) => console.warn("local store:", e));
    // Cloud upload only when an API base is configured; otherwise metadata lives
    // on-device in IndexedDB — no backend needed.
    const apiBase = (settings.cloud.apiBase || "").trim();
    if (settings.cloud.uploadEnabled && apiBase) {
      uploader = new MetadataUploader({
        apiBase,
        sessionId: currentSessionId,
        clientId: currentClientId,
      });
      uploader.start();
    }

    pipeline.on("frame", onFrame);
    pipeline.on("change", onChange);

    await pipeline.start();

    preview = new PreviewRenderer($("#preview"));
    preview.attach(sensor.videoElement);

    // Periodic flush: persist the accumulated hourly buckets on-device; also
    // upload a session rollup if a backend is configured.
    rollupTimer = setInterval(() => {
      flushAccounting();
      if (uploader) uploader.enqueueRollup(pipeline.snapshot());
    }, (settings.cloud.rollupSeconds || 30) * 1000);
    statusTimer = setInterval(refreshStats, 1000);
    liveTimer = setInterval(renderLiveViews, 500);

    btn.textContent = "Stop monitoring";
    btn.classList.add("stop");
    btn.disabled = false;
    $("#status-dot").classList.add("live");
    $("#cal-hint").textContent = "Live — open and close your mouth to calibrate.";
    $("#ambient-hint").textContent = "";
    toast("Monitoring started", "info");
  } catch (err) {
    console.error(err);
    toast("Could not start: " + err.message, "error");
    btn.textContent = "Start monitoring";
    btn.disabled = false;
    stopMonitoring();
  }
}

function stopMonitoring() {
  // Persist the final accumulated hourly activity before tearing down.
  flushAccounting();
  if (rollupTimer) clearInterval(rollupTimer), (rollupTimer = null);
  if (statusTimer) clearInterval(statusTimer), (statusTimer = null);
  if (liveTimer) clearInterval(liveTimer), (liveTimer = null);
  if (uploader) uploader.stop(), (uploader = null);
  if (pipeline) pipeline.stop(), (pipeline = null);
  if (preview) preview.stop(), (preview = null);
  sensor = null;
  notifier = null;

  const btn = $("#toggle-btn");
  btn.textContent = "Start monitoring";
  btn.classList.remove("stop");
  btn.disabled = false;
  $("#status-dot").classList.remove("live");
  lastMar = null;
  $("#cal-hint").textContent = "Start monitoring on the Monitor tab to see live MAR.";
  $("#cal-mar").textContent = "—";
  $("#cal-state").textContent = "—";
  $("#cal-fill").style.width = "0%";
  resetNarMeter();
  renderLiveViews();
  updateAmbient(null);
  $("#ambient-hint").textContent = "Start monitoring on the Monitor tab, then leave this tab open.";
}

function onFrame(result) {
  // Draw the face box + lip/nose landmarks over the preview video.
  if (preview) preview.setResult(result);

  // Central suppression gate: ignored frames are never aggregated and never
  // alert (see core/ignore.js).
  const ignored = isIgnored(result);
  const talkingIgnored = ignored && ignoreReasons(result).includes("talking");
  ignoredNow = ignored;

  // Accumulate fine-grained (per-hour) activity for the stats store.
  accountFrame(result, ignored);
  // Live binary state trace + ambient tab (ignored → gap / gray).
  liveTrace.push(Date.now(), ignored ? "unknown" : result.state);
  updateAmbient(result, ignored, talkingIgnored);
  updateAvgClose(); // live: grows while the mouth is currently closed (gated)

  const indicator = $("#indicator");
  const mar = result.lips ? result.lips.mar.toFixed(3) : "—";
  const state = result.state;
  const displayState = ignored ? "unknown" : state;

  // Treat talking as an ignore, but label it "TALKING" instead of the neutral
  // placeholder so it's clear why nothing is being counted.
  indicator.dataset.state = displayState;
  $("#indicator-label").textContent = talkingIgnored
    ? "TALKING"
    : displayState === "open"
    ? "OPEN"
    : displayState === "closed"
    ? "CLOSED"
    : "…";
  $("#mar-value").textContent = mar;
  $("#face-status").textContent = ignored
    ? "ignored · " + (ignoreLabels(result)[0] || "")
    : "tracking";

  // Feed the Calibrate tab's live readout (cheap even when that tab is hidden).
  lastMar = result.lips ? result.lips.mar : null;
  $("#cal-mar").textContent = lastMar != null ? lastMar.toFixed(3) : "—";
  $("#cal-state").textContent = displayState;
  $("#cal-fill").style.width = (lastMar != null ? marPct(lastMar) : 0) + "%";

  // Experimental nose-breathing signal (auto-scaled bar).
  updateNarMeter(result.nose ? result.nose.nar : null);

  // Talking-detection live readout (for the Calibrate tab).
  $("#talk-score").textContent = result.talkingScore != null ? result.talkingScore.toFixed(1) : "—";
  $("#talk-state").textContent = result.talking ? "TALKING" : "quiet";

  // Alerts: suppressed while ignored; the open-alert uses the ignore-gated
  // continuous open-run duration (so a gap doesn't inflate it).
  if (notifier) {
    if (ignored) notifier.suppress();
    else notifier.onState(state, openRun);
  }
}

function onChange(change) {
  if (uploader) uploader.enqueueChange(change);
  // Closed-span durations for the avg-close metric are recorded in accountFrame
  // (ignore-gated), not here — this listener only drives the uploader + the list.
  const list = $("#changes-list");
  const li = document.createElement("li");
  const t = new Date().toLocaleTimeString();
  li.textContent = `${t}  ${change.fromState} → ${change.toState}  (${change.prevDuration.toFixed(1)}s)`;
  list.prepend(li);
  while (list.children.length > 20) list.lastChild.remove();
}

function refreshStats() {
  if (!pipeline) return;
  const s = pipeline.snapshot();
  // Open/closed time and % from the ignore-gated session accounting; change
  // count and face rate from the pipeline accumulator.
  const known = sessionOpen + sessionClosed;
  $("#stat-open-pct").textContent = (known > 0 ? Math.round((sessionOpen / known) * 100) : 0) + "%";
  $("#stat-changes").textContent = s.totalChanges;
  $("#stat-open-s").textContent = sessionOpen.toFixed(0) + "s";
  $("#stat-closed-s").textContent = sessionClosed.toFixed(0) + "s";
  $("#stat-face-rate").textContent = Math.round(s.faceDetectionRate * 100) + "%";
  updateAvgClose(); // recompute so the 60-min window decays even without new spans
}

// ---- config --------------------------------------------------------------
function populateConfigForm() {
  const form = $("#config-form");
  const set = (name, val) => {
    const el = form.elements[name];
    if (el) el.type === "checkbox" ? (el.checked = val) : (el.value = val);
  };
  set("intervalMs", settings.capture.intervalMs);
  set("facingMode", settings.capture.facingMode);
  set("openThreshold", settings.detection.openThreshold);
  set("closeThreshold", settings.detection.closeThreshold);
  set("minOpenSeconds", settings.detection.minOpenSeconds);
  set("minClosedSeconds", settings.detection.minClosedSeconds);
  set("minFaceConfidence", settings.detection.minFaceConfidence);
  set("minFaceAreaRatio", settings.detection.minFaceAreaRatio);
  set("notifEnabled", settings.notifications.enabled);
  set("mouthOpenAlertSeconds", settings.notifications.mouthOpenAlertSeconds);
  set("breathingReminderMinutes", settings.notifications.breathingReminderMinutes);
  set("apiBase", settings.cloud.apiBase);
  set("uploadEnabled", settings.cloud.uploadEnabled);
  set("rollupSeconds", settings.cloud.rollupSeconds);
}

function bindConfigForm() {
  const form = $("#config-form");
  populateConfigForm();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = form.elements;
    const num = (el) => parseFloat(el.value);
    settings = {
      capture: {
        ...settings.capture,
        intervalMs: parseInt(f.intervalMs.value, 10),
        facingMode: f.facingMode.value,
      },
      detection: {
        ...settings.detection,
        openThreshold: num(f.openThreshold),
        closeThreshold: num(f.closeThreshold),
        minOpenSeconds: num(f.minOpenSeconds),
        minClosedSeconds: num(f.minClosedSeconds),
        minFaceConfidence: num(f.minFaceConfidence),
        minFaceAreaRatio: num(f.minFaceAreaRatio),
      },
      notifications: {
        ...settings.notifications,
        enabled: f.notifEnabled.checked,
        mouthOpenAlertSeconds: num(f.mouthOpenAlertSeconds),
        breathingReminderMinutes: num(f.breathingReminderMinutes),
      },
      cloud: {
        ...settings.cloud,
        apiBase: f.apiBase.value.trim(),
        uploadEnabled: f.uploadEnabled.checked,
        rollupSeconds: num(f.rollupSeconds),
      },
    };
    if (settings.detection.closeThreshold > settings.detection.openThreshold) {
      toast("Close threshold must be ≤ open threshold", "error");
      return;
    }
    saveSettings(settings);
    if (notifier) notifier.updateConfig(settings.notifications);
    // Detection thresholds can apply live; capture changes need a restart.
    if (pipeline) {
      pipeline.updateDetection({
        openThreshold: settings.detection.openThreshold,
        closeThreshold: settings.detection.closeThreshold,
        minOpenSeconds: settings.detection.minOpenSeconds,
        minClosedSeconds: settings.detection.minClosedSeconds,
      });
    }
    refreshCalibrateUI();
    toast("Settings saved" + (pipeline ? " — restart monitoring to apply capture changes" : ""), "info");
  });

  $("#config-reset").addEventListener("click", () => {
    settings = resetSettings();
    populateConfigForm();
    refreshCalibrateUI();
    if (pipeline) {
      pipeline.updateDetection({
        openThreshold: settings.detection.openThreshold,
        closeThreshold: settings.detection.closeThreshold,
        minOpenSeconds: settings.detection.minOpenSeconds,
        minClosedSeconds: settings.detection.minClosedSeconds,
      });
    }
    toast("Settings reset to defaults", "info");
  });
}

// ---- calibrate -----------------------------------------------------------
function refreshCalibrateUI() {
  const d = settings.detection;
  const openEl = $("#cal-open");
  if (!openEl) return;
  openEl.value = d.openThreshold;
  $("#cal-close").value = d.closeThreshold;
  $("#cal-open-val").textContent = d.openThreshold.toFixed(2);
  $("#cal-close-val").textContent = d.closeThreshold.toFixed(2);
  $("#cal-mark-open").style.left = marPct(d.openThreshold) + "%";
  $("#cal-mark-close").style.left = marPct(d.closeThreshold) + "%";

  const t = settings.talking;
  $("#talk-enabled").checked = t.enabled;
  $("#talk-sens").value = t.sensitivity;
  $("#talk-sens-val").textContent = t.sensitivity.toFixed(2);
  $("#talk-onset").value = (t.onsetMs / 1000).toFixed(2);
  $("#talk-hold").value = (t.holdMs / 1000).toFixed(2);
}

function applyThresholds(open, close) {
  open = round2(open);
  close = round2(Math.min(close, open)); // enforce hysteresis: close <= open
  settings.detection.openThreshold = open;
  settings.detection.closeThreshold = close;
  saveSettings(settings);
  if (pipeline) pipeline.updateDetection({ openThreshold: open, closeThreshold: close });
  refreshCalibrateUI();
}

function initCalibrate() {
  $("#cal-open").addEventListener("input", (e) => {
    applyThresholds(parseFloat(e.target.value), settings.detection.closeThreshold);
  });
  $("#cal-close").addEventListener("input", (e) => {
    applyThresholds(settings.detection.openThreshold, parseFloat(e.target.value));
  });
  $("#cal-set-open").addEventListener("click", () => {
    if (lastMar == null) return toast("No live MAR yet — start monitoring first.", "warn");
    applyThresholds(lastMar, settings.detection.closeThreshold);
    toast(`Open threshold set to ${round2(lastMar)}`, "info");
  });
  $("#cal-set-close").addEventListener("click", () => {
    if (lastMar == null) return toast("No live MAR yet — start monitoring first.", "warn");
    applyThresholds(settings.detection.openThreshold, lastMar);
    toast(`Close threshold set to ${round2(Math.min(lastMar, settings.detection.openThreshold))}`, "info");
  });

  const applyTalking = () => {
    saveSettings(settings);
    if (pipeline) pipeline.setTalkingConfig({ ...settings.talking });
  };
  $("#talk-enabled").addEventListener("change", (e) => {
    settings.talking.enabled = e.target.checked;
    applyTalking();
  });
  $("#talk-sens").addEventListener("input", (e) => {
    settings.talking.sensitivity = parseFloat(e.target.value);
    $("#talk-sens-val").textContent = settings.talking.sensitivity.toFixed(2);
    applyTalking();
  });
  $("#talk-onset").addEventListener("change", (e) => {
    settings.talking.onsetMs = Math.max(0, parseFloat(e.target.value) || 0) * 1000;
    applyTalking();
  });
  $("#talk-hold").addEventListener("change", (e) => {
    settings.talking.holdMs = Math.max(0, parseFloat(e.target.value) || 0) * 1000;
    applyTalking();
  });

  refreshCalibrateUI();
}

// ---- nostril ratio (experimental nose-breathing signal) ------------------
const NAR_WINDOW = 120; // ~24s at 5 fps
let narBuf = [];

function updateNarMeter(nar) {
  const valEl = $("#nar-value");
  if (!valEl) return;
  if (nar == null) {
    valEl.textContent = "—";
    return;
  }
  valEl.textContent = nar.toFixed(3);
  narBuf.push(nar);
  if (narBuf.length > NAR_WINDOW) narBuf.shift();
  // Auto-scale the bar to the recent min/max so subtle nostril motion is visible.
  let mn = Infinity, mx = -Infinity;
  for (const v of narBuf) {
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const amp = mx - mn;
  $("#nar-amp").textContent = amp.toFixed(3);
  const pct = amp > 1e-6 ? ((nar - mn) / amp) * 100 : 50;
  $("#nar-fill").style.width = pct + "%";
}

function resetNarMeter() {
  narBuf = [];
  if ($("#nar-value")) {
    $("#nar-value").textContent = "—";
    $("#nar-amp").textContent = "—";
    $("#nar-fill").style.width = "0%";
  }
}

// ---- statistics (cross-day, from the central store) ----------------------
async function loadStatistics() {
  const status = $("#stats-status");
  const base = (settings.cloud.apiBase || "").trim().replace(/\/$/, "");
  status.textContent = "Loading…";
  try {
    let data, source;
    if (base) {
      const res = await fetch(`${base}/api/stats/daily?days=30`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      source = "central server";
    } else {
      data = await localStore.aggregate(currentResolution);
      source = "this device";
    }
    renderCharts(data.days || []);
    renderDaily(data.days || []);
    renderTotals(data.totals || {});
    const unit = base ? "day" : currentResolution;
    status.textContent =
      data.days && data.days.length
        ? `Showing ${data.days.length} ${unit}(s) from ${source}.`
        : `No data yet (${source}) — start monitoring to record some.`;
  } catch (err) {
    status.textContent = "Could not load statistics (" + err.message + ").";
  }
}

function renderTotals(t) {
  $("#agg-days").textContent = t.days ?? 0;
  $("#agg-sessions").textContent = t.sessions ?? 0;
  $("#agg-open-pct").textContent = (t.open_percentage ?? 0).toFixed(1) + "%";
  $("#agg-open-hours").textContent = ((t.total_open_seconds ?? 0) / 3600).toFixed(1) + "h";
}

function renderCharts(days) {
  const openSeries = days.map((d) => ({ date: d.date, value: d.open_percentage ?? 0 }));
  const closedSeries = days.map((d) => ({ date: d.date, value: d.max_closed_seconds ?? 0 }));
  // % open: 0..100, semantic "open" hue (red). Max closed duration: seconds,
  // semantic "closed" hue (green). Two separate charts — never a dual axis.
  lineChart($("#chart-open"), openSeries, {
    color: "var(--open)",
    yMax: 100,
    unit: "%",
    fmt: (v) => Math.round(v),
  });
  lineChart($("#chart-closed"), closedSeries, {
    color: "var(--closed)",
    unit: "s",
    fmt: (v) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10),
  });
}

function renderDaily(days) {
  const wrap = $("#daily-bars");
  wrap.innerHTML = "";
  const maxPct = 100;
  for (const d of days) {
    const row = document.createElement("div");
    row.className = "bar-row";
    const pct = d.open_percentage ?? 0;
    row.innerHTML = `
      <span class="bar-label">${d.label ?? d.date}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(pct / maxPct) * 100}%"></span></span>
      <span class="bar-val">${pct.toFixed(0)}% open</span>
    `;
    wrap.appendChild(row);
  }
}

// ---- updates -------------------------------------------------------------
async function hardRefresh() {
  toast("Updating…", "info");
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {
    /* best effort */
  }
  location.reload();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("./sw.js")
    .then((reg) => {
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            toast("New version ready — tap ↻ to update.", "info");
          }
        });
      });
    })
    .catch(() => {});
}

// ---- boot ----------------------------------------------------------------
function boot() {
  $("#app-version").textContent = "v" + APP_VERSION;
  console.info("Breathing Monitor v" + APP_VERSION);
  $("#refresh-btn").addEventListener("click", hardRefresh);
  registerServiceWorker();

  initTabs((name) => {
    if (name === "stats") loadStatistics();
    if (name === "config") populateConfigForm();
    if (name === "calibrate") refreshCalibrateUI();
  });
  bindConfigForm();
  initCalibrate();

  $("#toggle-btn").addEventListener("click", () => {
    if (pipeline) {
      stopMonitoring();
      toast("Monitoring stopped", "info");
    } else {
      startMonitoring();
    }
  });
  $("#stats-refresh").addEventListener("click", loadStatistics);

  // Live feedback resolution toggle (Seconds/Minutes).
  const liveSeg = $("#live-seg");
  liveSeg.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.live === liveRes);
    b.addEventListener("click", () => {
      liveRes = b.dataset.live;
      localStorage.setItem("bm.live.res", liveRes);
      liveSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      renderLive();
    });
  });
  renderLiveViews();

  // Graph resolution selector (hour/day/week/month).
  const seg = $("#res-seg");
  seg.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.res === currentResolution);
    b.addEventListener("click", () => {
      currentResolution = b.dataset.res;
      localStorage.setItem("bm.stats.res", currentResolution);
      seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      loadStatistics();
    });
  });

  // Stop cleanly on unload so camera + uploads flush.
  window.addEventListener("pagehide", () => {
    if (uploader) uploader.flush(true);
  });

  if (!window.isSecureContext) {
    toast("Camera needs HTTPS or localhost. Detection may not start here.", "warn");
  }

  // Ask the browser to keep our on-device stats from being evicted.
  localStore.requestPersistence().catch(() => {});
}

boot();
