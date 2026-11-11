/* Screenick effect module — registers into the runtime in content.js. */
(() => {
  const sfx = window.__screenick;
  if (!sfx || !sfx.kit) return;
  // eslint-disable-next-line no-unused-vars
  const { R, SPRING, SPRING_MS, rand, rint, pick, clamp, svgFrom, el, div, later, listen, loop, canvasLayer, envelope, easeOut3, easeIn2, shake, breathe, pageLuminance, gl, lockScroll, blocks } = sfx.kit;

  /* ========================================================================
   * 5. CONFETTI — two air cannons fire from the bottom corners, a steady rain
   *    keeps it going, the paper lands and piles up ON THE PAGE (headings,
   *    images, buttons, cards, the bottom of the window), and a gust clears
   *    it all away at the end.
   *
   *    MODEL. Each piece is a thin plate falling through air, simulated with
   *    the quasi-steady model of Andersen, Pesavento & Wang (JFM 541, 2005):
   *    body-frame equations with added mass (m22 = pi rho l^2 / 4), the Munk
   *    moment (m11 - m22) u v that turns a plate broadside, circulation
   *    Gamma = -1/2 C_T l uv/|V| + 1/2 C_R l^2 w (translational + rotational
   *    lift), drag 1/2 rho l (A - B cos 2a) |V|, and a rotational damping
   *    torque. A=1.4 B=1.0 C_T=1.2 C_R=pi. Damping is solved implicitly, so a
   *    2 ms step stays stable. Depending on size, paper weight and damping,
   *    the same equations give the two real regimes for free: FLUTTER (side
   *    to side glides with a swoop at each turn) and TUMBLE (autorotation
   *    with a slanted glide), plus chaos between them. Terminal speeds come
   *    out at 0.2-0.5 m/s, like real paper confetti.
   *
   *    Each piece moves in a vertical "flutter plane" whose azimuth slowly
   *    precesses, which gives the helical, 3-D look; that orientation drives
   *    lighting (two-sided paper, metallic foil with a sharp glint).
   *
   *    AIR. The cannon is a decaying jet of air, not a velocity kick: paper
   *    has almost no momentum of its own, so it rides the jet up, the jet
   *    dies, and the plates fall back into flutter. Turbulence is an
   *    Ornstein-Uhlenbeck gust per piece plus a slow shared drift.
   *
   *    THE PAGE. Visible top edges of real elements are shelves; each keeps a
   *    1-D heightfield, so paper stacks, slides down slopes steeper than its
   *    angle of repose, spills off the ends, and some pieces bounce
   *    (restitution 0.2-0.35). Resting paper is baked into a canvas so piles
   *    cost nothing per frame.
   * ====================================================================== */

  /* Top edges you could actually set something on: things that look solid
     (media, controls, styled boxes) and the real glyph line of headings. */
  function shelves(W, H) {
    const out = [];
    const seen = new Set();
    const topVisible = (n, x0, x1, y) => {
      let ok = 0;
      for (const f of [0.2, 0.5, 0.8]) {
        const hit = document.elementFromPoint(clamp(x0 + (x1 - x0) * f, 1, W - 1), clamp(y + 2, 1, H - 1));
        if (hit && (hit === n || n.contains(hit) || hit.contains(n))) ok++;
      }
      return ok >= 2;
    };
    const add = (x0, x1, y, k, kind) => {
      x0 = Math.max(0, x0); x1 = Math.min(W, x1);
      if (x1 - x0 < 28 || y < 26 || y > H - 18) return;
      out.push({ x0, x1, y, k, kind });
    };

    // Solid things straight out of the runtime's layout scan.
    const SOLID = { img: 0.75, video: 0.75, canvas: 0.7, picture: 0.75, svg: 0.6, button: 0.75, input: 0.7,
      textarea: 0.7, select: 0.7, table: 0.5, pre: 0.6, figure: 0.6, blockquote: 0.5 };
    let base = [];
    try { base = blocks({ max: 220, minSize: 28 }); } catch (err) { base = []; }
    base.forEach((b) => {
      if (SOLID[b.tag] && b.h >= 14) {
        const key = Math.round(b.x) + ':' + Math.round(b.y);
        if (seen.has(key)) return;
        seen.add(key);
        const n = document.elementFromPoint(clamp(b.x + b.w / 2, 1, W - 1), clamp(b.y + 3, 1, H - 1));
        if (n && n.closest && n.closest('#__screenick_root')) return;
        add(b.x, b.x + b.w, b.y, SOLID[b.tag], b.tag);
      }
    });

    // Headings: the top of the letters, over the width of the first line of
    // text only (the box itself runs on into thin air).
    const hs = document.querySelectorAll('h1,h2,h3');
    for (let i = 0; i < hs.length && i < 40; i++) {
      const h = hs[i];
      const r0 = h.getBoundingClientRect();
      if (r0.bottom < 0 || r0.top > H || r0.width < 30) continue;
      try {
        const rg = document.createRange();
        rg.selectNodeContents(h);
        const lines = rg.getClientRects();
        if (!lines.length) continue;
        const ln = lines[0];
        const fs = parseFloat(getComputedStyle(h).fontSize) || 24;
        const y = ln.top + (ln.height - fs) / 2 + fs * 0.24;    // cap height sits ~0.24em under the em-box top
        let x1 = ln.right;
        for (let j = 1; j < lines.length && Math.abs(lines[j].top - ln.top) < 2; j++) x1 = Math.max(x1, lines[j].right);
        if (topVisible(h, ln.left, x1, y)) add(ln.left + 2, x1 - 2, y, 0.45, 'text');
      } catch (err) { /* detached or odd node */ }
    }

    // Styled boxes: cards, bars, pills. Anything with a fill, border or shadow
    // has a real visible top edge. Capped so a huge DOM cannot stall us.
    const cand = document.body ? document.body.querySelectorAll('div,section,article,aside,header,nav,footer,main,li,a,span,form,ul,ol,td') : [];
    let visited = 0;
    for (let i = 0; i < cand.length && visited < 1600 && out.length < 120; i++) {
      const n = cand[i];
      const r = n.getBoundingClientRect();
      if (r.width < 40 || r.height < 18 || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue;
      if (r.width > W * 0.96 && r.height > H * 0.7) continue;           // page wrappers
      visited++;
      const cs = getComputedStyle(n);
      if (cs.visibility === 'hidden' || +cs.opacity < 0.3) continue;
      const bg = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
      const bga = bg ? (bg[1].split(',')[3] === undefined ? 1 : parseFloat(bg[1].split(',')[3])) : 0;
      const styled = bga > 0.3 || parseFloat(cs.borderTopWidth) > 0.4 && !/transparent|rgba\([^)]*,\s*0\)/.test(cs.borderTopColor) ||
        (cs.boxShadow && cs.boxShadow !== 'none') || cs.backgroundImage !== 'none';
      if (!styled) continue;
      const key = Math.round(r.left) + ':' + Math.round(r.top);
      if (seen.has(key)) continue;
      seen.add(key);
      const rad = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, r.width / 3);
      if (topVisible(n, r.left + rad, r.right - rad, r.top)) add(r.left + rad * 0.6, r.right - rad * 0.6, r.top, 0.6, 'box');
    }

    // Merge shelves that are the same edge seen twice.
    out.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const merged = [];
    out.forEach((s) => {
      const m = merged.find((q) => Math.abs(q.y - s.y) < 2.5 && s.x0 < q.x1 + 4 && s.x1 > q.x0 - 4);
      if (m) { m.x0 = Math.min(m.x0, s.x0); m.x1 = Math.max(m.x1, s.x1); m.k = Math.max(m.k, s.k); }
      else merged.push(s);
    });
    // The bottom of the window always catches everything.
    merged.push({ x0: -40, x1: W + 40, y: H, k: 1, kind: 'floor' });
    return merged.slice(0, 90);
  }

  function confetti(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const reduced = ctx.reduced;
    const f = ctx.fit(1700, 1500, 400);
    const OUT_AT = f.intro + f.hold, OUT = f.outro;
    const total = OUT_AT + OUT;

    /* ---- physical scale ---------------------------------------------------
       The window is treated as a ~0.95 m tall pane, so 1 cm pieces are about
       8-13 px and the fall speeds above land at 160-400 px/s. */
    const PXM = clamp(H * 1.05, 620, 1150);
    const RHO = 1.2, G = 9.81, A = 1.4, B = 1.0, CT = 1.2, CR = Math.PI;
    const HSTEP = 1 / 500;
    const CAM = 0.36;                                 // the viewer looks down ~20 degrees
    const cb = Math.cos(CAM), sb = Math.sin(CAM);
    // Light from upper left, slightly in front of the screen (y is down).
    const LX = -0.38, LY = -0.78, LZ = 0.5;
    const ll = Math.hypot(LX, LY, LZ);
    const Lx = LX / ll, Ly = LY / ll, Lz = LZ / ll;

    const PAPER = [[255, 210, 63], [255, 77, 109], [63, 216, 232], [255, 159, 28], [155, 93, 229],
      [46, 196, 182], [241, 91, 181], [250, 250, 246], [120, 200, 80]];
    const FOIL = [[214, 178, 82], [205, 210, 218], [232, 150, 160], [110, 170, 235]];

    // Bake layer (resting paper) under the live layer.
    const bake = canvasLayer(stage, 'sfx-cf-bake');
    const live = canvasLayer(stage, 'sfx-cf-live');
    const bg = bake.g, g = live.g, dpr = live.dpr;

    let surf = [];
    try { surf = shelves(W, H); } catch (err) { surf = [{ x0: -40, x1: W + 40, y: H, k: 1, kind: 'floor' }]; }
    const BIN = 3;
    surf.forEach((s, i) => { s.id = i; s.n = Math.max(1, Math.ceil((s.x1 - s.x0) / BIN)); s.hf = new Float32Array(s.n); });
    // Column hash: which shelves cover each 40px column.
    const COL = 40, cols = [];
    for (let c = 0; c <= Math.ceil((W + 80) / COL); c++) cols.push([]);
    surf.forEach((s) => {
      for (let c = Math.max(0, Math.floor((s.x0 + 40) / COL)); c <= Math.min(cols.length - 1, Math.floor((s.x1 + 40) / COL)); c++) cols[c].push(s);
    });

    const P = [];                     // airborne + landing pieces
    const rest = [];                  // resting (baked) pieces
    const CAP_LIVE = reduced ? 260 : 760;
    const CAP_ALL = reduced ? 600 : 1700;
    let spawned = 0, idc = 0;

    const make = (X, Y, vxw, vyw, jet) => {
      if (P.length >= CAP_LIVE || spawned >= CAP_ALL) return null;
      spawned++;
      const foil = Math.random() < 0.18;
      const shape = foil ? pick(['rect', 'rect', 'circle']) : pick(['rect', 'rect', 'rect', 'strip', 'circle']);
      const wpx = shape === 'strip' ? rand(3.6, 5) : rand(7.5, 12);
      const hpx = shape === 'strip' ? rand(16, 24) : shape === 'circle' ? wpx : wpx * rand(1.05, 1.6);
      const l = wpx / PXM;
      const sigma = foil ? rand(0.035, 0.05) : rand(0.05, 0.09);   // kg/m^2: tissue-ish paper, metallised film
      const m = sigma * l, m22 = Math.PI * RHO * l * l / 4;
      const p = {
        id: idc++, X, Y, shape, foil, wpx, hpx, l, m, m22,
        I: m * l * l / 12 + Math.PI * RHO * l ** 4 / 128,
        tl: Math.PI * RHO * l ** 4 / 32,
        mu: rand(0.28, 0.55), sq: Math.sqrt(G / l),
        th: rand(-Math.PI, Math.PI), w: rand(-8, 8),
        phi: rand(0, Math.PI * 2), dphi: rand(-0.9, 0.9),
        u: 0, v: 0, q: 0,
        ax: 0, ay: 0, az: 0,
        jet,
        col: foil ? pick(FOIL) : pick(PAPER),
        bouncy: !reduced && Math.random() < (foil ? 0.5 : 0.22),
        e: rand(0.18, 0.34),
        st: 0,                     // 0 air, 1 landing, 2 resting (in P only during outro)
        lastShelf: -1, ignore: 0
      };
      setWorldVel(p, vxw, vyw);
      P.push(p);
      return p;
    };

    // world velocity (m/s, y up) in the flutter plane -> body frame
    function setWorldVel(p, vs, vy) {
      const c = Math.cos(p.th), s = Math.sin(p.th);
      p.u = vs * c + vy * s;
      p.v = -vs * s + vy * c;
    }
    const worldVel = (p) => {
      const c = Math.cos(p.th), s = Math.sin(p.th);
      return [p.u * c - p.v * s, p.u * s + p.v * c];
    };

    /* ---- cannons ---------------------------------------------------------- */
        const cannon = (left) => {
      const n = Math.round((reduced ? 55 : 170) * clamp(W / 1280, 0.7, 1.4));
      const reach = rand(0.62, 0.8) * H / PXM;        // metres the jet carries paper
      for (let i = 0; i < n; i++) {
        const a = (left ? 1 : -1) * rand(0.12, 0.62);  // off vertical, toward the middle
        const U0 = (reach / 0.3) * 1.9 * rand(0.62, 1.08);
        const dir = [Math.sin(a), Math.cos(a)];
        const p = make(left ? rand(-6, 26) : W - rand(-6, 26), H + rand(-4, 18), dir[0] * U0 * 0.6, dir[1] * U0 * 0.6,
          { U0, dir, t0: 0, tau: rand(0.24, 0.34) });
        if (p) p.phiJet = true;
      }
    };
    if (!reduced) { cannon(true); later(() => cannon(false), 110); }
    else { cannon(true); cannon(false); }

    /* ---- outro breeze ----------------------------------------------------- */
    const windDir = Math.random() < 0.5 ? 1 : -1;
    const frontX = (t) => {                           // gust front position, px
      const k = clamp((t - OUT_AT) / (OUT * 0.5), 0, 1);
      const x = easeIn2(k) * (W + 200) - 100;
      return windDir > 0 ? x : W - x;
    };
    const gusted = (X, t) => t >= OUT_AT && (windDir > 0 ? X < frontX(t) : X > frontX(t));

    /* ---- shading ---------------------------------------------------------- */
    // Orientation of the plate in screen space (x right, y down, z to viewer).
    const orient = (p, out) => {
      const c = Math.cos(p.th), s = Math.sin(p.th), cp = Math.cos(p.phi), sp = Math.sin(p.phi);
      // chord axis in the flutter plane, span axis horizontal across it
      const ax = c * cp, ay = -s, az = c * sp;
      const bx = -sp, by = 0, bz = cp;
      // normal = chord x span
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      // camera tilt about x
      const ay2 = ay * cb - az * sb, az2 = ay * sb + az * cb;
      const by2 = by * cb - bz * sb;
      const ny2 = ny * cb - nz * sb, nz2 = ny * sb + nz * cb;
      ny = ny2; nz = nz2;
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }  // two-sided: shade the face we see
      out[0] = ax * p.wpx; out[1] = ay2 * p.wpx; out[2] = bx * p.hpx; out[3] = by2 * p.hpx;
      out[4] = nx; out[5] = ny; out[6] = nz; out[7] = az2;
      return out;
    };
    const shadeOf = (p, nx, ny, nz) => {
      const nl = nx * Lx + ny * Ly + nz * Lz;
      const dif = Math.abs(nl);
      const [r0, g0, b0] = p.col;
      let r, gg, b;
      if (p.foil) {
        // metal: little diffuse, mirror-like lobe toward the eye (0,0,1)
        const rz = 2 * nl * nz - Lz;
        const spec = Math.pow(Math.max(0, rz), 46) * 1.6 + Math.pow(Math.max(0, rz), 6) * 0.35;
        const env = 0.5 + 0.3 * Math.max(0, -ny);           // sky above, floor below
        const k = 0.4 * env + 0.3 * dif + 0.26;
        r = r0 * k + 255 * spec; gg = g0 * k + 250 * spec; b = b0 * k + 240 * spec;
      } else {
        const k = 0.74 + 0.36 * dif;
        const spec = Math.pow(Math.max(0, 2 * nl * nz - Lz), 12) * 0.12;   // a little paper sheen
        r = r0 * k + 255 * spec; gg = g0 * k + 255 * spec; b = b0 * k + 255 * spec;
      }
      return 'rgb(' + (r > 255 ? 255 : r | 0) + ',' + (gg > 255 ? 255 : gg | 0) + ',' + (b > 255 ? 255 : b | 0) + ')';
    };
    const O = new Float64Array(8);
    const drawPiece = (ctx2, p, X, Y, alpha) => {
      orient(p, O);
      ctx2.globalAlpha = alpha;
      ctx2.fillStyle = shadeOf(p, O[4], O[5], O[6]);
      ctx2.setTransform(dpr * O[0], dpr * O[1], dpr * O[2], dpr * O[3], dpr * X, dpr * Y);
      if (p.shape === 'circle') { ctx2.beginPath(); ctx2.arc(0, 0, 0.5, 0, 6.2832); ctx2.fill(); }
      else ctx2.fillRect(-0.5, -0.5, 1, 1);
    };
    // vertical half-extent of the drawn piece (for contact)
    const halfY = () => (Math.abs(O[1]) + Math.abs(O[3])) * 0.5;

    /* ---- physics ---------------------------------------------------------- */
    const stepAir = (p, h, t) => {
      // air at the piece: jet + gust + slow shared drift + outro breeze
      p.ax += -p.ax * h / 0.4 + 0.12 * Math.sqrt(2 * h / 0.4) * (Math.random() * 2 - 1) * 1.73;
      p.ay += -p.ay * h / 0.4 + 0.10 * Math.sqrt(2 * h / 0.4) * (Math.random() * 2 - 1) * 1.73;
      p.az += -p.az * h / 0.4 + 0.12 * Math.sqrt(2 * h / 0.4) * (Math.random() * 2 - 1) * 1.73;
      let axw = p.ax + 0.06 * Math.sin(t * 0.00031 + p.Y * 0.004), ayw = p.ay, azw = p.az;
      if (p.jet) {
        const age = t / 1000 - p.jet.t0;
        const U = p.jet.U0 * Math.exp(-age / p.jet.tau);
        if (U < 0.02) p.jet = null;
        else { axw += p.jet.dir[0] * U; ayw += p.jet.dir[1] * U; }
      }
      if (gusted(p.X, t)) {
        const k = clamp((t - OUT_AT) / 260, 0, 1);
        axw += windDir * 3.4 * k; ayw += 0.9 * k;
      }
      const cp = Math.cos(p.phi), sp = Math.sin(p.phi);
      const as = axw * cp + azw * sp;                // in-plane horizontal air
      const aq = -axw * sp + azw * cp;               // across the plane
      const c = Math.cos(p.th), s = Math.sin(p.th);
      const au = as * c + ayw * s, av = -as * s + ayw * c;
      const ur = p.u - au, vr = p.v - av;
      const V = Math.sqrt(ur * ur + vr * vr) + 1e-9;
      const Gm = -0.5 * CT * p.l * ur * vr / V + 0.5 * CR * p.l * p.l * p.w;
      const Fd = 0.5 * RHO * p.l * (A - B * (ur * ur - vr * vr) / (V * V)) * V;
      const m = p.m, m22 = p.m22;
      p.u = (p.u + h * ((m + m22) * p.w * p.v - RHO * Gm * vr - m * G * s + Fd * au) / m) / (1 + h * Fd / m);
      p.v = (p.v + h * (-m * p.w * p.u + RHO * Gm * ur - m * G * c + Fd * av) / (m + m22)) / (1 + h * Fd / (m + m22));
      const damp = p.tl * (p.mu * p.sq + p.mu * Math.abs(p.w));
      p.w = (p.w + h * (-m22 * ur * vr) / p.I) / (1 + h * damp / p.I);
      p.th += p.w * h;
      p.phi += p.dphi * h;
      // across-plane motion: edge-on, weakly coupled to the air
      p.q += (aq - p.q) * Math.min(1, h / 0.12);
      const vs = p.u * c - p.v * s, vy = p.u * s + p.v * c;
      p.X += (vs * cp - p.q * sp) * PXM * h;
      p.Y -= vy * PXM * h;
    };

    const hash = (a, b) => {
      let x = (a * 374761393 + b * 668265263) | 0;
      x = (x ^ (x >>> 13)) * 1274126177 | 0;
      return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
    };

    // Put a piece down on shelf s near x: slide down the pile to a stable bin.
    const REPOSE = 0.8 * BIN;                        // ~38 degree angle of repose
    const settle = (p, s, X) => {
      let i = clamp(Math.floor((X - s.x0) / BIN), 0, s.n - 1);
      const foot = Math.max(1, Math.round(p.wpx * 0.9 / BIN));
      let moved = 0, off = 0;
      for (let k = 0; k < 60; k++) {
        const hl = i > 0 ? s.hf[i - 1] : -99, hr = i < s.n - 1 ? s.hf[i + 1] : -99;
        const hi = s.hf[i];
        const dl = hi - hl, dr = hi - hr;
        if (dl < REPOSE && dr < REPOSE) break;
        const dir = dl > dr ? -1 : dr > dl ? 1 : (Math.random() < 0.5 ? -1 : 1);
        if (i + dir < 0 || i + dir >= s.n) {
          if (s.kind !== 'floor' && hi > 1.2) { off = dir; break; }
          break;
        }
        i += dir; moved++;
      }
      return { i, foot, moved, off };
    };

    const landOn = (p, s, t) => {
      const st = settle(p, s, p.X);
      if (st.off) {
        // spills off the end: back into the air just past the edge
        p.X = st.off < 0 ? s.x0 - 3 : s.x1 + 3;
        setWorldVel(p, st.off * 0.08 * Math.cos(p.phi), -0.05);
        p.ignore = s.id + 1;
        return;
      }
      let top = 0;
      for (let k = -st.foot; k <= st.foot; k++) { const j = st.i + k; if (j >= 0 && j < s.n) top = Math.max(top, s.hf[j]); }
      const thick = rand(0.9, 1.9);
      for (let k = -st.foot; k <= st.foot; k++) {
        const j = st.i + k;
        if (j >= 0 && j < s.n) s.hf[j] = Math.max(s.hf[j], top + thick * (1 - Math.abs(k) / (st.foot + 1) * 0.6));
      }
      p.st = 1;
      p.t0 = t;
      p.dur = 110 + st.moved * 22;
      p.fx = p.X; p.fy = p.Y;
      p.tx = s.x0 + (st.i + 0.5) * BIN;
      p.ty = s.y - top - 1.2;
      p.th0 = p.th; p.phi0 = p.phi;
      // lies nearly flat; a crumple of tilt so it is not a perfect sheet
      p.thR = (Math.round(p.th / Math.PI) * Math.PI) + rand(-0.5, 0.5);
      p.shelf = s;
    };

    const bakePiece = (p) => {
      // contact shadow first, then the paper
      bg.setTransform(dpr, 0, 0, dpr, 0, 0);
      bg.globalAlpha = 0.16;
      bg.fillStyle = '#000';
      bg.beginPath(); bg.ellipse(p.X + 0.8, p.Y + 1.2, p.wpx * 0.55, 1.6, 0, 0, 6.2832); bg.fill();
      drawPiece(bg, p, p.X, p.Y, 1);
      bg.globalAlpha = 1;
    };

    /* ---- rain ------------------------------------------------------------- */
    const rainRate = (reduced ? 14 : 56) * clamp(W / 1280, 0.7, 1.6);
    const rainFrom = Math.min(650, f.intro * 0.4), rainTo = OUT_AT - 500;
    let rainAcc = 0;

    let outroStarted = false;
    let lastFade = 1;

    loop((dt, t) => {
      if (t > total) return false;
      dt = Math.max(0, dt);                         // the first rAF stamp can precede loop() start
      const steps = Math.max(1, Math.min(17, Math.round(dt / (HSTEP * 1000))));
      const h = dt / 1000 / steps;

      if (t > rainFrom && t < rainTo) {
        rainAcc += dt / 1000 * rainRate;
        while (rainAcc >= 1) {
          rainAcc--;
          const p = make(rand(-30, W + 30), rand(-30, -10), 0, -0.25, null);
          if (p) p.v = -0.25;
        }
      }

      // Outro: wake the piles. The bake layer is cleared and every resting
      // piece rejoins the live set, waiting for the gust front to reach it.
      if (!outroStarted && t >= OUT_AT) {
        outroStarted = true;
        bg.setTransform(1, 0, 0, 1, 0, 0);
        bg.clearRect(0, 0, bake.cv.width, bake.cv.height);
        rest.forEach((p) => { p.st = 2; P.push(p); });
        rest.length = 0;
      }

      const fade = clamp((total - t) / 260, 0, 1);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, live.cv.width, live.cv.height);

      for (let i = P.length - 1; i >= 0; i--) {
        const p = P[i];
        if (p.st === 2) {
          if (!gusted(p.X, t)) { drawPiece(g, p, p.X, p.Y, fade); continue; }
          // the gust lifts it
          p.st = 0; p.jet = null; p.ignore = p.shelf ? p.shelf.id + 1 : 0;
          p.th = p.thR; p.w = windDir * rand(4, 12);
          setWorldVel(p, windDir * 0.4 * Math.cos(p.phi), rand(0.3, 0.8));
          p.Y -= 2;
        }
        if (p.st === 1) {
          const k = clamp((t - p.t0) / p.dur, 0, 1), e = easeOut3(k);
          p.X = p.fx + (p.tx - p.fx) * e;
          p.Y = p.fy + (p.ty - p.fy) * e;
          p.th = p.th0 + (p.thR - p.th0) * e;
          if (k >= 1 && !outroStarted) {
            P.splice(i, 1); rest.push(p); bakePiece(p); continue;
          }
          if (k >= 1) { p.st = 2; }
          drawPiece(g, p, p.X, p.Y, fade);
          continue;
        }

        const y0 = p.Y;
        for (let k = 0; k < steps; k++) stepAir(p, h, t);
        if (p.Y > H + 60 || p.X < -120 || p.X > W + 120 || p.Y < -H * 0.8) {
          // gone off-screen (or blown away)
          if (p.Y > H + 60 || t >= OUT_AT || p.Y < -H * 0.8) { P.splice(i, 1); continue; }
        }
        orient(p, O);
        const hy = halfY();

        // contact: only while moving down, and only crossing a shelf top
        if (!outroStarted && p.Y > y0 && !p.jet) {
          const col = cols[clamp(Math.floor((p.X + 40) / COL), 0, cols.length - 1)];
          for (let j = 0; j < col.length; j++) {
            const s = col[j];
            if (p.X < s.x0 || p.X > s.x1 || p.ignore === s.id + 1) continue;
            const bi = clamp(Math.floor((p.X - s.x0) / BIN), 0, s.n - 1);
            const top = s.y - s.hf[bi];
            if (y0 + hy <= top + 0.5 && p.Y + hy > top) {
              if (hash(p.id, s.id) > s.k) { p.ignore = s.id + 1; continue; }   // passes in front of it
              const [vs, vy] = worldVel(p);
              if (p.bouncy && -vy > 0.18) {
                p.Y = top - hy;
                setWorldVel(p, vs * 0.6, -vy * p.e);
                p.w = -p.w * 0.5 + rand(-25, 25);
                p.bouncy = Math.random() < 0.3;      // a second, smaller hop sometimes
              } else {
                p.Y = top - hy;
                landOn(p, s, t);
              }
              break;
            }
          }
        }
        if (p.st === 1) { drawPiece(g, p, p.X, p.Y, fade); continue; }
        if (p.st === 0) drawPiece(g, p, p.X, p.Y, fade);
      }
      g.globalAlpha = 1;
      if (fade !== lastFade) { bake.cv.style.opacity = fade; lastFade = fade; }
    });

    return total;
  }

  sfx.register('confetti', confetti);
})();
