// Runs computer-vs-computer games in worker threads. Used by arena and tune.
import { Worker } from 'node:worker_threads';

// A and B: level names, or config objects. rules: optional game rules.
export function runMatch(A, B, games, threads, rules = null) {
  return new Promise((resolve) => {
    const res = { A: 0, B: 0, D: 0, diff: 0, ms: 0, turns: 0, slow: 0, games };
    let next = 0, done = 0;
    const t = Math.min(threads, games);
    for (let i = 0; i < t; i++) {
      const w = new Worker(new URL('./match-worker.mjs', import.meta.url), { workerData: { A, B, rules } });
      const feed = () => { if (next < games) w.postMessage(next++); else w.terminate(); };
      w.on('message', (r) => {
        res[r.result]++;
        res.diff += r.diff; res.ms += r.ms; res.turns += r.turns; res.slow = Math.max(res.slow, r.slow);
        done++;
        if (done === games) resolve(res);
        feed();
      });
      feed();
    }
  });
}

export function describe(res) {
  const n = res.games;
  return `A ${res.A}  B ${res.B}  draws ${res.D}  of ${n}  (A score ${((res.A + res.D / 2) / n * 100).toFixed(0)}% ± ${(50 / Math.sqrt(n)).toFixed(0)})  avg margin ${(res.diff / n).toFixed(0)}  ${(res.ms / res.turns).toFixed(0)} ms/turn, slowest ${res.slow.toFixed(0)}`;
}
