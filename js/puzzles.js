// Puzzles. Most ask for the best turn: the swing of a turn is the area you
// fence in plus the enemy area you open up. Other kinds ask you to only
// build, only cut, block the opponent's best cut with your last edge, or
// plan four edges in a row. Answers are scored exactly by the engine.

import { Game, decodeHistory, decodeRules, decodePosition, encodeRules, formatArea, makeRules } from './engine.js';
import { Board } from './board.js';
import { PUZZLES } from './puzzledata.js';
import { bestSingleCut } from './solver.js';
import { sfx } from './sound.js';
import * as store from './store.js';
import { puzzleRating } from './profile.js';
import { seatNames } from './colors.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const TYPE_NAMES = { swing: 'Best turn', gain: 'Build', cut: 'Cut', block: 'Block', plan: 'Plan ahead' };
const DIFF_NAMES = ['', 'Easier', 'Medium', 'Harder'];
const EPOCH = Date.UTC(2026, 9, 1);

export function difficulty(p) {
  return p.level || 2;
}

export function typeOf(p) {
  return p.type || 'swing';
}

// Today's puzzle, the same for everyone on the same day.
export function dailyIndex(date = new Date()) {
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  return ((day * 7) % PUZZLES.length + PUZZLES.length) % PUZZLES.length;
}

export function dailyNumber(date = new Date()) {
  return Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - EPOCH) / 86400000) + 1;
}

export function startGame(p) {
  if (p.pos) return new Game(decodePosition(p.pos));
  const rules = p.rules ? decodeRules(p.rules) : makeRules({});
  return Game.fromHistory(decodeHistory(p.code, rules), null, rules);
}

// How a finished attempt scores. Higher is better, except for block.
function score(p, start, g) {
  const me = start.player;
  const gain = g.areas[me] - start.areas[me];
  let cut = 0;
  for (const q of start.enemiesOf(me)) cut += start.areas[q] - g.areas[q];
  const t = typeOf(p);
  if (t === 'gain') return gain;
  if (t === 'cut') return cut;
  return gain + cut;
}

export class PuzzleView {
  constructor(app) {
    this.app = app;
    this.solved = new Set(store.load('puzzles', []));
    this.best = store.load('puzzleBest', {});
    this.streak = store.load('puzzleStreak', { now: 0, best: 0 });
    this.filters = { type: 'all', level: 0, state: 'all', ...store.load('puzzleFilters', {}) };
    this.tab = 'all';
    this.list = PUZZLES;
    this.index = 0;
    this.board = null;
    this.rush = null;
    this.bind();
  }

  mine() { return store.load('myPuzzles', []); }

  addMine(p) {
    const list = this.mine();
    if (!list.some((x) => (x.pos && x.pos === p.pos) || (x.code && x.code === p.code))) list.push({ ...p, mine: true, date: Date.now() });
    store.save('myPuzzles', list);
  }

  bind() {
    $('pz-reset').onclick = () => this.open(this.index, this.list);
    $('pz-show').onclick = () => this.showSolution();
    $('pz-hint').onclick = () => this.hint();
    $('pz-next').onclick = () => this.step(1);
    $('pz-prev').onclick = () => this.step(-1);
    $('pz-share').onclick = () => this.shareDaily();
    for (const t of document.querySelectorAll('#view-puzzles [data-pztab]')) t.onclick = () => { location.hash = `#puzzles/${t.dataset.pztab}`; };
    for (const sel of ['pz-f-type', 'pz-f-level', 'pz-f-state']) {
      $(sel).onchange = () => {
        this.filters = { type: $('pz-f-type').value, level: Number($('pz-f-level').value), state: $('pz-f-state').value };
        store.save('puzzleFilters', this.filters);
        this.renderList();
      };
    }
    $('rush-start').onclick = () => this.startRush();
  }

  step(d) {
    const ids = this.visible();
    const pos = ids.indexOf(this.index);
    const next = ids[(pos + d + ids.length) % ids.length];
    if (next === undefined) return;
    location.hash = this.list === PUZZLES ? `#puzzles/${next + 1}` : `#puzzles/mine/${next + 1}`;
  }

  // Indexes of puzzles in the current list that pass the filters.
  visible() {
    const f = this.filters;
    return this.list.map((p, i) => i).filter((i) => {
      const p = this.list[i];
      if (f.type !== 'all' && typeOf(p) !== f.type) return false;
      if (f.level && difficulty(p) !== f.level) return false;
      const done = this.solved.has(this.keyOf(p));
      if (f.state === 'open' && done) return false;
      if (f.state === 'done' && !done) return false;
      return true;
    });
  }

  keyOf(p) { return p.pos || p.code; }

  route(arg, arg2) {
    this.stopRush(false);
    if (arg === 'rush') { this.showTab('rush'); return; }
    if (arg === 'daily') { this.showTab('daily'); this.renderCalendar(); return; }
    if (arg === 'mine') {
      this.list = this.mine();
      this.showTab('mine');
      if (!this.list.length) { this.renderList(); $('pz-main').hidden = true; $('pz-empty').hidden = false; return; }
      const n = Number(arg2);
      this.open(Number.isInteger(n) && n >= 1 && n <= this.list.length ? n - 1 : 0, this.list);
      return;
    }
    this.list = PUZZLES;
    this.showTab('all');
    const n = Number(arg);
    this.open(Number.isInteger(n) && n >= 1 && n <= PUZZLES.length ? n - 1 : this.firstUnsolved(), PUZZLES);
  }

  // A puzzle someone shared: a position and the best swing. It is checked
  // again here before it is shown, so a link can't claim a wrong answer.
  async openShared(posCode, claimed) {
    this.showTab('all');
    $('pz-main').hidden = false;
    $('pz-empty').hidden = true;
    $('pz-title').textContent = 'Shared puzzle';
    $('pz-meta').textContent = 'Checking it…';
    $('pz-task').textContent = 'Checking the best answer for this position…';
    let g;
    try { g = new Game(decodePosition(posCode)); } catch { this.app.toast("That puzzle link doesn't work."); return; }
    let r;
    try { r = await this.app.solver.solve({ kind: 'turn', base: decodePosition(posCode) }); } catch { return; }
    if (!r || r.best <= 1e-9) { this.app.toast("That position doesn't have a turn to find."); return; }
    if (claimed && Math.abs(Number(claimed) - r.best) > 1e-6) this.app.toast('The link claimed a different best swing. Showing the checked one.');
    const p = { pos: posCode, player: g.player, best: r.best, gain: r.gain, cut: r.cut, firsts: r.firsts, sol: r.sol, level: r.firsts > 2 ? 1 : r.firsts === 1 ? 3 : 2, type: 'swing', from: 'Shared with a link' };
    this.addMine(p);
    this.list = [p];
    this.open(0, this.list, 'Shared puzzle');
  }

  showTab(name) {
    this.tab = name;
    for (const t of document.querySelectorAll('#view-puzzles [data-pztab]')) t.setAttribute('aria-selected', String(t.dataset.pztab === name || (name === 'all' && t.dataset.pztab === '')));
    $('pz-browse').hidden = name === 'rush' || name === 'daily';
    $('pz-rush').hidden = name !== 'rush';
    $('pz-calendar').hidden = name !== 'daily';
    $('pz-main').hidden = name === 'daily' || (name === 'rush' && !this.rush);
    $('pz-empty').hidden = true;
    $('pz-rating').textContent = `Puzzle rating ${this.app.profile.current.rating.puzzle} · first-try streak ${this.streak.now} (best ${this.streak.best})`;
    $('pz-f-type').value = this.filters.type;
    $('pz-f-level').value = String(this.filters.level);
    $('pz-f-state').value = this.filters.state;
  }

  firstUnsolved() {
    const i = PUZZLES.findIndex((p) => !this.solved.has(this.keyOf(p)));
    return i < 0 ? 0 : i;
  }

  renderList() {
    const ids = this.visible();
    const all = this.list.length;
    const done = this.list.filter((p) => this.solved.has(this.keyOf(p))).length;
    $('pz-progress').textContent = `${done} of ${all} solved${ids.length !== all ? ` · ${ids.length} shown` : ''}`;
    $('pz-list').innerHTML = ids.map((i) => {
      const p = this.list[i];
      const d = difficulty(p);
      const t = typeOf(p);
      return `<button data-i="${i}" class="${this.solved.has(this.keyOf(p)) ? 'done' : ''}" ${i === this.index ? 'aria-current="true"' : ''} title="${TYPE_NAMES[t]}, ${DIFF_NAMES[d].toLowerCase()}">
        <span>${i + 1}</span><i class="dots">${'•'.repeat(d)}</i>${t !== 'swing' ? `<i class="ptype">${TYPE_NAMES[t][0]}</i>` : ''}</button>`;
    }).join('') || '<p class="small">No puzzles match these filters.</p>';
    for (const b of $('pz-list').querySelectorAll('button')) {
      b.onclick = () => { location.hash = this.list === PUZZLES ? `#puzzles/${Number(b.dataset.i) + 1}` : `#puzzles/mine/${Number(b.dataset.i) + 1}`; };
    }
  }

  ensureBoard() {
    const s = this.app.settings;
    if (!this.board) {
      this.board = new Board($('pz-board'), {
        interactive: true, zoomable: true, coords: s.coords, labels: s.labels, animate: s.animate, confirmTaps: s.confirmTaps,
        shapes: s.shapes, lineScale: s.lineScale, nodeScale: s.nodeScale,
        onMove: (fx, fy, tx, ty) => this.move(fx, fy, tx, ty),
        onPreview: (info) => this.preview(info),
      });
      this.board.onIllegal = (reason) => { this.say(reason, 'bad'); sfx.illegal(); };
    } else {
      this.board.setOptions({ coords: s.coords, labels: s.labels, animate: s.animate, confirmTaps: s.confirmTaps, shapes: s.shapes, lineScale: s.lineScale, nodeScale: s.nodeScale });
    }
  }

  open(i, list = this.list, title = null) {
    this.list = list;
    this.index = i;
    const p = list[i];
    this.puzzle = p;
    $('pz-main').hidden = false;
    $('pz-empty').hidden = true;
    this.renderList();
    this.start = startGame(p);
    this.game = this.start.clone();
    this.me = this.start.player;
    this.locked = false;
    this.hinted = false;
    this.edgesPlayed = 0;
    this.ensureBoard();
    this.board.setHint(null);
    this.board.setWarning(null);
    this.board.setGame(this.game);
    this.board.setCanMove(true);
    const names = seatNames(this.app.settings, this.start.NP);
    const daily = list === PUZZLES && i === dailyIndex();
    const t = typeOf(p);
    $('pz-title').textContent = title || (list === PUZZLES ? `Puzzle ${i + 1}` : `Your puzzle ${i + 1}`);
    $('pz-meta').textContent = `${TYPE_NAMES[t]} · ${DIFF_NAMES[difficulty(p)]} · rated ${puzzleRating(p)}${daily ? ' · Puzzle of the day' : ''}${p.from ? ` · ${p.from}` : ''}`;
    const who = `<b class="t-p${this.me}">${names[this.me]}</b>`;
    const tasks = {
      swing: `You are ${who}, with ${this.start.left === 1 ? 'one edge' : 'two edges'} to place. The best turn here swings <b>${formatArea(p.best)}</b>: area you fence in plus enemy area you open. Can you find one that good?`,
      gain: `You are ${who}. Fence in as much area as you can with your ${this.start.left === 1 ? 'edge' : 'two edges'}. The most possible is <b>${formatArea(p.best)}</b>.`,
      cut: `You are ${who}. Open as much enemy area as you can this turn. The most possible is <b>${formatArea(p.best)}</b>.`,
      block: `You are ${who}, with one edge left. After it, the next player gets to cut. Place your edge so their best single cut opens as little of your area as possible. The best you can do is <b>${formatArea(p.best)}</b>.`,
      plan: `You are ${who}. The other side ran out of time, so you get <b>four edges in a row</b>. Swing at least <b>${formatArea(p.best)}</b>: area you fence in plus enemy area you open.`,
    };
    $('pz-task').innerHTML = tasks[t];
    const prev = this.best[this.keyOf(p)];
    $('pz-best').textContent = this.solved.has(this.keyOf(p)) ? 'Solved.' : prev !== undefined ? `Your best so far: ${formatArea(prev)}` : '';
    $('pz-share').hidden = true;
    this.say(t === 'block' ? 'After your edge, the dashed line shows their best cut.' : 'Swing counts the area you fence in plus the enemy area you open up.');
    this.renderSwing();
  }

  current(g = this.game) { return score(this.puzzle, this.start, g); }

  renderSwing() {
    const p = this.puzzle;
    const t = typeOf(p);
    const total = t === 'plan' ? 4 : this.start.left;
    if (t === 'block') $('pz-swing').textContent = `Their best cut after your edge: ${this.blockResult !== undefined && this.locked ? formatArea(this.blockResult) : '?'} (best ${formatArea(p.best)})`;
    else $('pz-swing').textContent = `${t === 'gain' ? 'Fenced in' : t === 'cut' ? 'Opened' : 'Swing'} so far: ${formatArea(Math.max(0, this.current()))} of ${formatArea(p.best)}`;
    const left = Math.max(0, total - this.edgesPlayed);
    $('pz-edges').textContent = this.locked ? 'Done' : `${left} edge${left === 1 ? '' : 's'} left`;
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
    this.say(parts.length ? `This edge ${parts.join(' and ')}.` : `${this.game.pointName(info.fx, info.fy)} to ${this.game.pointName(info.tx, info.ty)}`);
  }

  move(fx, fy, tx, ty) {
    const g = this.game;
    if (this.locked || g.player !== this.me) return;
    const before = g.areas.slice();
    let entry;
    try { entry = g.play(fx, fy, tx, ty); } catch (e) { this.say(e.message, 'bad'); return; }
    this.edgesPlayed++;
    if (entry.broke) sfx.snap(); else if (g.areas[this.me] > before[this.me]) sfx.close(); else sfx.place();
    this.board.setGame(g, { added: entry.edge, broken: entry.broke, removedNodes: [] });
    const t = typeOf(this.puzzle);
    if (t === 'plan' && g.player !== this.me && !g.over && this.edgesPlayed < 4) {
      // The other side's turn is skipped: they ran out of time.
      while (g.player !== this.me && !g.over) g.timeout();
      this.board.setGame(g);
      this.say('Their turn is skipped. Two more edges.');
      this.renderSwing();
      return;
    }
    this.renderSwing();
    if (g.player === this.me && !g.over) { this.say('One more edge.'); return; }
    this.finish();
  }

  finish() {
    const p = this.puzzle, g = this.game;
    this.locked = true;
    this.board.setCanMove(false);
    const t = typeOf(p);
    let solved, v;
    if (t === 'block') {
      const { cut, move } = bestSingleCut(g, this.me);
      v = cut;
      this.blockResult = cut;
      solved = cut <= p.best + 1e-6;
      if (move) this.board.setWarning({ move: { fx: move[0], fy: move[1], tx: move[2], ty: move[3] }, player: g.player });
    } else {
      v = this.current();
      solved = v >= p.best - 1e-6;
    }
    this.renderSwing();
    const key = this.keyOf(p);
    const prev = this.best[key];
    const better = t === 'block' ? prev === undefined || v < prev : prev === undefined || v > prev;
    if (better) { this.best[key] = Math.round(v * 1e6) / 1e6; store.save('puzzleBest', this.best); }
    const first = !this.attempted(key);
    this.markAttempt(key);
    const daily = this.list === PUZZLES && this.index === dailyIndex();
    if (!this.rush) this.app.profile.puzzleResult(p, solved && !this.hinted, { daily: daily && solved });
    if (solved) {
      this.solved.add(key);
      store.save('puzzles', [...this.solved]);
      if (first && !this.hinted) { this.streak.now++; this.streak.best = Math.max(this.streak.best, this.streak.now); store.save('puzzleStreak', this.streak); }
      const msg = t === 'block' ? `Solved: their best cut is now ${formatArea(v)}.` : t === 'plan' ? `Solved: ${formatArea(v)}, target reached.` : `Solved: ${formatArea(v)}, as good as it gets.`;
      this.say(msg, 'good');
      $('pz-best').textContent = 'Solved.';
      if (!this.rush) sfx.win();
      $('pz-share').hidden = !daily;
      this.lastDaily = daily ? { first: first && !this.hinted } : null;
      this.renderList();
      this.app.renderDaily();
    } else {
      if (first) { this.streak.now = 0; store.save('puzzleStreak', this.streak); }
      const msg = t === 'block'
        ? `Their best cut would open ${formatArea(v)} (the dashed line). The best you can do is ${formatArea(p.best)}.`
        : `That ${t === 'gain' ? 'fences in' : t === 'cut' ? 'opens' : 'swings'} ${formatArea(Math.max(0, v))}. The target is ${formatArea(p.best)}. Press Try again, or Show me.`;
      this.say(msg, 'bad');
    }
    $('pz-rating').textContent = `Puzzle rating ${this.app.profile.current.rating.puzzle} · first-try streak ${this.streak.now} (best ${this.streak.best})`;
    if (this.rush) this.rushResult(solved);
  }

  attempted(key) { return (store.load('puzzleTried', {}))[key]; }

  markAttempt(key) {
    const t = store.load('puzzleTried', {});
    t[key] = 1;
    store.save('puzzleTried', t);
  }

  hint() {
    const p = this.puzzle;
    if (!p || !p.sol || !p.sol.length || this.locked) return;
    this.hinted = true;
    const [fx, fy, tx, ty] = p.sol[Math.min(this.edgesPlayed, p.sol.length - 1)];
    this.board.setHint({ fx, fy, tx, ty });
    this.say(`Try ${this.game.pointName(fx, fy)} to ${this.game.pointName(tx, ty)}. Hints don't count toward your rating.`);
  }

  async showSolution() {
    const p = this.puzzle;
    this.open(this.index, this.list);
    this.locked = true;
    this.hinted = true;
    this.board.setCanMove(false);
    this.say(typeOf(p) === 'plan' ? 'Here is one way to reach it.' : 'Here is one best answer.');
    const g = this.game;
    const t = typeOf(p);
    for (let k = 0; k < p.sol.length; k++) {
      const [fx, fy, tx, ty] = p.sol[k];
      await sleep(500);
      if (this.game !== g) return;
      this.board.setHint({ fx, fy, tx, ty });
      await sleep(900);
      if (this.game !== g) return;
      this.board.setHint(null);
      const entry = g.play(fx, fy, tx, ty);
      this.edgesPlayed++;
      if (t === 'plan') while (g.player !== this.me && !g.over && k < p.sol.length - 1) g.timeout();
      this.board.setGame(g, { added: entry.edge, broken: entry.broke, removedNodes: [] });
      this.renderSwing();
    }
    const names = p.sol.map(([a, b, c, d]) => `${g.pointName(a, b)}-${g.pointName(c, d)}`).join(', then ');
    if (t === 'block') {
      const { cut, move } = bestSingleCut(g, this.me);
      if (move) this.board.setWarning({ move: { fx: move[0], fy: move[1], tx: move[2], ty: move[3] }, player: g.player });
      this.say(`${names}: their best cut drops to ${formatArea(cut)}.`);
      return;
    }
    const parts = [];
    if (p.gain > 1e-9) parts.push(`fences in ${formatArea(p.gain)}`);
    if (p.cut > 1e-9) parts.push(`opens ${formatArea(p.cut)} of enemy area`);
    this.say(`${names}: it ${parts.join(' and ') || 'does it'}.`);
  }

  shareDaily() {
    const n = dailyNumber();
    const first = this.lastDaily && this.lastDaily.first;
    const text = `Enclosure daily puzzle #${n}: solved${first ? ' on the first try' : ''}. ${location.href.split('#')[0]}#puzzles/daily`;
    this.app.copy(text, 'Result copied');
  }

  // ----- daily calendar -----

  renderCalendar() {
    const today = new Date();
    const cells = [];
    for (let k = 0; k < 28; k++) {
      const d = new Date(today.getTime() - k * 86400000);
      if (dailyNumber(d) < 1) break;
      const i = dailyIndex(d);
      const p = PUZZLES[i];
      const done = this.solved.has(this.keyOf(p));
      cells.push(`<a class="cal-day${done ? ' done' : ''}${k === 0 ? ' today' : ''}" href="#puzzles/${i + 1}"><b>#${dailyNumber(d)}</b><span>${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><i>${done ? 'Solved' : k === 0 ? 'Today' : 'Open'}</i></a>`);
    }
    $('pz-cal-grid').innerHTML = cells.join('');
    const st = this.app.profile.current.daily;
    $('pz-cal-streak').textContent = `Daily streak: ${st.streak || 0} day${st.streak === 1 ? '' : 's'}.`;
  }

  // ----- Puzzle Rush -----

  startRush() {
    const pool = PUZZLES.map((p, i) => i).filter((i) => difficulty(PUZZLES[i]) <= 2 && ['swing', 'gain', 'cut'].includes(typeOf(PUZZLES[i])));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    this.rush = { pool, at: 0, solved: 0, misses: 0, end: Date.now() + 180000 };
    $('rush-start').hidden = true;
    $('pz-main').hidden = false;
    this.rushNext();
    clearInterval(this.rushTimer);
    this.rushTimer = setInterval(() => this.rushTick(), 250);
  }

  rushNext() {
    const r = this.rush;
    if (!r) return;
    if (r.at >= r.pool.length) { this.stopRush(true); return; }
    this.open(r.pool[r.at++], PUZZLES, 'Puzzle Rush');
    this.renderRush();
  }

  rushResult(solved) {
    const r = this.rush;
    if (solved) r.solved++; else r.misses++;
    this.renderRush();
    if (r.misses >= 3) { setTimeout(() => this.stopRush(true), 900); return; }
    setTimeout(() => this.rushNext(), solved ? 700 : 1400);
  }

  rushTick() {
    if (!this.rush) return;
    if (Date.now() >= this.rush.end) this.stopRush(true);
    else this.renderRush();
  }

  renderRush() {
    const r = this.rush;
    if (!r) return;
    const left = Math.max(0, Math.ceil((r.end - Date.now()) / 1000));
    $('rush-status').innerHTML = `<b>${r.solved}</b> solved · ${'✕'.repeat(r.misses)}${'·'.repeat(3 - r.misses)} · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`;
  }

  stopRush(showResult) {
    if (!this.rush) return;
    clearInterval(this.rushTimer);
    const r = this.rush;
    this.rush = null;
    const best = store.load('rushBest', 0);
    if (r.solved > best) store.save('rushBest', r.solved);
    if (r.solved >= 10) this.app.profile.unlock('rush10');
    $('rush-start').hidden = false;
    if (showResult) {
      $('rush-status').innerHTML = `Time! You solved <b>${r.solved}</b>. Your best is <b>${Math.max(best, r.solved)}</b>.`;
      if (this.board) this.board.setCanMove(false);
      this.locked = true;
    }
  }
}

export { esc as escapeHtml, encodeRules };
