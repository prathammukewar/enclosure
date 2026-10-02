// Small static boards that illustrate the rules.
import { Game, BLUE, RED } from './engine.js';
import { Board } from './board.js';

// Each diagram: a position, the part of the board to show, and optionally a
// selected node with a hovered target so the board draws its preview.
export const DIAGRAMS = {
  start: { base: null, crop: [0, 3, 18, 15] },
  grow: {
    base: { edges: [[BLUE, 0, 9, 3, 9], [BLUE, 3, 9, 5, 7]], turn: 3 },
    crop: [0, 3, 10, 11], select: [5, 7],
  },
  reach: {
    base: { edges: [[BLUE, 0, 9, 3, 9], [BLUE, 3, 9, 5, 7]], turn: 3 },
    crop: [0, 3, 10, 11], select: [5, 7], hover: [8, 4],
  },
  cut: {
    base: { edges: [[BLUE, 1, 7, 4, 7], [RED, 8, 5, 5, 8], [RED, 8, 5, 11, 5]], turn: 3 },
    crop: [1, 3, 11, 10], select: [4, 7], hover: [6, 8],
  },
  break: {
    base: { edges: [[BLUE, 1, 7, 4, 7], [RED, 8, 5, 5, 8], [RED, 8, 5, 11, 5]], turn: 3 },
    crop: [1, 3, 11, 10], select: [4, 7], hover: [6, 8],
  },
  enclose: {
    base: { edges: [[BLUE, 2, 6, 3, 5], [BLUE, 3, 5, 6, 4], [BLUE, 6, 4, 7, 6], [BLUE, 7, 6, 5, 9], [BLUE, 5, 9, 2, 9], [BLUE, 2, 9, 2, 6], [BLUE, 7, 6, 9, 6]], turn: 3 },
    crop: [1, 3, 10, 10],
  },
  shield: {
    base: { edges: [[BLUE, 5, 6, 7, 6], [RED, 9, 4, 9, 8, 3], [RED, 9, 8, 11, 9]], turn: 3 },
    crop: [4, 3, 13, 10], select: [7, 6], hover: [9, 7],
  },
  area: {
    base: {
      edges: [
        [BLUE, 1, 6, 2, 5], [BLUE, 2, 5, 5, 4], [BLUE, 5, 4, 6, 6], [BLUE, 6, 6, 4, 9], [BLUE, 4, 9, 1, 9], [BLUE, 1, 9, 1, 6],
        [RED, 11, 9, 12, 6], [RED, 12, 6, 15, 9], [RED, 15, 9, 14, 11], [RED, 14, 11, 11, 9], [RED, 15, 9, 17, 9],
      ],
      turn: 3,
    },
    crop: [0, 3, 18, 12],
  },
};

export function drawDiagram(el, name) {
  const d = DIAGRAMS[name];
  if (!d) return null;
  const board = new Board(el, { interactive: false, coords: false, crop: d.crop, labels: true, animate: false });
  const g = new Game(d.base);
  board.setGame(g);
  if (d.select) {
    // Show the reach (and a preview) without making the diagram clickable.
    board.canMove = true;
    board.selected = d.select;
    board.hover = d.hover || null;
    board.render();
  }
  return board;
}

export function drawAllDiagrams(root = document) {
  for (const el of root.querySelectorAll('[data-diagram]')) {
    if (el.dataset.drawn) continue;
    drawDiagram(el, el.dataset.diagram);
    el.dataset.drawn = '1';
  }
}
