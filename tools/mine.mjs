// Mines puzzles from computer games. Five kinds:
//   swing  the best two-edge turn, clearly better than the greedy one
//   gain   fence in as much as possible this turn
//   cut    open as much enemy area as possible this turn
//   block  with one edge left, leave the next player's best cut smallest
//   plan   the opponent times out, so four edges in a row reach a target
//          that two separate best turns can't
// Answers come from js/solver.js (exact for swing, gain, cut and block). Plan
// targets are what a beam search found, so they are a reachable bar rather
// than a proven best; the puzzle says "at least".
//
// node tools/mine.mjs [games] [threads] [kinds] > mined.jsonl
// Writes one puzzle per line as soon as it's found.
// kinds: comma list, default swing,gain,cut,block,plan

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';

if (isMainThread) {
  const games = Number(process.argv[2] || 16);
  const threads = Math.min(games, Number(process.argv[3] || Math.max(1, cpus().length - 2)));
  const kinds = (process.argv[4] || 'swing,gain,cut,block,plan').split(',');
  const seed0 = Number(process.env.SEED || Date.now() % 100000);
  const out = [];
  let next = 0, done = 0;
  await new Promise((resolve) => {
    for (let t = 0; t < threads; t++) {
      const w = new Worker(new URL(import.meta.url), { workerData: { kinds } });
      const feed = () => { if (next < games) w.postMessage(seed0 + next++); else w.terminate(); };
      w.on('message', (r) => {
        out.push(...r);
        for (const p of r) process.stdout.write(`${JSON.stringify(p)}\n`);
        done++;
        const count = (k) => out.filter((p) => p.type === k).length;
        process.stderr.write(`game ${done}/${games}: +${r.length} (${kinds.map((k) => `${k} ${count(k)}`).join(', ')})\n`);
        if (done === games) resolve();
        feed();
      });
      feed();
    }
  });
} else {
  const { Game, encodeHistory } = await import('../js/engine.js');
  const { planTurn, scoreMoves } = await import('../js/ai.js');
  const { solveTurn, solveBlock } = await import('../js/solver.js');
  const kinds = new Set(workerData.kinds);
  const r6 = (v) => Math.round(v * 1e6) / 1e6;

  const swingOf = (a, b, me) => (b.areas[me] - a.areas[me]) + (a.areas[1 - me] - b.areas[1 - me]);

  // Plays edges for `me`, skipping the opponent's turn whenever it comes up.
  function playPlan(g, edges) {
    const h = g.clone();
    const me = g.player;
    for (const [a, b, c, d] of edges) {
      while (h.player !== me && !h.over) h.timeout();
      if (h.over) return null;
      if (!h.check(a, b, c, d).ok) return null;
      h.play(a, b, c, d);
    }
    return h;
  }

  // Beam search over four edges in a row.
  function solvePlan(g) {
    const me = g.player;
    let beam = [{ edges: [], h: g.clone() }];
    for (let depth = 0; depth < 4; depth++) {
      const next = [];
      for (const st of beam) {
        const h = st.h;
        while (h.player !== me && !h.over) h.timeout();
        if (h.over) continue;
        const moves = scoreMoves(h);
        moves.sort((a, b) => (b.gain + b.loss) - (a.gain + a.loss));
        // Effective moves, plus a sample of quiet ones that set things up.
        const eff = moves.filter((m) => m.gain + m.loss > 1e-9).slice(0, 25);
        const quiet = moves.filter((m) => m.gain + m.loss <= 1e-9);
        const pick = depth < 3 ? [...eff, ...quiet.filter((_, i) => i % Math.max(1, Math.floor(quiet.length / 30)) === 0)] : eff.slice(0, 8);
        for (const m of pick) {
          const k = h.clone();
          k.play(m.fx, m.fy, m.tx, m.ty);
          const done = swingOf(g, k, me);
          let look = 0;
          if (depth < 3) {
            const kk = k.clone();
            while (kk.player !== me && !kk.over) kk.timeout();
            if (!kk.over) for (const m2 of scoreMoves(kk)) look = Math.max(look, m2.gain + m2.loss);
          }
          next.push({ edges: [...st.edges, [m.fx, m.fy, m.tx, m.ty]], h: k, v: done, est: done + look * (depth < 3 ? 1 : 0) });
        }
      }
      next.sort((a, b) => b.est - a.est);
      beam = next.slice(0, depth === 0 ? 30 : 20);
      if (!beam.length) return null;
    }
    beam.sort((a, b) => b.v - a.v);
    const top = beam[0];
    return { best: top.v, sol: top.edges, end: top.h };
  }

  // Two best turns in a row, the opponent timing out between them.
  function chainedGreedy(g) {
    const me = g.player;
    const t1 = solveTurn(g);
    if (!t1) return null;
    const h = playPlan(g, t1.sol);
    if (!h) return null;
    while (h.player !== me && !h.over) h.timeout();
    if (h.over) return null;
    const t2 = solveTurn(h);
    if (!t2) return null;
    const end = playPlan(h, t2.sol) || h;
    return swingOf(g, end, me);
  }

  const rec = (g, type, extra) => ({
    type, code: encodeHistory(g.history), player: g.player, turn: g.turn, ...extra,
  });

  function tryTurnKinds(g, found) {
    // Cut and swing puzzles are rarer, so they get the first try.
    const order = ['cut', 'swing', 'gain'].filter((k) => kinds.has(k));
    for (const mode of order) {
      const r = solveTurn(g, mode);
      if (!r || !r.sol.length) continue;
      let good;
      if (mode === 'swing') good = r.best >= 3 && r.best - r.greedy >= 1.5;
      else if (mode === 'cut') good = r.best >= 4 && (r.best - r.greedy >= 1 || r.firsts <= 3);
      else good = r.best >= 4 && (r.best - r.greedy >= 1 || (r.firsts <= 2 && r.best >= 6));
      if (!good) continue;
      found.push(rec(g, mode, { best: r.best, greedy: r.greedy, firsts: r.firsts, gain: r.gain, cut: r.cut, sol: r.sol }));
      return true;
    }
    return false;
  }

  function tryBlock(g, found) {
    const r = solveBlock(g);
    if (!r || !r.sol) return false;
    if (r.worst - r.best < 3 || r.count > Math.max(4, r.total * 0.1)) return false;
    found.push(rec(g, 'block', { best: r.best, worst: r.worst, count: r.count, total: r.total, sol: r.sol, gain: 0, cut: 0 }));
    return true;
  }

  function tryPlan(g, found) {
    const greedy = chainedGreedy(g);
    if (greedy === null) return false;
    const p = solvePlan(g);
    if (!p || p.best < 6 || p.best < greedy + 3) return false;
    const me = g.player;
    const end = playPlan(g, p.sol);
    if (!end || Math.abs(swingOf(g, end, me) - p.best) > 1e-6) return false;
    found.push(rec(g, 'plan', {
      best: r6(p.best), greedy: r6(greedy), sol: p.sol, firsts: 1,
      gain: r6(end.areas[me] - g.areas[me]), cut: r6(g.areas[1 - me] - end.areas[1 - me]),
    }));
    return true;
  }

  parentPort.on('message', (i) => {
    const levels = ['medium', 'hard'];
    const g = new Game();
    const found = [];
    let lastTurn = -10;
    while (!g.over) {
      const mid = g.placed >= 12 && g.placed <= 112 && g.turn - lastTurn >= 3;
      if (mid && g.left === 2 && Math.random() < 0.5) {
        let ok = false;
        if (kinds.has('plan') && g.placed <= 100 && Math.random() < 0.3) ok = tryPlan(g, found);
        if (!ok) ok = tryTurnKinds(g, found);
        if (ok) lastTurn = g.turn;
      }
      const plan = planTurn(g, levels[(i + g.turn) % 2], i * 1000 + g.turn);
      for (let k = 0; k < plan.length; k++) {
        g.apply(plan[k]);
        // Mid-turn: a chance for a block puzzle before the second edge.
        if (k === 0 && kinds.has('block') && !g.over && g.left === 1 && g.placed >= 12 && g.placed <= 112 && g.turn - lastTurn >= 3 && Math.random() < 0.35) {
          if (tryBlock(g, found)) lastTurn = g.turn;
        }
      }
    }
    for (const p of found) p.game = i;
    parentPort.postMessage(found);
  });
}
