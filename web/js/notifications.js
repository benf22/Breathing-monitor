// User notifications for the Monitor tab.
//
// Two channels, both driven off the pipeline's state:
//   * In-page toasts (always available).
//   * Web Notifications (when the user grants permission) so alerts surface even
//     when the tab isn't focused — e.g. you're working in another window.
//
// Rules (configurable in Config):
//   * Mouth-open alert: fires when the smoothed state has been OPEN continuously
//     for `mouthOpenAlertSeconds` (a nudge toward nasal breathing).
//   * Breathing reminder: periodic "take a breathing break" every N minutes.

import { LipState } from "./core/types.js";

export class Notifier {
  /**
   * @param {Object} cfg notifications settings block
   * @param {(msg:string, level?:string)=>void} toast in-page toast callback
   */
  /**
   * @param {Object} cfg notifications settings block
   * @param {(msg:string, level?:string)=>void} toast in-page toast callback
   * @param {(text:string)=>void} [remote] optional cross-device sender (ntfy)
   */
  constructor(cfg, toast, remote) {
    this.cfg = cfg;
    this.toast = toast;
    this.remote = remote;
    this._openAlertFired = false;
    this._lastReminder = Date.now();
  }

  updateConfig(cfg) {
    this.cfg = cfg;
  }

  async requestPermission() {
    if (!("Notification" in window)) return "unsupported";
    if (Notification.permission === "default") {
      try {
        return await Notification.requestPermission();
      } catch {
        return Notification.permission;
      }
    }
    return Notification.permission;
  }

  _system(title, body) {
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(title, { body, tag: "breathing-monitor" });
      } catch {
        /* some browsers require a SW registration; toast still covers it */
      }
    }
  }

  notify(title, body, level = "info") {
    this.toast(`${title} — ${body}`, level);
    this._system(title, body);
    if (this.remote) {
      try {
        this.remote(`${title}: ${body}`);
      } catch {
        /* best effort */
      }
    }
  }

  /** Called on every pipeline frame with the current smoothed state + duration. */
  onState(state, timeInStateSeconds) {
    if (!this.cfg.enabled) return;

    // Mouth-open (mouth-breathing) sustained alert.
    if (state === LipState.OPEN) {
      const threshold = this.cfg.mouthOpenAlertSeconds ?? 0;
      if (threshold > 0 && timeInStateSeconds >= threshold && !this._openAlertFired) {
        this._openAlertFired = true;
        this.notify(
          "Mouth open a while",
          `Open for ${Math.round(timeInStateSeconds)}s — try breathing through your nose.`,
          "warn"
        );
      }
    } else {
      this._openAlertFired = false;
    }

    // Periodic breathing-break reminder.
    const mins = this.cfg.breathingReminderMinutes ?? 0;
    if (mins > 0 && Date.now() - this._lastReminder >= mins * 60_000) {
      this._lastReminder = Date.now();
      this.notify("Breathing break", "Take a slow, deep breath.", "info");
    }
  }

  resetTimers() {
    this._openAlertFired = false;
    this._lastReminder = Date.now();
  }

  /**
   * Called on ignored frames: fire nothing, and re-arm the sustained-open alert
   * so a run interrupted by an ignored gap can alert again once it resumes. Does
   * not touch the periodic-reminder timer.
   */
  suppress() {
    this._openAlertFired = false;
  }
}
