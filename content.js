/* ============================================================================
 * ScreenFX — injected effect runtime
 * ----------------------------------------------------------------------------
 * Injected on demand by the popup (user click) or the service worker (a
 * schedule firing). Re-injecting the same build into a page is a no-op; a
 * NEWER build replaces the old one (see RUNTIME below). Callers then just call
 * window.__screenFX.play(name, opts).
 *
 * ADDING A 9TH EFFECT
 *   1. write   function myEffect(stage, css, ctx) { ...; return totalMs; }
 *   2. register it in the EFFECTS object near the bottom
 *   3. add one matching card to EFFECTS in popup.js
 *   4. add one label to EFFECT_LABELS in options.js
 *   5. bump RUNTIME, or open tabs keep the build that has no such effect
 *
 * Effect contract
 *   stage — an empty, full-viewport, pointer-events:none div you own entirely
 *   css   — css(text) appends scoped CSS; it is thrown away with the overlay
 *   ctx   — { duration, reduced, hold(intro, outro, min), fit(intro, outro, min) }
 *
 *           `duration` is how long the user asked the effect to stay on screen.
 *           Do NOT stretch the whole animation to fill it — a slam is a slam at
 *           any setting. Play the intro at its natural speed, sit in a HOLD
 *           phase for ctx.hold(intro, outro), then play the outro. That is what
 *           makes 3s and 30s both look deliberate instead of slow-motion.
 *
 *           Use ctx.fit() instead of ctx.hold() when your intro + outro are
 *           long enough that they might not FIT the shortest setting. fit()
 *           returns compressed {intro, outro, hold} that always land inside the
 *           budget; hold() alone would overrun it.
 *
 *   return  the real total in ms. The overlay tears itself down then; the
 *           safety timeout is only a backstop, never the plan.
 *
 * House rules for effect code
 *   - every selector starts with R (the overlay id) so nothing leaks to the host
 *   - animate transform / opacity / filter only
 *   - linear easing ONLY for genuinely constant motion (looping waves, falling
 *     confetti, spin, progress). Everything else gets a real curve.
 * ========================================================================== */
(() => {
  /* Bump RUNTIME whenever the effect registry or the public API changes.
     Injection is idempotent, which means an older build already living in an
     open tab would otherwise win forever: re-injecting is a no-op, so any
     newly added effect silently does nothing until that tab is reloaded. The
     version check turns "reload every tab" into "the newest build wins". */
  const RUNTIME = 2;
  const prev = window.__screenFX;
  if (prev) {
    if (prev.version === RUNTIME) return;      // same build, nothing to do
    try { prev.stop(); } catch (err) { /* older build, already torn down */ }
  }

  const ROOT_ID = '__screenfx_root';
  const R = '#' + ROOT_ID;
  const DEFAULT_MS = 6000;
  const MIN_MS = 1500;
  const MAX_MS = 60000;
  // Same critically-damped spring the popup and settings use (damping 1.0,
  // response 0.35), so the overlay chrome moves like the rest of the product.
  const SPRING = 'linear(0, 0.0242, 0.0829, 0.1605, 0.2464, 0.3335, 0.4175, 0.4958, 0.5671, 0.6308, 0.6869, 0.7358, 0.778, 0.8142, 0.845, 0.8711, 0.8931, 0.9116, 0.927, 0.9399, 0.9506, 0.9594, 0.9667, 0.9728, 0.9777, 0.9818, 0.9852, 0.9879, 0.9902, 0.992, 0.9935, 0.9947, 0.9957, 0.9965, 0.9972, 0.9977, 0.9982, 0.9985, 0.9988, 0.999, 0.9992)';
  const SPRING_MS = 530;
  const RING_R = 13;                       // dismiss-ring radius
  const RING_C = 2 * Math.PI * RING_R;

  /* ---------- tiny helpers ------------------------------------------------ */
  const rand = (a, b) => a + Math.random() * (b - a);
  const rint = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (a) => a[(Math.random() * a.length) | 0];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const prefersReduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // DOMParser instead of innerHTML: works even on strict Trusted Types pages.
  const svgFrom = (markup) =>
    document.importNode(
      new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement,
      true
    );

  // cssText is CSSOM, so it is never blocked by a page's style-src policy.
  const el = (tag, cls, cssText) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (cssText) n.style.cssText = cssText;
    return n;
  };
  const div = (cls, cssText) => el('div', cls, cssText);

  /* ---------- overlay lifecycle ------------------------------------------- */
  let timers = [];
  let onKey = null;
  let session = 0;                   // bumped on teardown; kills in-flight rAF loops
  const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };

  /* A per-frame loop tied to the overlay's lifetime. step(dt, elapsed) runs with
     dt clamped so a backgrounded tab does not resume with a 4-second timestep
     and explode the physics; returning false ends the loop early. */
  const loop = (step) => {
    const mine = session;
    let last = performance.now();
    const t0 = last;
    const tick = (now) => {
      if (mine !== session) return;              // overlay is gone, stop cold
      const dt = Math.min(34, now - last);
      last = now;
      if (step(dt, now - t0) === false) return;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  function destroy() {
    session++;
    timers.forEach(clearTimeout);
    timers = [];
    if (onKey) { window.removeEventListener('keydown', onKey, true); onKey = null; }
    const old = document.getElementById(ROOT_ID);
    if (old) old.remove();           // takes the scoped <style> with it
  }

  const BASE_CSS = `
${R}{position:fixed!important;inset:0!important;z-index:2147483600!important;pointer-events:none!important;overflow:hidden!important;direction:ltr!important;text-align:left!important;}
${R},${R} *{box-sizing:border-box;margin:0;padding:0;border:0;outline:0;background:transparent;box-shadow:none;text-transform:none;letter-spacing:normal;text-indent:0;float:none;min-width:0;min-height:0;max-width:none;max-height:none;filter:none;opacity:1;}
${R} .sfx-stage{position:absolute;inset:0;overflow:hidden;}

/* Dismiss control. A translucent material floating over live page content —
   which is the one place in this extension where translucency is doing a job
   rather than decorating. Monochrome: it sits on top of arbitrary pages, so it
   carries no product colour of its own. No rotate-on-hover; an X that spins is
   a tic, not feedback. */
${R} .sfx-dismiss{position:absolute;top:16px;right:16px;width:34px;height:34px;pointer-events:auto;cursor:pointer;
 display:flex;align-items:center;justify-content:center;border-radius:50%;
 background:rgba(22,22,24,.58)!important;
 box-shadow:inset 0 0 0 .5px rgba(255,255,255,.3),inset 0 1px 0 rgba(255,255,255,.16),0 6px 20px rgba(0,0,0,.34)!important;
 -webkit-backdrop-filter:blur(20px) saturate(1.8);backdrop-filter:blur(20px) saturate(1.8);
 opacity:0;transform:scale(.96);
 transition:opacity ${SPRING_MS}ms ${SPRING},transform ${SPRING_MS}ms ${SPRING},box-shadow 160ms ease-out;z-index:9;}
${R} .sfx-dismiss.sfx-in{opacity:1;transform:scale(1);}
${R} .sfx-dismiss:hover{background:rgba(30,30,32,.66)!important;box-shadow:inset 0 0 0 .5px rgba(255,255,255,.52),inset 0 1px 0 rgba(255,255,255,.22),0 8px 24px rgba(0,0,0,.4)!important;}
${R} .sfx-dismiss:active{transform:scale(.94);transition-duration:110ms;}
${R} .sfx-x{position:relative;z-index:1;color:rgba(255,255,255,.96);
 font:500 17px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif!important;}
${R} .sfx-ring{position:absolute;inset:0;transform:rotate(-90deg);overflow:visible;}
${R} .sfx-ring circle{fill:none;stroke-linecap:round;}
${R} .sfx-ring-bg{stroke:rgba(255,255,255,.18);stroke-width:2;}
${R} .sfx-ring-fg{stroke:rgba(255,255,255,.92);stroke-width:2;stroke-dasharray:${RING_C.toFixed(2)};stroke-dashoffset:0;}
@media (prefers-reduced-transparency:reduce){
 ${R} .sfx-dismiss{background:rgba(22,22,24,.95)!important;-webkit-backdrop-filter:none;backdrop-filter:none;}}

@keyframes sfx-ring-drain{from{stroke-dashoffset:0}to{stroke-dashoffset:${RING_C.toFixed(2)}}}
@keyframes sfx-shake{0%{transform:translate3d(0,0,0)}8%{transform:translate3d(-9px,5px,0) rotate(-.4deg)}20%{transform:translate3d(8px,-6px,0) rotate(.34deg)}32%{transform:translate3d(-6px,-4px,0)}46%{transform:translate3d(5px,5px,0) rotate(.22deg)}60%{transform:translate3d(-4px,3px,0)}74%{transform:translate3d(3px,-2px,0)}88%{transform:translate3d(-1px,1px,0)}100%{transform:translate3d(0,0,0)}}
@keyframes sfx-fade-in{from{opacity:0}to{opacity:1}}
@keyframes sfx-fade-out{from{opacity:1}to{opacity:0}}
`;

  function mount(duration) {
    destroy();
    const root = el('div');
    root.id = ROOT_ID;

    const style = document.createElement('style');
    root.appendChild(style);
    const css = (t) => style.appendChild(document.createTextNode(t));
    css(BASE_CSS);

    const stage = div('sfx-stage');
    root.appendChild(stage);

    // Dismiss + countdown. The ring is the static cue for "how much is left" —
    // motion should never be the only feedback channel.
    const btn = el('button', 'sfx-dismiss');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Dismiss ScreenFX effect');
    btn.title = 'Dismiss (Esc)';
    const ring = svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" class="sfx-ring" viewBox="0 0 34 34">
      <circle class="sfx-ring-bg" cx="17" cy="17" r="${RING_R}"/>
      <circle class="sfx-ring-fg" cx="17" cy="17" r="${RING_R}"/>
    </svg>`);
    // progress is constant motion — linear is correct here, a curve would lie
    ring.querySelector('.sfx-ring-fg').style.animation =
      `sfx-ring-drain ${duration}ms linear forwards`;
    const x = el('span', 'sfx-x');
    x.textContent = '×';
    btn.append(ring, x);
    btn.addEventListener('click', destroy);
    root.appendChild(btn);

    (document.body || document.documentElement).appendChild(root);
    later(() => btn.classList.add('sfx-in'), 420);
    return { root, stage, css };
  }

  /* Shake the stage (not the root — the root must stay pinned to the viewport). */
  const shake = (stage, delay = 0, dur = 520) => {
    if (prefersReduced()) return;
    stage.style.animation = `sfx-shake ${dur}ms cubic-bezier(.36,.07,.19,.97) ${delay}ms both`;
  };

  /* Fade a layer in at the start and out at the end, independent of total
     length — percentage keyframes would stretch the fades with the duration. */
  const breathe = (node, total, inMs = 400, outMs = 450) => {
    node.style.animation =
      `sfx-fade-in ${inMs}ms cubic-bezier(0.22,1,0.36,1) both,` +
      `sfx-fade-out ${outMs}ms cubic-bezier(0.22,1,0.36,1) ${Math.max(0, total - outMs)}ms forwards`;
  };

  /* Effective page background luminance, for effects that must stay legible on
     both light and dark pages. Falls back to "light" (the browser default). */
  function pageLuminance() {
    const probe = (node) => {
      if (!node) return null;
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(node).backgroundColor);
      if (!m) return null;
      const p = m[1].split(',').map(parseFloat);
      if (p.length > 3 && p[3] < 0.35) return null;   // see-through, keep looking
      return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
    };
    const v = probe(document.body);
    if (v !== null) return v;
    const h = probe(document.documentElement);
    return h !== null ? h : 0.95;
  }

  /* ========================================================================
   * 1. PRISON BARS — bars slam down with overshoot, impact shake, hold, lift
   * ====================================================================== */
  function prisonBars(stage, css, ctx) {
    const count = clamp(Math.round(window.innerWidth / 118), 5, 14);
    const DROP = 620, STEP = 34, LIFT = 540;
    const INTRO = (count - 1) * STEP + DROP;
    const OUTRO = (count - 1) * STEP + LIFT;
    const HOLD = ctx.hold(INTRO, OUTRO, 600);
    const liftAt = INTRO + HOLD;
    const total = liftAt + OUTRO + 120;

    css(`
${R} .sfx-cell{position:absolute;inset:0;opacity:0;
 background:radial-gradient(120% 90% at 50% 45%,rgba(0,0,0,0) 34%,rgba(6,6,8,.4) 100%);}
${R} .sfx-bar{position:absolute;top:-5%;height:110%;width:44px;border-radius:3px;
 background:linear-gradient(90deg,#08090b 0%,#2b2f35 10%,#6e747c 27%,#c6ccd4 41%,#878d95 51%,#3d424a 72%,#111316 100%);
 box-shadow:0 0 0 1px rgba(0,0,0,.5),9px 0 16px -13px rgba(0,0,0,.6),-9px 0 16px -13px rgba(0,0,0,.6);
 transform:translate3d(-50%,-106%,0);}
${R} .sfx-bar::after{content:"";position:absolute;inset:0;border-radius:3px;
 background:repeating-linear-gradient(0deg,rgba(255,255,255,.05) 0 2px,rgba(0,0,0,.05) 2px 5px);}
${R} .sfx-rail{position:absolute;left:-2%;width:104%;height:30px;
 background:linear-gradient(180deg,#14161a 0%,#5a6068 22%,#c3c9d1 46%,#71767e 66%,#101216 100%);
 box-shadow:0 12px 26px -10px rgba(0,0,0,.75);}
${R} .sfx-rail-t{top:0;transform:translate3d(0,-110%,0);}
${R} .sfx-rail-b{bottom:0;transform:translate3d(0,110%,0);}
@keyframes sfx-bar-drop{from{transform:translate3d(-50%,-106%,0)}to{transform:translate3d(-50%,0,0)}}
@keyframes sfx-bar-lift{from{transform:translate3d(-50%,0,0)}to{transform:translate3d(-50%,-106%,0)}}
@keyframes sfx-rail-t-in{from{transform:translate3d(0,-110%,0)}to{transform:translate3d(0,0,0)}}
@keyframes sfx-rail-t-out{from{transform:translate3d(0,0,0)}to{transform:translate3d(0,-110%,0)}}
@keyframes sfx-rail-b-in{from{transform:translate3d(0,110%,0)}to{transform:translate3d(0,0,0)}}
@keyframes sfx-rail-b-out{from{transform:translate3d(0,0,0)}to{transform:translate3d(0,110%,0)}}
`);

    const cell = div('sfx-cell');
    breathe(cell, total, 500, 500);
    stage.appendChild(cell);

    for (let i = 0; i < count; i++) {
      const b = div('sfx-bar');
      b.style.left = ((i + 0.5) / count) * 100 + '%';
      // The overshoot lives in the curve, not in extra keyframes; the 5% top
      // bleed hides the gap that overshoot would otherwise open at the top edge.
      b.style.animation =
        `sfx-bar-drop ${DROP}ms cubic-bezier(.28,1.34,.44,1) ${i * STEP + rand(-7, 7)}ms forwards,` +
        `sfx-bar-lift ${LIFT}ms cubic-bezier(.6,0,.78,.36) ${liftAt + (count - 1 - i) * STEP}ms forwards`;
      stage.appendChild(b);
    }

    const rt = div('sfx-rail sfx-rail-t');
    rt.style.animation =
      `sfx-rail-t-in 440ms cubic-bezier(.24,1.2,.4,1) 60ms forwards,` +
      `sfx-rail-t-out 420ms cubic-bezier(.6,0,.78,.36) ${liftAt + 140}ms forwards`;
    const rb = div('sfx-rail sfx-rail-b');
    rb.style.animation =
      `sfx-rail-b-in 440ms cubic-bezier(.24,1.2,.4,1) 120ms forwards,` +
      `sfx-rail-b-out 420ms cubic-bezier(.6,0,.78,.36) ${liftAt + 140}ms forwards`;
    stage.append(rt, rb);

    shake(stage, INTRO - 190, 560);   // lands as the last bars hit
    return total;
  }

  /* ---- shared web rendering ---------------------------------------------
     Both web effects draw the same silk, so the splat generator and the
     figure's suit palette live out here rather than in one of them. */
  const SUIT = { RED: '#CE2B33', RED_D: '#9C1B22', BLU: '#22307F', BLU_D: '#161F5C', INK: '#170A0C' };

  /* A web splat: a small sticky centre, strands thrown well past it, and two
     ragged rings tying them together. The strands carry the read — a big solid
     blob just looks like a squashed insect. */
  function splatMarkup(r) {
    const n = rint(11, 15), rr = [], pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.16, 0.16);
      const k = r * rand(0.34, 0.56);
      rr.push(k); pts.push([Math.cos(a) * k, Math.sin(a) * k, a]);
    }
    let blob = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    for (let i = 1; i <= n; i++) {
      const p = pts[i % n], q = pts[i - 1], s = rand(0.42, 0.72);
      blob += ' Q' + ((p[0] + q[0]) * s).toFixed(1) + ' ' + ((p[1] + q[1]) * s).toFixed(1) +
              ' ' + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
    }
    blob += 'Z';
    let strands = '';
    pts.forEach((p, i) => {
      const a = p[2], far = rr[i] * rand(2.4, 3.6);
      strands += 'M' + (Math.cos(a) * rr[i] * 0.4).toFixed(1) + ' ' + (Math.sin(a) * rr[i] * 0.4).toFixed(1) +
                 ' L' + (Math.cos(a) * far).toFixed(1) + ' ' + (Math.sin(a) * far).toFixed(1);
    });
    [1.35, 2.05, 2.75].forEach((f) => {
      let d = '';
      pts.forEach((p, i) => {
        const a = p[2], k = rr[i] * f * rand(0.88, 1.12);
        d += (i ? ' L' : 'M') + (Math.cos(a) * k).toFixed(1) + ' ' + (Math.sin(a) * k).toFixed(1);
      });
      strands += d + 'Z';
    });
    return '<path class="sfx-sp-blob" d="' + blob + '"/><path class="sfx-sp-web" d="' + strands + '"/>';
  }

  /* Silk has to hold up on a white page and a black one alike: take the line
     colour from the page and back it with the opposite tone. */
  const silkTones = () => {
    const dark = pageLuminance() <= 0.5;
    return {
      silk: dark ? '#F4F1E6' : '#1A1C22',
      halo: dark ? 'rgba(0,0,0,.7)' : 'rgba(255,255,255,.92)'
    };
  };

  const shotCSS = (silk, halo) => `
${R} .sfx-shot{position:absolute;inset:0;overflow:visible;}
${R} .sfx-line{stroke:${silk};stroke-width:2.6;stroke-linecap:round;fill:none;
 filter:drop-shadow(0 0 2px ${halo});
 animation:sfx-draw 130ms cubic-bezier(.14,.78,.3,1) forwards,
           sfx-fade-out 300ms cubic-bezier(0.22,1,0.36,1) 380ms forwards;}
${R} .sfx-sp{opacity:0;transform-origin:0 0;filter:drop-shadow(0 0 2.5px ${halo});
 animation:sfx-splat 420ms ${SPRING} 112ms forwards;}
${R} .sfx-sp-blob{fill:${silk};opacity:.5;}
${R} .sfx-sp-web{stroke:${silk};stroke-width:1.4;fill:none;stroke-linecap:round;stroke-linejoin:round;opacity:.8;}
@keyframes sfx-draw{to{stroke-dashoffset:0}}
@keyframes sfx-splat{from{transform:scale(.22);opacity:0}to{transform:scale(1);opacity:1}}
`;

  /* Fire one web from (hx,hy) to (tx,ty) into the given <svg>. Returns the
     group, so the caller can decide how long it lives. */
  function fireWeb(into, hx, hy, tx, ty, size) {
    const len = Math.hypot(tx - hx, ty - hy);
    if (len < 26) return null;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('class', 'sfx-line');
    // a slight bow, so it reads as a thrown line rather than a laser
    const mx = (hx + tx) / 2 + rand(-0.05, 0.05) * len;
    const my = (hy + ty) / 2 + len * 0.045;
    line.setAttribute('d',
      `M${hx.toFixed(1)} ${hy.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`);
    line.style.strokeDasharray = line.style.strokeDashoffset = (len * 1.1).toFixed(0);

    const at = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    at.setAttribute('transform', `translate(${tx.toFixed(1)} ${ty.toFixed(1)}) rotate(${rint(0, 359)})`);
    const sp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    sp.setAttribute('class', 'sfx-sp');
    const parsed = svgFrom(`<svg xmlns="http://www.w3.org/2000/svg">${splatMarkup(size)}</svg>`);
    while (parsed.firstChild) sp.appendChild(parsed.firstChild);
    at.appendChild(sp);

    g.append(line, at);
    into.appendChild(g);
    return g;
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
${R} .sfx-figure{filter:drop-shadow(0 0 5px rgba(0,0,0,.28)) drop-shadow(0 2px 3px rgba(0,0,0,.22));}
`;

  /* ========================================================================
   * 2. WEB SLINGER — a line anchors in the top-right corner and lowers a
   *    web-slinger smoothly down the page, where he hangs and sways before
   *    being drawn back up.
   *
   *    The line is still an 18-node verlet rope on a fixed 1/120s timestep,
   *    but it pays out SLOWER than he would fall, so it never goes slack and
   *    there is no whip — he is lowered, not dropped. All the physics does
   *    here is supply the sag, the slow pendulum (T = 2*pi*sqrt(L/g), about
   *    2.7s at this length) and the way his arms trail the sway and settle
   *    late. Those are the parts that make a smooth descent look alive rather
   *    than like a sprite sliding down a guide.
   * ====================================================================== */
  function webSlinger(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const uid = 'sfx' + ((Math.random() * 1e9) | 0).toString(36);

    const ax = Math.round(W - clamp(W * 0.23, 150, 360));
    const ay = -4;
    const L = Math.round(clamp(H * 0.46, 210, 460));

    const DROP = 1250, RETRACT = 1050;
    const HOLD = ctx.hold(DROP, RETRACT, 1100);
    const RETRACT_AT = DROP + HOLD;
    const total = RETRACT_AT + RETRACT + 160;

    const S = clamp((H * 0.305) / 110, 1.2, 2.9);
    const { silk, halo } = silkTones();

    /* ---- verlet rope ---------------------------------------------------- */
    const N = 18, G = 2100, ITER = 8, DT = 1 / 120;
    const DAMP = ctx.reduced ? 0.86 : 0.9986;
    const node = [];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      node.push({ x: ax, y: ay + t * 26, px: ax, py: ay + t * 26 });
    }
    // Just enough sideways nudge to start a slow, shallow sway. A hard throw
    // is what made this read as a drop instead of a descent.
    if (!ctx.reduced) {
      const vx = -rand(70, 115) / 60;
      for (let i = 1; i < N; i++) { node[i].px -= vx * (i / (N - 1)); }
    }

    // Smooth in, smooth out, constant in the middle: a winch, not a fall.
    const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const restLen = (t) => {
      if (t < DROP) return 22 + (L - 22) * easeInOut(t / DROP);
      if (t < RETRACT_AT) return L;
      return 22 + (L - 22) * (1 - easeInOut(clamp((t - RETRACT_AT) / RETRACT, 0, 1)));
    };

    let acc = 0;
    function step(seg) {
      for (let i = 1; i < N; i++) {
        const n = node[i];
        const vx = (n.x - n.px) * DAMP, vy = (n.y - n.py) * DAMP;
        n.px = n.x; n.py = n.y;
        n.x += vx; n.y += vy + G * DT * DT;
      }
      for (let k = 0; k < ITER; k++) {
        // Gauss-Seidel is order-dependent, so alternating the sweep stops the
        // rope stretching asymmetrically down its length.
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
        node[0].x = ax; node[0].y = ay;          // re-pin every iteration
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

    css(suitCSS() + `
${R} .sfx-web{position:absolute;inset:0;overflow:visible;}
${R} .sfx-silk{fill:${silk};filter:drop-shadow(0 0 2.5px ${halo}) drop-shadow(0 0 1px ${halo});}
${R} .sfx-anchor{stroke:${silk};stroke-width:1.5;stroke-linecap:round;fill:none;opacity:.78;
 filter:drop-shadow(0 0 2px ${halo});
 stroke-dasharray:1100;stroke-dashoffset:1100;
 animation:sfx-draw2 620ms cubic-bezier(.12,.82,.26,1) forwards,
           sfx-fade-out 420ms cubic-bezier(0.22,1,0.36,1) ${RETRACT_AT + 420}ms forwards;}
@keyframes sfx-draw2{to{stroke-dashoffset:0}}
`);

    // Anchor web: strands fanning round the pivot, tied by ragged rings, so
    // the line looks fired into something rather than hung off nothing.
    const span = clamp((W - ax) * 0.34, 54, 92);
    const fan = [];
    for (let i = 0; i < 9; i++) fan.push(-0.26 + (i / 8) * (Math.PI + 0.52) + rand(-0.05, 0.05));
    let anchorD = '';
    fan.forEach((a) => {
      const r = span * rand(0.72, 1.05);
      anchorD += ` M${ax} ${ay} L${(ax + Math.cos(a) * r).toFixed(1)} ${(ay + Math.sin(a) * r).toFixed(1)}`;
    });
    [0.3, 0.52, 0.74, 0.96].forEach((f) => {
      let d = '';
      fan.forEach((a, i) => {
        const r = span * f * rand(0.9, 1.1);
        d += (i ? ' L' : ' M') + (ax + Math.cos(a) * r).toFixed(1) + ' ' + (ay + Math.sin(a) * r).toFixed(1);
      });
      anchorD += d;
    });

    const fig = slingerFigure(uid);
    const svg = svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" class="sfx-web" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <clipPath id="${uid}h"><ellipse cx="0" cy="0" rx="10.2" ry="11.4"/></clipPath>
    <clipPath id="${uid}c"><path d="${fig.chestD}"/></clipPath>
  </defs>
  <path class="sfx-anchor" d="${anchorD}"/>
  <path class="sfx-silk" d=""/>
  <g class="sfx-body"><g transform="scale(${S.toFixed(3)})">${fig.markup}</g></g>
</svg>`);
    stage.appendChild(svg);

    const silkEl = svg.querySelector('.sfx-silk');
    const bodyEl = svg.querySelector('.sfx-body');
    const armsEl = svg.querySelectorAll('.sfx-arms');
    let heroA = Math.PI / 2, armA = heroA;

    loop((dt, t) => {
      if (t > total) return false;
      acc = Math.min(acc + dt / 1000, 0.1);
      const seg = restLen(t) / (N - 1);
      while (acc >= DT) { step(seg); acc -= DT; }

      silkEl.setAttribute('d', ribbon(3.4, 2.0));
      const a = node[N - 1], b = node[N - 2];
      heroA = Math.atan2(a.y - b.y, a.x - b.x);
      let d = heroA - armA;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      armA += d * Math.min(1, dt / 150);

      bodyEl.setAttribute('transform',
        `translate(${a.x.toFixed(1)} ${a.y.toFixed(1)}) rotate(${((heroA * 180) / Math.PI - 90).toFixed(2)})`);
      const lag = `rotate(${((((armA - heroA) * 180) / Math.PI) * 0.8).toFixed(2)} 0 76)`;
      armsEl.forEach((n) => n.setAttribute('transform', lag));
    });

    return total;
  }

  /* ========================================================================
   * 2b. WEB SHOOTER — the page becomes a web-shooter. A gloved forearm comes
   *     in from the bottom-right, tracks the pointer, and fires a line that
   *     sticks wherever you click. Webs accumulate until the page is covered.
   * ====================================================================== */
  function webShooter(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const total = ctx.duration;
    const FADE = 600;
    const { silk, halo } = silkTones();

    // Elbow just off the bottom-right corner; the forearm runs from there up
    // to the palm, and the whole arm pivots about the elbow to aim.
    // The elbow sits just off-screen past the corner, and how far the palm
    // reaches into the page is set in pixels — deriving it from the figure
    // scale left the hand lying in the corner instead of reaching in.
    const ex = W + 34, ey = H + 66;
    const ARM = 150;                                  // elbow-to-palm, local units
    const REACH = clamp(Math.min(W, H) * 0.54, 300, 560);
    const S = REACH / ARM;
    // Keep the arm inside a believable range of shoulder angles — swung flat
    // it stops reading as an arm and starts reading as a mitten on the floor.
    const AIM_LO = -1.28, AIM_HI = -0.38;

    css(shotCSS(silk, halo) + `
${R} .sfx-aim{position:absolute;inset:0;pointer-events:auto;cursor:crosshair;z-index:4;}
${R} .sfx-hand{position:absolute;inset:0;overflow:visible;
 filter:drop-shadow(-6px -4px 14px rgba(0,0,0,.34));
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

    const shots = svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" class="sfx-shot" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"></svg>`);
    stage.appendChild(shots);

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
    let aim = -0.84;                                  // resting angle, radians
    let want = aim;
    let recoil = 0;
    let palm = { x: ex, y: ey - ARM * S };

    const setAim = (tx, ty) => { want = clamp(Math.atan2(tx - ex, -(ty - ey)), AIM_LO, AIM_HI); };
    setAim(W * 0.45, H * 0.35);
    aim = want;

    const live = [];
    const shoot = (tx, ty) => {
      const g = fireWeb(shots, palm.x, palm.y, tx, ty, rand(18, 30));
      if (!g) return;
      recoil = 1;
      live.push(g);
      if (live.length > 26) live.shift().remove();
    };

    const hit = div('sfx-aim');
    hit.addEventListener('pointermove', (e) => setAim(e.clientX, e.clientY));
    hit.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      setAim(e.clientX, e.clientY);
      aim = want;                                     // snap onto a deliberate shot
      shoot(e.clientX, e.clientY);
    });
    stage.appendChild(hit);

    // Fire a couple unprompted, so the effect explains itself to someone who
    // never clicks.
    if (!ctx.reduced) {
      [520, 1180].forEach((at, i) => later(() => {
        const tx = rand(W * 0.12, W * 0.62), ty = rand(H * 0.12, H * 0.5);
        setAim(tx, ty); if (!i) aim = want;
        shoot(tx, ty);
      }, at));
    }

    const hint = div('sfx-hint');
    const hs = el('span');
    hs.textContent = 'Click to shoot';
    hint.appendChild(hs);
    hint.style.animation =
      `sfx-fade-in 420ms cubic-bezier(0.22,1,0.36,1) 900ms both,` +
      `sfx-fade-out 420ms cubic-bezier(0.22,1,0.36,1) 3200ms forwards`;
    stage.appendChild(hint);

    loop((dt, t) => {
      if (t > total) return false;
      let d = want - aim;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      aim += d * Math.min(1, dt / 130);
      recoil *= Math.pow(0.86, dt / 16.67);

      const deg = (aim * 180) / Math.PI;
      armG.setAttribute('transform',
        `translate(${ex.toFixed(1)} ${ey.toFixed(1)}) rotate(${deg.toFixed(2)}) translate(0 ${(recoil * 13).toFixed(1)})`);
      palm = {
        x: ex + Math.sin(aim) * (REACH - recoil * 13 * S),
        y: ey - Math.cos(aim) * (REACH - recoil * 13 * S)
      };
    });

    later(() => {
      shots.style.transition = `opacity ${FADE}ms cubic-bezier(0.22,1,0.36,1)`;
      shots.style.opacity = '0';
    }, total - FADE);

    return total;
  }

  /* ========================================================================
   * 3. FLOOD — muddy water surges up from below, swallows the page whole, and
   *    drains away.
   *
   *    The point of this one is that everything goes. Flood water is not a
   *    rinse and it is not clear: it is opaque with silt, so anything it
   *    covers is simply gone until it leaves. That is carried by a heavy
   *    backdrop-filter under a silt-coloured body, which is the only honest
   *    way to take the page away without touching the page.
   *
   *    A real surge rises fast and then slows as it spreads, so the rise is
   *    strongly eased out rather than linear. The surface gets two crests
   *    scrolling against each other at different rates — a single scrolling
   *    wave reads as a loop, two never repeat at the same moment. Debris rides
   *    the surface because floating junk is what makes water read as a flood
   *    rather than as a filling tank.
   * ====================================================================== */
  function flood(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const LEVEL = 6;                                   // final waterline, % of H
    const NAT_RISE = 1500, NAT_DRAIN = 1100;
    const f = ctx.fit(NAT_RISE, NAT_DRAIN, 700);
    const RISE = f.intro, DRAIN = f.outro;
    const DRAIN_AT = RISE + f.hold;
    const total = DRAIN_AT + DRAIN;

    // A wave path that tiles seamlessly across 1200 units.
    const crest = (period, amp, h) => {
      let d = `M0 ${amp + 2}`;
      for (let x = 0; x < 1200; x += period) {
        d += ` q ${period / 4} ${-amp} ${period / 2} 0 q ${period / 4} ${amp} ${period / 2} 0`;
      }
      return d + ` L1200 ${h} L0 ${h} Z`;
    };

    css(`
${R} .sfx-fl{position:absolute;left:0;top:0;width:100%;height:132%;
 transform:translate3d(0,100%,0);
 animation:sfx-fl-rise ${RISE}ms cubic-bezier(.06,.74,.26,1) forwards,
           sfx-fl-drain ${DRAIN}ms cubic-bezier(.5,0,.78,.4) ${DRAIN_AT}ms forwards;}
${R} .sfx-fl-swell{position:absolute;inset:0;
 animation:sfx-fl-swell 3400ms cubic-bezier(.45,0,.55,1) infinite alternate;}

/* The body. Silt makes flood water opaque, so this is what removes the page. */
${R} .sfx-fl-body{position:absolute;left:0;right:0;top:0;bottom:0;
 background:linear-gradient(180deg,
   rgba(104,88,52,.88) 0%,rgba(84,70,42,.93) 14%,
   rgba(54,46,30,.94) 48%,rgba(28,25,18,.97) 100%);
 -webkit-backdrop-filter:blur(13px) saturate(.3) brightness(.55) contrast(1.15);
 backdrop-filter:blur(13px) saturate(.3) brightness(.55) contrast(1.15);}
/* Silt churning through the body at two speeds. */
${R} .sfx-fl-churn{position:absolute;left:-30%;right:-30%;top:-10%;bottom:-10%;opacity:.5;
 background:
  radial-gradient(38% 26% at 22% 30%,rgba(174,148,86,.32),transparent 70%),
  radial-gradient(30% 22% at 68% 52%,rgba(46,38,24,.52),transparent 72%),
  radial-gradient(42% 30% at 84% 22%,rgba(158,134,80,.24),transparent 74%),
  radial-gradient(34% 26% at 44% 76%,rgba(32,27,18,.52),transparent 70%);
 animation:sfx-fl-churn 7200ms cubic-bezier(.45,0,.55,1) infinite alternate;}
${R} .sfx-fl-churn2{animation-duration:11000ms;animation-direction:alternate-reverse;opacity:.34;}

/* Surface. Two crests at different periods and speeds, plus a foam line. */
${R} .sfx-fl-crest{position:absolute;left:0;width:200%;display:block;}
${R} .sfx-fl-foam{fill:none;stroke:rgba(240,242,226,.62);stroke-width:3.2;
 stroke-linecap:round;stroke-dasharray:34 22 9 31 18 44;filter:blur(.7px);}
${R} .sfx-fl-foam2{fill:none;stroke:rgba(248,250,238,.34);stroke-width:7;
 stroke-linecap:round;stroke-dasharray:14 46 26 62;filter:blur(3px);}
/* Sky bouncing off the surface, brightest right at the waterline. */
${R} .sfx-fl-sheen{position:absolute;left:0;right:0;top:0;height:54px;
 background:linear-gradient(180deg,rgba(226,234,212,.3) 0%,rgba(180,196,158,.12) 42%,rgba(0,0,0,0) 100%);
 mix-blend-mode:screen;}

${R} .sfx-deb{position:absolute;transform-origin:50% 50%;}
${R} .sfx-deb > i{display:block;width:100%;height:100%;
 background:var(--c);border-radius:var(--r);
 box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 2px 5px rgba(0,0,0,.4);}
${R} .sfx-spray{position:absolute;border-radius:50%;opacity:0;
 background:rgba(226,230,206,.9);box-shadow:0 0 4px rgba(210,216,184,.6);}

@keyframes sfx-fl-rise{from{transform:translate3d(0,100%,0)}to{transform:translate3d(0,${LEVEL}%,0)}}
@keyframes sfx-fl-drain{from{transform:translate3d(0,${LEVEL}%,0)}to{transform:translate3d(0,104%,0)}}
@keyframes sfx-fl-swell{from{transform:translate3d(0,5px,0)}to{transform:translate3d(0,-7px,0)}}
@keyframes sfx-fl-churn{from{transform:translate3d(-4%,2%,0) scale(1)}to{transform:translate3d(5%,-3%,0) scale(1.1)}}
@keyframes sfx-fl-crest{from{transform:translate3d(0,0,0)}to{transform:translate3d(-50%,0,0)}}
`);

    const fl = div('sfx-fl');
    const swell = div('sfx-fl-swell');

    const body = div('sfx-fl-body');
    body.append(div('sfx-fl-churn'), div('sfx-fl-churn sfx-fl-churn2'));
    swell.appendChild(body);

    // Two crests: the back one deeper and slower, the front one sharper.
    // Open (unclosed) copy of the same wave, for the foam to be stroked along.
    const crestLine = (period, amp) => {
      let d = `M0 ${amp + 2}`;
      for (let x = 0; x < 1200; x += period) {
        d += ` q ${period / 4} ${-amp} ${period / 2} 0 q ${period / 4} ${amp} ${period / 2} 0`;
      }
      return d;
    };

    [{ p: 340, a: 27, h: 150, sp: 9000, dir: 'normal', c: 'rgba(74,62,38,.9)', top: -58, foam: 0 },
     { p: 220, a: 18, h: 130, sp: 5600, dir: 'reverse', c: 'rgba(104,88,52,.88)', top: -36, foam: 1 }
    ].forEach((cfg) => {
      const s = svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" class="sfx-fl-crest" viewBox="0 0 1200 ${cfg.h}" preserveAspectRatio="none" height="${cfg.h}">
        <path d="${crest(cfg.p, cfg.a, cfg.h)}" fill="${cfg.c}"/>
        ${cfg.foam ? `<path class="sfx-fl-foam2" d="${crestLine(cfg.p, cfg.a)}"/>
        <path class="sfx-fl-foam" d="${crestLine(cfg.p, cfg.a)}"/>` : ''}
      </svg>`);
      s.style.top = cfg.top + 'px';
      s.style.animation = `sfx-fl-crest ${cfg.sp}ms linear infinite ${cfg.dir}`;
      swell.appendChild(s);
    });
    swell.appendChild(div('sfx-fl-sheen'));

    /* ---- debris riding the surface --------------------------------------- */
    // Silhouettes, because nothing keeps its colour in silt-laden water.
    const kinds = [
      { w: 46, h: 8, c: 'rgba(54,40,26,.95)', r: '2px' },      // plank
      { w: 30, h: 6, c: 'rgba(44,34,22,.95)', r: '2px' },      // splinter
      { w: 15, h: 12, c: 'rgba(30,42,26,.9)', r: '60% 20% 60% 20%' },  // leaf
      { w: 11, h: 11, c: 'rgba(38,44,38,.9)', r: '50%' },      // junk
      { w: 22, h: 15, c: 'rgba(48,44,32,.92)', r: '3px' }      // carton
    ];
    let kf = '';
    const count = clamp(Math.round(W / 58), 12, 34);
    const bag = [];
    for (let i = 0; i < count; i++) {
      const k = pick(kinds), sc = rand(0.7, 1.7);
      const drift = rand(-120, 120), spin = rand(-16, 16);
      kf += `@keyframes sfx-deb-${i}{` +
        `0%{transform:translate3d(0,0,0) rotate(0deg)}` +
        `50%{transform:translate3d(${(drift / 2).toFixed(0)}px,${rand(-7, 7).toFixed(1)}px,0) rotate(${(spin / 2).toFixed(1)}deg)}` +
        `100%{transform:translate3d(${drift.toFixed(0)}px,0,0) rotate(${spin.toFixed(1)}deg)}}`;
      const d = div('sfx-deb',
        `left:${rand(-4, 100).toFixed(1)}%;top:${rand(-10, 56).toFixed(0)}px;` +
        `width:${(k.w * sc).toFixed(0)}px;height:${(k.h * sc).toFixed(0)}px;` +
        `animation:sfx-deb-${i} ${rand(5200, 9000).toFixed(0)}ms cubic-bezier(.45,0,.55,1) ` +
        `${rand(-4000, 0).toFixed(0)}ms infinite alternate;`);
      const inner = el('i', '', `--c:${k.c};--r:${k.r};`);
      d.appendChild(inner);
      bag.push(d);
    }
    swell.append(...bag);

    fl.appendChild(swell);
    stage.appendChild(fl);

    /* ---- spray thrown off the surge --------------------------------------- */
    if (!ctx.reduced) {
      const N = clamp(Math.round(W / 30), 16, 46);
      const sp = [];
      for (let i = 0; i < N; i++) {
        const life = rand(420, 900);
        const ang = rand(-0.85, 0.85);
        const speed = rand(320, 820);
        const vx = Math.sin(ang) * speed, vy = -Math.cos(ang) * speed;
        const g = 1500;
        let k = '';
        for (let s = 0; s <= 4; s++) {
          const t = (s / 4) * (life / 1000);
          k += `${s * 25}%{transform:translate3d(${(vx * t).toFixed(1)}px,${(vy * t + 0.5 * g * t * t).toFixed(1)}px,0);` +
               `opacity:${(1 - Math.pow(s / 4, 2)).toFixed(2)}}`;
        }
        kf += `@keyframes sfx-spr-${i}{${k}}`;
        const d = rand(2, 6);
        sp.push(div('sfx-spray',
          `left:${rand(0, W).toFixed(0)}px;top:${rand(-16, 26).toFixed(0)}px;` +
          `width:${d.toFixed(1)}px;height:${(d * 1.2).toFixed(1)}px;` +
          `animation:sfx-spr-${i} ${life.toFixed(0)}ms linear ${(RISE * rand(0.14, 0.8)).toFixed(0)}ms forwards;`));
      }
      swell.append(...sp);
    }

    css(kf);                                   // one reparse, not sixty
    shake(stage, RISE * 0.12, 620);            // the surge hitting
    return total;
  }

  /* ========================================================================
   * 3b. UNDERWATER — the whole page is submerged. Light shafts come down from
   *     a surface somewhere above, caustics crawl over everything, bubbles
   *     rise, and fish swim past at three different depths.
   *
   *     Unlike the flood, this water is clear: the page stays readable, just
   *     blue, dimmer and slightly soft. Depth is carried by parallax — the far
   *     layer is small, pale, blurred and slow, the near layer is large, sharp
   *     and quick, and crosses the screen in a few seconds. That difference is
   *     what gives a flat page the illusion of volume.
   * ====================================================================== */
  function underwater(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const total = ctx.duration;
    const IN = 900, OUT = 760;

    /* ---- one procedural fish, facing +x ---------------------------------- */
    const FISH = [
      { body: '#F2861E', fin: '#D8690C', band: '#F7F2E6' },   // clown
      { body: '#F2C516', fin: '#D8A400', band: '#FFF6C4' },   // tang
      { body: '#3E86D6', fin: '#2C63A8', band: '#CFE6FF' },   // blue
      { body: '#C8542E', fin: '#A03B1C', band: '#F6D9C4' },   // rust
      { body: '#7FC7B8', fin: '#4E9A8A', band: '#E6FAF4' },   // teal
      { body: '#B9C3CC', fin: '#8B959E', band: '#F2F6F9' }    // silver
    ];

    const fishMarkup = (c, i) => `
<g class="sfx-fish-g">
  <g class="sfx-tail-${i}">
    <path d="M-27 0 L-51 -17 L-43 0 L-51 17 Z" fill="${c.fin}"/>
  </g>
  <path d="M3 -15 L-9 -29 L-19 -13 Z" fill="${c.fin}"/>
  <path d="M0 13 L-7 25 L-15 12 Z" fill="${c.fin}"/>
  <path d="M38 0 C30 -15 6 -21 -16 -12 C-24 -9 -28 -4 -30 0
           C-28 4 -24 9 -16 12 C6 21 30 15 38 0 Z" fill="${c.body}"/>
  <path d="M8 -18 C4 -6 4 6 8 18 L18 15 C15 5 15 -5 18 -15 Z" fill="${c.band}" opacity=".78"/>
  <path d="M-4 -19 C-8 -7 -8 7 -4 19 L2 17 C-1 6 -1 -6 2 -17 Z" fill="${c.band}" opacity=".5"/>
  <path d="M16 -11 C12 -4 12 4 16 11" fill="none" stroke="rgba(0,0,0,.2)" stroke-width="1.4"/>
  <circle cx="27" cy="-4" r="3.6" fill="#FBFDFF"/>
  <circle cx="27.8" cy="-4" r="1.9" fill="#101720"/>
</g>`;

    // Three depth layers. Everything about a layer follows from its distance.
    const layers = [
      { n: 5, s: [0.28, 0.4], sp: [15000, 22000], blur: 2.6, op: 0.3, dim: 0.55 },
      { n: 5, s: [0.5, 0.75], sp: [9000, 14000], blur: 1.0, op: 0.62, dim: 0.8 },
      { n: 3, s: [0.9, 1.35], sp: [5200, 8000], blur: 0, op: 0.92, dim: 1 }
    ];

    let kf = '';
    // Tail beat scales with the fish: a big fish beats slowly.
    for (let i = 0; i < 6; i++) {
      kf += `@keyframes sfx-tail-${i}{0%{transform:rotate(-15deg)}100%{transform:rotate(15deg)}}`;
    }

    css(`
${R} .sfx-uw{position:absolute;inset:0;opacity:0;
 background:linear-gradient(180deg,rgba(34,126,162,.3) 0%,rgba(20,86,124,.42) 46%,rgba(10,44,74,.6) 100%);
 -webkit-backdrop-filter:blur(1.4px) saturate(1.25) brightness(.9) hue-rotate(-12deg);
 backdrop-filter:blur(1.4px) saturate(1.25) brightness(.9) hue-rotate(-12deg);}
/* Shafts of surface light. They are volume, so they add rather than cover. */
${R} .sfx-ray{position:absolute;top:-40%;height:190%;mix-blend-mode:screen;opacity:0;
 background:linear-gradient(180deg,rgba(214,244,255,.5) 0%,rgba(188,232,255,.2) 44%,rgba(170,220,250,0) 88%);
 filter:blur(9px);}
/* Caustics: the surface acting as a lens, so the pattern crawls and breathes. */
${R} .sfx-caus{position:absolute;left:-25%;right:-25%;top:-25%;bottom:-25%;
 mix-blend-mode:screen;opacity:.42;
 background:
  radial-gradient(22% 14% at 18% 24%,rgba(206,244,255,.42),transparent 62%),
  radial-gradient(17% 11% at 52% 12%,rgba(214,248,255,.36),transparent 64%),
  radial-gradient(26% 16% at 78% 36%,rgba(196,238,255,.32),transparent 66%),
  radial-gradient(19% 12% at 34% 62%,rgba(206,244,255,.3),transparent 64%),
  radial-gradient(23% 15% at 68% 78%,rgba(190,234,255,.28),transparent 66%),
  radial-gradient(15% 10% at 88% 62%,rgba(214,248,255,.3),transparent 62%);
 animation:sfx-caus 9000ms cubic-bezier(.45,0,.55,1) infinite alternate;}
${R} .sfx-caus2{animation-duration:13500ms;animation-direction:alternate-reverse;opacity:.3;
 filter:blur(5px);}
/* Surface, seen from below. */
${R} .sfx-uwtop{position:absolute;left:0;right:0;top:0;height:16%;mix-blend-mode:screen;opacity:0;
 background:linear-gradient(180deg,rgba(226,250,255,.55) 0%,rgba(198,238,255,.18) 48%,rgba(190,232,255,0) 100%);}

${R} .sfx-swim{position:absolute;top:0;will-change:transform;}
${R} .sfx-bobb{display:block;}
${R} .sfx-fish{display:block;overflow:visible;}
${R} .sfx-fish-g{transform-box:fill-box;transform-origin:center;}
${R} .sfx-uwb{position:absolute;border-radius:50%;
 background:radial-gradient(38% 34% at 34% 28%,rgba(255,255,255,.85),rgba(222,246,255,.14) 62%);
 box-shadow:inset 0 0 0 1px rgba(236,252,255,.5),0 0 5px rgba(206,242,255,.4);}
${R} .sfx-snow{position:absolute;border-radius:50%;background:rgba(226,246,255,.5);}

@keyframes sfx-caus{from{transform:translate3d(-3%,-2%,0) scale(1)}to{transform:translate3d(4%,3%,0) scale(1.12)}}
@keyframes sfx-uwb{0%{transform:translate3d(0,0,0) scale(.5);opacity:0}
 14%{opacity:.9}72%{opacity:.75}100%{transform:translate3d(18px,-${(H + 90).toFixed(0)}px,0) scale(1);opacity:0}}
@keyframes sfx-bob{from{transform:translate3d(0,-14px,0)}to{transform:translate3d(0,14px,0)}}
`);

    const water = div('sfx-uw');
    breathe(water, total, IN, OUT);
    water.append(div('sfx-caus'), div('sfx-caus sfx-caus2'));
    stage.appendChild(water);

    const top = div('sfx-uwtop');
    breathe(top, total, IN, OUT);
    stage.appendChild(top);

    /* ---- light shafts ----------------------------------------------------- */
    const rays = clamp(Math.round(W / 210), 3, 8);
    const rayBag = [];
    for (let i = 0; i < rays; i++) {
      const w = rand(38, 130);
      kf += `@keyframes sfx-ray-${i}{0%{opacity:${rand(0.2, 0.4).toFixed(2)};transform:translate3d(-${rand(8, 26).toFixed(0)}px,0,0) rotate(${rand(8, 15).toFixed(1)}deg) scaleX(.86)}` +
            `100%{opacity:${rand(0.5, 0.9).toFixed(2)};transform:translate3d(${rand(8, 26).toFixed(0)}px,0,0) rotate(${rand(14, 21).toFixed(1)}deg) scaleX(1.14)}}`;
      rayBag.push(div('sfx-ray',
        `left:${rand(-6, 100).toFixed(1)}%;width:${w.toFixed(0)}px;` +
        `animation:sfx-ray-${i} ${rand(5200, 9500).toFixed(0)}ms cubic-bezier(.45,0,.55,1) ` +
        `${rand(-4000, 0).toFixed(0)}ms infinite alternate,` +
        `sfx-fade-out ${OUT}ms cubic-bezier(0.22,1,0.36,1) ${total - OUT}ms forwards;`));
    }
    stage.append(...rayBag);

    /* ---- fish ------------------------------------------------------------- */
    const school = [];
    let fi = 0;
    layers.forEach((L, li) => {
      for (let k = 0; k < L.n; k++) {
        const c = FISH[fi % FISH.length];
        const sc = rand(L.s[0], L.s[1]);
        const dur = rand(L.sp[0], L.sp[1]);
        const dir = Math.random() < 0.5 ? 1 : -1;
        const y = rand(0.06, 0.9) * H;
        const idx = fi % 6;

        // Cross the viewport plus a fish-length of margin at each end.
        kf += `@keyframes sfx-swim-${fi}{from{transform:translate3d(${dir > 0 ? -180 : W + 180}px,0,0)}` +
              `to{transform:translate3d(${dir > 0 ? W + 180 : -180}px,0,0)}}`;

        const outer = div('sfx-swim',
          `top:${y.toFixed(0)}px;opacity:${L.op};` +
          (L.blur ? `filter:blur(${L.blur}px);` : '') +
          `animation:sfx-swim-${fi} ${dur.toFixed(0)}ms linear ${rand(-dur, 200).toFixed(0)}ms infinite,` +
          `sfx-fade-out ${OUT}ms cubic-bezier(0.22,1,0.36,1) ${total - OUT}ms forwards;`);

        // Fish do not travel in a straight line; they rise and sink as they go.
        const bob = el('span', 'sfx-bobb',
          `animation:sfx-bob ${rand(2600, 5200).toFixed(0)}ms cubic-bezier(.45,0,.55,1) ` +
          `${rand(-3000, 0).toFixed(0)}ms infinite alternate;`);

        const svg = svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" class="sfx-fish" width="${(110 * sc).toFixed(0)}" height="${(70 * sc).toFixed(0)}" viewBox="-56 -35 112 70">${fishMarkup(c, idx)}</svg>`);
        // Facing: the artwork swims +x, so flip the whole fish when it goes left.
        svg.style.transform = `scaleX(${dir})`;
        // A big fish beats its tail slowly. Scaling the beat with size is most
        // of what separates a shoal from a set of clones.
        svg.querySelector('.sfx-tail-' + idx).style.animation =
          `sfx-tail-${idx} ${(210 + sc * 210).toFixed(0)}ms cubic-bezier(.45,0,.55,1) infinite alternate`;
        svg.querySelector('.sfx-tail-' + idx).style.transformOrigin = '-27px 0px';
        svg.querySelector('.sfx-tail-' + idx).style.transformBox = 'view-box';

        bob.appendChild(svg);
        outer.appendChild(bob);
        school.push(outer);
        fi++;
      }
      void li;
    });
    stage.append(...school);

    /* ---- bubbles and marine snow ------------------------------------------ */
    const bub = [];
    const nb = clamp(Math.round(W / 46), 14, 40);
    for (let i = 0; i < nb; i++) {
      const d = rand(4, 14);
      bub.push(div('sfx-uwb',
        `left:${rand(0, 100).toFixed(1)}%;top:${rand(H * 0.55, H * 1.05).toFixed(0)}px;` +
        `width:${d.toFixed(1)}px;height:${d.toFixed(1)}px;` +
        `animation:sfx-uwb ${rand(4200, 8200).toFixed(0)}ms cubic-bezier(.4,.05,.6,.95) ` +
        `${rand(0, 5000).toFixed(0)}ms infinite,` +
        `sfx-fade-out ${OUT}ms cubic-bezier(0.22,1,0.36,1) ${total - OUT}ms forwards;`));
    }
    const ns = clamp(Math.round((W * H) / 26000), 20, 70);
    for (let i = 0; i < ns; i++) {
      const d = rand(1.2, 3.4);
      bub.push(div('sfx-snow',
        `left:${rand(0, 100).toFixed(1)}%;top:${rand(0, H).toFixed(0)}px;` +
        `width:${d.toFixed(1)}px;height:${d.toFixed(1)}px;opacity:${rand(0.2, 0.6).toFixed(2)};` +
        `animation:sfx-bob ${rand(5000, 11000).toFixed(0)}ms cubic-bezier(.45,0,.55,1) ` +
        `${rand(-8000, 0).toFixed(0)}ms infinite alternate,` +
        `sfx-fade-out ${OUT}ms cubic-bezier(0.22,1,0.36,1) ${total - OUT}ms forwards;`));
    }
    stage.append(...bub);

    css(kf);                                   // one reparse, not a hundred
    return total;
  }

  /* ========================================================================
   * 4. GLITCH — backdrop-filter slices tear through the real page.
   *    Strobing is capped at 3 cycles no matter how long the user asked for;
   *    past that it settles into a non-strobing residual wash. A 30-second
   *    strobe is a photosensitivity hazard, not a longer joke.
   * ====================================================================== */
  function glitch(stage, css, ctx) {
    const CYCLE = 1560;

    if (ctx.reduced) {
      // No strobe, no jitter — one soft desaturating wash for the full duration.
      const total = ctx.duration;
      css(`${R} .sfx-calm{position:absolute;inset:0;opacity:0;
 -webkit-backdrop-filter:saturate(.25) contrast(1.15) hue-rotate(20deg);
 backdrop-filter:saturate(.25) contrast(1.15) hue-rotate(20deg);}`);
      const calm = div('sfx-calm');
      breathe(calm, total, 400, 450);
      stage.appendChild(calm);
      return total;
    }

    const cycles = clamp(Math.round(ctx.duration / CYCLE), 1, 3);
    const strobe = cycles * CYCLE;
    const residual = Math.max(0, ctx.duration - strobe);
    const total = strobe + residual;

    css(`
${R} .sfx-gs{position:absolute;left:-8%;width:116%;opacity:0;
 box-shadow:inset 0 3px 0 rgba(255,0,72,.6),inset 0 -3px 0 rgba(0,246,232,.55);}
${R} .sfx-gs-a{-webkit-backdrop-filter:invert(1) hue-rotate(95deg) saturate(1.7);backdrop-filter:invert(1) hue-rotate(95deg) saturate(1.7);}
${R} .sfx-gs-b{-webkit-backdrop-filter:hue-rotate(190deg) contrast(1.7) saturate(2.4);backdrop-filter:hue-rotate(190deg) contrast(1.7) saturate(2.4);}
${R} .sfx-gs-c{-webkit-backdrop-filter:grayscale(1) contrast(2.4) brightness(1.3);backdrop-filter:grayscale(1) contrast(2.4) brightness(1.3);}
${R} .sfx-ginv{position:absolute;inset:0;opacity:0;
 -webkit-backdrop-filter:invert(1) hue-rotate(40deg);backdrop-filter:invert(1) hue-rotate(40deg);
 animation:sfx-ginv ${CYCLE}ms steps(1,end) ${cycles} both;}
${R} .sfx-scan{position:absolute;inset:-10px;opacity:.5;
 background:repeating-linear-gradient(180deg,rgba(0,0,0,.26) 0 1px,rgba(0,0,0,0) 1px 3px);
 animation:sfx-scan 420ms steps(6,end) infinite;
 transition:opacity 320ms cubic-bezier(0.22,1,0.36,1);}
${R} .sfx-band{position:absolute;left:0;width:100%;height:96px;
 background:linear-gradient(180deg,rgba(255,255,255,0),rgba(255,255,255,.16) 45%,rgba(255,255,255,.3) 52%,rgba(255,255,255,0));
 animation:sfx-band 760ms cubic-bezier(.4,0,.6,1) ${cycles * 2} both;}
${R} .sfx-flash{position:absolute;inset:0;background:#fff;opacity:0;animation:sfx-flash ${CYCLE}ms steps(1,end) ${cycles} both;}
${R} .sfx-noise{position:absolute;left:-50%;top:-50%;width:200%;height:200%;opacity:.14;
 animation:sfx-noise 160ms steps(1,end) infinite;}
${R} .sfx-resid{position:absolute;inset:0;opacity:0;
 -webkit-backdrop-filter:contrast(1.22) saturate(.3) hue-rotate(-12deg);
 backdrop-filter:contrast(1.22) saturate(.3) hue-rotate(-12deg);}
@keyframes sfx-scan{from{transform:translate3d(0,0,0)}to{transform:translate3d(0,6px,0)}}
@keyframes sfx-band{from{transform:translate3d(0,-110%,0)}to{transform:translate3d(0,${window.innerHeight + 40}px,0)}}
@keyframes sfx-flash{0%{opacity:.85}5%{opacity:0}46%{opacity:.55}50%{opacity:0}82%{opacity:.3}85%{opacity:0}100%{opacity:0}}
@keyframes sfx-noise{0%{transform:translate3d(0,0,0)}25%{transform:translate3d(-7%,4%,0)}50%{transform:translate3d(5%,-6%,0)}75%{transform:translate3d(-3%,-2%,0)}100%{transform:translate3d(6%,3%,0)}}
@keyframes sfx-ginv{0%{opacity:0}5%{opacity:1}8%{opacity:0}43%{opacity:1}46%{opacity:0}79%{opacity:1}82%{opacity:0}100%{opacity:0}}
@keyframes sfx-jit{0%,100%{transform:translate3d(0,0,0)}9%{transform:translate3d(-5px,2px,0)}17%{transform:translate3d(0,0,0)}31%{transform:translate3d(7px,-3px,0)}38%{transform:translate3d(0,0,0)}56%{transform:translate3d(-9px,0,0)}62%{transform:translate3d(0,0,0)}79%{transform:translate3d(4px,3px,0)}86%{transform:translate3d(0,0,0)}}
@keyframes sfx-gsA{0%{opacity:0;transform:translate3d(0,0,0)}3%{opacity:1;transform:translate3d(-34px,0,0)}13%{opacity:0;transform:translate3d(0,0,0)}22%{opacity:1;transform:translate3d(22px,0,0)}33%{opacity:0;transform:translate3d(0,0,0)}46%{opacity:1;transform:translate3d(-42px,0,0)}57%{opacity:0;transform:translate3d(0,0,0)}68%{opacity:1;transform:translate3d(15px,0,0)}78%{opacity:0;transform:translate3d(0,0,0)}88%{opacity:1;transform:translate3d(-11px,0,0)}96%{opacity:0}100%{opacity:0}}
@keyframes sfx-gsB{0%{opacity:0;transform:translate3d(0,0,0)}9%{opacity:1;transform:translate3d(29px,0,0)}20%{opacity:0;transform:translate3d(0,0,0)}34%{opacity:1;transform:translate3d(-19px,0,0)}45%{opacity:0;transform:translate3d(0,0,0)}58%{opacity:1;transform:translate3d(38px,0,0)}70%{opacity:0;transform:translate3d(0,0,0)}81%{opacity:1;transform:translate3d(-25px,0,0)}92%{opacity:0}100%{opacity:0}}
`);

    // Churning grain, drawn as a live SVG filter — no data: URI, no CSP surprises.
    stage.appendChild(svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" class="sfx-noise">
      <filter id="sfxN"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="7"/></filter>
      <rect width="100%" height="100%" filter="url(#sfxN)"/></svg>`));

    const kinds = ['sfx-gs-a', 'sfx-gs-b', 'sfx-gs-c'];
    for (let i = 0; i < 13; i++) {
      // Negative delays desync the slices without needing 13 keyframe sets.
      stage.appendChild(div('sfx-gs ' + pick(kinds),
        `top:${rand(-2, 92)}%;height:${rand(3.5, 11)}%;` +
        `animation:${i % 2 ? 'sfx-gsB' : 'sfx-gsA'} ${CYCLE}ms steps(1,end) ${-rint(0, CYCLE)}ms ${cycles} both;`));
    }

    const scan = div('sfx-scan');
    stage.append(scan, div('sfx-ginv'), div('sfx-band'), div('sfx-flash'));
    stage.style.animation = `sfx-jit ${CYCLE}ms steps(1,end) ${cycles} both`;

    if (residual > 0) {
      // Strobe is over; a dead-signal wash carries the rest of the time.
      const resid = div('sfx-resid');
      resid.style.animation =
        `sfx-fade-in 500ms cubic-bezier(0.22,1,0.36,1) ${Math.max(0, strobe - 250)}ms both,` +
        `sfx-fade-out 500ms cubic-bezier(0.22,1,0.36,1) ${total - 500}ms forwards`;
      stage.appendChild(resid);
      later(() => {
        // hard-stop every strobing layer, keep only the quiet ones
        stage.querySelectorAll('.sfx-gs, .sfx-ginv, .sfx-band, .sfx-flash').forEach((n) => n.remove());
        scan.style.opacity = '.3';
      }, strobe);
      later(() => { scan.style.opacity = '0'; }, total - 340);
    } else {
      later(() => { scan.style.opacity = '0'; }, total - 340);
    }
    return total;
  }

  /* ========================================================================
   * 5. CONFETTI — four shapes, three nested transforms per piece
   *    (fall / sway / spin) so nothing ever moves in lockstep. A longer
   *    duration widens the emission window rather than slowing the fall.
   * ====================================================================== */
  function confetti(stage, css, ctx) {
    const COLORS = ['#E9F551', '#FF4D6D', '#3FD8E8', '#FFA23A', '#A66BFF', '#FFF3DC'];
    const FALL_MAX = 4300, FADE = 680;
    const total = ctx.duration;
    const emit = Math.max(400, total - FALL_MAX);            // release window
    const count = clamp(Math.round(150 * (total / 5300)), 80, 420);

    css(`
${R} .sfx-c{position:absolute;top:-6%;will-change:transform;}
${R} .sfx-cs{display:block;}
${R} .sfx-ci{display:block;box-shadow:0 0 0 .5px rgba(0,0,0,.14);}
${R} .sfx-sq{border-radius:1px;}
${R} .sfx-strip{border-radius:2px;}
${R} .sfx-dot{border-radius:50%;}
${R} .sfx-tri{clip-path:polygon(50% 0,100% 100%,0 100%);box-shadow:none;}
@keyframes sfx-fall{from{transform:translate3d(0,0,0)}to{transform:translate3d(0,${window.innerHeight + 90}px,0)}}
@keyframes sfx-csway{from{transform:translate3d(-26px,0,0)}to{transform:translate3d(26px,0,0)}}
`);

    // Six tumble axes, reused across pieces so the generated CSS stays small.
    for (let a = 0; a < 6; a++) {
      const ax = rand(-1, 1).toFixed(2), ay = rand(0.3, 1).toFixed(2), az = rand(-1, 1).toFixed(2);
      css(`@keyframes sfx-spin-${a}{from{transform:rotate3d(${ax},${ay},${az},0deg)}to{transform:rotate3d(${ax},${ay},${az},360deg)}}`);
    }

    for (let i = 0; i < count; i++) {
      const color = pick(COLORS);
      const shape = pick(['sq', 'sq', 'strip', 'dot', 'tri', 'strip']);
      const dur = rand(2600, FALL_MAX);
      const delay = rand(0, emit);

      // gravity: a touch of acceleration up front, then terminal velocity
      const outer = div('sfx-c',
        `left:${rand(-4, 104)}%;animation:sfx-fall ${dur}ms cubic-bezier(.3,.16,.52,.92) ${delay}ms forwards;`);

      const sway = el('span', 'sfx-cs',
        `transform:translate3d(${rand(-26, 26)}px,0,0);` +
        `animation:sfx-csway ${rand(1100, 2200)}ms cubic-bezier(.45,0,.55,1) ${delay}ms infinite alternate;`);

      const w = shape === 'strip' ? rand(3, 4.5) : shape === 'dot' ? rand(6, 9) : rand(7, 11);
      const h = shape === 'strip' ? rand(13, 20) : shape === 'dot' ? w : rand(8, 13);
      const inner = el('span', 'sfx-ci sfx-' + shape,
        `width:${w}px;height:${h}px;background:${color};` +
        `animation:sfx-spin-${i % 6} ${rand(520, 1500)}ms linear ${delay}ms infinite;`);

      sway.appendChild(inner);
      outer.appendChild(sway);
      stage.appendChild(outer);
    }

    stage.style.animation =
      `sfx-fade-out ${FADE}ms cubic-bezier(0.22,1,0.36,1) ${total - FADE}ms forwards`;
    return total;
  }

  /* ========================================================================
   * 6. SCREEN CRACK — a dropped phone, not a drawing of a star.
   *
   *    The thing that makes a cracked screen recognisable is that it is TWO
   *    damaged layers, and the second one is the one people actually name:
   *
   *    GLASS. A fracture is a sub-micron air gap between two rough faces, so
   *    it is an optical element, not a pen stroke. On a dark page it glints
   *    silver-white and is the brightest thing on screen; on a bright page it
   *    scatters and traps light and reads mid-grey, with a thin specular
   *    highlight along one flank only. Either way it is a sliver with two
   *    edges, 1-2px of core with a flanking edge, never a flat black line.
   *    Alpha varies along its length, it tapers to nothing where it arrests,
   *    and it stops dead wherever it meets a crack that got there first.
   *
   *    PANEL. Underneath, the display itself is broken: liquid crystal bleeds
   *    out of the ruptured cells as an opaque black amoeba with a violet and
   *    amber fringe, driver damage puts hard saturated colour bands across the
   *    whole screen that completely ignore the crack geometry, pressure leaves
   *    rainbow mura, and the backlight blows out around the impact. This layer
   *    is opaque and does not care what is behind it.
   *
   *    Two more things real screens do that fake ones don't: modern panels are
   *    fully laminated to the cover glass with ~0.2mm of adhesive, so the
   *    fragments CANNOT move — offsetting shards of content reads as a broken
   *    mirror, not a broken phone. And the density is graded: a pulverised
   *    core, a ring of tiny fragments around it, then cells that grow with
   *    distance until the last cracks are lone hairlines.
   * ====================================================================== */
  function crack(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const uid = 'sfx' + ((Math.random() * 1e9) | 0).toString(36);

    // Real phones break on a corner far more often than face-on, and a corner
    // origin gives a sweeping quarter-fan rather than a symmetric poster star.
    const corner = Math.random() < 0.68;
    let ox, oy, spanLo, spanHi;
    if (corner) {
      const cx = Math.random() < 0.5 ? 0 : 1, cy = Math.random() < 0.5 ? 0 : 1;
      ox = cx ? W - rand(-30, 70) : rand(-30, 70);
      oy = cy ? H - rand(-30, 70) : rand(-30, 70);
      const mid = Math.atan2(H / 2 - oy, W / 2 - ox);
      spanLo = mid - 1.15; spanHi = mid + 1.15;
    } else {
      ox = rand(0.22, 0.78) * W; oy = rand(0.2, 0.72) * H;
      spanLo = 0; spanHi = Math.PI * 2;
    }
    const reach = Math.max(
      Math.hypot(ox, oy), Math.hypot(W - ox, oy),
      Math.hypot(ox, H - oy), Math.hypot(W - ox, H - oy)
    );

    const light = pageLuminance() > 0.5;
    // On a bright page the crack scatters away more light than the surround
    // returns, so it reads grey; on a dark page the facets are the only thing
    // reflecting and it goes silver. Same geometry, inverted optics.
    const core = light ? 'rgba(74,80,90,.88)' : 'rgba(236,244,252,.8)';
    const flank = light ? 'rgba(255,255,255,.85)' : 'rgba(6,9,14,.75)';

    const RACE = 210, RING_AT = RACE * 0.42, RING_MS = 170;
    const BLEED_AT = RACE + 120, BLEED_MS = 900;
    const INTRO = BLEED_AT + BLEED_MS;
    const OUTRO = 640;
    const HOLD = ctx.hold(INTRO, OUTRO, 900);
    const total = INTRO + HOLD + OUTRO;

    const rc = rand(11, 19);                          // pulverised core radius

    /* ---- radials ---------------------------------------------------------
       Heavy jitter on the gaps. Evenly spaced spokes read as a starburst. */
    const n = rint(7, 14);
    const gap = (spanHi - spanLo) / n;
    const spokes = [];
    for (let i = 0; i < n; i++) {
      const a0 = spanLo + (i + 0.5) * gap + rand(-0.38, 0.38) * gap;
      const len = reach * rand(0.42, 1.05);
      let a = a0, r = rc;
      const pts = [[ox + Math.cos(a) * rc, oy + Math.sin(a) * rc]];
      while (r < len) {
        a += rand(-0.115, 0.115);                     // 3-8 degrees per step
        r += reach * rand(0.022, 0.05);
        pts.push([ox + Math.cos(a) * r, oy + Math.sin(a) * r]);
      }
      spokes.push({ pts, len: Math.min(r, len), a: a0 });
    }
    spokes.sort((p, q) => p.a - q.a);

    /* ---- branches: inner third only, 30-45 degrees ------------------------ */
    const branches = [];
    spokes.forEach((sp) => {
      for (let k = 0, f = rint(1, 3); k < f; k++) {
        const at = Math.max(1, Math.round(sp.pts.length * rand(0.06, 0.3)));
        if (at >= sp.pts.length - 1) continue;
        const p = sp.pts[at], q = sp.pts[at - 1];
        let a = Math.atan2(p[1] - q[1], p[0] - q[0]) +
                (Math.random() < 0.5 ? -1 : 1) * rand(0.52, 0.79);
        let r = 0;
        const len = (sp.len - Math.hypot(p[0] - ox, p[1] - oy)) * rand(0.2, 0.46);
        const pts = [p];
        while (r < len) {
          a += rand(-0.1, 0.1);
          r += reach * rand(0.02, 0.045);
          pts.push([p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * r]);
        }
        if (pts.length > 1) branches.push({ pts, w: 1.15 });
      }
    });

    /* ---- concentric chords, at geometrically growing radii ----------------
       This is what converts a star into a shatter, and the growth is what
       gives the density gradient: tiny cells at the impact, big ones far out. */
    const radiusOf = (p) => Math.hypot(p[0] - ox, p[1] - oy);
    const atRadius = (pts, tr) => {
      let best = 1, bd = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const d = Math.abs(radiusOf(pts[i]) - tr);
        if (d < bd) { bd = d; best = i; }
      }
      return pts[best];
    };

    const rings = [];
    const radii = [];
    for (let r = rc * 1.5; r < reach * 0.98; r *= rand(1.42, 1.72)) radii.push(r);
    radii.forEach((tr, ri) => {
      const near = tr < rc * 5;                       // dense cluster near impact
      if (!near && Math.random() < 0.14) return;
      const from = rint(0, n - 1), run = near ? n + 1 : rint(3, n + 1);
      for (let k = 0; k < run; k++) {
        const A = spokes[(from + k) % n], B = spokes[(from + k + 1) % n];
        if (!A || !B || A === B) continue;
        if (radiusOf(A.pts[A.pts.length - 1]) < tr) continue;
        if (radiusOf(B.pts[B.pts.length - 1]) < tr) continue;
        const a = atRadius(A.pts, tr), b = atRadius(B.pts, tr);
        const span = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (span > reach * 0.4) continue;             // never a ruled 400px line
        const j = 0.07 * span;
        rings.push({
          pts: [a, [(a[0] + b[0]) / 2 + rand(-j, j), (a[1] + b[1]) / 2 + rand(-j, j)], b],
          w: near ? 1.2 : (ri < 4 ? 1.35 : 0.95)
        });
      }
    });

    /* ---- slivers, micro-cracks and the fragment cluster -------------------- */
    const extra = [];
    // Long thin wedges trapped between two near-parallel radials. Present in
    // every real photo and in almost no generated one.
    for (let i = 0; i < n; i++) {
      const A = spokes[i], B = spokes[(i + 1) % n];
      if (Math.abs(B.a - A.a) > gap * 1.1) continue;
      if (Math.random() < 0.45) continue;
      const r0 = rand(rc * 2, reach * 0.4), r1 = r0 * rand(1.5, 2.6);
      if (radiusOf(A.pts[A.pts.length - 1]) < r1) continue;
      extra.push({ pts: [atRadius(A.pts, r0), atRadius(B.pts, r1)], w: 0.9, op: 0.5 });
    }
    // Hair-thin secondary cracking inside the bigger outer cells.
    for (let i = 0; i < 22; i++) {
      const a = rand(spanLo, spanHi), r = rand(reach * 0.3, reach * 0.9);
      const x = ox + Math.cos(a) * r, y = oy + Math.sin(a) * r;
      if (x < -40 || x > W + 40 || y < -40 || y > H + 40) continue;
      const d = rand(0, Math.PI * 2), l = rand(18, 62);
      extra.push({
        pts: [[x, y], [x + Math.cos(d) * l, y + Math.sin(d) * l]],
        w: 0.75, op: rand(0.16, 0.34)
      });
    }
    // The pulverised ring: dozens of tiny fragments hugging the crush zone.
    for (let i = 0; i < 34; i++) {
      const a = rand(0, Math.PI * 2), b = a + rand(-0.7, 0.7);
      const r0 = rc * rand(0.9, 2.4), r1 = r0 * rand(1.3, 2.4);
      extra.push({
        pts: [[ox + Math.cos(a) * r0, oy + Math.sin(a) * r0],
              [ox + Math.cos(b) * r1, oy + Math.sin(b) * r1]],
        w: 1, op: rand(0.5, 1)
      });
    }

    /* ---- ribbons ----------------------------------------------------------
       width(s) = wmax * sqrt(s/L) behind the tip: blunt nearly all the way,
       needle-sharp only at the very end. A linear taper is the usual tell. */
    const ribbon = (pts, wmax, widthAt) => {
      const lft = [], rgt = [], cum = [0];
      for (let i = 1; i < pts.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      }
      const L = cum[cum.length - 1] || 1;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        let dx = b[0] - a[0], dy = b[1] - a[1];
        const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
        const w = Math.max(0.3, wmax * widthAt(cum[i] / L)) / 2;
        lft.push((p[0] - dy * w).toFixed(1) + ' ' + (p[1] + dx * w).toFixed(1));
        rgt.push((p[0] + dy * w).toFixed(1) + ' ' + (p[1] - dx * w).toFixed(1));
      }
      return 'M' + lft.join(' L') + ' L' + rgt.reverse().join(' L') + 'Z';
    };
    const oneTip = (t) => Math.sqrt(Math.max(0, 1 - t));
    const twoTip = (t) => Math.sqrt(Math.max(0, 1 - Math.abs(2 * t - 1) * 0.92));

    // Alpha wanders along every crack. A constant-alpha stroke is what makes
    // the whole thing look drawn rather than broken.
    const chunked = (pts, wmax, fn, base) => {
      const out = [];
      const step = Math.max(2, Math.round(pts.length / rint(2, 4)));
      let op = clamp(base * rand(0.55, 1), 0.12, 1);
      for (let i = 0; i < pts.length - 1; i += step) {
        const seg = pts.slice(i, Math.min(pts.length, i + step + 1));
        if (seg.length < 2) continue;
        const t0 = i / (pts.length - 1), t1 = Math.min(1, (i + step) / (pts.length - 1));
        out.push({ d: ribbon(seg, wmax, (u) => fn(t0 + u * (t1 - t0))), op: op.toFixed(2) });
        op = clamp(op * rand(0.62, 1.5), 0.12, 1);
      }
      return out;
    };

    const parts = [];
    spokes.forEach((sp) => parts.push(...chunked(sp.pts, 2.2, oneTip, 0.92)));
    branches.forEach((b) => parts.push(...chunked(b.pts, b.w, oneTip, 0.8)));
    rings.forEach((r) => parts.push(...chunked(r.pts, r.w, twoTip, 0.85)));
    extra.forEach((e) => parts.push({ d: ribbon(e.pts, e.w, twoTip), op: e.op.toFixed(2) }));

    const layer = (fill) =>
      parts.map((p) => `<path d="${p.d}" fill="${fill}" opacity="${p.op}"/>`).join('');

    /* ---- panel damage ------------------------------------------------------ */
    // An amoeba, not a circle: several lobes and one long finger, elongated by
    // gravity, anchored on the impact because that is where the cells ruptured.
    const blob = (() => {
      const k = rint(9, 12), rx = rand(90, 180), ry = rx * rand(0.55, 0.95);
      const P = [];
      for (let i = 0; i < k; i++) {
        const a = (i / k) * Math.PI * 2;
        const f = rand(0.72, 1) * (Math.random() < 0.18 ? rand(1.35, 1.9) : 1);  // a finger
        P.push([Math.cos(a) * rx * f, Math.sin(a) * ry * f]);
      }
      let d = `M${P[0][0].toFixed(1)} ${P[0][1].toFixed(1)}`;
      for (let i = 1; i <= k; i++) {
        const p = P[i % k], q = P[i - 1];
        d += ` Q${(q[0] * 1.06).toFixed(1)} ${(q[1] * 1.06).toFixed(1)} ` +
             `${((p[0] + q[0]) / 2).toFixed(1)} ${((p[1] + q[1]) / 2).toFixed(1)}`;
      }
      return { d: d + 'Z', rx };
    })();

    // Driver damage: hard saturated bands that run the full screen and take no
    // notice whatsoever of the crack geometry. Clustered, never evenly spaced.
    const LINE = ['#00FF66', '#FF2E9A', '#FFFFFF', '#000000', '#00E5FF', '#FF3B30'];
    const bands = [];
    for (let c = 0, clusters = rint(1, 3); c < clusters; c++) {
      let x = rand(0.06, 0.94) * W;
      for (let i = 0, m = rint(2, 4); i < m; i++) {
        bands.push({ x, w: Math.random() < 0.75 ? 1 : rint(2, 4), c: pick(LINE), o: rand(0.6, 1) });
        x += rand(3, 90) * (Math.random() < 0.5 ? -1 : 1);
      }
    }
    const hBands = [];
    for (let i = 0, m = rint(0, 2); i < m; i++) {
      hBands.push({ y: rand(0.08, 0.92) * H, h: rint(1, 5), c: pick(LINE), o: rand(0.5, 0.9) });
    }

    css(`
${R} .sfx-glass{position:absolute;inset:0;}
${R} .sfx-flank{transform:translate3d(1.1px,1.1px,0);}

/* Pulverised core: genuinely powdered glass, fully opaque, hard irregular
   edge. The only part of a fracture that hides what is behind it. */
${R} .sfx-crush{position:absolute;left:${ox.toFixed(1)}px;top:${oy.toFixed(1)}px;
 width:${(rc * 2.6).toFixed(1)}px;height:${(rc * 2.6).toFixed(1)}px;
 margin:${(-rc * 1.3).toFixed(1)}px 0 0 ${(-rc * 1.3).toFixed(1)}px;border-radius:50%;
 background:radial-gradient(circle,${light ? '#D9DEE4' : '#F2F6FA'} 0%,${light ? '#C4CBD4' : '#DCE4EE'} 46%,
   ${light ? 'rgba(186,194,204,.6)' : 'rgba(198,210,224,.5)'} 74%,transparent 100%);
 transform:scale(.2);animation:sfx-crush 240ms cubic-bezier(.12,.9,.28,1) forwards;}
${R} .sfx-frost{position:absolute;left:${ox.toFixed(1)}px;top:${oy.toFixed(1)}px;
 width:${(rc * 9).toFixed(1)}px;height:${(rc * 9).toFixed(1)}px;
 margin:${(-rc * 4.5).toFixed(1)}px 0 0 ${(-rc * 4.5).toFixed(1)}px;border-radius:50%;
 background:radial-gradient(circle,transparent 22%,${light ? 'rgba(255,255,255,.5)' : 'rgba(226,238,250,.34)'} 40%,
   ${light ? 'rgba(240,244,250,.2)' : 'rgba(210,226,244,.12)'} 62%,transparent 84%);
 filter:blur(2.4px);
 transform:scale(.3);animation:sfx-crush 360ms cubic-bezier(.14,.88,.3,1) 20ms forwards;}
/* Broken LCDs leak their backlight around the damage. */
${R} .sfx-bloom{position:absolute;left:${ox.toFixed(1)}px;top:${oy.toFixed(1)}px;
 width:${(rc * 13).toFixed(1)}px;height:${(rc * 13).toFixed(1)}px;
 margin:${(-rc * 6.5).toFixed(1)}px 0 0 ${(-rc * 6.5).toFixed(1)}px;border-radius:50%;
 background:radial-gradient(circle,rgba(255,246,232,.34) 0%,rgba(255,244,226,.12) 36%,transparent 72%);
 mix-blend-mode:screen;opacity:0;
 animation:sfx-bloom-in 420ms cubic-bezier(.2,.9,.3,1) 90ms forwards;}

/* Liquid crystal bled out of the ruptured cells. Opaque, and it eats content. */
${R} .sfx-panel{position:absolute;inset:0;opacity:0;
 animation:sfx-bleed ${BLEED_MS}ms cubic-bezier(.16,.72,.3,1) ${BLEED_AT}ms forwards;}
${R} .sfx-ink{fill:#05060B;}
${R} .sfx-ink-v{fill:none;stroke:${light ? '#2E2145' : '#5B3F8C'};stroke-width:14;filter:blur(4px);}
${R} .sfx-ink-a{fill:none;stroke:${light ? '#3A2A18' : '#8A5C22'};stroke-width:6;filter:blur(2px);}
${R} .sfx-ink-t{fill:none;stroke:#0F5C50;stroke-width:1.6;opacity:.7;}
${R} .sfx-ink-h{position:absolute;left:${ox.toFixed(1)}px;top:${oy.toFixed(1)}px;
 width:${(blob.rx * 4).toFixed(0)}px;height:${(blob.rx * 3.2).toFixed(0)}px;
 margin:${(-blob.rx * 1.6).toFixed(0)}px 0 0 ${(-blob.rx * 2).toFixed(0)}px;border-radius:50%;
 background:radial-gradient(circle,rgba(46,20,60,.6) 0%,rgba(30,14,42,.3) 44%,transparent 74%);
 filter:blur(10px);}

/* Row/column driver damage. Saturated, opaque, and completely indifferent to
   where the glass broke — that contrast is itself part of the read. */
${R} .sfx-vb{position:absolute;top:0;bottom:0;}
${R} .sfx-hb{position:absolute;left:0;right:0;}
${R} .sfx-bandw{position:absolute;inset:0;opacity:0;
 animation:sfx-fade-in 90ms steps(1,end) ${(RACE * 0.5).toFixed(0)}ms forwards;}
/* Crystals squeezed out of alignment: a soft full-spectrum smear, no edge. */
${R} .sfx-mura{position:absolute;border-radius:50%;mix-blend-mode:overlay;opacity:0;
 background:conic-gradient(from 0deg,#FF4D4D,#FFD24D,#4DFF88,#4DD2FF,#8A4DFF,#FF4DC4,#FF4D4D);
 filter:blur(60px);opacity:0;
 animation:sfx-mura-in 620ms cubic-bezier(.2,.9,.3,1) ${(RACE * 0.7).toFixed(0)}ms forwards;}

@keyframes sfx-mura-in{to{opacity:.26}}
@keyframes sfx-bloom-in{to{opacity:.8}}
@keyframes sfx-crush{from{transform:scale(.2)}to{transform:scale(1)}}
@keyframes sfx-race{from{r:0}to{r:${(reach * 1.14).toFixed(0)}}}
@keyframes sfx-bleed{from{opacity:0;transform:scale(.24)}to{opacity:1;transform:scale(1)}}
`);

    /* ---- panel layer goes down first, glass sits on top of it ------------- */
    const panel = div('sfx-panel');
    panel.style.transformOrigin = `${ox.toFixed(1)}px ${oy.toFixed(1)}px`;
    panel.appendChild(div('sfx-ink-h'));
    panel.appendChild(svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" class="sfx-glass" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      <g transform="translate(${ox.toFixed(1)} ${oy.toFixed(1)})">
        <path class="sfx-ink-v" d="${blob.d}"/>
        <path class="sfx-ink-a" d="${blob.d}"/>
        <path class="sfx-ink-t" d="${blob.d}"/>
        <path class="sfx-ink" d="${blob.d}"/>
      </g></svg>`));
    stage.appendChild(panel);

    const mura = div('sfx-mura',
      `left:${(ox - rand(140, 260)).toFixed(0)}px;top:${(oy - rand(90, 170)).toFixed(0)}px;` +
      `width:${rand(280, 520).toFixed(0)}px;height:${rand(150, 300).toFixed(0)}px;`);
    stage.appendChild(mura);

    const bandw = div('sfx-bandw');
    bands.forEach((b) => bandw.appendChild(div('sfx-vb',
      `left:${b.x.toFixed(0)}px;width:${b.w}px;background:${b.c};opacity:${b.o.toFixed(2)};`)));
    hBands.forEach((b) => bandw.appendChild(div('sfx-hb',
      `top:${b.y.toFixed(0)}px;height:${b.h}px;background:${b.c};opacity:${b.o.toFixed(2)};`)));
    stage.appendChild(bandw);

    stage.append(div('sfx-bloom'));

    /* ---- glass ------------------------------------------------------------
       One expanding clip circle reveals everything at once, which is what a
       fracture front actually does and is one animated element rather than
       several hundred dash walks. */
    const svg = svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" class="sfx-glass" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs><clipPath id="${uid}r"><circle class="sfx-race" cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="0"/></clipPath></defs>
  <g clip-path="url(#${uid}r)">
    <g class="sfx-flank">${layer(flank)}</g>
    <g>${layer(core)}</g>
  </g>
</svg>`);
    stage.appendChild(svg);
    svg.querySelector('.sfx-race').style.animation =
      `sfx-race ${RACE}ms cubic-bezier(.05,.86,.28,1) forwards`;

    stage.append(div('sfx-frost'), div('sfx-crush'));
    shake(stage, 0, 560);

    /* ---- a live damaged panel flickers ------------------------------------
       Irregularly, and only occasionally. A steady pulse is exhausting on a
       real page and reads as an animation rather than as a fault. */
    if (!ctx.reduced) {
      let t = RACE + 600;
      while (t < INTRO + HOLD - 400) {
        const at = t;
        later(() => { bandw.style.opacity = '0'; }, at);
        later(() => { bandw.style.opacity = '1'; }, at + rand(40, 95));
        t += rand(1600, 5200);
      }
    }

    // The shake owns stage.transform, so fade the layers rather than the stage.
    later(() => {
      [svg, panel, bandw, mura].concat(
        Array.prototype.slice.call(stage.querySelectorAll('.sfx-crush,.sfx-frost,.sfx-bloom'))
      ).forEach((node) => {
        node.style.transition = `opacity ${OUTRO}ms cubic-bezier(0.22,1,0.36,1)`;
        node.style.opacity = '0';
      });
    }, INTRO + HOLD);

    return total;
  }

  /* ========================================================================
   * Registry + public API
   * ====================================================================== */
  const EFFECTS = { prisonBars, spiderman: webSlinger, webShooter, waterfall: flood, underwater, glitch, confetti, crack };
  const NAMES = Object.keys(EFFECTS);

  /**
   * @param {string} name  effect id, or 'random'
   * @param {{duration?: number}} [opts]  how long to stay on screen, in ms
   * @returns {boolean} whether an effect started
   */
  function play(name, opts) {
    const id = name === 'random' ? pick(NAMES) : name;
    const fx = EFFECTS[id];
    if (!fx) return false;

    const duration = clamp(Number(opts && opts.duration) || DEFAULT_MS, MIN_MS, MAX_MS);
    const ctx = {
      duration,
      reduced: prefersReduced(),
      // Sit on screen for whatever is left once the intro and outro have each
      // played at their natural speed.
      hold: (intro, outro, min = 300) => Math.max(min, duration - intro - outro),

      // Same idea, but honest when the budget is too small to hold the intro
      // and outro at natural speed: compress them proportionally rather than
      // overrunning the time the user asked for. Floor the squeeze at 0.45 —
      // below that a rise stops reading as a rise.
      fit: (intro, outro, min = 300) => {
        if (intro + outro + min <= duration) {
          return { intro, outro, hold: duration - intro - outro };
        }
        const k = Math.max(0.45, (duration - min) / (intro + outro));
        const i = Math.round(intro * k);
        const o = Math.round(outro * k);
        return { intro: i, outro: o, hold: Math.max(0, duration - i - o) };
      }
    };

    const { stage, css } = mount(duration);    // mount() destroys any live overlay first
    let ms;
    try {
      ms = fx(stage, css, ctx) || duration;
    } catch (err) {
      destroy();
      console.error('[ScreenFX]', id, err);
      return false;
    }

    later(destroy, ms + 150);                  // the plan
    later(destroy, duration + 2500);           // the backstop
    onKey = (e) => { if (e.key === 'Escape') destroy(); };
    window.addEventListener('keydown', onKey, true);
    return true;
  }

  window.__screenFX = { version: RUNTIME, play, stop: destroy, list: () => NAMES.slice() };
})();
