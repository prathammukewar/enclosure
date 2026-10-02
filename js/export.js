// Replay export: an animated GIF (encoded here) or a video (recorded with
// the browser's MediaRecorder). One frame per turn, scores along the top.

import { Game } from './engine.js';
import { boardSVG } from './image.js';

function css(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Positions at the end of every turn, plus the start.
function frames(history, rules) {
  const g = new Game(null, rules);
  const out = [g.clone()];
  for (const m of history) {
    const t = g.turn;
    g.apply(m);
    if (g.turn !== t || g.over) out.push(g.clone());
  }
  if (out[out.length - 1].history.length !== g.history.length) out.push(g.clone());
  return out;
}

async function drawFrame(ctx, g, names, W, H) {
  const head = H - W;
  ctx.fillStyle = css('--paper', '#f4ede1');
  ctx.fillRect(0, 0, W, H);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([boardSVG(g, W)], { type: 'image/svg+xml' }));
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  ctx.drawImage(img, 0, head, W, W);
  URL.revokeObjectURL(url);
  const n = g.NP;
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(head * 0.42)}px Inter, system-ui, sans-serif`;
  for (let p = 0; p < n; p++) {
    ctx.fillStyle = css(`--c${p}`, ['#2440f0', '#dd2738', '#12873d', '#b07d00'][p]);
    ctx.textAlign = 'center';
    ctx.fillText(`${names[p] || ''} ${Math.round(g.scores[p])}`, (W * (p + 0.5)) / n, head * 0.5);
  }
}

// ----- GIF -----

// Popularity palette from a frame: the most common colors, at 5 bits per
// channel, up to 256 entries.
function buildPalette(data) {
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([k]) => [((k >> 10) & 31) << 3 | 4, ((k >> 5) & 31) << 3 | 4, (k & 31) << 3 | 4]);
  while (top.length < 256) top.push([0, 0, 0]);
  return top;
}

function indexPixels(data, palette, cache) {
  const out = new Uint8Array(data.length / 4);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    let idx = cache.get(k);
    if (idx === undefined) {
      let best = 0, bd = Infinity;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      for (let p = 0; p < palette.length; p++) {
        const c = palette[p];
        const d = (c[0] - r) ** 2 * 3 + (c[1] - g) ** 2 * 4 + (c[2] - b) ** 2 * 2;
        if (d < bd) { bd = d; best = p; }
      }
      cache.set(k, best);
      idx = best;
    }
    out[j] = idx;
  }
  return out;
}

// GIF LZW, following the usual variable-width scheme with clear codes.
function lzw(indices, minCode, out) {
  const clear = 1 << minCode, eoi = clear + 1;
  let next = eoi + 1, size = minCode + 1, cur = 0, shift = 0;
  const bytes = [];
  const emit = (code) => {
    cur |= code << shift;
    shift += size;
    while (shift >= 8) { bytes.push(cur & 255); cur >>>= 8; shift -= 8; }
  };
  emit(clear);
  let table = new Map();
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      next = eoi + 1;
      size = minCode + 1;
      table = new Map();
    } else {
      if (next >= (1 << size)) size++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (shift > 0) bytes.push(cur & 255);
  out.push(minCode);
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
}

export function encodeGif(W, H, framesIdx, palette, delays) {
  const out = [];
  const w16 = (v) => out.push(v & 255, (v >> 8) & 255);
  for (const c of 'GIF89a') out.push(c.charCodeAt(0));
  w16(W); w16(H);
  out.push(0xf7, 0, 0); // global table of 256 colors
  for (const [r, g, b] of palette) out.push(r, g, b);
  out.push(0x21, 0xff, 0x0b);
  for (const c of 'NETSCAPE2.0') out.push(c.charCodeAt(0));
  out.push(3, 1, 0, 0, 0);
  framesIdx.forEach((idx, f) => {
    out.push(0x21, 0xf9, 4, 0x04);
    w16(delays[f]);
    out.push(0, 0);
    out.push(0x2c);
    w16(0); w16(0); w16(W); w16(H);
    out.push(0);
    lzw(idx, 8, out);
  });
  out.push(0x3b);
  return new Uint8Array(out);
}

export async function exportGif(history, rules, names, onProgress = () => {}) {
  const W = 420, H = 460;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const list = frames(history, rules);
  // Palette from the last frame, which has the most going on.
  await drawFrame(ctx, list[list.length - 1], names, W, H);
  const palette = buildPalette(ctx.getImageData(0, 0, W, H).data);
  const cache = new Map();
  const idx = [];
  for (let i = 0; i < list.length; i++) {
    await drawFrame(ctx, list[i], names, W, H);
    idx.push(indexPixels(ctx.getImageData(0, 0, W, H).data, palette, cache));
    onProgress((i + 1) / (list.length + 2));
    await tick();
  }
  const delays = idx.map((_, i) => (i === idx.length - 1 ? 300 : 30));
  const bytes = encodeGif(W, H, idx, palette, delays);
  onProgress(1);
  return { blob: new Blob([bytes], { type: 'image/gif' }), ext: 'gif' };
}

// ----- video -----

export async function exportVideo(history, rules, names, onProgress = () => {}) {
  if (typeof MediaRecorder === 'undefined') throw new Error("This browser can't record video. Try the GIF instead.");
  const W = 720, H = 780;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const type = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error("This browser can't record video. Try the GIF instead.");
  const list = frames(history, rules);
  await drawFrame(ctx, list[0], names, W, H);
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2500000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((r) => { rec.onstop = r; });
  rec.start(200);
  for (let i = 0; i < list.length; i++) {
    await drawFrame(ctx, list[i], names, W, H);
    onProgress((i + 1) / list.length);
    await new Promise((r) => setTimeout(r, i === list.length - 1 ? 2000 : 220));
  }
  rec.stop();
  await done;
  const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
  return { blob: new Blob(chunks, { type: type.split(';')[0] }), ext };
}
