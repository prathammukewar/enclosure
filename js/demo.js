// The home page board: a short captioned intro, then the computer playing
// itself, slowly.
import { Game } from './engine.js';
import { Board } from './board.js';
import { AIClient } from './ai-client.js';
import { LEVELS } from './ai.js';

const LEVEL = { ...LEVELS.medium, budget: 250, blunder: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each step plays its edges, then shows its caption. Checked by the tests.
export const INTRO = [
  { caption: 'Blue and Red each start with one edge.', moves: [] },
  { caption: 'Edges grow from your own nodes and reach up to 3 points.', moves: [[3, 9, 6, 8]] },
  { caption: 'Close a loop to fence in area. Red now holds 3.', moves: [[15, 9, 16, 7], [16, 7, 18, 9]] },
  { caption: 'After every turn, both players add the area they hold to their score.', moves: [[6, 8, 9, 8], [9, 8, 12, 8]] },
  { caption: 'Red keeps building.', moves: [[15, 9, 14, 11], [14, 11, 16, 12]] },
  { caption: "Touch an enemy edge to break it. Red's loop is open again.", moves: [[12, 8, 15, 8], [15, 8, 16, 8]] },
  { caption: 'After 120 edges, the higher score wins.', moves: [] },
];

export class Demo {
  constructor(el, caption) {
    this.el = el;
    this.caption = caption;
    this.board = null;
    this.ai = new AIClient();
    this.running = false;
    this.gen = 0;
    this.game = null;
    this.introDone = false;
  }

  // Draw the current position even while paused.
  show() {
    if (!this.board) this.board = new Board(this.el, { interactive: false, coords: false, labels: true, animate: true });
    if (!this.game) this.game = new Game();
    this.board.setGame(this.game);
    if (this.introDone) this.say();
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
      ? `Final score: Blue ${Math.round(g.scores[0])}, Red ${Math.round(g.scores[1])}`
      : `The computer playing itself · edge ${g.placed} of 120 · Blue ${Math.round(g.scores[0])}, Red ${Math.round(g.scores[1])}`;
  }

  async intro(gen) {
    const g = new Game();
    this.game = g;
    this.board.setGame(g);
    for (const step of INTRO) {
      for (const [fx, fy, tx, ty] of step.moves) {
        await sleep(700);
        if (gen !== this.gen) return false;
        const e = g.play(fx, fy, tx, ty);
        this.board.setGame(g, { added: e.edge, broken: e.broke, removedNodes: [] });
      }
      this.caption.textContent = step.caption;
      await sleep(2300);
      if (gen !== this.gen) return false;
    }
    this.introDone = true;
    this.game = new Game();
    this.board.setGame(this.game);
    return true;
  }

  async loop(gen) {
    if (!this.introDone && !(await this.intro(gen))) return;
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
