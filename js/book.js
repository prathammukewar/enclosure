// Opening book for Hard: first turns found offline by a longer search
// (tools/book.mjs), keyed by the position. Used only with the standard rules.
import { BOOK } from './bookdata.js';
import { encodeRules } from './engine.js';

// The position as a sorted list of edges (owner and both ends), mirrored
// top to bottom if that gives a smaller key, so mirror images share entries.
export function positionKey(g) {
  const S = g.S;
  const keyFor = (flip) => [...g.edges.values()].map((e) => {
    let a = [e.ax, flip ? S - 1 - e.ay : e.ay], b = [e.bx, flip ? S - 1 - e.by : e.by];
    if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) [a, b] = [b, a];
    return `${e.owner}${a[0].toString(36)}${a[1].toString(36)}${b[0].toString(36)}${b[1].toString(36)}`;
  }).sort().join('');
  const k0 = keyFor(false), k1 = keyFor(true);
  return k0 <= k1 ? { key: `${g.player}${g.left}${k0}`, flip: false } : { key: `${g.player}${g.left}${k1}`, flip: true };
}

export function bookMove(g) {
  if (encodeRules(g.rules) !== '' || g.turn > 12) return null;
  const { key, flip } = positionKey(g);
  const entry = BOOK[key];
  if (!entry || !entry.length) return null;
  const pick = entry[Math.floor(Math.random() * entry.length)];
  const S = g.S;
  const plan = pick.map(([fx, fy, tx, ty]) => ({ kind: 'edge', fx, fy: flip ? S - 1 - fy : fy, tx, ty: flip ? S - 1 - ty : ty }));
  // Only use it if every edge is legal right now.
  const h = g.clone();
  for (const m of plan) {
    if (!h.check(m.fx, m.fy, m.tx, m.ty).ok) return null;
    h.play(m.fx, m.fy, m.tx, m.ty);
  }
  return plan;
}
