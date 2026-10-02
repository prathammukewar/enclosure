// Static check: every element id the scripts look up exists in index.html
// or is created by the scripts themselves.
// node tools/check-ids.mjs
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const defined = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const used = new Map();
for (const f of readdirSync(new URL('js/', root))) {
  if (!f.endsWith('.js')) continue;
  const src = readFileSync(new URL(`js/${f}`, root), 'utf8');
  for (const m of src.matchAll(/\sid="([a-z][\w-]*)"/g)) defined.add(m[1]);
  for (const m of src.matchAll(/(?:\$|getElementById)\('([a-z][\w-]*)'\)/g)) {
    if (!used.has(m[1])) used.set(m[1], f);
  }
  for (const m of src.matchAll(/querySelector\('#([a-z][\w-]*)'\)/g)) {
    if (!used.has(m[1])) used.set(m[1], f);
  }
}
const missing = [...used].filter(([id]) => !defined.has(id));
for (const [id, f] of missing) console.log(`missing #${id} (used in js/${f})`);
console.log(`${used.size} ids checked, ${missing.length} missing`);
process.exit(missing.length ? 1 : 0);
