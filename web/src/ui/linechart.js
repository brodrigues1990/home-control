// A small SVG line chart for the dashboard: one y-axis, 2px lines with ringed end dots and
// direct labels, a crosshair that snaps to the time under the pointer and one tooltip that
// lists every series there. `compact` drops the axes and labels (a sparkline).
const NS = 'http://www.w3.org/2000/svg';
const SURFACE = '#0f1320';
const node = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The reading of a series at time `t`: the last one at or before it. */
export function valueAt(points, t) {
  let lo = 0;
  let hi = points.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= t) { found = points[mid][1]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** A round top for the y-axis: 1, 2 or 5 times a power of ten. */
export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v);
}

export function createLineChart({ height = 132, yMax = null, format = String, compact = false, label = 'Chart' }) {
  const el = document.createElement('div');
  el.className = `lc${compact ? ' compact' : ''}`;
  const tip = document.createElement('div');
  tip.className = 'lc-tip';
  tip.hidden = true;
  const table = document.createElement('table');
  table.className = 'sr-only';
  el.append(tip, table);
  let drawn = null;

  function render(series, t0, t1) {
    const width = el.clientWidth;
    el.querySelector('svg')?.remove();
    if (!width || t1 <= t0) return;
    const pad = compact ? { l: 0, r: 0, t: 4, b: 4 } : { l: 34, r: 74, t: 8, b: 18 };
    const top = yMax ?? niceMax(Math.max(0, ...series.flatMap((s) => s.points.map((p) => p[1]))) * 1.1);
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;
    const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * plotW;
    const y = (v) => pad.t + (1 - Math.min(v, top) / top) * plotH;
    const svg = node('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });

    if (!compact) {
      for (const v of [0, top / 2, top]) {
        svg.append(node('line', { x1: pad.l, x2: pad.l + plotW, y1: y(v), y2: y(v), class: 'lc-grid' }));
        const t = node('text', { x: pad.l - 6, y: y(v) + 3.5, class: 'lc-axis', 'text-anchor': 'end' });
        t.textContent = format(v);
        svg.append(t);
      }
      [[t0, 'start'], [(t0 + t1) / 2, 'middle'], [t1, 'end']].forEach(([t, anchor], i) => {
        const text = node('text', { x: x(t), y: height - 4, class: 'lc-axis', 'text-anchor': anchor });
        text.textContent = i === 2 ? 'now' : clock(t);
        svg.append(text);
      });
    }

    const ends = [];
    for (const s of series) {
      const inside = s.points.filter((p) => p[0] >= t0 && p[0] <= t1);
      const before = valueAt(s.points, t0);
      const pts = before != null ? [[t0, before], ...inside] : inside;
      if (!pts.length) continue;
      const last = pts[pts.length - 1][1];
      pts.push([t1, last]); // the latest reading holds until now
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
      svg.append(node('path', { d, class: 'lc-line', stroke: s.color }));
      ends.push({ s, v: last, y: y(last) });
    }

    if (!compact) {
      // Direct labels at the right edge; pushed apart, with a leader line back to the end dot.
      const placed = [...ends].sort((a, b) => a.y - b.y);
      for (let i = 1; i < placed.length; i++) placed[i].ly = Math.max(placed[i].y, (placed[i - 1].ly ?? placed[i - 1].y) + 13);
      placed[0] && (placed[0].ly = placed[0].ly ?? placed[0].y);
      const overflow = (placed.at(-1)?.ly ?? 0) - (height - pad.b);
      if (overflow > 0) placed.forEach((p) => { p.ly -= overflow; });
      for (const e of placed) {
        const ex = x(t1);
        if (Math.abs(e.ly - e.y) > 1.5) svg.append(node('line', { x1: ex + 5, y1: e.y, x2: ex + 12, y2: e.ly, class: 'lc-leader' }));
        svg.append(node('circle', { cx: ex, cy: e.y, r: 4, fill: e.s.color, stroke: SURFACE, 'stroke-width': 2 }));
        const text = node('text', { x: ex + 14, y: e.ly + 3.5, class: 'lc-label' });
        const name = node('tspan', { class: 'lc-label-name' });
        name.textContent = `${e.s.name} `;
        const value = node('tspan');
        value.textContent = format(e.v);
        text.append(name, value);
        svg.append(text);
      }
    }

    // The crosshair: the whole plot is the hit target, so the pointer only has to find a time.
    const hair = node('line', { y1: pad.t, y2: pad.t + plotH, class: 'lc-hair', visibility: 'hidden' });
    const dots = series.map((s) => node('circle', { r: 4, fill: s.color, stroke: SURFACE, 'stroke-width': 2, visibility: 'hidden' }));
    const hit = node('rect', { x: pad.l, y: 0, width: plotW, height, fill: 'transparent' });
    svg.append(hair, ...dots, hit);
    const hide = () => { tip.hidden = true; hair.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); };
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('pointermove', (ev) => {
      const box = svg.getBoundingClientRect();
      const px = Math.min(pad.l + plotW, Math.max(pad.l, ev.clientX - box.left));
      const t = t0 + ((px - pad.l) / plotW) * (t1 - t0);
      hair.setAttribute('x1', px);
      hair.setAttribute('x2', px);
      hair.setAttribute('visibility', 'visible');
      const rows = [];
      series.forEach((s, i) => {
        const v = valueAt(s.points, t);
        if (v == null) { dots[i].setAttribute('visibility', 'hidden'); return; }
        dots[i].setAttribute('cx', px);
        dots[i].setAttribute('cy', y(v));
        dots[i].setAttribute('visibility', 'visible');
        rows.push([s, v]);
      });
      for (const extra of drawn?.extraRows?.(t) || []) rows.push(extra);
      const head = document.createElement('div');
      head.className = 'lc-tip-time';
      head.textContent = clock(t);
      tip.replaceChildren(head, ...rows.map(([s, v]) => {
        const row = document.createElement('div');
        row.className = 'lc-tip-row';
        const key = document.createElement('i');
        key.style.background = s.color || 'transparent';
        const value = document.createElement('b');
        value.textContent = format(v);
        const name = document.createElement('span');
        name.textContent = s.name;
        row.append(key, value, name);
        return row;
      }));
      tip.hidden = false;
      const left = px + 12 + tip.offsetWidth > width ? px - 12 - tip.offsetWidth : px + 12;
      tip.style.left = `${Math.max(0, left)}px`;
    });

    svg.setAttribute('aria-label', `${label}: ${ends.map((e) => `${e.s.name} ${format(e.v)}`).join(', ')}`);
    el.prepend(svg);

    // The same numbers without a chart: now, low, average and high of each series.
    const head = document.createElement('tr');
    for (const c of ['Series', 'Now', 'Low', 'Average', 'High']) { const th = document.createElement('th'); th.textContent = c; head.append(th); }
    table.replaceChildren(head, ...series.map((s) => {
      const values = s.points.filter((p) => p[0] >= t0).map((p) => p[1]);
      const tr = document.createElement('tr');
      const cells = [s.name, ...(values.length ? [values.at(-1), Math.min(...values), values.reduce((a, b) => a + b, 0) / values.length, Math.max(...values)].map(format) : ['–', '–', '–', '–'])];
      for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.append(td); }
      return tr;
    }));
  }

  return {
    el,
    render(series, t0, t1, extraRows = null) {
      drawn = { extraRows };
      render(series, t0, t1);
    },
  };
}
