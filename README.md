# Enclosure

A browser version of Enclosure, a two-player strategy game on a 19 by 19 grid. You grow a drawing of edges, fence in area, and cut your opponent's edges. After 120 edges, the higher score wins.

**Play it here: https://prathammukewar.github.io/enclosure/**

![A game in progress](og-image.png)

## What you can do

- Play the computer on Easy, Medium or Hard, a friend on the same screen, or a friend online by sending them a link.
- Turn on a clock, including the 1 minute plus 15 seconds setting used in tournament play.
- Learn the game in eleven short interactive lessons, or read the full rules with diagrams.
- Solve puzzles: find the turn that fences in the most area and opens the most of your opponent's. Every best answer was found by trying every possible pair of edges, and there's a puzzle of the day on the home page.
- See what an edge will do before you place it: which enemy edge it breaks, how much area it fences in, or why it isn't allowed.
- Use undo and hints against the computer, and switch on a view that marks your walls the opponent can reach and enemy walls you can break.
- Follow the score chart and move list, step through any game in review, share a link that replays it, save a picture, or download the record.
- Pick a paper or night look and a blue and orange palette, play with the keyboard, install it as an app, and keep playing offline.

## The rules in short

- Blue starts with an edge from a10 to d10 and Red with one from s10 to p10.
- Blue places one edge, then players take turns placing two. The game lasts exactly 120 edges.
- A new edge starts at one of your nodes and ends anywhere within 3 points across and 3 points up or down.
- If it touches an enemy edge, that edge breaks, along with any of their nodes left with no edges. An edge can break only one enemy edge, and edges placed on the opponent's last turn are protected.
- You can't end an edge on the middle of your own edge, or pass through your own node.
- After every turn, both players add the area their edges enclose to their score.

The [rules page](https://prathammukewar.github.io/enclosure/#rules) has the details and the answers to common questions.

## How it's built

Plain HTML, CSS and JavaScript modules, with no build step and no dependencies apart from PeerJS for online games.

| File | What it does |
| --- | --- |
| `js/engine.js` | The rules: legal edges, breaking, protection, turns, scoring, timeouts, and the compact move code used in links |
| `js/geometry.js` | Exact contact tests on lattice segments, and enclosed area from the planar arrangement of a player's edges |
| `js/ai.js` | The computer player. It plans both edges of a turn and judges the result by score, area income and what the opponent can break next turn. It runs in a Web Worker (`js/worker.js`). |
| `js/board.js` | The SVG board, previews, drag and click input, and keyboard play |
| `js/play.js` | The play screen: game flow, clocks, undo, hints, review, sharing |
| `js/online.js` | Online games over WebRTC using PeerJS |
| `js/lessons.js`, `js/learn.js` | The tutorial |
| `js/puzzles.js`, `js/puzzledata.js` | Puzzles, mined from computer games with `tools/mine.mjs` |

Area is measured exactly. Crossings between a player's own edges split them into pieces, the faces of that drawing are traced, and every face with positive area counts. A region that sits inside another region of the same player counts once.

## Running it locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Any static file server works.

Tests:

```bash
node test/test.mjs
```

The tests check the rules against an independent, slower implementation on thousands of random moves, and check every area against a second area method based on vertical slabs. `node tools/arena.mjs hard medium 40` runs computer-against-computer matches.

## About

This is an unofficial fan-made version of the game, built from the rules shown in its reveal video. It isn't affiliated with the game's creator or its official site.

## License

MIT
