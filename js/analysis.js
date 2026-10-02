// Analysis board: set up any position, play moves for either side, find the
// exact best turn, ask the computer, and share positions or make puzzles.

import { Game, makeRules, encodePosition, decodePosition, formatArea, startEdges } from './engine.js';
import { Board } from './board.js';
import { segmentsTouch, pointOnSegment } from './geometry.js';
import { SolverClient } from './solver-client.js';
import { AIClient } from './ai-client.js';
import { exposure } from './ai.js';
import { sfx } from './sound.js';
import { seatNames } from './colors.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Can this set of edges exist in a game? Different players' edges never
// touch, no node sits inside its owner's edge, no edge is out of reach.
export function validateEdges(edges, rules) {
  const R = makeRules(rules);
  for (const [o, ax, ay, bx, by] of edges) {
    if ([ax, ay, bx, by].some((v) => v < 0 || v >= R.size)) return 'An edge is off the board.';
    if (o >= R.players) return 'An edge belongs to a player who is not in this game.';
    if (ax === bx && ay === by) return 'An edge needs two different points.';
    if (Math.abs(ax - bx) > R.radius || Math.abs(ay - by) > R.radius) return `Edges reach at most ${R.radius} points.`;
  }
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i], b = edges[j];
      if (a[0] === b[0]) {
        const same = (a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4]) || (a[1] === b[3] && a[2] === b[4] && a[3] === b[1] && a[4] === b[2]);
        if (same) return 'That edge is already there.';
        // A node of one edge inside the other edge.
        for (const [e, f] of [[a, b], [b, a]]) {
          for (const [x, y] of [[f[1], f[2]], [f[3], f[4]]]) {
            const end = (x === e[1] && y === e[2]) || (x === e[3] && y === e[4]);
            if (!end && pointOnSegment(e[1], e[2], e[3], e[4], x, y)) return "A node can't sit in the middle of its own player's edge.";
          }
        }
      } else if (segmentsTouch(a[1], a[2], a[3], a[4], b[1], b[2], b[3], b[4])) {
        return "Different players' edges can't touch.";
      }
    }
  }
  return null;
}

export class AnalysisView {
  constructor(app) {
    this.app = app;
    this.solver = new SolverClient();
    this.ai = new AIClient();
    this.mode = 'play';
    this.color = 0;
    this.tool = 'add';
    this.pending = null;
    this.stack = [];
    this.overlay = null;
    const s = app.settings;
    this.board = new Board($('an-board'), {
      interactive: true, zoomable: true, coords: s.coords, labels: s.labels, animate: s.animate, confirmTaps: s.confirmTaps,
      shapes: s.shapes, lineScale: s.lineScale, nodeScale: s.nodeScale,
      onMove: (fx, fy, tx, ty) => this.move(fx, fy, tx, ty),
      onPreview: (info) => this.preview(info),
    });
    this.board.onIllegal = (reason) => this.say(reason, 'bad');
    this.bind();
    this.load(null);
  }

  applySettings(s) {
    this.board.setOptions({ coords: s.coords, labels: s.labels, animate: s.animate, confirmTaps: s.confirmTaps, shapes: s.shapes, lineScale: s.lineScale, nodeScale: s.nodeScale });
  }

  bind() {
    $('an-mode').onchange = (e) => { this.mode = e.target.value; this.pending = null; this.render(); };
    $('an-tool').onchange = (e) => { this.tool = e.target.value; this.pending = null; this.render(); };
    $('an-size').onchange = () => this.resetTo('start');
    $('an-players').onchange = () => this.resetTo('start');
    $('an-radius').onchange = () => this.resetTo('start');
    $('an-start').onclick = () => this.resetTo('start');
    $('an-clear').onclick = () => this.resetTo('clear');
    $('an-undo').onclick = () => this.undo();
    $('an-tomove').onchange = (e) => this.setTurn(Number(e.target.value), null);
    $('an-left').onchange = (e) => this.setTurn(null, Number(e.target.value));
    $('an-best').onclick = () => this.best();
    $('an-ask').onclick = () => this.ask();
    $('an-share').onclick = () => this.app.copy(this.positionURL(), 'Position link copied');
    $('an-puzzle').onclick = () => this.makePuzzle();
    $('an-play').onclick = () => this.playFromHere();
    $('an-reach').onclick = () => this.toggleOverlay('reach');
    $('an-risk').onclick = () => this.toggleOverlay('risk');
    $('an-load').onclick = () => this.loadPrompt();
    // Edit mode clicks go straight to the board's points and edges.
    $('an-board').addEventListener('pointerup', (e) => {
      if (this.mode !== 'edit' || e.button > 0) return;
      const svg = this.board.svg;
      const p = svg.createSVGPoint();
      p.x = e.clientX; p.y = e.clientY;
      const q = p.matrixTransform(svg.getScreenCTM().inverse());
      this.editAt(q.x, q.y);
    });
  }

  // ----- position state -----

  base() {
    return decodePosition(encodePosition(this.game));
  }

  load(base) {
    const rules = base ? base.rules : makeRules({});
    this.game = base ? new Game(base) : new Game(null, rules);
    this.stack = [];
    this.syncControls();
    this.render();
  }

  syncControls() {
    const g = this.game;
    $('an-size').value = String(g.rules.size);
    $('an-players').value = String(g.rules.players);
    $('an-radius').value = String(g.rules.radius);
    const names = seatNames(this.app.settings, g.NP);
    $('an-colors').innerHTML = names.map((n, i) => `<button class="btn chip-btn${i === this.color ? ' on' : ''}" data-c="${i}"><i class="chip chip-p${i}"></i>${n}</button>`).join('');
    for (const b of $('an-colors').querySelectorAll('[data-c]')) b.onclick = () => { this.color = Number(b.dataset.c); this.syncControls(); };
    $('an-tomove').innerHTML = names.map((n, i) => `<option value="${i}"${i === g.player ? ' selected' : ''}>${n}</option>`).join('');
    $('an-left').value = String(Math.min(2, g.left));
  }

  push() {
    this.stack.push(encodePosition(this.game));
    if (this.stack.length > 200) this.stack.shift();
  }

  undo() {
    const code = this.stack.pop();
    if (!code) return;
    this.game = new Game(decodePosition(code));
    this.syncControls();
    this.render();
  }

  resetTo(kind) {
    this.push();
    const rules = makeRules({ ...this.game.rules, size: Number($('an-size').value), players: Number($('an-players').value), radius: Number($('an-radius').value), teams: false });
    if (kind === 'start') this.game = new Game(null, rules);
    else this.game = new Game({ rules, edges: startEdges(rules).map(([o, ax, ay, bx, by]) => [o, ax, ay, bx, by, 0]).slice(0, 0), turn: 3, player: 0, left: 2 });
    if (this.color >= rules.players) this.color = 0;
    this.syncControls();
    this.render();
  }

  // Replace the position with a different player to move or edges left.
  setTurn(player, left) {
    const b = this.base();
    if (player !== null) b.player = player;
    if (left !== null) b.left = left;
    this.push();
    this.game = new Game(b);
    this.syncControls();
    this.render();
  }

  editAt(x, y) {
    const g = this.game;
    const b = this.base();
    if (this.tool === 'erase') {
      // Nearest edge within reach of the click.
      let best = null, bestD = 0.35;
      b.edges.forEach((e, i) => {
        const [, ax, ay, bx, by] = e;
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best === null) return;
      this.push();
      b.edges.splice(best, 1);
      this.game = new Game(b);
      sfx.snap();
      this.render();
      return;
    }
    const px = Math.round(x), py = Math.round(y);
    if (px < 0 || py < 0 || px >= g.S || py >= g.S || Math.hypot(x - px, y - py) > 0.62) return;
    if (!this.pending) { this.pending = [px, py]; this.render(); this.say(`Edge from ${g.pointName(px, py)}: now pick the other end.`); return; }
    const [ax, ay] = this.pending;
    this.pending = null;
    if (ax === px && ay === py) { this.render(); return; }
    const edges = [...b.edges, [this.color, ax, ay, px, py, 0]];
    const err = validateEdges(edges, b.rules);
    if (err) { this.say(err, 'bad'); this.render(); return; }
    this.push();
    b.edges = edges;
    this.game = new Game(b);
    sfx.place();
    this.render();
  }

  move(fx, fy, tx, ty) {
    const g = this.game;
    this.push();
    try { g.play(fx, fy, tx, ty); } catch (e) { this.stack.pop(); this.say(e.message, 'bad'); return; }
    sfx.place();
    this.syncControls();
    this.render();
  }

  // ----- rendering -----

  render() {
    const g = this.game;
    this.board.setGame(g);
    this.board.setCanMove(this.mode === 'play' && !g.over);
    this.board.setHint(this.hint || null);
    if (this.overlay === 'risk') this.board.setOverlay({ kind: 'risk', cells: exposure(g, g.player, {}, true).cells });
    else this.board.setOverlay(this.overlay === 'reach' ? { kind: 'reach' } : null);
    // Show the pending first point of a new edge.
    if (this.mode === 'edit' && this.pending) {
      const [x, y] = this.pending;
      this.board.layers.cursor.innerHTML = `<circle class="edit-pending g-p${this.color}" cx="${x}" cy="${y}" r="0.32"/>`;
    }
    $('an-edit-tools').hidden = this.mode !== 'edit';
    $('an-reach').setAttribute('aria-pressed', String(this.overlay === 'reach'));
    $('an-risk').setAttribute('aria-pressed', String(this.overlay === 'risk'));
    const names = seatNames(this.app.settings, g.NP);
    $('an-info').innerHTML = Array.from({ length: g.NP }, (_, p) => `<span><i class="chip chip-p${p}"></i>${names[p]}: ${formatArea(g.areas[p])} area</span>`).join('') +
      `<span>${g.over ? 'Game over' : `${names[g.player]} to play, ${g.left} edge${g.left === 1 ? '' : 's'} left`}</span>`;
    this.hint = null;
  }

  say(text, kind = '') {
    const el = $('an-status');
    el.textContent = text;
    el.className = `status-line ${kind === 'bad' ? 's-bad' : kind === 'good' ? 's-good' : ''}`;
  }

  preview(info) {
    if (!info) return;
    const r = info.r;
    if (!r.ok) { this.say(r.reason, 'bad'); return; }
    const bits = [];
    if (r.breaks) bits.push(`breaks an edge${info.loss > 1e-9 ? `, opening ${formatArea(info.loss)}` : ''}`);
    if (info.gain > 1e-9) bits.push(`fences in ${formatArea(info.gain)}`);
    this.say(bits.length ? `This edge ${bits.join(' and ')}.` : `${this.game.pointName(info.fx, info.fy)} to ${this.game.pointName(info.tx, info.ty)}`);
  }

  toggleOverlay(kind) {
    this.overlay = this.overlay === kind ? null : kind;
    this.render();
  }

  // ----- tools -----

  async best() {
    const g = this.game;
    if (g.over) return;
    if (g.left > 2) { this.say('The best-turn search works on turns of one or two edges.', 'bad'); return; }
    this.say('Trying every pair of edges…');
    $('an-out').innerHTML = '';
    let r;
    try { r = await this.solver.solve({ kind: 'turn', base: this.base() }); } catch { return; }
    if (!r) return;
    if (!r.sol.length || r.best <= 1e-9) { this.say('No turn here fences in area or opens enemy area right away.'); return; }
    const names = r.sol.map(([a, b, c, d]) => `${g.pointName(a, b)}-${g.pointName(c, d)}`).join(', then ');
    this.hint = { fx: r.sol[0][0], fy: r.sol[0][1], tx: r.sol[0][2], ty: r.sol[0][3] };
    this.render();
    this.say(`Best turn: ${names}. It fences in ${formatArea(r.gain)} and opens ${formatArea(r.cut)}, a swing of ${formatArea(r.best)}. ${r.firsts === 1 ? 'Only one first edge gets there.' : `${r.firsts} different first edges get there.`}`, 'good');
    this.lastSolve = r;
  }

  async ask() {
    const g = this.game;
    if (g.over) return;
    this.say('The computer is thinking…');
    let res;
    try { res = await this.ai.think(g, 'hard', 99, { explain: true, book: false }); } catch { return; }
    const opts = res.options || [];
    if (!opts.length) { this.say('No suggestion.'); return; }
    const desc = (o) => o.plan.map((m) => (m.kind === 'edge' ? `${g.pointName(m.fx, m.fy)}-${g.pointName(m.tx, m.ty)}` : m.kind)).join(', ');
    $('an-out').innerHTML = `<table class="why"><thead><tr><th>Turn</th><th>Fenced</th><th>Cut</th><th>At risk next</th><th>Score</th></tr></thead><tbody>${opts.map((o, i) => `<tr${i === 0 ? ' class="chosen"' : ''}><td><code>${desc(o)}</code></td><td>${formatArea(o.gain || 0)}</td><td>${formatArea(o.cut || 0)}</td><td>${formatArea(o.lost || 0)}</td><td>${(o.value - opts[0].value).toFixed(1)}</td></tr>`).join('')}</tbody></table>`;
    const m = opts[0].plan.find((x) => x.kind === 'edge');
    if (m) { this.hint = m; this.render(); }
    this.say(`The computer would play ${desc(opts[0])}.`, 'good');
  }

  positionURL() {
    return `${location.href.split('#')[0]}#a=${encodeURIComponent(encodePosition(this.game))}`;
  }

  async makePuzzle() {
    const g = this.game;
    if (g.over || g.left > 2) { this.say('Puzzles need a turn of one or two edges.', 'bad'); return; }
    this.say('Finding the best turn so the puzzle has a known answer…');
    let r;
    try { r = await this.solver.solve({ kind: 'turn', base: this.base() }); } catch { return; }
    if (!r || r.best <= 1e-9) { this.say("There's nothing to win this turn, so it wouldn't make a puzzle.", 'bad'); return; }
    const url = `${location.href.split('#')[0]}#p=${encodeURIComponent(encodePosition(g))}&b=${r.best}`;
    this.app.puzzles.addMine({ pos: encodePosition(g), player: g.player, best: r.best, gain: r.gain, cut: r.cut, firsts: r.firsts, sol: r.sol, level: r.firsts > 2 ? 1 : r.firsts === 1 ? 3 : 2, from: 'Made on the analysis board' });
    this.app.profile.unlock('maker');
    this.app.copy(url, 'Puzzle saved to Your puzzles. Link copied.');
    this.say(`Puzzle made: the best swing is ${formatArea(r.best)}. The link is copied, and it's in Your puzzles.`, 'good');
  }

  playFromHere() {
    const g = this.game;
    const b = this.base();
    const seats = Array.from({ length: g.NP }, () => ({ type: 'human' }));
    this.app.play.startFromBase(b, seats);
    location.hash = '#play';
  }

  async loadPrompt() {
    const text = await this.app.prompt('Load a position', 'Paste a game link, a position link, or a position code.');
    if (!text) return;
    try {
      const t = text.trim();
      const m = t.match(/#a=([^&]+)/);
      if (m || !t.includes('#')) { this.push(); this.load(decodePosition(decodeURIComponent(m ? m[1] : t))); return; }
      const g = this.app.gameFromLink(t);
      if (g) { this.push(); this.load(decodePosition(encodePosition(g))); return; }
      throw new Error('bad');
    } catch {
      this.say("That doesn't look like a game or position.", 'bad');
    }
  }

  openFrom(game) {
    this.push();
    this.load(decodePosition(encodePosition(game)));
    this.mode = 'play';
    $('an-mode').value = 'play';
    this.render();
  }
}
