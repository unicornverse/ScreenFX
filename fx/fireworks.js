/* Screenick effect module — registers into the runtime in content.js. */
(() => {
  const sfx = window.__screenick;
  if (!sfx || !sfx.kit) return;
  // eslint-disable-next-line no-unused-vars
  const { R, SPRING, SPRING_MS, rand, rint, pick, clamp, svgFrom, el, div, later, listen, loop, canvasLayer, envelope, easeOut3, easeIn2, shake, breathe, pageLuminance, gl, lockScroll, blocks } = sfx.kit;

  /* ========================================================================
   * 7. FIREWORKS: night falls on the real page and a show lights it up.
   *
   *    LIGHTING. The page is treated as a matte wall with the show in front
   *    of it. Each burst is a point light at height z off that wall, so the
   *    irradiance it lands is the exact Lambert/inverse-square result
   *        E = I * z^3 / (r^2 + z^2)^1.5        (1 straight under the burst)
   *    and the page is relit as albedo x (night ambient + sum of bursts),
   *    in linear light. The night ambient is a dim, cool moonlit grade with
   *    warm light pollution low down. At these levels vision is mesopic, so
   *    colour drains out of the page and comes back only where a burst
   *    lights it. A burst's intensity is a short break-charge flash plus the
   *    summed brightness of its burning stars, so the light dies away as the
   *    stars do and follows their centroid as they droop. Smoke from every
   *    break lingers, drifts, and is lit by later bursts. Air glow (scatter)
   *    halos each break.
   *
   *    BALLISTICS. Shells leave a mortar at v0 = g*T and break near apex when
   *    the time fuse runs out (T = 1.1-1.7s here; real fuses are 3-6s, scaled
   *    to a screen). Stars are light pellets with strong drag, so
   *        x(t) = v0/k * (1 - e^(-kt))
   *    and they open fast, hang, then fall at their terminal speed g/k. Stars
   *    burn 1.2-3.4s depending on type. Shells: peony (with pistil),
   *    chrysanthemum (spark tails), ring, gold willow (long hanging charcoal
   *    trails), crackle (stars split into popping microstars), strobe
   *    (blinking stars), and brocade (dense glittering gold). Colours are the
   *    real emitters: Sr red, Ba green, Cu blue, Na yellow, Sr+Cu purple,
   *    Mg/Ti white, charcoal gold.
   *
   *    PHOTOSENSITIVITY. Break flashes are grouped. Breaks within 60ms count
   *    as one flash, and flash groups are at least 380ms apart, so there are
   *    never more than 3 per second, including the finale. Strobe stars are
   *    tiny points, not area flashes. ctx.reduced drops the break flash,
   *    strobe, crackle and twinkle, and slows the launches.
   * ====================================================================== */

  const FRAG = `
uniform vec4 uL[8];      // light: x, y, intensity
uniform vec3 uLc[8];     // light colour
uniform vec4 uS[14];     // smoke puff: x, y, radius, density
uniform vec3 uAmbTop, uAmbBot;
uniform float uSat, uZ, uHaze;

void main() {
  vec2 p = cssPos();
  vec3 page = pageAt(p).rgb;
  vec3 alb = pow(page, vec3(2.2));
  float yv = p.y / uRes.y;
  vec3 amb = mix(uAmbTop, uAmbBot, yv * yv);

  vec3 light = vec3(0.0), haze = vec3(0.0);
  float z2 = uZ * uZ;
  for (int i = 0; i < 8; i++) {
    vec4 L = uL[i];
    if (L.z <= 0.0) continue;
    vec2 dv = p - L.xy;
    float r2 = dot(dv, dv);
    float E = uZ * z2 / pow(r2 + z2, 1.5);
    light += uLc[i] * L.z * E;
    haze += uLc[i] * L.z * exp(-sqrt(r2) / (uZ * 0.32));
  }

  float D = 0.0;
  for (int j = 0; j < 14; j++) {
    vec4 S = uS[j];
    if (S.w <= 0.0) continue;
    vec2 q = (p - S.xy) / S.z;
    D += S.w * exp(-dot(q, q));
  }
  if (D > 0.004) D *= 0.35 + 1.1 * fbm(p * 0.007 + vec2(uTime * 0.03, -uTime * 0.012));
  D = clamp(D, 0.0, 0.8);

  vec3 lit = alb * (amb + light);
  float Y = dot(lit, vec3(0.2126, 0.7152, 0.0722));
  float sat = mix(uSat, 1.0, clamp(dot(light, vec3(0.333)) * 2.2, 0.0, 1.0));
  lit = mix(vec3(Y), lit, sat);
  // smoke absorbs the page behind it and scatters burst light toward us
  vec3 smokeCol = amb * 0.3 + light * 0.6 + haze * 0.3;
  lit = lit * (1.0 - D * 0.5) + smokeCol * D * 0.32;
  lit += haze * uHaze;
  gl_FragColor = vec4(pow(max(lit, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
}
`;

  // emitters, as linear-ish display colours
  const EM = {
    red: [1.0, 0.2, 0.12], green: [0.4, 1.0, 0.38], blue: [0.3, 0.5, 1.0], yellow: [1.0, 0.8, 0.3],
    purple: [0.75, 0.35, 1.0], white: [1.0, 0.96, 0.9], gold: [1.0, 0.6, 0.22], orange: [1.0, 0.45, 0.15]
  };
  const COLOURED = ['red', 'green', 'blue', 'yellow', 'purple', 'white', 'orange'];
  const css3 = (c, w = 0.25) => `rgb(${Math.round(255 * (c[0] + (1 - c[0]) * w))},${Math.round(255 * (c[1] + (1 - c[1]) * w))},${Math.round(255 * (c[2] + (1 - c[2]) * w))})`;

  // 3-key smooth interpolation for the dusk and dawn grades
  const sm = (u) => u * u * (3 - 2 * u);
  const mix3 = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  const path3 = (k0, k1, k2, u) => (u < 0.5 ? mix3(k0, k1, sm(u * 2)) : mix3(k1, k2, sm(u * 2 - 1)));
  const DAY = [1, 1, 1];
  const SUNSET_T = [0.42, 0.36, 0.5], SUNSET_B = [0.95, 0.55, 0.32];
  const NIGHT_T = [0.034, 0.045, 0.095], NIGHT_B = [0.09, 0.068, 0.1];
  const DAWN_T = [0.35, 0.42, 0.62], DAWN_B = [0.95, 0.62, 0.42];

  function fireworks(stage, css, ctx) {
    const total = ctx.duration;
    const f = ctx.fit(1400, 1300, 800);
    const OUT_AT = f.intro + f.hold;
    const W = window.innerWidth, H = window.innerHeight;
    const S = Math.min(W, H);
    const red = ctx.reduced;

    let fx = null;
    if (ctx.snapshot) {
      try { fx = gl(stage, FRAG, { snapshot: ctx.snapshot }); } catch (err) { fx = null; }
      if (!fx) stage.textContent = '';
    }

    css(`
${R} .sfx-fw-p{mix-blend-mode:screen;}
${R} .sfx-night{position:absolute;inset:0;
 background:radial-gradient(130% 100% at 50% 110%,rgba(36,20,70,.5),rgba(5,7,22,.74) 70%);
 -webkit-backdrop-filter:brightness(.55) saturate(.6);backdrop-filter:brightness(.55) saturate(.6);}
${R} .sfx-fw-l{mix-blend-mode:screen;}
`);
    let lightLayer = null;
    if (fx) {
      lockScroll();
      fx.set('uZ', S * 0.36);
      fx.set('uHaze', red ? 0.035 : 0.055);
    } else {
      // no snapshot / no WebGL: a dimming veil over the live page, and the
      // bursts as soft additive pools on top of it
      const night = div('sfx-night');
      breathe(night, total, f.intro * 0.7, f.outro * 0.8);
      stage.appendChild(night);
      lightLayer = canvasLayer(stage, 'sfx-fw-l');
    }
    const P = canvasLayer(stage, 'sfx-fw-p');
    const g = P.g;

    /* ---- show plan: break times, then launch = break - fuse --------------- */
    const GR = 0.75 * H;                              // gravity, px/s^2
    const KINDS = red
      ? ['peony', 'peony', 'ring', 'willow', 'chrys', 'brocade']
      : ['peony', 'peony', 'peony', 'chrys', 'chrys', 'ring', 'willow', 'willow', 'crackle', 'strobe', 'brocade', 'brocade'];
    const breaks = [];
    const first = Math.max(1250, f.intro * 0.85);
    const finaleLen = clamp(f.hold * 0.35, 900, 2600);
    const lastBreak = OUT_AT + Math.min(250, f.outro * 0.2);
    const finaleAt = Math.max(first + 400, lastBreak - finaleLen);
    let tb = first;
    while (tb < finaleAt - 300) {
      breaks.push({ t: tb, n: !red && Math.random() < 0.22 ? 2 : 1 });
      tb += rand(red ? 1300 : 650, red ? 2200 : 1500);
    }
    // finale: salvos of 2-3, at least 400ms apart so flashes stay <= 3/s
    tb = Math.max(tb, finaleAt);
    while (tb <= lastBreak) {
      breaks.push({ t: tb, n: red ? 1 : rint(2, 3), finale: true });
      tb += red ? 900 : rand(400, 520);
    }
    const launches = [];
    breaks.forEach((b) => {
      for (let i = 0; i < b.n; i++) {
        const T = Math.min(rand(1.15, 1.55), Math.max(0.8, (b.t - 30) / 1000));
        launches.push({ at: b.t + rand(-25, 25) - T * 1000, T, finale: !!b.finale });
      }
    });
    launches.sort((a, b) => a.at - b.at);
    let li = 0;

    const shells = [], stars = [], sparks = [], bursts = [], puffs = [];
    const MAX_STARS = red ? 700 : 1500, MAX_SPARKS = red ? 600 : 1600;

    const addPuff = (x, y, r, d) => {
      puffs.push({ x, y, r, d, vx: rand(-6, 10), age: 0 });
      if (puffs.length > 14) {
        let w = 0;
        for (let i = 1; i < puffs.length; i++) if (puffs[i].d < puffs[w].d) w = i;
        puffs.splice(w, 1);
      }
    };

    const launch = (L) => {
      const x = rand(0.1, 0.9) * W;
      shells.push({ x, y: H + 6, px: x, py: H + 6, vx: rand(-0.04, 0.04) * W, vy: -GR * L.T, age: 0, T: L.T * 1000,
        kind: pick(KINDS), big: L.finale ? rand(0.85, 1.1) : rand(0.75, 1.15) });
    };

    const spherical = () => {
      // uniform on a sphere, projected: stars crowd toward the rim like a real shell
      const z = rand(-1, 1), a = rand(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
      return [r * Math.cos(a), r * Math.sin(a)];
    };

    const burst = (sh) => {
      const x = sh.x, y = sh.y;
      const R0 = S * rand(0.17, 0.25) * sh.big;      // final radius, px
      const kind = sh.kind;
      const col = kind === 'willow' || kind === 'brocade' ? EM.gold : EM[pick(COLOURED)];
      const pist = Math.random() < 0.5 ? EM[pick(COLOURED)] : null;
      const b = { x, y, col, age: 0, n0: 0, sum: 0, lx: x, ly: y, flash: red ? 0 : 1.5,
        base: kind === 'willow' || kind === 'brocade' ? 0.32 : 0.55, alive: 0 };
      const add = (vx, vy, s) => {
        if (stars.length >= MAX_STARS) return;
        const st = Object.assign({ x, y, px: x, py: y, vx, vy, age: 0, b, k: 3, w: 2, emit: 0, strobe: 0, crackAt: 0 }, s);
        st.core = css3(st.rgb, 0.72);
        stars.push(st);
        b.n0++;
      };
      if (kind === 'ring') {
        const n = rint(44, 60), tilt = rand(0.25, 0.95), rot = rand(0, Math.PI);
        const v = R0 * 3;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2, cx = Math.cos(a), cy = Math.sin(a) * tilt;
          add(v * (cx * Math.cos(rot) - cy * Math.sin(rot)), v * (cx * Math.sin(rot) + cy * Math.cos(rot)),
            { life: rand(1300, 1800), css: css3(col), rgb: col });
        }
      } else {
        const n = kind === 'willow' ? rint(60, 80) : kind === 'brocade' ? rint(55, 75) : rint(90, 130);
        const k = kind === 'willow' ? 3.6 : kind === 'brocade' ? 3.3 : 3;
        for (let i = 0; i < n; i++) {
          const [ux, uy] = spherical();
          const v = R0 * k * rand(0.92, 1.05);
          const s = { life: rand(1200, 1900), css: css3(col), rgb: col, k };
          if (kind === 'willow') Object.assign(s, { life: rand(2600, 3400), emit: 22, w: 1.6, css: css3(col, 0.05) });
          if (kind === 'brocade') Object.assign(s, { life: rand(2000, 2600), emit: 34, w: 1.7, glitter: true });
          if (kind === 'chrys') Object.assign(s, { emit: 16 });
          if (kind === 'crackle') Object.assign(s, { crackAt: rand(800, 1250), life: 1400 });
          if (kind === 'strobe') Object.assign(s, { strobe: rand(8, 12), phase: Math.random(), life: rand(1600, 2200), css: css3(EM.white, 0), rgb: EM.white });
          add(ux * v, uy * v, s);
        }
        if (pist && kind === 'peony') {
          for (let i = 0, m = rint(24, 34); i < m; i++) {
            const [ux, uy] = spherical();
            add(ux * R0 * 1.3, uy * R0 * 1.3, { life: rand(900, 1300), css: css3(pist), rgb: pist });
          }
        }
      }
      if (kind === 'strobe') b.col = EM.white;
      bursts.push(b);
      addPuff(x, y, R0 * 0.55, 0.22);
      addPuff(x + rand(-20, 20), (y + H) / 2, S * 0.05, 0.12);   // the rocket's own trail
      // the instant of the break: a hot core drawn straight into the trails
      if (!red) {
        const gr = g.createRadialGradient(x, y, 0, x, y, 30);
        gr.addColorStop(0, 'rgba(255,248,230,.55)');
        gr.addColorStop(1, 'rgba(255,248,230,0)');
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = 1;
        g.fillStyle = gr;
        g.fillRect(x - 30, y - 30, 60, 60);
      }
    };

    const spark = (x, y, vx, vy, life, css, w, glit) => {
      if (sparks.length >= MAX_SPARKS) return;
      sparks.push({ x, y, px: x, py: y, vx, vy, age: 0, life, css, w, k: 4, glit });
    };

    /* ---- grade over time -------------------------------------------------- */
    const grade = (t) => {
      if (t < f.intro) {
        const u = t / f.intro;
        return { top: path3(DAY, SUNSET_T, NIGHT_T, u), bot: path3(DAY, SUNSET_B, NIGHT_B, u), sat: 1 - 0.68 * sm(u), night: sm(u) };
      }
      if (t < OUT_AT) return { top: NIGHT_T, bot: NIGHT_B, sat: 0.32, night: 1 };
      const u = clamp((t - OUT_AT) / f.outro, 0, 1);
      return { top: path3(NIGHT_T, DAWN_T, DAY, u), bot: path3(NIGHT_B, DAWN_B, DAY, u), sat: 0.32 + 0.68 * sm(u), night: 1 - sm(u) };
    };

    const Lb = new Float32Array(32), Lc = new Float32Array(24), Sb = new Float32Array(56);
    let fading = false;
    let lastT = 0;

    // Strokes are batched by colour, width and a quantised alpha, so a full
    // sky is a few dozen stroke() calls rather than thousands.
    const batches = new Map();
    const seg = (css, a, w, x0, y0, x1, y1) => {
      if (a < 0.03) return;
      const q = a > 0.82 ? 1 : a > 0.6 ? 0.72 : a > 0.38 ? 0.5 : a > 0.18 ? 0.28 : 0.12;
      const key = css + q + w;
      let b = batches.get(key);
      if (!b) { b = { css, a: q, w, pts: [] }; batches.set(key, b); }
      b.pts.push(x0, y0, x1, y1);
    };
    const flush = () => {
      batches.forEach((b) => {
        if (!b.pts.length) return;
        g.globalAlpha = b.a;
        g.strokeStyle = b.css;
        g.lineWidth = b.w;
        g.beginPath();
        for (let i = 0; i < b.pts.length; i += 4) { g.moveTo(b.pts[i], b.pts[i + 1]); g.lineTo(b.pts[i + 2], b.pts[i + 3]); }
        g.stroke();
        b.pts.length = 0;
      });
      g.globalAlpha = 1;
    };

    loop((dt0, t) => {
      if (t >= total) return false;
      // Simulate on the wall clock, not the clamped frame step: if frames
      // drop, the show must still break on schedule rather than slow down.
      const dt = clamp(t - lastT, 0, 100);
      lastT = t;
      const s = dt / 1000;
      if (!fading && t >= total - 450) {
        fading = true;
        P.cv.style.transition = 'opacity 420ms cubic-bezier(0.22,1,0.36,1)';
        P.cv.style.opacity = '0';
      }

      while (li < launches.length && launches[li].at <= t) launch(launches[li++]);

      // trails: fade what is already there (destination-out keeps it transparent)
      g.globalCompositeOperation = 'destination-out';
      g.globalAlpha = 1;
      g.fillStyle = `rgba(0,0,0,${(1 - Math.pow(0.8, dt / 16.67)).toFixed(3)})`;
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'lighter';
      g.lineCap = 'round';

      // shells climbing: ballistic, with a spitting tail
      for (let i = shells.length - 1; i >= 0; i--) {
        const sh = shells[i];
        sh.age += dt;
        sh.vy += GR * s;
        sh.px = sh.x; sh.py = sh.y;
        sh.x += sh.vx * s; sh.y += sh.vy * s;
        seg('rgb(255,214,160)', 0.9, 2, sh.px, sh.py, sh.x, sh.y);
        seg('rgb(255,246,226)', 1, 1, sh.px, sh.py, sh.x, sh.y);
        if (Math.random() < 0.7) spark(sh.x, sh.y, rand(-25, 25), rand(10, 60), rand(220, 420), 'rgb(255,190,110)', 1.2, false);
        if (sh.age >= sh.T) { burst(sh); shells.splice(i, 1); }
      }

      bursts.forEach((b) => { b.sum = 0; b.lx = 0; b.ly = 0; b.alive = 0; });

      // stars: drag + gravity, exact exponential drag per step
      for (let i = stars.length - 1; i >= 0; i--) {
        const p = stars[i];
        p.age += dt;
        if (p.crackAt && p.age >= p.crackAt) {
          // crackle: the star splits into popping microstars
          for (let j = 0, m = rint(3, 5); j < m; j++) {
            const a = rand(0, Math.PI * 2), v = rand(40, 95);
            spark(p.x, p.y, p.vx * 0.3 + Math.cos(a) * v, p.vy * 0.3 + Math.sin(a) * v, rand(110, 260), 'rgb(255,250,236)', 1.6, false);
          }
          seg('rgb(255,250,236)', 1, 4, p.x - 0.5, p.y, p.x + 0.5, p.y);   // the pop
          stars.splice(i, 1);
          continue;
        }
        if (p.age >= p.life) { stars.splice(i, 1); continue; }
        const e = Math.exp(-p.k * s);
        p.vx *= e;
        p.vy = p.vy * e + GR * s * (1 - e) / (p.k * s || 1);
        p.px = p.x; p.py = p.y;
        p.x += p.vx * s; p.y += p.vy * s;
        const u = p.age / p.life;
        let a = Math.min(1, p.age / 50) * (u < 0.65 ? 1 : Math.pow((1 - u) / 0.35, 1.4));
        if (!red && u > 0.6) a *= 0.6 + 0.4 * Math.random();          // burning out
        const lum = a;
        if (p.strobe && !red) a *= ((p.age / 1000) * p.strobe + p.phase) % 1 < 0.38 ? 1 : 0.05;
        if (p.emit && Math.random() < p.emit * s) {
          if (p.glitter) spark(p.x, p.y, rand(-14, 14), rand(-6, 20), rand(500, 900), 'rgb(255,200,120)', 1.3, true);
          else spark(p.x, p.y, p.vx * 0.15 + rand(-8, 8), p.vy * 0.15 + rand(-4, 10), p.emit > 20 ? rand(700, 1150) : rand(260, 480), p.emit > 20 ? 'rgb(255,170,80)' : p.css, 1.1, false);
        }
        const b = p.b;
        b.sum += lum; b.lx += p.x * lum; b.ly += p.y * lum; b.alive++;
        // coloured envelope plus a white-hot core while the star burns hard
        seg(p.css, a, p.w + 0.6, p.px, p.py, p.x, p.y);
        if (u < 0.75) seg(p.core, a, 1, p.px, p.py, p.x, p.y);
      }

      for (let i = sparks.length - 1; i >= 0; i--) {
        const p = sparks[i];
        p.age += dt;
        if (p.age >= p.life) { sparks.splice(i, 1); continue; }
        const e = Math.exp(-p.k * s);
        p.vx *= e;
        p.vy = p.vy * e + GR * 0.5 * s;
        p.px = p.x; p.py = p.y;
        p.x += p.vx * s; p.y += p.vy * s;
        let a = 1 - p.age / p.life;
        if (p.glit && !red) a *= Math.random() < 0.5 ? 1 : 0.15;   // glitter twinkle
        seg(p.css, a * 0.85, p.w, p.px, p.py, p.x + 0.01, p.y + 0.01);
      }
      flush();

      /* ---- lights: break flash + burning stars, at the star centroid ------ */
      const lights = [];
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i];
        b.age += dt;
        const flash = b.flash * Math.exp(-b.age / 75);
        const starL = b.n0 ? b.base * Math.min(1, b.sum / (b.n0 * 0.85)) : 0;
        const I = flash + starL;
        if (b.alive === 0 && flash < 0.01) { bursts.splice(i, 1); continue; }
        const cx = b.sum > 0.01 ? b.lx / b.sum : b.x, cy = b.sum > 0.01 ? b.ly / b.sum : b.y;
        const fw = flash / Math.max(I, 1e-4);
        lights.push({ x: cx, y: cy, I, c: mix3(b.col, [1, 0.93, 0.8], fw) });
      }
      lights.sort((p, q) => q.I - p.I);

      for (let i = puffs.length - 1; i >= 0; i--) {
        const p = puffs[i];
        p.age += dt;
        p.x += p.vx * s; p.y -= 4 * s;
        p.r += 9 * s;
        p.d *= Math.exp(-s / 9);
        if (p.d < 0.01) puffs.splice(i, 1);
      }

      const gd = grade(t);
      if (fx) {
        Lb.fill(0); Lc.fill(0); Sb.fill(0);
        for (let i = 0; i < Math.min(8, lights.length); i++) {
          const L = lights[i];
          // daylight swamps them: a burst only visibly lights the page at night
          Lb.set([L.x, L.y, L.I * gd.night, 0], i * 4);
          Lc.set(L.c, i * 3);
        }
        for (let i = 0; i < puffs.length; i++) Sb.set([puffs[i].x, puffs[i].y, puffs[i].r, puffs[i].d * gd.night], i * 4);
        fx.set('uL', Lb, '4fv');
        fx.set('uLc', Lc, '3fv');
        fx.set('uS', Sb, '4fv');
        fx.set('uAmbTop', gd.top);
        fx.set('uAmbBot', gd.bot);
        fx.set('uSat', gd.sat);
        fx.draw(t / 1000);
      } else {
        const lg = lightLayer.g;
        lg.clearRect(0, 0, W, H);
        lg.globalCompositeOperation = 'lighter';
        for (let i = 0; i < Math.min(6, lights.length); i++) {
          const L = lights[i];
          const r = S * 0.7;
          const c = L.c.map((v) => Math.round(v * 255)).join(',');
          const gr = lg.createRadialGradient(L.x, L.y, 0, L.x, L.y, r);
          gr.addColorStop(0, `rgba(${c},${(0.32 * Math.min(1.2, L.I) * gd.night).toFixed(3)})`);
          gr.addColorStop(0.35, `rgba(${c},${(0.12 * Math.min(1.2, L.I) * gd.night).toFixed(3)})`);
          gr.addColorStop(1, `rgba(${c},0)`);
          lg.fillStyle = gr;
          lg.fillRect(L.x - r, L.y - r, r * 2, r * 2);
        }
      }
    });

    return total;
  }

  sfx.register('fireworks', fireworks);
})();
