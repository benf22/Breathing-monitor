// Minimal single-series line chart (inline SVG, no dependencies).
//
// Design per the dataviz method: one measure = one axis, thin 2px line,
// recessive grid/axes in muted ink, a single semantic hue (the heading names
// the series so no legend is needed), a selective direct label on the last
// point, and a touch/hover crosshair+tooltip. Theme-aware via CSS vars.

const W = 320, H = 150;
const PAD = { l: 34, r: 12, t: 12, b: 26 };
const PLOT_W = W - PAD.l - PAD.r;
const PLOT_H = H - PAD.t - PAD.b;

function niceMax(v) {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

const shortDate = (iso) => iso.slice(5); // YYYY-MM-DD -> MM-DD
const labelOf = (d) => d.label ?? shortDate(d.date);

/**
 * @param {HTMLElement} container
 * @param {{date:string, value:number}[]} series
 * @param {{color:string, yMax?:number, unit?:string, fmt?:(v:number)=>string}} opts
 */
export function lineChart(container, series, opts) {
  const { color, unit = "", fmt = (v) => String(v) } = opts;
  container.style.position = "relative";

  if (!series || series.length === 0) {
    container.innerHTML = `<div class="empty">No data yet — record a few sessions.</div>`;
    return;
  }

  const yMax = opts.yMax ?? niceMax(Math.max(...series.map((d) => d.value)));
  const n = series.length;
  const x = (i) => (n === 1 ? PAD.l + PLOT_W / 2 : PAD.l + (i / (n - 1)) * PLOT_W);
  const y = (v) => PAD.t + PLOT_H - (Math.min(v, yMax) / yMax) * PLOT_H;

  // Recessive horizontal gridlines + y labels at 0, half, max.
  const grid = [0, 0.5, 1]
    .map((f) => {
      const val = yMax * f;
      const yy = y(val);
      return `<line x1="${PAD.l}" y1="${yy}" x2="${W - PAD.r}" y2="${yy}" class="c-grid"/>
              <text x="${PAD.l - 5}" y="${yy + 3}" class="c-axis" text-anchor="end">${fmt(val)}</text>`;
    })
    .join("");

  const pts = series.map((d, i) => `${x(i)},${y(d.value)}`).join(" ");
  const line =
    n === 1
      ? ""
      : `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const dots = series
    .map(
      (d, i) =>
        `<circle cx="${x(i)}" cy="${y(d.value)}" r="3" fill="${color}" stroke="var(--panel)" stroke-width="1.5"/>`
    )
    .join("");

  // x labels: first and last only (sparse) to avoid collisions on mobile.
  const xLabels =
    n === 1
      ? `<text x="${x(0)}" y="${H - 8}" class="c-axis" text-anchor="middle">${labelOf(series[0])}</text>`
      : `<text x="${PAD.l}" y="${H - 8}" class="c-axis" text-anchor="start">${labelOf(series[0])}</text>
         <text x="${W - PAD.r}" y="${H - 8}" class="c-axis" text-anchor="end">${labelOf(series[n - 1])}</text>`;

  // Selective direct label on the last point.
  const last = series[n - 1];
  const lx = x(n - 1);
  const label = `<text x="${lx}" y="${y(last.value) - 7}" class="c-label" text-anchor="${n === 1 ? "middle" : "end"}">${fmt(last.value)}${unit}</text>`;

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="line chart">
      ${grid}
      <line class="c-cross" x1="0" y1="${PAD.t}" x2="0" y2="${PAD.t + PLOT_H}" style="display:none"/>
      ${line}${dots}${label}${xLabels}
    </svg>
    <div class="chart-tip" style="display:none"></div>`;

  wireTooltip(container, series, { x, y, unit, fmt });
}

function wireTooltip(container, series, { x, y, unit, fmt }) {
  const svg = container.querySelector("svg");
  const cross = container.querySelector(".c-cross");
  const tip = container.querySelector(".chart-tip");
  const n = series.length;

  function locate(clientX) {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / W;
    const relX = (clientX - rect.left) / scale; // into viewBox units
    let i = 0;
    if (n > 1) {
      const f = (relX - PAD.l) / PLOT_W;
      i = Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
    }
    return i;
  }

  function show(clientX) {
    const i = locate(clientX);
    const d = series[i];
    const px = x(i), py = y(d.value);
    cross.setAttribute("x1", px);
    cross.setAttribute("x2", px);
    cross.style.display = "";
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / W;
    tip.innerHTML = `<b>${labelOf(d)}</b> ${fmt(d.value)}${unit}`;
    tip.style.display = "";
    // Position within the container (which is position:relative).
    tip.style.left = Math.min(px * scale + 8, rect.width - 90) + "px";
    tip.style.top = Math.max(py * scale - 8, 0) + "px";
  }
  function hide() {
    cross.style.display = "none";
    tip.style.display = "none";
  }

  svg.addEventListener("pointermove", (e) => show(e.clientX));
  svg.addEventListener("pointerdown", (e) => show(e.clientX));
  svg.addEventListener("pointerleave", hide);
}

/**
 * Multi-series line chart with a legend (for ≥2 series, per the dataviz method).
 * @param {{label:string,color:string,points:{t:number,value:number}[]}[]} series
 */
export function multiLineChart(container, series, opts = {}) {
  const unit = opts.unit || "";
  const all = series.flatMap((s) => s.points);
  if (!all.length) {
    container.innerHTML = `<div class="empty">${opts.emptyMsg || "No data yet."}</div>`;
    return;
  }
  const ts = all.map((p) => p.t);
  const vals = all.map((p) => p.value);
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const span = Math.max(1, t1 - t0);
  let mn = Math.min(...vals, 0), mx = Math.max(...vals);
  if (mx - mn < 0.5) mx = mn + 0.5;
  mx += (mx - mn) * 0.1;
  const x = (t) => (ts.length <= 1 ? PAD.l + PLOT_W / 2 : PAD.l + ((t - t0) / span) * PLOT_W);
  const y = (v) => PAD.t + PLOT_H - ((v - mn) / (mx - mn)) * PLOT_H;

  const grid = [mn, (mn + mx) / 2, mx]
    .map((val) => {
      const yy = y(val);
      return `<line x1="${PAD.l}" y1="${yy}" x2="${W - PAD.r}" y2="${yy}" class="c-grid"/>
              <text x="${PAD.l - 5}" y="${yy + 3}" class="c-axis" text-anchor="end">${val.toFixed(1)}</text>`;
    })
    .join("");

  const lines = series
    .map((s) => {
      if (!s.points.length) return "";
      const pts = s.points.map((p) => `${x(p.t)},${y(p.value)}`).join(" ");
      const dots = s.points
        .map((p) => `<circle cx="${x(p.t)}" cy="${y(p.value)}" r="3" fill="${s.color}" stroke="var(--panel)" stroke-width="1.5"/>`)
        .join("");
      const line = s.points.length > 1
        ? `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
        : "";
      return line + dots;
    })
    .join("");

  const xLabels = `<text x="${PAD.l}" y="${H - 8}" class="c-axis" text-anchor="start">${hm(t0)}</text>
                   <text x="${W - PAD.r}" y="${H - 8}" class="c-axis" text-anchor="end">${hm(t1)}</text>`;
  const legend = series
    .map((s) => `<span class="lg-item"><span class="lg-dot" style="background:${s.color}"></span>${s.label}</span>`)
    .join("");

  container.innerHTML = `
    <div class="chart-legend">${legend}</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.aria || "comparison"}">
      ${grid}${lines}${xLabels}
    </svg>`;
}

// hm() is defined below with the live-trace helpers.

// ---- Live trace (real-time feedback) -------------------------------------

const p2 = (n) => String(n).padStart(2, "0");
const hms = (ms) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
const hm = (ms) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };

/**
 * Rolling buffer of the last hour of open/closed state. Stores per-second frame
 * counts of open vs closed; the minute view is derived from the same seconds.
 * A bucket's reported state is its majority (ties → closed); no usable face → gap.
 */
export class LiveTrace {
  constructor(capSeconds = 3600) {
    this.cap = capSeconds;
    this.sec = []; // [{ s: epochSeconds, open, closed }]
  }
  reset() {
    this.sec = [];
  }
  push(ms, state) {
    const s = Math.floor(ms / 1000);
    const last = this.sec[this.sec.length - 1];
    if (last && last.s === s) {
      if (state === "open") last.open += 1;
      else if (state === "closed") last.closed += 1;
    } else {
      this.sec.push({ s, open: state === "open" ? 1 : 0, closed: state === "closed" ? 1 : 0 });
      if (this.sec.length > this.cap) this.sec.shift();
    }
  }
  _nowS() {
    return this.sec.length ? this.sec[this.sec.length - 1].s : Math.floor(Date.now() / 1000);
  }
  seconds(windowSec = 90) {
    const from = this._nowS() - windowSec;
    return this.sec
      .filter((e) => e.s >= from && e.open + e.closed > 0)
      .map((e) => ({ t: e.s * 1000, state: e.open > e.closed ? "open" : "closed" }));
  }
  minutes(windowMin = 60) {
    const byMin = new Map();
    for (const e of this.sec) {
      if (e.open + e.closed === 0) continue;
      const m = Math.floor(e.s / 60);
      const b = byMin.get(m) || { open: 0, closed: 0 };
      b.open += e.open;
      b.closed += e.closed;
      byMin.set(m, b);
    }
    const from = Math.floor(this._nowS() / 60) - windowMin;
    return [...byMin.entries()]
      .filter(([m]) => m >= from)
      .sort((a, b) => a[0] - b[0])
      .map(([m, b]) => ({ t: m * 60000, state: b.open > b.closed ? "open" : "closed" }));
  }
}

const STATE_COLOR = { open: "var(--open)", closed: "var(--closed)", unknown: "#556" };

/**
 * Binary open/closed state timeline as a colored ribbon over time (green =
 * closed, red = open). Clearer real-time feedback than a continuous line.
 */
export function stateRibbon(container, series, opts = {}) {
  const xf = opts.res === "min" ? hm : hms;
  if (!series.length) {
    container.innerHTML = `<div class="empty">${opts.emptyMsg || "Waiting for data…"}</div>`;
    return;
  }
  const unit = opts.res === "min" ? 60000 : 1000;
  const n = series.length;
  const t0 = series[0].t;
  const t1 = series[n - 1].t + unit;
  const span = Math.max(1, t1 - t0);
  const x = (t) => PAD.l + ((t - t0) / span) * PLOT_W;

  const top = PAD.t + 4;
  const bandH = PLOT_H - 6;
  let rects = "";
  for (let i = 0; i < n; i++) {
    const x0 = x(series[i].t);
    const x1 = x(i + 1 < n ? series[i + 1].t : series[i].t + unit);
    rects += `<rect x="${x0}" y="${top}" width="${Math.max(0.6, x1 - x0)}" height="${bandH}" fill="${STATE_COLOR[series[i].state] || STATE_COLOR.unknown}"/>`;
  }
  const xLabels = `<text x="${PAD.l}" y="${H - 8}" class="c-axis" text-anchor="start">${xf(t0)}</text>
                   <text x="${W - PAD.r}" y="${H - 8}" class="c-axis" text-anchor="end">${xf(series[n - 1].t)}</text>`;

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="open/closed timeline">
      ${rects}${xLabels}
    </svg>`;
}

/**
 * Biofeedback-style live line: a value over time, auto-ranged to the recent
 * min/max (so small changes are visible) with a soft area fill. Updated ~2x/s.
 */
export function bioChart(container, series, opts = {}) {
  const unit = opts.unit || "";
  if (!series.length) {
    container.innerHTML = `<div class="empty">${opts.emptyMsg || "Waiting…"}</div>`;
    return;
  }
  const vals = series.map((d) => d.value);
  let mn = Math.min(...vals), mx = Math.max(...vals);
  if (mx - mn < 0.5) { const c = (mx + mn) / 2; mn = Math.max(0, c - 0.25); mx = c + 0.25; }
  const rp = (mx - mn) * 0.12;
  mn = Math.max(0, mn - rp);
  mx += rp;

  const n = series.length;
  const t0 = series[0].t, t1 = series[n - 1].t;
  const span = Math.max(1, t1 - t0);
  const x = (t) => (n === 1 ? PAD.l + PLOT_W : PAD.l + ((t - t0) / span) * PLOT_W);
  const y = (v) => PAD.t + PLOT_H - ((v - mn) / (mx - mn)) * PLOT_H;

  const gridY = [mn, mx]
    .map((val) => {
      const yy = y(val);
      return `<line x1="${PAD.l}" y1="${yy}" x2="${W - PAD.r}" y2="${yy}" class="c-grid"/>
              <text x="${PAD.l - 5}" y="${yy + 3}" class="c-axis" text-anchor="end">${val.toFixed(1)}</text>`;
    })
    .join("");

  const linePts = series.map((d) => `${x(d.t)},${y(d.value)}`).join(" ");
  const area = `<polygon points="${x(t0)},${y(mn)} ${linePts} ${x(t1)},${y(mn)}" fill="var(--accent)" opacity="0.13"/>`;
  const line = `<polyline points="${linePts}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const lastV = series[n - 1].value;
  const lastLbl = `<text x="${W - PAD.r}" y="${Math.max(y(lastV) - 6, PAD.t + 9)}" class="c-label" text-anchor="end">${lastV.toFixed(1)}${unit}</text>`;
  const xLabels = `<text x="${PAD.l}" y="${H - 8}" class="c-axis" text-anchor="start">${hms(t0)}</text>
                   <text x="${W - PAD.r}" y="${H - 8}" class="c-axis" text-anchor="end">${hms(t1)}</text>`;

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="avg closed span biofeedback">
      ${gridY}${area}${line}${lastLbl}${xLabels}
    </svg>`;
}
