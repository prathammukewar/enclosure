// Runs the computer player off the main thread.
import { Game } from './engine.js';
import { planTurn } from './ai.js';
import { bookMove } from './book.js';

self.onmessage = (e) => {
  const { id, history, base, rules, level, seed, opts = {} } = e.data;
  try {
    const g = Game.fromHistory(history, base, rules);
    const o = { ...opts };
    // The opening book is Hard's: weaker levels play their own openings.
    o.book = o.book !== false && (level === 'hard' || level === 'adaptive') ? bookMove : null;
    self.postMessage({ id, plan: planTurn(g, level, seed, o) });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
