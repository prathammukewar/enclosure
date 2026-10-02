// Re-checks puzzles on the engine alone, without the solver.
//   swing, gain, cut: every legal first edge, then every legal second edge.
//     Second edges that neither break nor close anything can't change any
//     area, so only the rest are played out.
//   block: every legal edge, then every enemy edge that breaks one of the
//     mover's edges (nothing else can open the mover's area).
//   plan: the stated four edges are replayed, with the opponent timing out,
//     and must reach the stated swing. Plan targets are a bar to reach, not
//     a proven best.
//
// node tools/verify-puzzles.mjs [input.json] [threads]
// With an input file it checks those candidates and prints the ones that
// pass as JSON; without one it checks js/puzzledata.js.

import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { cpus } from 'node:os';
import { readFileSync } from 'node:fs';

if (isMainThread) {
  const file = process.argv[2];
  const threads = Number(process.argv[3] || Math.max(1, cpus().length - 2));
  const list = file && file !== '-' ? JSON.parse(readFileSync(file, 'utf8')) : (await import('../js/puzzledata.js')).PUZZLES;
  const results = new Array(list.length);
  let next = 0, done = 0;
  await new Promise((resolve) => {
    if (!list.length) resolve();
    for (let t = 0; t < Math.min(threads, list.length); t++) {
      const w = new Worker(new URL(import.meta.url));
      const feed = () => { if (next < list.length) { const i = next++; w.postMessage({ i, p: list[i] }); } else w.terminate(); };
      w.on('message', (r) => {
        results[r.i] = r;
        done++;
        process.stderr.write(`${done}/${list.length} ${list[r.i].type || 'swing'} ${r.ok ? 'ok' : 'FAIL'} found ${r.best} stated ${list[r.i].best}\n`);
        if (done === list.length) resolve();
        feed();
      });
      feed();
    }
  });
  const bad = results.filter((r) => !r.ok);
  process.stderr.write(`${list.length - bad.length} verified, ${bad.length} failed\n`);
  if (file && file !== '-') console.log(JSON.stringify(list.filter((_, i) => results[i].ok)));
  process.exit(bad.length && !(file && file !== '-') ? 1 : 0);
} else {
  const { Game, decodeHistory, decodeRules, makeRules } = await import('../js/engine.js');

  const startOf = (p) => {
    const rules = p.rules ? decodeRules(p.rules) : makeRules({});
    return Game.fromHistory(decodeHistory(p.code, rules), null, rules);
  };

  function bestTurn(g, mode) {
    const me = g.player;
    const value = (h) => {
      const gain = h.areas[me] - g.areas[me];
      let cut = 0;
      for (const q of g.enemiesOf(me)) cut += g.areas[q] - h.areas[q];
      return mode === 'gain' ? gain : mode === 'cut' ? cut : gain + cut;
    };
    let best = -Infinity;
    for (const m1 of g.legalMoves()) {
      const g1 = g.clone();
      g1.play(m1.fx, m1.fy, m1.tx, m1.ty);
      best = Math.max(best, value(g1));
      if (g1.player !== me || g1.over) continue;
      for (const m2 of g1.legalMoves()) {
        if (!m2.breaks && !m2.closes) continue;
        const g2 = g1.clone();
        g2.play(m2.fx, m2.fy, m2.tx, m2.ty);
        best = Math.max(best, value(g2));
      }
    }
    return best;
  }

  // Smallest "most the next player can open with one edge", over my edges.
  function bestBlock(g) {
    const me = g.player;
    let best = Infinity;
    for (const m of g.legalMoves()) {
      const h = g.clone();
      h.play(m.fx, m.fy, m.tx, m.ty);
      let worst = 0;
      if (!h.over && h.isEnemy(h.player, me)) {
        for (const e of h.legalMoves()) {
          if (!e.breaks || e.breaks.owner !== me) continue;
          const k = h.clone();
          k.play(e.fx, e.fy, e.tx, e.ty);
          worst = Math.max(worst, h.areas[me] - k.areas[me]);
        }
      }
      best = Math.min(best, worst);
    }
    return best;
  }

  function planValue(g, sol) {
    const me = g.player;
    const h = g.clone();
    for (const [a, b, c, d] of sol) {
      while (h.player !== me && !h.over) h.timeout();
      if (h.over || !h.check(a, b, c, d).ok) return -Infinity;
      h.play(a, b, c, d);
    }
    return (h.areas[me] - g.areas[me]) + (g.areas[1 - me] - h.areas[1 - me]);
  }

  parentPort.on('message', ({ i, p }) => {
    const g = startOf(p);
    const type = p.type || 'swing';
    let best, ok = g.player === p.player;
    if (type === 'block') {
      best = bestBlock(g);
      ok = ok && g.left === 1 && Math.abs(best - p.best) < 1e-6;
    } else if (type === 'plan') {
      best = planValue(g, p.sol);
      ok = ok && g.left === 2 && p.sol.length === 4 && Math.abs(best - p.best) < 1e-6;
    } else {
      best = bestTurn(g, type);
      ok = ok && g.left === 2 && Math.abs(best - p.best) < 1e-6;
    }
    parentPort.postMessage({ i, best: Math.round(best * 1e6) / 1e6, ok });
  });
}
