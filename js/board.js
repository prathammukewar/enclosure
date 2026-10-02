// SVG board: draws a Game and turns pointer / keyboard input into edges.
// Works for any board size, reach and number of players. Optional extras:
// zoom and pan, a magnifier while dragging on touch screens, shapes and
// patterns per player, thicker lines and bigger nodes, and overlays for
// reach, risk and the opponent's best cut.

import { pointName, formatArea } from './engine.js';
import { analyzeArea } from './geometry.js';

const COLS = 'abcdefghijklmnopqrstuvwxy';
const SVGNS = 'http://www.w3.org/2000/svg';
let boardCount = 0;

const labelCache = new WeakMap();

function distToEdges(x, y, pts) {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay;
    const L = dx * dx + dy * dy;
    let t = L ? ((x - ax) * dx + (y - ay) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

function inside(x, y, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < xj + (y - yj) * (xi - xj) / (yi - yj)) c = !c;
  }
  return c;
}

// A roomy point inside a face for its area label.
export function labelPoint(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const step = Math.max(0.1, Math.min(x1 - x0, y1 - y0) / 14);
  let best = null, bestD = -1;
  for (let y = y0 + step / 2; y < y1; y += step) {
    for (let x = x0 + step / 2; x < x1; x += step) {
      if (!inside(x, y, pts)) continue;
      const d = distToEdges(x, y, pts);
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
  }
  return best ? { x: best[0], y: best[1], room: bestD } : null;
}

function facesWithLabels(an) {
  let out = labelCache.get(an);
  if (!out) {
    out = an.faces.map((f) => ({ ...f, label: labelPoint(f.pts), key: centroidKey(f.pts) }));
    labelCache.set(an, out);
  }
  return out;
}

function centroidKey(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return Math.round((x / pts.length) * 20) + ':' + Math.round((y / pts.length) * 20);
}

export function starPoints(S) {
  if (S < 11) return [2, (S - 1) / 2, S - 3];
  return [3, (S - 1) / 2, S - 4];
}

const f2 = (v) => Math.round(v * 1000) / 1000;
const facePath = (pts) => 'M' + pts.map(([x, y]) => f2(x) + ' ' + f2(y)).join('L') + 'Z';

// Node shapes for the shapes-and-patterns setting: circle, square,
// triangle, diamond.
function nodeShape(owner, x, y, r, cls, shapes) {
  const kind = shapes ? owner % 4 : 0;
  if (kind === 1) return `<rect class="${cls}" x="${f2(x - r * 0.9)}" y="${f2(y - r * 0.9)}" width="${f2(r * 1.8)}" height="${f2(r * 1.8)}"/>`;
  if (kind === 2) return `<path class="${cls}" d="M${f2(x)} ${f2(y - r * 1.15)}L${f2(x + r * 1.05)} ${f2(y + r * 0.75)}L${f2(x - r * 1.05)} ${f2(y + r * 0.75)}Z"/>`;
  if (kind === 3) return `<path class="${cls}" d="M${f2(x)} ${f2(y - r * 1.2)}L${f2(x + r * 1.2)} ${f2(y)}L${f2(x)} ${f2(y + r * 1.2)}L${f2(x - r * 1.2)} ${f2(y)}Z"/>`;
  return `<circle class="${cls}" cx="${x}" cy="${y}" r="${f2(r)}"/>`;
}

export class Board {
  constructor(el, opts = {}) {
    this.el = el;
    this.uid = `b${++boardCount}`;
    this.opts = {
      coords: true, labels: true, crop: null, animate: true, confirmTaps: false,
      shapes: false, lineScale: 1, nodeScale: 1, zoomable: false, ...opts,
    };
    this.size = 0;
    this.game = null;
    this.canMove = false;
    this.selected = null;
    this.hover = null;
    this.pendingTap = null;
    this.hint = null;
    this.coach = null;
    this.overlay = null;
    this.warning = null;
    this.cursor = null;
    this.scars = [];
    this.onMove = opts.onMove || null;
    this.onPreview = opts.onPreview || null;
    this.prevFaceKeys = [new Set(), new Set(), new Set(), new Set()];
    this.zoom = null;
    this.pointers = new Map();
    this.build(19);
  }

  build(size) {
    this.size = size;
    const S = size;
    const { crop } = this.opts;
    const pad = this.opts.coords && !crop ? 1.15 : 0.62;
    const [x0, y0, x1, y1] = crop || [0, 0, S - 1, S - 1];
    this.view = { x0, y0, x1, y1 };
    this.full = [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
    this.zoom = null;
    this.el.innerHTML = '';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', this.full.join(' '));
    svg.setAttribute('class', 'board-svg');
    svg.innerHTML = `
      <defs>${[0, 1, 2, 3].map((p) => `<pattern id="${this.uid}-hatch${p}" width="0.5" height="0.5" patternUnits="userSpaceOnUse" patternTransform="rotate(${[45, -45, 0, 90][p]})"><rect width="0.5" height="0.5" class="hb-p${p}"/><line x1="0" y1="0" x2="0" y2="0.5" class="hl-p${p}"/></pattern>`).join('')}</defs>
      <style></style>
      <g id="${this.uid}-content">
        <g class="layer-grid"></g>
        <g class="layer-overlay"></g>
        <g class="layer-faces">${[0, 1, 2, 3].map((p) => `<g class="faces faces-p${p}"></g>`).join('')}<g class="faces faces-preview"></g></g>
        <g class="layer-scars"></g>
        <g class="layer-reach"></g>
        <g class="layer-coach"></g>
        <g class="layer-edges"></g>
        <g class="layer-preview"></g>
        <g class="layer-nodes"></g>
        <g class="layer-labels"></g>
        <g class="layer-fx"></g>
        <g class="layer-cursor"></g>
      </g>`;
    this.el.appendChild(svg);
    this.svg = svg;
    this.styleEl = svg.querySelector('style');
    this.layers = {};
    for (const g of svg.querySelectorAll(`#${this.uid}-content > g`)) this.layers[g.getAttribute('class').replace('layer-', '')] = g;
    this.faceGroups = [0, 1, 2, 3].map((p) => svg.querySelector(`.faces-p${p}`));
    this.previewFaces = svg.querySelector('.faces-preview');
    this.applyStyle();
    this.drawGrid();
    if (this.opts.interactive) this.bindInput();
  }

  // Line and node sizes, and patterns, scoped to this board.
  applyStyle() {
    const ls = this.opts.lineScale || 1;
    const id = `#${this.uid}-content`;
    let css = `${id} .edge{stroke-width:${f2(0.17 * ls)}}${id} .core{stroke-width:${f2(0.06 * ls)}}${id} .grid-line{stroke-width:${f2(0.035 * Math.max(1, ls * 0.9))}}`;
    if (this.opts.shapes) {
      for (let p = 0; p < 4; p++) css += `${id} .faces-p${p}{fill:url(#${this.uid}-hatch${p})}`;
    }
    this.styleEl.textContent = css;
  }

  setOptions(o) {
    const rebuild = ('coords' in o && o.coords !== this.opts.coords) || ('crop' in o && JSON.stringify(o.crop) !== JSON.stringify(this.opts.crop));
    Object.assign(this.opts, o);
    if (rebuild) this.build(this.size);
    else this.applyStyle();
    if (this.game) this.render();
  }

  drawGrid() {
    const S = this.size;
    const { x0, y0, x1, y1 } = this.view;
    const ext = this.opts.crop ? 0.6 : 0;
    let s = '';
    for (let i = 0; i < S; i++) {
      const edge = i === 0 || i === S - 1 ? ' grid-edge' : '';
      if (i >= x0 && i <= x1) s += `<line class="grid-line${edge}" x1="${i}" y1="${Math.max(0, y0 - ext)}" x2="${i}" y2="${Math.min(S - 1, y1 + ext)}"/>`;
      if (i >= y0 && i <= y1) s += `<line class="grid-line${edge}" x1="${Math.max(0, x0 - ext)}" y1="${i}" x2="${Math.min(S - 1, x1 + ext)}" y2="${i}"/>`;
    }
    const stars = starPoints(S);
    for (const sx of stars) for (const sy of stars) {
      if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) s += `<circle class="star" cx="${sx}" cy="${sy}" r="0.1"/>`;
    }
    if (this.opts.coords && !this.opts.crop) {
      for (let i = 0; i < S; i++) {
        s += `<text class="coord" x="${i}" y="${S - 1 + 0.82}">${COLS[i]}</text>`;
        s += `<text class="coord" x="-0.78" y="${i + 0.12}">${S - i}</text>`;
      }
    }
    this.layers.grid.innerHTML = s;
  }

  setGame(game, anim = null) {
    if (game.S !== this.size) this.build(game.S);
    this.game = game;
    if (!this.canMove) this.selected = null;
    if (this.selected && !game.hasNode(game.player, this.selected[0], this.selected[1])) this.selected = null;
    this.pendingTap = null;
    this.render(anim);
  }

  setCanMove(v) {
    this.canMove = v;
    this.svg.classList.toggle('can-move', v);
    if (!v) { this.selected = null; this.pendingTap = null; this.hover = null; }
    if (this.game) this.render();
  }

  setHint(m) { this.hint = m; if (this.game) this.renderPreview(); }
  setCoach(c) { this.coach = c; this.renderCoach(); }
  setWarning(w) { this.warning = w; this.renderCoach(); }

  // overlay: null | { kind: 'reach' } | { kind: 'risk', cells: [...] }
  setOverlay(o) { this.overlay = o; this.renderOverlay(); }

  // ----- rendering -----

  render(anim = null) {
    const g = this.game;
    if (!g) return;
    this.renderOverlay();
    this.renderFaces(anim);
    this.layers.scars.innerHTML = (this.scars || []).map((e) => `<line class="scar e-p${e.owner}" x1="${e.ax}" y1="${e.ay}" x2="${e.bx}" y2="${e.by}"/>`).join('');
    this.renderEdges(anim);
    this.renderNodes(anim);
    this.renderReach();
    this.renderCoach();
    this.renderPreview();
    this.renderCursor();
    if (anim) this.renderFx(anim);
  }

  renderOverlay() {
    const g = this.game, o = this.overlay;
    if (!g || !o) { if (this.layers.overlay) this.layers.overlay.innerHTML = ''; return; }
    let s = '';
    if (o.kind === 'reach') {
      // Points each player can reach with one edge this turn.
      const S = g.S, R = g.R;
      const owners = Array.from({ length: S * S }, () => 0);
      for (let p = 0; p < g.NP; p++) {
        for (const [x, y] of g.nodesOf(p)) {
          for (let yy = Math.max(0, y - R); yy <= Math.min(S - 1, y + R); yy++) {
            for (let xx = Math.max(0, x - R); xx <= Math.min(S - 1, x + R); xx++) owners[yy * S + xx] |= 1 << p;
          }
        }
      }
      for (let i = 0; i < S * S; i++) {
        const m = owners[i];
        if (!m) continue;
        const x = i % S, y = (i / S) | 0;
        const players = [0, 1, 2, 3].filter((p) => m & (1 << p));
        if (players.length > 1) s += `<rect class="reach-cell contested" x="${x - 0.5}" y="${y - 0.5}" width="1" height="1"/>`;
        else s += `<rect class="reach-cell rc-p${players[0]}" x="${x - 0.5}" y="${y - 0.5}" width="1" height="1"/>`;
      }
    } else if (o.kind === 'risk' && o.cells) {
      for (const c of o.cells) {
        if (c.nested || c.risk < 0.005) continue;
        s += `<path class="risk-cell" style="fill-opacity:${f2(0.12 + c.risk * 0.55)}" d="${facePath(c.pts)}"/>`;
        const lp = labelPoint(c.pts);
        if (lp && lp.room > 0.35) s += `<text class="risk-label" x="${f2(lp.x)}" y="${f2(lp.y + 0.16)}">${Math.round(c.risk * 100)}%</text>`;
      }
    }
    this.layers.overlay.innerHTML = s;
  }

  renderFaces(anim) {
    const g = this.game;
    let labels = '';
    for (let pl = 0; pl < 4; pl++) {
      if (pl >= g.NP) { this.faceGroups[pl].innerHTML = ''; continue; }
      const faces = facesWithLabels(g.analysis(pl));
      const keys = new Set(faces.map((f) => f.key));
      const isNew = (f) => anim && this.opts.animate && !this.prevFaceKeys[pl].has(f.key);
      this.faceGroups[pl].innerHTML = faces.map((f) => `<path class="face${isNew(f) ? ' face-in' : ''}" d="${facePath(f.pts)}"/>`).join('');
      this.prevFaceKeys[pl] = keys;
      if (this.opts.labels) {
        for (const f of faces) {
          if (f.nested || !f.label || f.area < 1.5 || f.label.room < 0.3) continue;
          const size = Math.max(0.45, Math.min(0.95, f.label.room * 0.9));
          const text = Number.isInteger(Math.round(f.area * 10) / 10) ? String(Math.round(f.area)) : (Math.round(f.area * 10) / 10).toFixed(1);
          labels += `<text class="area-label al-p${pl}" x="${f2(f.label.x)}" y="${f2(f.label.y + size * 0.34)}" font-size="${f2(size)}">${text}</text>`;
        }
      }
    }
    this.layers.labels.innerHTML = labels;
  }

  renderEdges(anim) {
    const g = this.game;
    let s = '';
    const addedId = anim && anim.added && this.opts.animate ? anim.added.id : null;
    for (const e of g.edges.values()) {
      const fresh = g.isFresh(e);
      const cls = `edge e-p${e.owner}${fresh ? ' fresh' : ''}${e.id === addedId ? ' draw-in' : ''}`;
      const len = e.id === addedId ? ' pathLength="1"' : '';
      s += `<line class="${cls}" data-id="${e.id}" x1="${e.ax}" y1="${e.ay}" x2="${e.bx}" y2="${e.by}"${len}/>`;
      if (fresh) s += `<line class="core${e.id === addedId ? ' draw-in' : ''}" x1="${e.ax}" y1="${e.ay}" x2="${e.bx}" y2="${e.by}"${len}/>`;
    }
    this.layers.edges.innerHTML = s;
  }

  renderNodes(anim) {
    const g = this.game;
    let s = '';
    const last = anim && anim.added ? anim.added : null;
    const r = 0.21 * (this.opts.nodeScale || 1);
    for (let pl = 0; pl < g.NP; pl++) {
      const mine = this.canMove && pl === g.player;
      for (const [x, y] of g.nodesOf(pl)) {
        const sel = this.selected && this.selected[0] === x && this.selected[1] === y;
        const isNew = last && this.opts.animate && last.bx === x && last.by === y && last.owner === pl;
        s += nodeShape(pl, x, y, r, `node n-p${pl}${mine ? ' mine' : ''}${sel ? ' selected' : ''}${isNew ? ' pop-in' : ''}`, this.opts.shapes);
      }
    }
    this.layers.nodes.innerHTML = s;
  }

  renderReach() {
    const g = this.game;
    if (!this.selected || !this.canMove) { this.layers.reach.innerHTML = ''; return; }
    const [sx, sy] = this.selected;
    const S = g.S, R = g.R;
    const x0 = Math.max(0, sx - R), y0 = Math.max(0, sy - R);
    const x1 = Math.min(S - 1, sx + R), y1 = Math.min(S - 1, sy + R);
    let s = `<rect class="reach" x="${x0 - 0.35}" y="${y0 - 0.35}" width="${x1 - x0 + 0.7}" height="${y1 - y0 + 0.7}" rx="0.3"/>`;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (x === sx && y === sy) continue;
      const r = g.check(sx, sy, x, y);
      if (!r.ok) continue;
      s += `<circle class="target${r.breaks ? ' t-break' : r.closes ? ' t-close' : ''}" cx="${x}" cy="${y}" r="${r.breaks || r.closes ? 0.15 : 0.1}"/>`;
    }
    this.layers.reach.innerHTML = s;
  }

  renderCoach() {
    if (!this.layers) return;
    const c = this.coach;
    let s = '';
    if (c && this.game) {
      for (const w of c.weak || []) s += `<line class="coach-weak" x1="${w.ax}" y1="${w.ay}" x2="${w.bx}" y2="${w.by}"/>`;
      for (const w of c.targets || []) s += `<line class="coach-target" x1="${w.ax}" y1="${w.ay}" x2="${w.bx}" y2="${w.by}"/>`;
    }
    const w = this.warning;
    if (w && w.move) {
      const m = w.move;
      s += `<line class="warn-cut e-p${w.player}" x1="${m.fx}" y1="${m.fy}" x2="${m.tx}" y2="${m.ty}"/>`;
      s += `<circle class="warn-dot" cx="${m.tx}" cy="${m.ty}" r="0.3"/>`;
    }
    this.layers.coach.innerHTML = s;
  }

  // Ghost edge from the selected node to the hovered point.
  renderPreview() {
    const g = this.game;
    if (!g) return;
    let s = '';
    this.previewFaces.innerHTML = '';
    if (this.hint && !g.over) {
      const h = this.hint;
      s += `<line class="hint" x1="${h.fx}" y1="${h.fy}" x2="${h.tx}" y2="${h.ty}"/><circle class="hint-dot" cx="${h.tx}" cy="${h.ty}" r="0.3"/>`;
    }
    const info = this.previewInfo();
    if (info) {
      const { fx, fy, tx, ty, r } = info;
      const me = g.player;
      if (r.ok) {
        s += `<line class="ghost g-p${me}${this.pendingTap ? ' pending' : ''}" x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}"/>`;
        s += `<circle class="ghost-node g-p${me}" cx="${tx}" cy="${ty}" r="0.2"/>`;
        if (r.breaks) {
          const e = r.breaks;
          s += `<line class="victim" x1="${e.ax}" y1="${e.ay}" x2="${e.bx}" y2="${e.by}"/>`;
        }
        if (info.faces) {
          this.previewFaces.setAttribute('class', `faces faces-preview fp-p${me}`);
          this.previewFaces.innerHTML = info.faces.map((f) => `<path d="${facePath(f.pts)}"/>`).join('');
        }
      } else if (r.code !== 'same' && r.code !== 'notyours') {
        s += `<line class="ghost bad" x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}"/>`;
        s += `<g class="bad-x" transform="translate(${tx} ${ty})"><line x1="-0.22" y1="-0.22" x2="0.22" y2="0.22"/><line x1="-0.22" y1="0.22" x2="0.22" y2="-0.22"/></g>`;
        if ((r.code === 'shielded' || r.code === 'ally') && r.edge) {
          s += `<line class="victim shielded" x1="${r.edge.ax}" y1="${r.edge.ay}" x2="${r.edge.bx}" y2="${r.edge.by}"/>`;
        }
      }
    }
    this.layers.preview.innerHTML = s;
    if (this.onPreview) this.onPreview(info);
    this.updateLoupe();
  }

  previewInfo() {
    const g = this.game;
    if (!this.canMove || !this.selected) return null;
    const target = this.pendingTap || this.hover;
    if (!target) return null;
    const [fx, fy] = this.selected, [tx, ty] = target;
    if (fx === tx && fy === ty) return null;
    if (Math.abs(tx - fx) > g.R || Math.abs(ty - fy) > g.R) return null;
    const key = `${g.history.length}:${g.turn}:${fx},${fy},${tx},${ty}`;
    if (this._previewKey === key && this._previewGame === g) return this._preview;
    const r = g.check(fx, fy, tx, ty);
    const info = { fx, fy, tx, ty, r, gain: 0, loss: 0, faces: null };
    const B = g.rules.border ? g.S : 0;
    if (r.ok) {
      const me = g.player;
      if (r.closes) {
        const segs = g.edgesOf(me).map((e) => [e.ax, e.ay, e.bx, e.by]);
        segs.push([fx, fy, tx, ty]);
        const an = analyzeArea(segs, false, B);
        info.gain = Math.max(0, an.area - g.areas[me]);
        if (info.gain > 1e-9) info.faces = an.faces;
      }
      if (r.breaks) {
        const op = r.breaks.owner;
        info.victim = op;
        const segs = g.edgesOf(op).filter((e) => e.id !== r.breaks.id).map((e) => [e.ax, e.ay, e.bx, e.by]);
        info.loss = Math.max(0, g.areas[op] - analyzeArea(segs, false, B).area);
      }
    }
    this._previewKey = key;
    this._previewGame = g;
    this._preview = info;
    return info;
  }

  renderCursor() {
    if (!this.cursor || !this.canMove) { this.layers.cursor.innerHTML = ''; return; }
    const [x, y] = this.cursor;
    this.layers.cursor.innerHTML = `<rect class="kbd-cursor" x="${x - 0.42}" y="${y - 0.42}" width="0.84" height="0.84" rx="0.2"/>`;
  }

  renderFx(anim) {
    if (!this.opts.animate) return;
    let s = '';
    if (anim.broken) {
      const e = anim.broken;
      s += `<line class="snap e-p${e.owner}" x1="${e.ax}" y1="${e.ay}" x2="${e.bx}" y2="${e.by}"/>`;
      for (const [x, y] of anim.removedNodes || []) s += nodeShape(e.owner, x, y, 0.21 * (this.opts.nodeScale || 1), `node-out n-p${e.owner}`, this.opts.shapes);
    }
    if (!s) return;
    const g = document.createElementNS(SVGNS, 'g');
    g.innerHTML = s;
    this.layers.fx.appendChild(g);
    setTimeout(() => g.remove(), 900);
  }

  // ----- zoom and pan -----

  setViewBox(v) {
    const [fx, fy, fw, fh] = this.full;
    if (!v) { this.zoom = null; this.svg.setAttribute('viewBox', this.full.join(' ')); this.el.classList.remove('zoomed'); return; }
    let [x, y, w, h] = v;
    w = Math.max(fw / 4, Math.min(fw, w));
    h = w * fh / fw;
    x = Math.max(fx, Math.min(fx + fw - w, x));
    y = Math.max(fy, Math.min(fy + fh - h, y));
    if (w >= fw - 1e-6) { this.setViewBox(null); return; }
    this.zoom = [x, y, w, h];
    this.svg.setAttribute('viewBox', this.zoom.map(f2).join(' '));
    this.el.classList.add('zoomed');
  }

  zoomBy(factor, cx = null, cy = null) {
    const [x, y, w, h] = this.zoom || this.full;
    const px = cx ?? x + w / 2, py = cy ?? y + h / 2;
    const nw = w / factor, nh = h / factor;
    this.setViewBox([px - (px - x) / factor, py - (py - y) / factor, nw, nh]);
  }

  resetZoom() { this.setViewBox(null); }

  svgPoint(clientX, clientY) {
    const pt = this.svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    return pt.matrixTransform(this.svg.getScreenCTM().inverse());
  }

  // ----- magnifier -----

  updateLoupe() {
    if (!this.loupe) return;
    const d = this.drag;
    const touching = d && d.touch && this.hover;
    if (!touching) { this.loupe.hidden = true; return; }
    const [x, y] = this.hover;
    const span = 3.2;
    this.loupe.hidden = false;
    this.loupeSvg.setAttribute('viewBox', `${f2(x - span)} ${f2(y - span)} ${f2(span * 2)} ${f2(span * 2)}`);
    // Keep the loupe above the finger, inside the board.
    const rect = this.el.getBoundingClientRect();
    const size = this.loupe.offsetWidth || 120;
    const px = Math.max(0, Math.min(rect.width - size, d.lastX - rect.left - size / 2));
    const py = Math.max(0, d.lastY - rect.top - size - 46);
    this.loupe.style.transform = `translate(${px}px, ${py}px)`;
  }

  ensureLoupe() {
    if (this.loupe || !this.opts.interactive) return;
    const div = document.createElement('div');
    div.className = 'loupe';
    div.hidden = true;
    div.innerHTML = `<svg class="board-svg"><use href="#${this.uid}-content"/><circle class="loupe-mark" cx="0" cy="0" r="0"/></svg>`;
    this.el.style.position = 'relative';
    this.el.appendChild(div);
    this.loupe = div;
    this.loupeSvg = div.querySelector('svg');
  }

  // ----- input -----

  bindInput() {
    const svg = this.svg;
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('role', 'application');
    svg.setAttribute('aria-label', 'Game board. Use the arrow keys to move, Enter to pick a node and then a point.');
    svg.addEventListener('pointerdown', (e) => this.pointerDown(e));
    svg.addEventListener('pointermove', (e) => this.pointerMove(e));
    svg.addEventListener('pointerup', (e) => this.pointerUp(e));
    svg.addEventListener('pointercancel', (e) => { this.pointers.delete(e.pointerId); this.drag = null; this.pinch = null; this.updateLoupe(); });
    svg.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.drag) { this.hover = null; this.renderPreview(); }
    });
    svg.addEventListener('keydown', (e) => this.keyDown(e));
    svg.addEventListener('contextmenu', (e) => { if (this.selected) { e.preventDefault(); this.deselect(); } });
    if (this.opts.zoomable) {
      svg.addEventListener('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey) && !this.zoom) return;
        e.preventDefault();
        const p = this.svgPoint(e.clientX, e.clientY);
        if (e.ctrlKey || e.metaKey) this.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
        else {
          const [x, y, w, h] = this.zoom;
          this.setViewBox([x + e.deltaX * w / 400, y + e.deltaY * h / 400, w, h]);
        }
      }, { passive: false });
      svg.addEventListener('dblclick', (e) => { if (this.zoom && !this.canMove) { e.preventDefault(); this.resetZoom(); } });
    }
    this.ensureLoupe();
  }

  pointAt(e) {
    const p = this.svgPoint(e.clientX, e.clientY);
    const x = Math.round(p.x), y = Math.round(p.y);
    const S = this.size;
    if (x < 0 || y < 0 || x >= S || y >= S) return null;
    if (Math.hypot(p.x - x, p.y - y) > 0.62) return null;
    return [x, y];
  }

  isMine(p) {
    return p && this.game && this.game.hasNode(this.game.player, p[0], p[1]);
  }

  pointerDown(e) {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.opts.zoomable && this.pointers.size === 2) {
      // Two fingers: pinch to zoom, cancel any edge being dragged.
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), view: this.zoom || this.full, mid: this.svgPoint((a.x + b.x) / 2, (a.y + b.y) / 2) };
      this.drag = null;
      this.updateLoupe();
      return;
    }
    if (e.button > 0) return;
    const p = this.pointAt(e);
    this.cursor = null;
    if (!this.canMove || !p || !this.isMine(p)) {
      if (this.opts.zoomable && this.zoom) this.pan = { x: e.clientX, y: e.clientY, view: this.zoom, moved: false, id: e.pointerId };
      return;
    }
    // Pressing one of your nodes: a click may connect the selected node to
    // it, while a press-and-drag starts a new edge from it.
    const connect = !!(this.selected && this.legalFromSelected(p));
    const wasSelected = !!(this.selected && this.selected[0] === p[0] && this.selected[1] === p[1]);
    this.drag = { from: p, moved: false, id: e.pointerId, connect, wasSelected, prev: this.selected, touch: e.pointerType !== 'mouse', lastX: e.clientX, lastY: e.clientY };
    if (!connect) {
      this.selected = p;
      this.pendingTap = null;
      this.renderNodes();
      this.renderReach();
      this.renderPreview();
    }
    try { this.svg.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  pointerMove(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const [x, y, w, h] = this.pinch.view;
      const f = d / Math.max(10, this.pinch.d);
      const mid = this.pinch.mid;
      this.setViewBox([mid.x - (mid.x - x) / f, mid.y - (mid.y - y) / f, w / f, h / f]);
      return;
    }
    if (this.pan && this.pan.id === e.pointerId) {
      const r = this.svg.getBoundingClientRect();
      const [x, y, w, h] = this.pan.view;
      const dx = (e.clientX - this.pan.x) * w / r.width, dy = (e.clientY - this.pan.y) * h / r.height;
      if (Math.abs(e.clientX - this.pan.x) + Math.abs(e.clientY - this.pan.y) > 6) this.pan.moved = true;
      if (this.pan.moved) this.setViewBox([x - dx, y - dy, w, h]);
      return;
    }
    if (!this.canMove) return;
    const p = this.pointAt(e);
    const d = this.drag;
    if (d) { d.lastX = e.clientX; d.lastY = e.clientY; }
    if (d && !d.moved && p && (p[0] !== d.from[0] || p[1] !== d.from[1])) {
      d.moved = true;
      if (d.connect) {
        this.selected = d.from;
        this.pendingTap = null;
        this.renderNodes();
        this.renderReach();
      }
    }
    const same = (a, b) => (a === b) || (a && b && a[0] === b[0] && a[1] === b[1]);
    if (!same(p, this.hover)) {
      this.hover = p;
      if (!this.pendingTap) this.renderPreview();
    } else this.updateLoupe();
  }

  pointerUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; return; }
    if (this.pan && this.pan.id === e.pointerId) {
      const moved = this.pan.moved;
      this.pan = null;
      if (moved) return;
    }
    if (!this.canMove) return;
    const p = this.pointAt(e);
    const d = this.drag;
    this.drag = null;
    this.updateLoupe();
    if (d) {
      try { this.svg.releasePointerCapture(d.id); } catch { /* ignore */ }
      if (d.moved) {
        if (p) this.tryMove(p, true);
        return;
      }
      if (d.connect) {
        this.selected = d.prev;
        this.tryMove(d.from, false, e.pointerType !== 'mouse');
        return;
      }
      if (d.wasSelected) this.deselect();
      return;
    }
    if (!p) { if (e.pointerType === 'mouse') this.deselect(); return; }
    if (this.selected) this.tryMove(p, false, e.pointerType !== 'mouse');
  }

  legalFromSelected(p) {
    if (!this.selected) return false;
    const [sx, sy] = this.selected;
    if (sx === p[0] && sy === p[1]) return false;
    return this.game.check(sx, sy, p[0], p[1]).ok;
  }

  tryMove(p, fromDrag, isTouch = false) {
    const [sx, sy] = this.selected;
    const [tx, ty] = p;
    if (sx === tx && sy === ty) return;
    const r = this.game.check(sx, sy, tx, ty);
    if (!r.ok) {
      if (this.isMine(p)) {
        // Clicking another of your nodes that you can't connect to selects it.
        this.selected = p;
        this.pendingTap = null;
        this.render();
        return;
      }
      if (r.code === 'range' || r.code === 'board') { this.deselect(); return; }
      this.hover = p;
      this.renderPreview();
      if (this.onIllegal) this.onIllegal(r.reason);
      return;
    }
    if (!fromDrag && isTouch && this.opts.confirmTaps) {
      const same = this.pendingTap && this.pendingTap[0] === tx && this.pendingTap[1] === ty;
      if (!same) {
        this.pendingTap = p;
        this.renderPreview();
        return;
      }
    }
    this.pendingTap = null;
    this.hover = null;
    this.selected = null;
    if (this.onMove) this.onMove(sx, sy, tx, ty);
  }

  deselect() {
    this.selected = null;
    this.pendingTap = null;
    this.render();
  }

  keyDown(e) {
    if (!this.canMove) return;
    const k = e.key;
    const S = this.size;
    const moves = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (moves[k]) {
      e.preventDefault();
      if (!this.cursor) this.cursor = this.selected ? [...this.selected] : this.firstNode();
      const [dx, dy] = moves[k];
      this.cursor = [Math.max(0, Math.min(S - 1, this.cursor[0] + dx)), Math.max(0, Math.min(S - 1, this.cursor[1] + dy))];
      this.hover = this.cursor;
      this.renderCursor();
      this.renderPreview();
      if (this.onCursor) this.onCursor(this.cursor);
      return;
    }
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      const p = this.cursor || this.firstNode();
      if (!p) return;
      if (this.selected && this.legalFromSelected(p)) { this.tryMove(p, true); return; }
      if (this.isMine(p)) { this.selected = p; this.render(); return; }
      if (this.selected) this.tryMove(p, true);
      return;
    }
    if (k === 'Escape') { this.deselect(); }
  }

  firstNode() {
    const nodes = this.game.nodesOf(this.game.player);
    const m = (this.size - 1) / 2;
    return nodes.length ? nodes[nodes.length - 1] : [m, m];
  }

  describeCursor(names = null) {
    if (!this.cursor || !this.game) return '';
    const [x, y] = this.cursor;
    const g = this.game;
    const o = g.ownerAt(x, y);
    const what = o < 0 ? 'empty' : `${(names && names[o]) || `player ${o + 1}`} node`;
    return `${pointName(x, y, g.S)}, ${what}`;
  }
}

// A plain-language summary of a position for screen readers.
export function describePosition(g, names) {
  const nm = (p) => (names && names[p]) || `Player ${p + 1}`;
  const parts = [];
  for (let p = 0; p < g.NP; p++) {
    const faces = g.analysis(p).faces.filter((f) => !f.nested);
    const bits = faces.slice(0, 6).map((f) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of f.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      return `${formatArea(f.area)} around ${pointName(Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2), g.S)}`;
    });
    parts.push(`${nm(p)}: score ${formatArea(g.scores[p])}, holding ${formatArea(g.areas[p])} area${faces.length ? ` in ${faces.length} cell${faces.length === 1 ? '' : 's'} (${bits.join('; ')}${faces.length > 6 ? '; more' : ''})` : ''}, ${g.nodesOf(p).length} nodes.`);
  }
  if (!g.over) parts.push(`${nm(g.player)} to play, ${g.left} edge${g.left === 1 ? '' : 's'} left this turn. Edge ${g.placed} of ${g.totalEdges}.`);
  else parts.push('The game is over.');
  return parts.join(' ');
}
