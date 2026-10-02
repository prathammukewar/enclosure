// SVG board: draws a Game and turns pointer / keyboard input into edges.

import { N, RADIUS, BLUE, RED, pointName } from './engine.js';
import { analyzeArea } from './geometry.js';

const STARS = [3, 9, 15];
const COLS = 'abcdefghijklmnopqrs';
const COLOR = ['blue', 'red'];

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

const f2 = (v) => Math.round(v * 1000) / 1000;
const facePath = (pts) => 'M' + pts.map(([x, y]) => f2(x) + ' ' + f2(y)).join('L') + 'Z';

export class Board {
  constructor(el, opts = {}) {
    this.el = el;
    this.opts = { coords: true, labels: true, crop: null, animate: true, confirmTaps: false, ...opts };
    this.game = null;
    this.canMove = false;
    this.selected = null;
    this.hover = null;
    this.pendingTap = null;
    this.hint = null;
    this.coach = null;
    this.cursor = null;
    this.onMove = opts.onMove || null;
    this.onPreview = opts.onPreview || null;
    this.prevFaceKeys = [new Set(), new Set()];
    this.build();
  }

  build() {
    const { crop } = this.opts;
    const pad = this.opts.coords && !crop ? 1.15 : 0.62;
    const [x0, y0, x1, y1] = crop || [0, 0, N - 1, N - 1];
    this.view = { x0, y0, x1, y1 };
    this.el.innerHTML = '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`);
    svg.setAttribute('class', 'board-svg');
    svg.innerHTML = `
      <g class="layer-grid"></g>
      <g class="layer-faces"><g class="faces faces-blue"></g><g class="faces faces-red"></g><g class="faces faces-preview"></g></g>
      <g class="layer-reach"></g>
      <g class="layer-coach"></g>
      <g class="layer-edges"></g>
      <g class="layer-preview"></g>
      <g class="layer-nodes"></g>
      <g class="layer-labels"></g>
      <g class="layer-fx"></g>
      <g class="layer-cursor"></g>`;
    this.el.appendChild(svg);
    this.svg = svg;
    this.layers = {};
    for (const g of svg.querySelectorAll(':scope > g')) this.layers[g.getAttribute('class').replace('layer-', '')] = g;
    this.faceGroups = [svg.querySelector('.faces-blue'), svg.querySelector('.faces-red'), svg.querySelector('.faces-preview')];
    this.drawGrid();
    if (this.opts.interactive) this.bindInput();
  }

  setOptions(o) {
    const rebuild = 'coords' in o && o.coords !== this.opts.coords;
    Object.assign(this.opts, o);
    if (rebuild) this.build();
    if (this.game) this.render();
  }

  drawGrid() {
    const { x0, y0, x1, y1 } = this.view;
    const ext = this.opts.crop ? 0.6 : 0;
    let s = '';
    for (let i = 0; i < N; i++) {
      if (i >= x0 && i <= x1) s += `<line class="grid-line${i === 0 || i === N - 1 ? ' grid-edge' : ''}" x1="${i}" y1="${Math.max(0, y0 - ext)}" x2="${i}" y2="${Math.min(N - 1, y1 + ext)}"/>`;
      if (i >= y0 && i <= y1) s += `<line class="grid-line${i === 0 || i === N - 1 ? ' grid-edge' : ''}" x1="${Math.max(0, x0 - ext)}" y1="${i}" x2="${Math.min(N - 1, x1 + ext)}" y2="${i}"/>`;
    }
    for (const sx of STARS) for (const sy of STARS) {
      if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) s += `<circle class="star" cx="${sx}" cy="${sy}" r="0.1"/>`;
    }
    if (this.opts.coords && !this.opts.crop) {
      for (let i = 0; i < N; i++) {
        s += `<text class="coord" x="${i}" y="${N - 1 + 0.82}">${COLS[i]}</text>`;
        s += `<text class="coord" x="-0.78" y="${i + 0.12}">${N - i}</text>`;
      }
    }
    this.layers.grid.innerHTML = s;
  }

  setGame(game, anim = null) {
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

  setHint(m) { this.hint = m; this.renderPreview(); }
  setCoach(c) { this.coach = c; this.renderCoach(); }

  // ----- rendering -----

  render(anim = null) {
    const g = this.game;
    if (!g) return;
    this.renderFaces(anim);
    this.renderEdges(anim);
    this.renderNodes(anim);
    this.renderReach();
    this.renderCoach();
    this.renderPreview();
    this.renderCursor();
    if (anim) this.renderFx(anim);
  }

  renderFaces(anim) {
    const g = this.game;
    let labels = '';
    for (const pl of [BLUE, RED]) {
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
          labels += `<text class="area-label al-${COLOR[pl]}" x="${f2(f.label.x)}" y="${f2(f.label.y + size * 0.34)}" font-size="${f2(size)}">${text}</text>`;
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
      const cls = `edge e-${COLOR[e.owner]}${fresh ? ' fresh' : ''}${e.id === addedId ? ' draw-in' : ''}`;
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
    for (const pl of [BLUE, RED]) {
      const mine = this.canMove && pl === g.player;
      for (const [x, y] of g.nodesOf(pl)) {
        const sel = this.selected && this.selected[0] === x && this.selected[1] === y;
        const isNew = last && this.opts.animate && last.bx === x && last.by === y && last.owner === pl;
        s += `<circle class="node n-${COLOR[pl]}${mine ? ' mine' : ''}${sel ? ' selected' : ''}${isNew ? ' pop-in' : ''}" cx="${x}" cy="${y}" r="0.21"/>`;
      }
    }
    this.layers.nodes.innerHTML = s;
  }

  renderReach() {
    const g = this.game;
    if (!this.selected || !this.canMove) { this.layers.reach.innerHTML = ''; return; }
    const [sx, sy] = this.selected;
    const x0 = Math.max(0, sx - RADIUS), y0 = Math.max(0, sy - RADIUS);
    const x1 = Math.min(N - 1, sx + RADIUS), y1 = Math.min(N - 1, sy + RADIUS);
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
    const c = this.coach;
    if (!c || !this.game) { this.layers.coach.innerHTML = ''; return; }
    let s = '';
    for (const w of c.weak || []) s += `<line class="coach-weak" x1="${w.ax}" y1="${w.ay}" x2="${w.bx}" y2="${w.by}"/>`;
    for (const w of c.targets || []) {
      s += `<line class="coach-target" x1="${w.ax}" y1="${w.ay}" x2="${w.bx}" y2="${w.by}"/>`;
    }
    this.layers.coach.innerHTML = s;
  }

  // Ghost edge from the selected node to the hovered point.
  renderPreview() {
    const g = this.game;
    let s = '';
    this.faceGroups[2].innerHTML = '';
    if (this.hint && !g.over) {
      const h = this.hint;
      s += `<line class="hint" x1="${h.fx}" y1="${h.fy}" x2="${h.tx}" y2="${h.ty}"/><circle class="hint-dot" cx="${h.tx}" cy="${h.ty}" r="0.3"/>`;
    }
    const info = this.previewInfo();
    if (info) {
      const { fx, fy, tx, ty, r } = info;
      const me = g.player;
      if (r.ok) {
        s += `<line class="ghost g-${COLOR[me]}${this.pendingTap ? ' pending' : ''}" x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}"/>`;
        s += `<circle class="ghost-node g-${COLOR[me]}" cx="${tx}" cy="${ty}" r="0.2"/>`;
        if (r.breaks) {
          const e = r.breaks;
          s += `<line class="victim" x1="${e.ax}" y1="${e.ay}" x2="${e.bx}" y2="${e.by}"/>`;
        }
        if (info.faces) {
          this.faceGroups[2].setAttribute('class', `faces faces-preview fp-${COLOR[me]}`);
          this.faceGroups[2].innerHTML = info.faces.map((f) => `<path d="${facePath(f.pts)}"/>`).join('');
        }
      } else if (r.code !== 'same' && r.code !== 'notyours') {
        s += `<line class="ghost bad" x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}"/>`;
        s += `<g class="bad-x" transform="translate(${tx} ${ty})"><line x1="-0.22" y1="-0.22" x2="0.22" y2="0.22"/><line x1="-0.22" y1="0.22" x2="0.22" y2="-0.22"/></g>`;
        if (r.code === 'shielded' && r.edge) {
          s += `<line class="victim shielded" x1="${r.edge.ax}" y1="${r.edge.ay}" x2="${r.edge.bx}" y2="${r.edge.by}"/>`;
        }
      }
    }
    this.layers.preview.innerHTML = s;
    if (this.onPreview) this.onPreview(info);
  }

  previewInfo() {
    const g = this.game;
    if (!this.canMove || !this.selected) return null;
    const target = this.pendingTap || this.hover;
    if (!target) return null;
    const [fx, fy] = this.selected, [tx, ty] = target;
    if (fx === tx && fy === ty) return null;
    if (Math.abs(tx - fx) > RADIUS || Math.abs(ty - fy) > RADIUS) return null;
    const key = `${g.history.length}:${fx},${fy},${tx},${ty}`;
    if (this._previewKey === key) return this._preview;
    const r = g.check(fx, fy, tx, ty);
    const info = { fx, fy, tx, ty, r, gain: 0, loss: 0, faces: null };
    if (r.ok) {
      const me = g.player, op = 1 - me;
      if (r.closes) {
        const segs = g.edgesOf(me).map((e) => [e.ax, e.ay, e.bx, e.by]);
        segs.push([fx, fy, tx, ty]);
        const an = analyzeArea(segs);
        info.gain = Math.max(0, an.area - g.areas[me]);
        if (info.gain > 1e-9) info.faces = an.faces;
      }
      if (r.breaks) {
        const segs = g.edgesOf(op).filter((e) => e.id !== r.breaks.id).map((e) => [e.ax, e.ay, e.bx, e.by]);
        info.loss = Math.max(0, g.areas[op] - analyzeArea(segs).area);
      }
    }
    this._previewKey = key;
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
      s += `<line class="snap e-${COLOR[e.owner]}" x1="${e.ax}" y1="${e.ay}" x2="${e.bx}" y2="${e.by}"/>`;
      for (const [x, y] of anim.removedNodes || []) s += `<circle class="node-out n-${COLOR[e.owner]}" cx="${x}" cy="${y}" r="0.21"/>`;
    }
    if (!s) return;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.innerHTML = s;
    this.layers.fx.appendChild(g);
    setTimeout(() => g.remove(), 900);
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
    svg.addEventListener('pointercancel', () => { this.drag = null; });
    svg.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.drag) { this.hover = null; this.renderPreview(); }
    });
    svg.addEventListener('keydown', (e) => this.keyDown(e));
    svg.addEventListener('contextmenu', (e) => { if (this.selected) { e.preventDefault(); this.deselect(); } });
  }

  pointAt(e) {
    const pt = this.svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(this.svg.getScreenCTM().inverse());
    const x = Math.round(p.x), y = Math.round(p.y);
    if (x < 0 || y < 0 || x >= N || y >= N) return null;
    if (Math.hypot(p.x - x, p.y - y) > 0.62) return null;
    return [x, y];
  }

  isMine(p) {
    return p && this.game && this.game.hasNode(this.game.player, p[0], p[1]);
  }

  pointerDown(e) {
    if (!this.canMove || e.button > 0) return;
    const p = this.pointAt(e);
    this.cursor = null;
    if (!p || !this.isMine(p)) return;
    // Pressing one of your nodes: a click may connect the selected node to
    // it, while a press-and-drag starts a new edge from it.
    const connect = !!(this.selected && this.legalFromSelected(p));
    const wasSelected = !!(this.selected && this.selected[0] === p[0] && this.selected[1] === p[1]);
    this.drag = { from: p, moved: false, id: e.pointerId, connect, wasSelected, prev: this.selected };
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
    if (!this.canMove) return;
    const p = this.pointAt(e);
    const d = this.drag;
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
    }
  }

  pointerUp(e) {
    if (!this.canMove) return;
    const p = this.pointAt(e);
    const d = this.drag;
    this.drag = null;
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
    const moves = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (moves[k]) {
      e.preventDefault();
      if (!this.cursor) this.cursor = this.selected ? [...this.selected] : this.firstNode();
      const [dx, dy] = moves[k];
      this.cursor = [Math.max(0, Math.min(N - 1, this.cursor[0] + dx)), Math.max(0, Math.min(N - 1, this.cursor[1] + dy))];
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
    return nodes.length ? nodes[nodes.length - 1] : [9, 9];
  }

  describeCursor() {
    if (!this.cursor || !this.game) return '';
    const [x, y] = this.cursor;
    const g = this.game;
    let what = 'empty';
    if (g.hasNode(BLUE, x, y)) what = 'blue node';
    else if (g.hasNode(RED, x, y)) what = 'red node';
    return `${pointName(x, y)}, ${what}`;
  }
}
