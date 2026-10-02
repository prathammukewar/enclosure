// Run with: node test/test.mjs
import { analyzeArea, segmentsTouch, pointOnSegment } from '../js/geometry.js';
import {
  Game, BLUE, RED, N, TOTAL_EDGES, encodeHistory, decodeHistory, moveName, updatesAfter, formatArea,
} from '../js/engine.js';
import { LESSONS } from '../js/lessons.js';
import { DIAGRAMS } from '../js/diagrams.js';
import { planTurn, coachMarks } from '../js/ai.js';

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

// ------------------------------------------------- oracles and random games

// Independent area oracle: vertical slab decomposition plus a flood fill
// from the outside. Shares no code with analyzeArea.
function oracleArea(segs) {
  if (!segs.length) return 0;
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
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length) {
    const a = queue.pop();
    for (const b of adj.get(a) || []) if (!seen.has(b)) { seen.add(b); queue.push(b); }
  }
  let area = 0;
  for (const s of slabs) {
    for (const r of s.regs) {
      if (r.id === 0 || seen.has(r.id)) continue;
      const [l0, h0] = interval(r, s.x0), [l1, h1] = interval(r, s.x1);
      area += (s.x1 - s.x0) * ((h0 - l0) + (h1 - l1)) / 2;
    }
  }
  return area;
}

test('oracle agrees on the fixed shapes', () => {
  near(oracleArea(poly([[0, 2], [1, 1], [4, 0], [5, 2], [3, 5], [0, 5]])), 18);
  near(oracleArea([[1, 0, 0, 2], [1, 0, 2, 2], [0, 2, 2, 4], [2, 2, 0, 4]]), 3);
  near(oracleArea([...poly([[0, 0], [6, 0], [6, 6], [0, 6]]), ...poly([[2, 2], [4, 2], [4, 4], [2, 4]])]), 36);
  near(oracleArea(poly([[0, 0], [2, 2], [2, 0], [0, 2]])), 2);
});

// Independent legality check written straight from the rules.
function slowCheck(g, fx, fy, tx, ty) {
  const me = g.player, op = 1 - me;
  if (!g.hasNode(me, fx, fy)) return 'notyours';
  if (tx < 0 || ty < 0 || tx >= N || ty >= N) return 'board';
  if (Math.abs(tx - fx) > 3 || Math.abs(ty - fy) > 3 || (fx === tx && fy === ty)) return 'range';
  const mine = g.edgesOf(me), theirs = g.edgesOf(op);
  const toIsNode = g.hasNode(me, tx, ty);
  if (!toIsNode && mine.some((e) => pointOnSegment(e.ax, e.ay, e.bx, e.by, tx, ty))) return 'onown';
  for (const [x, y] of g.nodesOf(me)) {
    if ((x === fx && y === fy) || (x === tx && y === ty)) continue;
    if (pointOnSegment(fx, fy, tx, ty, x, y)) return 'throughown';
  }
  if (mine.some((e) => (e.ax === fx && e.ay === fy && e.bx === tx && e.by === ty) || (e.bx === fx && e.by === fy && e.ax === tx && e.ay === ty))) return 'dup';
  const hits = theirs.filter((e) => segmentsTouch(fx, fy, tx, ty, e.ax, e.ay, e.bx, e.by));
  if (hits.length > 1) return 'double';
  if (hits.length === 1 && hits[0].shield === g.turn) return 'shielded';
  return 'ok';
}

function invariants(g) {
  const blue = g.edgesOf(BLUE), red = g.edgesOf(RED);
  for (const b of blue) for (const r of red) {
    if (segmentsTouch(b.ax, b.ay, b.bx, b.by, r.ax, r.ay, r.bx, r.by)) throw new Error('blue and red edges touch');
  }
  for (const pl of [BLUE, RED]) {
    const es = pl === BLUE ? blue : red;
    const deg = new Uint8Array(N * N);
    for (const e of es) { deg[e.a]++; deg[e.b]++; }
    for (let p = 0; p < N * N; p++) if (deg[p] !== g.deg[pl][p]) throw new Error('degree table out of sync');
    for (const [x, y] of g.nodesOf(pl)) {
      for (const e of es) {
        const end = (e.ax === x && e.ay === y) || (e.bx === x && e.by === y);
        if (!end && pointOnSegment(e.ax, e.ay, e.bx, e.by, x, y)) throw new Error('own node inside own edge');
      }
    }
    const segs = es.map((e) => [e.ax, e.ay, e.bx, e.by]);
    const fast = analyzeArea(segs).area;
    if (Math.abs(fast - g.areas[pl]) > 1e-6) throw new Error(`cached area ${g.areas[pl]} vs fresh ${fast}`);
    const slow = oracleArea(segs);
    if (Math.abs(fast - slow) > 1e-6) throw new Error(`area ${fast} vs oracle ${slow} for ${JSON.stringify(segs)}`);
  }
}

// Random play with a pull toward the opponent so that games include fights.
function randomPolicy(g, legal, rand) {
  const breaking = legal.filter((m) => m.breaks);
  if (breaking.length && rand() < 0.7) return breaking[Math.floor(rand() * breaking.length)];
  const closing = legal.filter((m) => m.closes);
  if (closing.length && rand() < 0.4) return closing[Math.floor(rand() * closing.length)];
  if (rand() < 0.5) {
    const enemy = g.nodesOf(1 - g.player);
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

test('random games: legality matches the slow check, invariants hold, replay matches', () => {
  const games = Number(process.env.GAMES || 30);
  let moves = 0, breaks = 0, closes = 0, maxArea = 0;
  for (let seed = 1; seed <= games; seed++) {
    const rand = rng(seed * 7919);
    const g = new Game();
    while (!g.over) {
      // Compare every candidate around a few nodes with the slow check.
      const nodes = g.nodesOf(g.player);
      for (let k = 0; k < 3; k++) {
        const [fx, fy] = nodes[Math.floor(rand() * nodes.length)];
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
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
      maxArea = Math.max(maxArea, g.areas[0], g.areas[1]);
      if (rand() < 0.02 && !g.over) g.timeout();
      invariants(g);
    }
    const replay = Game.fromHistory(decodeHistory(encodeHistory(g.history)));
    eq(replay.scores.join(), g.scores.join(), 'replayed scores');
    eq(replay.edges.size, g.edges.size, 'replayed edges');
  }
  ok(breaks > games * 3 && closes > games * 3, `games too quiet: ${breaks} breaks, ${closes} closes`);
  console.log(`   random games: ${moves} edges, ${breaks} breaks, ${closes} closing moves, largest area ${maxArea}`);
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
