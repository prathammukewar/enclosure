// Page shell: routing, dialogs, settings, and the glue between screens.
import { Game, decodeHistory } from './engine.js';
import { PlayView, LEVEL_NAMES } from './play.js';
import { LearnView } from './learn.js';
import { PuzzleView, dailyIndex } from './puzzles.js';
import { PUZZLES } from './puzzledata.js';
import { Online } from './online.js';
import { Demo } from './demo.js';
import { drawAllDiagrams } from './diagrams.js';
import { setSound } from './sound.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);

function parseClock(v) {
  if (!v || v === 'none') return null;
  const [base, inc] = v.split('+').map(Number);
  return { base: base * 1000, inc: inc * 1000 };
}

class App {
  constructor() {
    this.settings = store.getSettings();
    this.applySettings();
    this.online = new Online();
    this.play = new PlayView(this);
    this.learn = new LearnView(this);
    this.puzzles = new PuzzleView(this);
    this.demo = new Demo($('demo-board'), $('demo-caption'));
    this.view = null;
    this.bind();
    this.bindOnline();
    drawAllDiagrams();
    this.renderRecord();
    this.renderDaily();
    window.addEventListener('hashchange', () => this.route());
    document.addEventListener('visibilitychange', () => this.updateDemo());
    this.route();
    this.pwa();
  }

  // ----- routing -----

  route() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h.startsWith('g=')) {
      try {
        const moves = decodeHistory(h.slice(2));
        Game.fromHistory(moves);
        this.play.replay(moves);
        this.show('play');
      } catch {
        this.toast("That game link doesn't work.");
        this.show('home');
      }
      return;
    }
    if (h.startsWith('join=')) {
      this.show('home');
      this.openJoin(h.slice(5));
      return;
    }
    const [name, arg] = h.split('/');
    if (name === 'play') {
      this.show('play');
      if (!this.play.game) {
        if (!this.play.resumeSaved()) {
          this.play.start({ mode: 'idle', humans: [false, false], names: ['Blue', 'Red'], clock: null });
          this.openNewGame('ai');
        }
      }
      return;
    }
    if (name === 'learn') { this.show('learn'); this.learn.route(arg); return; }
    if (name === 'puzzles') { this.show('puzzles'); this.puzzles.route(arg); return; }
    if (name === 'rules') { this.show('rules'); return; }
    this.show('home');
  }

  show(name) {
    if (this.view !== name) window.scrollTo(0, 0);
    this.view = name;
    for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${name}`);
    for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === name);
    const v = $(`view-${name}`);
    if (v && v.dataset.title) document.title = v.dataset.title;
    if (name === 'home') this.renderResume();
    this.updateDemo();
  }

  isView(name) {
    return this.view === name;
  }

  updateDemo() {
    if (this.view === 'home') this.demo.show();
    if (this.view === 'home' && !document.hidden) this.demo.start();
    else this.demo.stop();
  }

  // ----- home -----

  renderResume() {
    const s = this.play.saved();
    const card = $('resume-card');
    if (!s) { card.hidden = true; return; }
    card.hidden = false;
    const c = s.config;
    const who = c.mode === 'ai' ? `against the computer (${LEVEL_NAMES[c.level] || c.level})` : 'on one screen';
    $('resume-text').textContent = `${c.mode === 'ai' ? 'You are playing' : 'A game'} ${who}, edge ${s.edges} of 120.`;
  }

  renderDaily() {
    const i = dailyIndex();
    const p = PUZZLES[i];
    const solved = this.puzzles.solved.has(p.code);
    $('daily-text').textContent = solved ? `Solved. Come back tomorrow for a new one, or try the others.` : `Find a turn that swings ${p.best >= 10 ? Math.round(p.best) : p.best.toFixed(1).replace(/\.0$/, '')} or more.`;
    $('btn-daily').href = `#puzzles/${i + 1}`;
    $('btn-daily').textContent = solved ? 'More puzzles' : 'Solve it';
  }

  renderRecord() {
    const rec = store.getRecord();
    const levels = ['easy', 'medium', 'hard'];
    const any = levels.some((l) => rec[l]);
    $('record-card').hidden = !any;
    if (!any) return;
    $('record-grid').innerHTML = levels.map((l) => {
      const r = rec[l] || { w: 0, l: 0, d: 0, best: 0 };
      return `<div class="record-cell"><span>${LEVEL_NAMES[l]}</span><b>${r.w} won, ${r.l} lost</b><span>${r.d ? `${r.d} drawn · ` : ''}best score ${r.best || 0}</span></div>`;
    }).join('');
  }

  // ----- buttons and dialogs -----

  bind() {
    for (const b of document.querySelectorAll('[data-start]')) {
      b.onclick = () => this.openNewGame(b.dataset.start);
    }
    $('btn-resume').onclick = () => {
      if (this.play.resumeSaved()) location.hash = '#play';
    };
    $('btn-settings').onclick = () => this.openSettings();
    $('btn-over-close').onclick = () => $('dlg-over').close();
    $('btn-over-review').onclick = () => { $('dlg-over').close(); this.play.enterReview(0); };
    $('btn-over-again').onclick = () => { $('dlg-over').close(); this.play.again(); };

    const form = $('form-new');
    form.addEventListener('change', () => this.syncNewForm());
    $('dlg-new').addEventListener('close', () => {
      if ($('dlg-new').returnValue === 'start') this.startFromForm();
    });

    const sform = $('form-settings');
    sform.addEventListener('change', () => this.readSettings());
    $('btn-reset-stats').onclick = async () => {
      if (await this.confirm('Clear your record?', 'Your wins and losses against the computer will be reset.', 'Clear')) {
        store.clearRecord();
        this.renderRecord();
        this.toast('Record cleared');
      }
    };
  }

  openDialog(id) {
    const d = $(id);
    if (d.open) return;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }

  openNewGame(mode = 'ai') {
    const form = $('form-new');
    const last = store.load('lastSetup', {});
    form.mode.value = mode || last.mode || 'ai';
    if (last.level) form.level.value = last.level;
    if (last.color !== undefined) form.color.value = String(last.color);
    if (last.clock) form.clock.value = last.clock;
    if (last.nameBlue) form.nameBlue.value = last.nameBlue;
    if (last.nameRed) form.nameRed.value = last.nameRed;
    this.syncNewForm();
    $('dlg-new').returnValue = '';
    this.openDialog('dlg-new');
  }

  syncNewForm() {
    const form = $('form-new');
    const mode = form.mode.value;
    for (const el of form.querySelectorAll('[data-show]')) el.hidden = !el.dataset.show.split(' ').includes(mode);
    $('btn-start').textContent = mode === 'online' ? 'Create invite link' : 'Start';
  }

  startFromForm() {
    const form = $('form-new');
    const setup = {
      mode: form.mode.value, level: form.level.value, color: form.color.value, clock: form.clock.value,
      nameBlue: form.nameBlue.value.trim(), nameRed: form.nameRed.value.trim(),
    };
    store.save('lastSetup', setup);
    this.startQuick(setup);
  }

  // setup: { mode, level, color, clock, nameBlue, nameRed }
  startQuick(setup) {
    const clock = parseClock(setup.clock);
    if (setup.mode === 'online') { this.hostOnline(setup.color, clock); return; }
    if (setup.mode === 'local') {
      this.play.start({ mode: 'local', humans: [true, true], names: [setup.nameBlue || 'Blue', setup.nameRed || 'Red'], clock });
    } else {
      const c = setup.color === 'random' || setup.color === undefined ? (Math.random() < 0.5 ? 0 : 1) : Number(setup.color);
      const level = setup.level || 'medium';
      const names = c === 0 ? ['You', `Computer (${LEVEL_NAMES[level]})`] : [`Computer (${LEVEL_NAMES[level]})`, 'You'];
      this.play.start({ mode: 'ai', humans: [c === 0, c === 1], names, level, clock });
    }
    if (location.hash !== '#play') location.hash = '#play'; else this.show('play');
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

  toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(this._toast);
    this._toast = setTimeout(() => { t.hidden = true; }, 3200);
  }

  async copy(text, msg = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(msg);
    } catch {
      this.toast('Select the text and copy it yourself.');
    }
  }

  // ----- settings -----

  openSettings() {
    const f = $('form-settings');
    const s = this.settings;
    f.theme.value = s.theme;
    f.palette.value = s.palette;
    for (const k of ['sound', 'coords', 'labels', 'confirmTaps', 'animate']) f[k].checked = !!s[k];
    this.openDialog('dlg-settings');
  }

  readSettings() {
    const f = $('form-settings');
    const s = {
      theme: f.theme.value, palette: f.palette.value,
      sound: f.sound.checked, coords: f.coords.checked, labels: f.labels.checked,
      confirmTaps: f.confirmTaps.checked, animate: f.animate.checked,
    };
    this.settings = s;
    store.setSettings(s);
    this.applySettings();
    this.play.applySettings(s);
    if (this.puzzles.board) this.puzzles.board.setOptions({ coords: s.coords, labels: s.labels, animate: s.animate, confirmTaps: s.confirmTaps });
  }

  applySettings() {
    const s = this.settings;
    const root = document.documentElement;
    if (s.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = s.theme;
    if (s.palette === 'friendly') root.dataset.palette = 'friendly'; else delete root.dataset.palette;
    setSound(s.sound);
  }

  // ----- online -----

  async hostOnline(color, clock) {
    const name = store.load('name', '') || 'Player';
    $('online-title').textContent = 'Play a friend online';
    $('online-host').hidden = false;
    $('online-join').hidden = true;
    $('btn-online-join').hidden = true;
    $('online-name').value = name;
    $('online-link').value = '';
    $('online-status').textContent = 'Making a link…';
    this.hostSetup = { color, clock };
    this.openDialog('dlg-online');
    try {
      await this.online.host({ name, color, clock });
      $('online-link').value = this.online.link();
      $('online-status').textContent = 'Waiting for your friend to open the link…';
      $('btn-share-invite').hidden = !navigator.share;
    } catch (e) {
      $('online-status').textContent = e.message;
    }
  }

  openJoin(code) {
    if (this.online.code === code && this.online.connected) return;
    $('online-title').textContent = 'Join a game';
    $('online-host').hidden = true;
    $('online-join').hidden = false;
    $('btn-online-join').hidden = false;
    $('online-name').value = store.load('name', '');
    $('online-status').textContent = '';
    this.joinCode = code;
    this.openDialog('dlg-online');
  }

  bindOnline() {
    const o = this.online;
    $('btn-copy-invite').onclick = () => this.copy($('online-link').value, 'Invite link copied');
    $('btn-share-invite').onclick = () => navigator.share({ title: 'Enclosure', text: "Let's play Enclosure", url: $('online-link').value }).catch(() => {});
    $('online-name').onchange = () => {
      const n = $('online-name').value.trim().slice(0, 18);
      store.save('name', n);
      o.me = n || o.me;
    };
    $('btn-online-cancel').onclick = () => {
      $('dlg-online').close();
      if (!o.connected) o.close();
    };
    $('btn-online-join').onclick = async () => {
      const name = $('online-name').value.trim().slice(0, 18) || 'Guest';
      store.save('name', name);
      $('online-status').textContent = 'Connecting…';
      try { await o.join(this.joinCode, name); } catch (e) { $('online-status').textContent = e.message; }
    };
    o.on('status', (msg) => { $('online-status').textContent = msg; });
    o.on('guest', (them) => {
      const p = this.play;
      const resumed = p.config && p.config.mode === 'online' && p.game && !p.game.over && p.config.code === o.code;
      if (resumed) {
        o.sendStart(p.config.myColor, p.config.clock, p.game.history, p.clock ? p.clock.ms : null);
        this.toast(`${them} is back.`);
      } else {
        const setup = this.hostSetup || { color: 0, clock: null };
        const hostColor = setup.color === 'random' ? (Math.random() < 0.5 ? 0 : 1) : Number(setup.color) || 0;
        const names = hostColor === 0 ? [o.me, them] : [them, o.me];
        p.start({ mode: 'online', humans: [true, true], names, clock: setup.clock, myColor: hostColor, code: o.code });
        o.sendStart(hostColor, setup.clock, [], null);
        this.toast(`${them} joined. ${hostColor === 0 ? 'You are Blue and go first.' : 'You are Red.'}`);
      }
      $('dlg-online').close();
      if (location.hash !== '#play') location.hash = '#play'; else this.show('play');
    });
    o.on('start', (info) => {
      this.play.start({ mode: 'online', humans: [true, true], names: info.names, clock: info.clock, myColor: info.myColor, code: o.code }, info.moves, info.clocks);
      $('dlg-online').close();
      this.toast(info.moves.length ? 'Back in the game.' : `Game on. ${info.myColor === 0 ? 'You are Blue and go first.' : 'You are Red.'}`);
      history.replaceState(null, '', '#play');
      this.show('play');
    });
    o.on('move', (m, n, clock) => this.play.remoteMove(m, n, clock));
    o.on('resign', (pl) => this.play.remoteResign(pl));
    o.on('syncRequest', () => {
      const p = this.play;
      if (p.game) o.sendSync(p.game.history, p.clock ? p.clock.ms : null);
    });
    o.on('sync', (moves, clocks) => {
      const p = this.play;
      if (!p.config || p.config.mode !== 'online') return;
      p.start({ ...p.config }, moves, clocks);
    });
    o.on('closed', () => {
      this.toast(o.role === 'host' ? 'Your friend left. If they open the link again, the game continues.' : 'Connection lost. Open the invite link again to reconnect.');
      if (this.play.config && this.play.config.mode === 'online') this.play.render(null);
    });
    const rematch = () => {
      if (o.rematch.me && o.rematch.them) {
        if (o.role === 'host') {
          const p = this.play;
          const hostColor = 1 - p.config.myColor;
          const names = hostColor === 0 ? [o.me, o.them] : [o.them, o.me];
          o.rematch = { me: false, them: false };
          p.start({ mode: 'online', humans: [true, true], names, clock: p.config.clock, myColor: hostColor, code: o.code });
          o.sendStart(hostColor, p.config.clock, [], null);
          $('dlg-over').close();
          this.toast('Rematch. Colors switched.');
        }
      }
    };
    o.on('rematch', (mine) => {
      if (!mine) this.toast(`${o.them} wants a rematch. Press Ask for a rematch to accept.`);
      rematch();
    });
    o.on('rematchOffered', (theirs) => {
      if (!theirs) this.toast('Rematch request sent.');
      rematch();
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
