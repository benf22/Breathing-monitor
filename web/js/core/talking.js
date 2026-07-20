// Vision-only talking detection (Visual Voice Activity Detection).
//
// Speech oscillates the mouth rapidly and irregularly at the syllabic rate
// (~2-7 Hz); breathing does not. So we don't classify a single frame — we look
// at the DYNAMICS of MAR over a short sliding window.
//
// Earlier versions counted mean-crossings per second ("rate"). That fails at
// our real capture rate: at ~5 fps (200 ms/frame) the sampling is slower than
// the speech oscillation itself, so open/close cycles alias and the crossing
// count collapses — talking never fired even at max sensitivity.
//
// Instead we use the mean absolute successive difference (MASD): the average
// frame-to-frame jump in MAR across the window. Talking keeps moving the mouth
// between consecutive samples, so |Δ| stays large regardless of the underlying
// frequency; steady breathing keeps |Δ| near zero. This is robust to
// undersampling because it never assumes we resolve the oscillation — it only
// asks "is the mouth still changing a lot between frames?".
//
// A frame is "talking" when MASD exceeds a sensitivity-derived threshold, with
// a short onset delay and a hold time so brief inter-word pauses don't flicker
// it off. Pure and deterministic (feed it timestamps + MAR).
//
// Limitation: vision alone cannot perfectly separate talking from chewing /
// laughing / yawning. A slow, smooth yawn changes MAR gradually (small
// per-frame jumps) so it stays below threshold, but this is a heuristic, not
// ground truth.

export const DEFAULT_TALKING = Object.freeze({
  enabled: true,
  sensitivity: 0.5, // 0..1; higher = flags talking more readily
  windowMs: 1200,
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
    // Higher sensitivity → lower MASD threshold. At s=0 needs a big per-frame
    // jump (~0.09 MAR units); at s=1 a small one (~0.02) flags talking.
    return { diff: 0.09 - 0.07 * s };
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
    if (this._buf.length >= 3) {
      const vals = this._buf.map((b) => b.mar);
      // Mean absolute successive difference: average |Δ| between consecutive
      // frames. Large while the mouth keeps moving (speech), ~0 when steady.
      let sum = 0;
      for (let i = 1; i < vals.length; i++) sum += Math.abs(vals[i] - vals[i - 1]);
      const masd = sum / (vals.length - 1);
      this._score = masd;

      raw = masd >= this._thresholds().diff;
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
