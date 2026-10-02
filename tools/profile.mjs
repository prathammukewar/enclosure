// Finds the slowest computer turn in a hard vs hard game and prints its position code.
import { Game, encodeHistory } from '../js/engine.js';
import { planTurn } from '../js/ai.js';
const g = new Game();
let worst = 0, worstCode = '';
while (!g.over) {
  const code = encodeHistory(g.history);
  const t0 = performance.now();
  const plan = planTurn(g, 'hard', g.turn);
  const dt = performance.now() - t0;
  if (dt > worst) { worst = dt; worstCode = code; }
  for (const m of plan) g.apply(m);
}
console.log('worst', worst.toFixed(0), 'ms at', worstCode.length / 3, 'edges');
console.log(worstCode);
