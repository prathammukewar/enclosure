// Parallel computer-vs-computer matches.
// node tools/arena.mjs <A> <B> [games] [threads]
// A and B are level names or JSON overrides of the hard level, e.g. '{"rho":0.9}'.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';

if (isMainThread) {
  const [a = 'hard', b = 'medium', games = '40', threads = String(Math.max(1, cpus().length - 2))] = process.argv.slice(2);
  const n = Number(games), t = Math.min(Number(threads), n);
  let next = 0, done = 0;
  const res = { A: 0, B: 0, D: 0, diff: 0, ms: 0, turns: 0, slow: 0 };
  const t0 = Date.now();
  await new Promise((resolve) => {
    for (let i = 0; i < t; i++) {
      const w = new Worker(new URL(import.meta.url), { workerData: { a, b } });
      const feed = () => { if (next < n) w.postMessage(next++); else w.terminate(); };
      w.on('message', (r) => {
        res[r.result]++;
        res.diff += r.diff; res.ms += r.ms; res.turns += r.turns; res.slow = Math.max(res.slow, r.slow);
        done++;
        if (done === n) resolve();
        feed();
      });
      feed();
    }
  });
  const se = Math.sqrt(n) / 2;
  console.log(`A ${res.A}  B ${res.B}  draws ${res.D}  of ${n}  (A score ${((res.A + res.D / 2) / n * 100).toFixed(0)}% ± ${(se / n * 100).toFixed(0)})  avg margin ${(res.diff / n).toFixed(0)}  ${(res.ms / res.turns).toFixed(0)} ms/turn, slowest ${res.slow.toFixed(0)}  [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
} else {
  const { Game, BLUE } = await import('../js/engine.js');
  const { planTurn, LEVELS } = await import('../js/ai.js');
  // 'hard', '{"rho":0.9}' (hard with changes) or 'medium:{"budget":0}'.
  const parse = (s) => {
    const m = s.match(/^(easy|medium|hard):(\{.*\})$/);
    if (m) return { ...LEVELS[m[1]], ...JSON.parse(m[2]) };
    return s.startsWith('{') ? { ...LEVELS.hard, ...JSON.parse(s) } : s;
  };
  const A = parse(workerData.a), B = parse(workerData.b);
  parentPort.on('message', (i) => {
    const g = new Game();
    const aColor = i % 2 === 0 ? BLUE : 1 - BLUE;
    let ms = 0, turns = 0, slow = 0;
    while (!g.over) {
      const t0 = performance.now();
      const plan = planTurn(g, g.player === aColor ? A : B, 7777 + i * 131 + g.turn);
      const dt = performance.now() - t0;
      ms += dt; turns++; slow = Math.max(slow, dt);
      for (const m of plan) g.apply(m);
    }
    const w = g.winner();
    parentPort.postMessage({
      result: w === -1 ? 'D' : w === aColor ? 'A' : 'B',
      diff: g.scores[aColor] - g.scores[1 - aColor], ms, turns, slow,
    });
  });
}
