// Puzzles: find the turn with the biggest swing. The swing of a turn is the
// area you gain plus the enemy area you open up. Every puzzle's best swing was
// found by trying every pair of edges, and answers are scored by the engine.

import { Game, decodeHistory, formatArea, pointName, PLAYER_NAMES } from './engine.js';
import { Board } from './board.js';
import { PUZZLES } from './puzzledata.js';
import { sfx } from './sound.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function difficulty(p) {
  return p.level || 2;
}

const DIFF_NAMES = ['', 'Easier', 'Medium', 'Harder'];

export function dailyIndex(date = new Date()) {
  const day = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
  return ((day * 7) % PUZZLES.length + PUZZLES.length) % PUZZLES.length;
}

export class PuzzleView {
  constructor(app) {
    this.app = app;
    this.index = 0;
    this.solved = new Set(store.load('puzzles', []));
    this.best = store.load('puzzleBest', {});
    this.board = null;
    $('pz-reset').onclick = () => this.open(this.index);
    $('pz-show').onclick = () => this.showSolution();
    $('pz-next').onclick = () => this.go((this.index + 1) % PUZZLES.length);
    $('pz-prev').onclick = () => this.go((this.index - 1 + PUZZLES.length) % PUZZLES.length);
    this.renderList();
  }

  go(i) { location.hash = `#puzzles/${i + 1}`; }

  route(arg) {
    const n = Number(arg);
    if (Number.isInteger(n) && n >= 1 && n <= PUZZLES.length) this.open(n - 1);
    else this.open(this.firstUnsolved());
  }

  firstUnsolved() {
    const i = PUZZLES.findIndex((p) => !this.solved.has(p.code));
    return i < 0 ? 0 : i;
  }

  renderList() {
    const done = PUZZLES.filter((p) => this.solved.has(p.code)).length;
    $('pz-progress').textContent = `${done} of ${PUZZLES.length} solved`;
    $('pz-list').innerHTML = PUZZLES.map((p, i) => {
      const d = difficulty(p);
      return `<button data-i="${i}" class="${this.solved.has(p.code) ? 'done' : ''}" ${i === this.index ? 'aria-current="true"' : ''} title="Puzzle ${i + 1}, ${DIFF_NAMES[d].toLowerCase()}">
        <span>${i + 1}</span><i class="dots">${'•'.repeat(d)}</i></button>`;
    }).join('');
    for (const b of $('pz-list').querySelectorAll('button')) b.onclick = () => this.go(Number(b.dataset.i));
  }

  open(i) {
    this.index = i;
    const p = PUZZLES[i];
    this.puzzle = p;
    this.renderList();
    this.start = Game.fromHistory(decodeHistory(p.code));
    this.game = this.start.clone();
    this.me = p.player;
    this.locked = false;
    const s = this.app.settings;
    if (!this.board) {
      this.board = new Board($('pz-board'), {
        interactive: true, coords: s.coords, labels: s.labels, animate: s.animate, confirmTaps: s.confirmTaps,
        onMove: (fx, fy, tx, ty) => this.move(fx, fy, tx, ty),
        onPreview: (info) => this.preview(info),
      });
      this.board.onIllegal = (reason) => { this.say(reason, 'bad'); sfx.illegal(); };
    } else {
      this.board.setOptions({ coords: s.coords, labels: s.labels, animate: s.animate, confirmTaps: s.confirmTaps });
    }
    this.board.setHint(null);
    this.board.setGame(this.game);
    this.board.setCanMove(true);
    const d = difficulty(p);
    const daily = i === dailyIndex() ? ' · Puzzle of the day' : '';
    $('pz-title').textContent = `Puzzle ${i + 1}`;
    $('pz-meta').textContent = `${DIFF_NAMES[d]}${daily}`;
    const who = PLAYER_NAMES[this.me];
    $('pz-task').innerHTML = `You are <b class="t-${this.me ? 'red' : 'blue'}">${who}</b>, with two edges to place. The best turn here swings <b>${formatArea(p.best)}</b>. Can you find one that good?`;
    const prev = this.best[p.code];
    $('pz-best').textContent = this.solved.has(p.code) ? 'Solved.' : prev !== undefined ? `Your best so far: ${formatArea(prev)}` : '';
    this.say('Swing counts the area you fence in plus the enemy area you open up.');
    this.renderSwing();
  }

  swing(g = this.game) {
    const me = this.me, op = 1 - me;
    return (g.areas[me] - this.start.areas[me]) + (this.start.areas[op] - g.areas[op]);
  }

  renderSwing() {
    $('pz-swing').textContent = `Swing this turn: ${formatArea(Math.max(0, this.swing()))} of ${formatArea(this.puzzle.best)}`;
    $('pz-edges').textContent = this.game.player === this.me ? `${this.game.left} edge${this.game.left === 1 ? '' : 's'} left` : 'Turn over';
  }

  say(text, kind = '') {
    const el = $('pz-feedback');
    el.textContent = text;
    el.className = `lesson-feedback ${kind}`;
  }

  preview(info) {
    if (this.locked) return;
    if (!info) { this.say(''); return; }
    const r = info.r;
    if (!r.ok) { this.say(r.reason, 'bad'); return; }
    const parts = [];
    if (info.gain > 1e-9) parts.push(`fences in ${formatArea(info.gain)}`);
    if (info.loss > 1e-9) parts.push(`opens ${formatArea(info.loss)} of their area`);
    else if (r.breaks) parts.push('breaks an edge');
    this.say(parts.length ? `This edge ${parts.join(' and ')}.` : `${pointName(info.fx, info.fy)} to ${pointName(info.tx, info.ty)}`);
  }

  move(fx, fy, tx, ty) {
    const g = this.game;
    if (this.locked || g.player !== this.me) return;
    const before = g.areas.slice();
    let entry;
    try { entry = g.play(fx, fy, tx, ty); } catch (e) { this.say(e.message, 'bad'); return; }
    if (entry.broke) sfx.snap(); else if (g.areas[this.me] > before[this.me]) sfx.close(); else sfx.place();
    this.board.setGame(g, { added: entry.edge, broken: entry.broke, removedNodes: [] });
    this.renderSwing();
    if (g.player === this.me) { this.say('One more edge.'); return; }
    this.finish();
  }

  finish() {
    const p = this.puzzle;
    const v = this.swing();
    this.locked = true;
    this.board.setCanMove(false);
    const prev = this.best[p.code];
    if (prev === undefined || v > prev) { this.best[p.code] = Math.round(v * 1e6) / 1e6; store.save('puzzleBest', this.best); }
    if (v >= p.best - 1e-6) {
      this.solved.add(p.code);
      store.save('puzzles', [...this.solved]);
      this.say(`Solved: a swing of ${formatArea(v)}, as good as it gets.`, 'good');
      $('pz-best').textContent = 'Solved.';
      sfx.win();
      this.renderList();
      this.app.renderDaily();
    } else {
      this.say(`That swings ${formatArea(Math.max(0, v))}. The best is ${formatArea(p.best)}. Press Try again, or Show me.`, 'bad');
      $('pz-best').textContent = `Your best so far: ${formatArea(Math.max(this.best[p.code], 0))}`;
    }
  }

  async showSolution() {
    const p = this.puzzle;
    this.open(this.index);
    this.locked = true;
    this.board.setCanMove(false);
    this.say('Here is one best turn.');
    const g = this.game;
    for (const [fx, fy, tx, ty] of p.sol) {
      await sleep(500);
      if (this.game !== g) return;
      this.board.setHint({ fx, fy, tx, ty });
      await sleep(900);
      if (this.game !== g) return;
      this.board.setHint(null);
      const entry = g.play(fx, fy, tx, ty);
      this.board.setGame(g, { added: entry.edge, broken: entry.broke, removedNodes: [] });
      this.renderSwing();
    }
    const parts = [];
    if (p.gain > 1e-9) parts.push(`fences in ${formatArea(p.gain)}`);
    if (p.cut > 1e-9) parts.push(`opens ${formatArea(p.cut)} of enemy area`);
    this.say(`${p.sol.map(([a, b, c, d]) => `${pointName(a, b)}-${pointName(c, d)}`).join(', then ')}: it ${parts.join(' and ')}.`);
  }
}
