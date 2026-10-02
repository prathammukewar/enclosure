// Rules engine for Enclosure. Pure logic, no DOM, shared by the page, the
// computer player (in a worker) and the tests.
//
// Board: a 19 x 19 grid of points, x = 0..18 left to right, y = 0..18 top to
// bottom. Blue starts with the edge (0,9)-(3,9), red with (15,9)-(18,9).
// Blue places 1 edge, then each side places 2 per turn, for 120 edges in all.
// After every turn both players add their enclosed area to their score.

import { segmentsTouch, interiorLatticePoints, analyzeArea, roundArea, gcd } from './geometry.js';

export const N = 19;
export const RADIUS = 3;
export const TOTAL_EDGES = 120;
export const BLUE = 0;
export const RED = 1;
export const START_EDGES = [[0, 9, 3, 9], [15, 9, 18, 9]];
export const PLAYER_NAMES = ['Blue', 'Red'];

const P = (x, y) => y * N + x;

export const REASONS = {
  over: 'The game is over.',
  notyours: 'Start from one of your own nodes.',
  same: 'Pick a different point.',
  range: 'Too far. Edges reach at most 3 points in each direction.',
  board: 'That point is off the board.',
  onown: "You can't put a node on your own edge.",
  throughown: "An edge can't pass through your own node.",
  dup: 'That edge is already there.',
  double: 'An edge can break only one enemy edge at a time.',
  shielded: 'That edge was just placed, so it is protected this turn.',
};

export function updatesAfter(placed) {
  // Score updates happen after edges 1, 3, 5, ..., 119 and 120.
  let n = 0;
  for (let e = placed + 1; e <= TOTAL_EDGES; e++) if (e % 2 === 1 || e === TOTAL_EDGES) n++;
  return n;
}

export class Game {
  // base (optional) describes a custom starting position, used by the
  // tutorial and the tests:
  // { edges: [[owner, ax, ay, bx, by, shield?]], player, turn, placed, scores }
  constructor(base = null) {
    this.base = base;
    this.deg = [new Uint8Array(N * N), new Uint8Array(N * N)];
    this.through = [new Uint8Array(N * N), new Uint8Array(N * N)];
    this.edges = new Map();
    this.keys = [new Map(), new Map()];
    this.nextId = 1;
    this.turn = 1;
    this.player = BLUE;
    this.left = 1;
    this.placed = 0;
    this.scores = [0, 0];
    this.areas = [0, 0];
    this.over = false;
    this.resigned = null;
    this.history = [];
    this.timeline = [];
    this._analysis = [null, null];
    if (!base) {
      for (let pl = 0; pl < 2; pl++) {
        const [ax, ay, bx, by] = START_EDGES[pl];
        this._addEdge(pl, ax, ay, bx, by, 0, 0);
      }
      return;
    }
    for (const [owner, ax, ay, bx, by, shield = 0] of base.edges) {
      this._addEdge(owner, ax, ay, bx, by, shield ? shield - 1 : 0, shield);
    }
    this.turn = base.turn || 1;
    this.player = base.player === undefined ? this.turn % 2 === 1 ? BLUE : RED : base.player;
    this.placed = base.placed === undefined ? Math.max(0, 2 * this.turn - 3) : base.placed;
    this.left = base.left || Math.min(this.turn === 1 ? 1 : 2, TOTAL_EDGES - this.placed);
    this.scores = base.scores ? base.scores.slice() : [0, 0];
    this.areas = [this._recompute(0), this._recompute(1)];
  }

  clone() {
    const g = Object.create(Game.prototype);
    g.base = this.base;
    g.deg = [this.deg[0].slice(), this.deg[1].slice()];
    g.through = [this.through[0].slice(), this.through[1].slice()];
    g.edges = new Map(this.edges);
    g.keys = [new Map(this.keys[0]), new Map(this.keys[1])];
    g.nextId = this.nextId;
    g.turn = this.turn;
    g.player = this.player;
    g.left = this.left;
    g.placed = this.placed;
    g.scores = this.scores.slice();
    g.areas = this.areas.slice();
    g.over = this.over;
    g.resigned = this.resigned;
    g.history = this.history.slice();
    g.timeline = this.timeline.slice();
    g._analysis = this._analysis.slice();
    return g;
  }

  static fromHistory(history, base = null) {
    const g = new Game(base);
    for (const m of history) g.apply(m);
    return g;
  }

  // ----- queries -----

  hasNode(pl, x, y) {
    return x >= 0 && y >= 0 && x < N && y < N && this.deg[pl][P(x, y)] > 0;
  }

  edgesOf(pl) {
    const out = [];
    for (const e of this.edges.values()) if (e.owner === pl) out.push(e);
    return out;
  }

  nodesOf(pl) {
    const out = [];
    const d = this.deg[pl];
    for (let p = 0; p < N * N; p++) if (d[p]) out.push([p % N, (p / N) | 0]);
    return out;
  }

  // Protected from the player to move: placed by the opponent last turn.
  isShielded(e) {
    return e.shield === this.turn && e.owner !== this.player;
  }

  // Fresh edges: still protected now, or protected on the next turn.
  isFresh(e) {
    return e.shield >= this.turn;
  }

  updatesLeft() {
    return this.over ? 0 : updatesAfter(this.placed);
  }

  analysis(pl) {
    if (!this._analysis[pl]) {
      const segs = this.edgesOf(pl).map((e) => [e.ax, e.ay, e.bx, e.by]);
      this._analysis[pl] = analyzeArea(segs);
    }
    return this._analysis[pl];
  }

  // Check an edge for the player to move, from (fx, fy) to (tx, ty).
  check(fx, fy, tx, ty) {
    return this._check(fx, fy, tx, ty, this.edges.values());
  }

  // Edges whose bounding box comes within reach of the point (x, y).
  _near(x, y) {
    const out = [];
    for (const e of this.edges.values()) {
      if (Math.max(e.ax, e.bx) < x - RADIUS || Math.min(e.ax, e.bx) > x + RADIUS) continue;
      if (Math.max(e.ay, e.by) < y - RADIUS || Math.min(e.ay, e.by) > y + RADIUS) continue;
      out.push(e);
    }
    return out;
  }

  _check(fx, fy, tx, ty, pool) {
    if (this.over) return fail('over');
    const me = this.player, op = 1 - me;
    if (!this.hasNode(me, fx, fy)) return fail('notyours');
    if (tx < 0 || ty < 0 || tx >= N || ty >= N) return fail('board');
    if (fx === tx && fy === ty) return fail('same');
    const dx = tx - fx, dy = ty - fy;
    if (Math.abs(dx) > RADIUS || Math.abs(dy) > RADIUS) return fail('range');
    const myDeg = this.deg[me];
    const toOwn = myDeg[P(tx, ty)] > 0;
    if (!toOwn && this.through[me][P(tx, ty)] > 0) return fail('onown');
    const steps = gcd(dx, dy);
    if (steps > 1) {
      const sx = dx / steps, sy = dy / steps;
      for (let k = 1; k < steps; k++) {
        if (myDeg[P(fx + sx * k, fy + sy * k)] > 0) return fail('throughown');
      }
    }
    if (toOwn && this.keys[me].has(edgeKey(P(fx, fy), P(tx, ty)))) return fail('dup');
    let hit = null, hits = 0, crosses = false;
    const minX = Math.min(fx, tx), maxX = Math.max(fx, tx), minY = Math.min(fy, ty), maxY = Math.max(fy, ty);
    for (const e of pool) {
      if (Math.max(e.ax, e.bx) < minX || Math.min(e.ax, e.bx) > maxX) continue;
      if (Math.max(e.ay, e.by) < minY || Math.min(e.ay, e.by) > maxY) continue;
      if (!segmentsTouch(fx, fy, tx, ty, e.ax, e.ay, e.bx, e.by)) continue;
      if (e.owner === op) {
        hits++;
        hit = e;
        if (hits > 1) return fail('double');
      } else if (!crosses) {
        // After the checks above, an own edge that shares the start node
        // meets the new edge nowhere else. Any other own edge it touches is
        // crossed (or ends at the end node), and that can close area.
        if (!((e.ax === fx && e.ay === fy) || (e.bx === fx && e.by === fy))) crosses = true;
      }
    }
    if (hit && this.isShielded(hit)) return fail('shielded', hit);
    return { ok: true, breaks: hit, closes: toOwn || crosses, crosses };
  }

  legalMoves() {
    const out = [];
    if (this.over) return out;
    const me = this.player;
    const d = this.deg[me];
    for (let p = 0; p < N * N; p++) {
      if (!d[p]) continue;
      const fx = p % N, fy = (p / N) | 0;
      const near = this._near(fx, fy);
      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
          if (!dx && !dy) continue;
          const tx = fx + dx, ty = fy + dy;
          if (tx < 0 || ty < 0 || tx >= N || ty >= N) continue;
          const r = this._check(fx, fy, tx, ty, near);
          if (r.ok) out.push({ fx, fy, tx, ty, breaks: r.breaks, closes: r.closes, crosses: r.crosses });
        }
      }
    }
    return out;
  }

  hasLegalMove() {
    if (this.over) return false;
    const me = this.player;
    const d = this.deg[me];
    for (let p = 0; p < N * N; p++) {
      if (!d[p]) continue;
      const fx = p % N, fy = (p / N) | 0;
      const near = this._near(fx, fy);
      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
          if (!dx && !dy) continue;
          if (this._check(fx, fy, fx + dx, fy + dy, near).ok) return true;
        }
      }
    }
    return false;
  }

  // ----- moves -----

  // m: { kind: 'edge', fx, fy, tx, ty } | { kind: 'pass' } | { kind: 'timeout' }
  apply(m) {
    if (m.kind === 'edge') return this.play(m.fx, m.fy, m.tx, m.ty);
    if (m.kind === 'pass') return this.pass();
    if (m.kind === 'timeout') return this.timeout();
    if (m.kind === 'resign') return this.resign(m.player);
    throw new Error('Unknown move');
  }

  play(fx, fy, tx, ty) {
    const r = this.check(fx, fy, tx, ty);
    if (!r.ok) throw new Error(r.reason);
    const me = this.player, op = 1 - me;
    let broke = null;
    if (r.breaks) {
      broke = r.breaks;
      this._removeEdge(broke);
      this.areas[op] = this._recompute(op);
    }
    const added = this._addEdge(me, fx, fy, tx, ty, this.turn, this.turn + 1);
    if (r.closes) this.areas[me] = this._recompute(me);
    const entry = { kind: 'edge', fx, fy, tx, ty, player: me, turn: this.turn, broke, edge: added, areas: this.areas.slice() };
    this.history.push({ kind: 'edge', fx, fy, tx, ty, player: me });
    this._advance(1);
    return entry;
  }

  // Skip one edge (used when a player has no legal move).
  pass() {
    if (this.over) throw new Error(REASONS.over);
    const me = this.player;
    this.history.push({ kind: 'pass', player: me });
    this._advance(1);
    return { kind: 'pass', player: me };
  }

  // Clock ran out: the rest of the turn is skipped and edges placed earlier
  // in this turn lose their protection.
  timeout() {
    if (this.over) throw new Error(REASONS.over);
    const me = this.player;
    for (const e of [...this.edges.values()]) {
      if (e.owner === me && e.turn === this.turn) this.edges.set(e.id, { ...e, shield: 0 });
    }
    this.history.push({ kind: 'timeout', player: me });
    this._advance(this.left);
    return { kind: 'timeout', player: me };
  }

  resign(pl = this.player) {
    if (this.over) throw new Error(REASONS.over);
    this.history.push({ kind: 'resign', player: pl });
    this.over = true;
    this.resigned = pl;
    return { kind: 'resign', player: pl };
  }

  winner() {
    if (!this.over) return null;
    if (this.resigned !== null) return 1 - this.resigned;
    const a = roundArea(this.scores[0]), b = roundArea(this.scores[1]);
    if (a === b) return -1;
    return a > b ? BLUE : RED;
  }

  // ----- internals -----

  _advance(count) {
    for (let i = 0; i < count; i++) {
      this.placed++;
      this.left--;
      if (this.left === 0) { this._endTurn(); break; }
    }
  }

  _endTurn() {
    this.scores[0] = roundArea(this.scores[0] + this.areas[0]);
    this.scores[1] = roundArea(this.scores[1] + this.areas[1]);
    this.timeline.push({ turn: this.turn, player: this.player, placed: this.placed, areas: this.areas.slice(), scores: this.scores.slice() });
    if (this.placed >= TOTAL_EDGES) {
      this.over = true;
      return;
    }
    this.turn++;
    this.player = 1 - this.player;
    this.left = Math.min(2, TOTAL_EDGES - this.placed);
  }

  _recompute(pl) {
    this._analysis[pl] = null;
    return this.analysis(pl).area;
  }

  _addEdge(pl, ax, ay, bx, by, turn, shield) {
    const a = P(ax, ay), b = P(bx, by);
    const e = { id: this.nextId++, owner: pl, ax, ay, bx, by, a, b, turn, shield };
    this.edges.set(e.id, e);
    this.keys[pl].set(edgeKey(a, b), e.id);
    this.deg[pl][a]++;
    this.deg[pl][b]++;
    for (const [ix, iy] of interiorLatticePoints(ax, ay, bx, by)) this.through[pl][P(ix, iy)]++;
    this._analysis[pl] = null;
    return e;
  }

  _removeEdge(e) {
    const pl = e.owner;
    this.edges.delete(e.id);
    this.keys[pl].delete(edgeKey(e.a, e.b));
    // A node left with no edges disappears with the edge.
    this.deg[pl][e.a]--;
    this.deg[pl][e.b]--;
    for (const [ix, iy] of interiorLatticePoints(e.ax, e.ay, e.bx, e.by)) this.through[pl][P(ix, iy)]--;
    this._analysis[pl] = null;
  }
}

function fail(code, edge = null) {
  return { ok: false, code, reason: REASONS[code], edge };
}

function edgeKey(a, b) {
  return a < b ? a * 400 + b : b * 400 + a;
}

// ----- notation and encoding -----

const COLS = 'abcdefghijklmnopqrs';

export function pointName(x, y) {
  return COLS[x] + (N - y);
}

export function moveName(m) {
  if (m.kind === 'pass') return 'pass';
  if (m.kind === 'timeout') return 'time';
  if (m.kind === 'resign') return 'resign';
  return pointName(m.fx, m.fy) + (m.broke ? 'x' : '-') + pointName(m.tx, m.ty);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PASS_CODE = N * N * 49;
const TIMEOUT_CODE = PASS_CODE + 1;
const RESIGN_CODE = PASS_CODE + 2;

export function encodeHistory(history) {
  let s = '';
  for (const m of history) {
    let v;
    if (m.kind === 'pass') v = PASS_CODE;
    else if (m.kind === 'timeout') v = TIMEOUT_CODE;
    else if (m.kind === 'resign') v = RESIGN_CODE + m.player;
    else v = P(m.fx, m.fy) * 49 + (m.ty - m.fy + 3) * 7 + (m.tx - m.fx + 3);
    s += B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
  }
  return s;
}

export function decodeHistory(s) {
  const out = [];
  if (typeof s !== 'string' || s.length % 3) throw new Error('Bad game code');
  for (let i = 0; i < s.length; i += 3) {
    const a = B64.indexOf(s[i]), b = B64.indexOf(s[i + 1]), c = B64.indexOf(s[i + 2]);
    if (a < 0 || b < 0 || c < 0) throw new Error('Bad game code');
    const v = (a << 12) | (b << 6) | c;
    if (v === PASS_CODE) out.push({ kind: 'pass' });
    else if (v === TIMEOUT_CODE) out.push({ kind: 'timeout' });
    else if (v === RESIGN_CODE || v === RESIGN_CODE + 1) out.push({ kind: 'resign', player: v - RESIGN_CODE });
    else if (v < PASS_CODE) {
      const p = Math.floor(v / 49), d = v % 49;
      const fx = p % N, fy = Math.floor(p / N);
      const dx = (d % 7) - 3, dy = Math.floor(d / 7) - 3;
      out.push({ kind: 'edge', fx, fy, tx: fx + dx, ty: fy + dy });
    } else throw new Error('Bad game code');
  }
  return out;
}

export function formatArea(a) {
  const r = Math.round(a * 100) / 100;
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(2).replace(/0$/, '');
}
