// Page shell: routing, dialogs, settings, and the glue between screens.
import { Game, decodeHistory, decodeRules, decodePosition, encodeHistory, encodeRules, makeRules } from './engine.js';
import { PlayView, LEVEL_NAMES, STYLE_NAMES } from './play.js';
import { LearnView } from './learn.js';
import { GuideView } from './guide.js';
import { PuzzleView, dailyIndex, dailyNumber, typeOf, TYPE_NAMES } from './puzzles.js';
import { PUZZLES } from './puzzledata.js';
import { AnalysisView } from './analysis.js';
import { Online, EMOTES } from './online.js';
import { Corr, b64decode } from './corr.js';
import { Tournaments } from './tournament.js';
import { Profiles, renderYou } from './profile.js';
import { Report } from './report.js';
import { SolverClient } from './solver-client.js';
import { Demo } from './demo.js';
import { drawAllDiagrams } from './diagrams.js';
import { setSound } from './sound.js';
import { PALETTE, DEFAULT_SEATS, FRIENDLY_SEATS, applyColors, seatColors, seatNames } from './colors.js';
import { watchErrors, problemReport } from './errors.js';
import { startAnalytics } from './config.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const F = (form, name) => form.elements.namedItem(name);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Which top menu item each screen belongs to.
const NAV_OF = { play: 'play', puzzles: 'puzzles', learn: 'learn', guide: 'learn', rules: 'learn', analysis: 'analysis', you: 'you' };

function parseClock(v) {
  if (!v || v === 'none') return null;
  const [base, inc] = v.split('+').map(Number);
  return { base: base * 1000, inc: inc * 1000 };
}

// "a=1&b=2" to { a: '1', b: '2' }.
function parseParams(s) {
  const out = {};
  for (const part of s.split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1)); } catch { out[part.slice(0, i)] = part.slice(i + 1); }
  }
  return out;
}

function session(key, value) {
  try {
    if (value === undefined) return JSON.parse(sessionStorage.getItem(key) || 'null');
    if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
  return null;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

class App {
  constructor() {
    watchErrors();
    this.settings = store.getSettings();
    this.online = new Online();
    this.applySettings();
    this.profile = new Profiles(this);
    this.solver = new SolverClient();
    this.report = new Report(this);
    this.corr = new Corr(this);
    this.tournament = new Tournaments(this);
    this.play = new PlayView(this);
    this.learn = new LearnView(this);
    this.guide = new GuideView(this);
    this.puzzles = new PuzzleView(this);
    this.analysis = new AnalysisView(this);
    this.demo = new Demo($('demo-board'), $('demo-caption'));
    this.view = null;
    this.bind();
    this.bindNewGame();
    this.bindSettings();
    this.bindOnline();
    this.bindYou();
    this.bindTournament();
    drawAllDiagrams();
    this.renderRecord();
    this.renderDaily();
    window.addEventListener('hashchange', () => this.route());
    document.addEventListener('visibilitychange', () => this.updateDemo());
    const dark = matchMedia('(prefers-color-scheme: dark)');
    if (dark.addEventListener) dark.addEventListener('change', () => applyColors(this.settings));
    this.resumeOnline();
    this.route();
    this.pwa();
    startAnalytics();
  }

  // ----- routing -----

  route() {
    const h = location.hash.slice(1);
    if (/^(g|c|a|p|join|watch)=/.test(h)) { this.routeLink(parseParams(h)); return; }
    const [name, arg, arg2] = h.split('/');
    switch (name) {
      case 'play':
        this.show('play');
        if (!this.play.game) {
          if (this.pendingOnline) this.play.start({ mode: 'idle', seats: [], clock: null });
          else if (!this.play.resumeSaved()) {
            this.play.start({ mode: 'idle', seats: [], clock: null });
            this.openNewGame('ai');
          }
        }
        return;
      case 'learn': this.show('learn'); this.learn.route(arg); return;
      case 'guide': this.show('guide'); this.guide.route(arg); return;
      case 'puzzles': this.show('puzzles'); this.puzzles.route(arg, arg2); return;
      case 'analysis': this.show('analysis'); this.analysis.render(); return;
      case 'tournament': this.show('tournament'); this.tournament.render($('view-tournament')); return;
      case 'you': this.show('you'); renderYou(this, $('view-you')); return;
      case 'rules': case 'about': this.show(name); return;
      default: this.show('home');
    }
  }

  // Links that carry a game, a position or an invite.
  routeLink(q) {
    if (q.g !== undefined) {
      try {
        const rules = q.r ? decodeRules(q.r) : makeRules({});
        const moves = decodeHistory(q.g, rules);
        Game.fromHistory(moves, null, rules);
        const names = q.n ? q.n.split('|').map((x) => x.slice(0, 24)) : null;
        this.play.replay(moves, rules, names);
        this.show('play');
      } catch {
        this.toast("That game link doesn't work.");
        this.show('home');
      }
      return;
    }
    if (q.c !== undefined) {
      if (this.corr.open(q.c)) this.show('play'); else this.show('home');
      return;
    }
    if (q.a !== undefined) {
      try {
        const base = decodePosition(q.a);
        this.analysis.push();
        this.analysis.load(base);
        this.show('analysis');
      } catch {
        this.toast("That position link doesn't work.");
        this.show('home');
      }
      return;
    }
    if (q.p !== undefined) {
      this.show('puzzles');
      this.puzzles.openShared(q.p, q.b);
      return;
    }
    if (q.join) { this.openJoin(q.join); return; }
    if (q.watch) { this.watch(q.watch); }
  }

  show(name) {
    if (this.view !== name) window.scrollTo(0, 0);
    if (this.view === 'puzzles' && name !== 'puzzles') this.puzzles.stopRush(false);
    if (name !== 'play') document.body.classList.remove('focus');
    this.view = name;
    for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${name}`);
    for (const a of document.querySelectorAll('[data-nav]')) {
      const on = a.dataset.nav === NAV_OF[name];
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    const v = $(`view-${name}`);
    if (v && v.dataset.title) document.title = v.dataset.title;
    if (name === 'home') { this.renderResume(); this.renderCorr(); this.renderDaily(); this.renderRecord(); }
    this.updateDemo();
  }

  isView(name) { return this.view === name; }

  updateDemo() {
    if (this.view === 'home') this.demo.show();
    if (this.view === 'home' && !document.hidden) this.demo.start();
    else this.demo.stop();
  }

  goPlay() {
    if (location.hash !== '#play') location.hash = '#play';
    else this.show('play');
  }

  // ----- home -----

  renderResume() {
    const s = this.play.saved();
    const card = $('resume-card');
    if (!s || !s.config) { card.hidden = true; return; }
    card.hidden = false;
    const c = s.config;
    const ai = (c.seats || []).find((x) => x.type === 'ai');
    const humans = (c.seats || []).filter((x) => x.type === 'human').length;
    let who;
    if (ai && humans === 1) who = `You are playing the computer (${LEVEL_NAMES[ai.level] || ai.level})`;
    else who = 'A game on this screen';
    $('resume-text').textContent = `${who}, edge ${s.edges} of ${s.total || 120}.`;
  }

  renderCorr() {
    const list = this.corr.summary();
    $('corr-card').hidden = !list.length;
    if (!list.length) return;
    $('corr-list').innerHTML = list.map((r) => {
      const names = r.names.map((n, i) => `<i class="chip chip-p${i}"></i>${esc(n)}`).join(' ');
      let state;
      if (r.over) state = 'Finished';
      else if (r.waiting) state = `Waiting for ${esc(r.names[r.toMove] || 'the next player')}`;
      else if ((r.mine || []).includes(r.toMove)) state = '<b>Your move</b>';
      else state = `${esc(r.names[r.toMove] || 'Next player')} to play`;
      return `<li><button class="link" data-corr="${esc(r.id)}">${names}</button><span class="small">${state}</span><button class="link small" data-corr-del="${esc(r.id)}" aria-label="Remove this game">Remove</button></li>`;
    }).join('');
  }

  renderDaily() {
    const i = dailyIndex();
    const p = PUZZLES[i];
    if (!p) { $('daily-card').hidden = true; return; }
    const solved = this.puzzles.solved.has(p.pos || p.code);
    $('daily-text').textContent = `#${dailyNumber()} · ${TYPE_NAMES[typeOf(p)]}. ${solved ? 'Solved. A new one comes tomorrow.' : 'A new one every day, the same for everyone.'}`;
    $('btn-daily').href = solved ? '#puzzles/daily' : `#puzzles/${i + 1}`;
    $('btn-daily').textContent = solved ? 'See past days' : 'Solve it';
  }

  renderRecord() {
    const by = this.profile.current.stats.byLevel || {};
    const levels = ['easy', 'medium', 'hard', 'adaptive'];
    const any = levels.some((l) => by[l] && by[l].w + by[l].l + by[l].d > 0);
    $('record-card').hidden = !any;
    if (!any) return;
    $('record-grid').innerHTML = levels.filter((l) => by[l]).map((l) => {
      const r = by[l];
      return `<div class="record-cell"><span>${LEVEL_NAMES[l]}</span><b>${r.w} won, ${r.l} lost</b><span>${r.d ? `${r.d} drawn · ` : ''}best score ${r.best || 0}</span></div>`;
    }).join('');
  }

  // ----- buttons and dialogs -----

  bind() {
    for (const b of document.querySelectorAll('[data-start]')) b.onclick = () => this.openNewGame(b.dataset.start);
    $('btn-resume').onclick = () => {
      const p = this.play;
      const live = p.game && !p.game.over && p.config && (p.config.mode === 'ai' || p.config.mode === 'local') && !p.config.tournament;
      if (live || p.resumeSaved()) this.goPlay();
    };
    $('corr-list').onclick = async (e) => {
      const open = e.target.closest('[data-corr]');
      if (open) { this.corr.resume(open.dataset.corr); this.goPlay(); return; }
      const del = e.target.closest('[data-corr-del]');
      if (del && await this.confirm('Remove this game?', 'It is only removed from this browser. Anyone with a link can still open it.', 'Remove')) {
        this.corr.remove(del.dataset.corrDel);
        this.renderCorr();
      }
    };
    $('btn-settings').onclick = () => this.openSettings();
    $('btn-over-close').onclick = () => $('dlg-over').close();
    $('btn-over-review').onclick = () => { $('dlg-over').close(); this.play.enterReview(0); };
    $('btn-over-again').onclick = () => { $('dlg-over').close(); this.play.again(); };
    $('btn-over-report').onclick = () => { $('dlg-over').close(); this.play.openTab('report'); this.play.runReport(); };
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) document.body.classList.remove('focus');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('focus') && !document.querySelector('dialog[open]')) this.toggleFocus(false);
    });
  }

  openDialog(id) {
    const d = $(id);
    if (d.open) return;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }

  confirm(title, text, ok = 'OK') {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-yes').textContent = ok;
    const d = $('dlg-confirm');
    d.returnValue = '';
    this.openDialog('dlg-confirm');
    return new Promise((resolve) => {
      d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
    });
  }

  // Resolves to the text typed, or null if cancelled.
  prompt(title, text, value = '', multiline = true) {
    $('prompt-title').textContent = title;
    $('prompt-text').textContent = text;
    const input = $('prompt-input');
    input.value = value;
    input.rows = multiline ? 3 : 1;
    input.onkeydown = (e) => {
      if (!multiline && e.key === 'Enter') { e.preventDefault(); $('dlg-prompt').close('yes'); }
    };
    const d = $('dlg-prompt');
    d.returnValue = '';
    this.openDialog('dlg-prompt');
    input.focus();
    input.select();
    return new Promise((resolve) => {
      d.addEventListener('close', () => resolve(d.returnValue === 'yes' ? input.value : null), { once: true });
    });
  }

  toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(this._toast);
    this._toast = setTimeout(() => { t.hidden = true; }, 3600);
  }

  async copy(text, msg = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(msg);
    } catch {
      this.toast('Select the text and copy it yourself.');
    }
  }

  // A game from any kind of link the site makes, or null.
  gameFromLink(text) {
    const i = text.indexOf('#');
    const q = parseParams(i >= 0 ? text.slice(i + 1) : text);
    if (q.g !== undefined) {
      const rules = q.r ? decodeRules(q.r) : makeRules({});
      return Game.fromHistory(decodeHistory(q.g, rules), null, rules);
    }
    if (q.c !== undefined) {
      const p = b64decode(q.c);
      const rules = decodeRules(p.r || '');
      return Game.fromHistory(decodeHistory(p.m || '', rules), null, rules);
    }
    if (q.a !== undefined) return new Game(decodePosition(q.a));
    if (q.p !== undefined) return new Game(decodePosition(q.p));
    return null;
  }

  openAnalysis(game) {
    if (!game) return;
    this.analysis.openFrom(game);
    location.hash = '#analysis';
  }

  toggleFocus(force) {
    const on = force === undefined ? !document.body.classList.contains('focus') : force;
    document.body.classList.toggle('focus', on);
    try {
      const root = document.documentElement;
      if (on && root.requestFullscreen && !document.fullscreenElement) root.requestFullscreen().catch(() => {});
      if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    } catch { /* not supported */ }
  }

  // ----- new game -----

  bindNewGame() {
    const form = $('form-new');
    form.addEventListener('change', (e) => this.syncNewForm(e));
    $('dlg-new').addEventListener('close', () => {
      if ($('dlg-new').returnValue === 'start') this.startFromForm();
    });
  }

  openNewGame(mode = 'ai') {
    const f = $('form-new');
    const last = store.load('lastSetup', {});
    const set = (name, v, fallback) => { const el = F(f, name); if (el) el.value = v ?? fallback; };
    set('mode', mode || last.mode, 'ai');
    set('players', last.players, '2');
    set('gameLength', last.gameLength, 'standard');
    set('level', last.level, 'medium');
    set('aiStyle', last.aiStyle, 'balanced');
    set('clock', last.clock, 'none');
    set('days', last.days, '0');
    set('size', last.size, '');
    set('perPlayer', last.perPlayer, '');
    set('radius', last.radius, '3');
    set('timeout', last.timeout, 'turn');
    set('timeScale', last.timeScale, '1');
    F(f, 'noProtect').checked = !!last.noProtect;
    F(f, 'border').checked = !!last.border;
    this.seatDraft = { names: [], types: [], corrNames: [], handicap: [], color: '0', ...(last.seats || {}) };
    this._seatCount = null;
    this.syncNewForm(null);
    $('dlg-new').returnValue = '';
    this.openDialog('dlg-new');
  }

  seatCount() {
    const v = F($('form-new'), 'players').value;
    return v === 'teams' ? 4 : Number(v) || 2;
  }

  // Remembers what was typed in the per-seat controls before they are rebuilt.
  captureSeats() {
    const f = $('form-new');
    const d = this.seatDraft;
    for (let i = 0; i < 4; i++) {
      const nm = F(f, `seatName${i}`), ty = F(f, `seatType${i}`), cn = F(f, `corrName${i}`), hc = F(f, `hc${i}`);
      if (nm) d.names[i] = nm.value;
      if (ty) d.types[i] = ty.value;
      if (cn) d.corrNames[i] = cn.value;
      if (hc) d.handicap[i] = hc.value;
    }
    const c = F(f, 'color');
    if (c && c.value !== '') d.color = c.value;
  }

  buildSeatControls(n) {
    const d = this.seatDraft;
    const teams = F($('form-new'), 'players').value === 'teams';
    const names = seatNames(this.settings, n);
    const mate = (i) => (teams ? ` and ${names[(i + 2) % 4]}` : '');
    const color = d.color === 'random' || Number(d.color) < n ? d.color : '0';
    $('color-choices').innerHTML = names.map((nm, i) => `<label><input type="radio" name="color" value="${i}"${String(i) === String(color) ? ' checked' : ''}><span><i class="chip chip-p${i}"></i>${esc(nm)}${mate(i)}${i === 0 ? ', first' : ''}</span></label>`).join('')
      + `<label><input type="radio" name="color" value="random"${color === 'random' ? ' checked' : ''}><span>Random</span></label>`;
    const typeOpts = (v) => [['human', 'Person'], ['easy', 'Computer, Easy'], ['medium', 'Computer, Medium'], ['hard', 'Computer, Hard']]
      .map(([k, t]) => `<option value="${k}"${k === v ? ' selected' : ''}>${t}</option>`).join('');
    $('seat-rows').innerHTML = names.map((nm, i) => `
      <div class="seat-row"><i class="chip chip-p${i}"></i>
        <input name="seatName${i}" maxlength="24" placeholder="${esc(nm)}" value="${esc(d.names[i] || '')}" aria-label="Name for ${esc(nm)}">
        <select name="seatType${i}" aria-label="Who plays ${esc(nm)}">${typeOpts(d.types[i] || 'human')}</select></div>`).join('');
    $('corr-names').innerHTML = `<p class="small">Names for each player.${teams ? ' Teammates sit opposite each other.' : ''}</p>` + names.map((nm, i) => `
      <div class="seat-row"><i class="chip chip-p${i}"></i><input name="corrName${i}" maxlength="24" placeholder="${esc(nm)}" value="${esc(d.corrNames[i] || '')}" aria-label="Name for ${esc(nm)}"></div>`).join('');
    $('handicap-rows').innerHTML = `<p class="small">Handicap: extra edges in a player's first turn.</p><div class="row2">${names.map((nm, i) => `
      <label class="field"><span><i class="chip chip-p${i}"></i>${esc(nm)}</span><select name="hc${i}">${[0, 1, 2, 3, 4].map((k) => `<option value="${k}"${String(k) === String(d.handicap[i] || 0) ? ' selected' : ''}>${k ? `${k} extra` : 'None'}</option>`).join('')}</select></label>`).join('')}</div>`;
  }

  syncNewForm(e) {
    const f = $('form-new');
    const mode = F(f, 'mode').value;
    for (const el of f.querySelectorAll('[data-show]')) el.hidden = !el.dataset.show.split(' ').includes(mode);
    const n = this.seatCount();
    const playersChanged = e && e.target && e.target.name === 'players';
    if (this._seatCount !== n || !e || playersChanged) {
      if (e) this.captureSeats();
      this.buildSeatControls(n);
      this._seatCount = n;
    }
    $('btn-start').textContent = mode === 'online' ? 'Make an invite link' : mode === 'corr' ? 'Start' : 'Start';
  }

  rulesFromForm() {
    const f = $('form-new');
    const v = (name) => F(f, name).value;
    const pv = v('players');
    const quick = v('gameLength') === 'quick';
    return makeRules({
      size: v('size') ? Number(v('size')) : quick ? 13 : 19,
      perPlayer: v('perPlayer') ? Number(v('perPlayer')) : quick ? 30 : 60,
      radius: Number(v('radius')) || 3,
      players: pv === 'teams' ? 4 : Number(pv),
      teams: pv === 'teams',
      protect: !F(f, 'noProtect').checked,
      border: F(f, 'border').checked,
      timeout: v('timeout'),
      handicap: [0, 1, 2, 3].map((i) => (F(f, `hc${i}`) ? Number(F(f, `hc${i}`).value) : 0)),
    });
  }

  startFromForm() {
    const f = $('form-new');
    this.captureSeats();
    const v = (name) => F(f, name).value;
    const setup = {
      mode: v('mode'), players: v('players'), gameLength: v('gameLength'), level: v('level'), aiStyle: v('aiStyle'),
      clock: v('clock'), days: v('days'), size: v('size'), perPlayer: v('perPlayer'), radius: v('radius'), timeout: v('timeout'),
      noProtect: F(f, 'noProtect').checked, border: F(f, 'border').checked, timeScale: v('timeScale'),
      color: this.seatDraft.color, seats: this.seatDraft,
    };
    store.save('lastSetup', setup);
    this.startQuick(setup, this.rulesFromForm());
  }

  // setup: { mode, level, aiStyle, color, clock, days, timeScale, seats }
  startQuick(setup, rules = makeRules({})) {
    const n = rules.players;
    const clock = parseClock(setup.clock);
    const pick = () => {
      const c = setup.color;
      if (c === 'random' || c === undefined || c === null || c === '') return Math.floor(Math.random() * n);
      return Math.min(n - 1, Math.max(0, Number(c) || 0));
    };
    const names = seatNames(this.settings, n);
    const s = setup.seats || {};
    if (setup.mode === 'online') { this.hostOnline(rules, clock, pick()); return; }
    this.leaveOnline();
    if (setup.mode === 'corr') {
      const cn = s.corrNames || [];
      this.corr.start({ rules, names: names.map((d, i) => (cn[i] || '').trim().slice(0, 24) || d), mySeat: pick(), days: Number(setup.days) || 0 });
      this.goPlay();
      return;
    }
    let seats;
    if (setup.mode === 'local') {
      seats = names.map((d, i) => {
        const type = (s.types || [])[i] || 'human';
        const nm = ((s.names || [])[i] || '').trim().slice(0, 24);
        return type === 'human' ? { type: 'human', name: nm || d } : { type: 'ai', level: type, style: 'balanced', name: nm || `${d} (${LEVEL_NAMES[type]})` };
      });
    } else {
      const me = pick();
      const level = setup.level || 'medium';
      const style = setup.aiStyle || 'balanced';
      const label = `${LEVEL_NAMES[level]}${style !== 'balanced' ? `, ${STYLE_NAMES[style]}` : ''}`;
      seats = names.map((d, i) => (i === me ? { type: 'human', name: 'You' } : { type: 'ai', level, style, name: n === 2 ? `Computer (${label})` : `${d} (${label})` }));
    }
    this.play.start({ mode: setup.mode === 'local' ? 'local' : 'ai', rules, seats, clock, timeScale: Number(setup.timeScale) || 1 });
    this.goPlay();
  }

  // ----- settings -----

  bindSettings() {
    const f = $('form-settings');
    f.addEventListener('change', (e) => { if (e.target.name) this.readSettings(); });
    f.addEventListener('input', (e) => { if (e.target.type === 'range') this.readSettings(); });
    $('btn-friendly').onclick = () => { this.settings.colors = FRIENDLY_SEATS.slice(); this.renderColorSeats(); this.readSettings(); };
    $('btn-default-colors').onclick = () => { this.settings.colors = DEFAULT_SEATS.slice(); this.renderColorSeats(); this.readSettings(); };
    $('btn-report-copy').onclick = () => this.copy(problemReport({ Screen: this.view || 'home' }), 'Report copied. Paste it into the issue.');
    $('btn-reset-stats').onclick = async () => {
      if (await this.confirm('Clear your record?', 'Your games, ratings and achievements in this profile will be cleared.', 'Clear')) {
        this.profile.resetCurrent();
        store.clearRecord();
        this.renderRecord();
        this.toast('Record cleared');
        this.openDialog('dlg-settings');
      }
    };
  }

  renderColorSeats() {
    const cols = seatColors(this.settings);
    $('color-seats').innerHTML = cols.map((c, i) => `
      <label class="field"><span><i class="chip chip-p${i}"></i>Player ${i + 1}${i === 0 ? ', moves first' : ''}</span>
        <select name="color${i}">${Object.entries(PALETTE).map(([k, v]) => `<option value="${k}"${k === c ? ' selected' : ''}>${v.name}</option>`).join('')}</select></label>`).join('');
  }

  openSettings() {
    const f = $('form-settings');
    const s = this.settings;
    F(f, 'theme').value = s.theme;
    this.renderColorSeats();
    F(f, 'lineScale').value = String(s.lineScale || 1);
    F(f, 'nodeScale').value = String(s.nodeScale || 1);
    for (const k of ['shapes', 'sound', 'coords', 'labels', 'confirmTaps', 'animate']) F(f, k).checked = !!s[k];
    F(f, 'turnUrls').value = s.turnUrls || '';
    F(f, 'turnUser').value = s.turnUser || '';
    F(f, 'turnPass').value = s.turnPass || '';
    this.openDialog('dlg-settings');
  }

  readSettings() {
    const f = $('form-settings');
    const colors = [0, 1, 2, 3].map((i) => (F(f, `color${i}`) ? F(f, `color${i}`).value : seatColors(this.settings)[i]));
    const s = {
      ...this.settings,
      theme: F(f, 'theme').value || 'auto',
      colors,
      lineScale: Number(F(f, 'lineScale').value) || 1,
      nodeScale: Number(F(f, 'nodeScale').value) || 1,
      turnUrls: F(f, 'turnUrls').value.trim(),
      turnUser: F(f, 'turnUser').value.trim(),
      turnPass: F(f, 'turnPass').value,
    };
    for (const k of ['shapes', 'sound', 'coords', 'labels', 'confirmTaps', 'animate']) s[k] = F(f, k).checked;
    this.settings = s;
    store.setSettings(s);
    this.applySettings();
  }

  applySettings() {
    const s = this.settings;
    const root = document.documentElement;
    if (s.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = s.theme;
    applyColors(s);
    setSound(s.sound);
    this.online.turn = s.turnUrls ? { urls: s.turnUrls.split(/[\s,]+/).filter(Boolean), username: s.turnUser, credential: s.turnPass } : null;
    if (this.play) this.play.applySettings(s);
    if (this.analysis) this.analysis.applySettings(s);
    if (this.puzzles && this.puzzles.board) this.puzzles.ensureBoard();
  }

  // ----- you -----

  bindYou() {
    const refresh = () => { renderYou(this, $('view-you')); this.renderRecord(); };
    $('you-profiles').onchange = (e) => { this.profile.switchTo(e.target.value); refresh(); };
    $('you-name').onchange = (e) => { this.profile.rename(e.target.value.trim() || 'Player'); refresh(); };
    $('you-newprofile').onclick = async () => {
      const name = await this.prompt('New profile', 'A name for the new profile. Each profile keeps its own games, ratings and achievements.', '', false);
      if (name === null) return;
      this.profile.create(name.trim() || 'Player');
      refresh();
    };
    $('you-delprofile').onclick = async () => {
      if (this.profile.list().length < 2) { this.toast("That's your only profile. Make another one first."); return; }
      const name = this.profile.current.name;
      if (!await this.confirm(`Delete ${name}?`, 'Its games, ratings and achievements are deleted from this browser.', 'Delete')) return;
      this.profile.remove(this.profile.data.active);
      refresh();
    };
    $('you-export').onclick = () => {
      download(new Blob([this.profile.exportData()], { type: 'application/json' }), `enclosure-profiles-${new Date().toISOString().slice(0, 10)}.json`);
    };
    $('you-import').onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        this.profile.importData(await file.text());
        this.toast('Profiles loaded.');
        refresh();
      } catch (err) {
        this.toast(err && err.message && !err.message.startsWith('Unexpected') ? err.message : "That file couldn't be read.");
      }
      e.target.value = '';
    };
  }

  // ----- tournament -----

  bindTournament() {
    $('tour-new').onclick = () => {
      $('tour-error').textContent = '';
      $('dlg-tour').returnValue = '';
      this.openDialog('dlg-tour');
    };
    $('dlg-tour').addEventListener('close', () => {
      if ($('dlg-tour').returnValue === 'create') this.createTournament();
    });
    $('tour-list').onchange = (e) => {
      this.tournament.data.current = e.target.value;
      this.tournament.save();
      this.tournament.render($('view-tournament'));
    };
  }

  createTournament() {
    const f = $('form-tour');
    const lines = F(f, 'tplayers').value.split('\n').map((x) => x.trim()).filter(Boolean);
    const players = [];
    const used = new Set();
    for (const line of lines) {
      const m = line.match(/^computer\s*(easy|medium|hard)?$/i);
      const lvl = m ? (m[1] || 'medium').toLowerCase() : null;
      const p = m
        ? { type: 'ai', level: lvl, name: `Computer (${LEVEL_NAMES[lvl]})` }
        : { type: 'human', name: line.slice(0, 24) };
      let name = p.name;
      for (let k = 2; used.has(name.toLowerCase()); k++) name = `${p.name} ${k}`;
      used.add(name.toLowerCase());
      players.push({ ...p, name });
    }
    if (players.length < 2 || players.length > 64) {
      $('tour-error').textContent = players.length < 2 ? 'Add at least two players, one per line.' : 'That is more than 64 players.';
      $('dlg-tour').returnValue = '';
      this.openDialog('dlg-tour');
      return;
    }
    const quick = F(f, 'gameLength').value === 'quick';
    this.tournament.create({
      name: F(f, 'tname').value.trim() || 'Tournament', players,
      rules: quick ? { size: 13, perPlayer: 30 } : {}, clock: parseClock(F(f, 'clock').value),
    });
    this.tournament.render($('view-tournament'));
    this.toast('Tournament ready. Round 1 is drawn.');
  }

  // ----- online -----

  myName() {
    const typed = $('online-name').value.trim().slice(0, 18);
    if (typed) return typed;
    const saved = store.load('name', '');
    if (saved) return saved;
    const p = this.profile.current.name;
    return p && p !== 'You' ? p.slice(0, 18) : '';
  }

  showOnlineDialog(kind) {
    const host = kind === 'host';
    $('online-title').textContent = host ? 'Play friends online' : kind === 'watch' ? 'Watch a game' : 'Join a game';
    $('online-host').hidden = !host;
    $('online-join').hidden = host;
    $('btn-online-join').hidden = host || kind === 'watch';
    $('btn-online-join').textContent = 'Join game';
    $('online-name').value = this.myName();
    $('online-name-wrap').hidden = kind === 'watch';
    $('online-status').textContent = '';
    $('online-lobby').hidden = true;
    $('btn-online-fill').hidden = true;
    this.joinFull = false;
    this.openDialog('dlg-online');
  }

  // Stop any online game, for example when starting a different kind.
  leaveOnline() {
    if (!this.online.role) return;
    this.online.close(true);
    this.online.role = null;
    session('enclosure.guest', null);
    this.pendingOnline = false;
  }

  async hostOnline(rules, clock, hostSeat) {
    this.leaveOnline();
    const name = this.myName() || 'Host';
    const seats = Array.from({ length: rules.players }, (_, i) => (i === hostSeat ? { kind: 'host', name } : { kind: 'guest' }));
    this.showOnlineDialog('host');
    $('online-link').value = '';
    $('online-status').textContent = 'Making a link…';
    try {
      await this.online.host({ name, rules, clock, seats });
      $('online-link').value = this.online.link();
      $('btn-share-invite').hidden = !navigator.share;
      $('online-status').textContent = rules.players === 2 ? 'Waiting for your friend to open the link…' : 'Waiting for players to open the link…';
      this.renderLobby(this.online.lobbyInfo(), this.online.mySeat);
    } catch (e) {
      $('online-status').textContent = e.message;
    }
  }

  renderLobby(info, you) {
    const el = $('online-lobby');
    if (!info) { el.hidden = true; return; }
    el.hidden = false;
    const names = seatNames(this.settings, info.length);
    el.innerHTML = info.map((s) => `<li><i class="chip chip-p${s.seat}"></i><span>${esc(names[s.seat])}</span><b>${s.name ? esc(s.name) : '<span class="small">Waiting…</span>'}${s.seat === you ? ' (you)' : ''}</b></li>`).join('');
    const o = this.online;
    $('btn-online-fill').hidden = !(o.role === 'host' && !o.started && o.openSeats() > 0);
  }

  // The seats of the online game, as the play screen wants them.
  onlineSeats() {
    const o = this.online;
    return o.plan.map((s) => (s.kind === 'ai'
      ? { type: 'ai', level: s.level || 'medium', style: 'balanced', name: s.name || 'Computer' }
      : { type: 'human', name: s.kind === 'host' ? o.me : (s.name || 'Friend') }));
  }

  onlineState() {
    const p = this.play, o = this.online;
    return {
      rules: encodeRules(p.config.rules), moves: encodeHistory(p.game.history, p.config.rules),
      names: p.config.names.slice(0, p.game.NP), kinds: o.plan.map((s) => (s.kind === 'ai' ? 'ai' : 'human')),
      clock: p.config.clock || null, clocks: p.clock ? p.clock.ms.slice() : null,
    };
  }

  hostStartGame() {
    const o = this.online;
    o.started = true;
    o.saveHost();
    const st = o.setup;
    this.play.start({ mode: 'online', rules: makeRules(st.rules), seats: this.onlineSeats(), clock: st.clock || null, myColor: o.mySeat, code: o.code });
    o.sendState(this.onlineState());
    $('dlg-online').close();
    $('dlg-over').close();
    this.goPlay();
    const names = seatNames(this.settings, o.plan.length);
    this.toast(`Game on. You are ${names[o.mySeat]}${o.mySeat === 0 ? ' and go first' : ''}.`);
  }

  onlineRematch() {
    const o = this.online;
    if (o.role === 'host') {
      // Everyone moves one seat along, so the first move rotates.
      const n = o.plan.length;
      const plan = new Array(n);
      o.plan.forEach((s, i) => { plan[(i + 1) % n] = s; });
      o.plan = plan;
      o.mySeat = plan.findIndex((s) => s.kind === 'host');
      for (const v of o.conns.values()) if (v.seat >= 0) v.seat = (v.seat + 1) % n;
      o.setup = { ...o.setup, seats: plan };
      this.hostStartGame();
    } else if (o.role === 'guest') {
      o.send({ t: 'rematch' });
      this.toast('Asked the host for a rematch.');
    }
  }

  openJoin(code) {
    const o = this.online;
    if (o.code === code && o.role && o.role !== 'host') {
      if (o.started) this.goPlay(); else this.openDialog('dlg-online');
      return;
    }
    // Back after a reload: the seat is kept for this tab, so go straight in.
    if (session(`enclosure.token.${code}`)) {
      this.pendingOnline = true;
      this.joinGame(code, false);
      history.replaceState(null, '', '#play');
      this.route();
      return;
    }
    this.show('home');
    this.showOnlineDialog('join');
    this.joinCode = code;
  }

  watch(code) {
    this.show('home');
    this.showOnlineDialog('watch');
    $('online-join-text').textContent = 'Connecting so you can watch. The board shows up as soon as the game is running.';
    this.joinGame(code, true);
  }

  async joinGame(code, watch) {
    const name = watch ? (this.myName() || 'Watcher') : (this.myName() || 'Guest');
    if (!watch) store.save('name', name);
    session('enclosure.guest', { code, watch });
    this.joinCode = code;
    $('online-status').textContent = 'Connecting…';
    try {
      await this.online.join(code, name, watch);
    } catch (e) {
      $('online-status').textContent = e.message;
    }
  }

  // After a reload, pick an online game back up.
  resumeOnline() {
    const h = Online.savedHost();
    if (h && h.code && h.setup) { this.resumeHost(h); return; }
    const g = session('enclosure.guest');
    if (g && g.code) {
      this.pendingOnline = true;
      this.joinGame(g.code, !!g.watch);
    }
  }

  async resumeHost(h) {
    const o = this.online;
    this.pendingOnline = true;
    try {
      await o.host({ ...h.setup, code: h.code }, h.started ? true : null);
    } catch (e) {
      this.pendingOnline = false;
      this.toast(e.message);
      return;
    }
    if (h.started) {
      const rules = makeRules(h.setup.rules);
      let moves = [];
      try { moves = decodeHistory(h.moves || '', rules); } catch { moves = []; }
      this.play.start({ mode: 'online', rules, seats: this.onlineSeats(), clock: h.setup.clock || null, myColor: o.mySeat, code: o.code }, moves, h.clocks || null);
      if (!location.hash.startsWith('#play')) this.goPlay();
      this.toast('Back in your online game. The others reconnect on their own.');
    } else {
      this.showOnlineDialog('host');
      $('online-link').value = o.link();
      $('btn-share-invite').hidden = !navigator.share;
      $('online-status').textContent = 'Waiting for players to open the link…';
      this.renderLobby(o.lobbyInfo(), o.mySeat);
    }
  }

  onGameChange(view) {
    const o = this.online;
    if (view.config.mode === 'online' && o.role === 'host' && o.started) {
      o.saveHost({ moves: encodeHistory(view.game.history, view.config.rules), clocks: view.clock ? view.clock.ms.slice() : null });
    }
  }

  sendEmote(e) {
    if (!EMOTES[e]) return;
    const now = Date.now();
    if (now - (this._emoteAt || 0) < 1500) return;
    this._emoteAt = now;
    this.online.sendEmote(e);
    this.showEmote(this.online.mySeat, e);
  }

  showEmote(seat, e, name) {
    const card = seat >= 0 ? document.querySelector(`.player-card[data-pl="${seat}"]`) : null;
    if (!card || !card.offsetParent) { this.toast(`${name || 'Someone'}: ${EMOTES[e]}`); return; }
    const el = document.createElement('span');
    el.className = 'emote-pop';
    el.textContent = EMOTES[e];
    card.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  bindOnline() {
    const o = this.online;
    $('btn-copy-invite').onclick = () => this.copy($('online-link').value, 'Invite link copied');
    $('btn-copy-watch').onclick = () => this.copy(o.link(true), 'Watch link copied');
    $('btn-share-invite').onclick = () => navigator.share({ title: 'Enclosure', text: "Let's play Enclosure", url: $('online-link').value }).catch(() => {});
    $('online-name').onchange = () => {
      const n = $('online-name').value.trim().slice(0, 18);
      store.save('name', n);
      if (o.role === 'host' && n) {
        o.me = n;
        const s = o.plan[o.mySeat];
        if (s) s.name = n;
        o.setup.name = n;
        o.saveHost();
        o.broadcastLobby();
      }
    };
    $('btn-online-cancel').onclick = () => {
      $('dlg-online').close();
      if (!o.started) this.leaveOnline();
    };
    $('btn-online-join').onclick = () => {
      $('btn-online-join').hidden = true;
      this.joinGame(this.joinCode, this.joinFull);
    };
    $('btn-online-fill').onclick = () => {
      o.plan.forEach((s) => {
        if (s.kind === 'guest' && !s.token) Object.assign(s, { kind: 'ai', level: 'medium', name: 'Computer (Medium)' });
      });
      o.setup = { ...o.setup, seats: o.plan };
      this.hostStartGame();
    };

    o.on('status', (msg) => {
      $('online-status').textContent = msg;
      if (this.play.config && this.play.config.mode === 'online' && this.isView('play')) this.play.flash(msg);
    });
    o.on('full', () => {
      this.joinFull = true;
      $('btn-online-join').hidden = false;
      $('btn-online-join').textContent = 'Watch instead';
    });
    o.on('lobby', (info, you) => {
      if (o.role === 'host') {
        this.renderLobby(info, o.mySeat);
        if (!o.started && o.openSeats() === 0) this.hostStartGame();
        return;
      }
      this.renderLobby(info, you);
      const waiting = info.filter((s) => !s.name).length;
      $('online-join-text').textContent = you >= 0
        ? `You're in. Waiting for ${waiting === 1 ? 'one more player' : `${waiting} more players`}.`
        : 'Watching. The board shows up when the game starts.';
      $('online-name-wrap').hidden = true;
    });
    o.on('joined', (seat, name) => {
      if (o.started) this.toast(`${name} joined.`);
    });
    o.on('back', (seat, name) => { if (o.started) this.toast(`${name} is back.`); });
    o.on('left', (seat, name) => {
      if (o.started) this.toast(`${name} left. If they open the link again, they get their seat back.`);
    });
    o.on('needState', (id) => {
      const p = this.play;
      if (p.config && p.config.mode === 'online' && p.game) o.sendState(this.onlineState(), id);
    });
    o.on('start', (msg) => {
      const p = this.play;
      let rules, moves;
      try {
        rules = decodeRules(msg.rules || '');
        moves = decodeHistory(msg.moves || '', rules);
      } catch { return; }
      this.pendingOnline = false;
      const same = p.config && p.config.mode === 'online' && p.config.code === o.code && p.config.myColor === msg.you
        && encodeHistory(p.game.history, p.config.rules) === msg.moves;
      if (same) {
        if (p.clock && Array.isArray(msg.clocks)) p.clock.ms = msg.clocks.slice();
        p.render(null);
        return;
      }
      const names = Array.isArray(msg.names) ? msg.names.map((x) => String(x).slice(0, 24)) : [];
      const seats = names.map((name, i) => (msg.kinds && msg.kinds[i] === 'ai' ? { type: 'ai', level: 'medium', name } : { type: 'human', name }));
      p.start({ mode: 'online', rules, seats, clock: msg.clock || null, myColor: msg.you, code: o.code }, moves, Array.isArray(msg.clocks) ? msg.clocks : null);
      $('dlg-online').close();
      $('dlg-over').close();
      const colors = seatNames(this.settings, rules.players);
      if (msg.you < 0) this.toast('Watching the game.');
      else if (moves.length) this.toast('Back in the game.');
      else this.toast(`Game on. You are ${colors[msg.you]}${msg.you === 0 ? ' and go first' : ''}.`);
      if (location.hash !== '#play') history.replaceState(null, '', '#play');
      this.show('play');
    });
    o.on('move', (m, n, clock, seat, id) => {
      const p = this.play;
      if (o.role !== 'host') { p.remoteMove(m, n, clock); return; }
      const g = p.game;
      if (!g || !p.config || p.config.mode !== 'online' || g.over || seat !== g.player || n !== g.history.length) {
        if (p.game) o.sendState(this.onlineState(), id);
        return;
      }
      const before = g.history.length;
      p.remoteMove(m, n, clock);
      if (p.game.history.length > before) o.broadcast({ t: 'move', n, m, clock }, id);
      else o.sendState(this.onlineState(), id);
    });
    o.on('resign', (pl) => this.play.remoteResign(pl));
    o.on('emote', (seat, e, name) => this.showEmote(seat, e, name));
    o.on('rematch', (seat, name) => {
      this.toast(`${name || 'A player'} wants a rematch. Press Rematch to start one.`);
    });
    o.on('closed', () => {
      this.toast('Lost the connection. Trying to get back in…');
      if (this.play.config && this.play.config.mode === 'online') this.play.render(null);
    });
  }

  // ----- install -----

  pwa() {
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installPrompt = e;
      $('btn-install').hidden = false;
    });
    $('btn-install').onclick = async () => {
      if (!this.installPrompt) return;
      this.installPrompt.prompt();
      try { await this.installPrompt.userChoice; } catch { /* ignore */ }
      this.installPrompt = null;
      $('btn-install').hidden = true;
    };
  }
}

window.app = new App();
