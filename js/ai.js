// Computer player. It plans a whole turn (one or two edges) at once: pick
// promising first edges, try the best replies for the second edge, and score
// each finished turn by the score gap plus the area income it expects, minus
// what the opponent can break on their next turn.

import { N, RADIUS } from './engine.js';
import { analyzeArea, segmentsTouch } from './geometry.js';

export const LEVELS = {
  easy: { k1: 6, k2: 3, threat: false, noise: 4, blunder: 0.3, potential: 0, horizon: 3, budget: 400 },
  medium: { k1: 12, k2: 6, threat: true, noise: 1, blunder: 0.06, potential: 0, horizon: 6, budget: 700 },
  hard: { k1: 22, k2: 9, threat: true, noise: 0.1, blunder: 0, potential: 0, horizon: 9, budget: 1400, reply: 4 },
};

// How the hard level imagines the opponent's answer.
const REPLY = { k1: 8, k2: 4, threat: true, noise: 0, blunder: 0, potential: 0, horizon: 6, budget: 250 };

const segOf = (e) => [e.ax, e.ay, e.bx, e.by];

function cheb(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

// Chebyshev distance from a point to a segment, sampled along the segment.
function distToSeg(x, y, e) {
  let best = Infinity;
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    const d = Math.max(Math.abs(x - (e.ax + (e.bx - e.ax) * t)), Math.abs(y - (e.ay + (e.by - e.ay) * t)));
    if (d < best) best = d;
  }
  return best;
}

function insideAny(faces, x, y) {
  for (const f of faces) {
    if (f.nested) continue;
    let inside = false;
    const pts = f.pts;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if ((yi > y) !== (yj > y) && x < xj + (y - yj) * (xi - xj) / (yi - yj)) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

// Immediate effect of every legal move for the player to move:
// gain = own area added, loss = enemy area removed.
export function scoreMoves(g) {
  const me = g.player, op = 1 - me;
  const moves = g.legalMoves();
  const mySegs = g.edgesOf(me).map(segOf);
  const myFaces = g.analysis(me).faces;
  const opEdges = g.edgesOf(op);
  const opLoss = new Map();
  if (moves.some((m) => m.breaks)) {
    const an = analyzeArea(opEdges.map(segOf), true);
    opEdges.forEach((e, i) => opLoss.set(e.id, an.loss[i]));
  }
  const base = g.areas[me];
  let comp = null;
  for (const m of moves) {
    m.gain = 0;
    m.loss = m.breaks ? opLoss.get(m.breaks.id) || 0 : 0;
    if (!m.closes) continue;
    if (!m.crosses) {
      // Joining two separate pieces makes no loop.
      if (!comp) comp = pieces(g, me);
      if (comp.get(m.fy * N + m.fx) !== comp.get(m.ty * N + m.tx)) continue;
      // A chord through area we already own cannot add any.
      if (insideAny(myFaces, (m.fx + m.tx) / 2, (m.fy + m.ty) / 2)) continue;
    }
    m.gain = Math.max(0, analyzeArea([...mySegs, [m.fx, m.fy, m.tx, m.ty]]).area - base);
  }
  return moves;
}

// Connected pieces of a player's drawing (edges that touch, including
// crossings), as a map from node point to piece id.
function pieces(g, pl) {
  const es = g.edgesOf(pl);
  const parent = es.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < es.length; i++) {
    const a = es[i];
    for (let j = i + 1; j < es.length; j++) {
      const b = es[j];
      if (segmentsTouch(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by)) {
        const x = find(i), y = find(j);
        if (x !== y) parent[x] = y;
      }
    }
  }
  const out = new Map();
  es.forEach((e, i) => { out.set(e.a, find(i)); out.set(e.b, find(i)); });
  return out;
}

// Shortest paths inside one player's graph, used to guess how much area a
// future closing edge between two nodes would make.
function graphOf(g, pl) {
  const adj = new Map();
  for (const e of g.edges.values()) {
    if (e.owner !== pl) continue;
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push(e.b);
    adj.get(e.b).push(e.a);
  }
  return adj;
}

function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += (a % N) * ((b / N) | 0) - (b % N) * ((a / N) | 0);
  }
  return Math.abs(s) / 2;
}

// Best loop a player could close next turn: with one edge (ends within 3)
// or two edges (ends within 6). Returns estimated new area for each.
export function potential(g, pl, limit = 12) {
  const adj = graphOf(g, pl);
  const nodes = [...adj.keys()];
  const segs = g.edgesOf(pl).map(segOf);
  const faces = g.analysis(pl).faces;
  const base = g.areas[pl];
  const cands = [];
  for (const u of nodes) {
    const ux = u % N, uy = (u / N) | 0;
    const parent = new Map([[u, -1]]);
    const depth = new Map([[u, 0]]);
    const queue = [u];
    for (let qi = 0; qi < queue.length; qi++) {
      const a = queue[qi];
      if (depth.get(a) >= limit) continue;
      for (const b of adj.get(a)) {
        if (parent.has(b)) continue;
        parent.set(b, a);
        depth.set(b, depth.get(a) + 1);
        queue.push(b);
      }
    }
    for (const v of queue) {
      if (v <= u || depth.get(v) < 2) continue;
      const vx = v % N, vy = (v / N) | 0;
      const d = cheb(ux, uy, vx, vy);
      if (d > 2 * RADIUS) continue;
      const path = [];
      for (let w = v; w !== -1; w = parent.get(w)) path.push(w);
      const a = polyArea(path);
      if (a < 1) continue;
      // Skip loops that sit inside area we already have.
      if (insideAny(faces, (ux + vx) / 2, (uy + vy) / 2)) continue;
      cands.push({ u, v, d, a });
    }
  }
  cands.sort((p, q) => q.a - p.a);
  let one = 0, two = 0, checked = 0;
  for (const c of cands) {
    if (checked >= 6) break;
    if (c.d > RADIUS && two >= c.a) continue;
    if (c.d <= RADIUS && one >= c.a && two >= c.a) continue;
    checked++;
    const s = [c.u % N, (c.u / N) | 0, c.v % N, (c.v / N) | 0];
    const gain = Math.max(0, analyzeArea([...segs, s]).area - base);
    if (c.d <= RADIUS) one = Math.max(one, gain);
    two = Math.max(two, gain);
  }
  return { one, two };
}

// Area the attacker (the player to move in g) can probably break from the
// victim during this turn.
export function threat(g, victim) {
  const attacker = 1 - victim;
  if (g.player !== attacker || g.over) return 0;
  const edges = g.edgesOf(victim);
  if (!edges.length) return 0;
  const segs = edges.map(segOf);
  const an = analyzeArea(segs, true);
  const anodes = g.nodesOf(attacker);
  const direct = [], approach = [];
  edges.forEach((e, i) => {
    const loss = an.loss[i];
    if (loss <= 0 || g.isShielded(e)) return;
    let dist = Infinity;
    for (const [x, y] of anodes) dist = Math.min(dist, distToSeg(x, y, e));
    if (dist > 2 * RADIUS) return;
    if (dist <= RADIUS + 0.5 && canBreak(g, e, anodes)) direct.push({ i, loss });
    else approach.push({ i, loss });
  });
  direct.sort((a, b) => b.loss - a.loss);
  let best = direct.length ? direct[0].loss : 0;
  if (g.left >= 2) {
    if (direct.length >= 2) {
      const a = direct[0];
      for (const b of direct.slice(1, 5)) {
        const rest = segs.filter((_, j) => j !== a.i && j !== b.i);
        best = Math.max(best, an.area - analyzeArea(rest).area);
      }
    }
    for (const c of approach) best = Math.max(best, c.loss * 0.7);
  }
  return best;
}

function canBreak(g, e, anodes) {
  for (const [nx, ny] of anodes) {
    if (distToSeg(nx, ny, e) > RADIUS + 0.5) continue;
    let near = null;
    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        if (!dx && !dy) continue;
        const tx = nx + dx, ty = ny + dy;
        if (tx < 0 || ty < 0 || tx >= N || ty >= N) continue;
        if (!segmentsTouch(nx, ny, tx, ty, e.ax, e.ay, e.bx, e.by)) continue;
        if (!near) near = g._near(nx, ny);
        const r = g._check(nx, ny, tx, ty, near);
        if (r.ok && r.breaks && r.breaks.id === e.id) return true;
      }
    }
  }
  return false;
}

// How much enemy area sits on edges within reach of our nodes, ignoring
// legality details. Used as a rough "pressure" term.
function pressure(g, attacker) {
  const victim = 1 - attacker;
  const edges = g.edgesOf(victim);
  if (!edges.length || !g.areas[victim]) return 0;
  const an = analyzeArea(edges.map(segOf), true);
  const anodes = g.nodesOf(attacker);
  let best = 0;
  edges.forEach((e, i) => {
    if (an.loss[i] <= best) return;
    for (const [x, y] of anodes) {
      if (distToSeg(x, y, e) <= RADIUS) { best = an.loss[i]; return; }
    }
  });
  return best;
}

// Value of a position for `me`, taken right after my turn ended.
export function evaluate(g, me, cfg) {
  const op = 1 - me;
  const diff = g.scores[me] - g.scores[op];
  if (g.over) return diff;
  const R = g.updatesLeft();
  const myA = g.areas[me], opA = g.areas[op];
  const lost = cfg.threat ? threat(g, me) : 0;
  const noPot = { one: 0, two: 0 };
  const myPot = cfg.potential ? potential(g, me) : noPot, opPot = cfg.potential ? potential(g, op) : noPot;
  const atk = pressure(g, me);
  const rho = cfg.rho ?? 0.88;
  const next = (myA - lost) - (opA + opPot.two * cfg.potential);
  let later = 0, w = 1;
  const horizon = Math.min(R - 1, cfg.horizon);
  for (let k = 0; k < horizon; k++) { w *= rho; later += w; }
  const steady = (myA - lost + myPot.two * cfg.potential) - (opA + opPot.two * cfg.potential - atk * (cfg.atk ?? 0.5));
  return diff + next + later * steady;
}

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Quick ordering score for a move, before any lookahead.
function quick(m, setup, approach) {
  return 2 * (m.gain + m.loss) + (setup.get(m.tx * 100 + m.ty) || 0) * 0.5 + (approach.get(m.tx * 100 + m.ty) || 0) * 0.6;
}

// Points from which a single edge could close a loop next move, and points
// from which a breakable enemy edge with area behind it is in reach.
function targetsMaps(g) {
  const me = g.player, op = 1 - me;
  const setup = new Map(), approach = new Map();
  const adj = graphOf(g, me);
  const nodes = [...adj.keys()];
  // setup: a free point T within reach of two of our nodes that are far apart
  // in our graph; the triangle-ish loop area is the estimate.
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i], ax = a % N, ay = (a / N) | 0;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j], bx = b % N, by = (b / N) | 0;
      if (cheb(ax, ay, bx, by) > 2 * RADIUS) continue;
      const est = Math.abs((bx - ax) * 3) + Math.abs((by - ay) * 3);
      for (let ty = Math.max(0, Math.max(ay, by) - RADIUS); ty <= Math.min(N - 1, Math.min(ay, by) + RADIUS); ty++) {
        for (let tx = Math.max(0, Math.max(ax, bx) - RADIUS); tx <= Math.min(N - 1, Math.min(ax, bx) + RADIUS); tx++) {
          const k = tx * 100 + ty;
          const tri = Math.abs((bx - ax) * (ty - ay) - (by - ay) * (tx - ax)) / 2;
          const v = Math.min(est, tri + 1);
          if (v > (setup.get(k) || 0)) setup.set(k, v);
        }
      }
    }
  }
  const opEdges = g.edgesOf(op);
  if (g.areas[op] > 0) {
    const an = analyzeArea(opEdges.map(segOf), true);
    opEdges.forEach((e, i) => {
      if (an.loss[i] <= 0 || e.shield === g.turn) return;
      const x0 = Math.max(0, Math.min(e.ax, e.bx) - RADIUS), x1 = Math.min(N - 1, Math.max(e.ax, e.bx) + RADIUS);
      const y0 = Math.max(0, Math.min(e.ay, e.by) - RADIUS), y1 = Math.min(N - 1, Math.max(e.ay, e.by) + RADIUS);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (distToSeg(x, y, e) > RADIUS) continue;
        const k = x * 100 + y;
        if (an.loss[i] > (approach.get(k) || 0)) approach.set(k, an.loss[i]);
      }
    });
  }
  return { setup, approach };
}

function pickTop(moves, k, rand, maps, cfg) {
  const scored = moves.map((m) => ({ m, q: quick(m, maps.setup, maps.approach) + rand() * cfg.noise }));
  scored.sort((a, b) => b.q - a.q);
  const out = scored.slice(0, k).map((s) => s.m);
  // Keep a little variety: a couple of random quiet moves.
  for (let i = 0; i < 2 && moves.length > k; i++) out.push(moves[Math.floor(rand() * moves.length)]);
  return out;
}

const asMove = (m) => ({ kind: 'edge', fx: m.fx, fy: m.fy, tx: m.tx, ty: m.ty });

// Plan the rest of the current turn. Returns a list of moves to play in order.
export function planTurn(game, level = 'hard', seed = Date.now()) {
  const cfg = typeof level === 'string' ? LEVELS[level] : level;
  const rand = rng(seed);
  const me = game.player;
  const g = game.clone();
  if (g.over) return [];
  const first = scoreMoves(g);
  if (!first.length) return Array.from({ length: g.left }, () => ({ kind: 'pass' }));

  if (cfg.blunder && rand() < cfg.blunder) {
    const out = [];
    const h = g.clone();
    while (h.player === me && !h.over) {
      const ms = h.legalMoves();
      if (!ms.length) { out.push({ kind: 'pass' }); h.pass(); continue; }
      const m = ms[Math.floor(rand() * ms.length)];
      out.push(asMove(m));
      h.play(m.fx, m.fy, m.tx, m.ty);
    }
    return out;
  }

  const maps1 = targetsMaps(g);
  const tops = pickTop(first, cfg.k1, rand, maps1, cfg);
  let best = null, bestV = -Infinity;
  const finalists = [];
  const consider = (v, plan, pos) => {
    if (v > bestV) { bestV = v; best = plan; }
    if (cfg.reply) finalists.push({ v, plan, pos });
  };
  const t0 = Date.now();
  let tried = 0;
  for (const m1 of tops) {
    if (cfg.budget && tried >= 4 && Date.now() - t0 > cfg.budget) break;
    tried++;
    const g1 = g.clone();
    g1.play(m1.fx, m1.fy, m1.tx, m1.ty);
    if (g1.player !== me || g1.over) {
      consider(evaluate(g1, me, cfg) + rand() * cfg.noise * 0.1, [asMove(m1)], g1);
      continue;
    }
    const second = scoreMoves(g1);
    if (!second.length) {
      const g2 = g1.clone();
      g2.pass();
      consider(evaluate(g2, me, cfg), [asMove(m1), { kind: 'pass' }], g2);
      continue;
    }
    const maps2 = targetsMaps(g1);
    for (const m2 of pickTop(second, cfg.k2, rand, maps2, cfg)) {
      const g2 = g1.clone();
      g2.play(m2.fx, m2.fy, m2.tx, m2.ty);
      consider(evaluate(g2, me, cfg) + rand() * cfg.noise * 0.1, [asMove(m1), asMove(m2)], g2);
    }
  }
  if (cfg.reply && finalists.length > 1) {
    // Look one turn further for the best few: let the opponent answer, then
    // judge the position we would face.
    finalists.sort((a, b) => b.v - a.v);
    let bestReply = -Infinity;
    for (const f of finalists.slice(0, cfg.reply)) {
      const h = f.pos.clone();
      if (!h.over) {
        const answer = planTurn(h, REPLY, seed + 7);
        for (const m of answer) h.apply(m);
      }
      const v = afterReply(h, me, cfg);
      if (v > bestReply) { bestReply = v; best = f.plan; }
    }
  }
  return best;
}

// Value for `me` when it is my turn again (or the game is over).
function afterReply(g, me, cfg) {
  const op = 1 - me;
  const diff = g.scores[me] - g.scores[op];
  if (g.over) return diff;
  const R = g.updatesLeft();
  let later = 0, w = 1;
  for (let k = 0; k < Math.min(R, cfg.horizon); k++) { later += w; w *= cfg.rho ?? 0.88; }
  const myChance = threat(g, op);
  return diff + later * (g.areas[me] - g.areas[op]) + myChance * 1.5;
}

// Marks for the "weak walls" view, for the player to move: their walls with
// area behind them that the opponent can reach next turn, and enemy walls
// with area behind them that can be broken right now.
export function coachMarks(g) {
  const me = g.player, op = 1 - me;
  const weak = [], targets = [];
  if (g.over) return { weak, targets };
  const mine = g.edgesOf(me);
  if (g.areas[me] > 0) {
    const an = analyzeArea(mine.map(segOf), true);
    const onodes = g.nodesOf(op);
    mine.forEach((e, i) => {
      if (an.loss[i] <= 0 || e.shield === g.turn + 1) return;
      for (const [x, y] of onodes) {
        if (distToSeg(x, y, e) <= RADIUS) { weak.push({ ...e, loss: an.loss[i] }); return; }
      }
    });
  }
  const theirs = g.edgesOf(op);
  if (g.areas[op] > 0) {
    const an = analyzeArea(theirs.map(segOf), true);
    const mnodes = g.nodesOf(me);
    theirs.forEach((e, i) => {
      if (an.loss[i] <= 0 || g.isShielded(e)) return;
      if (canBreak(g, e, mnodes)) targets.push({ ...e, loss: an.loss[i] });
    });
  }
  return { weak, targets };
}
