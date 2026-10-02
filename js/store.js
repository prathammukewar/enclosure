// Small wrappers around localStorage. Storage can be blocked or empty
// (private windows, cleared data), so every call is guarded.

const PREFIX = 'enclosure.';

export function load(name, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function save(name, value) {
  try { localStorage.setItem(PREFIX + name, JSON.stringify(value)); } catch { /* ignore */ }
}

export function remove(name) {
  try { localStorage.removeItem(PREFIX + name); } catch { /* ignore */ }
}

const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export const DEFAULT_SETTINGS = {
  theme: 'auto',
  colors: ['blue', 'red', 'green', 'gold'],
  shapes: false,
  lineScale: 1,
  nodeScale: 1,
  sound: true,
  coords: true,
  labels: true,
  confirmTaps: coarse,
  animate: true,
  turnUrls: '',
  turnUser: '',
  turnPass: '',
};

export function getSettings() {
  const saved = load('settings', {});
  // Earlier versions had a single colorblind-friendly switch.
  if (saved.palette === 'friendly' && !saved.colors) saved.colors = ['blue', 'orange', 'pink', 'green'];
  delete saved.palette;
  return { ...DEFAULT_SETTINGS, ...saved };
}

export function setSettings(s) {
  save('settings', s);
}

// Record against the computer, per level.
export function getRecord() {
  return load('record', {});
}

export function addResult(level, result, score) {
  const rec = getRecord();
  const r = rec[level] || { w: 0, l: 0, d: 0, best: 0 };
  if (result === 'w') r.w++; else if (result === 'l') r.l++; else r.d++;
  r.best = Math.max(r.best || 0, Math.round(score));
  rec[level] = r;
  save('record', rec);
  return rec;
}

export function clearRecord() {
  remove('record');
}
