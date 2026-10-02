// A small queue in front of the solver worker.
export class SolverClient {
  constructor() {
    this.worker = null;
    this.next = 1;
    this.pending = new Map();
  }

  ensure() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Solver failed'));
      this.pending.clear();
      this.worker = null;
    };
    return this.worker;
  }

  // job: { kind, history, base, rules, mode }
  solve(job) {
    const w = this.ensure();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ id, ...job });
    });
  }

  cancel() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('cancelled'));
    this.pending.clear();
  }
}
