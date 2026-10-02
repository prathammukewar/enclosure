// Computer player. It plans a whole turn (one or two edges) at once: pick
// promising first edges, try the best replies for the second edge, and score
// each finished turn by the score gap plus the area income it expects, minus
// what the opponent can break on their next turn and how exposed each
// enclosed cell is.

import { analyzeArea, segmentsTouch } from './geometry.js';

export const LEVELS = {
  easy: { k1: 6, k2: 3, threat: false, noise: 4, blunder: 0.3, potential: 0, horizon: 3, budget: 400 },
  medium: { k1: 12, k2: 6, threat: true, noise: 1, blunder: 0.06, potential: 0, horizon: 6, budget: 700 },
  hard: { k1: 22, k2: 9, threat: true, noise: 0.1, blunder: 0, potential: 0, horizon: 9, budget: 1400, expose: 0.7 },
  expert: { k1: 30, k2: 12, threat: true, noise: 0.05, blunder: 0, potential: 0, horizon: 9, budget: 2600, expose: 0.7 },
};

// Personalities change what a level cares about, not how hard it searches.
export const STYLES = {
  balanced: {},
  builder: { wGain: 2.6, wLoss: 1.4, exMe: 1.4, exOp: 0.7, threatW: 1.2 },
  raider: { wGain: 1.5, wLoss: 3, exMe: 0.8, exOp: 1.5, approachQ: 1.1 },
  gambler: { threatW: 0.55, exMe: 0.6, horizon: 11, potential: 0.25, wGain: 2.4 },
};

export function levelConfig(level = 'hard', style = 'balanced', timeScale = 1) {
  const base = typeof level === 'string' ? LEVELS[level] || LEVELS.hard : level;
  const cfg = { ...base, ...(STYLES[style] || {}) };
  if (cfg.budget) cfg.budget = Math.round(cfg.budget * timeScale);
  return cfg;
}

const segOf = (e) => [e.ax, e.ay, e.bx, e.by];
const border = (g) => (g.rules.border ? g.S : 0);

function cheb(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

// Chebyshev distance from a point to a segment, sampled along the segment.
export function distToSeg(x, y, e) {
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

function enemyNodes(g, pl) {
  const out = [];
  for (const q of g.enemiesOf(pl)) for (const n of g.nodesOf(q)) out.push(n);
  return out;
}

// Loss table for one player's edges: edge id -> area opened if it breaks.
function lossTable(g, pl) {
  const es = g.edgesOf(pl);
  const an = analyzeArea(es.map(segOf), true, border(g));
  const m = new Map();
  es.forEach((e, i) => m.set(e.id, an.loss[i]));
  return m;
}

// Immediate effect of every legal move for the player to move:
// gain = own area added, loss = enemy area removed.
export function scoreMoves(g) {
  const me = g.player;
  const moves = g.legalMoves();
  const mySegs = g.edgesOf(me).map(segOf);
  const myFaces = g.analysis(me).faces;
  const tables = new Map();
  const base = g.areas[me];
  const B = border(g);
  let comp = null;
  for (const m of moves) {
    m.gain = 0;
    m.loss = 0;
    if (m.breaks) {
      const o = m.breaks.owner;
      if (!tables.has(o)) tables.set(o, lossTable(g, o));
      m.loss = tables.get(o).get(m.breaks.id) || 0;
    }
    if (!m.closes) continue;
    if (!m.crosses) {
      // Joining two separate pieces makes no loop (unless the board edge
      // joins them, in the border-wall variant).
      if (!B) {
        if (!comp) comp = pieces(g, me);
        if (comp.get(m.fy * g.S + m.fx) !== comp.get(m.ty * g.S + m.tx)) continue;
      }
      // A chord through area we already own cannot add any.
      if (insideAny(myFaces, (m.fx + m.tx) / 2, (m.fy + m.ty) / 2)) continue;
    }
    m.gain = Math.max(0, analyzeArea([...mySegs, [m.fx, m.fy, m.tx, m.ty]], false, B).area - base);
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

// Best loop a player could close next turn: with one edge (ends within
// reach) or two edges (ends within twice that). Estimated new area for each.
export function potential(g, pl, limit = 12) {
  const S = g.S, R = g.R;
  const adj = graphOf(g, pl);
  const nodes = [...adj.keys()];
  const segs = g.edgesOf(pl).map(segOf);
  const faces = g.analysis(pl).faces;
  const base = g.areas[pl];
  const cands = [];
  const polyArea = (pts) => {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      s += (a % S) * ((b / S) | 0) - (b % S) * ((a / S) | 0);
    }
    return Math.abs(s) / 2;
  };
  for (const u of nodes) {
    const ux = u % S, uy = (u / S) | 0;
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
      const vx = v % S, vy = (v / S) | 0;
      const d = cheb(ux, uy, vx, vy);
      if (d > 2 * R) continue;
      const path = [];
      for (let w = v; w !== -1; w = parent.get(w)) path.push(w);
      const a = polyArea(path);
      if (a < 1) continue;
      if (insideAny(faces, (ux + vx) / 2, (uy + vy) / 2)) continue;
      cands.push({ u, v, d, a });
    }
  }
  cands.sort((p, q) => q.a - p.a);
  let one = 0, two = 0, checked = 0;
  for (const c of cands) {
    if (checked >= 6) break;
    if (c.d > R && two >= c.a) continue;
    if (c.d <= R && one >= c.a && two >= c.a) continue;
    checked++;
    const s = [c.u % S, (c.u / S) | 0, c.v % S, (c.v / S) | 0];
    const gain = Math.max(0, analyzeArea([...segs, s], false, border(g)).area - base);
    if (c.d <= R) one = Math.max(one, gain);
    two = Math.max(two, gain);
  }
  return { one, two };
}

// Area the player to move in g can probably break from the victim during
// this turn: two direct breaks, or one approach edge and then a break.
export function threat(g, victim, cfg = {}) {
  const attacker = g.player;
  if (g.over || !g.isEnemy(attacker, victim)) return 0;
  const edges = g.edgesOf(victim);
  if (!edges.length || !g.areas[victim]) return 0;
  const R = g.R;
  const segs = edges.map(segOf);
  const an = analyzeArea(segs, true, border(g));
  const anodes = g.nodesOf(attacker);
  const direct = [], approach = [];
  edges.forEach((e, i) => {
    const loss = an.loss[i];
    if (loss <= 0 || g.isShielded(e)) return;
    let dist = Infinity;
    for (const [x, y] of anodes) dist = Math.min(dist, distToSeg(x, y, e));
    if (dist > 2 * R) return;
    if (dist <= R + 0.5 && canBreak(g, e, anodes)) direct.push({ i, loss });
    else approach.push({ i, loss });
  });
  direct.sort((a, b) => b.loss - a.loss);
  let best = direct.length ? direct[0].loss : 0;
  if (g.left >= 2) {
    if (direct.length >= 2) {
      const a = direct[0];
      for (const b of direct.slice(1, 5)) {
        const rest = segs.filter((_, j) => j !== a.i && j !== b.i);
        best = Math.max(best, an.area - analyzeArea(rest, false, border(g)).area);
      }
    }
    const aw = cfg.approachW ?? 0.7;
    for (const c of approach) best = Math.max(best, c.loss * aw);
  }
  return best;
}

export function canBreak(g, e, anodes) {
  const R = g.R, S = g.S;
  for (const [nx, ny] of anodes) {
    if (distToSeg(nx, ny, e) > R + 0.5) continue;
    let near = null;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (!dx && !dy) continue;
        const tx = nx + dx, ty = ny + dy;
        if (tx < 0 || ty < 0 || tx >= S || ty >= S) continue;
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
// legality details. A rough "pressure" term.
function pressure(g, attacker) {
  const anodes = g.nodesOf(attacker);
  let best = 0;
  for (const victim of g.enemiesOf(attacker)) {
    const edges = g.edgesOf(victim);
    if (!edges.length || !g.areas[victim]) continue;
    const an = analyzeArea(edges.map(segOf), true, border(g));
    edges.forEach((e, i) => {
      if (an.loss[i] <= best) return;
      for (const [x, y] of anodes) {
        if (distToSeg(x, y, e) <= g.R) { best = an.loss[i]; return; }
      }
    });
  }
  return best;
}

const P_BREAK = [0.6, 0.3, 0.12, 0.03];

// A face with no grid points strictly inside it.
function latticeFree(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  for (let y = Math.ceil(y0); y <= Math.floor(y1); y++) {
    for (let x = Math.ceil(x0); x <= Math.floor(x1); x++) {
      let onEdge = false, inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [ax, ay] = pts[j], [bx, by] = pts[i];
        const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        if (Math.abs(cr) < 1e-9 && x >= Math.min(ax, bx) - 1e-9 && x <= Math.max(ax, bx) + 1e-9 && y >= Math.min(ay, by) - 1e-9 && y <= Math.max(ay, by) + 1e-9) { onEdge = true; break; }
        if ((ay > y) !== (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay)) inside = !inside;
      }
      if (!onEdge && inside) return false;
    }
  }
  return true;
}

function gcdSmall(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

// A wall no enemy edge can ever break: no grid point in its middle, not
// crossed by its owner's other edges, joined to another edge at both ends,
// and bordering a cell with no grid points inside. Any edge that touches it
// either lands on a shared corner or crosses into that cell and has to
// leave through a second wall, touching two edges.
export function sealedWalls(g, pl, an = null) {
  const edges = g.edgesOf(pl);
  an = an || analyzeArea(edges.map(segOf), true, border(g));
  const free = an.faces.map((f) => latticeFree(f.pts));
  const deg = g.deg[pl], S = g.S;
  const out = new Set();
  edges.forEach((e, i) => {
    if (gcdSmall(e.bx - e.ax, e.by - e.ay) !== 1) return;
    if (deg[e.ay * S + e.ax] < 2 || deg[e.by * S + e.bx] < 2) return;
    const behind = an.opens[i];
    if (!behind.length) return;
    for (const other of edges) {
      if (other === e) continue;
      const shares = (other.ax === e.ax && other.ay === e.ay) || (other.bx === e.ax && other.by === e.ay) || (other.ax === e.bx && other.ay === e.by) || (other.bx === e.bx && other.by === e.by);
      if (!shares && segmentsTouch(e.ax, e.ay, e.bx, e.by, other.ax, other.ay, other.bx, other.by)) return;
    }
    if (behind.some((f) => free[f])) out.add(e.id);
  });
  return out;
}

// Expected area a player loses over the next few turns: each enclosed cell
// survives only if none of its outside walls is broken, and a wall is more
// likely to go the closer enemy nodes are to it. With detail, also returns
// each cell's chance of being opened.
export function exposure(g, pl, cfg = {}, detail = false) {
  if (!g.areas[pl]) return detail ? { lost: 0, cells: [] } : 0;
  const edges = g.edgesOf(pl);
  const an = analyzeArea(edges.map(segOf), true, border(g));
  const enemy = enemyNodes(g, pl);
  if (!enemy.length) return detail ? { lost: 0, cells: [] } : 0;
  const pb = cfg.pBreak || P_BREAK;
  const R = g.R;
  const survive = new Float64Array(an.faces.length).fill(1);
  const sealed = cfg.sealed ? sealedWalls(g, pl, an) : null;
  edges.forEach((e, i) => {
    const list = an.opens[i];
    if (!list.length || (sealed && sealed.has(e.id))) return;
    let d = Infinity;
    for (const [x, y] of enemy) { d = Math.min(d, distToSeg(x, y, e)); if (d <= 1) break; }
    const p = d <= R ? pb[0] : d <= 2 * R ? pb[1] : d <= 3 * R ? pb[2] : pb[3];
    for (const f of list) survive[f] *= 1 - p;
  });
  let lost = 0;
  an.faces.forEach((f, i) => { if (!f.nested) lost += f.area * (1 - survive[i]); });
  if (!detail) return lost;
  return { lost, cells: an.faces.map((f, i) => ({ pts: f.pts, area: f.area, nested: f.nested, risk: 1 - survive[i] })) };
}

// The side (player or team) that is the main rival of `me`: the strongest
// other side by score plus held area.
function rivalSide(g, me) {
  const my = g.sideOf(me);
  const sc = g.sideScores(), ar = g.sideAreas();
  const left = g.updatesLeft();
  let best = -1, bestV = -Infinity;
  for (let s = 0; s < g.sides; s++) {
    if (s === my) continue;
    const v = sc[s] + ar[s] * Math.min(left, 6);
    if (v > bestV) { bestV = v; best = s; }
  }
  return best;
}

// Value of a position for `me`, taken right after my turn ended. With
// parts, fills in the pieces of the score for explanations.
export function evaluate(g, me, cfg, parts = null) {
  const my = g.sideOf(me);
  const rival = rivalSide(g, me);
  const sc = g.sideScores();
  const diff = sc[my] - (rival >= 0 ? sc[rival] : 0);
  if (g.over) { if (parts) Object.assign(parts, { diff, final: true }); return diff; }
  const R = g.updatesLeft();
  const members = g.membersOf(my), rivals = rival >= 0 ? g.membersOf(rival) : [];
  const myA = members.reduce((a, p) => a + g.areas[p], 0);
  const opA = rivals.reduce((a, p) => a + g.areas[p], 0);
  // The next player attacks before our next update.
  let lost = 0;
  if (cfg.threat && !g.over && g.sideOf(g.player) !== my) {
    for (const p of members) lost += threat(g, p, cfg);
    lost *= cfg.threatW ?? 1;
  }
  const noPot = { one: 0, two: 0 };
  const pot = (ps) => (cfg.potential ? ps.reduce((a, p) => a + potential(g, p).two, 0) : 0);
  const myPot = cfg.potential ? pot(members) : 0, opPot = cfg.potential ? pot(rivals) : 0;
  void noPot;
  const rho = cfg.rho ?? 0.88;
  const next = (myA - lost) - (opA + opPot * cfg.potential);
  let later = 0, w = 1;
  const horizon = Math.min(R - 1, cfg.horizon);
  for (let k = 0; k < horizon; k++) { w *= rho; later += w; }
  let steady, exMe = 0, exOp = 0, atk = 0;
  if (cfg.expose) {
    const k = cfg.expose;
    exMe = members.reduce((a, p) => a + exposure(g, p, cfg), 0) * k * (cfg.exMe ?? 1);
    exOp = rivals.reduce((a, p) => a + exposure(g, p, cfg), 0) * k * (cfg.exOp ?? 1);
    steady = (myA - lost - exMe + myPot * cfg.potential) - (opA - exOp + opPot * cfg.potential);
  } else {
    atk = members.reduce((a, p) => Math.max(a, pressure(g, p)), 0);
    steady = (myA - lost + myPot * cfg.potential) - (opA + opPot * cfg.potential - atk * (cfg.atk ?? 0.5));
  }
  const value = diff + next + later * steady;
  if (parts) Object.assign(parts, { diff, myArea: myA, rivalArea: opA, lost, exMe, exOp, atk, later, value });
  return value;
}

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Quick ordering score for a move, before any lookahead.
function quick(m, maps, cfg) {
  const k = m.tx * 100 + m.ty;
  return (cfg.wGain ?? 2) * m.gain + (cfg.wLoss ?? 2) * m.loss
    + (maps.setup.get(k) || 0) * (cfg.setupQ ?? 0.5) + (maps.approach.get(k) || 0) * (cfg.approachQ ?? 0.6);
}

// Points from which a single edge could close a loop next move, and points
// from which a breakable enemy edge with area behind it is in reach.
function targetsMaps(g) {
  const me = g.player, S = g.S, R = g.R;
  const setup = new Map(), approach = new Map();
  const adj = graphOf(g, me);
  const nodes = [...adj.keys()];
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i], ax = a % S, ay = (a / S) | 0;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j], bx = b % S, by = (b / S) | 0;
      if (cheb(ax, ay, bx, by) > 2 * R) continue;
      const est = Math.abs((bx - ax) * 3) + Math.abs((by - ay) * 3);
      for (let ty = Math.max(0, Math.max(ay, by) - R); ty <= Math.min(S - 1, Math.min(ay, by) + R); ty++) {
        for (let tx = Math.max(0, Math.max(ax, bx) - R); tx <= Math.min(S - 1, Math.min(ax, bx) + R); tx++) {
          const k = tx * 100 + ty;
          const tri = Math.abs((bx - ax) * (ty - ay) - (by - ay) * (tx - ax)) / 2;
          const v = Math.min(est, tri + 1);
          if (v > (setup.get(k) || 0)) setup.set(k, v);
        }
      }
    }
  }
  for (const op of g.enemiesOf(me)) {
    if (!(g.areas[op] > 0)) continue;
    const opEdges = g.edgesOf(op);
    const an = analyzeArea(opEdges.map(segOf), true, border(g));
    opEdges.forEach((e, i) => {
      if (an.loss[i] <= 0 || g.isShielded(e)) return;
      const x0 = Math.max(0, Math.min(e.ax, e.bx) - R), x1 = Math.min(S - 1, Math.max(e.ax, e.bx) + R);
      const y0 = Math.max(0, Math.min(e.ay, e.by) - R), y1 = Math.min(S - 1, Math.max(e.ay, e.by) + R);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (distToSeg(x, y, e) > R) continue;
        const k = x * 100 + y;
        if (an.loss[i] > (approach.get(k) || 0)) approach.set(k, an.loss[i]);
      }
    });
  }
  return { setup, approach };
}

function pickTop(moves, k, rand, maps, cfg) {
  const scored = moves.map((m) => ({ m, q: quick(m, maps, cfg) + rand() * cfg.noise }));
  scored.sort((a, b) => b.q - a.q);
  const out = scored.slice(0, k).map((s) => s.m);
  // Keep a little variety: a couple of random quiet moves.
  for (let i = 0; i < 2 && moves.length > k; i++) out.push(moves[Math.floor(rand() * moves.length)]);
  return out;
}

const asMove = (m) => ({ kind: 'edge', fx: m.fx, fy: m.fy, tx: m.tx, ty: m.ty });

// The adaptive level plays harder when it is behind and eases off when it
// is far ahead, to keep games close.
function adaptiveConfig(g, me) {
  const my = g.sideOf(me);
  const rival = rivalSide(g, me);
  const sc = g.sideScores(), ar = g.sideAreas();
  const left = g.updatesLeft();
  const proj = (s) => sc[s] + ar[s] * left;
  const lead = rival >= 0 ? proj(my) - proj(rival) : 0;
  const scale = Math.max(150, (proj(my) + (rival >= 0 ? proj(rival) : 0)) * 0.12);
  if (lead > scale * 1.5) return { ...LEVELS.easy, blunder: 0.15 };
  if (lead > scale * 0.5) return LEVELS.medium;
  return LEVELS.hard;
}

// Plan the rest of the current turn. Returns a list of moves to play in
// order. With opts.explain, returns { plan, options } where options are the
// best few turns it looked at, with the parts of their scores.
export function planTurn(game, level = 'hard', seed = Date.now(), opts = {}) {
  const me = game.player;
  let cfg = level === 'adaptive' ? adaptiveConfig(game, me) : (typeof level === 'string' ? LEVELS[level] || LEVELS.hard : level);
  if (opts.style || opts.timeScale) cfg = levelConfig(cfg, opts.style || 'balanced', opts.timeScale || 1);
  const rand = rng(seed);
  const g = game.clone();
  const wrap = (plan, options = []) => (opts.explain ? { plan, options } : plan);
  if (g.over) return wrap([]);
  if (opts.book) {
    const b = opts.book(g);
    if (b) return wrap(b);
  }
  const first = scoreMoves(g);
  if (!first.length) return wrap(Array.from({ length: g.left }, () => ({ kind: 'pass' })));

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
    return wrap(out);
  }

  const maps1 = targetsMaps(g);
  const tops = pickTop(first, cfg.k1, rand, maps1, cfg);
  let best = null, bestV = -Infinity;
  const seen = [];
  const consider = (v, plan, pos) => {
    if (v > bestV) { bestV = v; best = plan; }
    if (opts.explain || cfg.reply) seen.push({ v, plan, pos });
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
      while (g2.player === me && !g2.over) g2.pass();
      consider(evaluate(g2, me, cfg), [asMove(m1), { kind: 'pass' }], g2);
      continue;
    }
    const maps2 = targetsMaps(g1);
    for (const m2 of pickTop(second, cfg.k2, rand, maps2, cfg)) {
      const g2 = g1.clone();
      g2.play(m2.fx, m2.fy, m2.tx, m2.ty);
      // Handicap turns can have more than two edges; finish them greedily.
      const plan = [asMove(m1), asMove(m2)];
      while (g2.player === me && !g2.over) {
        const more = scoreMoves(g2);
        if (!more.length) { g2.pass(); plan.push({ kind: 'pass' }); continue; }
        more.sort((a, b) => (b.gain + b.loss) - (a.gain + a.loss));
        g2.play(more[0].fx, more[0].fy, more[0].tx, more[0].ty);
        plan.push(asMove(more[0]));
      }
      consider(evaluate(g2, me, cfg) + rand() * cfg.noise * 0.1, plan, g2);
    }
  }
  if (cfg.reply && seen.length > 1) {
    // Look one turn further for the best few: let the next player answer,
    // then judge the position we would face.
    seen.sort((a, b) => b.v - a.v);
    let bestReply = -Infinity;
    for (const f of seen.slice(0, cfg.reply)) {
      const h = f.pos.clone();
      let guard = 0;
      while (!h.over && h.player !== me && guard++ < 8) {
        const answer = planTurn(h, { ...LEVELS.medium, blunder: 0, noise: 0, budget: 250 }, seed + 7);
        for (const m of answer) h.apply(m);
      }
      const v = evaluate(h, me, { ...cfg, threat: false });
      if (v > bestReply) { bestReply = v; best = f.plan; }
    }
  }
  if (!opts.explain) return best;
  seen.sort((a, b) => b.v - a.v);
  const options = [];
  const keyOf = (p) => p.map((m) => `${m.fx},${m.fy},${m.tx},${m.ty}`).join('|');
  const used = new Set();
  for (const f of [{ plan: best, pos: null, v: bestV }, ...seen]) {
    const k = keyOf(f.plan);
    if (used.has(k)) continue;
    used.add(k);
    const h = g.clone();
    for (const m of f.plan) h.apply(m);
    const parts = {};
    evaluate(h, me, cfg, parts);
    options.push({ plan: f.plan, gain: h.areas[me] - g.areas[me], cut: g.enemiesOf(me).reduce((a, q) => a + (g.areas[q] - h.areas[q]), 0), ...parts });
    if (options.length >= 3) break;
  }
  return { plan: best, options };
}

// Marks for the "weak walls" view, for the player to move: their walls with
// area behind them that an enemy can reach next turn, and enemy walls with
// area behind them that can be broken right now.
export function coachMarks(g) {
  const me = g.player;
  const weak = [], targets = [];
  if (g.over) return { weak, targets };
  const mine = g.edgesOf(me);
  if (g.areas[me] > 0) {
    const an = analyzeArea(mine.map(segOf), true, border(g));
    const onodes = enemyNodes(g, me);
    mine.forEach((e, i) => {
      // Edges placed this turn will be protected on the next one.
      if (an.loss[i] <= 0 || (g.rules.protect && e.turn === g.turn)) return;
      for (const [x, y] of onodes) {
        if (distToSeg(x, y, e) <= g.R) { weak.push({ ...e, loss: an.loss[i] }); return; }
      }
    });
  }
  const mnodes = g.nodesOf(me);
  for (const op of g.enemiesOf(me)) {
    if (!(g.areas[op] > 0)) continue;
    const theirs = g.edgesOf(op);
    const an = analyzeArea(theirs.map(segOf), true, border(g));
    theirs.forEach((e, i) => {
      if (an.loss[i] <= 0 || g.isShielded(e)) return;
      if (canBreak(g, e, mnodes)) targets.push({ ...e, loss: an.loss[i] });
    });
  }
  return { weak, targets };
}

// The best single edge the next enemy could play against `me` if my turn
// ended now: { move, swing, cut } or null. Used for the warning preview.
export function nextEnemyBest(game, me) {
  const h = game.clone();
  while (!h.over && h.player === me) h.pass();
  if (h.over || !h.isEnemy(h.player, me)) return null;
  const moves = scoreMoves(h);
  let best = null;
  for (const m of moves) {
    if (!m.breaks || m.breaks.owner !== me) continue;
    if (!best || m.loss > best.loss) best = m;
  }
  if (!best || best.loss <= 1e-9) return null;
  const k = h.clone();
  k.play(best.fx, best.fy, best.tx, best.ty);
  return { move: asMove(best), player: h.player, cut: game.areas[me] - k.areas[me] };
}
