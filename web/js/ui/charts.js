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
