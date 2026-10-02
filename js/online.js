// Online play by link. PeerJS's public signalling server introduces the two
// browsers, then moves travel directly between them over WebRTC. The host
// keeps the authoritative move list and can resend it if the guest reloads.

import { encodeHistory, decodeHistory } from './engine.js';

const PEER_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js';
const PREFIX = 'enclosure-';

function randomId() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function loadPeer() {
  if (window.Peer) return window.Peer;
  await new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = PEER_SRC;
    el.onload = resolve;
    el.onerror = () => reject(new Error("Couldn't load the connection library. Check your internet connection."));
    document.head.appendChild(el);
  });
  return window.Peer;
}

export class Online {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.role = null;
    this.connected = false;
    this.handlers = {};
    this.me = 'Player';
    this.them = 'Friend';
    this.options = null;
    this.code = null;
    this.rematch = { me: false, them: false };
  }

  on(ev, fn) { this.handlers[ev] = fn; }
  emit(ev, ...args) { const f = this.handlers[ev]; if (f) f(...args); }

  // Host a game. options: { name, color: 0 | 1 | 'random', clock }
  async host(options) {
    this.close();
    this.role = 'host';
    this.options = options;
    this.me = options.name || 'Host';
    const Peer = await loadPeer();
    this.code = randomId();
    return new Promise((resolve, reject) => {
      const peer = new Peer(PREFIX + this.code);
      this.peer = peer;
      peer.on('open', () => resolve(this.code));
      peer.on('connection', (c) => {
        // A newer connection replaces the old one, so a friend who reloads
        // gets straight back in even before the old link times out.
        const old = this.conn;
        this.attach(c);
        if (old) { try { old.close(); } catch { /* ignore */ } }
      });
      peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* ignore */ } });
      peer.on('error', (err) => {
        const msg = err && err.type === 'unavailable-id' ? 'That game code is taken. Try again.' : 'Connection problem. Check your internet connection.';
        this.emit('status', msg);
        reject(new Error(msg));
      });
    });
  }

  async join(code, name) {
    this.close();
    this.role = 'guest';
    this.me = name || 'Guest';
    this.code = code;
    const Peer = await loadPeer();
    return new Promise((resolve, reject) => {
      const peer = new Peer();
      this.peer = peer;
      peer.on('open', () => {
        const c = peer.connect(PREFIX + code, { reliable: true });
        this.attach(c);
        resolve();
      });
      peer.on('error', (err) => {
        const msg = err && err.type === 'peer-unavailable'
          ? "That game isn't open any more. Ask your friend for a new link."
          : 'Connection problem. Check your internet connection.';
        this.emit('status', msg);
        reject(new Error(msg));
      });
    });
  }

  attach(c) {
    this.conn = c;
    this.connected = false;
    // Events from a connection that has since been replaced are ignored.
    c.on('open', () => {
      if (c !== this.conn) return;
      this.connected = true;
      if (this.role === 'guest') c.send({ t: 'hello', name: this.me, v: 1 });
      this.emit('status', 'Connected.');
    });
    c.on('data', (msg) => { if (c === this.conn) this.receive(msg); });
    c.on('close', () => {
      if (c !== this.conn) return;
      this.connected = false;
      this.emit('closed');
    });
    c.on('error', () => { if (c === this.conn) this.emit('status', 'Connection error.'); });
  }

  receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello':
        if (this.role !== 'host') return;
        this.them = String(msg.name || 'Friend').slice(0, 18);
        this.emit('guest', this.them);
        break;
      case 'start':
        if (this.role !== 'guest') return;
        this.them = String(msg.name || 'Friend').slice(0, 18);
        this.rematch = { me: false, them: false };
        this.emit('start', {
          myColor: 1 - Number(msg.hostColor), names: msg.hostColor === 0 ? [this.them, this.me] : [this.me, this.them],
          clock: msg.clock || null, moves: msg.moves ? decodeHistory(msg.moves) : [], clocks: msg.clocks || null,
        });
        break;
      case 'move':
        this.emit('move', msg.m, Number(msg.n), msg.clock);
        break;
      case 'resign':
        this.emit('resign', Number(msg.player));
        break;
      case 'sync?':
        if (this.role === 'host') this.emit('syncRequest');
        break;
      case 'sync':
        this.emit('sync', decodeHistory(msg.moves || ''), msg.clocks || null);
        break;
      case 'rematch':
        this.rematch.them = true;
        this.emit('rematch', this.rematch.me);
        break;
      default:
    }
  }

  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  }

  // Host side: start (or resume) the game for the guest.
  sendStart(hostColor, clock, history, clocks) {
    this.send({ t: 'start', hostColor, clock, name: this.me, moves: encodeHistory(history), clocks });
  }

  sendMove(m, n, clock) {
    const { kind, fx, fy, tx, ty } = m;
    this.send({ t: 'move', n, m: { kind, fx, fy, tx, ty }, clock });
  }

  requestSync() {
    if (this.role === 'guest') this.send({ t: 'sync?' });
    else this.emit('syncRequest');
  }

  sendSync(history, clocks) {
    this.send({ t: 'sync', moves: encodeHistory(history), clocks });
  }

  offerRematch() {
    this.rematch.me = true;
    this.send({ t: 'rematch' });
    this.emit('rematchOffered', this.rematch.them);
  }

  link() {
    return `${location.href.split('#')[0]}#join=${this.code}`;
  }

  close() {
    const c = this.conn, p = this.peer;
    this.peer = null;
    this.conn = null;
    try { if (c) c.close(); } catch { /* ignore */ }
    try { if (p) p.destroy(); } catch { /* ignore */ }
    this.connected = false;
    this.rematch = { me: false, them: false };
  }
}
