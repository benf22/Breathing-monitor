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
}

function onFrame(result) {
  const indicator = $("#indicator");
  const mar = result.lips ? result.lips.mar.toFixed(3) : "—";
  const state = result.state;

  indicator.dataset.state = state;
  $("#indicator-label").textContent =
    state === "open" ? "OPEN" : state === "closed" ? "CLOSED" : "…";
  $("#mar-value").textContent = mar;
  $("#face-status").textContent = result.face ? "face detected" : "no face";

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
function bindConfigForm() {
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
    toast("Settings saved" + (pipeline ? " — restart monitoring to apply capture changes" : ""), "info");
  });

  $("#config-reset").addEventListener("click", () => {
    settings = resetSettings();
    bindConfigForm();
    toast("Settings reset to defaults", "info");
  });
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
  });
  bindConfigForm();

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
