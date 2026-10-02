// Online play by link. PeerJS's public signalling server introduces the
// browsers, then moves travel over WebRTC. The host's browser is the hub:
// guests connect to it, it keeps the official move list, runs any computer
// seats, and passes every move on to everyone else (players and watchers).

const PEER_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js';
const PREFIX = 'enclosure-';
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }];

export const EMOTES = { nice: '👍 Nice', wow: '😮 Whoa', oops: '😅 Oops', gg: '🤝 Good game' };

function randomId(n = 8) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
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

function session(key, value) {
  try {
    if (value === undefined) return JSON.parse(sessionStorage.getItem(key) || 'null');
    if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
  return null;
}

export class Online {
  constructor() {
    this.peer = null;
    this.role = null; // 'host' | 'guest' | 'watch'
    this.connected = false;
    this.handlers = {};
    this.me = 'Player';
    this.code = null;
    this.conns = new Map(); // host: id -> { conn, token, seat (-1 watcher), name }
    this.conn = null; // guest: connection to the host
    this.plan = null; // host: seats [{ kind: 'host' | 'ai' | 'guest', name, level, token }]
    this.started = false;
    this.mySeat = null;
    this.turn = null;
    this.retry = null;
  }

  on(ev, fn) { this.handlers[ev] = fn; }
  emit(ev, ...args) { const f = this.handlers[ev]; if (f) f(...args); }

  peerOptions() {
    const ice = [...STUN];
    if (this.turn && this.turn.urls) ice.push({ urls: this.turn.urls, username: this.turn.username || undefined, credential: this.turn.credential || undefined });
    return { config: { iceServers: ice } };
  }

  // ----- host -----

  // setup: { name, rules, clock, seats: [{ kind, name, level }], code? }
  async host(setup, resume = null) {
    this.close();
    this.role = 'host';
    this.me = setup.name || 'Host';
    this.setup = setup;
    this.plan = setup.seats.map((s) => ({ ...s }));
    this.mySeat = this.plan.findIndex((s) => s.kind === 'host');
    this.code = setup.code || randomId();
    this.started = !!resume;
    const Peer = await loadPeer();
    const open = () => new Promise((resolve, reject) => {
      const peer = new Peer(PREFIX + this.code, this.peerOptions());
      peer.on('open', () => { this.peer = peer; resolve(); });
      peer.on('error', (err) => reject(err));
    });
    // After a reload the old registration can linger for a little while.
    for (let attempt = 0; ; attempt++) {
      try { await open(); break; } catch (err) {
        if (!(err && err.type === 'unavailable-id') || attempt > 15) {
          const msg = err && err.type === 'unavailable-id' ? 'That game code is in use. Try again in a minute.' : 'Connection problem. Check your internet connection.';
          this.emit('status', msg);
          throw new Error(msg);
        }
        this.emit('status', 'Getting the game back…');
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    this.connected = true;
    this.peer.on('connection', (c) => this.hostAttach(c));
    this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch { /* ignore */ } });
    this.saveHost();
    return this.code;
  }

  hostAttach(c) {
    const id = c.connectionId || randomId(6);
    c.on('data', (msg) => this.hostReceive(id, c, msg));
    c.on('close', () => {
      const entry = this.conns.get(id);
      if (!entry || entry.conn !== c) return;
      this.conns.delete(id);
      if (entry.seat >= 0) this.emit('left', entry.seat, entry.name);
      this.broadcastLobby();
    });
  }

  hostReceive(id, c, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      const name = String(msg.name || 'Friend').slice(0, 18);
      const token = String(msg.token || '').slice(0, 32);
      let seat = -1;
      if (!msg.watch) {
        seat = this.plan.findIndex((s) => s.kind === 'guest' && s.token && s.token === token);
        if (seat < 0) seat = this.plan.findIndex((s) => s.kind === 'guest' && !s.token);
        if (seat < 0 && !this.started) { c.send({ t: 'full' }); }
      }
      // Drop an older connection for the same seat.
      for (const [k, v] of this.conns) if (seat >= 0 && v.seat === seat) { try { v.conn.close(); } catch { /* ignore */ } this.conns.delete(k); }
      this.conns.set(id, { conn: c, token, seat, name });
      if (seat >= 0) {
        const p = this.plan[seat];
        const back = !!p.token;
        p.token = token;
        p.name = name;
        this.emit(back ? 'back' : 'joined', seat, name);
      }
      this.saveHost();
      if (this.started) this.emit('needState', id);
      else this.broadcastLobby();
      return;
    }
    const entry = this.conns.get(id);
    if (!entry) return;
    if (msg.t === 'move') {
      if (entry.seat < 0) return;
      this.emit('move', msg.m, Number(msg.n), msg.clock, entry.seat, id);
    } else if (msg.t === 'resign') {
      if (entry.seat < 0) return;
      this.emit('resign', entry.seat);
      this.broadcast({ t: 'resign', player: entry.seat }, id);
    } else if (msg.t === 'emote') {
      if (!EMOTES[msg.e]) return;
      this.emit('emote', entry.seat, msg.e, entry.name);
      this.broadcast({ t: 'emote', e: msg.e, seat: entry.seat, name: entry.name }, id);
    } else if (msg.t === 'sync?') {
      this.emit('needState', id);
    } else if (msg.t === 'rematch') {
      this.emit('rematch', entry.seat, entry.name);
    }
  }

  // Seats still waiting for a friend.
  openSeats() { return this.plan ? this.plan.filter((s) => s.kind === 'guest' && !s.token).length : 0; }

  lobbyInfo() {
    return this.plan.map((s, i) => ({ seat: i, kind: s.kind, name: s.kind === 'ai' ? s.name : s.kind === 'host' ? this.me : s.token ? s.name : null }));
  }

  broadcastLobby() {
    const info = this.lobbyInfo();
    for (const v of this.conns.values()) this.sendTo(v.conn, { t: 'lobby', seats: info, you: v.seat });
    this.emit('lobby', info);
  }

  // Host: send the full game to one connection (or everyone).
  sendState(state, onlyId = null) {
    for (const [id, v] of this.conns) {
      if (onlyId && id !== onlyId) continue;
      this.sendTo(v.conn, { t: 'start', you: v.seat, ...state });
    }
  }

  broadcast(msg, exceptId = null) {
    for (const [id, v] of this.conns) if (id !== exceptId) this.sendTo(v.conn, msg);
  }

  sendTo(c, msg) {
    try { if (c && c.open) c.send(msg); } catch { /* ignore */ }
  }

  saveHost(extra = {}) {
    if (this.role !== 'host') return;
    const prev = session('enclosure.host') || {};
    session('enclosure.host', { ...prev, code: this.code, setup: { ...this.setup, seats: this.plan.map(({ kind, name, level, token }) => ({ kind, name, level, token })) }, started: this.started, ...extra });
  }

  static savedHost() { return session('enclosure.host'); }

  // ----- guest and watcher -----

  token(code) {
    const k = `enclosure.token.${code}`;
    let t = session(k);
    if (!t) { t = randomId(12); session(k, t); }
    return t;
  }

  async join(code, name, watch = false) {
    this.close(false);
    this.role = watch ? 'watch' : 'guest';
    this.me = name || 'Guest';
    this.code = code;
    const Peer = await loadPeer();
    return new Promise((resolve, reject) => {
      const peer = new Peer(undefined, this.peerOptions());
      this.peer = peer;
      peer.on('open', () => {
        const c = peer.connect(PREFIX + code, { reliable: true });
        this.conn = c;
        c.on('open', () => {
          if (c !== this.conn) return;
          this.connected = true;
          clearTimeout(this.retry);
          this.retryCount = 0;
          c.send({ t: 'hello', name: this.me, token: this.token(code), watch, v: 2 });
          this.emit('status', watch ? 'Connected. Waiting for the game…' : 'Connected.');
          resolve();
        });
        c.on('data', (msg) => { if (c === this.conn) this.guestReceive(msg); });
        c.on('close', () => {
          if (c !== this.conn) return;
          this.connected = false;
          this.emit('closed');
          this.scheduleRetry();
        });
      });
      peer.on('error', (err) => {
        const msg = err && err.type === 'peer-unavailable'
          ? "That game isn't open right now. If the host just reloaded, it will be back in a moment."
          : 'Connection problem. Check your internet connection.';
        this.emit('status', msg);
        if (this.started) this.scheduleRetry();
        reject(new Error(msg));
      });
    });
  }

  // Keep trying to get back into a game after the connection drops.
  scheduleRetry() {
    if (this.role === 'host' || !this.code || this.closing) return;
    this.retryCount = (this.retryCount || 0) + 1;
    if (this.retryCount > 40) { this.emit('status', 'Lost the connection to the game.'); return; }
    clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.emit('status', 'Reconnecting…');
      this.join(this.code, this.me, this.role === 'watch').catch(() => {});
    }, 3000);
  }

  guestReceive(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'full':
        this.emit('status', 'Every seat in that game is taken. You can watch it instead.');
        this.emit('full');
        break;
      case 'lobby':
        this.mySeat = msg.you;
        this.emit('lobby', msg.seats, msg.you);
        break;
      case 'start':
        this.started = true;
        this.mySeat = msg.you;
        this.emit('start', msg);
        break;
      case 'move':
        this.emit('move', msg.m, Number(msg.n), msg.clock);
        break;
      case 'resign':
        this.emit('resign', Number(msg.player));
        break;
      case 'emote':
        this.emit('emote', msg.seat, msg.e, msg.name);
        break;
      default:
    }
  }

  // ----- both -----

  send(msg) {
    if (this.role === 'host') this.broadcast(msg);
    else this.sendTo(this.conn, msg);
  }

  sendMove(m, n, clock) {
    const { kind, fx, fy, tx, ty } = m;
    const msg = { t: 'move', n, m: { kind, fx, fy, tx, ty }, clock };
    if (this.role === 'host') this.broadcast(msg, this.relayExcept || null);
    else this.sendTo(this.conn, msg);
  }

  requestSync() {
    if (this.role !== 'host') this.sendTo(this.conn, { t: 'sync?' });
  }

  sendEmote(e) {
    if (!EMOTES[e]) return;
    if (this.role === 'host') this.broadcast({ t: 'emote', e, seat: this.mySeat, name: this.me });
    else this.sendTo(this.conn, { t: 'emote', e });
  }

  link(watch = false) {
    return `${location.href.split('#')[0]}#${watch ? 'watch' : 'join'}=${this.code}`;
  }

  close(forget = true) {
    this.closing = true;
    clearTimeout(this.retry);
    try { if (this.conn) this.conn.close(); } catch { /* ignore */ }
    for (const v of this.conns.values()) { try { v.conn.close(); } catch { /* ignore */ } }
    try { if (this.peer) this.peer.destroy(); } catch { /* ignore */ }
    this.peer = null;
    this.conn = null;
    this.conns = new Map();
    this.connected = false;
    this.closing = false;
    if (forget && this.role === 'host') session('enclosure.host', null);
    if (forget) this.started = false;
  }
}
