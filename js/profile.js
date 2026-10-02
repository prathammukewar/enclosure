// Local profiles: ratings, game history, stats and achievements. Everything
// lives in this browser's storage; profiles can be exported and imported.

import { encodeHistory, encodeRules, formatArea } from './engine.js';
import * as store from './store.js';

export const COMPUTER_RATING = { easy: 800, medium: 1150, hard: 1500, adaptive: 1150 };

export const ACHIEVEMENTS = [
  ['first_game', 'First game', 'Finish a game.'],
  ['fenced', 'Fenced in', 'Hold some area in a game.'],
  ['pen30', 'Big pen', 'Hold 30 area at once.'],
  ['pen60', 'Landowner', 'Hold 60 area at once.'],
  ['snip', 'Snip', "Break an opponent's edge."],
  ['lumberjack', 'Lumberjack', 'Break 10 edges in one game.'],
  ['untouchable', 'Untouchable', 'Win without losing a single edge.'],
  ['comeback', 'Comeback', 'Win after trailing by 200 points or more.'],
  ['beat_easy', 'Warm-up', 'Beat the computer on Easy.'],
  ['beat_medium', 'Getting serious', 'Beat the computer on Medium.'],
  ['beat_hard', 'Hard won', 'Beat the computer on Hard.'],
  ['solo', 'On my own', 'Beat Hard without hints or undo.'],
  ['student', 'Student', 'Finish every lesson.'],
  ['strategist', 'Strategist', 'Read every chapter of the strategy guide.'],
  ['puzzles10', 'Puzzler', 'Solve 10 puzzles.'],
  ['puzzles50', 'Puzzle master', 'Solve 50 puzzles.'],
  ['rush10', 'Quick eye', 'Solve 10 puzzles in one Puzzle Rush.'],
  ['daily3', 'Habit', 'Solve the puzzle of the day three days in a row.'],
  ['daily7', 'Every day', 'Solve the puzzle of the day seven days in a row.'],
  ['online', 'Long distance', 'Finish an online game.'],
  ['penpal', 'Pen pal', 'Finish a game played by link.'],
  ['champion', 'Champion', 'Win a tournament.'],
  ['crowd', 'Crowded board', 'Finish a game with three or four players.'],
  ['variant', 'House rules', 'Finish a game with changed rules.'],
  ['regular', 'Regular', 'Finish 10 games.'],
  ['sharp', 'Sharp', 'Score 90% or more over 10 turns in a game report.'],
  ['maker', 'Puzzle maker', 'Make a puzzle on the analysis board.'],
];

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const newId = () => Math.random().toString(36).slice(2, 10);

function blankProfile(name) {
  return {
    name, created: Date.now(),
    rating: { computer: 1000, puzzle: 1200 },
    games: [], achievements: {}, puzzleAttempts: {}, daily: { last: null, streak: 0 },
    stats: { games: 0, wins: 0, losses: 0, draws: 0, byLevel: {}, breaks: 0, bestScore: 0, peakArea: 0, areaSum: 0 },
  };
}

function elo(r, opp, score, k = 32) {
  const e = 1 / (1 + 10 ** ((opp - r) / 400));
  return Math.round(r + k * (score - e));
}

export class Profiles {
  constructor(app) {
    this.app = app;
    this.data = store.load('profiles', null);
    if (!this.data || !this.data.list) {
      const id = newId();
      this.data = { active: id, list: { [id]: blankProfile('You') } };
      // Bring over the record kept by earlier versions.
      const old = store.getRecord();
      const p = this.data.list[id];
      for (const [lvl, r] of Object.entries(old || {})) {
        p.stats.byLevel[lvl] = { w: r.w || 0, l: r.l || 0, d: r.d || 0, best: r.best || 0 };
        p.stats.wins += r.w || 0; p.stats.losses += r.l || 0; p.stats.draws += r.d || 0;
        p.stats.games += (r.w || 0) + (r.l || 0) + (r.d || 0);
      }
      const lessons = store.load('lessons', []);
      if (lessons.length >= 11) p.achievements.student = Date.now();
      this.save();
    }
  }

  get current() { return this.data.list[this.data.active]; }

  save() { store.save('profiles', this.data); }

  list() { return Object.entries(this.data.list).map(([id, p]) => ({ id, ...p })); }

  switchTo(id) { if (this.data.list[id]) { this.data.active = id; this.save(); } }

  create(name) {
    const id = newId();
    this.data.list[id] = blankProfile(String(name || 'Player').slice(0, 24));
    this.data.active = id;
    this.save();
    return id;
  }

  // Clears the current profile's games, ratings and achievements.
  resetCurrent() {
    this.data.list[this.data.active] = blankProfile(this.current.name);
    this.save();
  }

  rename(name) { this.current.name = String(name || 'Player').slice(0, 24); this.save(); }

  remove(id) {
    if (Object.keys(this.data.list).length < 2) return false;
    delete this.data.list[id];
    if (this.data.active === id) this.data.active = Object.keys(this.data.list)[0];
    this.save();
    return true;
  }

  exportData() { return JSON.stringify({ format: 'enclosure-profiles', ...this.data }); }

  importData(text) {
    const d = JSON.parse(text);
    if (!d || !d.list || typeof d.list !== 'object') throw new Error("That file isn't a profile backup.");
    for (const [id, p] of Object.entries(d.list)) {
      if (!p || typeof p.name !== 'string') continue;
      this.data.list[this.data.list[id] ? newId() : id] = { ...blankProfile(p.name), ...p };
    }
    this.save();
  }

  unlock(key) {
    const p = this.current;
    if (p.achievements[key]) return false;
    p.achievements[key] = Date.now();
    this.save();
    const a = ACHIEVEMENTS.find((x) => x[0] === key);
    if (a) this.app.toast(`Achievement: ${a[1]}`);
    return true;
  }

  has(key) { return !!this.current.achievements[key]; }

  // ----- game hooks -----

  track(view) {
    const c = view.config;
    if (!c._track) c._track = { breaks: 0, peak: 0, lost: 0, worst: 0, hints: 0, undos: 0 };
    return c._track;
  }

  onMove(view, entry) {
    const me = view.mySeat();
    if (me === null || entry.player !== me) return;
    const t = this.track(view);
    if (entry.broke) { t.breaks++; this.unlock('snip'); }
    const g = view.game;
    t.peak = Math.max(t.peak, g.areas[me]);
    if (g.areas[me] > 0) this.unlock('fenced');
    if (g.areas[me] >= 30) this.unlock('pen30');
    if (g.areas[me] >= 60) this.unlock('pen60');
  }

  noteHint() { const v = this.app.play; if (v && v.config) this.track(v).hints++; }
  noteUndo() { const v = this.app.play; if (v && v.config) this.track(v).undos++; }

  recordGame(view) {
    const g = view.game, c = view.config;
    const p = this.current;
    const me = view.mySeat();
    const t = this.track(view);
    const st = view.stats();
    // Lowest point of my side against the best other side, over the game.
    let worst = 0;
    if (me !== null) {
      const my = g.sideOf(me);
      for (const tl of g.timeline) {
        const sides = new Array(g.sides).fill(0);
        tl.scores.forEach((v, q) => { sides[g.sideOf(q)] += v; });
        const others = sides.filter((_, s) => s !== my);
        worst = Math.min(worst, sides[my] - Math.max(...others));
      }
    }
    const w = g.winner();
    const result = me === null ? null : w === -1 ? 'd' : w === g.sideOf(me) ? 'w' : 'l';
    const computers = c.seats.filter((s) => s.type === 'ai');
    const level = computers.length === 1 && c.seats.length === 2 ? computers[0].level : null;
    const rec = {
      id: newId(), date: Date.now(), mode: c.mode, rules: encodeRules(c.rules), names: c.names.slice(0, g.NP),
      seats: c.seats.map((s) => (s.type === 'ai' ? `${s.level}${s.style && s.style !== 'balanced' ? `/${s.style}` : ''}` : 'human')),
      me, result, level, scores: g.scores.map((v) => Math.round(v * 10) / 10), code: encodeHistory(g.history, c.rules),
      breaks: st.breaks, peak: st.peak.map((v) => Math.round(v * 10) / 10), edges: g.placed, resigned: g.resigned,
    };
    p.games.unshift(rec);
    if (p.games.length > 300) p.games.length = 300;
    const s = p.stats;
    s.games++;
    if (result === 'w') s.wins++; else if (result === 'l') s.losses++; else if (result === 'd') s.draws++;
    if (me !== null) {
      s.breaks += st.breaks[me];
      s.bestScore = Math.max(s.bestScore, g.scores[me]);
      s.peakArea = Math.max(s.peakArea, st.peak[me]);
      s.areaSum += g.scores[me] / Math.max(1, g.timeline.length);
    }
    if (level && result) {
      const L = (s.byLevel[level] = s.byLevel[level] || { w: 0, l: 0, d: 0, best: 0 });
      L[result]++;
      L.best = Math.max(L.best || 0, Math.round(g.scores[me]));
      p.rating.computer = elo(p.rating.computer, COMPUTER_RATING[level] || 1150, result === 'w' ? 1 : result === 'd' ? 0.5 : 0);
      store.addResult(level, result, g.scores[me]);
    }
    this.save();
    this.unlock('first_game');
    if (s.games >= 10) this.unlock('regular');
    if (g.NP > 2) this.unlock('crowd');
    if (encodeRules(c.rules) !== '') this.unlock('variant');
    if (c.mode === 'online') this.unlock('online');
    if (c.mode === 'corr') this.unlock('penpal');
    if (me !== null && st.breaks[me] >= 10) this.unlock('lumberjack');
    if (result === 'w') {
      if (st.lost[me] === 0 && g.resigned === null) this.unlock('untouchable');
      if (worst <= -200) this.unlock('comeback');
      if (level) this.unlock(`beat_${level === 'adaptive' ? 'medium' : level}`);
      if (level === 'hard' && !t.hints && !t.undos) this.unlock('solo');
    }
  }

  // ----- puzzles -----

  puzzleResult(p, solved, opts = {}) {
    const prof = this.current;
    const key = p.pos || p.code;
    if (!opts.rush && prof.puzzleAttempts[key] === undefined) {
      prof.puzzleAttempts[key] = solved ? 1 : 0;
      prof.rating.puzzle = elo(prof.rating.puzzle, puzzleRating(p), solved ? 1 : 0, 24);
    }
    if (solved) {
      const count = Object.values(prof.puzzleAttempts).filter(Boolean).length + (opts.rush ? 0 : 0);
      const solvedSet = this.app.puzzles ? this.app.puzzles.solved.size : count;
      if (solvedSet >= 10) this.unlock('puzzles10');
      if (solvedSet >= 50) this.unlock('puzzles50');
      if (opts.daily) this.dailySolved();
    }
    this.save();
  }

  dailySolved() {
    const d = this.current.daily;
    const today = localDay(new Date());
    if (d.last === today) return;
    const y = localDay(new Date(Date.now() - 86400000));
    d.streak = d.last === y ? d.streak + 1 : 1;
    d.last = today;
    if (d.streak >= 3) this.unlock('daily3');
    if (d.streak >= 7) this.unlock('daily7');
    this.save();
  }

  noteReport(rows) {
    if (rows.length >= 10) {
      const got = rows.reduce((a, r) => a + Math.max(0, r.actual), 0);
      const best = rows.reduce((a, r) => a + r.best, 0);
      if (best > 0 && got / best >= 0.9) this.unlock('sharp');
    }
  }
}

// Fixed ratings for puzzles from how hard they are to find.
export function puzzleRating(p) {
  const base = { 1: 1000, 2: 1300, 3: 1600 }[p.level || 2] || 1300;
  const extra = p.greedy !== undefined ? Math.max(0, Math.min(150, (p.best - p.greedy) * 5)) : 0;
  return Math.round(base + extra);
}

// ----- the "You" page -----

export function renderYou(app, root) {
  const P = app.profile;
  const p = P.current;
  const s = p.stats;
  const levels = ['easy', 'medium', 'hard', 'adaptive'];
  const names = { easy: 'Easy', medium: 'Medium', hard: 'Hard', adaptive: 'Adaptive' };
  const games = p.games;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const resultText = (r) => (r === 'w' ? 'Won' : r === 'l' ? 'Lost' : r === 'd' ? 'Draw' : '');
  root.querySelector('#you-profiles').innerHTML = P.list().map((x) => `<option value="${x.id}"${x.id === P.data.active ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  root.querySelector('#you-name').value = p.name;
  root.querySelector('#you-ratings').innerHTML = `
    <div class="stat"><b>${p.rating.computer}</b><span>Rating against the computer</span></div>
    <div class="stat"><b>${p.rating.puzzle}</b><span>Puzzle rating</span></div>
    <div class="stat"><b>${s.games}</b><span>Games finished</span></div>
    <div class="stat"><b>${s.wins} / ${s.losses}${s.draws ? ` / ${s.draws}` : ''}</b><span>Won / lost${s.draws ? ' / drawn' : ''}</span></div>
    <div class="stat"><b>${formatArea(Math.round(s.peakArea * 10) / 10)}</b><span>Most area held at once</span></div>
    <div class="stat"><b>${s.games ? (s.breaks / s.games).toFixed(1) : '0'}</b><span>Edges broken per game</span></div>
    <div class="stat"><b>${Math.round(s.bestScore)}</b><span>Best score</span></div>
    <div class="stat"><b>${p.daily.streak || 0}</b><span>Daily puzzle streak</span></div>`;
  root.querySelector('#you-levels').innerHTML = levels.map((l) => {
    const r = s.byLevel[l] || { w: 0, l: 0, d: 0, best: 0 };
    return `<div class="record-cell"><span>${names[l]}</span><b>${r.w} won, ${r.l} lost</b><span>${r.d ? `${r.d} drawn · ` : ''}best ${r.best || 0}</span></div>`;
  }).join('');
  const got = ACHIEVEMENTS.filter(([k]) => p.achievements[k]).length;
  root.querySelector('#you-ach-count').textContent = `${got} of ${ACHIEVEMENTS.length}`;
  root.querySelector('#you-achievements').innerHTML = ACHIEVEMENTS.map(([k, t, d]) => `
    <div class="ach${p.achievements[k] ? ' got' : ''}"><span class="ach-mark" aria-hidden="true">${p.achievements[k] ? '★' : '☆'}</span><div><b>${t}</b><span>${d}</span></div></div>`).join('');
  root.querySelector('#you-history').innerHTML = games.length ? games.slice(0, 80).map((gm) => {
    const when = new Date(gm.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const vs = gm.names.map((n, i) => `<i class="chip chip-p${i}"></i>${esc(n)}`).join(' ');
    const link = `#g=${gm.code}${gm.rules ? `&r=${gm.rules}` : ''}&n=${encodeURIComponent(gm.names.join('|'))}`;
    return `<li><span class="h-date">${when}</span><span class="h-vs">${vs}</span><span class="h-score">${gm.scores.map((v) => Math.round(v)).join(' / ')}</span><span class="h-res r-${gm.result || 'n'}">${resultText(gm.result)}</span><a href="${link}">Replay</a></li>`;
  }).join('') : '<li class="small">Finished games show up here.</li>';
}
