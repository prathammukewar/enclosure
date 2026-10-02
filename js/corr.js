// Games by link ("correspondence"). The whole game travels in the link: after
// your turn you send it on, the next player opens it, plays, and sends a new
// one back. A copy of each game is kept in this browser so you can see
// where it stands.

import { Game, encodeHistory, decodeHistory, encodeRules, decodeRules, makeRules } from './engine.js';
import * as store from './store.js';

const DAY = 86400000;

function b64encode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64decode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export class Corr {
  constructor(app) {
    this.app = app;
  }

  games() { return store.load('corr', {}); }

  saveGame(rec) {
    const all = this.games();
    all[rec.id] = rec;
    store.save('corr', all);
  }

  remove(id) {
    const all = this.games();
    delete all[id];
    store.save('corr', all);
  }

  // Start a new game by link. setup: { rules, names, mySeat, days }
  start(setup) {
    const rules = makeRules(setup.rules || {});
    const id = Math.random().toString(36).slice(2, 10);
    const seats = setup.names.map((name) => ({ type: 'human', name }));
    const corr = { id, days: setup.days || 0, t: Date.now(), mine: [setup.mySeat], waiting: false };
    const g = new Game(null, rules);
    if (g.player !== setup.mySeat) corr.waiting = true;
    this.app.play.start({ mode: 'corr', rules, seats, clock: null, corr });
    if (corr.waiting) this.turnDone(this.app.play, true);
    this.persist(this.app.play);
  }

  link(view) {
    const c = view.config;
    const payload = {
      i: c.corr.id, r: encodeRules(c.rules), m: encodeHistory(view.game.history, c.rules),
      n: c.names.slice(0, view.game.NP), d: c.corr.days || 0, t: c.corr.t || Date.now(),
    };
    return `${location.href.split('#')[0]}#c=${b64encode(payload)}`;
  }

  persist(view) {
    const c = view.config;
    this.saveGame({
      id: c.corr.id, rules: encodeRules(c.rules), moves: encodeHistory(view.game.history, c.rules), names: c.names.slice(0, view.game.NP),
      days: c.corr.days || 0, t: c.corr.t || Date.now(), mine: c.corr.mine || [], waiting: !!c.corr.waiting,
      over: view.game.over, toMove: view.game.over ? null : view.game.player, updated: Date.now(),
    });
  }

  // Called when a turn ends (or the game ends) in a game by link.
  turnDone(view, quiet = false) {
    const c = view.config;
    if (!c.corr) return;
    const g = view.game;
    c.corr.waiting = !g.over;
    this.persist(view);
    const panel = document.getElementById('corr-panel');
    panel.hidden = false;
    document.getElementById('corr-link').value = this.link(view);
    document.getElementById('corr-text').textContent = g.over
      ? 'The game is over. Send the link so everyone sees the final position.'
      : `Send this link to ${c.names[g.player]}. When they have played, they send a new link back.`;
    document.getElementById('corr-share').hidden = !navigator.share;
    if (!quiet) this.app.toast('Turn done. Copy the link and send it.');
  }

  // Open a link: #c=<payload>
  open(payloadText) {
    let p;
    try { p = b64decode(payloadText); } catch { this.app.toast("That game link doesn't work."); return false; }
    const rules = decodeRules(p.r || '');
    let moves;
    try { moves = decodeHistory(p.m || '', rules); Game.fromHistory(moves, null, rules); } catch { this.app.toast("That game link doesn't work."); return false; }
    const local = this.games()[p.i];
    let note = '';
    if (local) {
      const localMoves = decodeHistory(local.moves, rules);
      if (localMoves.length > moves.length) {
        moves = localMoves;
        note = 'Your copy of this game is further along than this link, so that is what you see.';
      }
    }
    const names = Array.isArray(p.n) ? p.n.map((n) => String(n).slice(0, 24)) : [];
    const corr = { id: p.i, days: Number(p.d) || 0, t: Number(p.t) || Date.now(), mine: local ? local.mine : [], waiting: false };
    this.app.play.start({ mode: 'corr', rules, seats: names.map((name) => ({ type: 'human', name })), clock: null, corr }, moves);
    const view = this.app.play;
    const g = view.game;
    // Days per move: a turn that waited too long is skipped.
    if (corr.days && !g.over && Date.now() - corr.t > corr.days * DAY) {
      const pl = g.player;
      g.timeout();
      corr.t = Date.now();
      note = `${names[pl] || 'The player to move'} ran out of time, so their turn was skipped.`;
      view.after(null);
    }
    if (!g.over && !corr.mine.includes(g.player)) corr.mine.push(g.player);
    document.getElementById('corr-panel').hidden = true;
    this.persist(view);
    if (note) this.app.toast(note);
    return true;
  }

  resume(id) {
    const rec = this.games()[id];
    if (!rec) return;
    const rules = decodeRules(rec.rules);
    const corr = { id: rec.id, days: rec.days, t: rec.t, mine: rec.mine, waiting: rec.waiting };
    this.app.play.start({ mode: 'corr', rules, seats: rec.names.map((name) => ({ type: 'human', name })), clock: null, corr }, decodeHistory(rec.moves, rules));
    if (rec.waiting || rec.over) this.turnDone(this.app.play, true);
  }

  // Text for the time left on the current move, or ''.
  timeLeft(view) {
    const c = view.config;
    if (!c.corr || !c.corr.days || view.game.over) return '';
    const left = c.corr.t + c.corr.days * DAY - Date.now();
    if (left <= 0) return 'out of time';
    const d = Math.floor(left / DAY), h = Math.floor((left % DAY) / 3600000);
    return d ? `${d} day${d === 1 ? '' : 's'} ${h} h left` : `${h} h left`;
  }

  // Summary list for the home page.
  summary() {
    return Object.values(this.games()).sort((a, b) => b.updated - a.updated).slice(0, 8);
  }
}
