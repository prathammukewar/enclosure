// Computer vs computer matches for tuning.
// node tools/selfplay.mjs <levelA> <levelB> [games] [seed]
import { Game, BLUE, RED } from '../js/engine.js';
import { planTurn, LEVELS } from '../js/ai.js';

const [a = 'hard', b = 'medium', games = '4', seed0 = '1'] = process.argv.slice(2);
const parse = (s) => (s.startsWith('{') ? { ...LEVELS.hard, ...JSON.parse(s) } : s);
const A = parse(a), B = parse(b);

let winsA = 0, winsB = 0, draws = 0, slowest = 0, total = 0, turns = 0;
for (let i = 0; i < Number(games); i++) {
  const g = new Game();
  const aColor = i % 2 === 0 ? BLUE : RED;
  const breaks = [0, 0], peak = [0, 0];
  const curve = [];
  while (!g.over) {
    const lvl = g.player === aColor ? A : B;
    const t0 = performance.now();
    const plan = planTurn(g, lvl, Number(seed0) * 1000 + i * 100 + g.turn);
    const dt = performance.now() - t0;
    slowest = Math.max(slowest, dt); total += dt; turns++;
    for (const m of plan) {
      const pl = g.player;
      const r = g.apply(m);
      if (r && r.broke) breaks[pl]++;
    }
    peak[0] = Math.max(peak[0], g.areas[0]); peak[1] = Math.max(peak[1], g.areas[1]);
    if (g.turn % 10 === 0) curve.push(g.areas.map((x) => Math.round(x)).join('/'));
  }
  if (process.env.VERBOSE) console.log('   breaks', breaks.join('/'), 'peak', peak.map((x) => Math.round(x)).join('/'), 'areas by turn', curve.join(' '));
  const w = g.winner();
  const res = w === -1 ? 'draw' : w === aColor ? 'A' : 'B';
  if (res === 'A') winsA++; else if (res === 'B') winsB++; else draws++;
  console.log(`game ${i + 1}: A=${aColor === BLUE ? 'blue' : 'red'} blue ${g.scores[0]} red ${g.scores[1]} -> ${res}  (areas ${g.areas.join('/')})`);
}
console.log(`A ${winsA}  B ${winsB}  draws ${draws}   avg ${(total / turns).toFixed(0)} ms/turn, slowest ${slowest.toFixed(0)} ms`);
