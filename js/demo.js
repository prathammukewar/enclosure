// The home page board: the computer playing itself, slowly.
import { Game, BLUE, RED, formatArea } from './engine.js';
import { Board } from './board.js';
import { AIClient } from './ai-client.js';
import { LEVELS } from './ai.js';

const LEVEL = { ...LEVELS.medium, budget: 250, blunder: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Demo {
  constructor(el, caption) {
    this.el = el;
    this.caption = caption;
    this.board = null;
    this.ai = new AIClient();
    this.running = false;
    this.gen = 0;
    this.game = null;
  }

  // Draw the current position even while paused.
  show() {
    if (!this.board) this.board = new Board(this.el, { interactive: false, coords: false, labels: true, animate: true });
    if (!this.game) this.game = new Game();
    this.board.setGame(this.game);
    this.say();
  }

  start() {
    if (this.running) return;
    this.show();
    this.running = true;
    this.loop(++this.gen);
  }

  stop() {
    this.running = false;
    this.gen++;
    this.ai.cancel();
  }

  say() {
    const g = this.game;
    this.caption.textContent = g.over
      ? `Final score: Blue ${Math.round(g.scores[BLUE])}, Red ${Math.round(g.scores[RED])}`
      : `The computer playing itself · edge ${g.placed} of 120 · Blue ${Math.round(g.scores[BLUE])}, Red ${Math.round(g.scores[RED])}`;
  }

  async loop(gen) {
    if (!this.game || this.game.over) this.game = new Game();
    this.board.setGame(this.game);
    this.say();
    while (this.running && gen === this.gen) {
      const g = this.game;
      if (g.over) {
        await sleep(6000);
        if (gen !== this.gen) return;
        this.game = new Game();
        this.board.setGame(this.game);
        this.say();
        continue;
      }
      let plan;
      try { plan = await this.ai.think(g, LEVEL, (Math.random() * 1e9) >>> 0); } catch { return; }
      for (const m of plan) {
        await sleep(950);
        if (!this.running || gen !== this.gen || g.over) return;
        let e;
        try { e = g.apply(m); } catch { this.game = new Game(); break; }
        this.board.setGame(g, e && e.kind === 'edge' ? { added: e.edge, broken: e.broke, removedNodes: [] } : null);
        this.say();
      }
    }
  }
}
