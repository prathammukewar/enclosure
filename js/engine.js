// Rules engine for Enclosure. Pure logic, no DOM, shared by the page, the
// computer player (in a worker) and the tests.
//
// Standard game: a 19 x 19 grid of points, x = 0..18 left to right, y = 0..18
// top to bottom. Blue starts with the edge (0,9)-(3,9), Red with
// (15,9)-(18,9). Blue places 1 edge, then each side places 2 per turn, for
// 120 edges in all. After every turn every player adds their enclosed area
// to their score.
//
// Variants (all optional, see makeRules): board size, reach, 3 or 4 players,
// 2 v 2 teams, edges per player, protection off, the board border counting
// as a wall, timeout and no-legal-move behaviour, and handicap edges.

import { segmentsTouch, interiorLatticePoints, analyzeArea, roundArea, gcd } from './geometry.js';

export const BLUE = 0;
export const RED = 1;
export const PLAYER_NAMES = ['Blue', 'Red', 'Green', 'Gold'];

export const DEFAULT_RULES = Object.freeze({
  size: 19,
  radius: 3,
  players: 2,
  teams: false,
  perPlayer: 60,
  protect: true,
  border: false,
  timeout: 'turn',
  stuck: 'edge',
  handicap: Object.freeze([0, 0, 0, 0]),
});

// Standard-game constants, kept for code that only deals with the standard board.
export const N = 19;
export const RADIUS = 3;
export const TOTAL_EDGES = 120;
export const START_EDGES = [[0, 9, 3, 9], [15, 9, 18, 9]];

const clampInt = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

// Fills in and validates a rules object.
export function makeRules(r = {}) {
  const d = DEFAULT_RULES;
  let size = clampInt(r.size ?? d.size, 9, 25, d.size);
  if (size % 2 === 0) size += 1;
  const players = clampInt(r.players ?? d.players, 2, 4, 2);
  const h = Array.isArray(r.handicap) ? r.handicap : [];
  return {
    size,
    radius: clampInt(r.radius ?? d.radius, 2, 4, 3),
    players,
    teams: players === 4 && !!r.teams,
    perPlayer: clampInt(r.perPlayer ?? d.perPlayer, 6, 150, 60),
    protect: r.protect === undefined ? true : !!r.protect,
    border: !!r.border,
    timeout: r.timeout === 'edge' ? 'edge' : 'turn',
    stuck: r.stuck === 'turn' ? 'turn' : 'edge',
    handicap: [0, 1, 2, 3].map((i) => (i < players ? clampInt(h[i] ?? 0, 0, 6, 0) : 0)),
  };
}

export function isDefaultRules(r) {
  return encodeRules(r) === '';
}

// Starting edges: left, right, top and bottom of the middle lines.
export function startEdges(rules) {
  const S = rules.size, m = (S - 1) / 2, L = 3;
  const all = [
    [0, 0, m, L, m],
    [1, S - 1 - L, m, S - 1, m],
    [2, m, 0, m, L],
    [3, m, S - 1 - L, m, S - 1],
  ];
  return all.slice(0, rules.players);
}

export const REASONS = {
  over: 'The game is over.',
  notyours: 'Start from one of your own nodes.',
  same: 'Pick a different point.',
  range: 'Too far. Edges reach at most {r} points in each direction.',
  board: 'That point is off the board.',
  onown: "You can't put a node on your own edge.",
  throughown: "An edge can't pass through your own node.",
  dup: 'That edge is already there.',
  double: 'An edge can break only one enemy edge at a time.',
  shielded: 'That edge was just placed, so it is protected this turn.',
  ally: "You can't touch a teammate's edge.",
};

// Score updates after edges 1, 3, 5, ..., 119 and 120 in the standard game.
export function updatesAfter(placed) {
  let n = 0;
  for (let e = placed + 1; e <= TOTAL_EDGES; e++) if (e % 2 === 1 || e === TOTAL_EDGES) n++;
  return n;
}

export class Game {
  // base (optional) describes a custom starting position:
  // { edges: [[owner, ax, ay, bx, by, shield?]], player, turn, placed, left,
  //   scores, rules }
  // An edge with shield s was placed on turn s - 1 and is protected on turn s.
  constructor(base = null, rules = null) {
    const R = makeRules(rules || (base && base.rules) || {});
    this.rules = R;
    this.S = R.size;
    this.R = R.radius;
    this.NP = R.players;
    this.base = base;
    const cells = this.S * this.S;
    this.deg = Array.from({ length: this.NP }, () => new Uint8Array(cells));
    this.through = Array.from({ length: this.NP }, () => new Uint8Array(cells));
    this.keys = Array.from({ length: this.NP }, () => new Map());
    this.edges = new Map();
    this.nextId = 1;
    this.turn = 1;
    this.player = 0;
    this.placed = 0;
    this.remaining = Array.from({ length: this.NP }, (_, p) => R.perPlayer + R.handicap[p]);
    this.started = new Array(this.NP).fill(false);
    this.lastTurn = new Array(this.NP).fill(0);
    this.turnSize = 1;
    this.scores = new Array(this.NP).fill(0);
    this.areas = new Array(this.NP).fill(0);
    this.over = false;
    this.resigned = null;
    this.history = [];
    this.timeline = [];
    this._analysis = new Array(this.NP).fill(null);
    if (!base) {
      for (const [o, ax, ay, bx, by] of startEdges(R)) this._addEdge(o, ax, ay, bx, by, 0);
      this._beginTurn(0);
      return;
    }
    // A custom position: replay the turn structure up to base.turn.
    const turn = Math.max(1, base.turn || 1);
    let p = 0;
    for (let t = 1; t < turn; t++) {
      const size = this._turnLength(p);
      this.started[p] = true;
      this.lastTurn[p] = t;
      this.remaining[p] -= size;
      this.placed += size;
      p = this._nextPlayer(p);
      if (p < 0) break;
    }
    this.turn = turn;
    this.player = base.player === undefined ? Math.max(0, p) : base.player;
    if (base.placed !== undefined) this.placed = base.placed;
    for (let q = 0; q < this.NP; q++) this.lastTurn[q] = 0;
    for (const [owner, ax, ay, bx, by, shield = 0] of base.edges) {
      this._addEdge(owner, ax, ay, bx, by, shield ? shield - 1 : 0);
      if (shield) this.lastTurn[owner] = Math.max(this.lastTurn[owner], shield - 1);
    }
    this.turnSize = this._turnLength(this.player);
    this.left = base.left || this.turnSize;
    this.started[this.player] = true;
    this.lastTurn[this.player] = this.turn;
    if (base.scores) for (let q = 0; q < this.NP; q++) this.scores[q] = base.scores[q] || 0;
    for (let q = 0; q < this.NP; q++) this.areas[q] = this._recompute(q);
  }

  clone() {
    const g = Object.create(Game.prototype);
    g.rules = this.rules;
    g.S = this.S;
    g.R = this.R;
    g.NP = this.NP;
    g.base = this.base;
    g.deg = this.deg.map((a) => a.slice());
    g.through = this.through.map((a) => a.slice());
    g.keys = this.keys.map((k) => new Map(k));
    g.edges = new Map(this.edges);
    g.nextId = this.nextId;
    g.turn = this.turn;
    g.player = this.player;
    g.left = this.left;
    g.turnSize = this.turnSize;
    g.placed = this.placed;
    g.remaining = this.remaining.slice();
    g.started = this.started.slice();
    g.lastTurn = this.lastTurn.slice();
    g.scores = this.scores.slice();
    g.areas = this.areas.slice();
    g.over = this.over;
    g.resigned = this.resigned;
    g.history = this.history.slice();
    g.timeline = this.timeline.slice();
    g._analysis = this._analysis.slice();
    return g;
  }

  static fromHistory(history, base = null, rules = null) {
    const g = new Game(base, rules);
    for (const m of history) g.apply(m);
    return g;
  }

  // ----- sides and teams -----

  get sides() { return this.rules.teams ? 2 : this.NP; }
  sideOf(p) { return this.rules.teams ? p % 2 : p; }
  isEnemy(a, b) { return this.sideOf(a) !== this.sideOf(b); }
  isAlly(a, b) { return a !== b && this.sideOf(a) === this.sideOf(b); }
  enemiesOf(p) {
    const out = [];
    for (let q = 0; q < this.NP; q++) if (this.isEnemy(p, q)) out.push(q);
    return out;
  }
  membersOf(side) {
    const out = [];
    for (let q = 0; q < this.NP; q++) if (this.sideOf(q) === side) out.push(q);
    return out;
  }
  sideScores() {
    const out = new Array(this.sides).fill(0);
    for (let q = 0; q < this.NP; q++) out[this.sideOf(q)] += this.scores[q];
    return out.map(roundArea);
  }
  sideAreas() {
    const out = new Array(this.sides).fill(0);
    for (let q = 0; q < this.NP; q++) out[this.sideOf(q)] += this.areas[q];
    return out.map(roundArea);
  }

  get totalEdges() {
    let t = 0;
    for (let p = 0; p < this.NP; p++) t += this.rules.perPlayer + this.rules.handicap[p];
    return t;
  }

  // ----- queries -----

  P(x, y) { return y * this.S + x; }

  inBoard(x, y) { return x >= 0 && y >= 0 && x < this.S && y < this.S; }

  hasNode(pl, x, y) {
    return this.inBoard(x, y) && this.deg[pl][y * this.S + x] > 0;
  }

  // The player whose node (or edge end) is at (x, y), or -1.
  ownerAt(x, y) {
    if (!this.inBoard(x, y)) return -1;
    const p = y * this.S + x;
    for (let q = 0; q < this.NP; q++) if (this.deg[q][p]) return q;
    return -1;
  }

  edgesOf(pl) {
    const out = [];
    for (const e of this.edges.values()) if (e.owner === pl) out.push(e);
    return out;
  }

  nodesOf(pl) {
    const out = [];
    const d = this.deg[pl], S = this.S;
    for (let p = 0; p < S * S; p++) if (d[p]) out.push([p % S, (p / S) | 0]);
    return out;
  }

  // Protected from the player to move: placed by another player on that
  // player's most recent turn.
  isShielded(e) {
    return this.rules.protect && e.turn > 0 && !e.noShield && e.owner !== this.player && e.turn === this.lastTurn[e.owner];
  }

  // New edges: protected now, or protected once the current turn ends.
  isFresh(e) {
    return this.rules.protect && e.turn > 0 && !e.noShield && e.turn === this.lastTurn[e.owner];
  }

  // Turns still to come, counting the current one. Each ends in a score update.
  updatesLeft() {
    if (this.over) return 0;
    const rem = this.remaining.slice();
    const started = this.started.slice();
    rem[this.player] -= this.left;
    let count = 1, p = this.player;
    for (;;) {
      p = nextWith(rem, p, this.NP);
      if (p < 0) break;
      const size = Math.min(rem[p], 2 + (started[p] ? 0 : this.rules.handicap[p]));
      started[p] = true;
      rem[p] -= size;
      count++;
    }
    return count;
  }

  analysis(pl) {
    if (!this._analysis[pl]) {
      const segs = this.edgesOf(pl).map((e) => [e.ax, e.ay, e.bx, e.by]);
      this._analysis[pl] = analyzeArea(segs, false, this.rules.border ? this.S : 0);
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
    const R = this.R;
    for (const e of this.edges.values()) {
      if (Math.max(e.ax, e.bx) < x - R || Math.min(e.ax, e.bx) > x + R) continue;
      if (Math.max(e.ay, e.by) < y - R || Math.min(e.ay, e.by) > y + R) continue;
      out.push(e);
    }
    return out;
  }

  _check(fx, fy, tx, ty, pool) {
    if (this.over) return fail('over');
    const me = this.player, S = this.S;
    if (!this.hasNode(me, fx, fy)) return fail('notyours');
    if (!this.inBoard(tx, ty)) return fail('board');
    if (fx === tx && fy === ty) return fail('same');
    const dx = tx - fx, dy = ty - fy;
    if (Math.abs(dx) > this.R || Math.abs(dy) > this.R) return fail('range', null, this.R);
    const myDeg = this.deg[me];
    const toOwn = myDeg[ty * S + tx] > 0;
    if (!toOwn && this.through[me][ty * S + tx] > 0) return fail('onown');
    const steps = gcd(dx, dy);
    if (steps > 1) {
      const sx = dx / steps, sy = dy / steps;
      for (let k = 1; k < steps; k++) {
        if (myDeg[(fy + sy * k) * S + fx + sx * k] > 0) return fail('throughown');
      }
    }
    if (toOwn && this.keys[me].has(edgeKey(fy * S + fx, ty * S + tx))) return fail('dup');
    let hit = null, hits = 0, crosses = false;
    const minX = Math.min(fx, tx), maxX = Math.max(fx, tx), minY = Math.min(fy, ty), maxY = Math.max(fy, ty);
    for (const e of pool) {
      if (Math.max(e.ax, e.bx) < minX || Math.min(e.ax, e.bx) > maxX) continue;
      if (Math.max(e.ay, e.by) < minY || Math.min(e.ay, e.by) > maxY) continue;
      if (!segmentsTouch(fx, fy, tx, ty, e.ax, e.ay, e.bx, e.by)) continue;
      if (e.owner === me) {
        // After the checks above, an own edge that shares the start node
        // meets the new edge nowhere else. Any other own edge it touches is
        // crossed (or ends at the end node), and that can close area.
        if (!crosses && !((e.ax === fx && e.ay === fy) || (e.bx === fx && e.by === fy))) crosses = true;
      } else if (this.isAlly(me, e.owner)) {
        return fail('ally', e);
      } else {
        hits++;
        hit = e;
        // Two enemy edges already; keep looking only for a teammate's edge,
        // which takes priority as the reason.
        if (hits > 1 && !this.rules.teams) return fail('double');
      }
    }
    if (hits > 1) return fail('double');
    if (hit && this.isShielded(hit)) return fail('shielded', hit);
    // With border walls, reaching the edge of the board can close area too.
    const toBorder = this.rules.border && (tx === 0 || ty === 0 || tx === S - 1 || ty === S - 1);
    return { ok: true, breaks: hit, closes: toOwn || crosses || toBorder, crosses };
  }

  legalMoves() {
    const out = [];
    if (this.over) return out;
    const me = this.player, S = this.S, R = this.R;
    const d = this.deg[me];
    for (let p = 0; p < S * S; p++) {
      if (!d[p]) continue;
      const fx = p % S, fy = (p / S) | 0;
      const near = this._near(fx, fy);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (!dx && !dy) continue;
          const tx = fx + dx, ty = fy + dy;
          if (tx < 0 || ty < 0 || tx >= S || ty >= S) continue;
          const r = this._check(fx, fy, tx, ty, near);
          if (r.ok) out.push({ fx, fy, tx, ty, breaks: r.breaks, closes: r.closes, crosses: r.crosses });
        }
      }
    }
    return out;
  }

  hasLegalMove() {
    if (this.over) return false;
    const me = this.player, S = this.S, R = this.R;
    const d = this.deg[me];
    for (let p = 0; p < S * S; p++) {
      if (!d[p]) continue;
      const fx = p % S, fy = (p / S) | 0;
      const near = this._near(fx, fy);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (!dx && !dy) continue;
          if (this._check(fx, fy, fx + dx, fy + dy, near).ok) return true;
        }
      }
    }
    return false;
  }

  // ----- moves -----

  // m: { kind: 'edge', fx, fy, tx, ty } | { kind: 'pass' } | { kind: 'timeout' } | { kind: 'resign', player }
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
    const me = this.player;
    let broke = null;
    if (r.breaks) {
      broke = r.breaks;
      this._removeEdge(broke);
      this.areas[broke.owner] = this._recompute(broke.owner);
    }
    const added = this._addEdge(me, fx, fy, tx, ty, this.turn);
    if (r.closes) this.areas[me] = this._recompute(me);
    const entry = { kind: 'edge', fx, fy, tx, ty, player: me, turn: this.turn, broke, edge: added, areas: this.areas.slice() };
    this.history.push({ kind: 'edge', fx, fy, tx, ty, player: me });
    this._advance(1);
    return entry;
  }

  // No legal move: skip one edge (or the rest of the turn, by the rules).
  pass() {
    if (this.over) throw new Error(REASONS.over);
    const me = this.player;
    this.history.push({ kind: 'pass', player: me });
    this._advance(this.rules.stuck === 'turn' ? this.left : 1);
    return { kind: 'pass', player: me };
  }

  // Clock ran out. Standard rule: the rest of the turn is skipped and edges
  // placed earlier in this turn lose their protection. Per-edge rule: only
  // the current edge is skipped.
  timeout() {
    if (this.over) throw new Error(REASONS.over);
    const me = this.player;
    this.history.push({ kind: 'timeout', player: me });
    if (this.rules.timeout === 'edge') {
      this._advance(1);
    } else {
      for (const e of [...this.edges.values()]) {
        if (e.owner === me && e.turn === this.turn) this.edges.set(e.id, { ...e, noShield: true });
      }
      this._advance(this.left);
    }
    return { kind: 'timeout', player: me };
  }

  resign(pl = this.player) {
    if (this.over) throw new Error(REASONS.over);
    this.history.push({ kind: 'resign', player: pl });
    this.over = true;
    this.resigned = pl;
    return { kind: 'resign', player: pl };
  }

  // Winning side (a player, or a team index in team games), -1 for a draw,
  // null while the game is running.
  winner() {
    if (!this.over) return null;
    const sc = this.sideScores();
    const out = this.resigned !== null ? this.sideOf(this.resigned) : -1;
    let best = -Infinity, who = -1, tie = false;
    for (let s = 0; s < sc.length; s++) {
      if (s === out) continue;
      if (sc[s] > best) { best = sc[s]; who = s; tie = false; } else if (sc[s] === best) tie = true;
    }
    return tie ? -1 : who;
  }

  pointName(x, y) { return pointName(x, y, this.S); }

  moveName(m) { return moveName(m, this.S); }

  // ----- internals -----

  _turnLength(p) {
    return Math.min(this.remaining[p], (p === 0 && !this.started[0] ? 1 : 2) + (this.started[p] ? 0 : this.rules.handicap[p]));
  }

  _nextPlayer(p) {
    return nextWith(this.remaining, p, this.NP);
  }

  _beginTurn(p) {
    this.player = p;
    this.turnSize = this._turnLength(p);
    this.left = this.turnSize;
    this.started[p] = true;
    this.lastTurn[p] = this.turn;
  }

  _advance(count) {
    for (let i = 0; i < count; i++) {
      this.placed++;
      this.remaining[this.player]--;
      this.left--;
      if (this.left <= 0) { this._endTurn(); break; }
    }
  }

  _endTurn() {
    for (let q = 0; q < this.NP; q++) this.scores[q] = roundArea(this.scores[q] + this.areas[q]);
    this.timeline.push({ turn: this.turn, player: this.player, placed: this.placed, areas: this.areas.slice(), scores: this.scores.slice() });
    const next = this._nextPlayer(this.player);
    if (next < 0) {
      this.over = true;
      return;
    }
    this.turn++;
    this._beginTurn(next);
  }

  _recompute(pl) {
    this._analysis[pl] = null;
    return this.analysis(pl).area;
  }

  _addEdge(pl, ax, ay, bx, by, turn) {
    const S = this.S;
    const a = ay * S + ax, b = by * S + bx;
    const e = { id: this.nextId++, owner: pl, ax, ay, bx, by, a, b, turn };
    this.edges.set(e.id, e);
    this.keys[pl].set(edgeKey(a, b), e.id);
    this.deg[pl][a]++;
    this.deg[pl][b]++;
    for (const [ix, iy] of interiorLatticePoints(ax, ay, bx, by)) this.through[pl][iy * S + ix]++;
    this._analysis[pl] = null;
    return e;
  }

  _removeEdge(e) {
    const pl = e.owner, S = this.S;
    this.edges.delete(e.id);
    this.keys[pl].delete(edgeKey(e.a, e.b));
    // A node left with no edges disappears with the edge.
    this.deg[pl][e.a]--;
    this.deg[pl][e.b]--;
    for (const [ix, iy] of interiorLatticePoints(e.ax, e.ay, e.bx, e.by)) this.through[pl][iy * S + ix]--;
    this._analysis[pl] = null;
  }
}

// The next player after p (cyclically) who still has edges, or -1.
function nextWith(rem, p, n) {
  for (let i = 1; i <= n; i++) {
    const q = (p + i) % n;
    if (rem[q] > 0) return q;
  }
  return -1;
}

function fail(code, edge = null, r = 3) {
  return { ok: false, code, reason: REASONS[code].replace('{r}', r), edge };
}

function edgeKey(a, b) {
  return a < b ? a * 1024 + b : b * 1024 + a;
}

// ----- notation and encoding -----

const COLS = 'abcdefghijklmnopqrstuvwxy';

export function pointName(x, y, size = 19) {
  return COLS[x] + (size - y);
}

export function moveName(m, size = 19) {
  if (m.kind === 'pass') return 'pass';
  if (m.kind === 'timeout') return 'time';
  if (m.kind === 'resign') return 'resign';
  return pointName(m.fx, m.fy, size) + (m.broke ? 'x' : '-') + pointName(m.tx, m.ty, size);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function codeSpace(rules) {
  const R = makeRules(rules);
  const W = 2 * R.radius + 1;
  return { S: R.size, R: R.radius, W, D: W * W, PASS: R.size * R.size * W * W };
}

// Three characters per move. With the standard rules the codes are the same
// as they have always been, so old links keep working.
export function encodeHistory(history, rules = null) {
  const { S, R, W, D, PASS } = codeSpace(rules || {});
  let s = '';
  for (const m of history) {
    let v;
    if (m.kind === 'pass') v = PASS;
    else if (m.kind === 'timeout') v = PASS + 1;
    else if (m.kind === 'resign') v = PASS + 2 + m.player;
    else v = (m.fy * S + m.fx) * D + (m.ty - m.fy + R) * W + (m.tx - m.fx + R);
    s += B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
  }
  return s;
}

export function decodeHistory(s, rules = null) {
  const { S, R, W, D, PASS } = codeSpace(rules || {});
  const out = [];
  if (typeof s !== 'string' || s.length % 3) throw new Error('Bad game code');
  for (let i = 0; i < s.length; i += 3) {
    const a = B64.indexOf(s[i]), b = B64.indexOf(s[i + 1]), c = B64.indexOf(s[i + 2]);
    if (a < 0 || b < 0 || c < 0) throw new Error('Bad game code');
    const v = (a << 12) | (b << 6) | c;
    if (v === PASS) out.push({ kind: 'pass' });
    else if (v === PASS + 1) out.push({ kind: 'timeout' });
    else if (v >= PASS + 2 && v <= PASS + 5) out.push({ kind: 'resign', player: v - PASS - 2 });
    else if (v < PASS) {
      const p = Math.floor(v / D), d = v % D;
      const fx = p % S, fy = Math.floor(p / S);
      const dx = (d % W) - R, dy = Math.floor(d / W) - R;
      out.push({ kind: 'edge', fx, fy, tx: fx + dx, ty: fy + dy });
    } else throw new Error('Bad game code');
  }
  return out;
}

// Rules as a short string for links; '' for the standard rules.
export function encodeRules(r) {
  const R = makeRules(r || {});
  const d = DEFAULT_RULES;
  const t = [];
  if (R.size !== d.size) t.push(`s${R.size}`);
  if (R.radius !== d.radius) t.push(`r${R.radius}`);
  if (R.players !== d.players) t.push(`p${R.players}`);
  if (R.teams) t.push('t');
  if (R.perPlayer !== d.perPlayer) t.push(`e${R.perPlayer}`);
  if (!R.protect) t.push('n');
  if (R.border) t.push('w');
  if (R.timeout !== d.timeout) t.push('T');
  if (R.stuck !== d.stuck) t.push('K');
  if (R.handicap.some((h) => h)) t.push(`h${R.handicap.slice(0, R.players).join('-')}`);
  return t.join('.');
}

export function decodeRules(s) {
  const r = {};
  for (const tok of String(s || '').split('.')) {
    if (!tok) continue;
    const k = tok[0], v = tok.slice(1);
    if (k === 's') r.size = Number(v);
    else if (k === 'r') r.radius = Number(v);
    else if (k === 'p') r.players = Number(v);
    else if (k === 't') r.teams = true;
    else if (k === 'e') r.perPlayer = Number(v);
    else if (k === 'n') r.protect = false;
    else if (k === 'w') r.border = true;
    else if (k === 'T') r.timeout = 'edge';
    else if (k === 'K') r.stuck = 'turn';
    else if (k === 'h') r.handicap = v.split('-').map(Number);
  }
  return makeRules(r);
}

// A position as a compact string, for analysis links and custom puzzles.
// Each edge is six base-36 digits: owner, ax, ay, bx, by, and how many turns
// ago it was placed if it is still new (0 when it isn't).
export function encodePosition(g) {
  const flat = [...g.edges.values()].map((e) => {
    const f = g.isFresh(e) ? g.turn - e.turn + 1 : 0;
    return [e.owner, e.ax, e.ay, e.bx, e.by, f].map((v) => v.toString(36)).join('');
  }).join('');
  const scores = g.scores.map((v) => Math.round(v * 1e6) / 1e6).join(',');
  return [encodeRules(g.rules), g.turn, g.player, g.left, scores, flat].join('~');
}

export function decodePosition(str) {
  const [rs, t, p, l, sc, flat = ''] = String(str).split('~');
  const rules = decodeRules(rs);
  const turn = Math.max(1, Number(t) || 1);
  const edges = [];
  if (flat.length % 6) throw new Error('Bad position code');
  for (let i = 0; i < flat.length; i += 6) {
    const v = flat.slice(i, i + 6).split('').map((c) => parseInt(c, 36));
    if (v.some((x) => !Number.isFinite(x))) throw new Error('Bad position code');
    const [o, ax, ay, bx, by, f] = v;
    if (o >= rules.players) throw new Error('Bad position code');
    // shield = the turn on which it is protected = placed turn + 1.
    edges.push([o, ax, ay, bx, by, f ? turn - f + 2 : 0]);
  }
  return {
    rules, edges, turn, player: Number(p) || 0, left: Number(l) || undefined,
    scores: (sc || '').split(',').map((v) => Number(v) || 0),
  };
}

export function formatArea(a) {
  const r = Math.round(a * 100) / 100;
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(2).replace(/0$/, '');
}
