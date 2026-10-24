(() => {
  'use strict';

  const DIRS = {
    up:    { dx: 0,  dy: -1 },
    right: { dx: 1,  dy: 0 },
    down:  { dx: 0,  dy: 1 },
    left:  { dx: -1, dy: 0 },
  };
  const DIR_KEYS = Object.keys(DIRS);
  const ROTATION = { up: 0, right: 90, down: 180, left: 270 };
  const MAX_LIVES = 3;
  const MODES = {
    arrows: { unit: 'arrow', minSize: 4, maxSize: 10 },
    snakes: { unit: 'snake', minSize: 6, maxSize: 12 },
  };
  const SNAKE_COLORS = ['#4f8cff', '#ff7a59', '#22c493', '#f5b83d', '#b07cff', '#ff5fa2', '#3cc8e0', '#9bd14b'];
  const ARROW_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FAR = 400; // how far (in cells) a snake's track runs past its head, so it can slither off-screen

  const $ = (id) => document.getElementById(id);
  const els = {
    app: document.querySelector('.app'),
    hud: $('hud'),
    tray: $('tray'),
    board: $('board'),
    controls: $('controls'),
    help: $('help'),
    modeButtons: document.querySelectorAll('[data-mode]'),
    level: $('level'),
    remaining: $('remaining'),
    remainingLabel: $('remaining-label'),
    lives: $('lives'),
    hint: $('hint'),
    restart: $('restart'),
    newPuzzle: $('new'),
    sound: $('sound'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlayText: $('overlay-text'),
    overlayPrimary: $('overlay-primary'),
    overlaySecondary: $('overlay-secondary'),
  };

  const state = {
    mode: 'arrows',
    levels: { arrows: 1, snakes: 1 },
    layout: null,  // the generated puzzle, kept so Restart can replay it exactly
    n: 4,
    pieces: [],    // arrows or snakes; each is { cells (tail → head), dir, el, alive, busy }
    grid: [],      // grid[y][x] -> piece still on the board, or null
    remaining: 0,
    lives: MAX_LIVES,
    cell: 56,
    gap: 4,
    locked: true,  // ignores clicks during the intro and after the round ends
    round: 0,      // bumped on every new board so stale timers can bail out
  };

  const rand = (max) => Math.floor(Math.random() * max);
  const pick = (list) => list[rand(list.length)];
  const same = (a, b) => a.x === b.x && a.y === b.y;
  const headOf = (piece) => piece.cells[piece.cells.length - 1];
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const level = () => state.levels[state.mode];

  function sizeForLevel(mode, lvl) {
    const { minSize, maxSize } = MODES[mode];
    return Math.min(minSize + lvl - 1, maxSize);
  }

  function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(`arrow-escape:${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(`arrow-escape:${key}`, JSON.stringify(value));
    } catch {
      // Storage can be unavailable (private mode, blocked site data); progress just won't persist.
    }
  }

  // ---- Puzzle logic ----

  // Walks from (x, y) in `dir` and returns the first piece in the way plus how many
  // cells away it is, or null when the path off the board is clear.
  function firstBlocker(grid, n, x, y, dir) {
    const { dx, dy } = DIRS[dir];
    for (let i = 1; ; i++) {
      const cx = x + dx * i;
      const cy = y + dy * i;
      if (cx < 0 || cy < 0 || cx >= n || cy >= n) return null;
      if (grid[cy][cx]) return { piece: grid[cy][cx], dist: i };
    }
  }

  function dirBetween(from, to) {
    return DIR_KEYS.find((d) => DIRS[d].dx === to.x - from.x && DIRS[d].dy === to.y - from.y);
  }

  // The way a piece faces when its head is its last cell.
  function facing(cells) {
    return cells.length > 1 ? dirBetween(cells[cells.length - 2], cells[cells.length - 1]) : pick(DIR_KEYS);
  }

  // Turns any set of pieces covering the square into a solvable puzzle. We simulate
  // clearing the board: every piece with a clear path leaves, and whenever all remaining
  // pieces are blocked we fix one of them:
  //   1. re-point it (a single arrow can face any way, a snake can swap head and tail), or
  //   2. split a snake at a cell that has a clear way out, so that cell becomes a new head.
  // Some cell always has a clear way out (e.g. the top cell of any column can go up), so
  // step 2 always succeeds and the simulated clearing order is a valid solution.
  function makeSolvable(pieces, n) {
    const grid = Array.from({ length: n }, () => Array(n).fill(null));
    const occupy = (p) => p.cells.forEach((c) => { grid[c.y][c.x] = p; });
    const isClear = (c, dir) => !firstBlocker(grid, n, c.x, c.y, dir);
    pieces.forEach(occupy);

    let all = pieces.slice();
    let left = pieces.slice();
    let waves = 0;
    while (left.length) {
      const free = left.filter((p) => isClear(headOf(p), p.dir));
      if (free.length) {
        waves++;
        for (const p of free) p.cells.forEach((c) => { grid[c.y][c.x] = null; });
        left = left.filter((p) => !free.includes(p));
        continue;
      }

      const turns = [];
      for (const p of left) {
        if (p.cells.length === 1) {
          for (const dir of DIR_KEYS) {
            if (isClear(p.cells[0], dir)) turns.push(() => { p.dir = dir; });
          }
        } else {
          const flipped = p.cells.slice().reverse();
          const dir = facing(flipped);
          if (isClear(headOf({ cells: flipped }), dir)) turns.push(() => { p.cells = flipped; p.dir = dir; });
        }
      }
      if (turns.length) {
        pick(turns)();
        continue;
      }

      const cuts = [];
      const singles = [];
      for (const p of left) {
        p.cells.forEach((c, k) => {
          for (const dir of DIR_KEYS) {
            if (!isClear(c, dir)) continue;
            const behind = { x: c.x - DIRS[dir].dx, y: c.y - DIRS[dir].dy };
            if (k > 0 && same(p.cells[k - 1], behind)) {
              cuts.push({ p, head: p.cells.slice(0, k + 1), rest: [p.cells.slice(k + 1)], dir });
            } else if (k < p.cells.length - 1 && same(p.cells[k + 1], behind)) {
              cuts.push({ p, head: p.cells.slice(k).reverse(), rest: [p.cells.slice(0, k)], dir });
            } else {
              singles.push({ p, head: [c], rest: [p.cells.slice(0, k), p.cells.slice(k + 1)], dir });
            }
          }
        });
      }
      const cut = pick(cuts.length ? cuts : singles);
      const parts = [
        { cells: cut.head, dir: cut.dir },
        ...cut.rest.filter((cells) => cells.length).map((cells) => ({ cells, dir: facing(cells) })),
      ];
      parts.forEach(occupy);
      all = all.filter((p) => p !== cut.p).concat(parts);
      left = left.filter((p) => p !== cut.p).concat(parts);
    }

    return { pieces: all, waves };
  }

  function generateArrows(n) {
    const pieces = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) pieces.push({ cells: [{ x, y }], dir: pick(DIR_KEYS) });
    }
    return makeSolvable(pieces, n).pieces;
  }

  // One long cord coiled through the whole square, cut into long snakes. We try a few
  // boards and keep the one that needed the fewest short pieces to become solvable.
  function generateSnakes(n) {
    let best = null;
    for (let attempt = 0; attempt < 24; attempt++) {
      const pieces = cutIntoSnakes(randomPath(n), n).map((cells) => {
        if (Math.random() < 0.5) cells.reverse();
        return { cells, dir: facing(cells) };
      });
      const result = makeSolvable(pieces, n);
      const short = result.pieces.filter((p) => p.cells.length < 3).length;
      const score = short * 1000 - result.waves;
      if (!best || score < best.score) best = { score, pieces: result.pieces };
    }
    colorSnakes(best.pieces, n);
    return best.pieces;
  }

  // A random path through every cell of the square: start from a back-and-forth sweep and
  // scramble it with "backbite" moves, which always keep it one unbroken path.
  function randomPath(n) {
    let path = [];
    for (let y = 0; y < n; y++) {
      for (let i = 0; i < n; i++) path.push({ x: y % 2 ? n - 1 - i : i, y });
    }
    for (let step = 0; step < n * n * 12; step++) {
      if (Math.random() < 0.5) path.reverse();
      const end = path[0];
      const options = DIR_KEYS
        .map((d) => ({ x: end.x + DIRS[d].dx, y: end.y + DIRS[d].dy }))
        .filter((c) => c.x >= 0 && c.y >= 0 && c.x < n && c.y < n && !same(c, path[1]));
      const target = pick(options);
      const j = path.findIndex((c) => same(c, target));
      path = path.slice(0, j).reverse().concat(path.slice(j));
    }
    return path;
  }

  function cutIntoSnakes(path, n) {
    const lo = Math.max(4, n - 2);
    const hi = Math.round(n * 1.6);
    const snakes = [];
    for (let i = 0; i < path.length;) {
      let len = lo + rand(hi - lo + 1);
      if (path.length - (i + len) < lo) len = path.length - i;
      snakes.push(path.slice(i, i + len));
      i += len;
    }
    return snakes;
  }

  // Gives each snake a colour that its neighbours don't have, so touching snakes stay distinct.
  function colorSnakes(pieces, n) {
    const owner = Array.from({ length: n }, () => Array(n).fill(null));
    pieces.forEach((p) => p.cells.forEach((c) => { owner[c.y][c.x] = p; }));
    for (const p of pieces) {
      const taken = new Set();
      for (const c of p.cells) {
        for (const { dx, dy } of Object.values(DIRS)) {
          const other = owner[c.y + dy]?.[c.x + dx];
          if (other && other !== p && other.color !== undefined) taken.add(other.color);
        }
      }
      const open = SNAKE_COLORS.map((_, i) => i).filter((i) => !taken.has(i));
      p.color = open.length ? pick(open) : rand(SNAKE_COLORS.length);
    }
  }

  // ---- Renderers ----
  // Game logic works in cell units; each renderer turns that into its own animations.
  // `slide` moves a piece forward along its path by `s` cells per keyframe.

  const keyframeTiming = ({ offset, easing }) => ({
    ...(offset !== undefined && { offset }),
    ...(easing && { easing }),
  });

  // Arrows mode: each piece is a single tile.
  const tiles = {
    build(piece) {
      const { x, y } = piece.cells[0];
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'arrow';
      el.dataset.dir = piece.dir;
      el.style.setProperty('--x', x);
      el.style.setProperty('--y', y);
      el.setAttribute('aria-label', `Arrow pointing ${piece.dir}`);
      el.innerHTML = `<span class="tile">${ARROW_SVG}</span>`;
      el.addEventListener('click', () => onPieceClick(piece));
      els.board.append(el);
      piece.el = el;
    },
    enter(piece, tx, ty, spin, timing) {
      const c = state.cell;
      return piece.el.animate([
        { transform: `translate(${tx * c}px, ${ty * c}px) rotate(${spin}deg) scale(0.5)`, opacity: 0 },
        { opacity: 1, offset: 0.25 },
        { transform: 'translate(0px, 0px) rotate(0deg) scale(1)', opacity: 1 },
      ], timing);
    },
    slide(piece, frames, timing) {
      const { dx, dy } = DIRS[piece.dir];
      const c = state.cell;
      return piece.el.animate(frames.map((f) => ({
        transform: `translate(${dx * f.s * c}px, ${dy * f.s * c}px)`,
        ...(f.opacity !== undefined && { opacity: f.opacity }),
        ...keyframeTiming(f),
      })), timing);
    },
    jolt(piece, dx, dy) {
      piece.el.animate([
        { transform: 'translate(0px, 0px)' },
        { transform: `translate(${dx * 5}px, ${dy * 5}px)` },
        { transform: 'translate(0px, 0px)' },
      ], { duration: 220, easing: 'ease-out', composite: 'add' });
    },
    raise(piece) {
      piece.el.classList.add('moving');
    },
    lower(piece) {
      piece.el.classList.remove('moving');
    },
    // How far the head travels before it touches a piece `dist` cells ahead.
    contact: (dist) => dist - 1 + state.gap / state.cell,
  };

  // Snakes mode: each piece is a cord drawn in an SVG whose units are cells. The cord is a
  // dashed polyline running tail → head → far off the board; shifting the dash offset makes
  // the body follow its own path while the head goes straight.
  const cords = {
    svg: null,
    setup(n) {
      cords.svg = svgEl('svg', { class: 'cords', viewBox: `0 0 ${n} ${n}` });
      els.board.append(cords.svg);
    },
    build(piece) {
      const pts = piece.cells.map((c) => [c.x + 0.5, c.y + 0.5]);
      const [hx, hy] = pts[pts.length - 1];
      const { dx, dy } = DIRS[piece.dir];
      const track = [...pts, [hx + dx * FAR, hy + dy * FAR]].map((p) => p.join(',')).join(' ');
      const dash = `${pts.length - 1} ${FAR * 2}`;

      const g = svgEl('g', {
        class: 'snake',
        role: 'button',
        tabindex: 0,
        'aria-label': `Snake of length ${pts.length} heading ${piece.dir}`,
      });
      g.style.setProperty('--c', SNAKE_COLORS[piece.color]);
      const body = svgEl('polyline', { class: 'cord', points: track, 'stroke-dasharray': dash });
      const shine = svgEl('polyline', { class: 'cord-shine', points: track, 'stroke-dasharray': dash });
      const mover = svgEl('g');
      const head = svgEl('g', { transform: `translate(${hx} ${hy}) rotate(${ROTATION[piece.dir]})` });
      head.append(svgEl('path', { class: 'cord-head', d: 'M0 -0.44 L0.31 -0.04 L-0.31 -0.04 Z' }));
      mover.append(head);
      g.append(body, shine, mover);
      for (const c of piece.cells) {
        g.append(svgEl('rect', { class: 'cord-hit', x: c.x, y: c.y, width: 1, height: 1 }));
      }

      g.addEventListener('click', () => onPieceClick(piece));
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPieceClick(piece);
        }
      });
      cords.svg.append(g);
      Object.assign(piece, { el: g, lines: [body, shine], mover });
    },
    enter(piece, tx, ty, spin, timing) {
      const cx = piece.cells.reduce((sum, c) => sum + c.x, 0) / piece.cells.length + 0.5;
      const cy = piece.cells.reduce((sum, c) => sum + c.y, 0) / piece.cells.length + 0.5;
      piece.el.style.transformOrigin = `${cx}px ${cy}px`;
      return piece.el.animate([
        { transform: `translate(${tx}px, ${ty}px) rotate(${spin}deg) scale(0.5)`, opacity: 0 },
        { opacity: 1, offset: 0.25 },
        { transform: 'translate(0px, 0px) rotate(0deg) scale(1)', opacity: 1 },
      ], timing);
    },
    slide(piece, frames, timing) {
      const { dx, dy } = DIRS[piece.dir];
      for (const line of piece.lines) {
        line.animate(frames.map((f) => ({ strokeDashoffset: `${-f.s}px`, ...keyframeTiming(f) })), timing);
      }
      if (frames.some((f) => f.opacity !== undefined)) {
        piece.el.animate(frames.map((f) => ({ opacity: f.opacity ?? 1, ...keyframeTiming(f) })), timing);
      }
      return piece.mover.animate(frames.map((f) => ({
        transform: `translate(${dx * f.s}px, ${dy * f.s}px)`,
        ...keyframeTiming(f),
      })), timing);
    },
    jolt(piece, dx, dy) {
      piece.el.animate([
        { transform: 'translate(0px, 0px)' },
        { transform: `translate(${dx * 0.09}px, ${dy * 0.09}px)` },
        { transform: 'translate(0px, 0px)' },
      ], { duration: 220, easing: 'ease-out', composite: 'add' });
    },
    raise(piece) {
      cords.svg.append(piece.el); // later siblings paint on top
    },
    lower() {},
    contact: (dist) => dist - 0.62,
  };

  const RENDERERS = { arrows: tiles, snakes: cords };
  const renderer = () => RENDERERS[state.layout.mode];

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  }

  // ---- Board setup ----

  function startPuzzle(layout) {
    state.round++;
    state.layout = layout;
    state.n = layout.n;
    state.lives = MAX_LIVES;
    state.grid = Array.from({ length: state.n }, () => Array(state.n).fill(null));
    state.pieces = layout.pieces.map((p) => ({ ...p, alive: true, busy: false }));
    state.remaining = state.pieces.length;
    for (const piece of state.pieces) {
      for (const c of piece.cells) state.grid[c.y][c.x] = piece;
    }

    hideOverlay();
    fitBoard();
    els.board.replaceChildren();
    const draw = renderer();
    draw.setup?.(state.n);
    state.pieces.forEach(draw.build);
    updateHud();
    pullIn(state.round);
  }

  // Sizes cells so the whole square fits the viewport alongside the HUD and controls.
  function fitBoard() {
    const app = getComputedStyle(els.app);
    const appPad = parseFloat(app.paddingTop) * 2;
    const gap = parseFloat(app.rowGap) || 0;
    const trayPad = parseFloat(getComputedStyle(els.tray).paddingTop) * 2;
    const chrome = els.hud.offsetHeight + els.controls.offsetHeight + els.help.offsetHeight
      + gap * 3 + appPad + trayPad;

    const fit = Math.min(window.innerWidth - appPad - trayPad, window.innerHeight - chrome);
    state.cell = Math.max(26, Math.min(72, Math.floor(fit / state.n)));
    state.gap = Math.max(3, Math.round(state.cell * 0.08));

    els.board.style.setProperty('--n', state.n);
    els.board.style.setProperty('--cell', `${state.cell}px`);
    els.board.style.setProperty('--gap', `${state.gap}px`);
  }

  // Intro: every piece flies in from a random spot off-screen and snaps into the square.
  function pullIn(round) {
    state.locked = true;
    const { n } = state;
    const center = (n - 1) / 2;
    const radius = Math.hypot(window.innerWidth, window.innerHeight) / 2 / state.cell + 1;
    const order = shuffle(state.pieces.slice());
    const stagger = Math.min(40, 700 / order.length);

    const landed = order.map((piece, i) => {
      const mid = piece.cells[Math.floor(piece.cells.length / 2)];
      const angle = Math.random() * Math.PI * 2;
      const tx = Math.cos(angle) * radius - (mid.x - center);
      const ty = Math.sin(angle) * radius - (mid.y - center);
      const spin = (Math.random() < 0.5 ? -1 : 1) * (180 + rand(360));
      return renderer().enter(piece, tx, ty, spin, {
        duration: 650 + rand(250),
        delay: i * stagger,
        easing: 'cubic-bezier(.22, 1, .36, 1.08)',
        fill: 'backwards',
      }).finished;
    });

    Promise.all(landed).then(() => {
      if (round === state.round) state.locked = false;
    }, () => {});
  }

  // ---- Play ----

  function onPieceClick(piece) {
    if (state.locked || !piece.alive || piece.busy) return;
    sound.unlock();
    const head = headOf(piece);
    const hit = firstBlocker(state.grid, state.n, head.x, head.y, piece.dir);
    if (hit) crash(piece, hit);
    else escape(piece);
  }

  function escape(piece) {
    const { dx, dy } = DIRS[piece.dir];
    const { n } = state;
    const head = headOf(piece);

    piece.alive = false;
    for (const c of piece.cells) state.grid[c.y][c.x] = null;
    state.remaining--;
    updateHud();
    sound.whoosh();

    // Far enough for the head to leave the screen and the whole body to follow it out.
    const toEdge = dx > 0 ? n - 1 - head.x : dx < 0 ? head.x : dy > 0 ? n - 1 - head.y : head.y;
    const s = piece.cells.length + toEdge + Math.max(window.innerWidth, window.innerHeight) / state.cell;
    const draw = renderer();
    draw.raise(piece);
    piece.el.classList.add('flying');
    draw.slide(piece, [
      { s: 0, opacity: 1 },
      { s: s * 0.55, opacity: 1, offset: 0.55 },
      { s, opacity: 0 },
    ], {
      duration: 300 + s * state.cell * 0.3,
      easing: 'cubic-bezier(.45, 0, .85, .35)',
      fill: 'forwards',
    }).finished.then(() => piece.el.remove(), () => {});

    if (state.remaining === 0) {
      state.locked = true;
      const round = state.round;
      setTimeout(() => round === state.round && win(), 500);
    }
  }

  // The piece slides until it touches the blocker, bounces off and returns to its place.
  function crash(piece, hit) {
    const { dx, dy } = DIRS[piece.dir];
    const draw = renderer();
    const travel = Math.max(0.1, draw.contact(hit.dist));
    const recoil = Math.min(10 / state.cell, 0.15);
    const approach = 90 + hit.dist * 55;
    const total = approach + 380;

    // Lives drop now (not at impact) so rapid clicks can't sneak past zero.
    state.lives--;
    if (state.lives <= 0) state.locked = true;

    piece.busy = true;
    draw.raise(piece);
    draw.slide(piece, [
      { s: 0, easing: 'cubic-bezier(.5, 0, 1, 1)' },
      { s: travel, offset: approach / total, easing: 'ease-out' },
      { s: travel - recoil, offset: (approach + 80) / total, easing: 'ease-in-out' },
      { s: 0 },
    ], { duration: total }).finished.then(() => {
      piece.busy = false;
      draw.lower(piece);
    }, () => {});

    const round = state.round;
    setTimeout(() => {
      if (round !== state.round) return;
      sound.thud();
      if (hit.piece.alive && hit.piece !== piece) {
        draw.jolt(hit.piece, dx, dy);
        flash(hit.piece.el, 'crash', 500);
      }
      flash(piece.el, 'crash', 500);
      flash(els.tray, 'shake', 350);
      updateHud();
      if (state.lives <= 0) setTimeout(() => round === state.round && lose(), 600);
    }, approach);
  }

  function hint() {
    if (state.locked) return;
    // A solvable board always has at least one piece with a clear path.
    const free = state.pieces.filter((p) => {
      const head = headOf(p);
      return p.alive && !p.busy && !firstBlocker(state.grid, state.n, head.x, head.y, p.dir);
    });
    if (free.length) flash(pick(free).el, 'hint', 1800);
  }

  function flash(el, className, ms) {
    el.classList.remove(className);
    el.getBoundingClientRect(); // force a reflow so the CSS animation restarts if it's already running
    el.classList.add(className);
    clearTimeout(el[`${className}Timer`]);
    el[`${className}Timer`] = setTimeout(() => el.classList.remove(className), ms);
  }

  // ---- Round flow ----

  function newPuzzle() {
    const mode = state.mode;
    const n = sizeForLevel(mode, level());
    const pieces = mode === 'snakes' ? generateSnakes(n) : generateArrows(n);
    startPuzzle({ mode, n, pieces });
  }

  function restart() {
    startPuzzle(state.layout);
  }

  function nextLevel() {
    state.levels[state.mode]++;
    save('levels', state.levels);
    newPuzzle();
  }

  function setMode(mode) {
    state.mode = mode;
    save('mode', mode);
    renderModeButtons();
    newPuzzle();
  }

  function win() {
    sound.win();
    const total = state.layout.pieces.length;
    const things = `${total} ${MODES[state.layout.mode].unit}s`;
    showOverlay({
      title: `Level ${level()} cleared!`,
      text: state.lives === MAX_LIVES
        ? `Flawless. All ${things} escaped without a single crash.`
        : `All ${things} escaped with ${state.lives} ${state.lives === 1 ? 'life' : 'lives'} to spare.`,
      primary: { label: 'Next level', run: nextLevel },
      secondary: { label: 'Replay', run: restart },
    });
  }

  function lose() {
    sound.lose();
    showOverlay({
      title: 'Crash!',
      text: `Out of lives with ${plural(state.remaining, MODES[state.layout.mode].unit)} still on the board.`,
      primary: { label: 'Try again', run: restart },
      secondary: { label: 'New puzzle', run: newPuzzle },
    });
  }

  // ---- UI ----

  function updateHud() {
    els.level.textContent = level();
    els.remaining.textContent = state.remaining;
    els.remainingLabel.textContent = `${MODES[state.mode].unit}s`;
    els.lives.innerHTML = Array.from({ length: MAX_LIVES }, (_, i) =>
      `<span class="heart${i < state.lives ? '' : ' lost'}">&hearts;</span>`).join('');
  }

  function renderModeButtons() {
    for (const button of els.modeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
    }
  }

  function showOverlay({ title, text, primary, secondary }) {
    els.overlayTitle.textContent = title;
    els.overlayText.textContent = text;
    els.overlayPrimary.textContent = primary.label;
    els.overlayPrimary.onclick = primary.run;
    els.overlaySecondary.textContent = secondary.label;
    els.overlaySecondary.onclick = secondary.run;
    els.overlay.hidden = false;
    els.overlayPrimary.focus();
  }

  function hideOverlay() {
    els.overlay.hidden = true;
  }

  // Tiny Web Audio synth so the game has feedback without shipping sound files.
  const sound = (() => {
    let ctx = null;
    let on = load('sound', true);

    function unlock() {
      if (!ctx) {
        try { ctx = new AudioContext(); } catch { return; }
      }
      if (ctx.state === 'suspended') ctx.resume();
    }

    function tone(from, to, duration, type, volume, delay = 0) {
      if (!on || !ctx) return;
      const t = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(from, t);
      osc.frequency.exponentialRampToValueAtTime(to, t + duration);
      gain.gain.setValueAtTime(volume, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + duration);
    }

    return {
      unlock,
      get on() { return on; },
      toggle() {
        on = !on;
        save('sound', on);
        if (on) unlock();
      },
      whoosh: () => tone(420, 1300, 0.18, 'triangle', 0.07),
      thud: () => tone(170, 55, 0.22, 'square', 0.08),
      win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.2, 'triangle', 0.08, i * 0.11)),
      lose: () => [392, 330, 262].forEach((f, i) => tone(f, f * 0.97, 0.25, 'sawtooth', 0.05, i * 0.16)),
    };
  })();

  function renderSoundButton() {
    els.sound.textContent = `Sound: ${sound.on ? 'on' : 'off'}`;
    els.sound.setAttribute('aria-pressed', String(sound.on));
  }

  // ---- Wire up ----

  for (const button of els.modeButtons) {
    button.addEventListener('click', () => button.dataset.mode !== state.mode && setMode(button.dataset.mode));
  }
  els.hint.addEventListener('click', hint);
  els.restart.addEventListener('click', restart);
  els.newPuzzle.addEventListener('click', newPuzzle);
  els.sound.addEventListener('click', () => {
    sound.toggle();
    renderSoundButton();
  });
  window.addEventListener('resize', fitBoard);

  state.levels = { ...state.levels, ...load('levels', {}) };
  state.mode = MODES[load('mode', 'arrows')] ? load('mode', 'arrows') : 'arrows';
  renderModeButtons();
  renderSoundButton();
  newPuzzle();
})();
