// Re-checks every puzzle by brute force on the engine alone: every legal
// first edge, then every legal second edge. Second edges that neither break
// nor close anything can't change any area, so only the rest are played out.
//
// node tools/verify-puzzles.mjs [input.json] [threads]
// With an input file it checks those candidates and prints the ones that
// pass as JSON; without one it checks js/puzzledata.js.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { readFileSync } from 'node:fs';

if (isMainThread) {
  const file = process.argv[2];
  const threads = Number(process.argv[3] || Math.max(1, cpus().length - 2));
  const list = file && file !== '-' ? JSON.parse(readFileSync(file, 'utf8')) : (await import('../js/puzzledata.js')).PUZZLES;
  const results = new Array(list.length);
  let next = 0, done = 0;
  await new Promise((resolve) => {
    for (let t = 0; t < Math.min(threads, list.length); t++) {
      const w = new Worker(new URL(import.meta.url), { workerData: {} });
      const feed = () => { if (next < list.length) { const i = next++; w.postMessage({ i, p: list[i] }); } else w.terminate(); };
      w.on('message', (r) => {
        results[r.i] = r;
        done++;
        process.stderr.write(`${done}/${list.length} ${r.ok ? 'ok' : 'FAIL'} best ${r.best} stated ${list[r.i].best}\n`);
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
  const { Game, decodeHistory } = await import('../js/engine.js');
  parentPort.on('message', ({ i, p }) => {
    const g = Game.fromHistory(decodeHistory(p.code));
    const me = g.player;
    const swing = (h) => (h.areas[me] - g.areas[me]) + (g.areas[1 - me] - h.areas[1 - me]);
    let best = -Infinity;
    for (const m1 of g.legalMoves()) {
      const g1 = g.clone();
      g1.play(m1.fx, m1.fy, m1.tx, m1.ty);
      const s1 = swing(g1);
      if (s1 > best) best = s1;
      if (g1.player !== me) continue;
      for (const m2 of g1.legalMoves()) {
        if (!m2.breaks && !m2.closes) continue;
        const g2 = g1.clone();
        g2.play(m2.fx, m2.fy, m2.tx, m2.ty);
        const s = swing(g2);
        if (s > best) best = s;
      }
    }
    parentPort.postMessage({ i, best, ok: g.player === p.player && g.left === 2 && Math.abs(best - p.best) < 1e-6 });
  });
}
