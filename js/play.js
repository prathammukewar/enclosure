// The play screen: runs a game against the computer, on one screen, online,
// or as a replay, and keeps the side panel in step with the board.

import {
  Game, BLUE, RED, PLAYER_NAMES, TOTAL_EDGES, moveName, pointName, formatArea, encodeHistory, decodeHistory,
} from './engine.js';
import { Board } from './board.js';
import { AIClient } from './ai-client.js';
import { coachMarks } from './ai.js';
import { renderChart } from './chart.js';
import { sfx } from './sound.js';
import * as store from './store.js';
import { boardImage } from './image.js';

export const LEVEL_NAMES = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
const COLOR = ['blue', 'red'];
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtPoints(v) {
  const r = Math.round(v * 10) / 10;
  return r.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export class PlayView {
  constructor(app) {
    this.app = app;
    const s = app.settings;
    this.board = new Board($('board'), {
      interactive: true, coords: s.coords, labels: s.labels, animate: s.animate, confirmTaps: s.confirmTaps,
      onMove: (fx, fy, tx, ty) => this.humanMove(fx, fy, tx, ty),
      onPreview: (info) => this.preview(info),
    });
    this.board.onIllegal = (reason) => { this.flash(reason, 'bad'); sfx.illegal(); };
    this.board.onCursor = () => this.flash(this.board.describeCursor());
    this.ai = new AIClient();
    this.hintAI = new AIClient();
    this.game = null;
    this.config = null;
    this.review = null;
    this.thinking = false;
    this.coachOn = false;
    this.gen = 0;
    this.clock = null;
    this.summary = '';
    this.flashMsg = null;
    this.bind();
    setInterval(() => this.tick(), 200);
  }

  applySettings(s) {
    this.board.setOptions({ coords: s.coords, labels: s.labels, animate: s.animate, confirmTaps: s.confirmTaps });
  }

  bind() {
    $('btn-undo').onclick = () => this.undo();
    $('btn-hint').onclick = () => this.hint();
    $('btn-coach').onclick = () => this.toggleCoach();
    $('btn-review').onclick = () => (this.review === null ? this.enterReview() : this.exitReview());
    $('btn-resign').onclick = () => this.resign();
    $('btn-new').onclick = () => this.app.openNewGame(this.config ? this.config.mode : 'ai');
    for (const b of document.querySelectorAll('[data-review]')) {
      b.onclick = () => {
        const a = b.dataset.review;
        if (a === 'start') this.seek(0);
        if (a === 'end') this.seek(this.game.history.length);
        if (a === 'prev') this.seek(this.review - 1);
        if (a === 'next') this.seek(this.review + 1);
      };
    }
    $('review-slider').oninput = (e) => this.seek(Number(e.target.value));
    for (const t of document.querySelectorAll('.tab')) {
      t.onclick = () => {
        for (const o of document.querySelectorAll('.tab')) o.setAttribute('aria-selected', String(o === t));
        for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.dataset.panel !== t.dataset.tab;
        if (t.dataset.tab === 'chart') this.renderChart();
        if (t.dataset.tab === 'share') this.renderShare();
      };
    }
    $('btn-copy-link').onclick = () => this.app.copy($('share-link').value, 'Link copied');
    $('btn-download').onclick = () => this.downloadRecord();
    $('btn-image').onclick = () => this.saveImage();
    $('moves').onclick = (e) => {
      const b = e.target.closest('button[data-n]');
      if (!b) return;
      const n = Number(b.dataset.n);
      if (this.review === null) this.enterReview(n); else this.seek(n);
    };
    document.addEventListener('keydown', (e) => {
      if (!this.app.isView('play') || e.target.closest('input, textarea, dialog[open]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (this.review !== null) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); this.seek(this.review - 1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); this.seek(this.review + 1); }
        if (e.key === 'Home') this.seek(0);
        if (e.key === 'End') this.seek(this.game.history.length);
        if (e.key === 'Escape' || e.key === 'r') this.exitReview();
        return;
      }
      if (e.target.closest('.board-svg')) return;
      if (e.key === 'u') this.undo();
      if (e.key === 'h') this.hint();
      if (e.key === 'c') this.toggleCoach();
      if (e.key === 'r') this.enterReview();
    });
  }

  // ----- starting games -----

  // config: { mode, humans: [bool, bool], names: [..], level, clock: {base, inc} | null, myColor }
  start(config, history = [], clockMs = null) {
    this.stop();
    this.config = { recorded: false, id: Math.random().toString(36).slice(2), ...config };
    this.game = Game.fromHistory(history);
    this.review = null;
    this.summary = '';
    this.flashMsg = null;
    this.board.setHint(null);
    this.remoteEvents = [];
    this.clock = config.clock ? {
      ms: clockMs ? clockMs.slice() : [config.clock.base, config.clock.base],
      inc: config.clock.inc,
      last: performance.now(),
    } : null;
    for (const pl of [0, 1]) $(`clock-${pl}`).hidden = !this.clock;
    $('review-bar').hidden = true;
    this.after(null);
  }

  // Replay a shared game.
  replay(history, names = null) {
    this.start({ mode: 'replay', humans: [false, false], names: names || ['Blue', 'Red'], clock: null }, history);
    this.enterReview(0);
  }

  stop() {
    this.gen++;
    this.ai.cancel();
    this.hintAI.cancel();
    this.thinking = false;
  }

  saved() {
    return store.load('current', null);
  }

  persist() {
    const c = this.config;
    if (!c || (c.mode !== 'ai' && c.mode !== 'local')) return;
    if (this.game.over) { store.remove('current'); return; }
    store.save('current', {
      config: { mode: c.mode, humans: c.humans, names: c.names, level: c.level, clock: c.clock, myColor: c.myColor },
      moves: encodeHistory(this.game.history),
      clock: this.clock ? this.clock.ms : null,
      edges: this.game.placed,
      t: Date.now(),
    });
  }

  resumeSaved() {
    const s = this.saved();
    if (!s) return false;
    try {
      this.start(s.config, decodeHistory(s.moves), s.clock);
      return true;
    } catch {
      store.remove('current');
      return false;
    }
  }

  // ----- turn flow -----

  isHumanTurn() {
    const g = this.game, c = this.config;
    if (!g || g.over || this.review !== null || c.mode === 'replay' || c.mode === 'idle') return false;
    if (c.mode === 'online') return g.player === c.myColor && this.app.online.connected;
    return !!c.humans[g.player];
  }

  // Called after every change to the game.
  after(anim) {
    const g = this.game;
    this.board.setHint(null);
    this.render(anim);
    this.persist();
    if (g.over) { this.finish(); return; }
    if (this.review !== null) return;
    if (this.config.mode === 'ai' && !this.config.humans[g.player]) {
      if (!this.thinking) this.computerTurn();
      return;
    }
    if (this.config.mode === 'replay' || this.config.mode === 'idle') return;
    const mine = this.config.mode === 'online' ? g.player === this.config.myColor : true;
    if (mine && !g.hasLegalMove()) {
      // Nothing legal: the edge is skipped and still counts.
      setTimeout(() => {
        if (this.game !== g || g.over) return;
        const pl = g.player;
        this.flash(`${this.nameOf(pl)} has no legal edge, so it is skipped.`);
        const before = g.turn;
        g.pass();
        this.turnEnded(before);
        if (this.config.mode === 'online') this.app.online.sendMove({ kind: 'pass' }, g.history.length - 1, this.clockFor(pl));
        this.after(null);
      }, 600);
    }
  }

  humanMove(fx, fy, tx, ty) {
    if (!this.isHumanTurn()) return;
    const g = this.game;
    const before = g.turn;
    const pl = g.player;
    const areasBefore = g.areas.slice();
    let entry;
    try { entry = g.play(fx, fy, tx, ty); } catch (e) { this.flash(e.message, 'bad'); return; }
    this.flashMsg = null;
    this.summary = '';
    this.feedback(entry, areasBefore, pl);
    this.turnEnded(before);
    if (this.config.mode === 'online') this.app.online.sendMove(g.history[g.history.length - 1], g.history.length - 1, this.clockFor(pl));
    this.after(this.animOf(entry));
  }

  // Play a move that came from the other browser.
  remoteMove(m, n, clockMs) {
    const g = this.game;
    if (!g || this.config.mode !== 'online') return;
    if (n !== g.history.length) { this.app.online.requestSync(); return; }
    if (g.player === this.config.myColor) { this.app.online.requestSync(); return; }
    const before = g.turn;
    const pl = g.player;
    const areasBefore = g.areas.slice();
    let entry;
    try { entry = g.apply(m); } catch { this.app.online.requestSync(); return; }
    if (entry && entry.kind === 'edge') {
      this.feedback(entry, areasBefore, pl);
      if (!this.remoteEvents.length) this.remoteBefore = areasBefore;
      this.remoteEvents.push(entry);
    }
    if (m.kind === 'timeout') this.flash(`${this.nameOf(pl)} ran out of time.`);
    this.turnEnded(before);
    if (this.clock && typeof clockMs === 'number') this.clock.ms[pl] = clockMs;
    if (g.turn !== before || g.over) {
      this.summary = this.remoteEvents.length ? this.describeTurn(pl, this.remoteEvents, this.remoteBefore) : '';
      this.remoteEvents = [];
    }
    this.after(entry && entry.kind === 'edge' ? this.animOf(entry) : null);
  }

  async computerTurn() {
    const g = this.game;
    const gen = this.gen;
    this.thinking = true;
    this.render(null);
    const t0 = performance.now();
    let plan;
    try {
      plan = await this.ai.think(g, this.config.level, (Date.now() ^ (g.placed * 7919)) >>> 0);
    } catch {
      if (gen === this.gen) { this.thinking = false; this.render(null); }
      return;
    }
    if (gen !== this.gen || this.game !== g) return;
    const wait = Math.max(0, 450 - (performance.now() - t0));
    await sleep(wait);
    const pl = g.player;
    const turn = g.turn;
    const areaBefore = g.areas.slice();
    const events = [];
    for (let i = 0; i < plan.length; i++) {
      if (gen !== this.gen || g.over || g.player !== pl || g.turn !== turn || this.review !== null) break;
      let entry;
      try { entry = g.apply(plan[i]); } catch { break; }
      if (entry && entry.kind === 'edge') {
        events.push(entry);
        this.sound(entry, areaBefore, pl);
      }
      this.turnEnded(turn);
      if (i < plan.length - 1 && !g.over && g.player === pl) {
        this.render(entry && entry.kind === 'edge' ? this.animOf(entry) : null);
        await sleep(this.app.settings.animate ? 650 : 250);
      } else {
        this.thinking = false;
        this.summary = this.describeTurn(pl, events, areaBefore);
        this.after(entry && entry.kind === 'edge' ? this.animOf(entry) : null);
        return;
      }
    }
    if (gen === this.gen) { this.thinking = false; this.render(null); }
  }

  // Bookkeeping when a turn may have just ended: clock increment, scores.
  turnEnded(turnBefore) {
    const g = this.game;
    if (g.turn === turnBefore && !g.over) return;
    const finished = g.over && g.turn === turnBefore ? g.player : 1 - g.player;
    if (this.clock && g.turn !== turnBefore) this.clock.ms[finished] += this.clock.inc;
    if (this.clock) this.clock.last = performance.now();
    const last = g.timeline[g.timeline.length - 1];
    if (last) this.floatGains(last.areas);
    if (!g.over) sfx.turn();
  }

  animOf(entry) {
    if (!entry || entry.kind !== 'edge') return null;
    const removed = [];
    if (entry.broke) {
      const e = entry.broke;
      for (const [x, y] of [[e.ax, e.ay], [e.bx, e.by]]) if (!this.game.hasNode(e.owner, x, y) && !(x === entry.tx && y === entry.ty)) removed.push([x, y]);
    }
    return { added: entry.edge, broken: entry.broke, removedNodes: removed };
  }

  sound(entry, areasBefore, pl) {
    const g = this.game;
    if (entry.broke) sfx.snap();
    else if (g.areas[pl] > areasBefore[pl] + 1e-9) sfx.close();
    else sfx.place();
  }

  feedback(entry, areasBefore, pl) {
    this.sound(entry, areasBefore, pl);
  }

  describeTurn(pl, events, areaBefore) {
    const g = this.game;
    const op = 1 - pl;
    const parts = [];
    const broke = events.filter((e) => e.broke).length;
    const lost = areaBefore[op] - g.areas[op];
    const gained = g.areas[pl] - areaBefore[pl];
    const mineOp = (this.config.mode === 'ai' && this.config.humans[op]) || (this.config.mode === 'online' && op === this.config.myColor);
    const whose = mineOp ? 'your' : `${this.nameOf(op)}'s`;
    if (broke) parts.push(`broke ${broke === 1 ? 'one' : broke} of ${whose} edges${lost > 1e-9 ? `, opening ${formatArea(lost)} area` : ''}`);
    if (gained > 1e-9) parts.push(`fenced in ${formatArea(gained)} area`);
    if (!parts.length) return '';
    return `${this.nameOf(pl)} ${parts.join(' and ')}.`;
  }

  floatGains(areas) {
    if (!this.app.settings.animate) return;
    for (const pl of [0, 1]) {
      if (areas[pl] <= 0) continue;
      const card = document.querySelector(`.player-card[data-pl="${pl}"]`);
      if (!card || !card.offsetParent) continue;
      const el = document.createElement('span');
      el.className = 'float-gain';
      el.textContent = `+${formatArea(areas[pl])}`;
      card.appendChild(el);
      setTimeout(() => el.remove(), 1200);
    }
  }

  // ----- clock -----

  clockFor(pl) {
    return this.clock ? this.clock.ms[pl] : null;
  }

  tick() {
    const c = this.clock, g = this.game;
    if (!c || !g) return;
    const now = performance.now();
    const dt = now - c.last;
    c.last = now;
    if (g.over || this.config.mode === 'replay' || this.config.mode === 'idle') return;
    // The clock keeps running in review, like a real game clock.
    const pl = g.player;
    c.ms[pl] -= dt;
    if (c.ms[pl] <= 0) {
      const own = this.config.mode !== 'online' || pl === this.config.myColor;
      if (own) {
        c.ms[pl] = 0;
        this.timeout();
      } else {
        c.ms[pl] = 0;
      }
    }
    this.renderClocks();
  }

  timeout() {
    const g = this.game;
    const pl = g.player;
    this.gen++;
    this.ai.cancel();
    this.thinking = false;
    const before = g.turn;
    g.timeout();
    this.turnEnded(before);
    // Out of time: the clock restarts at the increment for the next turn.
    this.clock.ms[pl] = this.clock.inc;
    this.clock.last = performance.now();
    if (this.config.mode === 'online') this.app.online.sendMove({ kind: 'timeout' }, g.history.length - 1, this.clock.ms[pl]);
    this.flash(`${this.nameOf(pl)} ran out of time. The rest of the turn is skipped.`);
    this.after(null);
  }

  renderClocks() {
    if (!this.clock) return;
    const g = this.game;
    for (const pl of [0, 1]) {
      const el = $(`clock-${pl}`);
      el.textContent = fmtClock(this.clock.ms[pl]);
      el.classList.toggle('low', this.clock.ms[pl] < 10000);
      el.classList.toggle('running', !g.over && g.player === pl);
      const sb = document.querySelector(`.sb-clock-${pl}`);
      if (sb) sb.textContent = fmtClock(this.clock.ms[pl]);
    }
  }

  // ----- actions -----

  undo() {
    const g = this.game, c = this.config;
    if (!g || c.mode === 'online' || c.mode === 'replay') {
      if (c && c.mode === 'online') this.flash("Undo isn't available in online games.");
      return;
    }
    if (this.review !== null) this.exitReview();
    let n = g.history.length;
    if (!n) return;
    if (c.mode === 'ai') {
      // Take back to just before your most recent edge.
      let i = n - 1;
      while (i >= 0 && !c.humans[g.history[i].player]) i--;
      if (i < 0) return;
      n = i;
    } else {
      n -= 1;
    }
    this.stop();
    const hist = g.history.slice(0, n);
    this.game = Game.fromHistory(hist);
    this.summary = '';
    this.flash('Took back.');
    this.after(null);
  }

  async hint() {
    const g = this.game;
    if (!this.isHumanTurn()) return;
    this.flash('Looking for a good edge…');
    const gen = this.gen;
    const hist = g.history.length;
    let plan;
    try { plan = await this.hintAI.think(g, 'hard', 12345 + hist); } catch { return; }
    if (gen !== this.gen || this.game !== g || g.history.length !== hist) return;
    const m = plan && plan.find((x) => x.kind === 'edge');
    if (!m) { this.flash('No useful edge found.'); return; }
    this.board.setHint(m);
    const r = g.check(m.fx, m.fy, m.tx, m.ty);
    this.flash(`Try ${pointName(m.fx, m.fy)} to ${pointName(m.tx, m.ty)}${r.breaks ? ', which breaks an edge' : ''}.`);
  }

  toggleCoach() {
    this.coachOn = !this.coachOn;
    $('btn-coach').setAttribute('aria-pressed', String(this.coachOn));
    this.renderCoach();
    if (this.coachOn) this.flash('Orange marks your walls the opponent can reach. Green marks enemy walls you can break now.');
  }

  renderCoach() {
    const g = this.viewGame();
    if (!this.coachOn || !g || g.over || !this.isHumanTurn()) { this.board.setCoach(null); return; }
    this.board.setCoach(coachMarks(g));
  }

  async resign() {
    const g = this.game, c = this.config;
    if (!g || g.over || c.mode === 'replay') return;
    let pl = g.player;
    if (c.mode === 'ai') pl = c.humans[0] ? 0 : 1;
    if (c.mode === 'online') pl = c.myColor;
    const ok = await this.app.confirm('Resign?', c.mode === 'local' ? `${this.nameOf(pl)} gives up this game.` : 'You give up this game.', 'Resign');
    if (!ok || this.game !== g || g.over) return;
    this.stop();
    g.resign(pl);
    if (c.mode === 'online') this.app.online.send({ t: 'resign', player: pl });
    this.after(null);
  }

  remoteResign(pl) {
    const g = this.game;
    if (!g || g.over) return;
    this.stop();
    g.resign(pl);
    this.after(null);
  }

  // ----- review -----

  viewGame() {
    if (this.review === null) return this.game;
    if (!this._reviewGame || this._reviewKey !== `${this.config.id}:${this.review}:${this.game.history.length}`) {
      this._reviewGame = Game.fromHistory(this.game.history.slice(0, this.review));
      this._reviewKey = `${this.config.id}:${this.review}:${this.game.history.length}`;
    }
    return this._reviewGame;
  }

  enterReview(n = this.game.history.length) {
    this.review = Math.max(0, Math.min(this.game.history.length, n));
    $('review-bar').hidden = false;
    $('btn-review').textContent = this.config.mode === 'replay' ? 'Review' : 'Back to game';
    $('btn-review').disabled = this.config.mode === 'replay';
    this.render(null);
  }

  exitReview() {
    if (this.config.mode === 'replay') return;
    this.review = null;
    $('review-bar').hidden = true;
    $('btn-review').textContent = 'Review';
    this.after(null);
  }

  seek(n) {
    if (this.review === null) return;
    const max = this.game.history.length;
    const v = Math.max(0, Math.min(max, n));
    const prev = this.review;
    this.review = v;
    let anim = null;
    if (v === prev + 1) {
      const m = this.game.history[v - 1];
      if (m.kind === 'edge') {
        const h = Game.fromHistory(this.game.history.slice(0, v - 1));
        const entry = h.play(m.fx, m.fy, m.tx, m.ty);
        anim = { added: entry.edge, broken: entry.broke, removedNodes: [] };
      }
    }
    this.render(anim);
  }

  // ----- rendering -----

  nameOf(pl) {
    return (this.config && this.config.names && this.config.names[pl]) || PLAYER_NAMES[pl];
  }

  render(anim) {
    const g = this.viewGame();
    if (!g) return;
    this.board.setGame(g, anim);
    this.board.setCanMove(this.isHumanTurn() && !this.thinking);
    this.renderPlayers(g);
    this.renderProgress(g);
    this.renderMoves();
    this.renderStatus();
    this.renderCoach();
    this.renderClocks();
    if (!document.querySelector('[data-panel="chart"]').hidden) this.renderChart();
    if (!document.querySelector('[data-panel="share"]').hidden) this.renderShare();
    const c = this.config;
    $('btn-undo').disabled = !(c.mode === 'ai' || c.mode === 'local') || !this.game.history.length;
    $('btn-hint').disabled = !this.isHumanTurn() || this.thinking;
    const idle = c.mode === 'idle';
    $('btn-resign').disabled = this.game.over || c.mode === 'replay' || idle;
    $('btn-coach').disabled = c.mode === 'replay' || idle;
    $('btn-review').disabled = idle || c.mode === 'replay' || !this.game.history.length;
    if (this.review !== null) {
      const sl = $('review-slider');
      sl.max = String(this.game.history.length);
      sl.value = String(this.review);
      $('review-pos').textContent = `Edge ${this.review} of ${this.game.history.length}`;
    }
  }

  renderPlayers(g) {
    const active = !g.over ? g.player : -1;
    for (const pl of [0, 1]) {
      const card = document.querySelector(`.player-card[data-pl="${pl}"]`);
      card.classList.toggle('active', pl === active);
      $(`name-${pl}`).textContent = this.nameOf(pl);
      $(`score-${pl}`).textContent = fmtPoints(g.scores[pl]);
      $(`income-${pl}`).textContent = formatArea(g.areas[pl]);
      const turnEl = $(`turn-${pl}`);
      if (pl === active) {
        if (this.thinking && this.config.mode === 'ai' && !this.config.humans[pl]) turnEl.textContent = 'Thinking…';
        else {
          const total = g.turn === 1 ? 1 : Math.min(2, TOTAL_EDGES - (g.placed - (2 - g.left)));
          const pips = Array.from({ length: Math.max(total, g.left) }, (_, i) => `<i class="pip${i < g.left ? ' full' : ''}"></i>`).join('');
          turnEl.innerHTML = `${pips}<span>${g.left} to place</span>`;
        }
      } else if (g.over) {
        const w = g.winner();
        turnEl.textContent = w === pl ? 'Winner' : w === -1 ? 'Draw' : '';
      } else turnEl.textContent = '';
      const tl = g.timeline;
      const prev = tl.length >= 2 ? tl[tl.length - 2].areas[pl] : 0;
      const d = (tl.length ? tl[tl.length - 1].areas[pl] : 0) - prev;
      const dEl = $(`delta-${pl}`);
      dEl.textContent = Math.abs(d) > 1e-9 && tl.length ? `(${d > 0 ? '+' : '−'}${formatArea(Math.abs(d))})` : '';
      dEl.className = `pc-delta ${d > 0 ? 'up' : 'down'}`;
    }
    // Compact bar for narrow screens.
    const sb = $('scorebar');
    const sideP = (pl) => `<div class="sb-p ${pl ? 'r' : 'b'}${pl === active ? ' active' : ''}"><span class="chip chip-${COLOR[pl]}"></span><span class="sb-score">${fmtPoints(g.scores[pl])}</span><span class="sb-sub">${this.esc(this.nameOf(pl))}<br>${formatArea(g.areas[pl])} area${this.clock ? ` · <span class="sb-clock-${pl}">${fmtClock(this.clock.ms[pl])}</span>` : ''}</span></div>`;
    const mid = g.over ? '<b>Final</b>' : `<b>${this.nameOf(g.player)}</b>${this.thinking ? 'thinking' : `${g.left} to place`}`;
    sb.innerHTML = `${sideP(0)}<div class="sb-mid">${mid}<br>${g.placed}/${TOTAL_EDGES}</div>${sideP(1)}`;
  }

  esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  renderProgress(g) {
    $('progress-text').textContent = `Edge ${g.placed} of ${TOTAL_EDGES}`;
    const left = g.updatesLeft();
    $('updates-text').textContent = g.over ? 'Game over' : `${left} score update${left === 1 ? '' : 's'} left`;
    $('progress-fill').style.width = `${(g.placed / TOTAL_EDGES) * 100}%`;
    if (!g.over && left > 0) {
      const p = [0, 1].map((pl) => fmtPoints(g.scores[pl] + g.areas[pl] * left));
      $('projection').textContent = `If nobody's area changes: ${this.nameOf(0)} ${p[0]}, ${this.nameOf(1)} ${p[1]}`;
    } else $('projection').textContent = '';
  }

  moveRows() {
    const hist = this.game.history;
    const key = `${this.config.id}:${encodeHistory(hist)}`;
    if (this._rowsKey === key) return this._rows;
    const rows = [];
    let i = 0;
    const replay = new Game();
    while (i < hist.length) {
      const pl = replay.player;
      const startTurn = replay.turn;
      const cells = [];
      const startI = i;
      while (i < hist.length && replay.turn === startTurn && !replay.over) {
        const m = hist[i];
        let entry = null;
        try { entry = replay.apply(m); } catch { break; }
        const name = m.kind === 'edge' ? moveName({ ...m, broke: entry && entry.broke }) : moveName(m);
        cells.push(`<button data-n="${i + 1}">${name}</button>`);
        i++;
        if (m.kind === 'resign') break;
      }
      if (i === startI) break;
      const tl = replay.timeline[replay.timeline.length - 1];
      const after = tl && tl.turn === startTurn ? `${formatArea(tl.areas[0])} / ${formatArea(tl.areas[1])}` : '';
      rows.push({ from: startI, to: i, html: `<span class="mv-n">${startTurn}.</span><span class="mv-${pl ? 'r' : 'b'}">${cells.join(', ')}</span><span class="mv-s" title="Area held after the turn">${after}</span>` });
    }
    this._rowsKey = key;
    this._rows = rows;
    return rows;
  }

  renderMoves() {
    const cur = this.review;
    const rows = this.moveRows().map((r) => `<li${cur !== null && cur > r.from && cur <= r.to ? ' class="current"' : ''}>${r.html}</li>`);
    const el = $('moves');
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    el.innerHTML = rows.join('') || '<li><span></span><span class="mv-s">No edges yet</span></li>';
    if (this.review !== null) {
      const c = el.querySelector('.current');
      if (c) c.scrollIntoView({ block: 'nearest' });
    } else if (atEnd) el.scrollTop = el.scrollHeight;
  }

  renderChart() {
    renderChart($('chart'), this.viewGame().timeline);
  }

  shareURL() {
    const base = location.href.split('#')[0];
    return `${base}#g=${encodeHistory(this.game.history)}`;
  }

  renderShare() {
    $('share-link').value = this.shareURL();
  }

  status() {
    const g = this.viewGame(), c = this.config;
    if (c.mode === 'idle') return 'Press New game to start.';
    if (this.review !== null) {
      if (c.mode === 'replay') return 'Replay. Use the arrows or the slider to step through the game.';
      return 'Reviewing. The game is paused here. Press Back to game to continue.';
    }
    if (g.over) {
      const w = g.winner();
      const sc = `${fmtPoints(g.scores[0])} to ${fmtPoints(g.scores[1])}`;
      if (g.resigned !== null) return `${this.nameOf(g.resigned)} resigned. ${this.nameOf(1 - g.resigned)} wins.`;
      if (w === -1) return `Draw, ${sc}.`;
      return `${this.nameOf(w)} wins, ${fmtPoints(g.scores[w])} to ${fmtPoints(g.scores[1 - w])}.`;
    }
    const left = g.left === 1 ? '1 edge' : `${g.left} edges`;
    const sum = this.summary ? `${this.summary} ` : '';
    if (c.mode === 'ai') {
      if (!c.humans[g.player]) return this.thinking ? `${sum}The computer is thinking…` : `${sum}Computer to play.`;
      if (g.placed === 0) return 'You go first. Place 1 edge: pick a blue node, then a point in its square.';
      return `${sum}Your turn: place ${left}.`;
    }
    if (c.mode === 'online') {
      if (!this.app.online.connected) return 'Waiting for the connection…';
      if (g.player !== c.myColor) return `${sum}Waiting for ${this.esc(this.nameOf(g.player))}…`;
      return `${sum}Your turn: place ${left}.`;
    }
    return `${sum}${this.esc(this.nameOf(g.player))} to play: ${left}.`;
  }

  renderStatus() {
    const el = $('status');
    if (this.flashMsg && performance.now() - this.flashMsg.t < 4500) {
      el.innerHTML = `<span class="${this.flashMsg.kind === 'bad' ? 's-bad' : this.flashMsg.kind === 'good' ? 's-good' : ''}">${this.esc(this.flashMsg.text)}</span>`;
      return;
    }
    el.textContent = this.status();
  }

  flash(text, kind = '') {
    if (!text) return;
    this.flashMsg = { text, kind, t: performance.now() };
    this.renderStatus();
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => { this.flashMsg = null; this.renderStatus(); }, 4600);
  }

  // Hover preview from the board.
  preview(info) {
    const el = $('status');
    if (!info) { this.renderStatus(); return; }
    const g = this.game;
    const op = 1 - g.player;
    const r = info.r;
    let text, cls = '';
    if (!r.ok) {
      text = r.reason;
      cls = 's-bad';
    } else {
      const bits = [];
      if (r.breaks) bits.push(info.loss > 1e-9 ? `Breaks a ${COLOR[op]} edge: ${formatArea(info.loss)} of their area opens up.` : `Breaks a ${COLOR[op]} edge.`);
      if (info.gain > 1e-9) bits.push(`Fences in ${formatArea(info.gain)} area.`);
      text = bits.join(' ') || `${pointName(info.fx, info.fy)} to ${pointName(info.tx, info.ty)}`;
      if (bits.length) cls = 's-good';
      if (this.board.pendingTap) text += ' Tap again to place it.';
    }
    el.innerHTML = `<span class="${cls}">${this.esc(text)}</span>`;
  }

  // ----- game over -----

  finish() {
    const g = this.game, c = this.config;
    this.thinking = false;
    this.render(null);
    store.remove('current');
    const w = g.winner();
    let title, mine = null;
    if (c.mode === 'ai' || c.mode === 'online') {
      mine = c.mode === 'ai' ? (c.humans[0] ? 0 : 1) : c.myColor;
      title = w === -1 ? 'Draw' : w === mine ? 'You win!' : 'You lose';
    } else {
      title = w === -1 ? 'Draw' : `${this.nameOf(w)} wins`;
    }
    if (c.mode === 'ai' && !c.recorded) {
      c.recorded = true;
      store.addResult(c.level, w === -1 ? 'd' : w === mine ? 'w' : 'l', g.scores[mine]);
      this.app.renderRecord();
    }
    if (c.mode === 'replay' || c.shownOver === g.history.length) return;
    c.shownOver = g.history.length;
    if (mine !== null) (w === mine ? sfx.win : sfx.lose)();
    else sfx.win();
    setTimeout(() => this.showOver(title), 700);
  }

  stats() {
    const g = this.game;
    const r = new Game();
    const breaks = [0, 0], peak = [0, 0];
    for (const m of g.history) {
      const pl = r.player;
      let e = null;
      try { e = r.apply(m); } catch { break; }
      if (e && e.broke) breaks[pl]++;
      peak[0] = Math.max(peak[0], r.areas[0]);
      peak[1] = Math.max(peak[1], r.areas[1]);
    }
    return { breaks, peak };
  }

  showOver(title) {
    const g = this.game;
    if (!g.over) return;
    $('over-title').textContent = title;
    $('over-sub').textContent = g.resigned !== null ? `${this.nameOf(g.resigned)} resigned.` : 'After all 120 edges.';
    $('over-scores').innerHTML = [0, 1].map((pl) => `<div><b>${fmtPoints(g.scores[pl])}</b><span><i class="chip chip-${COLOR[pl]}"></i>${this.esc(this.nameOf(pl))}</span></div>`).join('');
    const st = this.stats();
    $('over-stats').innerHTML = `
      <div>Most area held<br><b>${formatArea(st.peak[0])}</b> / <b>${formatArea(st.peak[1])}</b></div>
      <div>Edges broken<br><b>${st.breaks[0]}</b> / <b>${st.breaks[1]}</b></div>
      <div>Area at the end<br><b>${formatArea(g.areas[0])}</b> / <b>${formatArea(g.areas[1])}</b></div>
      <div>Points per turn<br><b>${(g.scores[0] / Math.max(1, g.timeline.length)).toFixed(1)}</b> / <b>${(g.scores[1] / Math.max(1, g.timeline.length)).toFixed(1)}</b></div>`;
    $('btn-over-again').textContent = this.config.mode === 'online' ? 'Ask for a rematch' : 'Play again';
    this.app.openDialog('dlg-over');
  }

  again() {
    const c = this.config;
    if (c.mode === 'online') { this.app.online.offerRematch(); return; }
    if (c.mode === 'replay') { this.app.openNewGame('ai'); return; }
    const next = { mode: c.mode, humans: c.humans, names: c.names, level: c.level, clock: c.clock, myColor: c.myColor };
    this.start(next);
  }

  // ----- export -----

  downloadRecord() {
    const g = this.game;
    const r = new Game();
    const notation = [];
    for (const m of g.history) {
      const e = r.apply(m);
      notation.push(m.kind === 'edge' ? moveName({ ...m, broke: e && e.broke }) : moveName(m));
    }
    const data = {
      game: 'Enclosure', date: new Date().toISOString(), players: [this.nameOf(0), this.nameOf(1)],
      scores: g.scores, finished: g.over, code: encodeHistory(g.history), moves: notation,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `enclosure-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async saveImage() {
    try {
      const blob = await boardImage(this.viewGame(), [this.nameOf(0), this.nameOf(1)]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `enclosure-${this.viewGame().placed}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch {
      this.app.toast("Couldn't make the picture in this browser.");
    }
  }
}
