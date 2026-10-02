import { parentPort, workerData } from 'node:worker_threads';
import { Game } from '../js/engine.js';
import { planTurn } from '../js/ai.js';

const { A, B, rules } = workerData;
parentPort.on('message', (i) => {
  const g = new Game(null, rules);
  const aSeat = i % g.NP;
  let ms = 0, turns = 0, slow = 0;
  while (!g.over) {
    const t0 = performance.now();
    const cfg = g.sideOf(g.player) === g.sideOf(aSeat) ? A : B;
    const plan = planTurn(g, cfg, 7777 + i * 131 + g.turn);
    const dt = performance.now() - t0;
    ms += dt; turns++; slow = Math.max(slow, dt);
    for (const m of plan) g.apply(m);
  }
  const w = g.winner();
  const mine = g.sideOf(aSeat);
  const sc = g.sideScores();
  const other = sc.filter((_, s) => s !== mine);
  parentPort.postMessage({ result: w === -1 ? 'D' : w === mine ? 'A' : 'B', diff: sc[mine] - Math.max(...other), ms, turns, slow });
});
