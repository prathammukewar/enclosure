// The play screen: runs games for any mix of people and computer players
// (on one screen, online, by link, or as a replay) and keeps the side panel
// in step with the board.

import {
  Game, moveName, formatArea, encodeHistory, decodeHistory, encodeRules, makeRules, encodePosition,
} from './engine.js';
import { Board, describePosition } from './board.js';
import { AIClient } from './ai-client.js';
import { coachMarks, scoreMoves, nextEnemyBest, exposure } from './ai.js';
import { renderChart } from './chart.js';
import { sfx } from './sound.js';
import * as store from './store.js';
import { boardImage } from './image.js';
import { seatNames } from './colors.js';

export const LEVEL_NAMES = { easy: 'Easy', medium: 'Medium', hard: 'Hard', adaptive: 'Adaptive' };
export const STYLE_NAMES = { balanced: 'Balanced', builder: 'Builder', raider: 'Raider', gambler: 'Gambler' };
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtClock(ms) {
  if (ms >= 86400000) return `${Math.floor(ms / 86400000)}d ${Math.floor((ms % 86400000) / 3600000)}h`;
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtPoints(v) {
  const r = Math.round(v * 10) / 10;
  return r.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Converts configs saved by older versions (humans + level) to seats.
export function normalizeConfig(c, settings) {
  const cfg = { ...c };
  cfg.rules = makeRules(c.rules || {});
  const n = cfg.rules.players;
  if (!Array.isArray(cfg.seats)) {
    const humans = c.humans || [true, true];
    cfg.seats = [0, 1].map((i) => (humans[i] ? { type: 'human' } : { type: 'ai', level: c.level || 'medium', style: 'balanced' }));
  }
  const defaults = seatNames(settings, n);
  cfg.seats = Array.from({ length: n }, (_, i) => ({ type: 'human', ...(cfg.seats[i] || {}) }));
  const names = c.names || [];
  cfg.seats.forEach((s, i) => { if (!s.name) s.name = names[i] || defaults[i]; });
  cfg.names = cfg.seats.map((s) => s.name);
  return cfg;
}

export class PlayView {
  constructor(app) {
    this.app = app;
    const s = app.settings;
    this.board = new Board($('board'), {
      interactive: true, zoomable: true, coords: s.coords, labels: s.labels, animate: s.animate, confirmTaps: s.confirmTaps,
      shapes: s.shapes, lineScale: s.lineScale, nodeScale: s.nodeScale,
      onMove: (fx, fy, tx, ty) => this.humanMove(fx, fy, tx, ty),
      onPreview: (info) => this.preview(info),
    });
    this.board.onIllegal = (reason) => { this.flash(reason, 'bad'); sfx.illegal(); };
    this.board.onCursor = () => this.flash(this.board.describeCursor(this.config && this.config.names));
    this.ai = new AIClient();
    this.hintAI = new AIClient();
    this.game = null;
    this.config = null;
    this.review = null;
    this.thinking = false;
    this.gen = 0;
    this.clock = null;
    this.summary = '';
    this.flashMsg = null;
    this.show = { weak: false, reach: false, risk: false, warn: false, ...store.load('show', {}) };
    this.lastWhy = null;
    this.shownScores = [];
    this.bind();
    setInterval(() => this.tick(), 200);
  }

  applySettings(s) {
    this.board.setOptions({ coords: s.coords, labels: s.labels, animate: s.animate, confirmTaps: s.confirmTaps, shapes: s.shapes, lineScale: s.lineScale, nodeScale: s.nodeScale });
    if (this.game) this.render(null);
  }

  bind() {
    $('btn-undo').onclick = () => this.undo();
    $('btn-hint').onclick = () => this.hint();
    $('btn-review').onclick = () => (this.review === null ? this.enterReview() : this.exitReview());
    $('btn-resign').onclick = () => this.resign();
    $('btn-new').onclick = () => this.app.openNewGame(this.config ? this.config.mode : 'ai');
    for (const b of document.querySelectorAll('[data-show]')) {
      if (!b.closest('.show-row')) continue;
      b.onclick = () => this.toggleShow(b.dataset.show);
    }
    for (const b of document.querySelectorAll('[data-review]')) {
      b.onclick = () => {
        const a = b.dataset.review;
        if (a === 'start') this.seek(0);
        if (a === 'end') this.seek(this.game.history.length);
        if (a === 'prev') this.seek(this.review - 1);
        if (a === 'next') this.seek(this.review + 1);
        if (a === 'continue') this.continueFromReview();
      };
    }
    $('review-slider').oninput = (e) => this.seek(Number(e.target.value));
    for (const t of document.querySelectorAll('#view-play .tab')) {
      t.onclick = () => this.openTab(t.dataset.tab);
    }
    $('btn-copy-link').onclick = () => this.app.copy($('share-link').value, 'Link copied');
    $('btn-download').onclick = () => this.downloadRecord();
    $('btn-image').onclick = () => this.saveImage();
    $('btn-video').onclick = () => this.exportReplay('video');
    $('btn-gif').onclick = () => this.exportReplay('gif');
    $('btn-report').onclick = () => this.runReport();
    $('btn-analyze').onclick = () => this.app.openAnalysis(this.viewGame());
    $('zoom-in').onclick = () => this.board.zoomBy(1.4);
    $('zoom-out').onclick = () => this.board.zoomBy(1 / 1.4);
    $('zoom-reset').onclick = () => this.board.resetZoom();
    $('btn-focus').onclick = () => this.app.toggleFocus();
    $('btn-describe').onclick = () => this.describe();
    $('moves').onclick = (e) => {
      const b = e.target.closest('button[data-n]');
      if (!b) return;
      const n = Number(b.dataset.n);
      if (this.review === null) this.enterReview(n); else this.seek(n);
    };
    for (const b of document.querySelectorAll('[data-emote]')) {
      b.onclick = () => this.app.sendEmote(b.dataset.emote);
    }
    $('corr-copy').onclick = () => this.app.copy($('corr-link').value, 'Link copied. Send it to the next player.');
    $('corr-share').onclick = () => navigator.share({ title: 'Enclosure', text: 'Your move in Enclosure', url: $('corr-link').value }).catch(() => {});
    document.addEventListener('keydown', (e) => {
      if (!this.app.isView('play') || e.target.closest('input, textarea, select, dialog[open]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (this.review !== null) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); this.seek(this.review - 1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); this.seek(this.review + 1); }
        if (e.key === 'Home') this.seek(0);
        if (e.key === 'End') this.seek(this.game.history.length);
        if (e.key === 'Escape' || e.key === 'r') this.exitReview();
        return;
      }
      if (e.key === 'u') this.undo();
      if (e.key === 'h') this.hint();
      if (e.key === 'c') this.toggleShow('weak');
      if (e.key === 'r') this.enterReview();
      if (e.key === 'f') this.app.toggleFocus();
      if (e.key === '+' || e.key === '=') this.board.zoomBy(1.4);
      if (e.key === '-') this.board.zoomBy(1 / 1.4);
      if (e.key === '0') this.board.resetZoom();
    });
  }

  openTab(name) {
    for (const o of document.querySelectorAll('#view-play .tab')) o.setAttribute('aria-selected', String(o.dataset.tab === name));
    for (const p of document.querySelectorAll('#view-play .tab-panel')) p.hidden = p.dataset.panel !== name;
    this.tab = name;
    if (name === 'chart') this.renderChart();
    if (name === 'share') this.renderShare();
    if (name === 'coach') this.renderCoachTab();
    if (name === 'why') this.renderWhy();
  }

  // ----- starting games -----

  // config: { mode, rules, seats: [{ type, level, style, name }], clock, myColor, timeScale, corr, tournament }
  start(config, history = [], clockMs = null) {
    this.stop();
    const c = normalizeConfig(config, this.app.settings);
    this.config = { recorded: false, id: Math.random().toString(36).slice(2), timeScale: 1, ...c };
    this.game = this.newGame(history);
    this.review = null;
    this.summary = '';
    this.flashMsg = null;
    this.lastWhy = null;
    this.reportResult = null;
    this.board.setHint(null);
    this.board.resetZoom();
    this.remoteEvents = [];
    this.shownScores = this.game.scores.slice();
    const n = this.game.NP;
    this.clock = this.config.clock ? {
      ms: clockMs ? clockMs.slice() : new Array(n).fill(this.config.clock.base),
      inc: this.config.clock.inc,
      last: performance.now(),
    } : null;
    $('review-bar').hidden = true;
    this.buildPlayers();
    $('emotes').hidden = this.config.mode !== 'online';
    $('corr-panel').hidden = true;
    $('report-out').innerHTML = '';
    this.openTab(this.tab && this.tab !== 'why' ? this.tab : 'moves');
    this.after(null);
  }

  // A fresh game for this config: the standard start, or a custom position
  // from the analysis board, with the given moves played.
  newGame(history) {
    return Game.fromHistory(history, this.config.base || null, this.config.rules);
  }

  // Play on from a custom position (from the analysis board).
  startFromBase(base, seats) {
    this.start({ mode: 'local', rules: base.rules, base, seats, clock: null });
  }

  // Replay a shared game.
  replay(history, rules = null, names = null) {
    this.start({ mode: 'replay', rules, seats: [], names, clock: null }, history);
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
    if (!c || (c.mode !== 'ai' && c.mode !== 'local') || c.tournament) return;
    if (this.game.over) { store.remove('current'); return; }
    store.save('current', {
      config: { mode: c.mode, rules: c.rules, seats: c.seats, clock: c.clock, timeScale: c.timeScale, base: c.base || null },
      moves: encodeHistory(this.game.history, c.rules),
      clock: this.clock ? this.clock.ms : null,
      edges: this.game.placed,
      total: this.game.totalEdges,
      t: Date.now(),
    });
  }

  resumeSaved() {
    const s = this.saved();
    if (!s) return false;
    try {
      const rules = makeRules((s.config && s.config.rules) || {});
      this.start(s.config, decodeHistory(s.moves, rules), s.clock);
      return true;
    } catch {
      store.remove('current');
      return false;
    }
  }

  // ----- seats -----

  seat(pl) { return (this.config && this.config.seats[pl]) || { type: 'human' }; }

  isComputer(pl) { return this.seat(pl).type === 'ai'; }

  humanSeats() { return this.config.seats.map((s, i) => (s.type === 'human' ? i : -1)).filter((i) => i >= 0); }

  // The seat the person at this screen plays, if there is exactly one.
  mySeat() {
    const c = this.config;
    if (!c) return null;
    if (c.mode === 'online') return c.myColor >= 0 ? c.myColor : null;
    if (c.mode === 'corr') return null;
    const h = this.humanSeats();
    return h.length === 1 ? h[0] : null;
  }

  isHumanTurn() {
    const g = this.game, c = this.config;
    if (!g || g.over || this.review !== null || c.mode === 'replay' || c.mode === 'idle') return false;
    if (c.mode === 'online') return g.player === c.myColor && this.app.online.connected;
    if (c.mode === 'corr') return !c.corr.waiting;
    return !this.isComputer(g.player);
  }

  // Called after every change to the game.
  after(anim) {
    const g = this.game;
    this.board.setHint(null);
    this.render(anim);
    this.persist();
    if (this.app.onGameChange) this.app.onGameChange(this);
    if (g.over) { this.finish(); return; }
    if (this.review !== null) return;
    const c = this.config;
    const computerSeat = this.isComputer(g.player) && (c.mode === 'ai' || c.mode === 'local' || (c.mode === 'online' && this.app.online.role === 'host'));
    if (computerSeat) {
      if (!this.thinking) this.computerTurn();
      return;
    }
    if (c.mode === 'replay' || c.mode === 'idle') return;
    if (c.mode === 'corr' && c.corr.waiting) return;
    const mine = c.mode === 'online' ? g.player === c.myColor : true;
    if (mine && !g.hasLegalMove()) {
      // Nothing legal: the edge is skipped and still counts.
      setTimeout(() => {
        if (this.game !== g || g.over) return;
        const pl = g.player;
        this.flash(`${this.nameOf(pl)} has no legal edge, so it is skipped.`);
        const before = g.turn;
        g.pass();
        this.turnEnded(before, pl);
        if (c.mode === 'online') this.app.online.sendMove({ kind: 'pass' }, g.history.length - 1, this.clockFor(pl));
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
    this.sound(entry, areasBefore, pl);
    this.app.profile.onMove(this, entry, areasBefore);
    this.turnEnded(before, pl);
    if (this.config.mode === 'online') this.app.online.sendMove(g.history[g.history.length - 1], g.history.length - 1, this.clockFor(pl));
    this.after(this.animOf(entry));
  }

  // Play a move that came from another browser (online), or from the host's
  // computer seats.
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
      this.sound(entry, areasBefore, pl);
      if (!this.remoteEvents.length) this.remoteBefore = areasBefore;
      this.remoteEvents.push(entry);
    }
    if (m.kind === 'timeout') this.flash(`${this.nameOf(pl)} ran out of time.`);
    this.turnEnded(before, pl);
    if (this.clock && typeof clockMs === 'number') this.clock.ms[pl] = clockMs;
    if (g.turn !== before || g.over) {
      this.summary = this.remoteEvents.length ? this.describeTurn(pl, this.remoteEvents, this.remoteBefore) : '';
      this.remoteEvents = [];
      if (this.summary) this.recap(this.summary);
    }
    this.after(entry && entry.kind === 'edge' ? this.animOf(entry) : null);
  }

  async computerTurn() {
    const g = this.game;
    const gen = this.gen;
    const pl = g.player;
    const seat = this.seat(pl);
    this.thinking = true;
    this.render(null);
    const t0 = performance.now();
    let res;
    try {
      res = await this.ai.think(g, seat.level || 'medium', (Date.now() ^ (g.placed * 7919)) >>> 0, { explain: true, style: seat.style || 'balanced', timeScale: this.config.timeScale || 1 });
    } catch {
      if (gen === this.gen) { this.thinking = false; this.render(null); }
      return;
    }
    if (gen !== this.gen || this.game !== g) return;
    const plan = res.plan || res;
    this.lastWhy = { player: pl, options: res.options || [], turn: g.turn, before: g.clone() };
    if (this.tab === 'why') this.renderWhy();
    const wait = Math.max(0, 450 - (performance.now() - t0));
    await sleep(wait);
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
      if (this.config.mode === 'online') this.app.online.sendMove(plan[i], g.history.length - 1, this.clockFor(pl));
      this.turnEnded(turn, pl);
      if (i < plan.length - 1 && !g.over && g.player === pl) {
        this.render(entry && entry.kind === 'edge' ? this.animOf(entry) : null);
        await sleep(this.app.settings.animate ? 650 : 250);
      } else {
        this.thinking = false;
        this.summary = this.describeTurn(pl, events, areaBefore);
        if (this.summary && !this.isComputer(g.player)) this.recap(this.summary);
        this.after(entry && entry.kind === 'edge' ? this.animOf(entry) : null);
        return;
      }
    }
    if (gen === this.gen) { this.thinking = false; this.render(null); }
  }

  // Bookkeeping when a turn may have just ended: clock increment, banners.
  turnEnded(turnBefore, pl) {
    const g = this.game;
    if (g.turn === turnBefore && !g.over) return;
    if (this.clock && g.turn !== turnBefore) this.clock.ms[pl] += this.clock.inc;
    if (this.clock) this.clock.last = performance.now();
    const last = g.timeline[g.timeline.length - 1];
    if (last) this.floatGains(last.areas);
    if (!g.over) sfx.turn();
    const c = this.config;
    if (!g.over && (c.mode === 'local' || c.mode === 'ai') && this.humanSeats().length > 1 && !this.isComputer(g.player)) this.banner(`${this.nameOf(g.player)} to play`);
    if (!g.over && c.mode === 'online' && g.player === c.myColor) this.banner('Your turn');
    if (c.mode === 'corr' && !g.over) {
      c.corr.waiting = true;
      c.corr.t = Date.now();
      this.app.corr.turnDone(this);
    }
  }

  banner(text) {
    const o = $('board-overlay');
    o.hidden = false;
    o.innerHTML = `<span>${esc(text)}</span>`;
    clearTimeout(this._banner);
    this._banner = setTimeout(() => { o.hidden = true; }, 1450);
  }

  // A short recap of what the other side just did.
  recap(text) {
    const el = $('recap');
    el.textContent = text;
    el.hidden = false;
    el.classList.remove('recap-in');
    void el.offsetWidth;
    el.classList.add('recap-in');
    clearTimeout(this._recap);
    this._recap = setTimeout(() => { el.hidden = true; }, 4200);
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

  describeTurn(pl, events, areaBefore) {
    const g = this.game;
    const parts = [];
    const me = this.mySeat();
    const byVictim = new Map();
    for (const e of events) if (e.broke) byVictim.set(e.broke.owner, (byVictim.get(e.broke.owner) || 0) + 1);
    for (const [v, count] of byVictim) {
      const lost = areaBefore[v] - g.areas[v];
      const whose = v === me ? 'your' : `${this.nameOf(v)}'s`;
      parts.push(`broke ${count === 1 ? 'one' : count} of ${whose} edges${lost > 1e-9 ? `, opening ${formatArea(lost)} area` : ''}`);
    }
    const gained = g.areas[pl] - areaBefore[pl];
    if (gained > 1e-9) parts.push(`fenced in ${formatArea(gained)} area`);
    if (!parts.length) return '';
    return `${this.nameOf(pl)} ${parts.join(' and ')}.`;
  }

  floatGains(areas) {
    if (!this.app.settings.animate) return;
    for (let pl = 0; pl < areas.length; pl++) {
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
    const cfg = this.config;
    if (g.over || cfg.mode === 'replay' || cfg.mode === 'idle' || cfg.mode === 'corr') return;
    // Against the computer or on one screen, the clock waits while you are
    // on another page. Online it keeps running.
    if (cfg.mode !== 'online' && (!this.app.isView('play') || document.hidden)) return;
    const pl = g.player;
    c.ms[pl] -= dt;
    if (c.ms[pl] <= 0) {
      const own = cfg.mode !== 'online' || pl === cfg.myColor || (this.isComputer(pl) && this.app.online.role === 'host');
      c.ms[pl] = 0;
      if (own) this.timeout();
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
    this.turnEnded(before, pl);
    // Out of time: the clock restarts at the increment.
    this.clock.ms[pl] = this.clock.inc;
    this.clock.last = performance.now();
    if (this.config.mode === 'online') this.app.online.sendMove({ kind: 'timeout' }, g.history.length - 1, this.clock.ms[pl]);
    this.flash(this.game.rules.timeout === 'edge' ? `${this.nameOf(pl)} ran out of time, so one edge is skipped.` : `${this.nameOf(pl)} ran out of time. The rest of the turn is skipped.`);
    this.after(null);
  }

  renderClocks() {
    if (!this.clock || !this.game) return;
    const g = this.game;
    for (let pl = 0; pl < g.NP; pl++) {
      const el = $(`clock-${pl}`);
      if (!el) continue;
      el.hidden = false;
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
    if (!g || !(c.mode === 'ai' || c.mode === 'local') || c.tournament) {
      if (c && (c.mode === 'online' || c.mode === 'corr' || c.tournament)) this.flash("Undo isn't available in this kind of game.");
      return;
    }
    if (this.review !== null) this.exitReview();
    let n = g.history.length;
    if (!n) return;
    const computers = c.seats.some((s) => s.type === 'ai');
    if (computers) {
      // Take back to just before the most recent edge by a person.
      let i = n - 1;
      while (i >= 0 && this.isComputer(g.history[i].player)) i--;
      if (i < 0) return;
      n = i;
    } else {
      n -= 1;
    }
    this.stop();
    this.game = this.newGame(g.history.slice(0, n));
    this.shownScores = this.game.scores.slice();
    this.summary = '';
    this.flash('Took back.');
    this.app.profile.noteUndo();
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
    this.app.profile.noteHint();
    this.flash(`Try ${g.pointName(m.fx, m.fy)} to ${g.pointName(m.tx, m.ty)}${r.breaks ? ', which breaks an edge' : ''}.`);
  }

  toggleShow(key) {
    this.show[key] = !this.show[key];
    store.save('show', this.show);
    this.renderShow();
    const tips = {
      weak: 'Orange marks your walls an opponent can reach. Green marks enemy walls you can break now.',
      reach: 'Shaded points are where each player can reach with one edge. Gray points can be reached by more than one.',
      risk: 'Each of your cells shows its chance of being opened over the next few turns.',
      warn: "The dashed line is the opponent's best cut if your turn ended now.",
    };
    if (this.show[key]) this.flash(tips[key]);
  }

  // The seat whose view the overlays use: the person to move, or the
  // person at this screen.
  focusSeat(g) {
    if (this.isHumanTurn()) return g.player;
    const me = this.mySeat();
    return me !== null ? me : g.player;
  }

  renderShow() {
    for (const b of document.querySelectorAll('.show-row [data-show]')) b.setAttribute('aria-pressed', String(!!this.show[b.dataset.show]));
    const g = this.viewGame();
    if (!g || this.config.mode === 'idle') { this.board.setCoach(null); this.board.setOverlay(null); this.board.setWarning(null); return; }
    const live = !g.over && this.isHumanTurn();
    this.board.setCoach(this.show.weak && live ? coachMarks(g) : null);
    const seat = this.focusSeat(g);
    if (this.show.risk) this.board.setOverlay({ kind: 'risk', cells: exposure(g, seat, {}, true).cells });
    else if (this.show.reach) this.board.setOverlay({ kind: 'reach' });
    else this.board.setOverlay(null);
    this.board.setWarning(this.show.warn && live ? nextEnemyBest(g, g.player) : null);
  }

  async resign() {
    const g = this.game, c = this.config;
    if (!g || g.over || c.mode === 'replay' || c.mode === 'idle') return;
    let pl = g.player;
    const me = this.mySeat();
    if (me !== null) pl = me;
    const ok = await this.app.confirm('Resign?', me === null ? `${this.nameOf(pl)} gives up this game.` : 'You give up this game.', 'Resign');
    if (!ok || this.game !== g || g.over) return;
    this.stop();
    g.resign(pl);
    if (c.mode === 'online') this.app.online.send({ t: 'resign', player: pl });
    if (c.mode === 'corr') this.app.corr.turnDone(this);
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
    const key = `${this.config.id}:${this.review}:${this.game.history.length}`;
    if (!this._reviewGame || this._reviewKey !== key) {
      this._reviewGame = this.newGame(this.game.history.slice(0, this.review));
      this._reviewKey = key;
    }
    return this._reviewGame;
  }

  enterReview(n = this.game.history.length) {
    this.review = Math.max(0, Math.min(this.game.history.length, n));
    $('review-bar').hidden = false;
    $('btn-review').textContent = this.config.mode === 'replay' ? 'Review' : 'Back to game';
    $('btn-review').disabled = this.config.mode === 'replay';
    $('review-continue').hidden = !(this.config.mode === 'ai' || this.config.mode === 'local' || this.config.mode === 'replay') || !!this.config.tournament;
    this.render(null);
  }

  exitReview() {
    if (this.config.mode === 'replay') return;
    this.review = null;
    $('review-bar').hidden = true;
    $('btn-review').textContent = 'Review';
    this.after(null);
  }

  // Play on from the position being reviewed (drops the later edges).
  async continueFromReview() {
    const c = this.config;
    const n = this.review;
    if (n === null) return;
    if (n < this.game.history.length && c.mode !== 'replay') {
      const ok = await this.app.confirm('Play from here?', 'Everything after this point in the game is dropped.', 'Play from here');
      if (!ok) return;
    }
    const hist = this.game.history.slice(0, n);
    const seats = c.mode === 'replay' ? this.config.seats.map(() => ({ type: 'human' })) : c.seats;
    this.start({ ...c, mode: c.mode === 'replay' ? 'local' : c.mode, seats, recorded: false, id: undefined }, hist, this.clock ? this.clock.ms : null);
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
        const h = this.newGame(this.game.history.slice(0, v - 1));
        const entry = h.play(m.fx, m.fy, m.tx, m.ty);
        anim = { added: entry.edge, broken: entry.broke, removedNodes: [] };
      }
    }
    this.render(anim);
  }

  // ----- rendering -----

  nameOf(pl) {
    const c = this.config;
    return (c && c.seats && c.seats[pl] && c.seats[pl].name) || (c && c.names && c.names[pl]) || seatNames(this.app.settings, 4)[pl];
  }

  sideName(side) {
    const g = this.game;
    if (!g.rules.teams) return this.nameOf(side);
    return g.membersOf(side).map((p) => this.nameOf(p)).join(' and ');
  }

  buildPlayers() {
    const n = this.game.NP;
    const el = $('players');
    el.className = `players players-${n}`;
    el.innerHTML = Array.from({ length: n }, (_, pl) => `
      <div class="player-card" data-pl="${pl}">
        <div class="pc-top"><span class="chip chip-p${pl}"></span><span class="pc-name" id="name-${pl}"></span><span class="pc-clock" id="clock-${pl}" hidden></span></div>
        <div class="pc-score"><span class="pc-points" id="score-${pl}">0</span><span class="pc-unit">points</span></div>
        <div class="pc-sub"><span id="income-${pl}">0</span> area held <span class="pc-delta" id="delta-${pl}"></span></div>
        <div class="pc-turn" id="turn-${pl}"></div>
      </div>`).join('');
  }

  render(anim) {
    const g = this.viewGame();
    if (!g) return;
    if (!$('players').children.length || $('players').children.length !== g.NP) this.buildPlayers();
    this.moveRows();
    const upto = g.history.length;
    this.board.scars = (this._breaks || []).filter((b) => b.at < upto && b.turn >= g.turn - (g.NP - 1)).map((b) => b.e);
    this.board.setGame(g, anim);
    this.board.setCanMove(this.isHumanTurn() && !this.thinking);
    this.renderPlayers(g);
    this.renderProgress(g);
    this.renderMoves();
    this.renderStatus();
    this.renderShow();
    this.renderClocks();
    if (this.tab === 'chart') this.renderChart();
    if (this.tab === 'share') this.renderShare();
    if (this.tab === 'coach') this.renderCoachTab();
    const c = this.config;
    const idle = c.mode === 'idle';
    $('btn-undo').disabled = !(c.mode === 'ai' || c.mode === 'local') || !!c.tournament || !this.game.history.length;
    $('btn-hint').disabled = !this.isHumanTurn() || this.thinking;
    $('btn-resign').disabled = this.game.over || c.mode === 'replay' || idle;
    $('btn-review').disabled = idle || c.mode === 'replay' || !this.game.history.length;
    if (this.review !== null) {
      const sl = $('review-slider');
      sl.max = String(this.game.history.length);
      sl.value = String(this.review);
      $('review-pos').textContent = `Edge ${this.review} of ${this.game.history.length}`;
    }
    $('a11y-desc').textContent = '';
  }

  // Score numbers count up to their new values.
  tickTo(el, from, to) {
    if (!this.app.settings.animate || Math.abs(to - from) < 0.05) { el.textContent = fmtPoints(to); return; }
    const t0 = performance.now(), dur = 450;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      el.textContent = fmtPoints(from + (to - from) * (1 - (1 - k) ** 3));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  renderPlayers(g) {
    const active = !g.over ? g.player : -1;
    const winner = g.over ? g.winner() : null;
    for (let pl = 0; pl < g.NP; pl++) {
      const card = document.querySelector(`.player-card[data-pl="${pl}"]`);
      if (!card) continue;
      card.classList.toggle('active', pl === active);
      const seat = this.seat(pl);
      $(`name-${pl}`).textContent = this.nameOf(pl) + (seat.type === 'ai' && this.config.mode !== 'replay' ? '' : '');
      const scoreEl = $(`score-${pl}`);
      const prev = this.shownScores[pl] ?? g.scores[pl];
      if (this.review === null && Math.abs(prev - g.scores[pl]) > 1e-9) this.tickTo(scoreEl, prev, g.scores[pl]);
      else scoreEl.textContent = fmtPoints(g.scores[pl]);
      $(`income-${pl}`).textContent = formatArea(g.areas[pl]);
      const turnEl = $(`turn-${pl}`);
      if (pl === active) {
        if (this.thinking && this.isComputer(pl)) turnEl.textContent = 'Thinking…';
        else {
          const pips = Array.from({ length: Math.max(g.turnSize, g.left) }, (_, i) => `<i class="pip${i < g.left ? ' full' : ''}"></i>`).join('');
          turnEl.innerHTML = `${pips}<span>${g.left} to place</span>`;
        }
      } else if (g.over) {
        turnEl.textContent = winner === g.sideOf(pl) ? 'Winner' : winner === -1 ? 'Draw' : '';
      } else turnEl.textContent = '';
      const tl = g.timeline;
      const prevA = tl.length >= 2 ? tl[tl.length - 2].areas[pl] : 0;
      const d = (tl.length ? tl[tl.length - 1].areas[pl] : 0) - prevA;
      const dEl = $(`delta-${pl}`);
      dEl.textContent = Math.abs(d) > 1e-9 && tl.length ? `(${d > 0 ? '+' : '−'}${formatArea(Math.abs(d))})` : '';
      dEl.className = `pc-delta ${d > 0 ? 'up' : 'down'}`;
    }
    if (this.review === null) this.shownScores = g.scores.slice();
    // Compact bar for narrow screens.
    const sb = $('scorebar');
    const cell = (pl) => `<div class="sb-p sp${pl}${pl === active ? ' active' : ''}"><span class="chip chip-p${pl}"></span><span class="sb-score">${fmtPoints(g.scores[pl])}</span><span class="sb-sub">${esc(this.nameOf(pl))}<br>${formatArea(g.areas[pl])} area${this.clock ? ` · <span class="sb-clock-${pl}">${fmtClock(this.clock.ms[pl])}</span>` : ''}</span></div>`;
    const mid = g.over ? '<b>Final</b>' : `<b>${esc(this.nameOf(g.player))}</b>${this.thinking ? 'thinking' : `${g.left} to place`}`;
    sb.className = `scorebar sb-${g.NP}`;
    if (g.NP === 2) sb.innerHTML = `${cell(0)}<div class="sb-mid">${mid}<br>${g.placed}/${g.totalEdges}</div>${cell(1)}`;
    else sb.innerHTML = `${Array.from({ length: g.NP }, (_, pl) => cell(pl)).join('')}<div class="sb-mid sb-wide">${mid} · ${g.placed}/${g.totalEdges}</div>`;
  }

  renderProgress(g) {
    $('progress-text').textContent = `Edge ${g.placed} of ${g.totalEdges}`;
    const left = g.updatesLeft();
    $('updates-text').textContent = g.over ? 'Game over' : `${left} score update${left === 1 ? '' : 's'} left`;
    $('progress-fill').style.width = `${(g.placed / g.totalEdges) * 100}%`;
    let text = '';
    if (!g.over && left > 0) {
      if (g.rules.teams) {
        const sc = g.sideScores(), ar = g.sideAreas();
        text = `If nobody's area changes: ${[0, 1].map((s) => `${this.sideName(s)} ${fmtPoints(sc[s] + ar[s] * left)}`).join(', ')}`;
      } else {
        text = `If nobody's area changes: ${Array.from({ length: g.NP }, (_, pl) => `${this.nameOf(pl)} ${fmtPoints(g.scores[pl] + g.areas[pl] * left)}`).join(', ')}`;
      }
    } else if (g.rules.teams) {
      const sc = g.sideScores();
      text = `Team totals: ${[0, 1].map((s) => `${this.sideName(s)} ${fmtPoints(sc[s])}`).join(', ')}`;
    }
    $('projection').textContent = text;
    const rulesText = describeRules(g.rules);
    $('rules-note').textContent = rulesText;
    $('rules-note').hidden = !rulesText;
  }

  moveRows() {
    const hist = this.game.history;
    const key = `${this.config.id}:${encodeHistory(hist, this.config.rules)}`;
    if (this._rowsKey === key) return this._rows;
    const rows = [];
    const breaks = [];
    let i = 0;
    const replay = this.newGame([]);
    while (i < hist.length) {
      const pl = replay.player;
      const startTurn = replay.turn;
      const cells = [];
      const startI = i;
      while (i < hist.length && replay.turn === startTurn && !replay.over) {
        const m = hist[i];
        let entry = null;
        try { entry = replay.apply(m); } catch { break; }
        if (entry && entry.broke) breaks.push({ turn: startTurn, at: i, e: entry.broke });
        const name = m.kind === 'edge' ? replay.moveName({ ...m, broke: entry && entry.broke }) : moveName(m);
        cells.push(`<button data-n="${i + 1}">${name}</button>`);
        i++;
        if (m.kind === 'resign') break;
      }
      if (i === startI) break;
      const tl = replay.timeline[replay.timeline.length - 1];
      const after = tl && tl.turn === startTurn ? tl.areas.map((a) => formatArea(a)).join(' / ') : '';
      rows.push({ from: startI, to: i, html: `<span class="mv-n">${startTurn}.</span><span class="mv-p${pl}">${cells.join(', ')}</span><span class="mv-s" title="Area held after the turn">${after}</span>` });
    }
    this._rowsKey = key;
    this._rows = rows;
    this._breaks = breaks;
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
    renderChart($('chart'), this.viewGame().timeline, this.game.updatesLeft() + this.game.timeline.length, this.viewGame().NP);
  }

  shareURL() {
    const base = location.href.split('#')[0];
    if (this.config.base) return `${base}#a=${encodeURIComponent(encodePosition(this.viewGame()))}`;
    const r = encodeRules(this.config.rules);
    const names = this.config.mode === 'replay' ? '' : `&n=${encodeURIComponent(this.config.names.join('|'))}`;
    return `${base}#g=${encodeHistory(this.game.history, this.config.rules)}${r ? `&r=${r}` : ''}${names}`;
  }

  renderShare() {
    $('share-link').value = this.shareURL();
  }

  status() {
    const g = this.viewGame(), c = this.config;
    if (c.mode === 'idle') return 'Press New game to start.';
    if (this.review !== null) {
      if (c.mode === 'replay') return 'Replay. Use the arrows or the slider to step through the game, or press Play from here.';
      return 'Reviewing. The game is paused here. Press Back to game to continue.';
    }
    if (g.over) {
      const w = g.winner();
      if (g.resigned !== null) return `${this.nameOf(g.resigned)} resigned.${w >= 0 ? ` ${this.sideName(w)} win${g.rules.teams ? '' : 's'}.` : ''}`;
      const sc = g.sideScores();
      if (w === -1) return `Draw at ${fmtPoints(Math.max(...sc))}.`;
      const others = sc.filter((_, s) => s !== w);
      return `${this.sideName(w)} win${g.rules.teams ? '' : 's'}, ${fmtPoints(sc[w])} to ${fmtPoints(Math.max(...others))}.`;
    }
    const left = g.left === 1 ? '1 edge' : `${g.left} edges`;
    const sum = this.summary ? `${this.summary} ` : '';
    if (c.mode === 'online') {
      if (!this.app.online.connected) return 'Waiting for the connection…';
      if (!(c.myColor >= 0)) return `${sum}Watching. ${esc(this.nameOf(g.player))} to play.`;
      if (g.player !== c.myColor) return `${sum}Waiting for ${esc(this.nameOf(g.player))}…`;
      return `${sum}Your turn: place ${left}.`;
    }
    if (c.mode === 'corr') {
      const tl = this.app.corr.timeLeft(this);
      const limit = tl ? ` ${tl[0].toUpperCase()}${tl.slice(1)} for this turn.` : '';
      if (c.corr.waiting) return `Waiting for ${esc(this.nameOf(g.player))}. Send them the link below.${limit}`;
      return `${esc(this.nameOf(g.player))} to play: ${left}.${limit}`;
    }
    if (this.isComputer(g.player)) return this.thinking ? `${sum}${esc(this.nameOf(g.player))} is thinking…` : `${sum}${esc(this.nameOf(g.player))} to play.`;
    const mine = this.mySeat();
    if (mine !== null && g.player === mine) {
      if (g.placed === 0) return `You go first. Place ${left}: pick one of your nodes, then a point in its square.`;
      return `${sum}Your turn: place ${left}.`;
    }
    return `${sum}${esc(this.nameOf(g.player))} to play: ${left}.`;
  }

  renderStatus() {
    const el = $('status');
    if (this.flashMsg && performance.now() - this.flashMsg.t < 4500) {
      el.innerHTML = `<span class="${this.flashMsg.kind === 'bad' ? 's-bad' : this.flashMsg.kind === 'good' ? 's-good' : ''}">${esc(this.flashMsg.text)}</span>`;
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
    const r = info.r;
    let text, cls = '';
    if (!r.ok) {
      text = r.reason;
      cls = 's-bad';
    } else {
      const bits = [];
      if (r.breaks) {
        const who = this.nameOf(r.breaks.owner);
        bits.push(info.loss > 1e-9 ? `Breaks a ${who} edge: ${formatArea(info.loss)} of their area opens up.` : `Breaks a ${who} edge.`);
      }
      if (info.gain > 1e-9) bits.push(`Fences in ${formatArea(info.gain)} area.`);
      text = bits.join(' ') || `${this.game.pointName(info.fx, info.fy)} to ${this.game.pointName(info.tx, info.ty)}`;
      if (bits.length) cls = 's-good';
      if (this.board.pendingTap) text += ' Tap again to place it.';
    }
    el.innerHTML = `<span class="${cls}">${esc(text)}</span>`;
  }

  describe() {
    const text = describePosition(this.viewGame(), this.config.names);
    $('a11y-desc').textContent = text;
    this.flash(text);
  }

  // ----- coach and why -----

  renderCoachTab() {
    const el = $('coach-out');
    const g = this.viewGame();
    if (!g || g.over || this.config.mode === 'idle') { el.innerHTML = '<p class="small">Tips show up here during your turns.</p>'; return; }
    if (!this.isHumanTurn()) { el.innerHTML = `<p class="small">Tips appear on your turn.</p>`; return; }
    const key = `${this.config.id}:${g.history.length}`;
    if (this._coachKey === key) return;
    this._coachKey = key;
    const tips = coachTips(g, this.config.names);
    el.innerHTML = tips.length ? `<ul class="tips">${tips.map((t) => `<li>${t}</li>`).join('')}</ul>` : '<p class="small">Nothing urgent. Keep building.</p>';
  }

  renderWhy() {
    const el = $('why-out');
    const w = this.lastWhy;
    if (!w || !w.options.length) { el.innerHTML = '<p class="small">After a computer turn, this shows what it chose and what else it considered.</p>'; return; }
    const g = w.before;
    const name = this.nameOf(w.player);
    const desc = (o) => o.plan.map((m) => (m.kind === 'edge' ? `${g.pointName(m.fx, m.fy)}-${g.pointName(m.tx, m.ty)}` : m.kind)).join(', ');
    const best = w.options[0];
    const rows = w.options.map((o, i) => `
      <tr${i === 0 ? ' class="chosen"' : ''}><td>${i === 0 ? 'Chosen' : `Option ${i + 1}`}<br><code>${desc(o)}</code></td>
      <td>${formatArea(o.gain || 0)}</td><td>${formatArea(o.cut || 0)}</td><td>${formatArea(o.lost || 0)}</td><td>${formatArea((o.exMe || 0) - (o.exOp || 0))}</td>
      <td><b>${o.value !== undefined ? (o.value - best.value).toFixed(1) : ''}</b></td></tr>`).join('');
    el.innerHTML = `<p>${esc(name)} looked at its options for turn ${w.turn}. The columns are the area it fenced in, the area it cut, what it expected to lose on the next turn, and its long-term risk compared with yours. The last column is how far each option scored below its choice.</p>
      <table class="why"><thead><tr><th>Turn</th><th>Fenced</th><th>Cut</th><th>At risk next</th><th>Risk gap</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ----- post-game report -----

  runReport() {
    this.app.report.run(this, $('report-out'));
  }

  // ----- game over -----

  finish() {
    const g = this.game, c = this.config;
    this.thinking = false;
    this.render(null);
    if (!c.tournament) store.remove('current');
    const w = g.winner();
    const mine = this.mySeat();
    let title;
    if (mine !== null) title = w === -1 ? 'Draw' : w === g.sideOf(mine) ? (g.rules.teams ? 'Your team wins!' : 'You win!') : 'You lose';
    else title = w === -1 ? 'Draw' : `${this.sideName(w)} win${g.rules.teams ? '' : 's'}`;
    const watching = c.mode === 'online' && !(c.myColor >= 0);
    if (!c.recorded && c.mode !== 'replay' && c.mode !== 'idle' && !watching) {
      c.recorded = true;
      this.app.profile.recordGame(this);
      if (c.tournament) this.app.tournament.reportResult(c.tournament, g);
      if (c.mode === 'corr') this.app.corr.turnDone(this);
      this.app.renderRecord();
    }
    if (c.mode === 'replay' || c.shownOver === g.history.length) return;
    c.shownOver = g.history.length;
    if (mine !== null) (w === g.sideOf(mine) ? sfx.win : sfx.lose)();
    else sfx.win();
    setTimeout(() => this.showOver(title), 700);
  }

  stats() {
    const g = this.game;
    const r = this.newGame([]);
    const breaks = new Array(g.NP).fill(0), peak = new Array(g.NP).fill(0), lost = new Array(g.NP).fill(0);
    for (const m of g.history) {
      const pl = r.player;
      let e = null;
      try { e = r.apply(m); } catch { break; }
      if (e && e.broke) { breaks[pl]++; lost[e.broke.owner]++; }
      for (let q = 0; q < g.NP; q++) peak[q] = Math.max(peak[q], r.areas[q]);
    }
    return { breaks, peak, lost };
  }

  showOver(title) {
    const g = this.game;
    if (!g.over) return;
    $('over-title').textContent = title;
    $('over-sub').textContent = g.resigned !== null ? `${this.nameOf(g.resigned)} resigned.` : `After all ${g.totalEdges} edges.`;
    const order = Array.from({ length: g.NP }, (_, p) => p).sort((a, b) => g.scores[b] - g.scores[a]);
    $('over-scores').innerHTML = order.map((pl) => `<div><b>${fmtPoints(g.scores[pl])}</b><span><i class="chip chip-p${pl}"></i>${esc(this.nameOf(pl))}</span></div>`).join('');
    const st = this.stats();
    const list = (arr, f = (v) => v) => arr.map((v, i) => `<b class="t-p${i}">${f(v)}</b>`).join(' / ');
    $('over-stats').innerHTML = `
      ${g.rules.teams ? `<div class="span2">Team totals<br>${[0, 1].map((s) => `${esc(this.sideName(s))} <b>${fmtPoints(g.sideScores()[s])}</b>`).join(', ')}</div>` : ''}
      <div>Most area held<br>${list(st.peak, formatArea)}</div>
      <div>Edges broken<br>${list(st.breaks)}</div>
      <div>Area at the end<br>${list(g.areas, formatArea)}</div>
      <div>Points per turn<br>${list(g.scores, (v) => (v / Math.max(1, g.timeline.length) * g.NP).toFixed(1))}</div>`;
    const role = this.app.online.role;
    $('btn-over-again').textContent = this.config.mode === 'online' ? (role === 'host' ? 'Rematch' : 'Ask for a rematch') : this.config.tournament ? 'Back to the tournament' : 'Play again';
    $('btn-over-again').hidden = this.config.mode === 'online' && role === 'watch';
    $('btn-over-report').hidden = false;
    this.app.openDialog('dlg-over');
  }

  again() {
    const c = this.config;
    if (c.mode === 'online') { this.app.onlineRematch(); return; }
    if (c.tournament) { location.hash = '#tournament'; return; }
    if (c.mode === 'replay' || c.mode === 'corr') { this.app.openNewGame('ai'); return; }
    this.start({ mode: c.mode, rules: c.rules, seats: c.seats, clock: c.clock, timeScale: c.timeScale });
  }

  // ----- export -----

  record() {
    const g = this.game;
    const r = this.newGame([]);
    const notation = [];
    for (const m of g.history) {
      const e = r.apply(m);
      notation.push(m.kind === 'edge' ? r.moveName({ ...m, broke: e && e.broke }) : moveName(m));
    }
    return {
      game: 'Enclosure', date: new Date().toISOString(), players: this.config.names.slice(0, g.NP),
      rules: this.config.rules, scores: g.scores, finished: g.over,
      code: encodeHistory(g.history, this.config.rules), rulesCode: encodeRules(this.config.rules), moves: notation,
    };
  }

  downloadRecord() {
    const blob = new Blob([JSON.stringify(this.record(), null, 2)], { type: 'application/json' });
    download(blob, `enclosure-${new Date().toISOString().slice(0, 10)}.json`);
  }

  async saveImage() {
    try {
      const blob = await boardImage(this.viewGame(), this.config.names);
      download(blob, `enclosure-${this.viewGame().placed}.png`);
    } catch {
      this.app.toast("Couldn't make the picture in this browser.");
    }
  }

  async exportReplay(kind) {
    const btn = kind === 'gif' ? $('btn-gif') : $('btn-video');
    const label = btn.textContent;
    btn.disabled = true;
    try {
      const { exportGif, exportVideo } = await import('./export.js');
      const onProgress = (p) => { btn.textContent = `${Math.round(p * 100)}%`; };
      const res = kind === 'gif'
        ? await exportGif(this.game.history, this.config.rules, this.config.names, onProgress)
        : await exportVideo(this.game.history, this.config.rules, this.config.names, onProgress);
      download(res.blob, `enclosure-replay.${res.ext}`);
    } catch (e) {
      this.app.toast(e && e.message ? e.message : "Couldn't make the replay in this browser.");
    } finally {
      btn.textContent = label;
      btn.disabled = false;
    }
  }
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// A short line about any rules that differ from the standard game.
export function describeRules(r) {
  const R = makeRules(r);
  const bits = [];
  if (R.size !== 19) bits.push(`${R.size} by ${R.size} board`);
  if (R.radius !== 3) bits.push(`reach ${R.radius}`);
  if (R.players > 2) bits.push(R.teams ? '2 v 2 teams' : `${R.players} players`);
  if (R.perPlayer !== 60) bits.push(`${R.perPlayer} edges each`);
  if (!R.protect) bits.push('no protection');
  if (R.border) bits.push('border walls');
  if (R.timeout === 'edge') bits.push('timeouts skip one edge');
  if (R.stuck === 'turn') bits.push('stuck players skip the turn');
  if (R.handicap.some((h) => h)) bits.push(`handicap ${R.handicap.slice(0, R.players).join('/')}`);
  return bits.length ? `Rules: ${bits.join(', ')}.` : '';
}

// Plain tips for the player to move.
export function coachTips(g, names) {
  const me = g.player;
  const nm = (p) => (names && names[p]) || `Player ${p + 1}`;
  const tips = [];
  const moves = scoreMoves(g);
  const bestGain = moves.reduce((b, m) => (m.gain > (b ? b.gain : 1e-9) ? m : b), null);
  const bestCut = moves.reduce((b, m) => (m.loss > (b ? b.loss : 1e-9) ? m : b), null);
  if (bestCut) tips.push(`You can cut ${esc(nm(bestCut.breaks.owner))}'s wall with <code>${g.pointName(bestCut.fx, bestCut.fy)}-${g.pointName(bestCut.tx, bestCut.ty)}</code>, opening ${formatArea(bestCut.loss)} of their area.`);
  if (bestGain) tips.push(`<code>${g.pointName(bestGain.fx, bestGain.fy)}-${g.pointName(bestGain.tx, bestGain.ty)}</code> fences in ${formatArea(bestGain.gain)} right away.`);
  const marks = coachMarks(g);
  if (marks.weak.length) {
    const w = marks.weak.reduce((a, b) => (b.loss > a.loss ? b : a));
    tips.push(`${marks.weak.length === 1 ? 'One of your walls is' : `${marks.weak.length} of your walls are`} in reach of an opponent. The one at <code>${g.pointName(w.ax, w.ay)}-${g.pointName(w.bx, w.by)}</code> guards ${formatArea(w.loss)} area.`);
  }
  const threat = nextEnemyBest(g, me);
  if (threat) tips.push(`If your turn ended now, ${esc(nm(threat.player))}'s best single edge would open ${formatArea(threat.cut)} of your area.`);
  const big = g.analysis(me).faces.filter((f) => !f.nested && f.area >= 12);
  if (big.length) tips.push(`You have a cell of ${formatArea(Math.max(...big.map((f) => f.area)))} area. Splitting big cells means one break costs less.`);
  if (g.rules.protect && g.left >= 2 && g.areas[me] > 0) tips.push('Edges you place this turn are protected on the next one, so closing a loop with both edges keeps it safer.');
  const left = g.updatesLeft();
  if (left <= 6) tips.push(`${left} score update${left === 1 ? '' : 's'} left. Area you fence in now pays only ${left} more time${left === 1 ? '' : 's'}, while a cut costs the other side the same.`);
  return tips;
}
