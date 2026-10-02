// Score and area over the game, as a small SVG chart.
import { formatArea } from './engine.js';

export function renderChart(el, timeline, total = 61) {
  const W = 320, H = 190, padL = 34, padR = 8, padT = 10, splitY = 120, padB = 18;
  const n = Math.max(timeline.length, 1);
  const maxScore = Math.max(10, ...timeline.flatMap((t) => t.scores));
  const maxArea = Math.max(4, ...timeline.flatMap((t) => t.areas));
  const X = (i) => padL + (i / Math.max(total, n)) * (W - padL - padR);
  const Ys = (v) => splitY - 8 - (v / maxScore) * (splitY - 8 - padT);
  const Ya = (v) => H - padB - (v / maxArea) * (H - padB - splitY - 6);
  const line = (pl, f) => timeline.map((t, i) => `${i ? 'L' : 'M'}${X(i + 1).toFixed(1)} ${f(pl === 0 ? t.scores[0] : t.scores[1]).toFixed(1)}`).join('');
  const area = (pl) => {
    if (!timeline.length) return '';
    let d = `M${X(1).toFixed(1)} ${Ya(0).toFixed(1)}`;
    timeline.forEach((t, i) => { d += `L${X(i + 1).toFixed(1)} ${Ya(t.areas[pl]).toFixed(1)}`; });
    d += `L${X(timeline.length).toFixed(1)} ${Ya(0).toFixed(1)}Z`;
    return d;
  };
  const last = timeline[timeline.length - 1];
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Score chart${last ? `: Blue ${Math.round(last.scores[0])}, Red ${Math.round(last.scores[1])}` : ''}">
    <line class="ax" x1="${padL}" y1="${Ys(0)}" x2="${W - padR}" y2="${Ys(0)}"/>
    <line class="ax" x1="${padL}" y1="${Ya(0)}" x2="${W - padR}" y2="${Ya(0)}"/>
    <text x="2" y="${Ys(maxScore) + 4}">${Math.round(maxScore)}</text>
    <text x="2" y="${Ys(0) + 3}">0</text>
    <text x="2" y="${Ya(maxArea) + 6}">${formatArea(Math.round(maxArea))}</text>
    <text x="${padL}" y="${splitY + 2}">area held</text>
    <text x="${padL}" y="${padT + 2}">score</text>
    <text x="${W - padR}" y="${H - 4}" text-anchor="end">turn ${timeline.length} of ${total}</text>
    <path class="ar-b" d="${area(0)}"/><path class="ar-r" d="${area(1)}"/>
    <path class="ln-b" d="${line(0, Ys)}"/><path class="ln-r" d="${line(1, Ys)}"/>
  </svg>`;
}
