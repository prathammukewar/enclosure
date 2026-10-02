// Run with: node test/test.mjs
import { analyzeArea, segmentsTouch, pointOnSegment } from '../js/geometry.js';
import {
  Game, BLUE, RED, N, TOTAL_EDGES, encodeHistory, decodeHistory, moveName, updatesAfter, formatArea,
  makeRules, encodeRules, decodeRules, encodePosition, decodePosition, startEdges,
} from '../js/engine.js';
import { LESSONS } from '../js/lessons.js';
import { DIAGRAMS } from '../js/diagrams.js';
import { planTurn, coachMarks } from '../js/ai.js';
import { PUZZLES } from '../js/puzzledata.js';
import { CHAPTERS, breakableBlueWalls } from '../js/guidecontent.js';
import { validateEdges } from '../js/analysis.js';
import { canBreak as aiCanBreak } from '../js/ai.js';
import { pairRound } from '../js/tournament.js';
import { encodeGif } from '../js/export.js';
import { INTRO } from '../js/demo.js';

let passed = 0, failed = 0;
const only = process.argv[2];
function test(name, fn) {
  if (only && !name.includes(only)) return;
  try { fn(); passed++; }
  catch (e) { failed++; console.log('FAIL', name, '\n   ', e.stack.split('\n').slice(0, 3).join('\n    ')); }
}
function eq(a, b, msg = '') {
  if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function near(a, b, eps = 1e-6, msg = '') {
  if (Math.abs(a - b) > eps) throw new Error(`${msg} expected ${b}, got ${a}`);
}
function ok(c, msg = 'assertion failed') { if (!c) throw new Error(msg); }

const poly = (pts) => pts.map((p, i) => [...p, ...pts[(i + 1) % pts.length]]);

// ---------------------------------------------------------------- geometry

test('video hexagon has area 18', () => {
  eq(analyzeArea(poly([[0, 2], [1, 1], [4, 0], [5, 2], [3, 5], [0, 5]])).area, 18);
});

test('video red quadrilateral has area 10, dangling edges add nothing', () => {
  const segs = poly([[11, 9], [12, 6], [15, 9], [14, 11]]);
  segs.push([15, 9, 18, 9], [12, 6, 13, 4], [11, 9, 8, 8]);
  eq(analyzeArea(segs).area, 10);
});

test('a tree encloses nothing', () => {
  eq(analyzeArea([[0, 0, 3, 0], [3, 0, 5, 2], [3, 0, 3, 3]]).area, 0);
});

test('triangle inside a quadrilateral counts once (FAQ)', () => {
  const quad = poly([[3, 0], [6, 3], [3, 6], [0, 3]]);
  const tri = poly([[3, 2], [4, 4], [2, 4]]);
  eq(analyzeArea([...quad, ...tri]).area, 18);
  // Connected to the outside by a bridge it still counts once.
  eq(analyzeArea([...quad, ...tri, [3, 0, 3, 2]]).area, 18);
});

test('crossing own edges enclose area (FAQ)', () => {
  // Top (1,0), sides (0,2) and (2,2), legs crossing at (1,3).
  const segs = [[1, 0, 0, 2], [1, 0, 2, 2], [0, 2, 2, 4], [2, 2, 0, 4]];
  eq(analyzeArea(segs).area, 3);
});

test('bowtie counts both triangles', () => {
  eq(analyzeArea(poly([[0, 0], [2, 2], [2, 0], [0, 2]])).area, 2);
});

test('two cells sharing a wall add up', () => {
  const segs = [[0, 0, 2, 0], [2, 0, 4, 0], [4, 0, 4, 2], [4, 2, 2, 2], [2, 2, 0, 2], [0, 2, 0, 0], [2, 0, 2, 2]];
  const r = analyzeArea(segs, true);
  eq(r.area, 8);
  eq(r.faces.length, 2);
  eq(r.loss[6], 0, 'inner wall');
  eq(r.loss[0], 4, 'outer wall');
});

test('disjoint and nested squares', () => {
  const a = poly([[0, 0], [3, 0], [3, 3], [0, 3]]);
  const b = poly([[5, 5], [7, 5], [7, 7], [5, 7]]);
  eq(analyzeArea([...a, ...b]).area, 13);
  const big = poly([[0, 0], [6, 0], [6, 6], [0, 6]]);
  const small = poly([[2, 2], [4, 2], [4, 4], [2, 4]]);
  eq(analyzeArea([...big, ...small]).area, 36);
});

test('fractional areas from crossings', () => {
  // Diagonals of a 3x1 rectangle crossing at (1.5, 0.5).
  const segs = [[0, 0, 3, 1], [0, 1, 3, 0], [0, 0, 0, 1]];
  near(analyzeArea(segs).area, 0.75);
});

test('segment contact cases', () => {
  ok(segmentsTouch(0, 0, 2, 2, 0, 2, 2, 0), 'cross');
  ok(segmentsTouch(0, 0, 2, 2, 1, 1, 3, 0), 'endpoint on interior');
  ok(segmentsTouch(0, 0, 2, 0, 2, 0, 3, 3), 'shared endpoint');
  ok(segmentsTouch(0, 0, 3, 0, 1, 0, 5, 0), 'collinear overlap');
  ok(!segmentsTouch(0, 0, 3, 0, 4, 0, 5, 0), 'collinear apart');
  ok(!segmentsTouch(0, 0, 3, 1, 0, 1, 3, 2), 'parallel');
  ok(!segmentsTouch(0, 0, 1, 2, 1, 0, 2, 2), 'near miss');
  ok(pointOnSegment(0, 0, 3, 3, 2, 2) && !pointOnSegment(0, 0, 3, 3, 2, 1), 'point on segment');
});

// ------------------------------------------------------------------ engine

test('start position and first turn', () => {
  const g = new Game();
  eq(g.player, BLUE); eq(g.left, 1); eq(g.placed, 0); eq(g.turn, 1);
  ok(g.hasNode(BLUE, 0, 9) && g.hasNode(BLUE, 3, 9) && g.hasNode(RED, 15, 9) && g.hasNode(RED, 18, 9));
  eq(g.edges.size, 2);
  eq(updatesAfter(0), 61);
});

test('turn order is 1, 2, 2, ..., 2, 1 with 61 score updates', () => {
  const g = new Game();
  const owners = [];
  while (!g.over) { owners.push(g.player); g.pass(); }
  eq(owners.length, TOTAL_EDGES);
  eq(owners[0], BLUE); eq(owners[1], RED); eq(owners[2], RED); eq(owners[3], BLUE); eq(owners[4], BLUE);
  eq(owners[117], RED); eq(owners[118], RED); eq(owners[119], BLUE);
  eq(owners.filter((o) => o === BLUE).length, 60);
  eq(g.timeline.length, 61);
  eq(g.timeline.map((t) => t.placed).join(','), [1, ...Array.from({ length: 59 }, (_, i) => 3 + 2 * i), 120].join(','));
});

test('radius is a 7x7 square around the node', () => {
  const g = new Game();
  ok(g.check(3, 9, 6, 12).ok, '(3,3) offset');
  ok(g.check(3, 9, 6, 6).ok, '(3,-3) offset');
  ok(g.check(3, 9, 4, 12).ok, 'knight-like (1,3)');
  eq(g.check(3, 9, 7, 9).code, 'range');
  eq(g.check(3, 9, 3, 13).code, 'range');
  eq(g.check(0, 9, -1, 9).code, 'board');
  eq(g.check(5, 5, 6, 6).code, 'notyours');
  eq(g.check(15, 9, 14, 9).code, 'notyours', 'red node on blue turn');
  eq(g.legalMoves().length, 69, '24 from (0,9) and 45 from (3,9)');
});

test('breaking by crossing, and the leftover node disappears', () => {
  const g = new Game({ edges: [[BLUE, 2, 2, 4, 4], [RED, 7, 2, 4, 5], [RED, 7, 2, 9, 2]], turn: 3 });
  eq(g.check(4, 4, 3, 3).code, 'onown', '(3,3) lies on the blue edge');
  const r = g.check(4, 4, 4, 2);
  ok(r.ok && !r.breaks, 'moving away touches nothing');
  const c = g.check(4, 4, 5, 5);
  ok(c.ok && c.breaks && c.breaks.ax === 7 && c.breaks.bx === 4, 'crosses the red diagonal at (4.5, 4.5)');
  g.play(4, 4, 5, 5);
  ok(!g.hasNode(RED, 4, 5), 'leftover node removed');
  ok(g.hasNode(RED, 7, 2), 'node with another edge stays');
  eq(g.edgesOf(RED).length, 1);
});

test('touching counts: ending on an edge, or on a lone node', () => {
  // Red diagonal (8,2)-(5,5) passes through lattice points (7,3) and (6,4).
  const base = { edges: [[BLUE, 6, 2, 6, 1], [RED, 8, 2, 5, 5], [RED, 8, 2, 10, 2]], turn: 3 };
  let g = new Game(base);
  let r = g.check(6, 2, 7, 3);
  ok(r.ok && r.breaks, 'end on the edge');
  g = new Game(base);
  r = g.check(6, 2, 5, 5);
  ok(r.ok && r.breaks, 'end on the lone red node');
  g.play(6, 2, 5, 5);
  ok(!g.hasNode(RED, 5, 5) && g.hasNode(BLUE, 5, 5));
  g = new Game(base);
  eq(g.check(6, 2, 8, 2).code, 'double', 'red node with two edges');
  ok(g.check(6, 2, 9, 3).breaks, 'crosses only the diagonal');
  // Passing just under a red node crosses both of its edges.
  const h = new Game({ edges: [[BLUE, 6, 3, 5, 3], [RED, 8, 2, 6, 4], [RED, 8, 2, 10, 4]], turn: 3 });
  eq(h.check(6, 3, 9, 2).code, 'double', 'passes under the red node');
});

test('cannot break two edges, or a protected edge', () => {
  const g = new Game({ edges: [[BLUE, 2, 5, 3, 5], [RED, 4, 3, 4, 7], [RED, 5, 3, 5, 7], [RED, 4, 3, 5, 3]], turn: 3 });
  eq(g.check(3, 5, 6, 5).code, 'double');
  ok(g.check(3, 5, 4, 6).ok);
  const h = new Game({ edges: [[BLUE, 2, 5, 3, 5], [RED, 4, 3, 4, 7, 3], [RED, 4, 3, 6, 3]], turn: 3 });
  eq(h.check(3, 5, 5, 5).code, 'shielded');
  ok(h.check(3, 5, 5, 2).ok === true || h.check(3, 5, 5, 2).code !== 'shielded');
});

test('protection lasts exactly one opposing turn', () => {
  const g = new Game({ edges: [[BLUE, 2, 5, 3, 5], [BLUE, 2, 5, 1, 5], [RED, 6, 2, 6, 8]], turn: 2 });
  g.play(6, 8, 5, 8); // red, turn 2
  g.play(6, 2, 7, 2);
  eq(g.player, BLUE);
  eq(g.check(3, 5, 5, 8).code, 'shielded', "red's new edge is protected on blue's turn");
  g.play(3, 5, 3, 6); g.play(2, 5, 2, 6); // blue turn ends
  g.play(7, 2, 8, 2); g.play(8, 2, 9, 2); // red turn ends
  eq(g.player, BLUE);
  ok(g.check(3, 6, 5, 8).ok, 'old edge can be broken now');
});

test('own edge rules: no node on own edge, no edge through own node, no duplicates', () => {
  const g = new Game({ edges: [[BLUE, 3, 5, 6, 5], [BLUE, 3, 5, 4, 7], [BLUE, 4, 7, 4, 4]], turn: 3 });
  eq(g.check(4, 7, 5, 5).code, 'onown', 'ending on (5,5) which lies on blue (3,5)-(6,5)');
  eq(g.check(4, 4, 4, 6).code, 'onown', 'ends on (4,6), inside the blue edge (4,7)-(4,4)');
  eq(g.check(3, 5, 0, 5).ok, true);
  const h = new Game({ edges: [[BLUE, 3, 5, 4, 5], [BLUE, 3, 5, 3, 7], [BLUE, 3, 7, 5, 7]], turn: 3 });
  eq(h.check(3, 5, 6, 5).code, 'throughown', '(4,5) is a blue node');
  eq(h.check(3, 7, 3, 4).code, 'throughown', 'runs along its own edge through the node (3,5)');
  ok(h.check(5, 7, 3, 5).ok, 'closing the triangle is fine');
  eq(h.check(3, 5, 3, 7).code, 'dup');
});

test('connecting own nodes closes area; crossing own edges is allowed', () => {
  const g = new Game({ edges: [[BLUE, 2, 2, 5, 2], [BLUE, 5, 2, 5, 5]], turn: 3 });
  const r = g.check(5, 5, 2, 2);
  ok(r.ok && r.closes);
  g.play(5, 5, 2, 2);
  eq(g.areas[BLUE], 4.5);
  g.play(2, 2, 2, 5); // second edge of the turn; area unchanged
  eq(g.areas[BLUE], 4.5);
  eq(g.scores[BLUE], 4.5, 'score update at the end of the turn');
  const h = new Game({ edges: [[BLUE, 0, 0, 2, 2], [BLUE, 2, 2, 2, 0], [BLUE, 0, 2, 0, 3]], turn: 3 });
  const c = h.check(2, 0, 0, 2);
  ok(c.ok && c.closes, 'crossing own diagonal');
  h.play(2, 0, 0, 2);
  eq(h.areas[BLUE], 1, 'triangle (1,1),(2,2),(2,0)');
});

test('score updates use the areas at the end of each turn', () => {
  // Video example: blue makes 18, red already has 10 then 20.
  const g = new Game({
    edges: [
      [BLUE, 0, 2, 1, 1], [BLUE, 1, 1, 4, 0], [BLUE, 4, 0, 5, 2], [BLUE, 5, 2, 3, 5], [BLUE, 3, 5, 0, 5],
      [RED, 11, 9, 12, 6], [RED, 12, 6, 15, 9], [RED, 15, 9, 14, 11], [RED, 14, 11, 11, 9],
    ],
    turn: 15, scores: [0, 70],
  });
  eq(g.player, BLUE);
  g.play(0, 5, 0, 2); // closes the hexagon
  g.play(0, 5, 0, 7);
  eq(g.scores.join(), '18,80');
  g.play(15, 9, 16, 12);
  g.play(16, 12, 14, 11); // red closes the triangle (15,9),(16,12),(14,11) of area 2.5
  eq(g.areas[RED], 12.5);
  eq(g.scores.join(), '36,92.5');
});

test('timeout skips the rest of the turn and removes protection', () => {
  const g = new Game();
  g.play(3, 9, 5, 9);
  eq(g.player, RED);
  g.play(15, 9, 13, 9);
  g.timeout();
  eq(g.player, BLUE); eq(g.placed, 3);
  const e = g.edgesOf(RED).find((x) => x.ax === 15 && x.bx === 13);
  ok(e && !g.isShielded(e), 'red edge from the timed-out turn is not protected');
  eq(decodeHistory(encodeHistory(g.history)).length, 3);
});

test('no legal moves can be passed; resign ends the game', () => {
  const g = new Game();
  g.pass();
  eq(g.player, RED);
  g.resign(RED);
  ok(g.over); eq(g.winner(), BLUE);
});

test('notation and encoding round trip', () => {
  const g = new Game();
  const r = g.play(3, 9, 5, 10);
  eq(moveName(r), 'd10-f9');
  const code = encodeHistory([{ kind: 'edge', fx: 3, fy: 9, tx: 5, ty: 10 }, { kind: 'pass' }, { kind: 'timeout' }, { kind: 'resign', player: 1 }]);
  const back = decodeHistory(code);
  eq(JSON.stringify(back), JSON.stringify([{ kind: 'edge', fx: 3, fy: 9, tx: 5, ty: 10 }, { kind: 'pass' }, { kind: 'timeout' }, { kind: 'resign', player: 1 }]));
  eq(formatArea(18), '18'); eq(formatArea(0.75), '0.75'); eq(formatArea(2.5), '2.5'); eq(formatArea(10 / 3), '3.33');
});

// ------------------------------------------------------------ rule variants

test('old game links replay to the same result', () => {
  const code = 'CDoCOeBkRCu_Cw6CPKC8ZCFpCILC8rCPHCHhBaPC6EBkMCxjCvTC6YCNkDb1CydC4gDlyCyaBaSC6pDXoBaHCHrC4WDVYCymCXnCPEC34BrLCZHDU7CNUCYICovC3-CnJCb6CowCZ0DVECYJCbjCOoCqwCqhCpLCrMCZUCo_CqQC4WCq6CbdCbhC4MCOfCIDByKDEFDEBCqhCpDCQuCaMCcQCYJC4TBkODFOCpGCrLDU_CZFDR5C3ADVECYWDR3CNjCM-DF7CqhCaXC4TDSFDG0CoQDU9CcVDW7B-TCaHDxLCYWDU7DVYDEzDR4CM-CagDFTDWLDlsCoMCH7DR_CZqCraCJeCL3B-FCOUDV3';
  const g = Game.fromHistory(decodeHistory(code));
  ok(g.over);
  eq(g.scores.map(Math.round).join(), '2439,1765');
  eq(encodeHistory(g.history), code);
  eq(encodeRules(g.rules), '');
});

test('rules: defaults, validation and round trip', () => {
  const d = makeRules();
  eq(d.size, 19); eq(d.radius, 3); eq(d.players, 2); eq(d.perPlayer, 60); eq(d.protect, true); eq(d.border, false);
  eq(makeRules({ size: 14 }).size, 15, 'sizes are odd');
  eq(makeRules({ players: 3, teams: true }).teams, false, 'teams need four players');
  const r = { size: 13, radius: 4, players: 4, teams: true, perPlayer: 25, protect: false, border: true, timeout: 'edge', stuck: 'turn', handicap: [0, 2, 0, 1] };
  const back = decodeRules(encodeRules(r));
  eq(JSON.stringify(back), JSON.stringify(makeRules(r)));
  eq(encodeRules({}), '');
});

test('start edges for every board and player count', () => {
  eq(JSON.stringify(startEdges(makeRules())), JSON.stringify([[0, 0, 9, 3, 9], [1, 15, 9, 18, 9]]));
  eq(JSON.stringify(startEdges(makeRules({ size: 13, players: 4 }))), JSON.stringify([[0, 0, 6, 3, 6], [1, 9, 6, 12, 6], [2, 6, 0, 6, 3], [3, 6, 9, 6, 12]]));
});

test('reach follows the radius rule', () => {
  const g2 = new Game(null, { radius: 2 });
  ok(g2.check(3, 9, 5, 11).ok); eq(g2.check(3, 9, 6, 9).code, 'range');
  ok(g2.check(3, 9, 6, 9).reason.includes('2 points'));
  const g4 = new Game(null, { radius: 4 });
  ok(g4.check(3, 9, 7, 13).ok); eq(g4.check(3, 9, 8, 9).code, 'range');
});

test('three and four players take turns in order and each places the same number of edges', () => {
  for (const players of [3, 4]) {
    const g = new Game(null, { players, perPlayer: 10 });
    const counts = new Array(players).fill(0);
    const order = [];
    while (!g.over) { if (order[order.length - 1] !== g.player) order.push(g.player); counts[g.player]++; g.pass(); }
    eq(counts.join(), new Array(players).fill(10).join(), `${players} players`);
    eq(order.slice(0, players + 1).join(), [...Array(players).keys(), 0].join());
    eq(g.timeline.length, g.updatesLeft() + g.timeline.length, 'no updates left');
  }
  const g = new Game(null, { players: 3, perPlayer: 10 });
  eq(g.updatesLeft(), 16, 'turns for 3 x 10 edges: 1 + 14 twos + 1');
});

test('teams: teammates cannot touch, team scores add up', () => {
  const g = new Game({ edges: [[0, 2, 2, 4, 2], [2, 6, 0, 6, 4], [1, 9, 9, 9, 12], [3, 12, 12, 14, 12]], turn: 5, rules: { players: 4, teams: true } });
  eq(g.player, 0);
  eq(g.check(4, 2, 6, 2).code, 'ally', 'ends on a teammate edge');
  ok(g.isEnemy(0, 1) && g.isAlly(0, 2) && !g.isEnemy(0, 2));
  const h = new Game({ edges: [[0, 0, 0, 3, 0], [0, 3, 0, 3, 3], [2, 10, 10, 13, 10], [2, 13, 10, 13, 13], [2, 13, 13, 10, 10], [1, 17, 17, 18, 18]], turn: 5, rules: { players: 4, teams: true } });
  eq(h.sideAreas().join(), '4.5,0');
  h.play(3, 3, 0, 0);
  eq(h.areas[0], 4.5);
  eq(h.sideAreas().join(), '9,0');
});

test('protection can be switched off', () => {
  const base = { edges: [[BLUE, 2, 5, 3, 5], [RED, 4, 3, 4, 7, 3], [RED, 4, 3, 6, 3]], turn: 3 };
  eq(new Game(base).check(3, 5, 5, 5).code, 'shielded');
  ok(new Game({ ...base, rules: { protect: false } }).check(3, 5, 5, 5).ok);
});

test('protection lasts until the owner moves again with four players', () => {
  const g = new Game(null, { players: 4, perPlayer: 12 });
  g.play(3, 9, 5, 9); // p0, turn 1
  const e = [...g.edges.values()].find((x) => x.ax === 3 && x.bx === 5);
  for (let p = 1; p <= 3; p++) { eq(g.player, p); ok(g.isShielded(e), `protected on player ${p}'s turn`); g.pass(); g.pass(); }
  eq(g.player, 0);
  g.pass(); g.pass();
  eq(g.player, 1);
  ok(!g.isShielded(e), 'not after the owner moved again');
});

test('border walls: the board edge closes area, the largest region stays outside', () => {
  const g = new Game({ edges: [[BLUE, 0, 9, 3, 9], [BLUE, 3, 9, 3, 12], [RED, 15, 9, 18, 9]], turn: 3, rules: { border: true } });
  eq(g.areas[BLUE], 0);
  const r = g.check(3, 12, 0, 12);
  ok(r.ok && r.closes);
  g.play(3, 12, 0, 12);
  eq(g.areas[BLUE], 9, 'square against the left side');
  near(oracleArea(g.edgesOf(BLUE).map((e) => [e.ax, e.ay, e.bx, e.by]), 19), 9);
  near(analyzeArea([[0, 4, 3, 4], [3, 4, 6, 4], [6, 4, 9, 4], [9, 4, 12, 4], [12, 4, 15, 4], [15, 4, 18, 4]], false, 19).area, 72, 'a wall across the board keeps the smaller side');
  near(oracleArea([[0, 4, 3, 4], [3, 4, 6, 4], [6, 4, 9, 4], [9, 4, 12, 4], [12, 4, 15, 4], [15, 4, 18, 4]], 19), 72);
});

test('timeout per edge and skipping a whole turn when stuck', () => {
  const g = new Game(null, { timeout: 'edge' });
  g.pass();
  g.play(15, 9, 13, 9);
  g.timeout();
  eq(g.player, BLUE, 'second red edge skipped');
  const e = g.edgesOf(RED).find((x) => x.bx === 13 || x.ax === 13);
  ok(g.isShielded(e), 'per-edge timeout keeps protection');
  const h = new Game(null, { stuck: 'turn' });
  h.pass();
  eq(h.player, RED);
  h.pass();
  eq(h.player, BLUE, 'a stuck pass skips the rest of the turn');
  eq(h.placed, 3);
});

test('handicap edges come in the first turn', () => {
  const g = new Game(null, { handicap: [0, 2] });
  eq(g.left, 1);
  g.pass();
  eq(g.player, RED); eq(g.left, 4);
  eq(g.totalEdges, 122);
  const h = new Game(null, { handicap: [2, 0] });
  eq(h.left, 3);
});

test('positions round trip through their code, keeping protection', () => {
  const g = new Game(null, { players: 3, perPlayer: 20 });
  g.play(3, 9, 5, 7); g.play(15, 9, 13, 7); g.play(13, 7, 12, 9); g.play(9, 3, 11, 4); g.play(11, 4, 12, 2);
  g.play(5, 7, 6, 5);
  const code = encodePosition(g);
  const h = new Game(decodePosition(code));
  eq(h.player, g.player); eq(h.turn, g.turn); eq(h.left, g.left);
  eq(h.edges.size, g.edges.size);
  eq(h.areas.join(), g.areas.join());
  for (const e of g.edges.values()) {
    const f = [...h.edges.values()].find((x) => x.ax === e.ax && x.ay === e.ay && x.bx === e.bx && x.by === e.by && x.owner === e.owner);
    ok(f, 'edge kept');
    eq(h.isShielded(f), g.isShielded(e), `protection of ${e.ax},${e.ay}-${e.bx},${e.by}`);
    eq(h.isFresh(f), g.isFresh(e), 'freshness');
  }
  h.play(6, 5, 8, 4);
  g.play(6, 5, 8, 4);
  for (const e of g.edges.values()) {
    const f = [...h.edges.values()].find((x) => x.ax === e.ax && x.ay === e.ay && x.bx === e.bx && x.by === e.by && x.owner === e.owner);
    eq(h.isShielded(f), g.isShielded(e), 'protection after the turn ends');
  }
});

// ------------------------------------------------- oracles and random games

// Independent area oracle: vertical slab decomposition plus a flood fill
// from the outside. Shares no code with analyzeArea. With border > 0 the
// board's sides are walls and the largest region on the board is outside.
function oracleArea(segsIn, border = 0) {
  if (!segsIn.length) return 0;
  const B = border - 1;
  const segs = border ? [...segsIn, [0, 0, B, 0], [B, 0, B, B], [B, B, 0, B], [0, B, 0, 0]] : segsIn;
  const xs = new Set();
  for (const [ax, , bx] of segs) { xs.add(ax); xs.add(bx); }
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [ax, ay, bx, by] = segs[i], [cx, cy, dx, dy] = segs[j];
      const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
      const den = rx * sy - ry * sx;
      if (den === 0) continue;
      const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
      const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
      if (t >= -1e-12 && t <= 1 + 1e-12 && u >= -1e-12 && u <= 1 + 1e-12) xs.add(ax + t * rx);
    }
  }
  const X = [];
  for (const x of [...xs].sort((a, b) => a - b)) if (!X.length || x - X[X.length - 1] > 1e-9) X.push(x);
  const yAt = (s, x) => {
    const [ax, ay, bx, by] = s;
    return ay + (by - ay) * (x - ax) / (bx - ax);
  };
  // regions[k] = list of {lo: seg|null, hi: seg|null, id}
  const slabs = [];
  let nextId = 1; // 0 is the outside
  for (let k = 0; k + 1 < X.length; k++) {
    const x0 = X[k], x1 = X[k + 1], xm = (x0 + x1) / 2;
    const span = segs.filter(([ax, , bx]) => ax !== bx && Math.min(ax, bx) <= x0 + 1e-12 && Math.max(ax, bx) >= x1 - 1e-12);
    span.sort((a, b) => yAt(a, xm) - yAt(b, xm));
    const regs = [];
    for (let i = 0; i <= span.length; i++) {
      regs.push({ lo: i > 0 ? span[i - 1] : null, hi: i < span.length ? span[i] : null, id: (i === 0 || i === span.length) ? 0 : nextId++ });
    }
    slabs.push({ x0, x1, regs });
  }
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b); adj.get(b).add(a);
  };
  const interval = (r, x) => [r.lo ? yAt(r.lo, x) : -Infinity, r.hi ? yAt(r.hi, x) : Infinity];
  const verticalCover = (x) => segs.filter(([ax, , bx]) => ax === bx && Math.abs(ax - x) < 1e-12).map(([, ay, , by]) => [Math.min(ay, by), Math.max(ay, by)]);
  const passable = (lo, hi, cover) => {
    if (hi - lo <= 1e-7) return false;
    // Is some part of (lo, hi) not covered by the vertical walls?
    const cs = cover.filter(([a, b]) => b > lo && a < hi).sort((p, q) => p[0] - q[0]);
    let cur = lo;
    for (const [a, b] of cs) {
      if (a > cur + 1e-7) return true;
      cur = Math.max(cur, b);
      if (cur >= hi - 1e-7) return false;
    }
    return cur < hi - 1e-7;
  };
  const boundaryLinks = (left, right, x) => {
    const cover = verticalCover(x);
    for (const a of left) {
      const [al, ah] = a.iv;
      for (const b of right) {
        const [bl, bh] = b.iv;
        const lo = Math.max(al, bl), hi = Math.min(ah, bh);
        if (passable(lo, hi, cover)) link(a.id, b.id);
      }
    }
  };
  const outside = [{ id: 0, iv: [-Infinity, Infinity] }];
  for (let k = 0; k <= slabs.length; k++) {
    const x = X[k];
    const left = k === 0 ? outside : slabs[k - 1].regs.map((r) => ({ id: r.id, iv: interval(r, x) }));
    const right = k === slabs.length ? outside : slabs[k].regs.map((r) => ({ id: r.id, iv: interval(r, x) }));
    boundaryLinks(left, right, x);
  }
  // Label every region with its connected component.
  const comp = new Map();
  const label = (start, c) => {
    const queue = [start];
    comp.set(start, c);
    while (queue.length) {
      const a = queue.pop();
      for (const b of adj.get(a) || []) if (!comp.has(b)) { comp.set(b, c); queue.push(b); }
    }
  };
  label(0, 0);
  const compArea = new Map();
  for (const s of slabs) {
    for (const r of s.regs) {
      if (r.id === 0) continue;
      if (!comp.has(r.id)) label(r.id, r.id);
      const c = comp.get(r.id);
      if (c === 0) continue;
      const [l0, h0] = interval(r, s.x0), [l1, h1] = interval(r, s.x1);
      compArea.set(c, (compArea.get(c) || 0) + (s.x1 - s.x0) * ((h0 - l0) + (h1 - l1)) / 2);
    }
  }
  let total = 0, largest = 0;
  for (const a of compArea.values()) { total += a; largest = Math.max(largest, a); }
  return border ? total - largest : total;
}

test('oracle agrees on the fixed shapes', () => {
  near(oracleArea(poly([[0, 2], [1, 1], [4, 0], [5, 2], [3, 5], [0, 5]])), 18);
  near(oracleArea([[1, 0, 0, 2], [1, 0, 2, 2], [0, 2, 2, 4], [2, 2, 0, 4]]), 3);
  near(oracleArea([...poly([[0, 0], [6, 0], [6, 6], [0, 6]]), ...poly([[2, 2], [4, 2], [4, 4], [2, 4]])]), 36);
  near(oracleArea(poly([[0, 0], [2, 2], [2, 0], [0, 2]])), 2);
});

// Independent legality check written straight from the rules.
function slowCheck(g, fx, fy, tx, ty) {
  const me = g.player, R = g.rules, S = R.size;
  const side = (p) => (R.teams ? p % 2 : p);
  if (!g.hasNode(me, fx, fy)) return 'notyours';
  if (tx < 0 || ty < 0 || tx >= S || ty >= S) return 'board';
  if (Math.abs(tx - fx) > R.radius || Math.abs(ty - fy) > R.radius || (fx === tx && fy === ty)) return 'range';
  const all = [...g.edges.values()];
  const mine = all.filter((e) => e.owner === me);
  const allies = all.filter((e) => e.owner !== me && side(e.owner) === side(me));
  const theirs = all.filter((e) => side(e.owner) !== side(me));
  const toIsNode = g.hasNode(me, tx, ty);
  if (!toIsNode && mine.some((e) => pointOnSegment(e.ax, e.ay, e.bx, e.by, tx, ty))) return 'onown';
  for (const [x, y] of g.nodesOf(me)) {
    if ((x === fx && y === fy) || (x === tx && y === ty)) continue;
    if (pointOnSegment(fx, fy, tx, ty, x, y)) return 'throughown';
  }
  if (mine.some((e) => (e.ax === fx && e.ay === fy && e.bx === tx && e.by === ty) || (e.bx === fx && e.by === fy && e.ax === tx && e.ay === ty))) return 'dup';
  if (allies.some((e) => segmentsTouch(fx, fy, tx, ty, e.ax, e.ay, e.bx, e.by))) return 'ally';
  const hits = theirs.filter((e) => segmentsTouch(fx, fy, tx, ty, e.ax, e.ay, e.bx, e.by));
  if (hits.length > 1) return 'double';
  // Protected: placed during its owner's latest turn, unless that turn timed out.
  if (hits.length === 1 && R.protect && hits[0].turn > 0 && !hits[0].noShield && hits[0].turn === lastTurnOf(g, hits[0].owner)) return 'shielded';
  return 'ok';
}

// The turn number of a player's latest turn, worked out from the move list.
function lastTurnOf(g, pl) {
  if (g.player === pl) return g.turn;
  let t = g.turn, last = 0;
  // Walk back through the timeline of finished turns.
  for (let i = g.timeline.length - 1; i >= 0; i--) {
    if (g.timeline[i].player === pl) { last = g.timeline[i].turn; break; }
  }
  void t;
  return last;
}

function invariants(g) {
  const all = [...g.edges.values()];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    if (a.owner !== b.owner && segmentsTouch(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by)) throw new Error(`players ${a.owner} and ${b.owner} touch`);
  }
  const S = g.rules.size;
  for (let pl = 0; pl < g.NP; pl++) {
    const es = all.filter((e) => e.owner === pl);
    const deg = new Uint8Array(S * S);
    for (const e of es) { deg[e.a]++; deg[e.b]++; }
    for (let p = 0; p < S * S; p++) if (deg[p] !== g.deg[pl][p]) throw new Error('degree table out of sync');
    for (const [x, y] of g.nodesOf(pl)) {
      for (const e of es) {
        const end = (e.ax === x && e.ay === y) || (e.bx === x && e.by === y);
        if (!end && pointOnSegment(e.ax, e.ay, e.bx, e.by, x, y)) throw new Error('own node inside own edge');
      }
    }
    const segs = es.map((e) => [e.ax, e.ay, e.bx, e.by]);
    const border = g.rules.border ? S : 0;
    const fast = analyzeArea(segs, false, border).area;
    if (Math.abs(fast - g.areas[pl]) > 1e-6) throw new Error(`cached area ${g.areas[pl]} vs fresh ${fast}`);
    const slow = oracleArea(segs, border);
    if (Math.abs(fast - slow) > 1e-6) throw new Error(`area ${fast} vs oracle ${slow} (border ${border}) for ${JSON.stringify(segs)}`);
  }
}

// Random play with a pull toward the opponent so that games include fights.
function randomPolicy(g, legal, rand) {
  const breaking = legal.filter((m) => m.breaks);
  if (breaking.length && rand() < 0.7) return breaking[Math.floor(rand() * breaking.length)];
  const closing = legal.filter((m) => m.closes);
  if (closing.length && rand() < 0.4) return closing[Math.floor(rand() * closing.length)];
  if (rand() < 0.5) {
    const enemy = g.enemiesOf(g.player).flatMap((q) => g.nodesOf(q));
    const dist = (m) => Math.min(...enemy.map(([x, y]) => Math.max(Math.abs(x - m.tx), Math.abs(y - m.ty))));
    const best = legal.map((m) => [dist(m) + rand() * 2, m]).sort((a, b) => a[0] - b[0]).slice(0, 12);
    return best[Math.floor(rand() * best.length)][1];
  }
  return legal[Math.floor(rand() * legal.length)];
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function randomGames(games, rules, seedBase = 7919) {
  let moves = 0, breaks = 0, closes = 0, maxArea = 0;
  for (let seed = 1; seed <= games; seed++) {
    const rand = rng(seed * seedBase);
    const g = new Game(null, rules);
    const Rr = g.rules.radius;
    while (!g.over) {
      // Compare every candidate around a few nodes with the slow check.
      const nodes = g.nodesOf(g.player);
      for (let k = 0; k < 3 && nodes.length; k++) {
        const [fx, fy] = nodes[Math.floor(rand() * nodes.length)];
        for (let dy = -Rr; dy <= Rr; dy++) for (let dx = -Rr; dx <= Rr; dx++) {
          if (!dx && !dy) continue;
          const tx = fx + dx, ty = fy + dy;
          const a = g.check(fx, fy, tx, ty);
          const b = slowCheck(g, fx, fy, tx, ty);
          const ac = a.ok ? 'ok' : a.code === 'same' ? 'range' : a.code;
          if (ac !== b) throw new Error(`check mismatch at ${fx},${fy}->${tx},${ty}: ${ac} vs ${b} (seed ${seed})`);
        }
      }
      const legal = g.legalMoves();
      if (!legal.length) { g.pass(); continue; }
      const m = randomPolicy(g, legal, rand);
      const r = g.play(m.fx, m.fy, m.tx, m.ty);
      moves++;
      if (r.broke) breaks++;
      if (m.closes) closes++;
      maxArea = Math.max(maxArea, ...g.areas);
      if (rand() < 0.02 && !g.over) g.timeout();
      invariants(g);
    }
    const r2 = decodeRules(encodeRules(g.rules));
    const replay = Game.fromHistory(decodeHistory(encodeHistory(g.history, r2), r2), null, r2);
    eq(replay.scores.join(), g.scores.join(), 'replayed scores');
    eq(replay.edges.size, g.edges.size, 'replayed edges');
    eq(g.placed, g.totalEdges, 'all edges used');
  }
  return { moves, breaks, closes, maxArea };
}

test('random games: legality matches the slow check, invariants hold, replay matches', () => {
  const games = Number(process.env.GAMES || 30);
  const { moves, breaks, closes, maxArea } = randomGames(games, null);
  ok(breaks > games * 3 && closes > games * 3, `games too quiet: ${breaks} breaks, ${closes} closes`);
  console.log(`   random games: ${moves} edges, ${breaks} breaks, ${closes} closing moves, largest area ${maxArea}`);
});

const VARIANTS = [
  { size: 13, perPlayer: 30 },
  { radius: 2, perPlayer: 30 },
  { radius: 4, perPlayer: 30 },
  { players: 3, perPlayer: 25 },
  { players: 4, perPlayer: 20 },
  { players: 4, teams: true, perPlayer: 20 },
  { protect: false, perPlayer: 30 },
  { border: true, perPlayer: 40 },
  { border: true, size: 13, players: 4, perPlayer: 15 },
  { timeout: 'edge', stuck: 'turn', perPlayer: 30 },
  { handicap: [0, 3], perPlayer: 30 },
];

test('random games under every rule variant', () => {
  const games = Number(process.env.VGAMES || 4);
  for (const v of VARIANTS) {
    const r = randomGames(games, v, 104729);
    ok(r.moves > 0, JSON.stringify(v));
  }
});

test('loss estimates match removing the edge', () => {
  let checked = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const rand = rng(seed * 104729);
    const g = new Game();
    while (!g.over) {
      const legal = g.legalMoves();
      if (!legal.length) { g.pass(); continue; }
      const closing = legal.filter((m) => m.closes);
      const pool = closing.length && rand() < 0.7 ? closing : legal;
      const m = pool[Math.floor(rand() * pool.length)];
      g.play(m.fx, m.fy, m.tx, m.ty);
    }
    for (const pl of [BLUE, RED]) {
      const segs = g.edgesOf(pl).map((e) => [e.ax, e.ay, e.bx, e.by]);
      const r = analyzeArea(segs, true);
      const nested = r.faces.some((f) => f.nested);
      for (let i = 0; i < segs.length; i++) {
        const without = analyzeArea(segs.filter((_, j) => j !== i)).area;
        if (nested) ok(without >= r.area - r.loss[i] - 1e-6, 'loss overestimate only');
        else near(r.area - r.loss[i], without, 1e-6, `segment ${i}`);
        checked++;
      }
    }
  }
  ok(checked > 100);
});

// ----------------------------------------------------- lessons and diagrams

function touching(g) {
  for (const b of g.edgesOf(BLUE)) for (const r of g.edgesOf(RED)) {
    if (segmentsTouch(b.ax, b.ay, b.bx, b.by, r.ax, r.ay, r.bx, r.by)) return true;
  }
  return false;
}

test('every lesson starts with Blue to move and can be solved this turn', () => {
  for (const l of LESSONS) {
    if (l.final) continue;
    const g0 = new Game(l.base);
    eq(g0.player, BLUE, l.id);
    ok(!touching(g0), `${l.id}: blue and red touch`);
    let solved = false;
    for (const m1 of g0.legalMoves()) {
      const g1 = g0.clone();
      const e1 = g1.play(m1.fx, m1.fy, m1.tx, m1.ty);
      if (l.check(g1, e1)) { solved = true; break; }
      if (g1.player !== BLUE) continue;
      for (const m2 of g1.legalMoves()) {
        const g2 = g1.clone();
        if (l.check(g2, g2.play(m2.fx, m2.fy, m2.tx, m2.ty))) { solved = true; break; }
      }
      if (solved) break;
    }
    ok(solved, `${l.id} cannot be solved`);
  }
});

test('lesson traps behave as the text says', () => {
  const one = new Game(LESSONS.find((l) => l.id === 'one').base);
  eq(one.check(5, 7, 8, 6).code, 'double', 'peak of the red pair');
  const sh = new Game(LESSONS.find((l) => l.id === 'shield').base);
  eq(sh.check(7, 7, 10, 5).code, 'shielded');
  ok(sh.check(7, 7, 10, 9).breaks, 'old edge breaks');
});

test('diagrams show what their captions say', () => {
  for (const [name, d] of Object.entries(DIAGRAMS)) ok(!touching(new Game(d.base)), `${name} touches`);
  ok(new Game(DIAGRAMS.cut.base).check(4, 7, 6, 8).breaks, 'cut');
  eq(new Game(DIAGRAMS.shield.base).check(7, 6, 9, 7).code, 'shielded');
  eq(new Game(DIAGRAMS.enclose.base).areas[BLUE], 18);
  eq(new Game(DIAGRAMS.area.base).areas.join(), '18,10');
});

test('every puzzle solution reaches the stated best swing', () => {
  ok(PUZZLES.length >= 1, 'no puzzles');
  const seen = new Set();
  for (const p of PUZZLES) {
    ok(!seen.has(p.code), 'duplicate puzzle');
    seen.add(p.code);
    const g0 = Game.fromHistory(decodeHistory(p.code));
    eq(g0.player, p.player, 'side to move');
    eq(g0.left, 2, 'two edges to place');
    const g = g0.clone();
    for (const [fx, fy, tx, ty] of p.sol) g.play(fx, fy, tx, ty);
    ok(g.player !== p.player, 'solution finishes the turn');
    const me = p.player;
    const v = (g.areas[me] - g0.areas[me]) + (g0.areas[1 - me] - g.areas[1 - me]);
    near(v, p.best, 1e-6, 'solution swing');
  }
});

test('guide positions are valid, tasks can be solved, and wrong answers fail', () => {
  for (const ch of CHAPTERS) {
    for (const d of ch.diagrams) {
      eq(validateEdges(d.base.edges.map((e) => e.slice(0, 5)), d.base.rules || {}), null, `${ch.id} diagram`);
    }
    for (const t of ch.tasks) {
      eq(validateEdges(t.base.edges.map((e) => e.slice(0, 5)), t.base.rules || {}), null, `${ch.id} task`);
      const g0 = new Game(t.base);
      eq(g0.player, BLUE, `${ch.id} blue to move`);
      let solved = 0, failed = 0;
      for (const m1 of g0.legalMoves()) {
        const g1 = g0.clone();
        const r1 = g1.check(m1.fx, m1.fy, m1.tx, m1.ty);
        const e1 = g1.play(m1.fx, m1.fy, m1.tx, m1.ty);
        if (t.check(g1, e1, g0, r1)) { solved++; continue; }
        if (g1.player !== BLUE) { failed++; continue; }
        for (const m2 of g1.legalMoves().slice(0, 400)) {
          const g2 = g1.clone();
          const r2 = g2.check(m2.fx, m2.fy, m2.tx, m2.ty);
          const e2 = g2.play(m2.fx, m2.fy, m2.tx, m2.ty);
          if (t.check(g2, e2, g0, r2)) solved++; else failed++;
        }
        if (solved && failed > 50) break;
      }
      ok(solved > 0, `${ch.id} task can't be solved`);
      ok(failed > 0, `${ch.id} task can't be failed`);
    }
  }
});

test('guide claims: the cells diagram cut, the protected wall, the sealed cells', () => {
  const by = (id) => CHAPTERS.find((c) => c.id === id).diagrams[0];
  const cells = new Game(by('cells').base);
  const r = cells.check(4, 1, 4, 4);
  ok(r.ok && r.breaks, 'red cuts the top wall');
  const c2 = cells.clone(); c2.play(4, 1, 4, 4);
  eq(cells.areas[BLUE] - c2.areas[BLUE], 4.5, 'only one triangle opens');
  eq(new Game(by('timing').base).check(7, 6, 4, 7).code, 'shielded');
  const sealed = new Game(by('sealed').base);
  eq(sealed.check(5, 2, 4, 5).code, 'double');
  // Red nodes everywhere around the sealed block still can't break it.
  const edges = by('sealed').base.edges.filter((e) => e[0] === BLUE);
  const ring = [];
  for (let x = 1; x <= 7; x++) for (const y of [1, 2, 7, 8]) ring.push([RED, x, y, x, y === 1 || y === 7 ? y + 1 : y + 1]);
  const h = new Game({ edges: [...edges, [RED, 1, 1, 2, 1], [RED, 6, 1, 7, 2], [RED, 1, 7, 2, 8], [RED, 7, 7, 6, 8], [RED, 0, 4, 1, 3], [RED, 8, 4, 7, 3], [RED, 0, 6, 1, 6], [RED, 8, 6, 7, 7]], turn: 4, rules: { protect: false } });
  void ring;
  const blue = h.edgesOf(BLUE);
  ok(blue.every((e) => !aiCanBreak(h, e, h.nodesOf(RED))), 'no red edge breaks a lattice-free cell');
  eq(breakableBlueWalls(h).length, 0);
});

test('the home page intro plays legal edges and its captions are true', () => {
  const g = new Game();
  for (const step of INTRO) for (const [fx, fy, tx, ty] of step.moves) g.play(fx, fy, tx, ty);
  const h = new Game();
  INTRO.slice(0, 3).forEach((st) => st.moves.forEach((m) => h.play(...m)));
  eq(h.areas[RED], 3, 'Red holds 3');
  eq(g.areas[RED], 0, "Red's loop is open again");
  eq(g.history.length, 9);
});

test('lattice-free cells can never be broken, from any red node', () => {
  // A 2 x 1 block of half-square triangles. Try every red edge from every
  // nearby point that doesn't already touch blue.
  const blue = [[3, 4, 4, 4], [4, 4, 4, 5], [4, 5, 3, 5], [3, 5, 3, 4], [3, 4, 4, 5], [4, 4, 5, 4], [5, 4, 5, 5], [5, 5, 4, 5], [4, 4, 5, 5]];
  let tried = 0;
  for (let x = 0; x <= 8; x++) for (let y = 0; y <= 9; y++) {
    if (x >= 3 && x <= 5 && y >= 4 && y <= 5) continue;
    const g = new Game({ edges: [...blue.map((e) => [BLUE, ...e]), [RED, x, y, x === 0 ? 1 : x - 1, y]], turn: 4, rules: { protect: false } });
    if ([...g.edges.values()].some((e) => e.owner === RED && blue.some((b) => segmentsTouch(e.ax, e.ay, e.bx, e.by, ...b)))) continue;
    for (const m of g.legalMoves()) { ok(!m.breaks, `red ${m.fx},${m.fy}->${m.tx},${m.ty} broke a sealed wall`); tried++; }
  }
  ok(tried > 1000);
});

test('tournament pairing follows the double-elimination rules', () => {
  const players = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}` }));
  const losses = { p0: 1, p1: 1, p2: 2, p3: 0, p4: 0, p5: 0, p6: 1 };
  const r = pairRound(players, losses, {}, new Set(), rng(5));
  const ids = r.pairs.flat();
  ok(!ids.includes('p2'), 'two losses are out');
  for (const [a, b] of r.pairs) ok((losses[a] || 0) === (losses[b] || 0) || r.byes.length === 0, 'groups play inside themselves');
  eq(ids.length + r.byes.length, 6);
  // Both groups odd: the two left over play each other instead of byes.
  const r2 = pairRound(players.slice(3), { p3: 0, p4: 0, p5: 0, p6: 1 }, {}, new Set(), rng(9));
  eq(r2.byes.length, 0); eq(r2.pairs.length, 2);
  // A bye never goes to someone who already had one, when it can be avoided.
  for (let s = 1; s < 30; s++) {
    const r3 = pairRound(players.slice(0, 3), { p0: 0, p1: 0, p2: 0 }, { p0: true, p1: true }, new Set(), rng(s));
    eq(r3.byes.join(), 'p2');
  }
  // The final: one player with no losses, one with one.
  const r4 = pairRound([{ id: 'a' }, { id: 'b' }], { a: 0, b: 1 }, {}, new Set(), rng(1));
  eq(r4.pairs.length, 1); eq(r4.byes.length, 0);
});

test('GIF encoder output decodes back to the same pixels', () => {
  const W = 37, H = 23;
  const palette = Array.from({ length: 256 }, (_, i) => [i, 255 - i, (i * 7) & 255]);
  const frames = [0, 1, 2].map((f) => Uint8Array.from({ length: W * H }, (_, i) => ((i * (f + 3)) ^ (i >> 4)) & 255));
  const bytes = encodeGif(W, H, frames, palette, [10, 10, 50]);
  const back = decodeGif(bytes);
  eq(back.width, W); eq(back.height, H); eq(back.frames.length, 3);
  for (let f = 0; f < 3; f++) ok(back.frames[f].every((v, i) => v === frames[f][i]), `frame ${f}`);
  // A long run that fills the code table and forces a clear code.
  const big = Uint8Array.from({ length: 200 * 200 }, (_, i) => (i * 2654435761 >>> 24) & 255);
  const b2 = decodeGif(encodeGif(200, 200, [big], palette, [10]));
  ok(b2.frames[0].every((v, i) => v === big[i]), 'large frame');
});

// Minimal GIF decoder for the test above (global palette, full frames).
function decodeGif(b) {
  let p = 6;
  const rd16 = () => { const v = b[p] | (b[p + 1] << 8); p += 2; return v; };
  const width = rd16(), height = rd16();
  const packed = b[p]; p += 3;
  if (packed & 0x80) p += 3 * (2 << (packed & 7));
  const frames = [];
  while (p < b.length) {
    const t = b[p++];
    if (t === 0x3b) break;
    if (t === 0x21) { p++; while (b[p]) p += b[p] + 1; p++; continue; }
    if (t === 0x2c) {
      p += 8;
      const lp = b[p++];
      if (lp & 0x80) p += 3 * (2 << (lp & 7));
      const minCode = b[p++];
      const data = [];
      while (b[p]) { const n = b[p++]; for (let i = 0; i < n; i++) data.push(b[p++]); }
      p++;
      frames.push(lzwDecode(data, minCode, width * height));
    }
  }
  return { width, height, frames };
}

function lzwDecode(data, minCode, n) {
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, dict = [], next = eoi + 1, prev = null;
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; size = minCode + 1; next = eoi + 1; prev = null; };
  reset();
  const out = [];
  let bitPos = 0;
  const read = () => {
    let v = 0;
    for (let i = 0; i < size; i++) {
      const byte = data[(bitPos + i) >> 3];
      v |= ((byte >> ((bitPos + i) & 7)) & 1) << i;
    }
    bitPos += size;
    return v;
  };
  while (out.length < n) {
    const code = read();
    if (code === clear) { reset(); continue; }
    if (code === eoi) break;
    let entry;
    if (code < next && dict[code]) entry = dict[code];
    else if (code === next && prev) entry = [...prev, prev[0]];
    else throw new Error('bad code');
    out.push(...entry);
    if (prev && next < 4096) { dict[next++] = [...prev, entry[0]]; if (next === (1 << size) && size < 12) size++; }
    prev = entry;
  }
  return Uint8Array.from(out);
}

// ----------------------------------------------------------- computer player

test('computer plans are legal and fill the turn', () => {
  const positions = [];
  for (let seed = 1; seed <= 4; seed++) {
    const rand = rng(seed * 31337);
    const g = new Game();
    while (!g.over) {
      const legal = g.legalMoves();
      if (!legal.length) { g.pass(); continue; }
      const m = randomPolicy(g, legal, rand);
      g.play(m.fx, m.fy, m.tx, m.ty);
      if (rand() < 0.05) positions.push(g.clone());
    }
  }
  positions.unshift(new Game());
  let checked = 0;
  for (const pos of positions.slice(0, 14)) {
    for (const level of ['easy', 'medium', 'hard']) {
      if (pos.over) continue;
      const g = pos.clone();
      const pl = g.player, turn = g.turn, left = g.left;
      const plan = planTurn(g, level, 99);
      eq(plan.length, left, `${level} plan length`);
      for (const m of plan) g.apply(m);
      ok(g.over || g.player !== pl || g.turn !== turn, 'turn finished');
      coachMarks(pos);
      checked++;
    }
  }
  ok(checked >= 30, `only ${checked} plans checked`);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
