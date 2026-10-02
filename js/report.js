// Post-game report: for each turn of the players being graded, the swing
// they got against the best swing possible on that turn (found exactly by
// the solver). Big misses can be saved as personal puzzles.

import { Game, formatArea, encodeHistory, encodeRules } from './engine.js';
import { SolverClient } from './solver-client.js';
import * as store from './store.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function grade(missed, best) {
  if (best <= 1e-9 || missed <= 1e-9) return { mark: 'best', text: 'Best' };
  if (missed < Math.max(1, best * 0.15)) return { mark: 'good', text: 'Good' };
  if (missed < Math.max(3, best * 0.4)) return { mark: 'inacc', text: 'Missed some' };
  if (missed < 10) return { mark: 'mistake', text: 'Mistake' };
  return { mark: 'blunder', text: 'Big miss' };
}

// The start of every turn in a game: { index, turn, player, left }.
export function turnStarts(history, rules) {
  const out = [];
  const g = new Game(null, rules);
  let i = 0;
  while (i <= history.length && !g.over) {
    const start = { index: i, turn: g.turn, player: g.player, left: g.left };
    const t = g.turn;
    let j = i;
    while (j < history.length && g.turn === t && !g.over) { g.apply(history[j]); j++; }
    start.end = j;
    start.complete = g.turn !== t || g.over;
    out.push(start);
    if (j === i) break;
    i = j;
  }
  return out;
}

export class Report {
  constructor(app) {
    this.app = app;
    this.solver = new SolverClient();
    this.running = 0;
  }

  async run(view, out) {
    const run = ++this.running;
    this.solver.cancel();
    const c = view.config;
    const game = view.game;
    const rules = c.rules;
    const hist = game.history.map(({ kind, fx, fy, tx, ty, player }) => ({ kind, fx, fy, tx, ty, player }));
    const mine = view.mySeat();
    const focus = mine !== null ? [mine] : Array.from({ length: game.NP }, (_, p) => p);
    const starts = turnStarts(hist, rules).filter((s) => s.complete && focus.includes(s.player) && s.left <= 2 && hist.slice(s.index, s.end).every((m) => m.kind === 'edge' || m.kind === 'pass'));
    if (!starts.length) { out.innerHTML = '<p class="small">There are no finished turns to grade yet.</p>'; return; }
    out.innerHTML = `<p class="small" id="rep-progress">Checking ${starts.length} turns. Each one tries every pair of edges, so this takes a little while.</p>
      <div id="rep-summary"></div>
      <table class="report"><thead><tr><th>Turn</th><th>Got</th><th>Best</th><th></th></tr></thead><tbody id="rep-rows"></tbody></table>`;
    const rowsEl = out.querySelector('#rep-rows');
    let got = 0, possible = 0, done = 0;
    const results = [];
    for (const s of starts) {
      if (run !== this.running) return;
      const before = Game.fromHistory(hist.slice(0, s.index), null, rules);
      const after = Game.fromHistory(hist.slice(0, s.end), null, rules);
      const me = s.player;
      let actual = after.areas[me] - before.areas[me];
      for (const q of before.enemiesOf(me)) actual += before.areas[q] - after.areas[q];
      let res;
      try {
        res = await this.solver.solve({ kind: 'turn', history: hist.slice(0, s.index), rules });
      } catch {
        return;
      }
      if (run !== this.running) return;
      if (!res) continue;
      const missed = Math.max(0, res.best - actual);
      const gr = grade(missed, res.best);
      got += Math.max(0, actual);
      possible += res.best;
      done++;
      const row = { ...s, actual, ...res, missed, gr };
      results.push(row);
      const tr = document.createElement('tr');
      tr.className = `rep-${gr.mark}`;
      tr.innerHTML = `<td><button class="link" data-i="${s.index}">${s.turn}${focus.length > 1 ? ` <i class="chip chip-p${me}"></i>` : ''}</button></td><td>${formatArea(Math.max(0, actual))}</td><td>${formatArea(res.best)}</td><td><span class="mark mark-${gr.mark}">${gr.text}</span>${missed >= 3 ? ` <button class="link save" data-k="${results.length - 1}">Save as puzzle</button>` : ''}</td>`;
      rowsEl.appendChild(tr);
      out.querySelector('#rep-progress').textContent = `Checked ${done} of ${starts.length} turns.`;
      out.querySelector('#rep-summary').innerHTML = `<div class="rep-acc"><b>${possible > 0 ? Math.round((got / possible) * 100) : 100}%</b> of the best swing you could have had, over ${done} turns.</div>`;
    }
    if (run !== this.running) return;
    out.querySelector('#rep-progress').textContent = `Done. Swing counts the area fenced in plus enemy area opened on that turn, so it doesn't measure defence or long-term plans.`;
    view.reportResult = results;
    this.app.profile.noteReport(results);
    out.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.classList.contains('save')) {
        const r = results[Number(b.dataset.k)];
        this.savePuzzle(r, hist, rules, view);
        b.textContent = 'Saved';
        b.disabled = true;
        return;
      }
      const idx = Number(b.dataset.i);
      const r = results.find((x) => x.index === idx);
      view.enterReview(idx);
      if (r && r.sol && r.sol.length) {
        const [fx, fy, tx, ty] = r.sol[0];
        view.board.setHint({ fx, fy, tx, ty });
        const g = view.viewGame();
        view.flash(`Best here: ${r.sol.map(([a, b2, c2, d]) => `${g.pointName(a, b2)}-${g.pointName(c2, d)}`).join(', then ')} for a swing of ${formatArea(r.best)}.`);
      }
    };
  }

  savePuzzle(r, hist, rules, view) {
    const list = store.load('myPuzzles', []);
    const code = encodeHistory(hist.slice(0, r.index), rules);
    if (list.some((p) => p.code === code)) return;
    list.push({
      code, rules: encodeRules(rules), player: r.player, best: r.best, gain: r.gain, cut: r.cut, firsts: r.firsts,
      sol: r.sol, level: r.firsts > 2 ? 1 : 2, mine: true, from: `${esc(view.config.names.join(' vs '))}, turn ${r.turn}`, date: Date.now(),
    });
    store.save('myPuzzles', list);
    this.app.toast('Saved. Find it under Puzzles, in Your puzzles.');
  }
}
