// Exact best turn for the player to move. Used by the post-game report, the
// analysis board, custom puzzles and the puzzle miner.
//
// The swing of a turn is the area the mover fences in plus the enemy area
// it opens. solveTurn tries every first edge and every second edge that can
// matter. Second-edge effects come from scoreMoves (exact gains, and enemy
// losses that can only overestimate), and a dangling first edge can't
// change what a second edge does unless they touch. The best combinations
// are then replayed on the engine until no remaining estimate can beat the
// best exact result, so the answer is exact.

import { analyzeArea, segmentsTouch } from './geometry.js';
import { scoreMoves } from './ai.js';

const swingOf = (a, b, me, mode) => {
  const gain = b.areas[me] - a.areas[me];
  let cut = 0;
  for (const q of a.enemiesOf(me)) cut += a.areas[q] - b.areas[q];
  if (mode === 'gain') return gain;
  if (mode === 'cut') return cut;
  return gain + cut;
};

// True if edge B touches edge A anywhere except A's start point.
function touchesBeyondStart(a, b) {
  if (!segmentsTouch(a.fx, a.fy, a.tx, a.ty, b.fx, b.fy, b.tx, b.ty)) return false;
  const sharesStart = (b.fx === a.fx && b.fy === a.fy) || (b.tx === a.fx && b.ty === a.fy);
  if (!sharesStart) return true;
  const cross = (a.tx - a.fx) * (b.ty - b.fy) - (a.ty - a.fy) * (b.tx - b.fx);
  if (cross !== 0) return false;
  const ox = b.fx === a.fx && b.fy === a.fy ? b.tx : b.fx, oy = b.fx === a.fx && b.fy === a.fy ? b.ty : b.fy;
  return (ox - a.fx) * (a.tx - a.fx) + (oy - a.fy) * (a.ty - a.fy) > 0;
}

// True if (x, y) is inside one of the given faces.
function insideFaces(faces, x, y) {
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

const effect = (m, mode) => (mode === 'gain' ? m.gain : mode === 'cut' ? m.loss : m.gain + m.loss);

// Pieces of a player's drawing: edges that touch (including crossings)
// share a piece. Returns a function from edge id to piece number.
function piecesOf(edges) {
  const parent = edges.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const b = edges[j];
      if (segmentsTouch(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by)) {
        const x = find(i), y = find(j);
        if (x !== y) parent[x] = y;
      }
    }
  }
  const out = new Map();
  edges.forEach((e, i) => out.set(e.id, find(i)));
  return out;
}

const keyOf = (m) => `${m.fx},${m.fy},${m.tx},${m.ty}`;

// mode: 'swing' (default), 'gain' or 'cut'. Returns { best, sol, greedy,
// firsts, gain, cut } where sol is the list of edges, or null when the turn
// has more than two edges left.
//
// Second edges are scored without recounting area whenever that's safe.
// Say the first edge only touches one piece of the mover's drawing, and the
// second edge doesn't touch the first. Then any loop the two close together
// can be rerouted along that piece, so the second edge can't fence in more
// than it would have on its own (and exactly as much if the first edge
// fenced in nothing). Its area at the start is an upper bound, and the
// exact replay at the end settles the rest.
export function solveTurn(g, mode = 'swing', shouldStop = null) {
  const me = g.player;
  if (g.over || g.left > 2) return null;
  const B = g.rules.border ? g.S : 0;
  const root = scoreMoves(g);
  if (!root.length) return { best: 0, sol: [], greedy: 0, firsts: 0, gain: 0, cut: 0 };
  const rootEff = root.filter((m) => effect(m, mode) > 1e-9);
  const rootByKey = new Map(root.map((m) => [keyOf(m), m]));
  const lossTables = new Map();
  const tableFor = (h, owner) => {
    const es = h.edgesOf(owner);
    const an = analyzeArea(es.map((x) => [x.ax, x.ay, x.bx, x.by]), true, B);
    const t = new Map();
    es.forEach((x, i) => t.set(x.id, an.loss[i]));
    return t;
  };
  const lossOf = (e) => {
    if (!lossTables.has(e.owner)) lossTables.set(e.owner, tableFor(g, e.owner));
    return lossTables.get(e.owner).get(e.id) || 0;
  };
  const myEdges = g.edgesOf(me);
  const piece = piecesOf(myEdges);
  // Pieces of the mover's drawing that an edge touches.
  const touchedPieces = (m) => {
    const s = new Set();
    for (const e of myEdges) if (segmentsTouch(m.fx, m.fy, m.tx, m.ty, e.ax, e.ay, e.bx, e.by)) s.add(piece.get(e.id));
    return s;
  };
  const combos = [];
  let bestSingle = -Infinity, bestSingleMove = null;
  const R = g.R, S = g.S;
  for (const m1 of root) {
    if (shouldStop && shouldStop()) return null;
    const g1 = g.clone();
    g1.play(m1.fx, m1.fy, m1.tx, m1.ty);
    const s1 = swingOf(g, g1, me, mode);
    if (s1 > bestSingle) { bestSingle = s1; bestSingleMove = m1; }
    if (g1.player !== me || g1.over) { combos.push({ m1, m2: null, est: s1 }); continue; }
    combos.push({ m1, m2: 'quiet', est: s1 });
    if (B) {
      for (const m2 of scoreMoves(g1)) {
        const v = effect(m2, mode);
        if (v > 1e-9) combos.push({ m1, m2, est: s1 + v });
      }
      continue;
    }
    if (!m1.breaks && !m1.closes) {
      // A dangling first edge: second edges that don't touch it keep their
      // effect from the start position.
      for (const m2 of rootEff) {
        if (touchesBeyondStart(m1, m2)) continue;
        combos.push({ m1, m2, est: s1 + effect(m2, mode) });
      }
      const segs = g1.edgesOf(me).map((e) => [e.ax, e.ay, e.bx, e.by]);
      for (const [nx, ny] of g1.nodesOf(me)) {
        if (Math.max(Math.abs(nx - m1.fx), Math.abs(ny - m1.fy)) > 2 * R) continue;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          if (!dx && !dy) continue;
          const tx = nx + dx, ty = ny + dy;
          if (tx < 0 || ty < 0 || tx >= S || ty >= S) continue;
          const m2 = { fx: nx, fy: ny, tx, ty };
          if (!touchesBeyondStart(m1, m2)) continue;
          const r = g1.check(nx, ny, tx, ty);
          if (!r.ok) continue;
          let v = 0;
          if (r.breaks && mode !== 'gain') v += lossOf(r.breaks);
          if (r.closes && mode !== 'cut') v += Math.max(0, analyzeArea([...segs, [nx, ny, tx, ty]], false, B).area - g1.areas[me]);
          if (v > 1e-9) combos.push({ m1, m2, est: s1 + v });
        }
      }
      continue;
    }
    if (touchedPieces(m1).size > 1) {
      // The first edge joins pieces of the drawing: recount everything.
      for (const m2 of scoreMoves(g1)) {
        const v = effect(m2, mode);
        if (v > 1e-9) combos.push({ m1, m2, est: s1 + v });
      }
      continue;
    }
    // The first edge breaks or closes something within one piece.
    const broken = m1.breaks ? m1.breaks.owner : -1;
    const table1 = broken >= 0 && mode !== 'gain' ? tableFor(g1, broken) : null;
    const segs1 = g1.edgesOf(me).map((e) => [e.ax, e.ay, e.bx, e.by]);
    const faces1 = g1.analysis(me).faces;
    for (const m2 of g1.legalMoves()) {
      let v = 0;
      if (m2.breaks && mode !== 'gain') v += m2.breaks.owner === broken ? table1.get(m2.breaks.id) || 0 : lossOf(m2.breaks);
      if (m2.closes && mode !== 'cut') {
        const touches = segmentsTouch(m1.fx, m1.fy, m1.tx, m1.ty, m2.fx, m2.fy, m2.tx, m2.ty);
        const before = rootByKey.get(keyOf(m2));
        if (!touches && before) v += before.gain;
        else if (m2.crosses || !insideFaces(faces1, (m2.fx + m2.tx) / 2, (m2.fy + m2.ty) / 2)) {
          v += Math.max(0, analyzeArea([...segs1, [m2.fx, m2.fy, m2.tx, m2.ty]], false, B).area - g1.areas[me]);
        }
      }
      if (v > 1e-9) combos.push({ m1, m2, est: s1 + v });
    }
  }
  let greedy = bestSingle;
  {
    const g1 = g.clone();
    g1.play(bestSingleMove.fx, bestSingleMove.fy, bestSingleMove.tx, bestSingleMove.ty);
    if (g1.player === me && !g1.over) {
      let top = 0;
      for (const m2 of scoreMoves(g1)) top = Math.max(top, effect(m2, mode));
      greedy += top;
    }
  }
  combos.sort((a, b) => b.est - a.est);
  let best = -Infinity, sol = null, solPos = null;
  const exact = [];
  for (const c of combos) {
    if (c.est < best - 1e-9) break;
    const g2 = g.clone();
    g2.play(c.m1.fx, c.m1.fy, c.m1.tx, c.m1.ty);
    let m2 = c.m2;
    if (m2 === 'quiet') {
      m2 = g2.player === me && !g2.over ? g2.legalMoves().find((m) => !m.breaks && !m.closes) || null : null;
      c.m2 = m2;
    }
    if (m2 && g2.player === me && !g2.over) {
      if (!g2.check(m2.fx, m2.fy, m2.tx, m2.ty).ok) continue;
      g2.play(m2.fx, m2.fy, m2.tx, m2.ty);
    }
    const v = swingOf(g, g2, me, mode);
    exact.push({ c, v });
    if (v > best + 1e-9) { best = v; sol = c; solPos = g2; }
  }
  const firsts = new Set(exact.filter((x) => x.v >= best - 1e-6).map((x) => `${x.c.m1.fx},${x.c.m1.fy},${x.c.m1.tx},${x.c.m1.ty}`)).size;
  const edges = [sol.m1, sol.m2].filter((m) => m && m !== 'quiet').map((m) => [m.fx, m.fy, m.tx, m.ty]);
  return {
    best: Math.round(best * 1e6) / 1e6,
    greedy: Math.round(greedy * 1e6) / 1e6,
    sol: edges,
    firsts,
    gain: Math.round((solPos.areas[me] - g.areas[me]) * 1e6) / 1e6,
    cut: Math.round(g.enemiesOf(me).reduce((a, q) => a + g.areas[q] - solPos.areas[q], 0) * 1e6) / 1e6,
  };
}

// The most area the next enemy can open of `victim`'s with one edge, in
// position h (where that enemy is to move). Exact.
export function bestSingleCut(h, victim) {
  if (h.over || !h.isEnemy(h.player, victim)) return { cut: 0, move: null };
  const moves = h.legalMoves().filter((m) => m.breaks && m.breaks.owner === victim);
  if (!moves.length) return { cut: 0, move: null };
  const es = h.edgesOf(victim);
  const an = analyzeArea(es.map((x) => [x.ax, x.ay, x.bx, x.by]), true, h.rules.border ? h.S : 0);
  const table = new Map();
  es.forEach((x, i) => table.set(x.id, an.loss[i]));
  for (const m of moves) m.loss = table.get(m.breaks.id) || 0;
  moves.sort((a, b) => b.loss - a.loss);
  let best = 0, move = null;
  for (const m of moves) {
    if (m.loss <= best + 1e-9) break;
    const k = h.clone();
    k.play(m.fx, m.fy, m.tx, m.ty);
    const v = h.areas[victim] - k.areas[victim];
    if (v > best + 1e-9) { best = v; move = [m.fx, m.fy, m.tx, m.ty]; }
  }
  return { cut: Math.round(best * 1e6) / 1e6, move };
}

// Block puzzles: the mover has one edge left. Which edge leaves the next
// enemy's best single cut smallest? Returns { best, sol, worst, count }
// where count is how many edges reach the best and worst is the cut after
// the weakest legal edge.
export function solveBlock(g) {
  const me = g.player;
  if (g.over || g.left !== 1) return null;
  let best = Infinity, sol = null, worst = -Infinity, count = 0;
  const moves = g.legalMoves();
  for (const m of moves) {
    const h = g.clone();
    h.play(m.fx, m.fy, m.tx, m.ty);
    if (h.over) return null;
    const { cut } = bestSingleCut(h, me);
    if (cut < best - 1e-9) { best = cut; sol = [[m.fx, m.fy, m.tx, m.ty]]; count = 1; } else if (Math.abs(cut - best) <= 1e-9) count++;
    worst = Math.max(worst, cut);
  }
  return { best: Math.round(best * 1e6) / 1e6, worst: Math.round(worst * 1e6) / 1e6, sol, count, total: moves.length };
}
