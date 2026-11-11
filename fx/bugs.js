/* ScreenFX effect module — registers into the runtime in content.js. */
(() => {
  const sfx = window.__screenFX;
  if (!sfx || !sfx.kit) return;
  // eslint-disable-next-line no-unused-vars
  const { R, SPRING, SPRING_MS, rand, rint, pick, clamp, svgFrom, el, div, later, listen, loop, canvasLayer, envelope, easeOut3, easeIn2, shake, breathe, pageLuminance, gl, lockScroll, blocks } = sfx.kit;

  /* ========================================================================
   * 8. BUG INVASION — ladybirds, ground beetles and a column of ants move in
   *    and explore THE PAGE: they run along the edges of cards, images and
   *    text blocks, cross paragraphs, sit on pictures, slip under cards and
   *    come out somewhere else, bolt from the pointer, and occasionally fly a
   *    short hop. Click one and it is squashed. At the end they scurry off.
   *
   *    LOCOMOTION. Alternating tripod gait (front+hind leg of one side swing
   *    with the middle leg of the other). Feet are real footholds: a stance
   *    foot is pinned to the page while the body moves over it, a swing foot
   *    is lifted and placed half a stride ahead of where its hip will be.
   *    Stride length grows with speed (0.5-1.0 body lengths) and the duty
   *    factor falls from 0.65 to 0.5 as they speed up (Ting, Blickhan & Full
   *    1994; Weihmann et al. 2017), so stride frequency tracks speed instead
   *    of legs sliding on ice. Each leg is a two-segment IK chain, and the
   *    body yaws a little toward the stance tripod.
   *
   *    BEHAVIOUR. Intermittent locomotion (stop-and-go), a correlated random
   *    walk for exploring, thigmotaxis (wall following: once a bug touches
   *    an element edge it tends to follow the perimeter, turning corners),
   *    antennae sweeping alternately, faster when stopped. Ants follow a
   *    pheromone trail laid along element edges with the side-to-side
   *    osmotropotactic zig-zag, keep to lanes, and stop to antennate when
   *    they meet head-on. Escape: a sharp turn away from the threat plus a
   *    sprint; ladybirds and some beetles take off instead (elytra open,
   *    hind wings unfold, the shadow detaches as they rise).
   *
   *    LIGHT. One light from the upper left: soft contact shadows offset
   *    away from it, and the glossy highlights on the elytra are placed in
   *    world space so they stay put as a bug turns.
   * ====================================================================== */

  /* The page as rectangles bugs can follow, sit on and hide under. */
  function layout(W, H) {
    const rects = [];
    const seen = new Set();
    const push = (x, y, w, h, kind) => {
      if (w < 30 || h < 14) return;
      if (w > W * 0.94 && h > H * 0.7) return;
      const key = Math.round(x / 3) + ':' + Math.round(y / 3) + ':' + Math.round(w / 3);
      if (seen.has(key)) return;
      seen.add(key);
      rects.push({ x, y, w, h, kind });
    };
    let base = [];
    try { base = blocks({ max: 200, minSize: 30 }); } catch (err) { base = []; }
    const IMG = { img: 1, video: 1, picture: 1, canvas: 1, figure: 1, svg: 1 };
    const CTRL = { button: 1, input: 1, textarea: 1, select: 1 };
    base.forEach((b) => push(b.x, b.y, b.w, b.h, IMG[b.tag] ? 'img' : CTRL[b.tag] ? 'ctrl' : 'text'));
    // Styled boxes (cards, bars) — the blocks scan does not list plain divs.
    const cand = document.body ? document.body.querySelectorAll('div,section,article,aside,header,nav,footer,main,li,a,form') : [];
    let visited = 0;
    for (let i = 0; i < cand.length && visited < 1400 && rects.length < 170; i++) {
      const n = cand[i];
      const r = n.getBoundingClientRect();
      if (r.width < 60 || r.height < 30 || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue;
      visited++;
      const cs = getComputedStyle(n);
      if (cs.visibility === 'hidden' || +cs.opacity < 0.3) continue;
      const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
      const a = m ? (m[1].split(',')[3] === undefined ? 1 : parseFloat(m[1].split(',')[3])) : 0;
      const styled = a > 0.3 || (parseFloat(cs.borderTopWidth) > 0.4 && parseFloat(cs.borderLeftWidth) > 0.4) ||
        (cs.boxShadow && cs.boxShadow !== 'none') || cs.backgroundImage !== 'none';
      if (styled) push(r.left, r.top, r.width, r.height, 'box');
    }
    return rects;
  }

  /* Perimeter geometry for a rect grown by `o` px (o < 0 = inside). */
  const per = (r, o) => {
    const x = r.x - o, y = r.y - o, w = Math.max(2, r.w + 2 * o), h = Math.max(2, r.h + 2 * o);
    return { x, y, w, h, P: 2 * (w + h) };
  };
  const perPoint = (q, s) => {
    s = ((s % q.P) + q.P) % q.P;
    if (s < q.w) return [q.x + s, q.y];
    s -= q.w;
    if (s < q.h) return [q.x + q.w, q.y + s];
    s -= q.h;
    if (s < q.w) return [q.x + q.w - s, q.y + q.h];
    s -= q.w;
    return [q.x, q.y + q.h - s];
  };
  const perProject = (q, px, py) => {
    // nearest point on the boundary, as perimeter length
    const cx = clamp(px, q.x, q.x + q.w), cy = clamp(py, q.y, q.y + q.h);
    const inside = px > q.x && px < q.x + q.w && py > q.y && py < q.y + q.h;
    let side, d;
    if (inside) {
      const dl = px - q.x, dr = q.x + q.w - px, dt = py - q.y, db = q.y + q.h - py;
      d = Math.min(dl, dr, dt, db);
      side = d === dt ? 0 : d === dr ? 1 : d === db ? 2 : 3;
    } else {
      side = cy <= q.y + 0.01 ? 0 : cx >= q.x + q.w - 0.01 ? 1 : cy >= q.y + q.h - 0.01 ? 2 : 3;
      d = Math.hypot(px - cx, py - cy);
    }
    let s;
    if (side === 0) s = cx - q.x;
    else if (side === 1) s = q.w + (cy - q.y);
    else if (side === 2) s = q.w + q.h + (q.x + q.w - cx);
    else s = 2 * q.w + q.h + (q.y + q.h - cy);
    return { s, d, inside };
  };

  /* Soft shadow sprite: an ellipse with a gaussian-ish falloff. */
  function shadowSprite() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(0,0,0,0.55)');
    grd.addColorStop(0.45, 'rgba(0,0,0,0.38)');
    grd.addColorStop(0.75, 'rgba(0,0,0,0.12)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  /* Species. Lengths in px for a ~1 m tall window; speeds in body lengths/s
     scaled from field numbers (ladybird ~2 BL/s, carabid 4-10 BL/s, ant
     3-5 BL/s). legs: hip [x,y], neutral foot [x,y], femur, tibia (in L). */
  const SPECIES = {
    lady: {
      L: [17, 21], cruise: [1.6, 2.3], sprint: 4.2, turn: 5, thig: 0.35, flyFlee: 0.75, flyRand: 0.06,
      hips: [[0.2, 0.1], [0.06, 0.13], [-0.08, 0.13]],
      feet: [[0.42, 0.42], [0.06, 0.52], [-0.32, 0.46]], fem: 0.24, tib: 0.26, legW: 0.07,
      shadow: [1.0, 0.86], stride: [0.42, 0.75]
    },
    beetle: {
      L: [26, 34], cruise: [2.6, 4], sprint: 9, turn: 6.5, thig: 0.85, flyFlee: 0.18, flyRand: 0.004,
      hips: [[0.2, 0.07], [0.04, 0.09], [-0.1, 0.09]],
      feet: [[0.5, 0.38], [0.04, 0.5], [-0.46, 0.4]], fem: 0.3, tib: 0.34, legW: 0.055,
      shadow: [1.0, 0.5], stride: [0.55, 1.0]
    },
    ant: {
      L: [10, 13], cruise: [4.4, 5.6], sprint: 9, turn: 8, thig: 0.6, flyFlee: 0, flyRand: 0,
      hips: [[0.16, 0.04], [0.08, 0.05], [0.0, 0.05]],
      feet: [[0.46, 0.42], [0.06, 0.55], [-0.38, 0.48]], fem: 0.34, tib: 0.4, legW: 0.07,
      shadow: [0.95, 0.36], stride: [0.5, 0.9]
    }
  };
  // Tripod membership: legs ordered [L0, L1, L2, R0, R1, R2]
  const TRIPOD = [0, 1, 0, 1, 0, 1];

  function bugs(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const total = ctx.duration;
    const reduced = ctx.reduced;
    const f = ctx.fit(1400, 1300, 300);
    const OUT_AT = f.intro + f.hold, OUT = f.outro;
    const { g, dpr } = canvasLayer(stage);
    const SH = shadowSprite();
    const dark = pageLuminance() < 0.5;
    // Light from the upper left: shadows fall down and to the right.
    const LDX = 0.55, LDY = 0.85;

    let rects = [];
    try { rects = layout(W, H); } catch (err) { rects = []; }
    const imgs = rects.filter((r) => r.kind === 'img' && r.w > 50 && r.h > 40);
    const hides = rects.filter((r) => (r.kind === 'box' || r.kind === 'img') && r.w >= 90 && r.h >= 50);

    // Spatial hash of rects by 80px cells (padded) for edge sensing.
    const CELL = 80, GW = Math.ceil(W / CELL) + 1, GH = Math.ceil(H / CELL) + 1;
    const grid = Array.from({ length: GW * GH }, () => []);
    rects.forEach((r, i) => {
      const x0 = clamp(Math.floor((r.x - 30) / CELL), 0, GW - 1), x1 = clamp(Math.floor((r.x + r.w + 30) / CELL), 0, GW - 1);
      const y0 = clamp(Math.floor((r.y - 30) / CELL), 0, GH - 1), y1 = clamp(Math.floor((r.y + r.h + 30) / CELL), 0, GH - 1);
      for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) grid[gy * GW + gx].push(i);
    });
    const near = (x, y) => {
      const gx = clamp(Math.floor(x / CELL), 0, GW - 1), gy = clamp(Math.floor(y / CELL), 0, GH - 1);
      return grid[gy * GW + gx];
    };

    /* ---- bugs -------------------------------------------------------------- */
    const list = [];
    const mkBug = (kind, x, y, a, opts = {}) => {
      const sp = SPECIES[kind];
      const L = rand(sp.L[0], sp.L[1]);
      const b = {
        kind, sp, L, x, y, a, v: 0, z: 0,
        cruise: rand(sp.cruise[0], sp.cruise[1]) * L * (reduced ? 0.65 : 1),
        sprint: sp.sprint * L * (reduced ? 0.6 : 1),
        phase: rand(0, 1), turnN: 0, mode: 'explore', pause: 0, wakeAt: 0,
        edge: null, edgeT: 0, hide: null, fly: null, flee: 0, dead: false,
        antPh: rand(0, 6.28), sway: 0,
        hue: kind === 'beetle' ? pick([[52, 40, 30], [30, 52, 40], [36, 36, 62], [58, 34, 54]]) : null,
        spots: kind === 'lady' ? [[0.16, 0, 0.075], [0.02, -0.2, 0.07], [0.02, 0.2, 0.07], [-0.2, -0.13, 0.075],
          [-0.2, 0.13, 0.075], [-0.04, -0.3, 0.045], [-0.04, 0.3, 0.045]] : null,
        red: kind === 'ant' && Math.random() < 0.5,
        feet: [], legs: null, grad: null, ...opts
      };
      b.feet = [];
      for (let i = 0; i < 6; i++) {
        const side = i < 3 ? -1 : 1, k = i % 3;
        const nf = sp.feet[k];
        const lx = nf[0] * L, ly = side * nf[1] * L;
        const c = Math.cos(a), s = Math.sin(a);
        b.feet.push({ x: x + lx * c - ly * s, y: y + lx * s + ly * c, sx: 0, sy: 0, swing: false });
      }
      list.push(b);
      return b;
    };

    const nBeetles = Math.round(clamp((W * H) / 95000, 6, 15) * (reduced ? 0.5 : 1));
    for (let i = 0; i < nBeetles; i++) {
      const kind = Math.random() < 0.4 ? 'lady' : 'beetle';
      const edge = rint(0, 3);
      const x = edge === 1 ? W + 30 : edge === 3 ? -30 : rand(40, W - 40);
      const y = edge === 0 ? -30 : edge === 2 ? H + 30 : rand(40, H - 40);
      const a = Math.atan2(H / 2 - y + rand(-H * 0.3, H * 0.3), W / 2 - x + rand(-W * 0.3, W * 0.3));
      const b = mkBug(kind, x, y, a);
      b.wakeAt = rand(0, f.intro * 0.85);
      b.mode = 'enter';
      const inn = rand(90, 220);
      b.goX = clamp(edge === 1 ? W - inn : edge === 3 ? inn : x + rand(-160, 160), 60, W - 60);
      b.goY = clamp(edge === 0 ? inn : edge === 2 ? H - inn : y + rand(-160, 160), 60, H - 60);
      b.a = Math.atan2(b.goY - y, b.goX - x);
    }

    /* ---- the ant trail: along element edges, off-screen at both ends ------ */
    const trail = [];
    (() => {
      const cands = rects.filter((r) => (r.kind === 'box' || r.kind === 'img') && r.w > 140 && r.h > 50 &&
        r.y > 40 && r.y + r.h < H - 30 && r.x > 10 && r.x + r.w < W - 10);
      const r = cands.length ? pick(cands) : null;
      const o = 5;
      const pts = [];
      if (r) {
        const left = r.x + r.w / 2 > W / 2;    // come in from the nearer side
        if (left) {
          pts.push([-40, r.y - o + rand(-30, 30)], [r.x - o, r.y - o], [r.x + r.w + o, r.y - o],
            [r.x + r.w + o, r.y + r.h + o], [r.x + r.w + o + rand(20, 80), H + 40]);
        } else {
          pts.push([W + 40, r.y - o + rand(-30, 30)], [r.x + r.w + o, r.y - o], [r.x - o, r.y - o],
            [r.x - o, r.y + r.h + o], [r.x - o - rand(20, 80), H + 40]);
        }
      } else {
        const y0 = rand(H * 0.3, H * 0.7);
        for (let i = 0; i <= 8; i++) pts.push([-40 + (W + 80) * i / 8, y0 + Math.sin(i * 0.9) * H * 0.08]);
      }
      // Resample to ~6px with a little meander where the trail is in open page.
      let acc = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
        const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(len / 6));
        const open = !r || i === 0 || i === pts.length - 2;
        const nx = -(y1 - y0) / (len || 1), ny = (x1 - x0) / (len || 1);
        for (let k = 0; k < n; k++) {
          const t = k / n, m = open ? Math.sin(t * Math.PI) * Math.sin(t * 7 + i) * 10 : 0;
          const x = x0 + (x1 - x0) * t + nx * m, y = y0 + (y1 - y0) * t + ny * m;
          if (trail.length) acc += Math.hypot(x - trail[trail.length - 1].x, y - trail[trail.length - 1].y);
          trail.push({ x, y, s: acc });
        }
      }
      const last = pts[pts.length - 1];
      acc += Math.hypot(last[0] - trail[trail.length - 1].x, last[1] - trail[trail.length - 1].y);
      trail.push({ x: last[0], y: last[1], s: acc });
    })();
    const TRAIL_LEN = trail[trail.length - 1].s;
    const trailAt = (s) => {
      s = clamp(s, 0, TRAIL_LEN);
      let lo = 0, hi = trail.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (trail[m].s <= s) lo = m; else hi = m; }
      const p = trail[lo], q = trail[hi], k = (s - p.s) / Math.max(0.001, q.s - p.s);
      return [p.x + (q.x - p.x) * k, p.y + (q.y - p.y) * k, Math.atan2(q.y - p.y, q.x - p.x)];
    };
    const nAnts = reduced ? 9 : rint(16, 22);
    for (let i = 0; i < nAnts; i++) {
      const dir = Math.random() < 0.6 ? 1 : -1;
      // spaced out along the off-screen run-in so they arrive as a column
      const s0 = dir > 0 ? -i * rand(15, 28) - rand(0, 40) : TRAIL_LEN + i * rand(15, 28) + rand(0, 40);
      const [x, y, a] = trailAt(s0);
      const b = mkBug('ant', x, y, dir > 0 ? a : a + Math.PI, { mode: 'trail', ts: s0, tdir: dir, lane: dir * 2.2,
        crumb: dir < 0 && Math.random() < 0.35, met: 0 });
      b.wakeAt = 0;
    }

    /* ---- pointer & squashing ------------------------------------------------ */
    let mx = -1e4, my = -1e4, mvx = 0, mvy = 0, mt = 0;
    listen(window, 'pointermove', (e) => {
      const now = performance.now(), dtm = Math.max(8, now - mt);
      mvx = (e.clientX - mx) / dtm * 1000; mvy = (e.clientY - my) / dtm * 1000;
      mx = e.clientX; my = e.clientY; mt = now;
    }, { passive: true, capture: true });

    const splats = [];
    let swallowUntil = 0;
    const swallow = (e) => {
      if (performance.now() < swallowUntil) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
    };
    ['mousedown', 'mouseup', 'click', 'pointerup', 'dblclick', 'auxclick', 'contextmenu'].forEach((t) => listen(window, t, swallow, { capture: true }));
    listen(window, 'pointerdown', (e) => {
      let hit = null, best = 1e9;
      for (const b of list) {
        if (b.dead || b.hidden || b.z > 6) continue;
        const d = Math.hypot(e.clientX - b.x, e.clientY - b.y);
        const r = b.L * 0.55 + (b.kind === 'ant' ? 7 : 4);
        if (d < r && d < best) { hit = b; best = d; }
      }
      if (!hit) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      swallowUntil = performance.now() + 700;
      squash(hit, e.clientX, e.clientY);
    }, { capture: true });

    const HEMO = { lady: [236, 168, 36], beetle: [146, 150, 54], ant: [196, 188, 150] };
    function squash(b, px, py) {
      b.dead = true;
      b.deadAt = tNow;
      b.v = 0;
      // Splay the legs: the body is crushed flat, so every leg is pushed out.
      b.feet.forEach((ft, i) => {
        const dx = ft.x - b.x, dy = ft.y - b.y, k = rand(1.15, 1.45);
        ft.x = b.x + dx * k + rand(-2, 2); ft.y = b.y + dy * k + rand(-2, 2);
        ft.tw = rand(0, 6.28);
      });
      // Haemolymph: drops thrown radially, smaller drops faster (v ~ r^-1/2),
      // stopped within ~60 ms by drag/wetting on the glass.
      const n = Math.round(10 + b.L * 0.5);
      const drops = [];
      const scale = b.L / 24;
      const bias = Math.atan2(b.y - py, b.x - px) || rand(0, 6.28);
      for (let i = 0; i < n; i++) {
        const r = scale * Math.pow(Math.random(), 1.8) * 2.6 + 0.5;
        const ang = Math.random() < 0.4 ? bias + rand(-0.8, 0.8) : rand(0, 6.28);
        const v = rand(140, 380) * scale / Math.sqrt(r / scale + 0.2);
        drops.push({ a: ang, r, reach: v * 0.06, tau: 0.06 });
      }
      splats.push({ b, x: b.x, y: b.y, t0: tNow, col: HEMO[b.kind], drops, smear: rand(0, 6.28) });
      // Everyone nearby startles.
      for (const o of list) {
        if (o.dead || o === b) continue;
        const d = Math.hypot(o.x - b.x, o.y - b.y);
        if (d < 260) startle(o, b.x, b.y, 0.5 + (260 - d) / 260);
      }
    }

    const startle = (b, fx, fy, k) => {
      if (b.fly || b.mode === 'leave') return;
      if (b.hidden) return;
      if (Math.random() < b.sp.flyFlee * k && !reduced) { takeOff(b, Math.atan2(b.y - fy, b.x - fx)); return; }
      b.mode = 'flee'; b.flee = rand(500, 1100); b.pause = 0;
      b.fleeA = Math.atan2(b.y - fy, b.x - fx) + rand(-0.5, 0.5);
      if (b.kind === 'ant') b.trailLeft = true;
    };

    function takeOff(b, dirA, target) {
      const d = target ? Math.hypot(target[0] - b.x, target[1] - b.y) : rand(160, 380);
      const a = target ? Math.atan2(target[1] - b.y, target[0] - b.x) : dirA + rand(-0.6, 0.6);
      let tx = b.x + Math.cos(a) * d, ty = b.y + Math.sin(a) * d;
      if (!target) { tx = clamp(tx, 30, W - 30); ty = clamp(ty, 30, H - 30); }
      b.fly = { t: 0, prep: 200, dur: clamp(d / 420, 0.45, 1.3) * 1000, land: 180, x0: b.x, y0: b.y, tx, ty,
        zmax: clamp(d * 0.22, 26, 90), open: 0, away: !!target };
      b.mode = 'fly';
    }

    /* ---- steering ------------------------------------------------------------ */
    const wrap = (d) => { while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
    const insideRect = (r, x, y, m = 0) => x > r.x - m && x < r.x + r.w + m && y > r.y - m && y < r.y + r.h + m;

    function think(b, dt, t) {
      const s = dt / 1000;
      let want = b.a, speed = b.cruise;

      if (b.mode === 'leave') {
        want = Math.atan2(b.ey - b.y, b.ex - b.x);
        const dist = Math.hypot(b.ex - b.x, b.ey - b.y);
        speed = Math.max(b.sprint * 0.8, dist / Math.max(0.15, (total - t) / 1000 - 0.1));
        return [want, speed];
      }

      // pointer: a looming, close or fast-approaching threat triggers escape
      const dp = Math.hypot(b.x - mx, b.y - my);
      const appr = dp > 1 ? -((b.x - mx) * mvx + (b.y - my) * mvy) / dp : 0;
      const fear = 70 + b.L * 2.2 + Math.max(0, appr) * 0.12;
      if (dp < fear && b.mode !== 'flee' && !b.hidden) startle(b, mx, my, 1);

      if (b.mode === 'flee') {
        b.flee -= dt;
        if (dp < fear * 1.3) b.fleeA = Math.atan2(b.y - my, b.x - mx);
        want = b.fleeA;
        speed = b.sprint;
        // the screen edge is a wall too
        if (b.x < 20 || b.x > W - 20 || b.y < 20 || b.y > H - 20) want = Math.atan2(H / 2 - b.y, W / 2 - b.x);
        if (b.flee <= 0) { b.mode = b.kind === 'ant' && !b.trailLeft ? 'trail' : 'explore'; b.pause = rand(300, 900); }
        return [want, speed];
      }

      if (b.mode === 'enter') {
        // walk in toward somewhere inside the page, then start exploring
        want = Math.atan2(b.goY - b.y, b.goX - b.x);
        if (Math.hypot(b.goX - b.x, b.goY - b.y) < 40) b.mode = 'explore';
        return [want, b.cruise * 1.2];
      }

      if (b.pause > 0) {
        b.pause -= dt;
        return [b.a + b.turnN * s * 0.4, 0];
      }

      if (b.mode === 'hide') {
        const hd = b.hide;
        if (hd.stage === 'in') {
          want = Math.atan2(hd.cy - b.y, hd.cx - b.x);
          speed = b.cruise * 0.9;
          if (insideRect(hd.r, b.x, b.y, -b.L * 0.9)) { hd.stage = 'under'; hd.until = t + rand(1200, 3600); b.hidden = true; }
        } else if (hd.stage === 'under') {
          speed = 0;
          if (t > hd.until) {
            // come out somewhere else along the edge
            const q = per(hd.r, b.L);
            const [ex, ey] = perPoint(q, rand(0, q.P));
            hd.ex = ex; hd.ey = ey; hd.stage = 'out';
            b.x = clamp(ex, hd.r.x + b.L, hd.r.x + hd.r.w - b.L);
            b.y = clamp(ey, hd.r.y + b.L, hd.r.y + hd.r.h - b.L);
            b.a = Math.atan2(ey - b.y, ex - b.x);
            b.feet.forEach((ft) => { ft.x = b.x; ft.y = b.y; });
            b.resetFeet = true;
          }
        } else {
          want = Math.atan2(hd.ey - b.y, hd.ex - b.x);
          speed = b.cruise;
          if (!insideRect(hd.r, b.x, b.y, b.L * 0.7)) { b.hidden = false; b.hide = null; b.mode = 'explore'; b.pause = rand(200, 600); }
        }
        return [want, speed];
      }

      if (b.mode === 'trail') {
        return null;                                // handled by the trail follower
      }

      // stop-and-go: intermittent locomotion
      if (Math.random() < s * (b.kind === 'beetle' ? 0.35 : 0.5)) b.pause = rand(300, 1400);

      // on a picture: sit there a while
      for (const r of imgs) {
        if (insideRect(r, b.x, b.y, -b.L) && !b.basked) {
          b.basked = true;
          if (Math.random() < 0.6) b.pause = rand(900, 2600);
        }
      }
      if (b.basked && !imgs.some((r) => insideRect(r, b.x, b.y))) b.basked = false;

      // spontaneous short flight
      if (!reduced && Math.random() < s * b.sp.flyRand && t < OUT_AT - 1500) { takeOff(b, b.a); return [b.a, 0]; }

      // hide under a card / image now and then
      if (hides.length && !b.hidden && Math.random() < s * 0.05 && t < OUT_AT - 3000) {
        let best = null, bd = 1e9;
        hides.forEach((r) => { const d = Math.hypot(r.x + r.w / 2 - b.x, r.y + r.h / 2 - b.y); if (d < bd) { bd = d; best = r; } });
        if (best && bd < 520) {
          const q = per(best, -b.L);
          const pr = perProject(q, b.x, b.y);
          const [cx, cy] = perPoint(q, pr.s);
          b.mode = 'hide';
          b.hide = { r: best, stage: 'in', cx, cy };
          b.edge = null;
          return [Math.atan2(cy - b.y, cx - b.x), b.cruise];
        }
      }

      if (b.mode === 'edge' && b.edge) {
        const e = b.edge;
        const pr = perProject(e.q, b.x, b.y);
        const [tx, ty] = perPoint(e.q, pr.s + e.dir * Math.max(b.L * 1.4, 14));
        want = Math.atan2(ty - b.y, tx - b.x);
        e.t -= dt;
        if (e.t <= 0 || pr.d > b.L * 3) {
          b.mode = 'explore'; b.edge = null;
          want = b.a + (Math.random() < 0.5 ? -1 : 1) * rand(0.5, 1.2);
        }
        // never follow an edge off the screen
        if (tx < 8 || tx > W - 8 || ty < 8 || ty > H - 8) { e.dir = -e.dir; }
        return [want, speed];
      }

      // explore: correlated random walk
      b.turnN += (-b.turnN * 1.6 + rand(-1, 1) * 9) * s;
      want = b.a + b.turnN * s * 3;
      const m = 40 + b.L;
      if (b.x < m || b.x > W - m || b.y < m || b.y > H - m) want = Math.atan2(H / 2 - b.y + rand(-80, 80), W / 2 - b.x + rand(-80, 80));

      // thigmotaxis: touched an edge -> follow it
      const cell = near(b.x, b.y);
      for (let i = 0; i < cell.length; i++) {
        const r = rects[cell[i]];
        const q0 = per(r, 0);
        const pr = perProject(q0, b.x, b.y);
        if (pr.d < b.L * 0.9 + 4 && Math.random() < b.sp.thig * s * 6) {
          const off = (pr.inside ? -1 : 1) * (b.L * 0.32 + 2);
          const q = per(r, off);
          const p2 = perProject(q, b.x, b.y);
          const [ax, ay] = perPoint(q, p2.s + 4);
          const tang = Math.atan2(ay - b.y, ax - b.x);
          b.edge = { r, q, dir: Math.cos(wrap(tang - b.a)) >= 0 ? 1 : -1, t: rand(1800, 6500) };
          b.mode = 'edge';
          break;
        }
      }
      return [want, speed];
    }

    /* ---- gait ---------------------------------------------------------------- */
    function stepLegs(b, dt, turnRate) {
      const sp = b.sp, L = b.L;
      const rel = clamp(b.v / (sp.sprint * L), 0, 1);
      const stride = L * (sp.stride[0] + (sp.stride[1] - sp.stride[0]) * rel);
      const duty = 0.65 - 0.15 * rel;
      const dPh = (b.v / stride + Math.abs(turnRate) * 0.35) * dt / 1000;
      b.phase += dPh;
      const c = Math.cos(b.a), s = Math.sin(b.a);
      const swingT = (1 - duty) / Math.max(0.0001, b.v / stride + Math.abs(turnRate) * 0.35);
      for (let i = 0; i < 6; i++) {
        const ft = b.feet[i];
        const side = i < 3 ? -1 : 1, k = i % 3;
        const ph = ((b.phase + TRIPOD[i] * 0.5) % 1 + 1) % 1;
        const swinging = ph < 1 - duty && dPh > 0;
        const nf = sp.feet[k];
        if (b.resetFeet) {
          const lx = nf[0] * L, ly = side * nf[1] * L;
          ft.x = b.x + lx * c - ly * s; ft.y = b.y + lx * s + ly * c; ft.swing = false;
          continue;
        }
        if (swinging) {
          if (!ft.swing) { ft.swing = true; ft.sx = ft.x; ft.sy = ft.y; }
          const p = ph / (1 - duty);
          // where the hip will be when this foot comes down, plus half a stride
          const ahead = b.v * swingT * (1 - p) / 1;
          const lx = nf[0] * L + stride * 0.5, ly = side * nf[1] * L;
          const bx = b.x + c * ahead, by = b.y + s * ahead;
          const tx = bx + lx * c - ly * s, ty = by + lx * s + ly * c;
          const e = p * p * (3 - 2 * p);
          ft.x = ft.sx + (tx - ft.sx) * e; ft.y = ft.sy + (ty - ft.sy) * e;
          ft.lift = Math.sin(p * Math.PI);
        } else {
          ft.swing = false; ft.lift = 0;
          // a foot dragged out of reach (sharp turn, shove) gets re-placed
          const dx = ft.x - b.x, dy = ft.y - b.y;
          if (dx * dx + dy * dy > (L * 1.05) * (L * 1.05)) {
            const lx = nf[0] * L, ly = side * nf[1] * L;
            ft.x = b.x + lx * c - ly * s; ft.y = b.y + lx * s + ly * c;
          }
        }
      }
      b.resetFeet = false;
      // body yaws toward the stance tripod
      b.sway = Math.sin(b.phase * Math.PI * 2) * 0.07 * Math.min(1, b.v / (b.cruise + 1));
    }

    /* ---- drawing --------------------------------------------------------------- */
    const legCol = (b) => (b.kind === 'lady' ? '#140C0C' : b.kind === 'ant' ? (b.red ? '#4A1E10' : '#1A1210') : '#0D0B0E');

    function drawLegs(b, ca, sa, tuck) {
      const sp = b.sp, L = b.L;
      g.strokeStyle = legCol(b);
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (let i = 0; i < 6; i++) {
        const ft = b.feet[i];
        const side = i < 3 ? -1 : 1, k = i % 3;
        const hx = sp.hips[k][0] * L, hy = side * sp.hips[k][1] * L;
        // foot into body-local coordinates
        let fx, fy;
        if (tuck) {
          fx = hx + (sp.feet[k][0] * L - hx) * 0.45; fy = hy + (side * sp.feet[k][1] * L - hy) * 0.4;
        } else {
          const dx = ft.x - b.x, dy = ft.y - b.y;
          fx = dx * ca + dy * sa; fy = -dx * sa + dy * ca;
          if (b.dead && ft.tw !== undefined) {
            const age = (tNow - b.deadAt) / 1000;
            const tw = age < 0.9 ? Math.sin(age * 40 + ft.tw) * 1.6 * (1 - age / 0.9) : 0;
            fx += tw; fy += tw * 0.5;
          }
        }
        const a = sp.fem * L, c2 = sp.tib * L;
        let dx = fx - hx, dy = fy - hy;
        let d = Math.hypot(dx, dy);
        if (d > a + c2 - 0.01) { const kk = (a + c2 - 0.01) / d; dx *= kk; dy *= kk; d = a + c2 - 0.01; fx = hx + dx; fy = hy + dy; }
        d = Math.max(d, Math.abs(a - c2) + 0.01);
        // knee: law of cosines, bent outward (away from the body axis)
        const cosA = clamp((a * a + d * d - c2 * c2) / (2 * a * d), -1, 1);
        const base = Math.atan2(dy, dx), off = Math.acos(cosA);
        const k1 = base + off, k2 = base - off;
        const kx1 = hx + Math.cos(k1) * a, ky1 = hy + Math.sin(k1) * a;
        const kx2 = hx + Math.cos(k2) * a, ky2 = hy + Math.sin(k2) * a;
        const out1 = Math.abs(ky1) > Math.abs(ky2);
        const kx = out1 ? kx1 : kx2, ky = out1 ? ky1 : ky2;
        const lift = ft.lift || 0;
        g.lineWidth = Math.max(1, sp.legW * L * 1.25);
        g.beginPath(); g.moveTo(hx, hy); g.lineTo(kx, ky); g.stroke();
        g.lineWidth = Math.max(0.8, sp.legW * L * (0.85 - lift * 0.2));
        g.beginPath(); g.moveTo(kx, ky); g.lineTo(fx, fy); g.stroke();
        // tarsus: a short hooked tip
        if (b.kind !== 'lady') {
          g.lineWidth = Math.max(0.6, sp.legW * L * 0.55);
          const ta = Math.atan2(fy - ky, fx - kx);
          g.beginPath(); g.moveTo(fx, fy); g.lineTo(fx + Math.cos(ta + side * 0.5) * L * 0.08, fy + Math.sin(ta + side * 0.5) * L * 0.08); g.stroke();
        }
      }
    }

    function drawAntennae(b, t, still) {
      const L = b.L;
      const amp = still ? 0.42 : 0.2, fr = still ? 7 : 3.4;
      g.strokeStyle = legCol(b);
      g.lineCap = 'round';
      for (const side of [-1, 1]) {
        // left and right sweep in antiphase
        const sw = Math.sin(t / 1000 * fr + b.antPh + (side > 0 ? Math.PI : 0)) * amp;
        if (b.kind === 'ant') {
          const hx = L * 0.47, hy = side * L * 0.05;
          const a1 = side * (0.9 + sw * 0.5);
          const sx = hx + Math.cos(a1) * L * 0.22, sy = hy + Math.sin(a1) * L * 0.22;
          const a2 = side * (-0.25 + sw) + (b.meet > 0 ? side * -0.3 : 0);
          g.lineWidth = Math.max(0.7, L * 0.05);
          g.beginPath(); g.moveTo(hx, hy); g.lineTo(sx, sy);
          g.lineTo(sx + Math.cos(a2) * L * 0.3, sy + Math.sin(a2) * L * 0.3); g.stroke();
        } else if (b.kind === 'lady') {
          const hx = L * 0.46, hy = side * L * 0.06, an = side * (0.55 + sw * 0.6);
          g.lineWidth = Math.max(0.7, L * 0.035);
          const ex = hx + Math.cos(an) * L * 0.16, ey = hy + Math.sin(an) * L * 0.16;
          g.beginPath(); g.moveTo(hx, hy); g.lineTo(ex, ey); g.stroke();
          g.fillStyle = legCol(b);
          g.beginPath(); g.arc(ex, ey, L * 0.03, 0, 6.2832); g.fill();
        } else {
          const hx = L * 0.5, hy = side * L * 0.05;
          const an = side * (0.38 + sw * 0.7);
          g.lineWidth = Math.max(0.8, L * 0.03);
          g.beginPath(); g.moveTo(hx, hy);
          g.quadraticCurveTo(hx + Math.cos(an) * L * 0.3, hy + Math.sin(an) * L * 0.3,
            hx + Math.cos(an + side * 0.35) * L * 0.58, hy + Math.sin(an + side * 0.35) * L * 0.58);
          g.stroke();
        }
      }
    }

    // world light direction expressed in the bug's frame (for highlights)
    const localLight = (ca, sa) => [(-LDX) * ca + (-LDY) * sa, -(-LDX) * sa + (-LDY) * ca];

    function drawLady(b, ca, sa, open) {
      const L = b.L;
      const [lx, ly] = localLight(ca, sa);
      // pronotum + head
      g.fillStyle = '#121012';
      g.beginPath(); g.ellipse(L * 0.4, 0, L * 0.09, L * 0.14, 0, 0, 6.2832); g.fill();
      g.beginPath(); g.ellipse(L * 0.29, 0, L * 0.13, L * 0.27, 0, 0, 6.2832); g.fill();
      g.fillStyle = '#F2EEE4';
      g.beginPath(); g.ellipse(L * 0.3, -L * 0.17, L * 0.06, L * 0.065, 0, 0, 6.2832); g.fill();
      g.beginPath(); g.ellipse(L * 0.3, L * 0.17, L * 0.06, L * 0.065, 0, 0, 6.2832); g.fill();
      g.beginPath(); g.ellipse(L * 0.45, -L * 0.06, L * 0.022, L * 0.03, 0, 0, 6.2832); g.fill();
      g.beginPath(); g.ellipse(L * 0.45, L * 0.06, L * 0.022, L * 0.03, 0, 0, 6.2832); g.fill();
      if (open > 0) drawWings(b, open);
      // elytra: two halves, hinged at the front of the seam
      for (const side of [-1, 1]) {
        g.save();
        g.translate(L * 0.2, 0);
        g.rotate(side * open * 0.9);
        g.translate(-L * 0.2, 0);
        const grd = g.createRadialGradient(-L * 0.04 + lx * L * 0.16, side * L * 0.1 + ly * L * 0.16, L * 0.02, -L * 0.04, side * L * 0.1, L * 0.36);
        grd.addColorStop(0, '#FF6A4C'); grd.addColorStop(0.55, '#D8261B'); grd.addColorStop(1, '#8E0E0A');
        g.fillStyle = grd;
        g.beginPath();
        g.ellipse(-L * 0.06, 0, L * 0.38, L * 0.37, 0, side < 0 ? Math.PI : 0, side < 0 ? Math.PI * 2 : Math.PI);
        g.closePath(); g.fill();
        g.fillStyle = '#120B0A';
        b.spots.forEach(([sx, sy, sr]) => {
          if (sy * side < 0) return;
          if (sy === 0) { g.beginPath(); g.ellipse(sx * L, 0, sr * L, sr * L * 0.9, 0, side < 0 ? Math.PI : 0, side < 0 ? Math.PI * 2 : Math.PI); g.fill(); return; }
          g.beginPath(); g.arc(sx * L, sy * L, sr * L, 0, 6.2832); g.fill();
        });
        // specular: glossy dome, highlight toward the light
        g.fillStyle = 'rgba(255,255,255,.55)';
        g.beginPath(); g.ellipse(-L * 0.04 + lx * L * 0.2, side * L * 0.1 + ly * L * 0.2, L * 0.07, L * 0.035, Math.atan2(ly, lx), 0, 6.2832); g.fill();
        g.restore();
      }
      g.strokeStyle = 'rgba(40,0,0,.55)'; g.lineWidth = 0.8;
      if (open < 0.05) { g.beginPath(); g.moveTo(L * 0.2, 0); g.lineTo(-L * 0.43, 0); g.stroke(); }
    }

    function drawBeetle(b, ca, sa, open) {
      const L = b.L, [r0, g0, b0] = b.hue;
      const [lx, ly] = localLight(ca, sa);
      // mandibles + head
      g.fillStyle = '#0C0A0C';
      g.beginPath(); g.ellipse(L * 0.41, 0, L * 0.09, L * 0.1, 0, 0, 6.2832); g.fill();
      g.strokeStyle = '#0C0A0C'; g.lineWidth = Math.max(1, L * 0.035);
      g.beginPath(); g.moveTo(L * 0.47, -L * 0.04); g.quadraticCurveTo(L * 0.55, -L * 0.05, L * 0.55, 0); g.stroke();
      g.beginPath(); g.moveTo(L * 0.47, L * 0.04); g.quadraticCurveTo(L * 0.55, L * 0.05, L * 0.55, 0); g.stroke();
      // pronotum: rounded, heart-shaped shield
      const pg = g.createLinearGradient(0, -L * 0.15 + ly * L * 0.1, 0, L * 0.15);
      pg.addColorStop(0, `rgb(${r0 + 40},${g0 + 40},${b0 + 40})`); pg.addColorStop(1, '#09080A');
      g.fillStyle = pg;
      g.beginPath(); g.ellipse(L * 0.26, 0, L * 0.12, L * 0.15, 0, 0, 6.2832); g.fill();
      if (open > 0) drawWings(b, open);
      for (const side of [-1, 1]) {
        g.save();
        g.translate(L * 0.14, side * L * 0.01);
        g.rotate(side * open * 0.8);
        g.translate(-L * 0.14, -side * L * 0.01);
        const eg = g.createLinearGradient(0, side * L * 0.18, 0, 0);
        eg.addColorStop(0, '#060507'); eg.addColorStop(0.55, `rgb(${r0},${g0},${b0})`); eg.addColorStop(1, `rgb(${r0 * 0.5 | 0},${g0 * 0.5 | 0},${b0 * 0.5 | 0})`);
        g.fillStyle = eg;
        g.beginPath();
        g.ellipse(-L * 0.12, 0, L * 0.3, L * 0.18, 0, side < 0 ? Math.PI : 0, side < 0 ? Math.PI * 2 : Math.PI);
        g.closePath(); g.fill();
        // striae
        g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 0.6;
        for (const yy of [0.05, 0.1]) { g.beginPath(); g.moveTo(L * 0.1, side * L * yy); g.lineTo(-L * 0.36, side * L * yy * 0.7); g.stroke(); }
        // metallic streak toward the light
        g.strokeStyle = `rgba(${Math.min(255, r0 * 3 + 60)},${Math.min(255, g0 * 3 + 60)},${Math.min(255, b0 * 3 + 60)},${0.35 + 0.35 * Math.max(0, -ly * side)})`;
        g.lineWidth = Math.max(1, L * 0.035);
        g.beginPath(); g.moveTo(L * 0.08, side * L * 0.08); g.quadraticCurveTo(-L * 0.12, side * L * 0.11, -L * 0.33, side * L * 0.05); g.stroke();
        g.restore();
      }
      if (open < 0.05) { g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 0.8; g.beginPath(); g.moveTo(L * 0.14, 0); g.lineTo(-L * 0.42, 0); g.stroke(); }
    }

    function drawAnt(b, ca, sa) {
      const L = b.L;
      const [lx, ly] = localLight(ca, sa);
      const body = b.red ? '#7A2E16' : '#1E1612', gas = '#14100E';
      g.fillStyle = gas;
      g.beginPath(); g.ellipse(-L * 0.28, 0, L * 0.21, L * 0.15, 0, 0, 6.2832); g.fill();
      g.fillStyle = 'rgba(255,255,255,.28)';
      g.beginPath(); g.ellipse(-L * 0.28 + lx * L * 0.08, ly * L * 0.07, L * 0.06, L * 0.03, 0, 0, 6.2832); g.fill();
      g.fillStyle = body;
      g.beginPath(); g.ellipse(-L * 0.04, 0, L * 0.04, L * 0.045, 0, 0, 6.2832); g.fill();         // petiole node
      g.beginPath(); g.ellipse(L * 0.1, 0, L * 0.13, L * 0.065, 0, 0, 6.2832); g.fill();           // mesosoma
      g.fillStyle = b.red ? '#3A160C' : gas;
      g.beginPath(); g.ellipse(L * 0.36, 0, L * 0.11, L * 0.1, 0, 0, 6.2832); g.fill();            // head
      if (b.crumb) { g.fillStyle = '#F3EBD6'; g.beginPath(); g.ellipse(L * 0.52, 0, L * 0.09, L * 0.07, 0.4, 0, 6.2832); g.fill(); }
    }

    function drawWings(b, open) {
      // hind wings: translucent membranes, flapping (motion-blurred)
      const L = b.L, fl = 0.75 + 0.25 * Math.sin(tNow * 0.09);
      g.fillStyle = `rgba(210,200,185,${0.32 * open})`;
      for (const side of [-1, 1]) {
        g.beginPath();
        g.ellipse(-L * 0.12, side * L * 0.36 * fl * open, L * 0.36, L * 0.22 * open, side * 0.4, 0, 6.2832);
        g.fill();
      }
    }

    function drawBug(b, t) {
      const L = b.L, z = b.z;
      const ang = b.a + b.sway;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const sc = 1 + z / 520;                       // closer to the viewer as it rises
      // shadow: offset away from the light, softer and fainter with height
      const so = 1.6 + z * 0.55;
      const sw = b.sp.shadow;
      g.save();
      g.globalAlpha = b.alpha * clamp(0.75 - z / 160, 0.18, 0.75) * (dark ? 0.8 : 1);
      g.translate(b.x + LDX * so, b.y + LDY * so);
      g.rotate(ang);
      const blur = 1 + z / 40;
      g.drawImage(SH, -L * 0.55 * sw[0] * blur, -L * 0.55 * sw[1] * blur, L * 1.1 * sw[0] * blur, L * 1.1 * sw[1] * blur);
      g.restore();

      g.save();
      g.globalAlpha = b.alpha;
      g.translate(b.x, b.y - z * 0.15);
      g.rotate(ang);
      g.scale(sc * (b.dead ? 1.12 : 1), sc * (b.dead ? 1.18 : 1));
      const open = b.fly ? b.fly.open : 0;
      drawLegs(b, ca, sa, z > 3);
      if (!b.dead) drawAntennae(b, t, b.v < 4);
      if (b.kind === 'lady') drawLady(b, ca, sa, open);
      else if (b.kind === 'beetle') drawBeetle(b, ca, sa, open);
      else drawAnt(b, ca, sa);
      if (b.dead) {
        // crushed: darker, with a crack across the shell
        g.fillStyle = 'rgba(0,0,0,.28)';
        g.beginPath(); g.ellipse(-L * 0.05, 0, L * 0.38, L * 0.3, 0, 0, 6.2832); g.fill();
        g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 0.7;
        g.beginPath(); g.moveTo(L * 0.2, -L * 0.2); g.lineTo(-L * 0.02, L * 0.02); g.lineTo(-L * 0.1, -L * 0.04); g.lineTo(-L * 0.3, L * 0.22); g.stroke();
      }
      g.restore();
    }

    function drawSplat(sp, t, alpha) {
      const age = (t - sp.t0) / 1000;
      const [r, gg, bb] = sp.col;
      g.save();
      g.globalAlpha = alpha;
      g.translate(sp.x, sp.y);
      // smear under the body
      g.fillStyle = `rgba(${r * 0.7 | 0},${gg * 0.7 | 0},${bb * 0.7 | 0},.55)`;
      g.beginPath(); g.ellipse(0, 0, sp.b.L * 0.55, sp.b.L * 0.42, sp.smear, 0, 6.2832); g.fill();
      g.fillStyle = `rgba(${r},${gg},${bb},.82)`;
      g.strokeStyle = `rgba(${r},${gg},${bb},.7)`;
      g.lineCap = 'round';
      sp.drops.forEach((d) => {
        const k = 1 - Math.exp(-age / d.tau);
        const dist = d.reach * k + sp.b.L * 0.3;
        const x = Math.cos(d.a) * dist, y = Math.sin(d.a) * dist;
        // streak from where it left the body to where it is
        if (d.r > 0.9) {
          // a tail where the drop smeared across the glass
          g.lineWidth = d.r * 0.75;
          g.beginPath(); g.moveTo(x - Math.cos(d.a) * d.reach * k * 0.45, y - Math.sin(d.a) * d.reach * k * 0.45); g.lineTo(x, y); g.stroke();
        }
        g.beginPath(); g.ellipse(x, y, d.r * (1 + 0.6 * (1 - k)), d.r, d.a, 0, 6.2832); g.fill();
      });
      g.restore();
    }

    /* ---- trail ants ------------------------------------------------------------ */
    function antOnTrail(b, dt, t) {
      const s = dt / 1000;
      if (b.meet > 0) { b.meet -= dt; b.v = 0; return; }
      const speed = b.cruise;
      b.ts += b.tdir * speed * s;
      if (t < OUT_AT) {
        if (b.ts > TRAIL_LEN + 20) { b.ts = -rand(20, 120); }
        if (b.ts < -140) { b.ts = TRAIL_LEN + rand(20, 120); }
      }
      // osmotropotactic zig-zag about the trail, keeping to a lane
      const [px, py, pa] = trailAt(b.ts);
      const zz = Math.sin(b.ts / (b.L * 2.6) * Math.PI * 2 + b.antPh) * 1.8;
      const lat = b.lane + zz;
      const nx = -Math.sin(pa), ny = Math.cos(pa);
      const x = px + nx * lat, y = py + ny * lat;
      const a = Math.atan2(y - b.y, x - b.x);
      const moved = Math.hypot(x - b.x, y - b.y);
      if (moved > 0.01) b.a = a;
      b.v = moved / Math.max(0.001, s);
      b.x = x; b.y = y;
      // head-on meeting: stop and antennate
      if (!b.met || t - b.met > 2500) {
        for (const o of list) {
          if (o === b || o.kind !== 'ant' || o.mode !== 'trail' || o.tdir === b.tdir || o.dead) continue;
          if (Math.abs(o.ts - b.ts) < b.L * 0.9 && Math.random() < 0.5) {
            const d = rand(250, 600);
            b.meet = d; o.meet = d; b.met = t; o.met = t;
            break;
          }
        }
      }
    }

    /* ---- main loop --------------------------------------------------------------- */
    let tNow = 0;
    let leaving = false;
    loop((dt, t) => {
      if (t > total) return false;
      dt = Math.max(0, dt);
      tNow = t;
      const s = dt / 1000;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, g.canvas.width, g.canvas.height);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (!leaving && t >= OUT_AT) {
        leaving = true;
        for (const b of list) {
          if (b.dead) continue;
          b.hidden = false; b.hide = null; b.edge = null; b.pause = 0; b.meet = 0;
          // nearest way off the screen
          const dl = b.x, dr = W - b.x, dtp = b.y, db = H - b.y, m = Math.min(dl, dr, dtp, db);
          b.ex = m === dl ? -60 : m === dr ? W + 60 : b.x + rand(-40, 40);
          b.ey = m === dtp ? -60 : m === db ? H + 60 : b.y + rand(-40, 40);
          if (b.kind === 'lady' && !reduced && !b.fly && Math.random() < 0.7) takeOff(b, 0, [b.x + (b.ex - b.x) * 1.6, b.y + (b.ey - b.y) * 1.6]);
          else if (!b.fly) b.mode = 'leave';
        }
      }

      const fadeEnd = clamp((total - t) / 180, 0, 1);
      const splatA = envelope(t, total, 1, OUT * 0.7);
      splats.forEach((sp) => drawSplat(sp, t, splatA));

      for (const b of list) {
        b.alpha = fadeEnd;
        if (b.dead) { drawBug(b, t); continue; }
        if (t < b.wakeAt) continue;

        if (b.mode === 'fly' && b.fly) {
          const fl = b.fly;
          fl.t += dt;
          if (fl.t < fl.prep) {
            fl.open = easeOut3(fl.t / fl.prep);
          } else if (fl.t < fl.prep + fl.dur) {
            const p = (fl.t - fl.prep) / fl.dur;
            const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
            const nx = fl.x0 + (fl.tx - fl.x0) * e, ny = fl.y0 + (fl.ty - fl.y0) * e;
            b.a += wrap(Math.atan2(ny - b.y, nx - b.x) - b.a) * Math.min(1, s * 10);
            b.x = nx; b.y = ny;
            b.z = 4 * fl.zmax * p * (1 - p) * (fl.away ? 1 + p : 1);
            fl.open = 1;
          } else if (fl.t < fl.prep + fl.dur + fl.land && !fl.away) {
            b.z = 0;
            fl.open = 1 - easeOut3((fl.t - fl.prep - fl.dur) / fl.land);
          } else if (!fl.away) {
            b.fly = null; b.z = 0; b.mode = leaving ? 'leave' : 'explore'; b.pause = rand(200, 700); b.resetFeet = true;
          }
          drawBug(b, t);
          continue;
        }

        if (b.mode === 'trail' && !leaving) {
          antOnTrail(b, dt, t);
          stepLegs(b, dt, 0);
          // pointer near the trail: that ant bolts off it
          const dp = Math.hypot(b.x - mx, b.y - my);
          if (dp < 60 + b.L * 2) { startle(b, mx, my, 1); }
          drawBug(b, t);
          continue;
        }

        const res = think(b, dt, t);
        let want = b.a, speed = 0;
        if (res) { want = res[0]; speed = res[1]; }
        const turn = clamp(wrap(want - b.a), -b.sp.turn * s * (speed > b.cruise * 1.5 ? 2 : 1), b.sp.turn * s * (speed > b.cruise * 1.5 ? 2 : 1));
        b.a += turn;
        // insects accelerate and stop fast (~80 ms)
        b.v += (speed - b.v) * Math.min(1, s * 12);
        b.x += Math.cos(b.a) * b.v * s;
        b.y += Math.sin(b.a) * b.v * s;
        stepLegs(b, dt, turn / Math.max(0.001, s));
        if (b.hidden && b.hide && b.hide.stage === 'under') continue;
        if (b.hide) {
          // half under a card: clip the bug to outside that card
          const r = b.hide.r;
          g.save();
          g.beginPath(); g.rect(-10, -10, W + 20, H + 20); g.rect(r.x, r.y, r.w, r.h);
          g.clip('evenodd');
          drawBug(b, t);
          g.restore();
        } else drawBug(b, t);
      }
    });

    return total;
  }

  sfx.register('bugs', bugs);
})();
