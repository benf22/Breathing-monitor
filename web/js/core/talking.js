// Vision-only talking detection (Visual Voice Activity Detection).
//
// Speech oscillates the mouth rapidly and irregularly at the syllabic rate
// (~2-7 Hz); breathing does not. So we don't classify a single frame — we look
// at the DYNAMICS of MAR over a short sliding window:
//
//   * amplitude  — standard deviation of MAR in the window (mouth must actually
//                  be moving; excludes steady breathing).
//   * rate       — mean-crossings per second of MAR (open<->close cycles);
//                  fast oscillation = speech.
//
// A frame is "talking" when both exceed sensitivity-derived thresholds, with a
// short onset delay and a hold time so brief inter-word pauses don't flicker it
// off. Pure and deterministic (feed it timestamps + MAR).
//
// Limitation: vision alone cannot perfectly separate talking from chewing /
// laughing / yawning. Chewing is slower (~1-2 Hz) so usually stays below the
// rate threshold, but this is a heuristic, not ground truth.

export const DEFAULT_TALKING = Object.freeze({
  enabled: true,
  sensitivity: 0.5, // 0..1; higher = flags talking more readily
  windowMs: 1500,
  onsetMs: 200, // must look like talking this long before flagging
  holdMs: 700, // stays flagged this long after the last talking evidence
});

export class TalkingDetector {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULT_TALKING, ...cfg };
    this.reset();
  }

  setConfig(cfg) {
    this.cfg = { ...this.cfg, ...cfg };
  }

  reset() {
    this._buf = []; // [{ t, mar }]
    this._active = false;
    this._rawStartT = null;
    this._lastRawT = 0;
    this._score = 0;
  }

  _thresholds() {
    const s = Math.max(0, Math.min(1, this.cfg.sensitivity));
    // Higher sensitivity → lower thresholds.
    return { rate: 5 - 3 * s, minStd: 0.05 - 0.03 * s };
  }

  /**
   * Advance the detector. `mar` is null on frames with no usable mouth signal
   * (those aren't added, and an active flag decays via holdMs).
   * @returns {boolean} whether talking is currently detected
   */
  update(t, mar) {
    if (!this.cfg.enabled) {
      this._active = false;
      this._score = 0;
      return false;
    }
    if (mar != null) this._buf.push({ t, mar });
    const from = t - this.cfg.windowMs;
    while (this._buf.length && this._buf[0].t < from) this._buf.shift();

    let raw = false;
    if (this._buf.length >= 4) {
      const vals = this._buf.map((b) => b.mar);
      const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
      const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
      const std = Math.sqrt(variance);

      // Count mean-crossings, ignoring tiny jitter around the mean.
      const gate = 0.01;
      let crossings = 0;
      let prevSign = 0;
      for (const v of vals) {
        const d = v - mean;
        if (Math.abs(d) < gate) continue;
        const sign = d > 0 ? 1 : -1;
        if (prevSign !== 0 && sign !== prevSign) crossings += 1;
        prevSign = sign;
      }
      const durSec = Math.max(0.5, (this._buf[this._buf.length - 1].t - this._buf[0].t) / 1000);
      const rate = crossings / durSec;
      this._score = rate;

      const { rate: rateThr, minStd } = this._thresholds();
      raw = std >= minStd && rate >= rateThr;
    } else {
      this._score = 0;
    }

    if (raw) {
      if (this._rawStartT == null) this._rawStartT = t;
      this._lastRawT = t;
      if (t - this._rawStartT >= this.cfg.onsetMs) this._active = true;
    } else {
      this._rawStartT = null;
      if (this._active && t - this._lastRawT >= this.cfg.holdMs) this._active = false;
    }
    return this._active;
  }

  get isTalking() {
    return this._active;
  }
  get score() {
    return this._score;
  }
}
