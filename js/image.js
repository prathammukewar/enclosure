// Renders a position to a PNG with the current theme colors.
import { N, BLUE, RED, formatArea } from './engine.js';

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function boardSVG(g, size = 1000) {
  const c = {
    paper: css('--paper-board') || '#f7f1e6', grid: css('--grid') || '#2b2722', gridOp: css('--grid-op') || '0.5',
    blue: css('--blue') || '#2440f0', red: css('--red') || '#dd2738', core: css('--core') || '#fff', faceOp: css('--face-op') || '0.17',
  };
  const col = [c.blue, c.red];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-0.8 -0.8 19.6 19.6">`;
  s += `<rect x="-0.8" y="-0.8" width="19.6" height="19.6" fill="${c.paper}"/>`;
  s += `<g stroke="${c.grid}" stroke-opacity="${c.gridOp}" stroke-width="0.035">`;
  for (let i = 0; i < N; i++) s += `<line x1="${i}" y1="0" x2="${i}" y2="18"/><line x1="0" y1="${i}" x2="18" y2="${i}"/>`;
  s += '</g>';
  for (const x of [3, 9, 15]) for (const y of [3, 9, 15]) s += `<circle cx="${x}" cy="${y}" r="0.1" fill="${c.grid}"/>`;
  for (const pl of [BLUE, RED]) {
    const faces = g.analysis(pl).faces;
    s += `<g fill="${col[pl]}" opacity="${c.faceOp}">`;
    for (const f of faces) s += `<path d="M${f.pts.map((p) => `${p[0].toFixed(3)} ${p[1].toFixed(3)}`).join('L')}Z"/>`;
    s += '</g>';
  }
  for (const e of g.edges.values()) {
    s += `<line x1="${e.ax}" y1="${e.ay}" x2="${e.bx}" y2="${e.by}" stroke="${col[e.owner]}" stroke-width="0.17" stroke-linecap="round"/>`;
    if (g.isFresh(e)) s += `<line x1="${e.ax}" y1="${e.ay}" x2="${e.bx}" y2="${e.by}" stroke="${c.core}" stroke-width="0.06" stroke-linecap="round"/>`;
  }
  for (const pl of [BLUE, RED]) for (const [x, y] of g.nodesOf(pl)) s += `<circle cx="${x}" cy="${y}" r="0.21" fill="${col[pl]}" stroke="${c.paper}" stroke-width="0.06"/>`;
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
  const col = [css('--blue') || '#2440f0', css('--red') || '#dd2738'];
  ctx.font = `54px ${hand}`;
  for (const pl of [0, 1]) {
    const x = pl ? W - 120 : 120;
    ctx.textAlign = pl ? 'right' : 'left';
    ctx.fillStyle = col[pl];
    ctx.fillText(Math.round(g.scores[pl]).toLocaleString(), x, 160);
    ctx.font = `26px Inter, system-ui, sans-serif`;
    ctx.fillStyle = css('--muted') || '#6d665b';
    ctx.fillText(`${names[pl]} · ${formatArea(g.areas[pl])} area`, x, 112);
    ctx.font = `54px ${hand}`;
  }
  ctx.textAlign = 'center';
  ctx.font = '24px Inter, system-ui, sans-serif';
  ctx.fillStyle = css('--muted') || '#6d665b';
  ctx.fillText(g.over ? 'Final position' : `After edge ${g.placed} of 120`, W / 2, 150);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('no blob'))), 'image/png'));
}
