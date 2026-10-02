// Mines puzzles: positions where the best two-edge turn is clearly better
// than playing the best single edge and then the best follow-up.
//
// node tools/mine.mjs [games] [threads] > tools/mined.json
//
// The best turn is found by trying every first edge and every second edge.
// Second-edge effects come from scoreMoves (exact gains, and enemy losses
// that can only overestimate), then the top combinations are replayed on the
// real engine until no remaining estimate can beat the best exact result.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';

if (isMainThread) {
  const games = Number(process.argv[2] || 16);
  const threads = Math.min(games, Number(process.argv[3] || Math.max(1, cpus().length - 2)));
  const out = [];
  let next = 0, done = 0;
  await new Promise((resolve) => {
    for (let t = 0; t < threads; t++) {
      const w = new Worker(new URL(import.meta.url), { workerData: {} });
      const feed = () => { if (next < games) w.postMessage(next++); else w.terminate(); };
      w.on('message', (r) => {
        out.push(...r);
        done++;
        process.stderr.write(`game ${done}/${games}: ${r.length} puzzles (total ${out.length})\n`);
        if (done === games) resolve();
        feed();
      });
      feed();
    }
  });
  console.log(JSON.stringify(out));
} else {
  const { Game, encodeHistory } = await import('../js/engine.js');
  const { planTurn, scoreMoves } = await import('../js/ai.js');

  const swing = (a, b, me) => (b.areas[me] - a.areas[me]) + (a.areas[1 - me] - b.areas[1 - me]);

  const { segmentsTouch, analyzeArea } = await import('../js/geometry.js');
  const { N, RADIUS } = await import('../js/engine.js');

  // True if edge B touches edge A anywhere except A's start point.
  function touchesBeyondStart(a, b) {
    if (!segmentsTouch(a.fx, a.fy, a.tx, a.ty, b.fx, b.fy, b.tx, b.ty)) return false;
    const sharesStart = (b.fx === a.fx && b.fy === a.fy) || (b.tx === a.fx && b.ty === a.fy);
    if (!sharesStart) return true;
    // They share A's start; they touch elsewhere only if they overlap.
    const cross = (a.tx - a.fx) * (b.ty - b.fy) - (a.ty - a.fy) * (b.tx - b.fx);
    if (cross !== 0) return false;
    const ox = b.fx === a.fx && b.fy === a.fy ? b.tx : b.fx, oy = b.fx === a.fx && b.fy === a.fy ? b.ty : b.fy;
    return (ox - a.fx) * (a.tx - a.fx) + (oy - a.fy) * (a.ty - a.fy) > 0;
  }

  function solve(g) {
    const me = g.player, op = 1 - me;
    const combos = [];
    const root = scoreMoves(g);
    const rootEff = root.filter((m) => m.gain + m.loss > 1e-9);
    const opEdges = g.edgesOf(op);
    const opLoss = new Map();
    {
      const an = analyzeArea(opEdges.map((e) => [e.ax, e.ay, e.bx, e.by]), true);
      opEdges.forEach((e, i) => opLoss.set(e.id, an.loss[i]));
    }
    let bestSingle = -Infinity, bestSingleMove = null;
    for (const m1 of root) {
      const g1 = g.clone();
      g1.play(m1.fx, m1.fy, m1.tx, m1.ty);
      const s1 = swing(g, g1, me);
      if (s1 > bestSingle) { bestSingle = s1; bestSingleMove = m1; }
      if (g1.player !== me) { combos.push({ m1, m2: null, est: s1 }); continue; }
      combos.push({ m1, m2: 'quiet', est: s1 });
      if (m1.breaks || m1.closes) {
        for (const m2 of scoreMoves(g1)) {
          const v = m2.gain + m2.loss;
          if (v > 1e-9) combos.push({ m1, m2, est: s1 + v });
        }
        continue;
      }
      // A quiet first edge only adds a dangling edge: second edges that don't
      // touch it keep their effect from the root position.
      for (const m2 of rootEff) {
        if (touchesBeyondStart(m1, m2)) continue;
        combos.push({ m1, m2, est: s1 + m2.gain + m2.loss });
      }
      // Second edges that touch the new edge or its new node.
      const segs = g1.edgesOf(me).map((e) => [e.ax, e.ay, e.bx, e.by]);
      for (const [nx, ny] of g1.nodesOf(me)) {
        if (Math.max(Math.abs(nx - m1.fx), Math.abs(ny - m1.fy)) > 2 * RADIUS) continue;
        for (let dy = -RADIUS; dy <= RADIUS; dy++) for (let dx = -RADIUS; dx <= RADIUS; dx++) {
          if (!dx && !dy) continue;
          const tx = nx + dx, ty = ny + dy;
          if (tx < 0 || ty < 0 || tx >= N || ty >= N) continue;
          const m2 = { fx: nx, fy: ny, tx, ty };
          if (!touchesBeyondStart(m1, m2)) continue;
          const r = g1.check(nx, ny, tx, ty);
          if (!r.ok) continue;
          let v = r.breaks ? opLoss.get(r.breaks.id) || 0 : 0;
          if (r.closes) v += Math.max(0, analyzeArea([...segs, [nx, ny, tx, ty]]).area - g1.areas[me]);
          if (v > 1e-9) combos.push({ m1, m2, est: s1 + v });
        }
      }
    }
    // Greedy: the best first edge on its own, then the best second edge.
    let greedy;
    {
      const g1 = g.clone();
      g1.play(bestSingleMove.fx, bestSingleMove.fy, bestSingleMove.tx, bestSingleMove.ty);
      let top = 0;
      if (g1.player === me) for (const m2 of scoreMoves(g1)) top = Math.max(top, m2.gain + m2.loss);
      greedy = bestSingle + top;
    }
    combos.sort((a, b) => b.est - a.est);
    let best = -Infinity, sol = null;
    const exact = [];
    for (const c of combos) {
      if (c.est < best - 1e-9) break;
      const g2 = g.clone();
      g2.play(c.m1.fx, c.m1.fy, c.m1.tx, c.m1.ty);
      let m2 = c.m2;
      if (m2 === 'quiet') {
        m2 = g2.player === me ? g2.legalMoves().find((m) => !m.breaks && !m.closes) || null : null;
        c.m2 = m2;
      }
      if (m2 && g2.player === me) {
        if (!g2.check(m2.fx, m2.fy, m2.tx, m2.ty).ok) continue;
        g2.play(m2.fx, m2.fy, m2.tx, m2.ty);
      }
      if (g2.player === me) continue;
      const v = swing(g, g2, me);
      exact.push({ c, v });
      if (v > best + 1e-9) { best = v; sol = c; }
    }
    const firstsReaching = new Set(exact.filter((x) => x.v >= best - 1e-6).map((x) => `${x.c.m1.fx},${x.c.m1.fy},${x.c.m1.tx},${x.c.m1.ty}`)).size;
    return { best, greedy, sol, firstsReaching, combos: combos.length };
  }

  parentPort.on('message', (i) => {
    const levels = ['medium', 'hard'];
    const g = new Game();
    const found = [];
    while (!g.over) {
      if (g.left === 2 && g.placed >= 12 && g.placed <= 110 && Math.random() < 0.45) {
        const r = solve(g);
        if (r.best >= 3 && r.best - r.greedy >= 1.5) {
          const me = g.player;
          const g2 = g.clone();
          g2.play(r.sol.m1.fx, r.sol.m1.fy, r.sol.m1.tx, r.sol.m1.ty);
          if (r.sol.m2 && g2.player === me) g2.play(r.sol.m2.fx, r.sol.m2.fy, r.sol.m2.tx, r.sol.m2.ty);
          const gain = g2.areas[me] - g.areas[me];
          const cut = g.areas[1 - me] - g2.areas[1 - me];
          found.push({
            game: i, turn: g.turn,
            code: encodeHistory(g.history), player: me, best: Math.round(r.best * 1e6) / 1e6,
            greedy: Math.round(r.greedy * 1e6) / 1e6, firsts: r.firstsReaching,
            gain: Math.round(gain * 1e6) / 1e6, cut: Math.round(cut * 1e6) / 1e6,
            sol: [r.sol.m1, r.sol.m2].filter(Boolean).map((m) => [m.fx, m.fy, m.tx, m.ty]),
          });
        }
      }
      const plan = planTurn(g, levels[(i + g.turn) % 2], i * 1000 + g.turn);
      for (const m of plan) g.apply(m);
    }
    parentPort.postMessage(found);
  });
}
