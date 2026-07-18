// App orchestrator — wires the tabs, the monitor controls, the pipeline, the
// notifier, the uploader and the statistics view together.

import { FaceSensor } from "./vision/faceSensor.js";
import { Pipeline } from "./pipeline/pipeline.js";
import { MetadataUploader } from "./storage/uploader.js";
import { Notifier } from "./notifications.js";
import { PreviewRenderer } from "./ui/overlay.js";
import { initTabs } from "./ui/tabs.js";
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

    pipeline = new Pipeline(sensor, {
      openThreshold: settings.detection.openThreshold,
      closeThreshold: settings.detection.closeThreshold,
      minOpenSeconds: settings.detection.minOpenSeconds,
      minClosedSeconds: settings.detection.minClosedSeconds,
    });

    notifier = new Notifier(settings.notifications, toast);
    if (settings.notifications.enabled) await notifier.requestPermission();

    const sessionId = newSessionId();
    if (settings.cloud.uploadEnabled) {
      uploader = new MetadataUploader({
        apiBase: settings.cloud.apiBase,
        sessionId,
        clientId: getClientId(),
      });
      uploader.start();
    }

    pipeline.on("frame", onFrame);
    pipeline.on("change", onChange);

    await pipeline.start();

    preview = new PreviewRenderer($("#preview"));
    preview.attach(sensor.videoElement);

    // Periodic rollup upload for cross-day aggregation.
    if (uploader) {
      rollupTimer = setInterval(() => {
        uploader.enqueueRollup(pipeline.snapshot());
      }, (settings.cloud.rollupSeconds || 30) * 1000);
    }
    statusTimer = setInterval(refreshStats, 1000);

    btn.textContent = "Stop monitoring";
    btn.classList.add("stop");
    btn.disabled = false;
    $("#status-dot").classList.add("live");
    $("#cal-hint").textContent = "Live — open and close your mouth to calibrate.";
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
  if (rollupTimer) clearInterval(rollupTimer), (rollupTimer = null);
  if (statusTimer) clearInterval(statusTimer), (statusTimer = null);
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
}

function onFrame(result) {
  // Draw the face box + lip/nose landmarks over the preview video.
  if (preview) preview.setResult(result);

  const indicator = $("#indicator");
  const mar = result.lips ? result.lips.mar.toFixed(3) : "—";
  const state = result.state;

  indicator.dataset.state = state;
  $("#indicator-label").textContent =
    state === "open" ? "OPEN" : state === "closed" ? "CLOSED" : "…";
  $("#mar-value").textContent = mar;
  $("#face-status").textContent = result.face ? "face detected" : "no face";

  // Feed the Calibrate tab's live readout (cheap even when that tab is hidden).
  lastMar = result.lips ? result.lips.mar : null;
  $("#cal-mar").textContent = lastMar != null ? lastMar.toFixed(3) : "—";
  $("#cal-state").textContent = state;
  $("#cal-fill").style.width = (lastMar != null ? marPct(lastMar) : 0) + "%";

  // Experimental nose-breathing signal (auto-scaled bar).
  updateNarMeter(result.nose ? result.nose.nar : null);

  if (notifier && pipeline) {
    const tis = pipeline.smoother.timeInState(result.timestamp);
    notifier.onState(state, tis);
  }
}

function onChange(change) {
  if (uploader) uploader.enqueueChange(change);
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
  $("#stat-open-pct").textContent = s.openPercentage + "%";
  $("#stat-changes").textContent = s.totalChanges;
  $("#stat-open-s").textContent = s.totalOpenSeconds.toFixed(0) + "s";
  $("#stat-closed-s").textContent = s.totalClosedSeconds.toFixed(0) + "s";
  $("#stat-face-rate").textContent = Math.round(s.faceDetectionRate * 100) + "%";
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
  const base = (settings.cloud.apiBase || "").replace(/\/$/, "");
  status.textContent = "Loading…";
  try {
    const res = await fetch(`${base}/api/stats/daily?days=30`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderDaily(data.days || []);
    renderTotals(data.totals || {});
    status.textContent = data.days && data.days.length
      ? `Showing ${data.days.length} day(s) from the central store.`
      : "No data yet — start monitoring to populate the central store.";
  } catch (err) {
    status.textContent =
      "Could not reach the central store (" + err.message + "). " +
      "Check the API base in Config, or that the server is running.";
  }
}

function renderTotals(t) {
  $("#agg-days").textContent = t.days ?? 0;
  $("#agg-sessions").textContent = t.sessions ?? 0;
  $("#agg-open-pct").textContent = (t.open_percentage ?? 0).toFixed(1) + "%";
  $("#agg-open-hours").textContent = ((t.total_open_seconds ?? 0) / 3600).toFixed(1) + "h";
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
      <span class="bar-label">${d.date}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(pct / maxPct) * 100}%"></span></span>
      <span class="bar-val">${pct.toFixed(0)}% open</span>
    `;
    wrap.appendChild(row);
  }
}

// ---- boot ----------------------------------------------------------------
function boot() {
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

  // Stop cleanly on unload so camera + uploads flush.
  window.addEventListener("pagehide", () => {
    if (uploader) uploader.flush(true);
  });

  if (!window.isSecureContext) {
    toast("Camera needs HTTPS or localhost. Detection may not start here.", "warn");
  }
}

boot();
