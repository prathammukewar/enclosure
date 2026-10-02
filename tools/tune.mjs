// Coordinate search over the evaluation weights. Each step plays a variant
// against the current best; a change is kept only if it scores 58% or more.
// node tools/tune.mjs [games] [threads] [rounds] > tools/tuned.json
import { cpus } from 'node:os';
import { LEVELS } from '../js/ai.js';
import { runMatch, describe } from './match.mjs';

const games = Number(process.argv[2] || 32);
const threads = Number(process.argv[3] || Math.max(1, cpus().length - 2));
const rounds = Number(process.argv[4] || 2);
let best = { ...LEVELS.hard, budget: 0, approachW: 0.7, threatW: 1, rho: 0.88, wGain: 2, wLoss: 2, setupQ: 0.5, approachQ: 0.6, exMe: 1, exOp: 1, pBreak: [0.6, 0.3, 0.12, 0.03] };
const steps = [
  ['expose', (v) => [v * 0.7, v * 1.4]],
  ['rho', (v) => [Math.max(0.7, v - 0.05), Math.min(0.97, v + 0.05)]],
  ['horizon', (v) => [v - 3, v + 3]],
  ['threatW', (v) => [v * 0.75, v * 1.3]],
  ['approachW', (v) => [v * 0.7, Math.min(1, v * 1.3)]],
  ['exOp', (v) => [v * 0.7, v * 1.4]],
  ['exMe', (v) => [v * 0.7, v * 1.4]],
  ['wLoss', (v) => [v * 0.7, v * 1.4]],
  ['setupQ', (v) => [v * 0.5, v * 1.8]],
  ['pBreak', (v) => [v.map((p) => p * 0.75), v.map((p) => Math.min(0.9, p * 1.3))]],
];
const log = (s) => process.stderr.write(s + '\n');
for (let r = 0; r < rounds; r++) {
  for (const [key, vary] of steps) {
    for (const val of vary(best[key])) {
      const cand = { ...best, [key]: val };
      const res = await runMatch(cand, best, games, threads);
      const score = (res.A + res.D / 2) / games;
      log(`round ${r + 1} ${key}=${JSON.stringify(val)}: ${describe(res)}`);
      if (score >= 0.58) { best = cand; log(`  kept ${key}=${JSON.stringify(val)}`); break; }
    }
  }
}
console.log(JSON.stringify(best));
