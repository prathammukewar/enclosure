// Computer-vs-computer matches.
// node tools/arena.mjs <A> <B> [games] [threads] [rules-json]
// A and B are level names, JSON overrides of the hard level ('{"rho":0.9}'),
// or a level with overrides ('medium:{"budget":0}').
import { cpus } from 'node:os';
import { LEVELS } from '../js/ai.js';
import { runMatch, describe } from './match.mjs';

const parse = (s) => {
  const m = s.match(/^(easy|medium|hard|expert):(\{.*\})$/);
  if (m) return { ...LEVELS[m[1]], ...JSON.parse(m[2]) };
  if (s.startsWith('{')) return { ...LEVELS.hard, ...JSON.parse(s) };
  return LEVELS[s];
};
const [a = 'hard', b = 'medium', games = '40', threads = String(Math.max(1, cpus().length - 2)), rules = 'null'] = process.argv.slice(2);
const t0 = Date.now();
const res = await runMatch(parse(a), parse(b), Number(games), Number(threads), JSON.parse(rules));
console.log(`${describe(res)}  [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
