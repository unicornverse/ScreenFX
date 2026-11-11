/* ============================================================================
 * ScreenFX — injected effect runtime
 * ----------------------------------------------------------------------------
 * Injected on demand by the popup (user click) or the service worker (a
 * schedule firing). Re-injecting the same build into a page is a no-op; a
 * NEWER build replaces the old one (see RUNTIME below). Callers then just call
 * window.__screenFX.play(name, opts).
 *
 * LAYOUT
 *   content.js      this file: overlay lifecycle, helpers (`kit`), WebGL, play()
 *   fx/<name>.js    one module per effect; each calls window.__screenFX.register()
 *   The injection order lives in SFX_FILES (effects.js): this file first.
 *
 * ADDING AN EFFECT
 *   1. write fx/<name>.js: function myEffect(stage, css, ctx) { ...; return totalMs; }
 *      and register it:   sfx.register('myEffect', myEffect)
 *   2. add it to SFX_EFFECTS and SFX_FILES in effects.js, icon at icons/fx/<id>.svg
 *   3. bump RUNTIME if this file changed, or open tabs keep the old core
 *
 * Effect contract
 *   stage — an empty, full-viewport, pointer-events:none div you own entirely
 *   css   — css(text) appends scoped CSS; it is thrown away with the overlay
 *   ctx   — { duration, reduced, snapshot, hold(intro, outro, min), fit(intro, outro, min) }
 *           snapshot is the visible tab as an image (device px) or null —
 *           every effect must still work without it.
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
  const RUNTIME = 4;
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
  let cleanups = [];
  let onKey = null;
  let session = 0;                   // bumped on teardown; kills in-flight rAF loops
  const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };

  /* A listener on the host page (window, document) that must not outlive the
     overlay. Everything registered here is removed by destroy(). */
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  /* A full-viewport 2D canvas at device resolution (capped at 2x — past that
     the fill rate costs more than the sharpness is worth on a 4K panel). */
  const canvasLayer = (stage, cls) => {
    const W = window.innerWidth, H = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cv = el('canvas', cls || 'sfx-cv');
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    stage.appendChild(cv);
    return { cv, g, W, H, dpr };
  };

  /* 0..1 fade envelope for canvas work: ramps up over inMs, down over the
     last outMs of total. */
  const envelope = (t, total, inMs, outMs) =>
    clamp(Math.min(t / Math.max(1, inMs), (total - t) / Math.max(1, outMs)), 0, 1);

  const easeOut3 = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const easeIn2 = (t) => clamp(t, 0, 1) * clamp(t, 0, 1);

  /* A per-frame loop tied to the overlay's lifetime. step(dt, elapsed) runs with
     dt clamped so a backgrounded tab does not resume with a 4-second timestep
     and explode the physics; returning false ends the loop early. */
  const loop = (step) => {
    const mine = session;
    let last = performance.now();
    const t0 = last;
    const tick = (now) => {
      if (mine !== session) return;              // overlay is gone, stop cold
      // the first rAF timestamp can predate performance.now() at start, so
      // floor at 0: a negative step poisons every integrator with NaN
      const raw = Math.max(0, now - last);
      const dt = Math.min(34, raw);
      last = now;
      // dt is clamped for physics stability; raw is the true frame time, for
      // anything that must stay on a wall-clock schedule at low fps.
      if (step(dt, now - t0, raw) === false) return;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  function destroy() {
    session++;
    timers.forEach(clearTimeout);
    timers = [];
    cleanups.forEach((fn) => { try { fn(); } catch (err) { /* page already gone */ } });
    cleanups = [];
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

  function mount() {
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
    const x = el('span', 'sfx-x');
    x.textContent = '×';
    btn.append(ring, x);
    btn.addEventListener('click', destroy);
    root.appendChild(btn);

    (document.body || document.documentElement).appendChild(root);
    later(() => btn.classList.add('sfx-in'), 420);
    // The ring is started by play() once the effect has reported its real
    // length, so the countdown always matches what is actually on screen.
    const startRing = (ms) => {
      // progress is constant motion — linear is correct here, a curve would lie
      ring.querySelector('.sfx-ring-fg').style.animation = `sfx-ring-drain ${ms}ms linear forwards`;
    };
    return { root, stage, css, startRing };
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
   * Page snapshot + WebGL
   * ------------------------------------------------------------------------
   * The caller (popup / service worker) grabs the visible tab with
   * chrome.tabs.captureVisibleTab and passes it in as opts.snapshot. That is
   * what lets an effect act on the real site: bend it, refract it, light it,
   * swallow it — without touching a single node of the host page. While an
   * effect that redraws the page is up, scrolling is locked so the snapshot
   * stays registered with what is underneath.
   * ====================================================================== */

  /* Shared GLSL: hashing, value noise, fbm, voronoi. Prepended to every
     fragment shader built with gl(). */
  const GLSL_LIB = `
precision highp float;
varying vec2 vUv;                 // 0..1, origin bottom-left
uniform sampler2D uPage;          // the snapshot (or 1x1 transparent)
uniform float uHasPage;           // 1 when a real snapshot is bound
uniform vec2 uRes;                // viewport, CSS px
uniform float uTime;              // seconds since the effect started
uniform float uDpr;
// CSS-pixel position, origin top-left (matches clientX/Y and getBoundingClientRect)
vec2 cssPos() { return vec2(vUv.x, 1.0 - vUv.y) * uRes; }
// sample the page at a CSS-pixel position (top-left origin)
vec4 pageAt(vec2 p) { return texture2D(uPage, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)); }
vec4 pageUv(vec2 uv) { return texture2D(uPage, uv); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.02 + 17.1; a *= 0.5; } return s; }
// voronoi: x = distance to nearest cell point, y = distance to the cell edge, zw = cell id
vec4 voronoi(vec2 p) { vec2 n = floor(p), f = fract(p), mg, mr; float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 g = vec2(float(i), float(j)); vec2 o = hash22(n + g); vec2 r = g + o - f; float d = dot(r, r); if (d < md) { md = d; mr = r; mg = g; } }
  float ed = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) { vec2 g = mg + vec2(float(i), float(j)); vec2 o = hash22(n + g); vec2 r = g + o - f; if (dot(mr - r, mr - r) > 0.00001) ed = min(ed, dot(0.5 * (mr + r), normalize(r - mr))); }
  return vec4(sqrt(md), ed, n + mg); }
`;

  /**
   * A full-viewport WebGL canvas running one fragment shader over the page
   * snapshot. `frag` is the body (must define void main()); GLSL_LIB is
   * prepended. Returns null when WebGL is unavailable — callers fall back.
   *
   *   const fx = gl(stage, frag, { snapshot: ctx.snapshot, scale?, maxPixels? });
   *   fx.set('uCenter', [x, y]); fx.texture('uExtra', canvas, 1); fx.draw(tSeconds);
   */
  function gl(stage, frag, opts = {}) {
    const W = window.innerWidth, H = window.innerHeight;
    // Full-screen shaders are fill-rate bound. Cap the backing store at
    // ~4.2M pixels (a 1080p dpr-2 screen renders at ~1.4x) unless the
    // effect asks otherwise: opts.scale multiplies, opts.maxPixels caps.
    let dpr = Math.min(2, window.devicePixelRatio || 1) * (opts.scale || 1);
    const cap = opts.maxPixels || 4.2e6;
    if (W * H * dpr * dpr > cap) dpr = Math.sqrt(cap / (W * H));
    const cv = el('canvas', opts.cls || 'sfx-gl');
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;';
    const g = cv.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false });
    if (!g) return null;

    const compile = (type, text) => {
      const sh = g.createShader(type);
      g.shaderSource(sh, text);
      g.compileShader(sh);
      if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
        const log = g.getShaderInfoLog(sh);
        g.deleteShader(sh);
        throw new Error('[ScreenFX] shader: ' + log);
      }
      return sh;
    };
    const prog = g.createProgram();
    g.attachShader(prog, compile(g.VERTEX_SHADER,
      'attribute vec2 p; varying vec2 vUv; void main(){ vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }'));
    g.attachShader(prog, compile(g.FRAGMENT_SHADER, GLSL_LIB + frag));
    g.linkProgram(prog);
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error('[ScreenFX] link: ' + g.getProgramInfoLog(prog));
    g.useProgram(prog);

    const buf = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, buf);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), g.STATIC_DRAW);
    const loc = g.getAttribLocation(prog, 'p');
    g.enableVertexAttribArray(loc);
    g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);

    const uni = {};
    const U = (name) => (name in uni ? uni[name] : (uni[name] = g.getUniformLocation(prog, name)));

    const units = {};
    /** Bind an image/canvas/video as sampler `name` on texture unit `unit`
     *  (0 is the page). Call again with the same name to re-upload. */
    const texture = (name, source, unit, { repeat = false, linear = true } = {}) => {
      let t = units[name] && units[name].tex;
      if (!t) { t = g.createTexture(); units[name] = { tex: t, unit }; }
      g.activeTexture(g.TEXTURE0 + unit);
      g.bindTexture(g.TEXTURE_2D, t);
      g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, true);
      if (source) g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, source);
      else g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, 1, 1, 0, g.RGBA, g.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      const f = linear ? g.LINEAR : g.NEAREST;
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, f);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, f);
      // WebGL1 only repeats power-of-two textures; clamp everything else
      const wrap = repeat ? g.REPEAT : g.CLAMP_TO_EDGE;
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, wrap);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, wrap);
      g.uniform1i(U(name), unit);
    };
    texture('uPage', opts.snapshot || null, 0);

    /** set('uX', 1) / set('uV', [x, y]) / set('uArr', float32, '3fv') */
    const set = (name, v, kind) => {
      const l = U(name);
      if (l === null) return;
      if (kind) { g['uniform' + kind](l, v); return; }
      if (typeof v === 'number') g.uniform1f(l, v);
      else if (v.length === 2) g.uniform2f(l, v[0], v[1]);
      else if (v.length === 3) g.uniform3f(l, v[0], v[1], v[2]);
      else if (v.length === 4) g.uniform4f(l, v[0], v[1], v[2], v[3]);
    };
    set('uRes', [W, H]);
    set('uDpr', dpr);
    set('uHasPage', opts.snapshot ? 1 : 0);

    const draw = (tSec) => {
      if (tSec !== undefined) set('uTime', tSec);
      g.viewport(0, 0, cv.width, cv.height);
      g.drawArrays(g.TRIANGLES, 0, 6);
    };

    stage.appendChild(cv);
    cleanups.push(() => {
      const lose = g.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    });
    return { canvas: cv, gl: g, set, draw, texture, W, H, dpr };
  }

  /* Freeze scrolling for the life of the overlay, without touching the page's
     own styles (overflow:hidden would remove the scrollbar and reflow it). */
  function lockScroll() {
    const stop = (e) => { if (e.cancelable) e.preventDefault(); };
    const keys = (e) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key) &&
          !(e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)))) stop(e);
    };
    listen(window, 'wheel', stop, { passive: false, capture: true });
    listen(window, 'touchmove', stop, { passive: false, capture: true });
    listen(window, 'keydown', keys, { capture: true });
  }

  /* The visible layout, as rectangles: what an effect can land on, crawl
     along, or treat as solid. Only real, visible content boxes in the
     viewport; capped so a huge page cannot stall a frame. */
  function blocks({ max = 160, minSize = 24 } = {}) {
    const W = window.innerWidth, H = window.innerHeight;
    const out = [];
    const sel = 'img,video,canvas,svg,picture,button,input,textarea,select,h1,h2,h3,h4,p,li,pre,blockquote,table,figure,article,section,aside,nav,header,footer,a[href]';
    const nodes = document.querySelectorAll(sel);
    for (let i = 0; i < nodes.length && out.length < max; i++) {
      const n = nodes[i];
      if (n.closest('#' + ROOT_ID)) continue;
      const r = n.getBoundingClientRect();
      if (r.width < minSize || r.height < 8) continue;
      if (r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue;
      const cs = getComputedStyle(n);
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < 0.1) continue;
      out.push({ x: r.left, y: r.top, w: r.width, h: r.height, tag: n.tagName.toLowerCase() });
    }
    return out;
  }

  /* Decode the snapshot handed in by the caller: an <img> at device
     resolution, or null. */
  async function decodeSnapshot(src) {
    if (!src || typeof src !== 'string') return null;
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
      await img.decode();
      return img;
    } catch (err) {
      console.warn('[ScreenFX] snapshot unusable:', err);
      return null;
    }
  }

  /* ========================================================================
   * Registry + public API
   * ====================================================================== */
  const EFFECTS = {};
  const register = (id, fn) => { EFFECTS[id] = fn; };

  /**
   * @param {string} name  effect id, or 'random'
   * @param {{duration?: number, pool?: string[], snapshot?: string}} [opts]
   *        duration — how long to stay on screen, in ms
   *        pool     — ids 'random' may choose from (defaults to all)
   *        snapshot — data URL of the visible tab (captureVisibleTab)
   * @returns {Promise<boolean>} whether an effect started
   */
  async function play(name, opts) {
    const names = Object.keys(EFFECTS);
    let id = name;
    if (name === 'random') {
      const pool = (opts && Array.isArray(opts.pool) ? opts.pool : names).filter((n) => EFFECTS[n]);
      id = pick(pool.length ? pool : names);
    }
    const fx = EFFECTS[id];
    if (!fx) return false;

    const duration = clamp(Number(opts && opts.duration) || DEFAULT_MS, MIN_MS, MAX_MS);
    destroy();
    const snapshot = await decodeSnapshot(opts && opts.snapshot);

    /* Timing contract: intro and outro play at their natural speed and the
       hold absorbs the rest, so the total lands exactly on `duration`. When
       the budget is too small for both at natural speed they compress
       proportionally instead of overrunning. */
    const fit = (intro, outro, min = 300) => {
      if (intro + outro + min <= duration) {
        return { intro, outro, hold: duration - intro - outro, k: 1 };
      }
      const k = Math.max(0.3, (duration - min) / (intro + outro));
      const i = Math.round(intro * k);
      const o = Math.round(outro * k);
      return { intro: i, outro: o, hold: Math.max(0, duration - i - o), k };
    };
    const ctx = {
      id,
      duration,
      reduced: prefersReduced(),
      snapshot,                                // HTMLImageElement at device px, or null
      fit,
      hold: (intro, outro, min = 300) => fit(intro, outro, min).hold
    };

    const { stage, css, startRing } = mount();
    let ms;
    try {
      ms = fx(stage, css, ctx) || duration;
    } catch (err) {
      destroy();
      console.error('[ScreenFX]', id, err);
      return false;
    }

    startRing(ms);
    later(destroy, ms + 120);                        // the plan
    later(destroy, Math.max(ms, duration) + 2500);   // the backstop
    onKey = (e) => { if (e.key === 'Escape') destroy(); };
    window.addEventListener('keydown', onKey, true);
    return true;
  }

  const kit = {
    R, SPRING, SPRING_MS, rand, rint, pick, clamp, svgFrom, el, div, later, listen, loop,
    canvasLayer, envelope, easeOut3, easeIn2, shake, breathe, pageLuminance, gl, lockScroll, blocks
  };

  window.__screenFX = {
    version: RUNTIME, play, stop: destroy, register, kit,
    list: () => Object.keys(EFFECTS),
    isPlaying: () => !!document.getElementById(ROOT_ID)
  };
})();
