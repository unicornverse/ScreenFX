/* Screenick effect module — registers into the runtime in content.js. */
(() => {
  const sfx = window.__screenick;
  if (!sfx || !sfx.kit) return;
  // eslint-disable-next-line no-unused-vars
  const { R, SPRING, SPRING_MS, rand, rint, pick, clamp, svgFrom, el, div, later, listen, loop, canvasLayer, envelope, easeOut3, easeIn2, shake, breathe, pageLuminance, gl, lockScroll, blocks } = sfx.kit;

  /* ---- shared -------------------------------------------------------------
     Both web effects use the same silk, light and shadow.

     SILK is a thin dielectric fibre, so it is lit like hair: Kajiya-Kay,
     specular ~ sin(T, H)^p, where T is the fibre tangent and H the half
     vector between the light and a perspective eye (~1.2 screen heights in
     front of the middle). The glint therefore slides along a line as it
     swings, instead of the whole line being one flat colour.

     LIGHT comes from the upper left, slightly in front of the screen — the
     same light as the prison bars — so anything hanging in front of the
     page casts its shadow down and to the right. */
  const SUIT = { RED: '#CE2B33', RED_D: '#9C1B22', BLU: '#22307F', BLU_D: '#161F5C', INK: '#170A0C' };
  const LIGHT = [-0.4191, -0.4990, 0.7585];
  const CAST = [0.55, 0.66];                         // shadow offset per px of height above the page

  /* Silk has to hold up on a white page and a black one alike: take the line
     colour from the page and back it with the opposite tone. */
  const silkTones = () => {
    const dark = pageLuminance() <= 0.5;
    return {
      dark,
      silk: dark ? '#F4F1E6' : '#1A1C22',
      halo: dark ? 'rgba(0,0,0,.7)' : 'rgba(255,255,255,.92)',
      glint: dark ? '255,255,255' : '235,240,250'
    };
  };

  /* Kajiya-Kay glint for a fibre segment with screen tangent (tx, ty) at (x, y). */
  const glintAt = (W, H, x, y, tx, ty) => {
    let ex = W / 2 - x, ey = H / 2 - y, ez = H * 1.2;
    const el2 = Math.hypot(ex, ey, ez); ex /= el2; ey /= el2; ez /= el2;
    let hx = LIGHT[0] + ex, hy = LIGHT[1] + ey, hz = LIGHT[2] + ez;
    const hl = Math.hypot(hx, hy, hz); hx /= hl; hy /= hl; hz /= hl;
    const tl = Math.hypot(tx, ty) || 1;
    const th = (tx * hx + ty * hy) / tl;
    return Math.pow(Math.sqrt(Math.max(0, 1 - th * th)), 90);
  };

  /* A bar across the top of the page the line can be fixed to: a header or
     nav strip that starts at the top edge. Its bottom edge is the anchor, and
     the hero is lowered out from behind it. */
  function topBar(W, H, wantX, figH) {
    const cands = [];
    const consider = (x, y, w, h, n) => {
      if (y > 40 || h < 28 || w < 220) return;
      const bottom = y + h;
      if (bottom < 36 || bottom > H * 0.32) return;
      if (wantX < x + 60 || wantX > x + w - 60) return;
      cands.push({ x, y, w, h, bottom, n });
    };
    let base = [];
    try { base = blocks({ max: 120, minSize: 60 }); } catch (err) { base = []; }
    base.forEach((b) => { if (b.tag === 'header' || b.tag === 'nav') consider(b.x, b.y, b.w, b.h, null); });
    const els = document.body ? document.body.querySelectorAll('header,nav,div,section') : [];
    for (let i = 0, seen = 0; i < els.length && seen < 500; i++) {
      const r = els[i].getBoundingClientRect();
      if (r.top > 40 || r.height < 28 || r.width < 220 || r.bottom > H * 0.32) continue;
      seen++;
      const cs = getComputedStyle(els[i]);
      const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
      const a = m ? (m[1].split(',')[3] === undefined ? 1 : parseFloat(m[1].split(',')[3])) : 0;
      if (a < 0.6 && cs.backgroundImage === 'none') continue;     // must be opaque to hide behind
      consider(r.left, r.top, r.width, r.height, els[i]);
    }
    // the deepest opaque bar wins; it must really be on top at the anchor
    cands.sort((a, b) => b.bottom - a.bottom);
    for (const c of cands) {
      const hit = document.elementFromPoint(clamp(wantX, 1, W - 1), c.bottom - 3);
      if (!hit || (hit.closest && hit.closest('#__screenick_root'))) continue;
      if (c.n && !(c.n === hit || c.n.contains(hit))) continue;
      return c;
    }
    return null;
  }

  /* The web-slinger himself, drawn in a local frame where (0,0) is the ankles
     the line grips and +y runs down the body to the head — so he hangs
     head-down, which is the only way a drop from a corner ever reads.
     Proportions: ankles 0, knees 23, hips 47, shoulders 76, head centre 90,
     fingertips 106. About seven and a half heads tall. */
  function slingerFigure(uid) {
    const chestD = 'M-6.8 57 L6.8 57 C9.2 62 11 69 10.8 77 ' +
                   'C6.4 80.4 -6.4 80.4 -10.8 77 C-11 69 -9.2 62 -6.8 57 Z';
    return { chestD, markup: `
<g class="sfx-figure">
  <g class="sfx-arms">
    <path class="sfx-hl sfx-arm-s" d="M10.6 75 L19.4 89 L17.6 105"/>
    <circle class="sfx-glove" cx="17.6" cy="105" r="3.9"/>
  </g>
  <path class="sfx-hl sfx-leg-s" d="M3.6 1 L11.8 21 L5.6 47"/>
  <path class="sfx-hl sfx-boot" d="M3.6 1 L6.6 7.2"/>
  <path class="sfx-hl sfx-leg" d="M-3 0 L-7 24 L-5.4 47"/>
  <path class="sfx-hl sfx-boot" d="M-3 0 L-4.2 7.8"/>
  <path class="sfx-torso-b" d="M-6.2 45 L6.4 45 L6.9 58.4 L-6.9 58.4 Z"/>
  <path class="sfx-torso-r" d="${chestD}"/>
  <g class="sfx-tracery" clip-path="url(#${uid}c)">
    <path d="M-10.6 64 L10.6 64 M-11 70 L11 70 M-9.4 58.4 L9.4 58.4
      M-3.4 56.6 L-6.6 79.2 M3.4 56.6 L6.6 79.2 M0 56.6 L0 79.2
      M-7 56.6 L-9.9 78.4 M7 56.6 L9.9 78.4"/>
  </g>
  <path class="sfx-emblem" d="M0 62.6 L-2.9 66.6 L0 69.9 L2.9 66.6 Z
    M-2.7 64.3 L-6.6 62.6 M2.7 64.3 L6.6 62.6
    M-2.5 68.1 L-5.6 70.4 M2.5 68.1 L5.6 70.4
    M-1.3 62.6 L-2.3 59.5 M1.3 62.6 L2.3 59.5"/>
  <g transform="translate(0 90)">
    <ellipse class="sfx-head" cx="0" cy="0" rx="10.2" ry="11.4"/>
    <g class="sfx-tracery" clip-path="url(#${uid}h)">
      <path d="M0 -11.2 L0 11.2 M-9.9 -3.4 L9.9 -3.4 M-9.6 3.9 L9.6 3.9
        M-7.4 -8.4 L7.4 8.4 M-7.4 8.4 L7.4 -8.4
        M0 -11.2 C-4.6 -8 -7 -3.4 -7.5 1.1 M0 -11.2 C4.6 -8 7 -3.4 7.5 1.1
        M0 11.2 C-4.6 8 -7 4.1 -7.7 -.7 M0 11.2 C4.6 8 7 4.1 7.7 -.7"/>
    </g>
    <path class="sfx-lens" d="M-8.9 2.2 C-9.1 -1.9 -6 -4.3 -2.9 -3.1
      C-1.1 -2.4 -0.8 -0.2 -2.2 1.7 C-3.8 4.1 -8.6 5 -8.9 2.2 Z"/>
    <path class="sfx-lens" d="M8.9 2.2 C9.1 -1.9 6 -4.3 2.9 -3.1
      C1.1 -2.4 0.8 -0.2 2.2 1.7 C3.8 4.1 8.6 5 8.9 2.2 Z"/>
    <path class="sfx-lens-g" d="M-7.4 1.4 C-7.4 -1 -5.5 -2.4 -3.8 -1.9 C-5.3 -0.7 -6.5 .5 -7.4 1.4 Z"/>
    <path class="sfx-lens-g" d="M3.8 -1.9 C5.5 -2.4 7.4 -1 7.4 1.4 C6.5 .5 5.3 -0.7 3.8 -1.9 Z"/>
  </g>
  <g class="sfx-arms">
    <path class="sfx-hl sfx-arm" d="M-10.6 75.4 L-19 90 L-17 106"/>
    <circle class="sfx-glove" cx="-17" cy="106" r="3.9"/>
  </g>
</g>` };
  }

  const suitCSS = () => `
${R} .sfx-hl{stroke-linecap:round;stroke-linejoin:round;fill:none;}
${R} .sfx-leg{stroke:${SUIT.BLU};stroke-width:7.2;}
${R} .sfx-leg-s{stroke:${SUIT.BLU_D};stroke-width:7;}
${R} .sfx-boot{stroke:${SUIT.RED};stroke-width:8.6;}
${R} .sfx-arm{stroke:${SUIT.RED};stroke-width:6.2;}
${R} .sfx-arm-s{stroke:${SUIT.RED_D};stroke-width:6;}
${R} .sfx-glove{fill:${SUIT.RED};stroke:${SUIT.INK};stroke-width:.8;}
${R} .sfx-torso-b{fill:${SUIT.BLU};stroke:${SUIT.INK};stroke-width:.9;stroke-linejoin:round;}
${R} .sfx-torso-r{fill:${SUIT.RED};stroke:${SUIT.INK};stroke-width:.9;stroke-linejoin:round;}
${R} .sfx-head{fill:${SUIT.RED};stroke:${SUIT.INK};stroke-width:1;}
${R} .sfx-lens{fill:#EDF3FF;stroke:${SUIT.INK};stroke-width:1.3;stroke-linejoin:round;}
${R} .sfx-lens-g{fill:rgba(255,255,255,.8);}
${R} .sfx-emblem{fill:none;stroke:${SUIT.INK};stroke-width:1.05;stroke-linecap:round;stroke-linejoin:round;}
${R} .sfx-tracery{stroke:rgba(0,0,0,.45);stroke-width:.62;fill:none;stroke-linecap:round;}
`;

  /* ========================================================================
   * 2. WEB SLINGER — the line is fixed to the underside of the page's own
   *    header/nav bar (or the top edge when there is none), and the hero is
   *    lowered out from behind it, hangs and sways, and is drawn back up
   *    behind it again.
   *
   *    The line is an 18-node verlet rope on a fixed 1/120 s timestep. It
   *    pays out SLOWER than he would fall, so it never goes slack and there
   *    is no whip: he is lowered, not dropped. The physics supplies the sag,
   *    the slow pendulum (T = 2*pi*sqrt(L/g), ~2.7 s at this length) and the
   *    way his arms trail the sway and settle late. Silk is lit with
   *    Kajiya-Kay (the glint slides along the line as it swings), and line
   *    and figure cast one soft shadow onto the page, offset away from the
   *    light by their height above it.
   * ====================================================================== */
  function webSlinger(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const uid = 'sfx' + ((Math.random() * 1e9) | 0).toString(36);
    const S = clamp((H * 0.305) / 110, 1.2, 2.9);
    const FIG_H = 112 * S;

    let ax = Math.round(W - clamp(W * 0.23, 150, 360));
    let bar = null;
    try { bar = topBar(W, H, ax, FIG_H); } catch (err) { bar = null; }
    const ay = bar ? Math.round(bar.bottom) - 1 : -4;
    const HID = FIG_H + 46;                          // how far up he starts, behind the bar
    const L = Math.round(clamp((H - ay) * 0.48, 200, 460));

    const fw = ctx.fit(1350, 1150, 900);
    const DROP = fw.intro, RETRACT = fw.outro;
    const RETRACT_AT = DROP + fw.hold;
    const total = RETRACT_AT + RETRACT;
    const EMERGE = DROP * 0.36;                     // sliding out from behind the bar
    const { silk, halo, glint } = silkTones();

    /* ---- verlet rope ---------------------------------------------------- */
    const N = 18, G = 2100, ITER = 8, DT = 1 / 120;
    const DAMP = ctx.reduced ? 0.86 : 0.9986;
    const node = [];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      node.push({ x: ax, y: ay - HID + t * 22, px: ax, py: ay - HID + t * 22 });
    }
    // Just enough sideways nudge to start a slow, shallow sway.
    let nudged = false;

    const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const restLen = (t) => {
      if (t < EMERGE) return 22;
      if (t < DROP) return 22 + (L - 22) * easeInOut((t - EMERGE) / (DROP - EMERGE));
      if (t < RETRACT_AT) return L;
      return 22 + (L - 22) * (1 - easeInOut(clamp((t - RETRACT_AT) / (RETRACT * 0.62), 0, 1)));
    };
    // The pin rides down out of the bar at the start and back up into it at
    // the end, so he is never cut off mid-air: he slides in and out of cover.
    const pinAt = (t) => {
      if (t < EMERGE) return ay - HID * (1 - easeOut3(t / EMERGE));
      if (t < RETRACT_AT + RETRACT * 0.58) return ay;
      const p = clamp((t - RETRACT_AT - RETRACT * 0.58) / (RETRACT * 0.42), 0, 1);
      return ay - (HID + 20) * easeIn2(p);
    };

    let pinY = ay - HID;
    let acc = 0;
    function step(seg) {
      for (let i = 1; i < N; i++) {
        const n = node[i];
        const vx = (n.x - n.px) * DAMP, vy = (n.y - n.py) * DAMP;
        n.px = n.x; n.py = n.y;
        n.x += vx; n.y += vy + G * DT * DT;
      }
      for (let k = 0; k < ITER; k++) {
        // Gauss-Seidel is order-dependent: alternate the sweep.
        const down = k % 2 === 0;
        for (let j = 0; j < N - 1; j++) {
          const i = down ? j : N - 2 - j;
          const a = node[i], b = node[i + 1];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 0.0001;
          const m = (d - seg) / d;
          const wa = i === 0 ? 0 : (i === N - 2 ? 0.62 : 0.5);
          a.x += dx * m * wa; a.y += dy * m * wa;
          b.x -= dx * m * (1 - wa); b.y -= dy * m * (1 - wa);
        }
        // Webbing does not kink at its anchor; it leaves at a held angle.
        for (let i = 0; i + 2 < 5; i++) {
          const a = node[i], c = node[i + 2], mid = node[i + 1];
          mid.x += ((a.x + c.x) / 2 - mid.x) * 0.22;
          mid.y += ((a.y + c.y) / 2 - mid.y) * 0.22;
        }
        node[0].x = ax; node[0].y = pinY;
      }
    }

    const ribbon = (w0, w1) => {
      const lft = [], rgt = [];
      for (let i = 0; i < N; i++) {
        const p = node[i], a = node[Math.max(0, i - 1)], b = node[Math.min(N - 1, i + 1)];
        let dx = b.x - a.x, dy = b.y - a.y;
        const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
        const w = (w0 + (w1 - w0) * (i / (N - 1))) / 2;
        lft.push((p.x - dy * w).toFixed(1) + ' ' + (p.y + dx * w).toFixed(1));
        rgt.push((p.x + dy * w).toFixed(1) + ' ' + (p.y - dx * w).toFixed(1));
      }
      return 'M' + lft.join(' L') + ' L' + rgt.reverse().join(' L') + 'Z';
    };

    // Cast shadow: the line and figure hang ~34 px in front of the page.
    const SH = 34;
    css(suitCSS() + `
${R} .sfx-web{position:absolute;inset:0;overflow:visible;}
${R} .sfx-silk{fill:${silk};}
/* cast shadow: a black copy with a wide faint rim for the penumbra */
${R} .sfx-fsh{opacity:.2;}
${R} .sfx-fsh ellipse,${R} .sfx-rsh{fill:#000;}
${R} .sfx-fs{fill:none;stroke:#000;stroke-linecap:round;stroke-linejoin:round;}
${R} .sfx-silk-h{fill:${halo};opacity:.75;}
${R} .sfx-glints line{stroke:rgb(${glint});stroke-width:1.1;stroke-linecap:round;}
${R} .sfx-anchor{stroke:${silk};stroke-width:1.5;stroke-linecap:round;fill:none;opacity:.8;
 stroke-dasharray:1400;stroke-dashoffset:1400;
 animation:sfx-draw2 620ms cubic-bezier(.12,.82,.26,1) ${Math.round(EMERGE * 0.5)}ms forwards,
           sfx-fade-out 420ms cubic-bezier(0.22,1,0.36,1) ${Math.round(total - 520)}ms forwards;}
${R} .sfx-anchor-h{stroke:${halo};stroke-width:3.6;opacity:.6;}
@keyframes sfx-draw2{to{stroke-dashoffset:0}}
`);

    // Anchor web: strands fanning out under the bar's edge, tied by ragged
    // rings, plus silk folded along the edge itself.
    const span = clamp(Math.min(W - ax, ax) * 0.34, 54, 92);
    const fan = [];
    for (let i = 0; i < 9; i++) fan.push(-0.12 + (i / 8) * (Math.PI + 0.24) + rand(-0.05, 0.05));
    let anchorD = '';
    fan.forEach((a) => {
      const r = span * rand(0.72, 1.05);
      anchorD += ` M${ax} ${ay} L${(ax + Math.cos(a) * r).toFixed(1)} ${(ay + Math.max(0, Math.sin(a)) * r).toFixed(1)}`;
    });
    [0.3, 0.52, 0.74, 0.96].forEach((f) => {
      let d = '';
      fan.forEach((a, i) => {
        const r = span * f * rand(0.9, 1.1);
        d += (i ? ' L' : ' M') + (ax + Math.cos(a) * r).toFixed(1) + ' ' + (ay + Math.max(0, Math.sin(a)) * r).toFixed(1);
      });
      anchorD += d;
    });
    if (bar) anchorD += ` M${(ax - span * 0.9).toFixed(1)} ${ay + 0.5} L${(ax + span * 0.9).toFixed(1)} ${ay + 0.5}`;

    const fig = slingerFigure(uid);
    let glints = '';
    for (let i = 0; i < N - 1; i++) glints += '<line x1="0" y1="0" x2="0" y2="0"/>';
    const svg = svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" class="sfx-web" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <clipPath id="${uid}h"><ellipse cx="0" cy="0" rx="10.2" ry="11.4"/></clipPath>
    <clipPath id="${uid}c"><path d="${fig.chestD}"/></clipPath>
  </defs>
  <g>
    <path class="sfx-anchor sfx-anchor-h" d="${anchorD}"/>
    <path class="sfx-anchor" d="${anchorD}"/>
    <g class="sfx-fsh"><path class="sfx-rsh" d=""/><g class="sfx-fsh-body"><g transform="scale(${S.toFixed(3)})"><path class="sfx-fs" stroke-width="13" d="M0 2 L0 46"/><path class="sfx-fs" stroke-width="21" d="M0 50 L0 76"/><ellipse cx="0" cy="90" rx="10.5" ry="11.6"/><g class="sfx-arms"><path class="sfx-fs" stroke-width="6.5" d="M10.6 75 L19.4 89 L17.6 105 M-10.6 75.4 L-19 90 L-17 106"/></g></g></g></g>
    <g class="sfx-cast">
      <path class="sfx-silk-h" d=""/>
      <path class="sfx-silk" d=""/>
      <g class="sfx-glints">${glints}</g>
      <g class="sfx-body"><g transform="scale(${S.toFixed(3)})">${fig.markup}</g></g>
    </g>
  </g>
</svg>`);
    // everything above the bar's edge is behind the bar (CSS clip on the
    // element, composited; an SVG clipPath over animated content is not)
    if (ay > 0) svg.style.clipPath = `polygon(-400px ${ay}px, ${W + 400}px ${ay}px, ${W + 400}px ${H + 400}px, -400px ${H + 400}px)`;
    stage.appendChild(svg);
    const shBody = svg.querySelector('.sfx-fsh-body');
    const shArms = svg.querySelectorAll('.sfx-fsh .sfx-arms');
    const shRope = svg.querySelector('.sfx-rsh');
    const haloEl = svg.querySelector('.sfx-silk-h');

    const silkEl = svg.querySelector('.sfx-silk');
    const glintEls = svg.querySelectorAll('.sfx-glints line');
    const bodyEl = svg.querySelector('.sfx-body');
    const armsEl = svg.querySelectorAll('.sfx-arms');
    let heroA = Math.PI / 2, armA = heroA;

    loop((dt, t, raw) => {
      if (t > total) return false;
      dt = Math.max(0, dt);
      // raw frame time keeps the rope on the wall clock at low frame rates
      acc = Math.min(acc + (raw === undefined ? dt : Math.max(0, raw)) / 1000, 0.1);
      const seg = restLen(t) / (N - 1);
      // the pin carries the rope with it while sliding in or out of cover
      // (moving nodes and their history together adds no velocity)
      const np = pinAt(t), dp = np - pinY;
      if (dp !== 0 && (t < EMERGE || t > RETRACT_AT + RETRACT * 0.58)) {
        for (let i = 1; i < N; i++) { node[i].y += dp; node[i].py += dp; }
      }
      pinY = np;
      if (!nudged && t >= EMERGE + (DROP - EMERGE) * 0.7 && !ctx.reduced) {
        // ~6 degree sway on the full line: peak speed A*sqrt(g/L)
        nudged = true;
        const vx = -(L * rand(0.08, 0.12)) * Math.sqrt(G / L) * DT;
        for (let i = 1; i < N; i++) node[i].px -= vx * (i / (N - 1));
      }
      while (acc >= DT) { step(seg); acc -= DT; }

      silkEl.setAttribute('d', ribbon(3.4, 2.0));
      haloEl.setAttribute('d', ribbon(6.2, 4.6));
      for (let i = 0; i < N - 1; i++) {
        const a = node[i], b = node[i + 1];
        const tx = b.x - a.x, ty = b.y - a.y;
        const sp = glintAt(W, H, (a.x + b.x) / 2, (a.y + b.y) / 2, tx, ty);
        const ln = glintEls[i];
        // the glint sits on the lit flank of the fibre
        const l = Math.hypot(tx, ty) || 1, ox = (-ty / l) * -0.7, oy = (tx / l) * -0.7;
        ln.setAttribute('x1', (a.x + ox).toFixed(1)); ln.setAttribute('y1', (a.y + oy).toFixed(1));
        ln.setAttribute('x2', (b.x + ox).toFixed(1)); ln.setAttribute('y2', (b.y + oy).toFixed(1));
        ln.setAttribute('stroke-opacity', (0.1 + 0.85 * sp).toFixed(2));
      }
      // heading over the last few nodes (a slack end segment can point any
      // way); a hanging body never swings past ~70 degrees from vertical
      const a = node[N - 1], b = node[N - 4];
      heroA = clamp(Math.atan2(a.y - b.y, a.x - b.x), Math.PI / 2 - 1.2, Math.PI / 2 + 1.2);
      let d = heroA - armA;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      armA += d * Math.min(1, dt / 150);

      bodyEl.setAttribute('transform',
        `translate(${a.x.toFixed(1)} ${a.y.toFixed(1)}) rotate(${((heroA * 180) / Math.PI - 90).toFixed(2)})`);
      const lag = `rotate(${((((armA - heroA) * 180) / Math.PI) * 0.8).toFixed(2)} 0 76)`;
      armsEl.forEach((n) => n.setAttribute('transform', lag));
      const sx = CAST[0] * SH, sy = CAST[1] * SH;
      shBody.setAttribute('transform', `translate(${(a.x + sx).toFixed(1)} ${(a.y + sy).toFixed(1)}) rotate(${((heroA * 180) / Math.PI - 90).toFixed(2)})`);
      shArms.forEach((n) => n.setAttribute('transform', lag));
      shRope.setAttribute('transform', `translate(${sx.toFixed(1)} ${sy.toFixed(1)})`);
      shRope.setAttribute('d', silkEl.getAttribute('d'));
    });


    return total;
  }

  /* ========================================================================
   * 2b. WEB SHOOTER — a gloved forearm comes in from the bottom-right,
   *     tracks the pointer, and fires where you click. The web sticks to the
   *     ELEMENT under the click: the splat is sized to it, strands that run
   *     past its edge stop there and fold over it (so a shot near a corner
   *     wraps the corner), and the line, pulled taut between palm and target,
   *     sags into a catenary, snaps near the wrist and is left dangling from
   *     the element, swinging under gravity until it hangs still.
   *
   *     Lines are verlet ropes (fixed 1/120 s step, distance constraints);
   *     with both ends pinned and 5% slack they settle into the catenary
   *     y = a cosh(x/a) on their own. Silk glints with Kajiya-Kay and every
   *     strand casts a soft shadow down and to the right.
   * ====================================================================== */
  function webShooter(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const total = ctx.duration;
    const FADE = 600;
    const { silk, halo, glint } = silkTones();
    const reduced = ctx.reduced;

    // Elbow just off the bottom-right corner; the whole arm pivots about it.
    const ex = W + 34, ey = H + 66;
    const ARM = 150;                                  // elbow-to-palm, local units
    const REACH = clamp(Math.min(W, H) * 0.54, 300, 560);
    const S = REACH / ARM;
    const AIM_LO = -1.28, AIM_HI = -0.38;

    css(`
${R} .sfx-aim{position:absolute;inset:0;pointer-events:auto;cursor:crosshair;z-index:4;}
${R} .sfx-hand{position:absolute;inset:0;overflow:visible;
 filter:drop-shadow(${(CAST[0] * 26).toFixed(1)}px ${(CAST[1] * 26).toFixed(1)}px 12px rgba(0,0,0,.3));
 animation:sfx-hand-in 520ms ${SPRING} both,
           sfx-fade-out ${FADE}ms cubic-bezier(0.22,1,0.36,1) ${total - FADE}ms forwards;}
${R} .sfx-gl{fill:${SUIT.RED};stroke:${SUIT.INK};stroke-width:1.1;stroke-linejoin:round;}
${R} .sfx-gl-d{fill:${SUIT.RED_D};stroke:${SUIT.INK};stroke-width:1.1;stroke-linejoin:round;}
${R} .sfx-cuff{fill:${SUIT.BLU};stroke:${SUIT.INK};stroke-width:1.1;}
${R} .sfx-band{fill:#1A1D26;}
${R} .sfx-fing{fill:none;stroke:${SUIT.RED};stroke-width:8.4;stroke-linecap:round;stroke-linejoin:round;}
${R} .sfx-fing-d{fill:none;stroke:${SUIT.RED_D};stroke-width:8;stroke-linecap:round;stroke-linejoin:round;}
${R} .sfx-gtr{stroke:rgba(0,0,0,.42);stroke-width:.7;fill:none;stroke-linecap:round;}
${R} .sfx-hint{position:absolute;left:0;right:0;bottom:38px;text-align:center!important;
 font:500 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif!important;
 color:rgba(255,255,255,.96)!important;opacity:0;}
${R} .sfx-hint span{display:inline-block;padding:7px 14px;border-radius:999px;
 background:rgba(22,22,24,.62)!important;
 box-shadow:inset 0 0 0 .5px rgba(255,255,255,.28),0 6px 20px rgba(0,0,0,.34)!important;
 -webkit-backdrop-filter:blur(20px) saturate(1.8);backdrop-filter:blur(20px) saturate(1.8);}
@keyframes sfx-hand-in{from{opacity:0;transform:translate3d(46px,54px,0)}
 to{opacity:1;transform:translate3d(0,0,0)}}
`);

    const layer = canvasLayer(stage, 'sfx-webs');
    const g = layer.g, dpr = layer.dpr;

    /* ---- the shooter's hand ----------------------------------------------
       Local frame: elbow at (0,0), forearm running up -y to the palm at
       (0,-ARM), fingers beyond it. Middle and ring curled into the palm on the
       trigger, index and pinky out — the thwip. */
    const hand = svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" class="sfx-hand" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <g class="sfx-arm-g">
    <g transform="scale(${S.toFixed(3)})">
      <path class="sfx-cuff" d="M-16.5 24 L16.5 24 L14.2 -60 L-14.2 -60 Z"/>
      <path class="sfx-gl-d" d="M-14.2 -60 L14.2 -60 L13 -132 L-13 -132 Z"/>
      <rect class="sfx-band" x="-13.8" y="-114" width="27.6" height="11" rx="1.6"/>
      <path class="sfx-fing-d" d="M9 -146 L13.8 -163 L12.6 -176"/>
      <path class="sfx-gl" d="M-13.4 -132 L13.4 -132 C17 -138.5 17.6 -148.4 15.6 -155.4
        C11.6 -161.6 -11.6 -161.6 -15.6 -155.4 C-17.6 -148.4 -17 -138.5 -13.4 -132 Z"/>
      <path class="sfx-fing" d="M-9 -147 L-14.2 -164.5 L-13 -178"/>
      <path class="sfx-fing" d="M-15.2 -139 L-22 -143.5 L-25.4 -150"/>
      <circle class="sfx-gl-d" cx="-2.8" cy="-156.8" r="3.6"/>
      <circle class="sfx-gl-d" cx="4.6" cy="-156.8" r="3.6"/>
      <g class="sfx-gtr">
        <path d="M-15.6 -136 L15.6 -136 M-16.8 -144 L16.8 -144 M-16.2 -151.5 L16.2 -151.5
          M-6.2 -132 L-8.4 -159 M0 -132 L0 -160 M6.2 -132 L8.4 -159
          M-12.4 -132 L-15 -154 M12.4 -132 L15 -154
          M-13.6 -110 L13.6 -110 M-14 -84 L14 -84 M-14.6 -56 L14.6 -56
          M-15.4 -28 L15.4 -28 M-16 0 L16 0
          M-6.6 22 L-6 -130 M0 22 L0 -130 M6.6 22 L6 -130"/>
      </g>
    </g>
  </g>
</svg>`);
    stage.appendChild(hand);
    const armG = hand.querySelector('.sfx-arm-g');

    /* ---- aiming ----------------------------------------------------------
       The arm rotates so the palm points at the pointer, easing toward it so
       it never snaps. Recoil is a short kick back down the arm's own axis. */
    let aim = -0.84;
    let want = aim;
    let recoil = 0;
    let palm = { x: ex, y: ey - ARM * S };
    const setAim = (tx, ty) => { want = clamp(Math.atan2(tx - ex, -(ty - ey)), AIM_LO, AIM_HI); };
    setAim(W * 0.45, H * 0.35);
    aim = want;

    /* ---- what got hit ------------------------------------------------------ */
    const hit = div('sfx-aim');
    const surfaceAt = (x, y) => {
      hit.style.pointerEvents = 'none';
      let n = null;
      try { n = document.elementFromPoint(x, y); } catch (err) { n = null; }
      hit.style.pointerEvents = '';
      while (n && n !== document.body && n !== document.documentElement) {
        if (n.closest && n.closest('#__screenick_root')) return null;
        const r = n.getBoundingClientRect();
        // only things with a visible boundary: media, controls, styled boxes.
        // A paragraph's line box is not an edge silk could fold over.
        if (r.width >= 24 && r.height >= 18 && r.width < W * 0.92 && r.height < H * 0.85) {
          const tag = n.tagName;
          let solid = /^(IMG|VIDEO|CANVAS|SVG|PICTURE|BUTTON|INPUT|TEXTAREA|SELECT|IFRAME)$/i.test(tag);
          if (!solid) {
            const cs = getComputedStyle(n);
            const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
            const a = m ? (m[1].split(',')[3] === undefined ? 1 : parseFloat(m[1].split(',')[3])) : 0;
            solid = a > 0.3 || parseFloat(cs.borderTopWidth) > 0.4 || cs.backgroundImage !== 'none' || (cs.boxShadow && cs.boxShadow !== 'none');
          }
          if (solid) return { x: r.left, y: r.top, w: r.width, h: r.height };
        }
        n = n.parentElement;
      }
      return null;
    };

    /* A splat on surface `s` (or the bare page): strands thrown radially,
       tied by ragged rings. Where a strand reaches the element's edge it is
       cut there and folds over the edge (a short tab along it). */
    function makeSplat(x, y, s) {
      const r = s ? clamp(Math.min(s.w, s.h) * 0.32, 15, 34) : rand(18, 28);
      const n = rint(11, 15);
      const strands = [], wraps = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand(-0.16, 0.16);
        const len = r * rand(2.2, 3.4);
        let cut = len, side = -1;
        if (s) {
          const dx = Math.cos(a), dy = Math.sin(a);
          const ts = [];
          if (dx > 0) ts.push([(s.x + s.w - x) / dx, 1]); else if (dx < 0) ts.push([(s.x - x) / dx, 3]);
          if (dy > 0) ts.push([(s.y + s.h - y) / dy, 2]); else if (dy < 0) ts.push([(s.y - y) / dy, 0]);
          ts.forEach(([tt, sd]) => { if (tt >= 0 && tt < cut) { cut = tt; side = sd; } });
          if (side >= 0) {
            const bx = x + dx * cut, by = y + dy * cut;
            // folds over the edge, running along it in the strand's direction
            const along = side === 0 || side === 2 ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1];
            const tab = clamp(len - cut, 3, 10);
            wraps.push([bx, by, bx + along[0] * tab, by + along[1] * tab, side]);
          }
        }
        strands.push({ a, len, cut: Math.max(0, cut) });
      }
      const rings = [0.45, 0.72, 1.0].map((f) => strands.map((st) => Math.min(st.cut, st.len * f * rand(0.88, 1.08))));
      return { x, y, r, strands, rings, wraps, s, t0: 0 };
    }

    /* ---- shots ------------------------------------------------------------- */
    const FLY = 120, TAUT = 190;
    const RG = 2100, RDT = 1 / 120, RITER = 6;
    const shots = [];
    let tNow = 0;

    const shoot = (tx, ty) => {
      const len0 = Math.hypot(tx - palm.x, ty - palm.y);
      if (len0 < 26) return;
      const surf = surfaceAt(tx, ty);
      const sp = makeSplat(tx, ty, surf);
      recoil = 1;
      shots.push({ t0: tNow, hx: palm.x, hy: palm.y, tx, ty, sp, rope: null, reel: null, acc: 0 });
      if (shots.length > 24) shots.shift();
    };

    const startRope = (sh) => {
      // pinned at the target, other end on the palm, 5% slack -> catenary
      const M = 14;
      const d = Math.hypot(palm.x - sh.tx, palm.y - sh.ty);
      const seg = (d * 1.05) / (M - 1);
      sh.rope = [];
      for (let i = 0; i < M; i++) {
        const k = i / (M - 1);
        const x = sh.tx + (palm.x - sh.tx) * k, y = sh.ty + (palm.y - sh.ty) * k;
        sh.rope.push({ x, y, px: x, py: y });
      }
      sh.seg = seg;
      sh.pinEnd = true;
    };

    const stepRope = (sh) => {
      const P = sh.rope, M = P.length;
      for (let i = 1; i < M; i++) {
        const n = P[i];
        const vx = (n.x - n.px) * 0.992, vy = (n.y - n.py) * 0.992;
        n.px = n.x; n.py = n.y;
        n.x += vx; n.y += vy + RG * RDT * RDT;
      }
      for (let k = 0; k < RITER; k++) {
        for (let j = 0; j < M - 1; j++) {
          const i = k % 2 ? M - 2 - j : j;
          const a = P[i], b = P[i + 1];
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.0001;
          const m = (d - sh.seg) / d;
          const wa = i === 0 ? 0 : 0.5, wb = (i + 1 === M - 1 && sh.pinEnd) ? 0 : 0.5;
          const sum = wa + wb || 1;
          a.x += dx * m * wa / sum; a.y += dy * m * wa / sum;
          b.x -= dx * m * wb / sum; b.y -= dy * m * wb / sum;
        }
        P[0].x = sh.tx; P[0].y = sh.ty;
        if (sh.pinEnd) { P[M - 1].x = palm.x; P[M - 1].y = palm.y; }
      }
    };

    hit.addEventListener('pointermove', (e) => setAim(e.clientX, e.clientY));
    hit.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      setAim(e.clientX, e.clientY);
      aim = want;
      updatePalm();
      shoot(e.clientX, e.clientY);
    });
    stage.appendChild(hit);

    // Unprompted shots at real things on the page (near a corner, so the
    // wrap shows), so the effect explains itself to someone who never clicks.
    if (!reduced) {
      let targets = [];
      try {
        targets = blocks({ max: 120, minSize: 40 }).filter((b) => /^(img|video|canvas|picture|button|input|figure|pre|table)$/.test(b.tag) &&
          b.x + b.w * 0.5 < W * 0.8 && b.y + b.h * 0.5 < H * 0.7 && b.y > 10 && b.w < W * 0.9 && b.h < H * 0.7);
      } catch (err) { targets = []; }
      [520, 1180].forEach((at, i) => later(() => {
        let tx, ty;
        if (targets.length) {
          const b = pick(targets);
          tx = b.x + (Math.random() < 0.5 ? rand(0.06, 0.2) : rand(0.8, 0.94)) * b.w;
          ty = b.y + rand(0.12, 0.3) * b.h;
        } else { tx = rand(W * 0.12, W * 0.62); ty = rand(H * 0.12, H * 0.5); }
        setAim(tx, ty); if (!i) aim = want;
        updatePalm();
        shoot(tx, ty);
      }, at));
    }

    const hint = div('sfx-hint');
    const hs = el('span');
    hs.textContent = 'Click to shoot';
    hint.appendChild(hs);
    hint.style.animation =
      `sfx-fade-in 420ms cubic-bezier(0.22,1,0.36,1) 900ms both,` +
      `sfx-fade-out 420ms cubic-bezier(0.22,1,0.36,1) ${Math.min(3200, total - FADE - 420)}ms forwards`;
    stage.appendChild(hint);

    function updatePalm() {
      palm = {
        x: ex + Math.sin(aim) * (REACH - recoil * 13 * S),
        y: ey - Math.cos(aim) * (REACH - recoil * 13 * S)
      };
    }

    /* ---- drawing ------------------------------------------------------------- */
    const setShadow = (on) => {
      g.shadowColor = on ? 'rgba(0,0,0,0.22)' : 'transparent';
      g.shadowOffsetX = on ? CAST[0] * 14 * dpr : 0;
      g.shadowOffsetY = on ? CAST[1] * 14 * dpr : 0;
      g.shadowBlur = on ? 3 * dpr : 0;
    };
    const strokePoly = (pts, w) => {
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.stroke();
    };
    const silkLine = (pts, w) => {
      g.strokeStyle = halo; setShadow(false); strokePoly(pts, w + 2.2);
      g.strokeStyle = silk; setShadow(true); strokePoly(pts, w);
      setShadow(false);
      // glints, per segment
      g.lineWidth = Math.max(0.8, w * 0.45);
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
        const sp = glintAt(W, H, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0);
        if (sp < 0.05) continue;
        g.strokeStyle = `rgba(${glint},${(sp * 0.9).toFixed(2)})`;
        g.beginPath(); g.moveTo(x0 - 0.5, y0 - 0.5); g.lineTo(x1 - 0.5, y1 - 0.5); g.stroke();
      }
    };

    function drawSplat(sp, age) {
      // a damped spring opens it out: x(t) = 1 - (1 - s0) e^(-t/tau) cos(wt)
      const k = age < 0 ? 0 : 1 - 0.78 * Math.exp(-age / 0.07) * Math.cos(age * 26);
      if (k <= 0) return;
      g.save();
      if (sp.s) {
        // strands stop at the element's edge: everything past it is behind it
        g.beginPath(); g.rect(sp.s.x - 0.5, sp.s.y - 0.5, sp.s.w + 1, sp.s.h + 1); g.clip();
      }
      g.translate(sp.x, sp.y);
      g.scale(k, k);
      g.lineCap = 'round'; g.lineJoin = 'round';
      // the glue blob in the middle
      g.fillStyle = silk; g.globalAlpha *= 0.55;
      g.beginPath();
      sp.strands.forEach((st, i) => {
        const rr = sp.r * 0.42 * (0.8 + 0.4 * ((i * 7919) % 13) / 13);
        const px = Math.cos(st.a) * rr, py = Math.sin(st.a) * rr;
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      });
      g.closePath(); g.fill();
      g.globalAlpha /= 0.55;
      g.strokeStyle = silk;
      setShadow(true);
      g.lineWidth = 1.4;
      g.beginPath();
      sp.strands.forEach((st) => { g.moveTo(Math.cos(st.a) * sp.r * 0.2, Math.sin(st.a) * sp.r * 0.2); g.lineTo(Math.cos(st.a) * st.cut, Math.sin(st.a) * st.cut); });
      sp.rings.forEach((ring) => {
        ring.forEach((rr, i) => {
          const st = sp.strands[i];
          const px = Math.cos(st.a) * rr, py = Math.sin(st.a) * rr;
          i ? g.lineTo(px, py) : g.moveTo(px, py);
        });
        g.closePath();
      });
      g.stroke();
      setShadow(false);
      g.restore();
      // silk folded over the edge: a bright tab along it at every crossing
      if (sp.wraps.length && k > 0.9) {
        g.save();
        g.lineCap = 'round';
        sp.wraps.forEach(([x0, y0, x1, y1]) => {
          g.strokeStyle = silk; g.lineWidth = 1.6;
          g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
          g.strokeStyle = `rgba(${glint},.7)`; g.lineWidth = 0.7;
          g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
        });
        g.restore();
      }
    }

    /* ---- loop ---------------------------------------------------------------- */
    loop((dt, t, raw) => {
      if (t > total) return false;
      dt = Math.max(0, dt);
      tNow = t;
      let d = want - aim;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      aim += d * Math.min(1, dt / 130);
      recoil *= Math.pow(0.86, dt / 16.67);
      armG.setAttribute('transform',
        `translate(${ex.toFixed(1)} ${ey.toFixed(1)}) rotate(${((aim * 180) / Math.PI).toFixed(2)}) translate(0 ${(recoil * 13).toFixed(1)})`);
      updatePalm();

      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, layer.cv.width, layer.cv.height);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.globalAlpha = clamp((total - t) / FADE, 0, 1);

      for (const sh of shots) {
        const age = t - sh.t0;
        if (age < FLY) {
          // in flight: the line runs out from the palm with a slight bow
          const p = easeOut3(age / FLY);
          const x = sh.hx + (sh.tx - sh.hx) * p, y = sh.hy + (sh.ty - sh.hy) * p;
          const mx = (sh.hx + x) / 2, my = (sh.hy + y) / 2 + Math.hypot(x - sh.hx, y - sh.hy) * 0.04;
          silkLine([[sh.hx, sh.hy], [mx, my], [x, y]], 2.4);
          continue;
        }
        if (!sh.rope) startRope(sh);
        if (sh.pinEnd && age > FLY + TAUT) {
          // snap near the wrist: keep a dangling piece, reel the rest in
          const M = sh.rope.length;
          const keep = clamp(Math.round(rand(90, 220) / sh.seg), 2, M - 3);
          sh.reel = { pts: sh.rope.slice(keep).map((n) => [n.x, n.y]), t0: t };
          sh.rope = sh.rope.slice(0, keep + 1);
          sh.pinEnd = false;
          // a little recoil whip into the free end
          const end = sh.rope[sh.rope.length - 1];
          end.px = end.x + (palm.x - sh.tx) * 0.006; end.py = end.y + 2;
        }
        sh.acc = Math.min(sh.acc + (raw === undefined ? dt : Math.max(0, raw)) / 1000, 0.1);
        while (sh.acc >= RDT) { stepRope(sh); sh.acc -= RDT; }
        drawSplat(sh.sp, (age - FLY) / 1000);
        silkLine(sh.rope.map((n) => [n.x, n.y]), sh.pinEnd ? 2.2 : 1.8);
        if (sh.reel) {
          const p = (t - sh.reel.t0) / 140;
          if (p < 1) {
            // the cut piece whips back into the shooter
            const pts = sh.reel.pts.map(([x, y]) => [x + (palm.x - x) * easeIn2(p), y + (palm.y - y) * easeIn2(p)]);
            g.save(); g.globalAlpha *= 1 - p; silkLine(pts, 1.6); g.restore();
          } else sh.reel = null;
        }
      }
      g.globalAlpha = 1;
    });

    return total;
  }

  sfx.register('spiderman', webSlinger);
  sfx.register('webShooter', webShooter);
})();
