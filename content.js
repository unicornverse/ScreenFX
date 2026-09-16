/* ============================================================================
 * ScreenFX — injected effect runtime
 * ----------------------------------------------------------------------------
 * Injected on demand by the popup (user click) or the service worker (a
 * schedule firing). The file is idempotent: re-injecting into the same page is
 * a no-op, callers then just call window.__screenFX.play(name, opts).
 *
 * ADDING A 7TH EFFECT
 *   1. write   function myEffect(stage, css, ctx) { ...; return totalMs; }
 *   2. register it in the EFFECTS object near the bottom
 *   3. add one matching card to EFFECTS in popup.js
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
  if (window.__screenFX) return; // already injected on this page

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
  const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };

  function destroy() {
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

  /* ========================================================================
   * 2. WEB DROP — thread unspools from a top corner, a silhouette drops and
   *    swings on it through the hold, then the whole thing is reeled back up
   * ====================================================================== */
  function spiderman(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const ax = Math.round(W * 0.17);          // anchor x
    const L = Math.round(H * 0.56);           // drop length
    const DROP = 820, RETRACT = 780, SWAY = 2900;
    const HOLD = ctx.hold(DROP, RETRACT, 900);
    const RETRACT_AT = DROP + HOLD;
    const total = RETRACT_AT + RETRACT + 120;
    // keep swinging through the hold instead of settling and going dead
    const sways = Math.max(1, Math.ceil((RETRACT_AT - 430) / SWAY));

    // Silk has to read on a white page and a black one alike: pick the line
    // colour from the page, and back it with the opposite tone as a halo.
    const dark = pageLuminance() <= 0.5;
    const silk = dark ? '#F7F4EA' : '#16181F';
    const halo = dark ? 'rgba(0,0,0,.65)' : 'rgba(255,255,255,.9)';
    const rim = dark ? 'rgba(247,244,234,.6)' : 'rgba(255,255,255,.22)';

    css(`
${R} .sfx-web{position:absolute;inset:0;}
${R} .sfx-swing{transform-box:view-box;transform-origin:${ax}px 0px;}
${R} .sfx-silk{stroke:${silk};stroke-width:2.4;stroke-linecap:round;fill:none;
 filter:drop-shadow(0 0 2.5px ${halo}) drop-shadow(0 0 1px ${halo});
 stroke-dasharray:${L};stroke-dashoffset:${L};
 animation:sfx-silk-draw ${DROP}ms cubic-bezier(.22,.88,.3,1) forwards,
           sfx-silk-reel ${RETRACT}ms cubic-bezier(.55,0,.75,.4) ${RETRACT_AT}ms forwards;}
${R} .sfx-anchor{stroke:${silk};stroke-width:1.4;stroke-linecap:round;fill:none;opacity:.8;
 filter:drop-shadow(0 0 2px ${halo});
 stroke-dasharray:900;stroke-dashoffset:900;
 animation:sfx-anchor-draw 560ms cubic-bezier(.22,.88,.3,1) forwards,
           sfx-fade-out 420ms cubic-bezier(.22,1,.36,1) ${RETRACT_AT + 220}ms forwards;}
${R} .sfx-hero{transform:translate3d(0,-70px,0);
 animation:sfx-hero-drop ${DROP}ms cubic-bezier(.3,1.16,.5,1) forwards,
           sfx-hero-reel ${RETRACT}ms cubic-bezier(.55,0,.75,.4) ${RETRACT_AT}ms forwards;}
${R} .sfx-hero-body{fill:#0E0F13;stroke:${rim};stroke-width:1.3;stroke-linejoin:round;}
${R} .sfx-hero-limb{stroke:#0E0F13;stroke-width:3.4;stroke-linecap:round;stroke-linejoin:round;fill:none;}
${R} .sfx-hero-leg{stroke:#0E0F13;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;fill:none;}
@keyframes sfx-silk-draw{to{stroke-dashoffset:0}}
@keyframes sfx-silk-reel{from{stroke-dashoffset:0}to{stroke-dashoffset:${L}}}
@keyframes sfx-anchor-draw{to{stroke-dashoffset:0}}
@keyframes sfx-hero-drop{from{transform:translate3d(0,-70px,0)}to{transform:translate3d(0,${L}px,0)}}
@keyframes sfx-hero-reel{from{transform:translate3d(0,${L}px,0)}to{transform:translate3d(0,-90px,0)}}
@keyframes sfx-sway{
 0%{transform:rotate(0deg)}
 16%{transform:rotate(-7.5deg)}
 38%{transform:rotate(5.4deg)}
 58%{transform:rotate(-3.4deg)}
 76%{transform:rotate(2deg)}
 90%{transform:rotate(-.9deg)}
 100%{transform:rotate(0deg)}}
`);

    const s = svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" class="sfx-web" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <g class="sfx-swing">
    <path class="sfx-anchor" d="M${ax} 0 L${ax - 104} 16 M${ax} 0 L${ax - 76} 52 M${ax} 0 L${ax - 28} 70
      M${ax - 42} 6 L${ax - 31} 21 L${ax - 12} 28
      M${ax - 79} 12 L${ax - 58} 39 L${ax - 22} 53"/>
    <path class="sfx-silk" d="M${ax} 0 L${ax} ${L}"/>
    <g transform="translate(${ax} 0)">
      <g class="sfx-hero">
        <g transform="scale(3)">
          <path class="sfx-hero-leg" d="M0 1 L-6.5 8 L-4.2 19 M0 1 L6.5 8 L4.2 19"/>
          <path class="sfx-hero-limb" d="M-4 40 L-13 50 L-11.5 72 M4 40 L13 50 L11.5 72"/>
          <circle class="sfx-hero-body" cx="-11.5" cy="73.4" r="2.5"/>
          <circle class="sfx-hero-body" cx="11.5" cy="73.4" r="2.5"/>
          <path class="sfx-hero-body" d="M-5 19 C-5 15.4 5 15.4 5 19 L4 42 C4 45.6 -4 45.6 -4 42 Z"/>
          <circle class="sfx-hero-body" cx="0" cy="51" r="6.6"/>
        </g>
      </g>
    </g>
  </g>
</svg>`);
    stage.appendChild(s);

    // The swing rides the anchor group so the rope pivots from its top. Delayed
    // slightly so the drop reads as the primary motion.
    if (!ctx.reduced) {
      s.querySelector('.sfx-swing').style.animation =
        `sfx-sway ${SWAY}ms cubic-bezier(.45,0,.55,1) 430ms ${sways} both`;
    }
    return total;
  }

  /* ========================================================================
   * 3. FLOOD — three wave layers rise at different speeds, hold, then drain
   * ====================================================================== */
  function waterfall(stage, css, ctx) {
    // The rise and the drain together are ~3.3s at natural speed, which does not
    // fit the 3s setting — so this effect fits rather than holds, and every
    // timing below (including the per-layer stagger) scales with it.
    const NAT_RISE = 1500, NAT_DRAIN = 1250, NAT_DELAY = 300;
    const f = ctx.fit(NAT_RISE + NAT_DELAY, NAT_DRAIN + NAT_DELAY, 500);
    const k = f.intro / (NAT_RISE + NAT_DELAY);
    const RISE = Math.round(NAT_RISE * k);
    const DRAIN = Math.round(NAT_DRAIN * k);
    const LAST_DELAY = Math.round(NAT_DELAY * k);
    const DRAIN_AT = f.intro + f.hold;
    const total = DRAIN_AT + f.outro;

    // Periods divide 600 evenly so the -50% crest scroll loops seamlessly.
    const layers = [
      { period: 300, amp: 14, fill: 'rgba(14,66,104,.22)',  target: 68, speed: 9000, dir: 'normal',  delay: 0,                            foam: 0 },
      { period: 200, amp: 18, fill: 'rgba(22,118,152,.20)', target: 59, speed: 6200, dir: 'reverse', delay: Math.round(LAST_DELAY / 2),   foam: 0 },
      { period: 150, amp: 10, fill: 'rgba(52,178,190,.18)', target: 51, speed: 4100, dir: 'normal',  delay: LAST_DELAY, foam: 1 }
    ];

    const wave = (period, amp, h, closed) => {
      let d = `M0 ${amp + 2}`;
      for (let x = 0; x < 1200; x += period) {
        d += ` q ${period / 4} ${-amp} ${period / 2} 0 q ${period / 4} ${amp} ${period / 2} 0`;
      }
      // close 1.4 above the box floor: the crest then abuts the body with a
      // 0.6px overlap instead of the 2px double-alpha seam a full overlap makes
      return closed ? d + ` L1200 ${h - 1.4} L0 ${h - 1.4} Z` : d;
    };

    css(`
${R} .sfx-wl{position:absolute;left:0;top:0;width:100%;height:100%;transform:translate3d(0,100%,0);}
${R} .sfx-wbody{position:absolute;inset:0;}
${R} .sfx-wcrest{position:absolute;left:0;width:200%;display:block;}
${R} .sfx-wash{position:absolute;inset:0;opacity:0;
 background:linear-gradient(180deg,rgba(28,140,180,0) 34%,rgba(14,84,124,.22) 100%);}
${R} .sfx-caustic{position:absolute;left:-20%;right:-20%;top:0;bottom:0;opacity:.5;
 background:radial-gradient(60% 40% at 30% 70%,rgba(190,245,255,.16),transparent 70%),
            radial-gradient(45% 35% at 72% 82%,rgba(160,235,255,.12),transparent 72%);
 animation:sfx-caustic 5200ms ease-in-out infinite alternate;}
${R} .sfx-bub{position:absolute;border-radius:50%;background:rgba(232,252,255,.5);
 box-shadow:inset 0 0 0 1px rgba(255,255,255,.55),0 0 6px rgba(210,246,255,.4);}
@keyframes sfx-wave{from{transform:translate3d(0,0,0)}to{transform:translate3d(-50%,0,0)}}
@keyframes sfx-caustic{from{transform:translate3d(-3%,0,0) scale(1)}to{transform:translate3d(3%,0,0) scale(1.06)}}
@keyframes sfx-bub{0%{transform:translate3d(0,0,0) scale(.6);opacity:0}
 18%{opacity:.9}70%{opacity:.7}100%{transform:translate3d(14px,-190px,0) scale(1);opacity:0}}
`);

    const wash = div('sfx-wash');
    breathe(wash, total, 600, 700);
    stage.appendChild(wash);

    layers.forEach((cfg, i) => {
      const h = cfg.amp * 2 + 8;
      css(`
@keyframes sfx-rise-${i}{from{transform:translate3d(0,100%,0)}to{transform:translate3d(0,${100 - cfg.target}%,0)}}
@keyframes sfx-drain-${i}{from{transform:translate3d(0,${100 - cfg.target}%,0)}to{transform:translate3d(0,103%,0)}}`);

      const layer = div('sfx-wl');
      layer.style.animation =
        `sfx-rise-${i} ${RISE}ms cubic-bezier(.16,.84,.44,1) ${cfg.delay}ms forwards,` +
        `sfx-drain-${i} ${DRAIN}ms cubic-bezier(.45,0,.55,1) ${DRAIN_AT + cfg.delay}ms forwards`;

      const body = div('sfx-wbody');
      body.style.background =
        `linear-gradient(180deg,${cfg.fill} 0%,${cfg.fill} 55%,rgba(6,38,64,.16) 100%)`;
      layer.appendChild(body);

      const crest = svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" class="sfx-wcrest" viewBox="0 0 1200 ${h}" preserveAspectRatio="none" height="${h}">
        <path d="${wave(cfg.period, cfg.amp, h, true)}" fill="${cfg.fill}"/>
        ${cfg.foam ? `<path d="${wave(cfg.period, cfg.amp, h, false)}" fill="none" stroke="rgba(230,252,255,.55)" stroke-width="2.4"/>` : ''}
      </svg>`);
      crest.style.top = -(h - 2) + 'px';
      // constant scroll — linear is correct here, anything eased visibly pulses
      crest.style.animation = `sfx-wave ${cfg.speed}ms linear infinite ${cfg.dir}`;
      layer.appendChild(crest);

      if (cfg.foam) {   // caustics and bubbles only in the front layer
        layer.appendChild(div('sfx-caustic'));
        for (let b = 0; b < 14; b++) {
          const s = rand(5, 15);
          layer.appendChild(div('sfx-bub',
            `width:${s}px;height:${s}px;left:${rand(3, 96)}%;top:${rand(12, 80)}%;` +
            `animation:sfx-bub ${rand(2200, 3400)}ms cubic-bezier(.4,.05,.6,.95) ${rand(600, 2600)}ms infinite;`));
        }
      }
      stage.appendChild(layer);
    });
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
   * 6. SCREEN CRACK — jagged radial fracture from a random impact point,
   *    double-stroked so it stays readable on any page background
   * ====================================================================== */
  function crack(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const ox = rand(0.24, 0.76) * W, oy = rand(0.22, 0.7) * H;
    const reach = Math.max(
      Math.hypot(ox, oy), Math.hypot(W - ox, oy),
      Math.hypot(ox, H - oy), Math.hypot(W - ox, H - oy)
    );
    const light = pageLuminance() > 0.5;
    const inkLine = light ? '#0B0D12' : '#F7F4EA';                       // the crack
    const haloLine = light ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.6)';  // contrast backing
    const INTRO = 760, OUTRO = 640;
    const HOLD = ctx.hold(INTRO, OUTRO, 600);
    const total = INTRO + HOLD + OUTRO;

    const toD = (pts) => 'M' + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L');

    // --- geometry: short, hard-jittered steps. Long straight runs read as
    //     string art; real glass changes direction every 40-100px. ---------
    const n = rint(13, 18);
    const spokes = [];
    for (let i = 0; i < n; i++) {
      let a = (i / n) * Math.PI * 2 + rand(-0.18, 0.18);
      let r = rand(6, 14);
      const max = reach * rand(0.55, 1.05);
      const pts = [[ox, oy]];
      while (r < max) {
        a += rand(-0.3, 0.3);
        r += rand(0.05, 0.13) * reach;
        pts.push([ox + Math.cos(a) * r, oy + Math.sin(a) * r]);
      }
      spokes.push(pts);
    }

    // Every line is {d, w, delay}. Spokes are cut into three weights so the
    // stroke tapers from the impact outward — SVG has no tapered stroke.
    const lines = [];
    spokes.forEach((pts, i) => {
      const a = Math.max(1, Math.round(pts.length * 0.3));
      const b = Math.max(a + 1, Math.round(pts.length * 0.62));
      [[0, a, 2.3, 0], [a, b, 1.5, 46], [b, pts.length - 1, 0.85, 92]].forEach(([s, e, w, off]) => {
        if (e <= s) return;
        lines.push({ d: toD(pts.slice(s, e + 1)), w, delay: i * 7 + off });
      });
    });

    // Rings connect adjacent spokes at a matching *radius*, not a matching
    // point index — spokes have different lengths, and indexing by fraction
    // makes the connectors sag and read as cobweb instead of glass.
    const radiusOf = (p) => Math.hypot(p[0] - ox, p[1] - oy);
    const atRadius = (pts, tr) => {
      let best = 1, bd = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const d = Math.abs(radiusOf(pts[i]) - tr);
        if (d < bd) { bd = d; best = i; }
      }
      return pts[best];
    };

    [0.16, 0.28, 0.42, 0.58, 0.78].forEach((f, ri) => {
      if (Math.random() < 0.18) return;
      const tr = f * reach * 0.85;
      const start = rint(0, n - 1), len = rint(3, n - 1);
      for (let k = 0; k < len; k++) {
        const A = spokes[(start + k) % n], B = spokes[(start + k + 1) % n];
        // skip spokes that never reach this ring, else the connector shoots off
        if (radiusOf(A[A.length - 1]) < tr || radiusOf(B[B.length - 1]) < tr) continue;
        const a = atRadius(A, tr), b = atRadius(B, tr);
        const j = 0.16 * Math.hypot(a[0] - b[0], a[1] - b[1]);
        lines.push({
          d: toD([a, [(a[0] + b[0]) / 2 + rand(-j, j), (a[1] + b[1]) / 2 + rand(-j, j)], b]),
          w: f < 0.45 ? 1.5 : 1,
          delay: 150 + ri * 55 + k * 12
        });
      }
    });

    // splinters: the pulverized cluster right at the impact point
    for (let i = 0; i < 16; i++) {
      const a = rand(0, Math.PI * 2), b = a + rand(-0.4, 0.4);
      const r0 = rand(6, 26), r1 = r0 + rand(14, 46);
      lines.push({
        d: toD([[ox + Math.cos(a) * r0, oy + Math.sin(a) * r0],
                [ox + Math.cos(b) * r1, oy + Math.sin(b) * r1]]),
        w: 0.9,
        delay: rand(0, 90)
      });
    }

    // shards: tint the wedges nearest the impact, sells the glass read
    const shards = spokes.map((s, i) => {
      const t = spokes[(i + 1) % n];
      const p = s[Math.min(s.length - 1, 1)], q = t[Math.min(t.length - 1, 1)];
      return `M${ox.toFixed(1)} ${oy.toFixed(1)} L${p[0].toFixed(1)} ${p[1].toFixed(1)} L${q[0].toFixed(1)} ${q[1].toFixed(1)} Z`;
    });

    css(`
${R} .sfx-crack{position:absolute;inset:0;}
${R} .sfx-k{fill:none;stroke-linecap:round;stroke-linejoin:round;}
${R} .sfx-k-halo{stroke:${haloLine};}
${R} .sfx-k-ink{stroke:${inkLine};}
${R} .sfx-shard{fill:${light ? 'rgba(18,22,32,.05)' : 'rgba(255,255,255,.06)'};opacity:0;
 animation:sfx-fade-in 640ms cubic-bezier(.2,.9,.3,1) 90ms forwards;}
${R} .sfx-impact{position:absolute;border-radius:50%;left:${ox}px;top:${oy}px;width:180px;height:180px;margin:-90px 0 0 -90px;
 background:radial-gradient(circle,rgba(255,255,255,.95) 0%,rgba(255,255,255,.5) 26%,rgba(255,255,255,0) 68%);
 transform:scale(.15);animation:sfx-impact 520ms cubic-bezier(.16,.9,.3,1) forwards;}
${R} .sfx-hole{position:absolute;border-radius:50%;left:${ox}px;top:${oy}px;width:54px;height:54px;margin:-27px 0 0 -27px;
 background:radial-gradient(circle,${light ? 'rgba(10,12,18,.55)' : 'rgba(255,255,255,.5)'} 0%,transparent 70%);
 transform:scale(.2);animation:sfx-hole 420ms cubic-bezier(.2,.95,.3,1) forwards;}
@keyframes sfx-draw{to{stroke-dashoffset:0}}
@keyframes sfx-impact{from{transform:scale(.15);opacity:1}to{transform:scale(2.6);opacity:0}}
@keyframes sfx-hole{from{transform:scale(.2)}to{transform:scale(1)}}
`);

    const layer = (cls, bump) =>
      lines.map((l) => `<path class="sfx-k ${cls}" stroke-width="${(l.w + bump).toFixed(2)}" d="${l.d}"/>`).join('');

    const svg = svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" class="sfx-crack" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      <g>${shards.map((d) => `<path class="sfx-shard" d="${d}"/>`).join('')}</g>
      <g class="sfx-halos">${layer('sfx-k-halo', 1.9)}</g>
      <g class="sfx-inks">${layer('sfx-k-ink', 0)}</g>
    </svg>`);
    stage.appendChild(svg);

    // Dash-draw every line on its own clock so the fracture races outward
    // instead of appearing all at once.
    ['.sfx-halos path', '.sfx-inks path'].forEach((sel) => {
      svg.querySelectorAll(sel).forEach((p, i) => {
        const len = p.getTotalLength();
        p.style.strokeDasharray = len;
        p.style.strokeDashoffset = len;
        p.style.animation =
          `sfx-draw 300ms cubic-bezier(.08,.88,.24,1) ${lines[i].delay.toFixed(0)}ms forwards`;
      });
    });

    stage.appendChild(div('sfx-impact'));
    const hole = div('sfx-hole');
    stage.appendChild(hole);
    shake(stage, 0, 560);

    // The shake owns stage.transform, so fade the layers instead of the stage.
    later(() => {
      svg.style.transition = hole.style.transition = `opacity ${OUTRO}ms cubic-bezier(0.22,1,0.36,1)`;
      svg.style.opacity = hole.style.opacity = '0';
    }, INTRO + HOLD);

    return total;
  }

  /* ========================================================================
   * Registry + public API
   * ====================================================================== */
  const EFFECTS = { prisonBars, spiderman, waterfall, glitch, confetti, crack };
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

  window.__screenFX = { play, stop: destroy, list: () => NAMES.slice() };
})();
