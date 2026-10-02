// Exact geometry for Enclosure. Every endpoint is a lattice point, so contact
// tests use integer arithmetic only. Enclosed area is measured on the planar
// arrangement of one player's edges: crossings split edges, faces are traced,
// and a region counts once even when it sits inside another one.

export function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

function orient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function within(a, b, p) {
  return (a <= b) ? (p >= a && p <= b) : (p >= b && p <= a);
}

// True when the closed segments AB and CD share at least one point.
export function segmentsTouch(ax, ay, bx, by, cx, cy, dx, dy) {
  if (Math.max(ax, bx) < Math.min(cx, dx) || Math.max(cx, dx) < Math.min(ax, bx)) return false;
  if (Math.max(ay, by) < Math.min(cy, dy) || Math.max(cy, dy) < Math.min(ay, by)) return false;
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && within(cx, dx, ax) && within(cy, dy, ay)) return true;
  if (d2 === 0 && within(cx, dx, bx) && within(cy, dy, by)) return true;
  if (d3 === 0 && within(ax, bx, cx) && within(ay, by, cy)) return true;
  if (d4 === 0 && within(ax, bx, dx) && within(ay, by, dy)) return true;
  return false;
}

// True when P lies on the closed segment AB.
export function pointOnSegment(ax, ay, bx, by, px, py) {
  return orient(ax, ay, bx, by, px, py) === 0 && within(ax, bx, px) && within(ay, by, py);
}

// Lattice points strictly inside segment AB, as [x, y] pairs.
export function interiorLatticePoints(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const g = gcd(dx, dy);
  const out = [];
  for (let k = 1; k < g; k++) out.push([ax + (dx / g) * k, ay + (dy / g) * k]);
  return out;
}

// A rational point (X / D, Y / D) in lowest terms, with a canonical numeric
// key. Points lie on the board (0..18) and D is at most 18, so X and Y stay
// within 0..342 and the key is unique.
function ratPoint(X, Y, D) {
  if (D < 0) { X = -X; Y = -Y; D = -D; }
  const g = gcd(gcd(X, Y), D) || 1;
  X /= g; Y /= g; D /= g;
  return { key: ((X + 400) * 1200 + (Y + 400)) * 32 + D, x: X / D, y: Y / D };
}

// Sort key for direction vectors: counterclockwise from the +x axis.
function half(dx, dy) {
  return (dy > 0 || (dy === 0 && dx > 0)) ? 0 : 1;
}

function compareDir(adx, ady, bdx, bdy) {
  const ha = half(adx, ady), hb = half(bdx, bdy);
  if (ha !== hb) return ha - hb;
  const c = adx * bdy - ady * bdx;
  return c > 0 ? -1 : c < 0 ? 1 : 0;
}

function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > py) !== (yj > py)) {
      const xc = xj + (py - yj) * (xi - xj) / (yi - yj);
      if (px < xc) inside = !inside;
    }
  }
  return inside;
}

const EPS = 1e-9;

export function roundArea(a) {
  const r = Math.round(a * 1e6) / 1e6;
  return Math.abs(r) < EPS ? 0 : r;
}

// segs: array of [ax, ay, bx, by] integer segments belonging to one player.
// Returns the total enclosed area, the bounded faces for drawing, and for
// each input segment the area that would be lost if only it were removed.
export function analyzeArea(segs, wantLoss = false) {
  const n = segs.length;
  const empty = { area: 0, faces: [], loss: wantLoss ? new Float64Array(n) : null };
  if (n < 2) return empty;

  // 1. Split points along every segment (parameter t in [0, 1]).
  const splits = new Array(n);
  for (let i = 0; i < n; i++) {
    const [ax, ay, bx, by] = segs[i];
    splits[i] = [
      { t: 0, p: ratPoint(ax, ay, 1) },
      { t: 1, p: ratPoint(bx, by, 1) },
    ];
  }
  const paramOf = (i, x, y) => {
    const [ax, ay, bx, by] = segs[i];
    const dx = bx - ax, dy = by - ay;
    return ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
  };
  let anyMeeting = false;
  for (let i = 0; i < n; i++) {
    const [ax, ay, bx, by] = segs[i];
    const rx = bx - ax, ry = by - ay;
    for (let j = i + 1; j < n; j++) {
      const [cx, cy, dx, dy] = segs[j];
      if (!segmentsTouch(ax, ay, bx, by, cx, cy, dx, dy)) continue;
      anyMeeting = true;
      const sx = dx - cx, sy = dy - cy;
      const den = rx * sy - ry * sx;
      if (den !== 0) {
        const qpx = cx - ax, qpy = cy - ay;
        const tNum = qpx * sy - qpy * sx;
        const p = ratPoint(ax * den + tNum * rx, ay * den + tNum * ry, den);
        splits[i].push({ t: tNum / den, p });
        splits[j].push({ t: paramOf(j, p.x, p.y), p });
      } else {
        // Collinear overlap: each segment gets the other's endpoints that lie on it.
        if (pointOnSegment(ax, ay, bx, by, cx, cy)) splits[i].push({ t: paramOf(i, cx, cy), p: ratPoint(cx, cy, 1) });
        if (pointOnSegment(ax, ay, bx, by, dx, dy)) splits[i].push({ t: paramOf(i, dx, dy), p: ratPoint(dx, dy, 1) });
        if (pointOnSegment(cx, cy, dx, dy, ax, ay)) splits[j].push({ t: paramOf(j, ax, ay), p: ratPoint(ax, ay, 1) });
        if (pointOnSegment(cx, cy, dx, dy, bx, by)) splits[j].push({ t: paramOf(j, bx, by), p: ratPoint(bx, by, 1) });
      }
    }
  }
  if (!anyMeeting) return empty;

  // 2. Vertices and deduplicated sub-edges.
  const vIndex = new Map();
  const vx = [], vy = [];
  const vertexOf = (p) => {
    let k = vIndex.get(p.key);
    if (k === undefined) { k = vx.length; vIndex.set(p.key, k); vx.push(p.x); vy.push(p.y); }
    return k;
  };
  const heFrom = [], heTo = [], heDx = [], heDy = [];
  const edgeIndex = new Map();
  const segSubEdges = new Array(n);
  for (let i = 0; i < n; i++) {
    const [ax, ay, bx, by] = segs[i];
    const list = splits[i].sort((a, b) => a.t - b.t);
    const subs = [];
    let prev = null;
    for (const s of list) {
      const v = vertexOf(s.p);
      if (prev !== null && v !== prev) {
        const key = prev < v ? prev * 1048576 + v : v * 1048576 + prev;
        let e = edgeIndex.get(key);
        if (e === undefined) {
          e = heFrom.length;
          edgeIndex.set(key, e);
          heFrom.push(prev, v); heTo.push(v, prev);
          heDx.push(bx - ax, ax - bx); heDy.push(by - ay, ay - by);
        }
        subs.push(e);
      }
      prev = v;
    }
    segSubEdges[i] = subs;
  }
  const H = heFrom.length;
  const V = vx.length;

  // 3. Outgoing half-edges sorted counterclockwise around each vertex.
  const out = Array.from({ length: V }, () => []);
  for (let h = 0; h < H; h++) out[heFrom[h]].push(h);
  const pos = new Int32Array(H);
  for (let v = 0; v < V; v++) {
    const L = out[v];
    L.sort((a, b) => compareDir(heDx[a], heDy[a], heDx[b], heDy[b]));
    for (let k = 0; k < L.length; k++) pos[L[k]] = k;
  }

  // 4. Connected components (union-find on vertices).
  const parent = new Int32Array(V);
  for (let v = 0; v < V; v++) parent[v] = v;
  const find = (v) => { while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; } return v; };
  for (let h = 0; h < H; h += 2) {
    const a = find(heFrom[h]), b = find(heTo[h]);
    if (a !== b) parent[a] = b;
  }

  // 5. Trace faces: the face on the left of u->v continues with the edge
  // leaving v that is first clockwise from v->u.
  const faceOf = new Int32Array(H).fill(-1);
  const faceArea = [], faceComp = [], facePts = [];
  for (let h0 = 0; h0 < H; h0++) {
    if (faceOf[h0] !== -1) continue;
    const f = faceArea.length;
    let h = h0, twice = 0;
    const pts = [];
    do {
      faceOf[h] = f;
      const a = heFrom[h], b = heTo[h];
      twice += vx[a] * vy[b] - vx[b] * vy[a];
      pts.push([vx[a], vy[a]]);
      const tw = h ^ 1;
      const L = out[b];
      h = L[(pos[tw] - 1 + L.length) % L.length];
    } while (h !== h0);
    faceArea.push(twice / 2);
    faceComp.push(find(heFrom[h0]));
    facePts.push(pts);
  }

  // 6. Enclosed area per component, then drop components nested inside another.
  const compEnclosed = new Map();
  const compOuter = new Map();
  for (let f = 0; f < faceArea.length; f++) {
    const c = faceComp[f];
    if (faceArea[f] > EPS) compEnclosed.set(c, (compEnclosed.get(c) || 0) + faceArea[f]);
    else if (!compOuter.has(c) || faceArea[f] < faceArea[compOuter.get(c)]) compOuter.set(c, f);
  }
  const comps = [...compEnclosed.keys()];
  const nested = new Set();
  if (comps.length > 1) {
    const sample = new Map();
    for (let v = 0; v < V; v++) { const c = find(v); if (!sample.has(c)) sample.set(c, v); }
    for (const c of comps) {
      const v = sample.get(c);
      for (const d of comps) {
        if (d === c) continue;
        const outer = compOuter.get(d);
        if (outer !== undefined && pointInPolygon(vx[v], vy[v], facePts[outer])) { nested.add(c); break; }
      }
    }
  }
  let area = 0;
  for (const c of comps) if (!nested.has(c)) area += compEnclosed.get(c);

  const faces = [];
  for (let f = 0; f < faceArea.length; f++) {
    if (faceArea[f] > EPS) faces.push({ pts: facePts[f], area: faceArea[f], nested: nested.has(faceComp[f]) });
  }

  // 7. Loss if one segment is removed: merge the faces on both sides of its
  // pieces; a merged group that reaches the outside loses its bounded faces.
  let loss = null;
  if (wantLoss) {
    loss = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const subs = segSubEdges[i];
      if (!subs.length) continue;
      const fp = new Map();
      const root = (f) => { while (fp.has(f) && fp.get(f) !== f) f = fp.get(f); return f; };
      for (const e of subs) {
        const a = root(faceOf[e]), b = root(faceOf[e ^ 1]);
        if (!fp.has(a)) fp.set(a, a);
        if (!fp.has(b)) fp.set(b, b);
        if (a !== b) fp.set(a, b);
      }
      const groups = new Map();
      for (const f of fp.keys()) {
        const r = root(f);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(f);
      }
      let lost = 0;
      for (const fs of groups.values()) {
        let open = false, sum = 0;
        for (const f of fs) {
          if (faceArea[f] > EPS) sum += faceArea[f];
          else open = true;
        }
        if (open && !nested.has(faceComp[fs[0]])) lost += sum;
      }
      loss[i] = lost;
    }
  }

  return { area: roundArea(area), faces, loss };
}
