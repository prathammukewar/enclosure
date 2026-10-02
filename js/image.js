// Renders a position to a PNG with the current theme colors.
import { formatArea } from './engine.js';
import { starPoints } from './board.js';

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function boardSVG(g, size = 1000) {
  const c = {
    paper: css('--paper-board') || '#f7f1e6', grid: css('--grid') || '#2b2722', gridOp: css('--grid-op') || '0.5',
    core: css('--core') || '#fff', faceOp: css('--face-op') || '0.17',
  };
  const col = [0, 1, 2, 3].map((i) => css(`--c${i}`) || ['#2440f0', '#dd2738', '#12873d', '#b07d00'][i]);
  const S = g.S, B = S - 1, V = S + 0.6;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-0.8 -0.8 ${V} ${V}">`;
  s += `<rect x="-0.8" y="-0.8" width="${V}" height="${V}" fill="${c.paper}"/>`;
  s += `<g stroke="${c.grid}" stroke-opacity="${c.gridOp}" stroke-width="0.035">`;
  for (let i = 0; i < S; i++) s += `<line x1="${i}" y1="0" x2="${i}" y2="${B}"/><line x1="0" y1="${i}" x2="${B}" y2="${i}"/>`;
  s += '</g>';
  const stars = starPoints(S);
  for (const x of stars) for (const y of stars) s += `<circle cx="${x}" cy="${y}" r="0.1" fill="${c.grid}"/>`;
  for (let pl = 0; pl < g.NP; pl++) {
    const faces = g.analysis(pl).faces;
    s += `<g fill="${col[pl]}" opacity="${c.faceOp}">`;
    for (const f of faces) s += `<path d="M${f.pts.map((p) => `${p[0].toFixed(3)} ${p[1].toFixed(3)}`).join('L')}Z"/>`;
    s += '</g>';
  }
  for (const e of g.edges.values()) {
    s += `<line x1="${e.ax}" y1="${e.ay}" x2="${e.bx}" y2="${e.by}" stroke="${col[e.owner]}" stroke-width="0.17" stroke-linecap="round"/>`;
    if (g.isFresh(e)) s += `<line x1="${e.ax}" y1="${e.ay}" x2="${e.bx}" y2="${e.by}" stroke="${c.core}" stroke-width="0.06" stroke-linecap="round"/>`;
  }
  for (let pl = 0; pl < g.NP; pl++) for (const [x, y] of g.nodesOf(pl)) s += `<circle cx="${x}" cy="${y}" r="0.21" fill="${col[pl]}" stroke="${c.paper}" stroke-width="0.06"/>`;
  return s + '</svg>';
}

export async function boardImage(g, names) {
  const W = 1080, H = 1240, B = 1000;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = css('--paper') || '#f4ede1';
  ctx.fillRect(0, 0, W, H);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([boardSVG(g, B)], { type: 'image/svg+xml' }));
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  ctx.drawImage(img, (W - B) / 2, 200, B, B);
  URL.revokeObjectURL(url);
  try { await document.fonts.load('48px "Patrick Hand"'); } catch { /* fall back */ }
  const hand = '"Patrick Hand", "Comic Sans MS", sans-serif';
  ctx.fillStyle = css('--ink') || '#1e1b17';
  ctx.font = `64px ${hand}`;
  ctx.textAlign = 'center';
  ctx.fillText('Enclosure', W / 2, 78);
  const col = [0, 1, 2, 3].map((i) => css(`--c${i}`) || ['#2440f0', '#dd2738', '#12873d', '#b07d00'][i]);
  const n = g.NP;
  for (let pl = 0; pl < n; pl++) {
    // Two players: left and right. More: spread across the top.
    const x = n === 2 ? (pl ? W - 120 : 120) : 90 + (pl * (W - 180)) / (n - 1);
    ctx.textAlign = n === 2 ? (pl ? 'right' : 'left') : 'center';
    ctx.fillStyle = col[pl];
    ctx.font = `${n > 2 ? 44 : 54}px ${hand}`;
    ctx.fillText(Math.round(g.scores[pl]).toLocaleString(), x, 165);
    ctx.font = `${n > 2 ? 20 : 26}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = css('--muted') || '#6d665b';
    ctx.fillText(`${names[pl] || ''} · ${formatArea(g.areas[pl])}`, x, 118);
  }
  ctx.textAlign = 'center';
  ctx.font = '22px Inter, system-ui, sans-serif';
  ctx.fillStyle = css('--muted') || '#6d665b';
  if (n === 2) ctx.fillText(g.over ? 'Final position' : `After edge ${g.placed} of ${g.totalEdges}`, W / 2, 150);
  else ctx.fillText(g.over ? 'Final position' : `After edge ${g.placed} of ${g.totalEdges}`, W / 2, 1228);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('no blob'))), 'image/png'));
}
