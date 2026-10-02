// Double-elimination tournaments, run the way the Strategy Jam described:
// each round, players with no losses play each other and players with one
// loss play each other. Two losses and you are out. A draw counts as a
// loss for both. Byes go to a random player in a group with an odd number
// of players, never twice to the same player when it can be avoided.

import * as store from './store.js';
import { makeRules } from './engine.js';
import { LEVEL_NAMES } from './play.js';

const newId = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function shuffle(a, rand = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pure pairing logic, exported for tests. players: [{ id }], losses: {id: n},
// byes: {id: true}, played: Set of 'a|b'. Returns { pairs: [[a, b]], byes: [id] }.
export function pairRound(players, losses, byesGiven, played, rand = Math.random) {
  const alive = players.filter((p) => (losses[p.id] || 0) < 2).map((p) => p.id);
  const groups = [alive.filter((id) => !(losses[id] || 0)), alive.filter((id) => losses[id] === 1)];
  const pairs = [], byes = [];
  const leftovers = [];
  for (const g of groups) {
    const ids = shuffle(g.slice(), rand);
    if (ids.length % 2 === 1) {
      // Prefer someone who has not had a bye yet.
      const fresh = ids.filter((id) => !byesGiven[id]);
      const pick = (fresh.length ? fresh : ids)[Math.floor(rand() * (fresh.length || ids.length))];
      ids.splice(ids.indexOf(pick), 1);
      leftovers.push(pick);
    }
    // Greedy pairing that avoids rematches when it can.
    while (ids.length) {
      const a = ids.shift();
      let k = ids.findIndex((b) => !played.has(key(a, b)));
      if (k < 0) k = 0;
      pairs.push([a, ids.splice(k, 1)[0]]);
    }
  }
  // When both groups have someone left over, they play each other instead
  // of both sitting out. This also makes the final happen.
  if (leftovers.length === 2) pairs.push([leftovers[0], leftovers[1]]);
  else byes.push(...leftovers);
  return { pairs, byes };
}

export function key(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

export class Tournaments {
  constructor(app) {
    this.app = app;
    this.data = store.load('tournaments', { list: [], current: null });
  }

  save() { store.save('tournaments', this.data); }

  get current() { return this.data.list.find((t) => t.id === this.data.current) || null; }

  create({ name, players, rules, clock }) {
    const t = {
      id: newId(), name: name || 'Tournament', created: Date.now(), rules: makeRules(rules || {}), clock: clock || null,
      players: players.map((p) => ({ id: newId(), name: p.name, type: p.type || 'human', level: p.level || 'medium' })),
      losses: {}, byes: {}, rounds: [], done: false, winner: null,
    };
    this.data.list.unshift(t);
    this.data.current = t.id;
    this.nextRound(t);
    this.save();
    return t;
  }

  played(t) {
    const s = new Set();
    for (const r of t.rounds) for (const p of r.pairings) s.add(key(p.a, p.b));
    return s;
  }

  alive(t) { return t.players.filter((p) => (t.losses[p.id] || 0) < 2); }

  nextRound(t) {
    const alive = this.alive(t);
    if (alive.length <= 1) {
      t.done = true;
      t.winner = alive.length ? alive[0].id : null;
      const w = t.players.find((p) => p.id === t.winner);
      if (w && w.type === 'human') this.app.profile.unlock('champion');
      return;
    }
    const { pairs, byes } = pairRound(t.players, t.losses, t.byes, this.played(t));
    for (const id of byes) t.byes[id] = true;
    t.rounds.push({
      pairings: pairs.map(([a, b]) => {
        // Colors alternate from round to round.
        const swap = t.rounds.length % 2 === 1;
        return { id: newId(), a: swap ? b : a, b: swap ? a : b, result: null, scores: null };
      }),
      byes,
    });
  }

  roundDone(t) {
    const r = t.rounds[t.rounds.length - 1];
    return r && r.pairings.every((p) => p.result);
  }

  setResult(t, pairing, result, scores = null) {
    if (pairing.result) return;
    pairing.result = result;
    pairing.scores = scores;
    // A draw is a loss for both.
    if (result === 'a' || result === 'draw') t.losses[pairing.b] = (t.losses[pairing.b] || 0) + 1;
    if (result === 'b' || result === 'draw') t.losses[pairing.a] = (t.losses[pairing.a] || 0) + 1;
    if (this.roundDone(t)) this.nextRound(t);
    this.save();
  }

  // A game started from a pairing has finished.
  reportResult(ref, g) {
    const t = this.data.list.find((x) => x.id === ref.tid);
    if (!t) return;
    const p = t.rounds.flatMap((r) => r.pairings).find((x) => x.id === ref.pid);
    if (!p || p.result) return;
    const w = g.winner();
    this.setResult(t, p, w === -1 ? 'draw' : w === 0 ? 'a' : 'b', g.scores.map((v) => Math.round(v)));
    this.app.toast('Result saved to the tournament.');
  }

  playPairing(t, p) {
    const pa = t.players.find((x) => x.id === p.a), pb = t.players.find((x) => x.id === p.b);
    const seat = (pl) => (pl.type === 'ai' ? { type: 'ai', level: pl.level, style: 'balanced', name: pl.name } : { type: 'human', name: pl.name });
    const seats = [seat(pa), seat(pb)];
    const humans = seats.filter((s) => s.type === 'human').length;
    this.app.play.start({
      mode: humans === 1 ? 'ai' : 'local', rules: { ...t.rules, players: 2, teams: false }, seats, clock: t.clock,
      tournament: { tid: t.id, pid: p.id },
    });
    location.hash = '#play';
  }

  name(t, id) {
    const p = t.players.find((x) => x.id === id);
    return p ? p.name : '?';
  }

  render(root) {
    const t = this.current;
    root.querySelector('#tour-list').innerHTML = this.data.list.length
      ? this.data.list.map((x) => `<option value="${x.id}"${x.id === this.data.current ? ' selected' : ''}>${esc(x.name)}${x.done ? ' (finished)' : ''}</option>`).join('')
      : '';
    root.querySelector('#tour-pick').hidden = !this.data.list.length;
    const view = root.querySelector('#tour-view');
    if (!t) { view.innerHTML = '<p class="small">Set up a tournament to get started.</p>'; return; }
    const standings = t.players.slice().sort((a, b) => (t.losses[a.id] || 0) - (t.losses[b.id] || 0));
    const status = (p) => {
      const l = t.losses[p.id] || 0;
      if (t.winner === p.id) return '<span class="mark mark-best">Champion</span>';
      return l >= 2 ? '<span class="mark mark-blunder">Out</span>' : l === 1 ? '<span class="mark mark-inacc">One loss</span>' : '<span class="mark mark-good">No losses</span>';
    };
    const roundsHtml = t.rounds.map((r, i) => {
      const last = i === t.rounds.length - 1 && !t.done;
      const rows = r.pairings.map((p) => {
        const res = p.result === 'a' ? `${esc(this.name(t, p.a))} won` : p.result === 'b' ? `${esc(this.name(t, p.b))} won` : p.result === 'draw' ? 'Draw (a loss for both)' : '';
        const sc = p.scores ? ` <span class="small">${p.scores.join(' / ')}</span>` : '';
        const actions = !p.result && last ? `
          <button class="btn small-btn" data-play="${p.id}">Play</button>
          <select data-manual="${p.id}" aria-label="Record a result"><option value="">Record result…</option><option value="a">${esc(this.name(t, p.a))} won</option><option value="b">${esc(this.name(t, p.b))} won</option><option value="draw">Draw</option></select>` : '';
        return `<li><span><i class="chip chip-p0"></i>${esc(this.name(t, p.a))} <span class="small">vs</span> <i class="chip chip-p1"></i>${esc(this.name(t, p.b))}</span><span>${res}${sc}${actions}</span></li>`;
      }).join('');
      const byes = r.byes.length ? `<li class="small">Bye: ${r.byes.map((id) => esc(this.name(t, id))).join(', ')}</li>` : '';
      return `<div class="tour-round"><h3>Round ${i + 1}</h3><ul class="pairings">${rows}${byes}</ul></div>`;
    }).reverse().join('');
    view.innerHTML = `
      ${t.done ? `<div class="tour-winner">${t.winner ? `${esc(this.name(t, t.winner))} wins the tournament.` : 'The tournament is over.'}</div>` : ''}
      <div class="tour-cols">
        <div><h3>Standings</h3><table class="standings"><tbody>${standings.map((p) => `<tr><td>${esc(p.name)}${p.type === 'ai' && !p.name.includes(LEVEL_NAMES[p.level] || p.level) ? ` <span class="small">(computer, ${LEVEL_NAMES[p.level] || p.level})</span>` : ''}</td><td>${status(p)}</td></tr>`).join('')}</tbody></table>
        <p class="small">Draws count as a loss for both players. Two losses and you are out.</p></div>
        <div>${roundsHtml}</div>
      </div>`;
    view.onclick = (e) => {
      const b = e.target.closest('[data-play]');
      if (!b) return;
      const p = t.rounds[t.rounds.length - 1].pairings.find((x) => x.id === b.dataset.play);
      if (p) this.playPairing(t, p);
    };
    view.onchange = (e) => {
      const s = e.target.closest('[data-manual]');
      if (!s || !s.value) return;
      const p = t.rounds[t.rounds.length - 1].pairings.find((x) => x.id === s.dataset.manual);
      if (p) { this.setResult(t, p, s.value); this.render(root); }
    };
  }
}
