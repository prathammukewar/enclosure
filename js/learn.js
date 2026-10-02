// The Learn screen: a list of short lessons played on small boards.
import { Game, BLUE, pointName } from './engine.js';
import { Board } from './board.js';
import { LESSONS } from './lessons.js';
import { sfx } from './sound.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);

export class LearnView {
  constructor(app) {
    this.app = app;
    this.index = 0;
    this.done = new Set(store.load('lessons', []));
    this.board = null;
    $('lesson-reset').onclick = () => this.open(this.index);
    $('lesson-next').onclick = () => {
      const l = LESSONS[this.index];
      if (l.final) { this.app.startQuick({ mode: 'ai', level: 'easy', color: 0 }); return; }
      this.go(this.index + 1);
    };
    this.renderList();
  }

  go(i) {
    location.hash = `#learn/${i + 1}`;
  }

  route(arg) {
    const n = Number(arg);
    const i = Number.isInteger(n) && n >= 1 && n <= LESSONS.length ? n - 1 : this.firstOpen();
    this.open(i);
  }

  firstOpen() {
    const i = LESSONS.findIndex((l) => !this.done.has(l.id));
    return i < 0 ? 0 : i;
  }

  renderList() {
    $('lesson-list').innerHTML = LESSONS.map((l, i) => `
      <button data-i="${i}" ${i === this.index ? 'aria-current="true"' : ''}>
        <span class="ll-mark${this.done.has(l.id) ? ' done' : ''}">${this.done.has(l.id) ? '✓' : i + 1}</span>${l.title}
      </button>`).join('');
    for (const b of $('lesson-list').querySelectorAll('button')) b.onclick = () => this.go(Number(b.dataset.i));
  }

  open(i) {
    this.index = i;
    const l = LESSONS[i];
    this.solved = false;
    this.renderList();
    $('lesson-num').textContent = `Lesson ${i + 1} of ${LESSONS.length}`;
    $('lesson-title').textContent = l.title;
    $('lesson-text').innerHTML = l.text;
    $('lesson-task').textContent = l.task || '';
    $('lesson-task').hidden = !l.task;
    this.setFeedback('');
    $('lesson-next').disabled = !l.final;
    $('lesson-next').textContent = l.final ? 'Play the computer on Easy' : i === LESSONS.length - 1 ? 'Done' : 'Next lesson';
    $('lesson-reset').hidden = !!l.final;
    const s = this.app.settings;
    this.board = new Board($('lesson-board'), {
      interactive: true, coords: false, crop: l.crop, labels: s.labels, animate: s.animate, confirmTaps: s.confirmTaps,
      onMove: (fx, fy, tx, ty) => this.move(fx, fy, tx, ty),
      onPreview: (info) => this.preview(info),
    });
    this.board.onIllegal = (reason) => { this.setFeedback(reason, 'bad'); sfx.illegal(); };
    this.game = new Game(l.base);
    this.board.setGame(this.game);
    this.board.setCanMove(!l.final);
    if (l.final) this.done.add(l.id);
  }

  setFeedback(text, kind = '') {
    const el = $('lesson-feedback');
    el.textContent = text;
    el.className = `lesson-feedback ${kind}`;
  }

  preview(info) {
    if (this.solved) return;
    if (!info) { this.setFeedback(''); return; }
    const r = info.r;
    if (!r.ok) this.setFeedback(r.reason, 'bad');
    else if (r.breaks) this.setFeedback('This edge breaks the highlighted red edge.');
    else if (info.gain > 1e-9) this.setFeedback('This edge fences in the shaded area.');
    else this.setFeedback(`${pointName(info.fx, info.fy)} to ${pointName(info.tx, info.ty)}`);
  }

  move(fx, fy, tx, ty) {
    const l = LESSONS[this.index];
    const g = this.game;
    if (this.solved || g.player !== BLUE) return;
    const areas = g.areas.slice();
    let entry;
    try { entry = g.play(fx, fy, tx, ty); } catch (e) { this.setFeedback(e.message, 'bad'); return; }
    if (entry.broke) sfx.snap(); else if (g.areas[BLUE] > areas[BLUE]) sfx.close(); else sfx.place();
    const removed = [];
    if (entry.broke) {
      const e = entry.broke;
      for (const [x, y] of [[e.ax, e.ay], [e.bx, e.by]]) if (!g.hasNode(e.owner, x, y) && !(x === tx && y === ty)) removed.push([x, y]);
    }
    this.board.setGame(g, { added: entry.edge, broken: entry.broke, removedNodes: removed });
    if (l.check(g, entry)) {
      this.solved = true;
      this.board.setCanMove(false);
      this.setFeedback(typeof l.done === 'function' ? l.done(g) : l.done, 'good');
      this.done.add(l.id);
      store.save('lessons', [...this.done]);
      this.renderList();
      $('lesson-next').disabled = false;
      sfx.win();
      return;
    }
    const retry = l.retry && l.retry(g, entry);
    if (g.player !== BLUE) {
      this.board.setCanMove(false);
      this.setFeedback(retry || 'Your turn is over. Press Start over to try again.', 'bad');
    } else if (retry) {
      this.setFeedback(retry, 'bad');
    } else {
      this.setFeedback('Keep going: you have one more edge this turn.');
    }
  }
}
