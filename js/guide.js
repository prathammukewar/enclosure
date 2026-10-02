// The strategy guide: chapters with diagrams and small "try it" boards.
import { Game, BLUE } from './engine.js';
import { Board } from './board.js';
import { drawDiagram } from './diagrams.js';
import { CHAPTERS } from './guidecontent.js';
import { sfx } from './sound.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);

export class GuideView {
  constructor(app) {
    this.app = app;
    this.read = new Set(store.load('guideRead', []));
    this.index = 0;
    this.boards = [];
  }

  route(arg) {
    const n = Number(arg);
    this.open(Number.isInteger(n) && n >= 1 && n <= CHAPTERS.length ? n - 1 : 0);
  }

  renderList() {
    $('guide-list').innerHTML = CHAPTERS.map((c, i) => `
      <button data-i="${i}" ${i === this.index ? 'aria-current="true"' : ''}>
        <span class="ll-mark${this.read.has(c.id) ? ' done' : ''}">${this.read.has(c.id) ? '✓' : i + 1}</span>${c.title}
      </button>`).join('');
    for (const b of $('guide-list').querySelectorAll('button')) b.onclick = () => { location.hash = `#guide/${Number(b.dataset.i) + 1}`; };
  }

  open(i) {
    this.index = i;
    const ch = CHAPTERS[i];
    this.read.add(ch.id);
    store.save('guideRead', [...this.read]);
    if (CHAPTERS.every((c) => this.read.has(c.id))) this.app.profile.unlock('strategist');
    this.renderList();
    const el = $('guide-chapter');
    el.innerHTML = `
      <div class="lesson-head"><span class="lesson-num">Chapter ${i + 1} of ${CHAPTERS.length}</span><h2>${ch.title}</h2></div>
      <div class="guide-body">${ch.body}</div>
      ${ch.diagrams.map((d, k) => `<figure class="guide-fig"><div class="mini-board" id="gd-${k}"></div><figcaption>${d.caption}</figcaption></figure>`).join('')}
      ${ch.tasks.map((t, k) => `
        <div class="guide-task">
          <p class="lesson-task">Try it: ${t.text}</p>
          <div class="guide-task-body">
            <div class="board lesson-board" id="gt-${k}"></div>
            <div><p class="lesson-feedback" id="gtf-${k}" role="status" aria-live="polite"></p><button class="btn" id="gtr-${k}">Start over</button></div>
          </div>
        </div>`).join('')}
      <div class="guide-nav">
        ${i > 0 ? `<a class="btn" href="#guide/${i}">Previous chapter</a>` : '<span></span>'}
        ${i < CHAPTERS.length - 1 ? `<a class="btn primary" href="#guide/${i + 2}">Next chapter</a>` : '<a class="btn primary" href="#play">Play a game</a>'}
      </div>`;
    ch.diagrams.forEach((d, k) => drawDiagram($(`gd-${k}`), d));
    this.boards = ch.tasks.map((t, k) => this.task(t, k));
    window.scrollTo(0, 0);
  }

  task(t, k) {
    const s = this.app.settings;
    const state = { game: null, start: null, solved: false };
    const say = (text, kind = '') => {
      const f = $(`gtf-${k}`);
      f.textContent = text;
      f.className = `lesson-feedback ${kind}`;
    };
    const board = new Board($(`gt-${k}`), {
      interactive: true, coords: false, crop: t.crop, labels: s.labels, animate: s.animate, confirmTaps: s.confirmTaps,
      shapes: s.shapes, lineScale: s.lineScale, nodeScale: s.nodeScale,
      onMove: (fx, fy, tx, ty) => {
        const g = state.game;
        if (state.solved || g.player !== BLUE) return;
        const r = g.check(fx, fy, tx, ty);
        let entry;
        try { entry = g.play(fx, fy, tx, ty); } catch (e) { say(e.message, 'bad'); return; }
        if (entry.broke) sfx.snap(); else sfx.place();
        board.setGame(g, { added: entry.edge, broken: entry.broke, removedNodes: [] });
        if (t.check(g, entry, state.start, r)) {
          state.solved = true;
          board.setCanMove(false);
          say(t.done, 'good');
          sfx.win();
          return;
        }
        const retry = t.retry && t.retry(g, entry, state.start, r);
        if (g.player !== BLUE) { board.setCanMove(false); say(retry || 'Your turn is over. Press Start over to try again.', 'bad'); } else if (retry) say(retry, 'bad'); else say('One more edge this turn.');
      },
      onPreview: (info) => {
        if (state.solved || !info) return;
        if (!info.r.ok) say(info.r.reason, 'bad');
        else if (info.r.breaks) say(`This breaks a red edge${info.loss > 1e-9 ? `, opening ${Math.round(info.loss * 100) / 100}` : ''}.`);
        else if (info.gain > 1e-9) say(`This fences in ${Math.round(info.gain * 100) / 100}.`);
        else say('');
      },
    });
    board.onIllegal = (reason) => say(reason, 'bad');
    const reset = () => {
      state.game = new Game(t.base);
      state.start = state.game.clone();
      state.solved = false;
      board.setGame(state.game);
      board.setCanMove(true);
      say('');
    };
    $(`gtr-${k}`).onclick = reset;
    reset();
    return board;
  }
}
