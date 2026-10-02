// Keeps the last few errors in this browser so a problem report can be
// copied and pasted into a GitHub issue. Nothing is sent anywhere.
import * as store from './store.js';

const MAX = 15;

export function watchErrors() {
  const keep = (text) => {
    const list = store.load('errors', []);
    list.unshift({ t: new Date().toISOString(), text: String(text).slice(0, 600), at: location.hash.slice(0, 60) });
    store.save('errors', list.slice(0, MAX));
  };
  window.addEventListener('error', (e) => keep(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (r && r.message === 'cancelled') return;
    keep(r && r.stack ? r.stack.split('\n').slice(0, 3).join(' | ') : String(r));
  });
}

export function problemReport(extra = {}) {
  const errors = store.load('errors', []);
  return [
    'Enclosure problem report',
    `When: ${new Date().toISOString()}`,
    `Browser: ${navigator.userAgent}`,
    `Screen: ${window.innerWidth} x ${window.innerHeight}, ${window.devicePixelRatio}x`,
    `Page: ${location.hash.slice(0, 60) || '#home'}`,
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
    '',
    errors.length ? 'Recent errors:' : 'No errors recorded.',
    ...errors.map((e) => `- ${e.t} ${e.at} ${e.text}`),
  ].join('\n');
}

export function clearErrors() { store.remove('errors'); }
