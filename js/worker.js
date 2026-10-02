// Runs the computer player off the main thread.
import { Game } from './engine.js';
import { planTurn } from './ai.js';

self.onmessage = (e) => {
  const { id, history, base, level, seed } = e.data;
  try {
    const g = Game.fromHistory(history, base);
    self.postMessage({ id, plan: planTurn(g, level, seed) });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
