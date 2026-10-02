// Runs the exact turn solver off the main thread.
import { Game } from './engine.js';
import { solveTurn, solveBlock } from './solver.js';

self.onmessage = (e) => {
  const { id, kind = 'turn', history, base, rules, mode = 'swing' } = e.data;
  try {
    const g = Game.fromHistory(history || [], base || null, rules || null);
    const result = kind === 'block' ? solveBlock(g) : solveTurn(g, mode);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
