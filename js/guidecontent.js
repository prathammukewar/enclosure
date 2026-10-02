// Strategy guide chapters. Every diagram and task here is checked by the
// tests (test/test.mjs), so the claims in the text hold for these positions.
import { BLUE, RED, Game, formatArea } from './engine.js';
import { analyzeArea } from './geometry.js';
import { canBreak, distToSeg } from './ai.js';

const segs = (g, p) => g.edgesOf(p).map((e) => [e.ax, e.ay, e.bx, e.by]);

// Blue walls with area behind them that Red could break next turn, ignoring
// protection (it runs out a turn later anyway).
export function breakableBlueWalls(g) {
  const base = {
    rules: { ...g.rules, protect: false },
    edges: [...g.edges.values()].map((e) => [e.owner, e.ax, e.ay, e.bx, e.by, 0]),
    turn: 4, player: RED, left: 2,
  };
  const h = new Game(base);
  const blue = h.edgesOf(BLUE);
  const an = analyzeArea(blue.map((e) => [e.ax, e.ay, e.bx, e.by]), true);
  const red = h.nodesOf(RED);
  return blue.filter((e, i) => an.loss[i] > 1e-9 && canBreak(h, e, red));
}

export const CHAPTERS = [
  {
    id: 'income',
    title: 'Area pays every turn',
    body: `<p>Both players add the area they hold to their score after every turn, 61 times in a standard game. So the same pen is worth very different amounts depending on when you build it. Ten area fenced in by turn 10 earns about 500 points by the end. Ten area fenced in on turn 50 earns about 100.</p>
      <p>Cuts work the same way in reverse. Opening 10 of your opponent's area on turn 20 takes about 400 points away from them, unless they rebuild it. Late in the game the same cut is worth much less.</p>
      <p>The line under the progress bar on the play screen shows where the scores are heading if nobody's area changes. It's a quick way to see who is really ahead, since the current score lags behind.</p>`,
    diagrams: [],
    tasks: [],
  },
  {
    id: 'reach',
    title: 'Reach and safe ground',
    body: `<p>An enemy edge has to start at one of their nodes and can only reach 3 points in each direction. A wall more than 3 points from every enemy node can't be cut with a single edge.</p>
      <p>With two edges per turn, though, your opponent can place an approach edge first and cut with the second. So walls within about 6 points of their nodes are in danger every turn, and walls further away are safe for at least a turn.</p>
      <p>Turn on <b>Reach</b> on the play screen to see every point each side can touch with one edge.</p>`,
    diagrams: [
      {
        caption: "Shaded points are where each side can reach with one edge. The blue triangle at the top is in Red's reach. The one at the bottom isn't.",
        base: { edges: [[BLUE, 0, 9, 3, 9], [BLUE, 3, 5, 6, 5], [BLUE, 6, 5, 4, 7], [BLUE, 4, 7, 3, 5], [BLUE, 1, 13, 3, 13], [BLUE, 3, 13, 1, 15], [BLUE, 1, 15, 1, 13], [RED, 9, 4, 11, 4], [RED, 9, 4, 9, 7]], turn: 3 },
        crop: [0, 2, 12, 16], overlay: 'reach',
      },
    ],
    tasks: [
      {
        text: 'Fence in some area with every wall more than 3 points from all of Red\'s nodes.',
        base: { edges: [[BLUE, 0, 9, 3, 9], [RED, 7, 8, 9, 10], [RED, 9, 10, 11, 10]], turn: 3 },
        crop: [0, 4, 12, 14],
        check: (g) => {
          if (!(g.areas[BLUE] > 0)) return false;
          const an = analyzeArea(segs(g, BLUE), true);
          const red = g.nodesOf(RED);
          return g.edgesOf(BLUE).every((e, i) => an.loss[i] <= 1e-9 || red.every(([x, y]) => distToSeg(x, y, e) > 3));
        },
        done: 'Safe for now. Red needs an approach edge before it can touch these walls.',
      },
    ],
  },
  {
    id: 'cells',
    title: 'Cells limit the damage',
    body: `<p>Breaking a wall only opens the space directly behind it. If a wall sits between two of your cells, breaking it costs you nothing, because the merged space is still fenced in. If it's an outside wall, you lose only the cell behind it.</p>
      <p>So one big pen is fragile: any outside wall opens all of it. The same pen split into cells loses only a piece per break. Splitting costs edges, but it's often worth one edge to protect half a pen.</p>`,
    diagrams: [
      {
        caption: 'Red can break the top wall, but only the triangle behind it opens. The other triangle still counts.',
        base: { edges: [[BLUE, 2, 3, 5, 3], [BLUE, 5, 3, 5, 6], [BLUE, 5, 6, 2, 6], [BLUE, 2, 6, 2, 3], [BLUE, 2, 3, 5, 6], [RED, 4, 1, 7, 1]], turn: 4 },
        crop: [0, 0, 8, 8], select: [4, 1], hover: [4, 4],
      },
    ],
    tasks: [
      {
        text: 'Split this pen so that no single outside wall can open more than half of it.',
        base: { edges: [[BLUE, 3, 4, 6, 4], [BLUE, 6, 4, 6, 7], [BLUE, 6, 7, 3, 7], [BLUE, 3, 7, 3, 4], [RED, 9, 2, 10, 4]], turn: 3 },
        crop: [0, 1, 11, 10],
        check: (g) => {
          if (g.areas[BLUE] < 9 - 1e-9) return false;
          const an = analyzeArea(segs(g, BLUE), true);
          return Math.max(...an.loss) <= 4.5 + 1e-9;
        },
        done: 'Now any single break costs at most half the pen.',
      },
    ],
  },
  {
    id: 'timing',
    title: 'Close loops in one turn',
    body: `<p>Edges you place this turn are protected on your opponent's next turn. If you close a loop using both edges of a turn, only the older walls of that loop can be hit right away.</p>
      <p>That's why a loop that needs two more edges is often better closed all at once than one edge now and one later. Half-built loops give your opponent a turn to cut the chain before it closes.</p>`,
    diagrams: [
      {
        caption: 'Blue closed this triangle with two new edges, which have light centers. On Red\'s turn they are protected, so Red can only go after the old top wall.',
        base: { edges: [[BLUE, 2, 5, 5, 5], [BLUE, 5, 5, 4, 8, 4], [BLUE, 4, 8, 2, 5, 4], [RED, 7, 6, 9, 6]], turn: 4 },
        crop: [0, 2, 10, 10], select: [7, 6], hover: [4, 7],
      },
    ],
    tasks: [
      {
        text: 'Close a loop with both of your edges this turn.',
        base: { edges: [[BLUE, 2, 10, 4, 7], [BLUE, 4, 7, 7, 7], [BLUE, 7, 7, 8, 10], [RED, 12, 8, 14, 8]], turn: 3 },
        crop: [0, 4, 15, 13],
        check: (g) => g.player === RED && g.areas[BLUE] > 0,
        done: 'Both new walls are protected next turn. Only the three older walls are exposed.',
      },
    ],
  },
  {
    id: 'sealed',
    title: 'Cells that can never be broken',
    body: `<p>This one follows straight from the rules. An attacking edge must touch exactly one of your edges, and its end has to land on a grid point.</p>
      <p>Take a cell with no grid points inside it and none in the middle of its walls, like a triangle across half a grid square or a single grid square. An enemy edge that crosses into it has nowhere to stop. It has to leave through a second wall, or end on a corner where two of your walls meet. Either way it touches two of your edges, which isn't allowed. So a wall around such a cell can't be broken at all, as long as its corners each join two or more of your walls.</p>
      <p>These cells hold only half a square or a square each, so they're slow to build. They're worth it next to your opponent, or to guard the heart of a big pen.</p>`,
    diagrams: [
      {
        caption: 'Four half-square triangles. Every way in for Red touches two blue edges, so this edge is refused, and so is every other one.',
        base: { edges: [[BLUE, 3, 4, 4, 4], [BLUE, 4, 4, 4, 5], [BLUE, 4, 5, 3, 5], [BLUE, 3, 5, 3, 4], [BLUE, 3, 4, 4, 5], [BLUE, 4, 4, 5, 4], [BLUE, 5, 4, 5, 5], [BLUE, 5, 5, 4, 5], [BLUE, 4, 4, 5, 5], [RED, 2, 2, 5, 2]], turn: 4 },
        crop: [0, 0, 8, 7], select: [5, 2], hover: [4, 5],
      },
    ],
    tasks: [
      {
        text: 'Fence in area that Red can never break: a cell with no grid points inside it or in the middle of its walls.',
        base: { edges: [[BLUE, 0, 9, 3, 9], [BLUE, 3, 9, 4, 9], [BLUE, 4, 9, 4, 8], [RED, 6, 6, 7, 7]], turn: 3 },
        crop: [0, 4, 10, 13],
        check: (g) => g.player === RED && g.areas[BLUE] > 0 && breakableBlueWalls(g).length === 0,
        retry: (g) => (g.player === RED && g.areas[BLUE] > 0 ? 'That fences in area, but Red could still break a wall. Try a smaller cell.' : null),
        done: 'Sealed. No legal red edge can break these walls, now or later.',
      },
    ],
  },
  {
    id: 'attack',
    title: 'Approach, then cut',
    body: `<p>With two edges a turn, an attack usually takes both: the first edge gets within reach of a wall, and the second one cuts it. Before you cut, check three things.</p>
      <p>First, how much area is behind the wall. Outside walls of big cells are the best targets. Second, whether the wall is new: walls placed on your opponent's last turn are protected. Third, whether your edge would touch a second enemy edge, which isn't allowed.</p>
      <p>A cut also leaves your node inside their territory, which makes the next cut easier.</p>`,
    diagrams: [],
    tasks: [
      {
        text: 'Open as much of Red\'s area as you can this turn. The best is 9.',
        base: { edges: [[BLUE, 1, 8, 4, 8], [RED, 9, 5, 12, 5], [RED, 12, 5, 12, 8], [RED, 12, 8, 9, 8], [RED, 9, 8, 9, 5], [RED, 12, 8, 15, 8]], turn: 3 },
        crop: [0, 2, 16, 11],
        target: 9,
        check: (g, e, start) => g.player === RED && start.areas[RED] - g.areas[RED] >= 9 - 1e-9,
        retry: (g, e, start) => (g.player === RED ? `That opens ${formatArea(start.areas[RED] - g.areas[RED])}. Start over and try for 9.` : null),
        done: 'The whole square opens. Your second edge is now sitting inside it.',
      },
    ],
  },
  {
    id: 'crossing',
    title: 'Crossing your own edges',
    body: `<p>Your edges can cross each other, and a loop made by a crossing counts like any other. Sometimes that's the quickest way to fence something in: an edge that crosses one of your own edges can close a loop without ending on a node.</p>
      <p>It's also useful when the obvious closing point sits in the middle of your own edge, where you can't end an edge.</p>`,
    diagrams: [],
    tasks: [
      {
        text: 'Fence in area with an edge that crosses one of your own edges.',
        base: { edges: [[BLUE, 4, 4, 3, 6], [BLUE, 4, 4, 5, 6], [BLUE, 3, 6, 5, 8], [RED, 12, 5, 14, 5]], turn: 3 },
        crop: [0, 2, 10, 10],
        check: (g, e, start, r) => !!(r && r.crosses) && g.areas[BLUE] > start.areas[BLUE],
        done: 'The crossing point became a corner of your new cell.',
      },
    ],
  },
  {
    id: 'endgame',
    title: 'The endgame',
    body: `<p>Near the end, count score updates rather than area. With 4 updates left, a new 10-area pen earns 40 points, and a cut that opens 10 of your opponent's area saves you 40. Whichever is bigger right now is the better turn.</p>
      <p>Blue's very last turn is a single edge, placed after Red's last two. Nothing can answer it, so Blue's last edge should take whatever swing is biggest, cut or build. Red's last turn, on the other hand, can be answered by that one blue edge, so Red should prefer moves Blue can't undo with a single edge.</p>`,
    diagrams: [],
    tasks: [],
  },
];
