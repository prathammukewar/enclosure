// Talks to the computer player in a worker, with a main-thread fallback.

export class AIClient {
  constructor() {
    this.worker = null;
    this.failed = false;
    this.next = 1;
    this.pending = new Map();
  }

  ensure() {
    if (this.worker || this.failed) return this.worker;
    try {
      this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const { id, plan, error } = e.data;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (error) p.reject(new Error(error)); else p.resolve(plan);
      };
      this.worker.onerror = () => {
        this.failed = true;
        this.worker = null;
        for (const p of this.pending.values()) p.fallback();
        this.pending.clear();
      };
    } catch {
      this.failed = true;
      this.worker = null;
    }
    return this.worker;
  }

  async local(game, level, seed, opts) {
    const { planTurn } = await import('./ai.js');
    const { bookMove } = await import('./book.js');
    await new Promise((r) => setTimeout(r, 30));
    return planTurn(game.clone(), level, seed, { ...opts, book: opts.book === false ? null : bookMove });
  }

  // Resolves with a list of moves for the rest of the current turn (or, with
  // opts.explain, with { plan, options }).
  think(game, level, seed = Date.now(), opts = {}) {
    const w = this.ensure();
    if (!w) return this.local(game, level, seed, opts);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, fallback: () => this.local(game, level, seed, opts).then(resolve, reject) });
      const history = game.history.map(({ kind, fx, fy, tx, ty, player }) => ({ kind, fx, fy, tx, ty, player }));
      w.postMessage({ id, history, base: game.base, rules: game.rules, level, seed, opts });
    });
  }

  // Drop any work in progress (results that arrive later are ignored).
  cancel() {
    if (this.pending.size && this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const p of this.pending.values()) p.reject(new Error('cancelled'));
    this.pending.clear();
  }
}
