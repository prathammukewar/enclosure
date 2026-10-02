// Tiny synthesized sound effects (no audio files).

let ctx = null;
let enabled = true;

export function setSound(v) { enabled = v; }

function audio() {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { return null; }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(freq, dur, { type = 'sine', gain = 0.05, at = 0, to = null } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur, gain = 0.05) {
  const a = audio();
  if (!a) return;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = a.createBufferSource();
  const g = a.createGain();
  const f = a.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = 1400;
  g.gain.value = gain;
  src.buffer = buf;
  src.connect(f).connect(g).connect(a.destination);
  src.start();
}

export const sfx = {
  place() { tone(660, 0.08, { type: 'triangle', gain: 0.045 }); },
  close() { tone(523, 0.12, { type: 'triangle', gain: 0.05 }); tone(659, 0.12, { type: 'triangle', gain: 0.05, at: 0.08 }); tone(784, 0.2, { type: 'triangle', gain: 0.05, at: 0.16 }); },
  snap() { noise(0.12, 0.09); tone(300, 0.15, { type: 'square', gain: 0.025, to: 120 }); },
  illegal() { tone(180, 0.12, { type: 'sawtooth', gain: 0.025 }); },
  turn() { tone(880, 0.05, { gain: 0.025 }); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, { type: 'triangle', gain: 0.05, at: i * 0.11 })); },
  lose() { [392, 330, 262].forEach((f, i) => tone(f, 0.3, { type: 'triangle', gain: 0.045, at: i * 0.14 })); },
};
