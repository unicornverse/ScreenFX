/* Screenick effect module — registers into the runtime in content.js. */
(() => {
  const sfx = window.__screenick;
  if (!sfx || !sfx.kit) return;
  const { R, rand, clamp, div, el, loop, listen, canvasLayer, gl, lockScroll } = sfx.kit;

  /* ========================================================================
   * UNDERWATER — the space between the glass and the page floods. The
   * waterline rises from the bottom, the page is seen through moving water
   * (as the back wall of a tank lit from above), then it drains away.
   *
   * Physical model:
   *  Surface   sum of 8 deep-water sine waves, h = Σ Aᵢ sin(kᵢ·x − ωᵢt + φᵢ),
   *            dispersion ωᵢ = √(g kᵢ) (g scaled to screen px), steepness Aᵢkᵢ
   *            ≈ 0.035. Gradient and Hessian are analytic. The pointer stirs
   *            the water: each stroke launches a radial ring wave whose slope
   *            is added to the surface gradient.
   *  Refraction  n = normalize(−∇h, 1); Snell via refract(view, n, 1/1.333);
   *            the page is sampled at x + d·R.xy/|R.z|, so text wobbles.
   *  Caustics  light refracted at the surface lands at x' = x − c∇h with
   *            c = D(1 − 1/n). Irradiance is the inverse area ratio of that
   *            map, I = 1/|det J|, det J = (1 − c hₓₓ)(1 − c h_yy) − c²hₓᵧ²
   *            (Jacobian caustics). n differs per channel → faint dispersion.
   *            Caustics land on the fish too, not just the page.
   *  Light     downwelling irradiance E(d) = E₀·exp(−K·d) with K ≈ Jerlov
   *            oceanic IB (red goes first, then green), plus a grey loss for
   *            scattering out of the beam. The view path glass→page adds its
   *            own Beer–Lambert transmittance and in-scattered veiling light.
   *  Depth     three fish layers sit at different distances from the glass:
   *            the far one is rendered at low resolution (forward scattering
   *            blurs it), hazed more and refracted more. Fish cast soft
   *            shadows down onto the page.
   *  Waterline seen edge-on: a meniscus (thin magnifying film above the
   *            line), the bright edge, and below it the underside of the
   *            surface acting as a mirror (total internal reflection, θ >
   *            48.6°), fading with Fresnel.
   *  Bubbles   air spheres in water are diverging lenses: a minified upright
   *            image inside, a total-internal-reflection rim where the
   *            incidence exceeds the critical angle. Rise at terminal
   *            velocity, zig-zag path instability, grow on the way up (Boyle).
   *  Fish      carangiform swimmers: lateral body wave h(s,t) = a(s)·
   *            sin(2π(s/λ − f t)), a(s) = L(0.02 − 0.08s + 0.16s²) (Videler),
   *            speed U ≈ 0.7·L·f. A school keeps loose formation slots; fish
   *            startle away from the pointer (C-start burst, faster tail beat).
   *  Draining  Torricelli: the level falls as h(t) = h₀(1 − t/T)².
   *
   * Performance: one full-screen pass, rendered at a capped pixel budget and
   * scaled down further by a governor if frames run long. Fish are drawn into
   * small offscreen canvases and composited in that same pass — no canvas
   * filters anywhere (a 2D `filter: blur()` per fish cost ~0.5 s per frame on
   * integrated graphics).
   * ====================================================================== */

  const NB = 28;                     // bubble slots in the shader
  const NR = 4;                      // pointer ring-wave slots
  const G = 229;                     // px/s², shared by every wave so they disperse alike
  const BAND = 22;                   // TIR mirror band under the waterline, px
  const TAU = Math.PI * 2;
  const ZONE = 4.4;                  // metres of water from the top of the screen to the bottom

  const FRAG = `
uniform float uLevel;
uniform float uAmp;
uniform float uT;
uniform float uRefr;
uniform float uCaus;
uniform float uPxm;
uniform float uFish;
uniform vec4 uW[8];
uniform vec4 uB[${NB}];
uniform vec4 uRip[${NR}];
uniform sampler2D uNear;
uniform sampler2D uMid;
uniform sampler2D uFar;

// diffuse attenuation, m^-1 (Jerlov oceanic IB, R/G/B)
const vec3 K = vec3(0.42, 0.072, 0.040);
const float BAND = ${BAND.toFixed(1)};
const float ZV = 0.8;              // glass to page, m

float lineY(float x) {
  return uLevel + uAmp * (5.0 * sin(x * 0.0105 - uT * 1.551 + 0.4) + 2.6 * sin(x * 0.023 + uT * 2.295 + 1.7) + 1.2 * sin(x * 0.051 - uT * 3.418));
}

void waves(vec2 x, out vec2 grad, out vec3 hs) {
  grad = vec2(0.0); hs = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    vec4 w = uW[i];
    float ph = dot(w.xy, x) - w.z * uT + float(i) * 1.913;
    float s = sin(ph), c = cos(ph);
    grad += w.w * c * w.xy;
    hs -= w.w * s * vec3(w.x * w.x, w.y * w.y, w.x * w.y);
  }
  grad *= uAmp; hs *= uAmp;
}

// ring waves stirred up by the pointer: slope only (they distort, they do not focus)
vec2 ripples(vec2 p, out float glow) {
  vec2 g = vec2(0.0);
  glow = 0.0;
  for (int i = 0; i < ${NR}; i++) {
    vec4 r = uRip[i];
    if (r.w <= 0.0) continue;
    vec2 d = p - r.xy;
    float l = length(d) + 0.001;
    float f = l - 240.0 * r.z;
    float e = exp(-f * f / 2600.0) * r.w;
    g += d / l * (e * cos(f * 0.105));
    glow += e * max(0.0, sin(f * 0.105));       // crests focus a little light
  }
  return g;
}

float rays(vec2 p, float dz) {
  vec2 v = p - vec2(uRes.x * 0.3, -uRes.y * 1.3);
  float u = v.x / v.y * uRes.y;
  float r = 0.65 * vnoise(vec2(u * 0.011, uT * 0.2)) + 0.35 * vnoise(vec2(u * 0.031 + 3.0, uT * 0.33 + 9.0));
  r = smoothstep(0.42, 0.8, r);
  return r * r * exp(-dz / (uRes.y * 0.7)) * smoothstep(0.0, 60.0, dz);
}

float snow(vec2 p, float cell, vec2 vel, float seed, float rad) {
  vec2 q = p / cell - vel * uT;
  vec2 id = floor(q), f = fract(q);
  float h3 = hash12(id + seed);
  if (h3 < 0.45) return 0.0;
  vec2 h = hash22(id + seed * 1.37);
  vec2 pos = 0.2 + 0.6 * h + 0.06 * vec2(sin(uT * 0.7 + h.y * 20.0), cos(uT * 0.53 + h.x * 20.0));
  float d = length(f - pos) * cell;
  return (1.0 - smoothstep(rad * 0.25, rad, d)) * (0.3 + 0.7 * h3);
}

vec3 page(vec2 p) { return pageAt(clamp(p, vec2(0.5), uRes - 0.5)).rgb; }
vec4 tex(sampler2D s, vec2 p) { return texture2D(s, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)); }

// downwelling light at depth d (m): spectral Beer–Lambert plus a grey loss
// for light scattered out of the beam
vec3 sunAt(float d) { return exp(-K * d) * exp(-0.16 * d); }
// veiling light: what the water itself glows with when lit from above
vec3 veilAt(float d) { return vec3(0.07, 0.42, 0.56) * sunAt(d * 0.85) + vec3(0.0, 0.025, 0.06); }

// composite something sitting z metres in front of the page (premultiplied in)
vec3 inWater(vec3 c, float z, vec3 sun, vec3 veil, vec3 lit) {
  float vk = 1.0 - exp(-1.1 * z);
  return c * sun * lit * exp(-K * z * 1.4) + veil * vk;
}
// the same for a premultiplied fish layer sample
vec4 fishLit(vec4 f, float z, vec3 sun, vec3 veil, vec3 lit) {
  return vec4(f.rgb * sun * lit * exp(-K * z * 1.4) + veil * (1.0 - exp(-1.1 * z)) * f.a, f.a);
}

void main() {
  vec2 p = cssPos();
  float yl = lineY(p.x);
  float dz = p.y - yl;
  bool hasPage = uHasPage > 0.5;
  // dry: transparent, so the live page shows through at full sharpness
  if (dz < -9.0) { gl_FragColor = vec4(0.0); return; }

  vec2 grad; vec3 hs;
  waves(p, grad, hs);
  float rgl;
  vec2 rg = ripples(p, rgl);
  float wIn = smoothstep(0.0, 26.0, dz);

  // Snell refraction through the moving surface
  vec3 Rr = refract(vec3(0.0, 0.0, -1.0), normalize(vec3(-(grad + rg), 1.0)), 0.7502);
  vec2 off = uRefr * Rr.xy / max(-Rr.z, 0.2) * wIn;

  float dm = 0.3 + max(dz, 0.0) / uPxm;          // depth below the surface, m
  vec3 sun = sunAt(dm);
  vec3 veil = veilAt(dm);

  // caustics: irradiance = 1/|det J| of the refraction map, per wavelength.
  // The focusing distance grows with depth, so the net is sharpest a little
  // under the surface and goes soft and broad further down.
  float cz = uCaus * (0.5 + 0.5 * exp(-dm * 0.45));
  vec2 xs = p + cz * grad;
  vec2 g2; vec3 h2;
  waves(xs, g2, h2);
  vec3 kk = vec3(0.985, 1.0, 1.015);
  vec3 a = kk * cz * h2.x, b = kk * cz * h2.y, c = kk * cz * h2.z;
  vec3 det = (1.0 - a) * (1.0 - b) - c * c;
  vec3 I = min(1.0 / (abs(det) + 0.22), 3.6);
  float causAmt = exp(-dm * 0.38) * wIn;
  vec3 lit = 0.7 + (I - 0.85) * 0.34 * causAmt;      // ambient sky light + focused sun
  vec3 litFish = 0.74 + (I - 0.85) * 0.3 * causAmt;

  float ry = rays(p, dz) * (0.6 + 0.4 * causAmt);
  float sn = snow(p, 150.0, vec2(0.05, -0.035), 3.7, 2.6) * 0.8 + snow(p, 70.0, vec2(0.03, -0.02), 11.3, 1.3) * 0.5;
  sn *= wIn;
  vec3 sunC = vec3(0.8, 0.95, 1.0);

  // ---- the page (or, without a snapshot, a veil over the live page) -------
  vec3 col;               // opaque path
  vec4 ov = vec4(0.0);    // overlay path: premultiplied colour over the live page
  vec3 em;                // light added on top
  if (dz < 0.0) {
    // meniscus: a thin film climbing the page, magnifying toward the line
    float men = smoothstep(-9.0, 0.0, dz);
    vec3 pg = page(p + vec2(0.0, 3.5 * men * men));
    col = pg * mix(vec3(1.0), vec3(0.9, 1.0, 1.02), men);
    em = vec3(0.85, 0.97, 1.0) * exp(-pow((dz + 1.6) / 1.3, 2.0)) * 0.55;
    ov = vec4(vec3(0.6, 0.85, 0.95) * men * 0.2, men * 0.2);
  } else {
    vec3 pg = page(p + off);
    col = inWater(pg, ZV, sun, veil, lit);
    // the live page cannot be multiplied, so darken-and-tint it instead
    float deep = clamp((0.93 - sun.g) / 0.6, 0.0, 1.0);
    float oa = mix(0.52, 0.84, deep) * wIn;
    vec3 oc = mix(vec3(0.04, 0.56, 0.72), vec3(0.0, 0.15, 0.27), deep) * mix(vec3(1.0), lit, 0.6);
    ov = vec4(oc * oa, oa);
    em = sunC * sun * (ry * 0.36 + rgl * 0.35) + sunC * sn * sun * 0.5 + vec3(0.45, 0.85, 1.0) * 0.12 * exp(-dz / 110.0);
    if (!hasPage) em += sunC * sun * max(I - 1.0, vec3(0.0)) * 0.2 * causAmt;

    // ---- fish: shadows on the page, then far, mid, near -----------------
    if (uFish > 0.5) {
      // soft shadow: fish coverage, offset away from the light and blurred
      vec2 sp = p + vec2(-14.0, -34.0);
      float sh = 0.4 * (tex(uMid, sp + vec2(-9.0, -6.0)).a + tex(uMid, sp + vec2(9.0, 6.0)).a)
               + 0.5 * (tex(uNear, sp + vec2(-16.0, -10.0)).a + tex(uNear, sp + vec2(16.0, 10.0)).a);
      sh = min(sh, 1.0);
      col *= 1.0 - 0.32 * sh * wIn;
      ov = vec4(ov.rgb * (1.0 - 0.32 * sh), ov.a + (1.0 - ov.a) * 0.32 * sh * wIn);

      // far fish swim close to the page (more water in front of them, more
      // refraction), near ones close to the glass
      vec4 c1 = fishLit(tex(uFar, p + off * 0.8), 0.62, sun, veil, litFish);
      col = col * (1.0 - c1.a) + c1.rgb; ov = ov * (1.0 - c1.a) + c1;
      vec4 c2 = fishLit(tex(uMid, p + off * 0.5), 0.34, sun, veil, litFish);
      col = col * (1.0 - c2.a) + c2.rgb; ov = ov * (1.0 - c2.a) + c2;
      vec4 c3 = fishLit(tex(uNear, p + off * 0.25), 0.12, sun, veil, litFish);
      col = col * (1.0 - c3.a) + c3.rgb; ov = ov * (1.0 - c3.a) + c3;
    }

    if (dz < BAND) {
      // the underside of the surface, seen at grazing incidence: a mirror
      float k = dz / BAND;
      vec3 rc = inWater(page(vec2(p.x + off.x * 2.0, yl + BAND + (BAND - dz) * 1.4)), ZV, sun, veil, lit) * 0.95;
      float fr = pow(1.0 - k, 1.5) * 0.8;
      col = mix(col, rc, fr);
      em += vec3(0.8, 0.95, 1.0) * exp(-dz / 1.7) * 0.6;
      ov = mix(ov, vec4(veil * 1.6 + 0.08, 0.55), fr * 0.7);
    }
  }

  // ---- bubbles --------------------------------------------------------------
  for (int i = 0; i < ${NB}; i++) {
    vec4 B = uB[i];
    if (B.w <= 0.0) continue;
    vec2 d = p - B.xy;
    float rho = length(d) / B.z;
    if (rho > 1.0) continue;
    vec2 u = d / B.z;
    vec3 inside = inWater(page(B.xy + d * 0.38 + off), ZV, sun, veil, lit) * 1.12;
    float tir = smoothstep(0.62, 0.86, rho);
    vec3 env = mix(vec3(0.85, 0.97, 1.0) * (0.55 + 0.45 * sun.g), veil * 1.3 + 0.03, smoothstep(-0.9, 0.9, u.y));
    vec2 hl = u - vec2(-0.33, -0.4);
    float spec = exp(-dot(hl, hl) * 38.0);
    float aa = (1.0 - smoothstep(1.0 - 1.4 / B.z, 1.0, rho)) * B.w;
    col = mix(col, mix(inside, env, tir) + spec, aa);
    // over the live page: the lens interior stays clear, the rim and glint add
    float ba = max(tir * 0.8, spec);
    ov = mix(ov, vec4(env * tir * 0.8 + vec3(spec), ba) + ov * (1.0 - ba), aa);
  }

  if (hasPage) {
    gl_FragColor = vec4(col + em, 1.0);
  } else {
    float ea = clamp(max(max(em.r, em.g), em.b), 0.0, 1.0);
    vec4 o = vec4(ov.rgb + em, ov.a + (1.0 - ov.a) * ea);
    float A = clamp(o.a, 0.0, 1.0);
    gl_FragColor = vec4(clamp(o.rgb / max(A, 1e-3), 0.0, 1.0), A);
  }
}
`;

  /* Adaptive resolution: water is soft, so trade pixels for frames. Watches
     real frame times in windows and steps the backing store down (never back
     up — oscillating resolution reads as flicker). */
  const governor = (fx, W, H) => {
    let n = 0, acc = 0, scale = 1, skip = 8;
    const base = fx.dpr;
    return (raw) => {
      if (skip > 0) { skip--; return; }
      if (!(raw > 0) || raw > 250) return;            // backgrounded or a hitch
      acc += raw;
      if (++n < 36) return;
      const avg = acc / n;
      n = 0; acc = 0;
      if (avg > 19.5 && scale > 0.42) {
        scale *= avg > 32 ? 0.66 : 0.8;
        const d = Math.max(0.5, base * scale);
        fx.canvas.width = Math.round(W * d);
        fx.canvas.height = Math.round(H * d);
        skip = 6;
      }
    };
  };

  function underwater(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const RM = ctx.reduced;
    const f = ctx.fit(1500, 1300, 600);
    const total = f.intro + f.hold + f.outro;
    const T1 = f.intro, T2 = f.intro + f.hold;
    const AMP = RM ? 0.45 : 1;
    const LOW = H + 24;                 // line + meniscus fully below the screen
    const HIGH = -(BAND + 34);          // the mirror band fully above it
    const PXM = H / ZONE;               // px per metre of depth (shared with the shader)

    let clock = 0;                      // animation time, s (slower when reduced)
    let stir = 1;                       // extra surface chop while the water pours in
    const lineY = (x, lv) =>
      lv + AMP * stir * (5 * Math.sin(x * 0.0105 - clock * 1.551 + 0.4) + 2.6 * Math.sin(x * 0.023 + clock * 2.295 + 1.7) + 1.2 * Math.sin(x * 0.051 - clock * 3.418));

    const levelAt = (t) => {
      if (t < T1) {
        const u = t / T1;
        const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        return LOW + (HIGH - LOW) * e;
      }
      if (t < T2) return HIGH + 4 * Math.sin((t - T1) / 1100);
      const u = clamp((t - T2) / f.outro, 0, 1);
      const from = HIGH + 4 * Math.sin(f.hold / 1100);
      return LOW - (LOW - from) * Math.pow(1 - u, 2);           // Torricelli
    };

    /* ---- pointer: stirs the water, sheds bubbles, scares fish ------------- */
    const ptr = { x: -1e4, y: -1e4, vx: 0, vy: 0, lx: -1e4, ly: -1e4, t: -1e9, seen: false };
    const rip = [];                     // {x, y, age, a}
    const ripBuf = new Float32Array(NR * 4);
    listen(window, 'pointermove', (e) => {
      const x = e.clientX, y = e.clientY;
      if (ptr.seen) { ptr.vx = x - ptr.x; ptr.vy = y - ptr.y; }
      ptr.x = x; ptr.y = y; ptr.seen = true;
    }, { passive: true, capture: true });

    /* ---- bubbles --------------------------------------------------------- */
    const bubbles = [];
    const vents = [rand(0.08, 0.3), rand(0.4, 0.62), rand(0.7, 0.94)].map((k) => ({ x: k * W, next: rand(0, 600) }));
    const bubbleBuf = new Float32Array(NB * 4);
    const addBubble = (x, y, r0) => {
      if (bubbles.length >= NB) return;
      bubbles.push({ x, x0: x, y, r0, r: r0, ph: rand(0, TAU), a: 0, age: 0 });
    };
    let pour = 0;                       // air trapped by the incoming water
    const stepBubbles = (dt, t, lv) => {
      const s = dt / 1000;
      if (t < T2 + f.outro * 0.15 && lv < H - 40) {
        for (const v of vents) {
          v.next -= dt;
          if (v.next <= 0) {
            addBubble(v.x + rand(-6, 6), H + 8, Math.random() < 0.25 ? rand(4, 7) : rand(1.6, 4));
            v.next = Math.random() < 0.7 ? rand(90, 260) : rand(700, 1800);   // trains, then pauses
            if (RM) v.next *= 2.5;
          }
        }
      }
      // while it pours in, the water traps air: bursts just under the rising line
      if (t < T1 && !RM) {
        pour -= dt;
        if (pour <= 0 && lv < H - 30) {
          const x = rand(20, W - 20);
          addBubble(x, Math.min(H + 6, lineY(x, lv) + rand(40, 160)), rand(2, 6.5));
          pour = rand(25, 70);
        }
      }
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i];
        b.age += s;
        const rmm = b.r * 0.25;                                     // px → mm
        const v = 0.25 * Math.tanh(rmm / 0.8) * 400 * (RM ? 0.6 : 1); // terminal velocity, px/s
        b.y -= v * s;
        const zig = rmm > 0.7 ? b.r * 1.1 : b.r * 0.3;              // path instability
        b.x = b.x0 + zig * Math.sin(b.age * TAU * 2.2 + b.ph) + Math.sin(b.age * 0.9 + b.ph) * 6;
        const d = Math.max(0, (b.y - lv) / PXM);
        b.r = b.r0 * Math.cbrt((1 + 0.0981 * ZONE) / (1 + 0.0981 * (d + 1.0)));  // Boyle: P = 1 atm + ρgd
        b.a = Math.min(1, b.age * 6);
        if (b.y < lineY(b.x, lv) + b.r || b.y < -20) bubbles.splice(i, 1);
      }
      bubbleBuf.fill(0);
      bubbles.forEach((b, i) => bubbleBuf.set([b.x, b.y, b.r, b.a], i * 4));
    };

    const stepPointer = (dt, lv) => {
      const s = dt / 1000;
      const sp = Math.hypot(ptr.vx, ptr.vy);
      const wet = ptr.y > lineY(ptr.x, lv) + 8;
      if (ptr.seen && wet && sp > 2 && Math.hypot(ptr.x - ptr.lx, ptr.y - ptr.ly) > 70 && !RM) {
        if (rip.length >= NR) rip.shift();
        rip.push({ x: ptr.x, y: ptr.y, age: 0, a: clamp(sp / 40, 0.3, 1) * 0.42 });
        ptr.lx = ptr.x; ptr.ly = ptr.y;
        // a hand moving through water sheds a few small bubbles
        if (sp > 14) for (let k = 0; k < 2; k++) addBubble(ptr.x + rand(-10, 10), ptr.y + rand(-6, 10), rand(1.4, 3.2));
      }
      ptr.vx *= 0.5; ptr.vy *= 0.5;
      for (let i = rip.length - 1; i >= 0; i--) {
        const r = rip[i];
        r.age += s;
        if (r.age > 2.2) rip.splice(i, 1);
      }
      ripBuf.fill(0);
      rip.forEach((r, i) => ripBuf.set([r.x, r.y, r.age, r.a * Math.exp(-r.age * 1.5)], i * 4));
    };

    /* ---- fish -------------------------------------------------------------- */
    const SPECIES = {
      sardine: { back: [34, 70, 104], flank: [168, 190, 204], belly: [238, 242, 244], fin: [140, 168, 182], stripe: [92, 132, 170], spots: true },
      mullet: { back: [66, 82, 90], flank: [170, 180, 182], belly: [230, 232, 228], fin: [120, 130, 128], stripe: [120, 134, 140], spots: false },
      jack: { back: [48, 92, 116], flank: [182, 204, 210], belly: [240, 244, 242], fin: [212, 184, 96], stripe: [200, 186, 110], spots: false }
    };
    // depth layer: apparent scale, haze (fallback only), canvas resolution
    const FS = clamp(Math.min(W, H) / 760, 0.6, 1.4);
    const LAYERS = [{ s: 0.5 * FS, hz: 0.8, res: 0.34 }, { s: 0.78 * FS, hz: 0.5, res: 0.6 }, { s: 1.12 * FS, hz: 0.18, res: 1 }];
    const fishes = [];
    const spawn = (o) => {
      const L = o.L * LAYERS[o.layer].s;
      const U = o.bl * L * (RM ? 0.6 : 1);                        // body lengths / s
      fishes.push({
        ...o, L, U, U0: U, f: U / (0.7 * L), ph: rand(0, TAU), vy: 0, wob: rand(0, TAU),
        sp: SPECIES[o.sp], age: 0, beat: rand(0, TAU), scare: 0, kick: 0, slot: o.slot || [0, 0]
      });
    };
    const startDir = Math.random() < 0.5 ? 1 : -1;
    const sx0 = W * rand(0.25, 0.6), sy0 = H * rand(0.38, 0.6);
    const NS = W < 700 ? 7 : 10;
    for (let i = 0; i < NS; i++) {
      const slot = [-(i % 4) * 30 - Math.floor(i / 4) * 12 + rand(-8, 8), (Math.floor(i / 4) - 1) * 26 + ((i % 4) - 1.5) * 9 + rand(-6, 6)];
      spawn({ layer: 1, sp: 'sardine', L: 82 * rand(0.92, 1.08), bl: 1.7 * rand(0.97, 1.03), dir: startDir,
        x: sx0 + slot[0] * startDir * 1.6, y: sy0 + slot[1] * 1.6, group: 1, slot });
    }
    spawn({ layer: 0, sp: 'mullet', L: 150, bl: 0.7, dir: -startDir, x: W * rand(0.2, 0.8), y: H * rand(0.22, 0.4) });
    spawn({ layer: 0, sp: 'jack', L: 130, bl: 0.8, dir: startDir, x: W * rand(0.1, 0.9), y: H * rand(0.65, 0.85) });
    spawn({ layer: 2, sp: 'jack', L: 160, bl: 1.25, dir: -startDir, x: -startDir > 0 ? -260 - rand(0, 900) : W + 260 + rand(0, 900), y: H * rand(0.45, 0.8) });
    fishes.forEach((F) => { F.y0 = F.y; });
    fishes.sort((a, b) => a.layer - b.layer);
    const school = fishes.filter((F) => F.group);
    const lead = school[0];

    const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    const prof = (s) => Math.max(0, Math.sqrt(s) * (1.08 - s)) / 0.432;

    // Beer–Lambert colour for the no-WebGL path, where the shader cannot do it
    const KJ = [0.42, 0.072, 0.040];
    const waterify = (c, y, lv, hz) => {
      const dm = 0.3 + clamp((y - lv) / PXM, 0, ZONE * 1.3);
      return c.map((v, i) => {
        const T = Math.exp(-KJ[i] * (dm + hz * 2.2) - 0.16 * dm);
        const veil = [0.07, 0.42, 0.56][i] * Math.exp(-KJ[i] * dm * 0.85 - 0.136 * dm);
        const k = 1 - Math.exp(-1.1 * (0.2 + hz * 1.2));
        return Math.round(255 * clamp((v / 255) * T * (1 - k * 0.5) + veil * k, 0, 1));
      });
    };

    const drawFish = (g, F, lv, raw) => {
      const L = F.L, N = 14, BODY = 0.8;
      const beat = F.beat;
      const xs = [], ys = [], hh = [];
      let tailSlope = 0;
      // a startled fish bends into a C before it bolts
      const bend = F.kick * 0.22 * L;
      for (let i = 0; i <= N; i++) {
        const s = i / N;
        const a = L * (0.02 - 0.08 * s + 0.16 * s * s);
        const lat = a * Math.sin(TAU * (s / 0.95) - beat);
        xs.push((0.5 - s * BODY) * L);
        ys.push(lat * 0.3 + bend * s * s);                // we see the yaw wave slightly from above
        hh.push(L * 0.115 * prof(s));
        if (i === N) tailSlope = (a * TAU / 0.95) * Math.cos(TAU * (s / 0.95) - beat) / (BODY * L);
      }
      const tone = raw ? (c) => c : (c) => waterify(c, F.y, lv, LAYERS[F.layer].hz);
      const back = tone(F.sp.back), flank = tone(F.sp.flank), belly = tone(F.sp.belly);
      const fin = tone(F.sp.fin), stripe = tone(F.sp.stripe);

      g.save();
      g.translate(F.x, F.y);
      g.rotate(clamp(F.vy / Math.max(30, F.U), -0.35, 0.35) * F.dir);
      g.scale(F.dir, 1);

      // caudal fin: vertical, foreshortened as the tail sweeps toward/away from us
      const tx = xs[N], ty = ys[N];
      const cf = Math.max(0.25, Math.abs(Math.cos(Math.atan(tailSlope * 2.2))));
      g.fillStyle = rgb(fin, 0.78);
      g.beginPath();
      g.moveTo(tx + 2, ty - hh[N] * 0.9);
      g.quadraticCurveTo(tx - 0.12 * L * cf, ty - 0.1 * L, tx - 0.22 * L * cf, ty - 0.19 * L);
      g.quadraticCurveTo(tx - 0.12 * L * cf, ty - 0.03 * L, tx - 0.1 * L * cf, ty);
      g.quadraticCurveTo(tx - 0.12 * L * cf, ty + 0.03 * L, tx - 0.22 * L * cf, ty + 0.19 * L);
      g.quadraticCurveTo(tx - 0.12 * L * cf, ty + 0.1 * L, tx + 2, ty + hh[N] * 0.9);
      g.closePath();
      g.fill();

      // dorsal + anal fins, translucent
      g.fillStyle = rgb(fin, 0.62);
      g.beginPath();
      g.moveTo(xs[5], ys[5] - hh[5] * 0.95);
      g.lineTo(xs[6] + 0.02 * L, ys[6] - hh[6] - 0.09 * L);
      g.lineTo(xs[8], ys[8] - hh[8] * 0.95);
      g.closePath();
      g.moveTo(xs[9], ys[9] + hh[9] * 0.9);
      g.lineTo(xs[10], ys[10] + hh[10] + 0.05 * L);
      g.lineTo(xs[11], ys[11] + hh[11] * 0.9);
      g.closePath();
      g.fill();

      // body, countershaded: dark back, silver flank, white belly
      const gr = g.createLinearGradient(0, -0.12 * L, 0, 0.11 * L);
      gr.addColorStop(0, rgb(back));
      gr.addColorStop(0.4, rgb(back));
      gr.addColorStop(0.56, rgb(flank));
      gr.addColorStop(1, rgb(belly));
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(xs[0] + 0.012 * L, ys[0]);
      for (let i = 0; i <= N; i++) g.lineTo(xs[i], ys[i] - hh[i]);
      for (let i = N; i >= 0; i--) g.lineTo(xs[i], ys[i] + hh[i] * 0.92);
      g.closePath();
      g.fill();

      // lateral stripe
      g.strokeStyle = rgb(stripe, 0.55);
      g.lineWidth = Math.max(0.6, 0.012 * L);
      g.beginPath();
      for (let i = 2; i <= N - 1; i++) (i === 2 ? g.moveTo : g.lineTo).call(g, xs[i], ys[i] - hh[i] * 0.12);
      g.stroke();

      // flank flash: silver scales catching the light as the body yaws
      const flash = Math.max(0, Math.sin(beat - 0.6)) * (1 - LAYERS[F.layer].hz) * 0.32;
      if (flash > 0.01) {
        g.fillStyle = `rgba(240,250,255,${flash.toFixed(3)})`;
        g.beginPath();
        for (let i = 2; i <= N - 2; i++) g.lineTo(xs[i], ys[i] - hh[i] * 0.15);
        for (let i = N - 2; i >= 2; i--) g.lineTo(xs[i], ys[i] + hh[i] * 0.45);
        g.closePath();
        g.fill();
      }
      if (F.sp.spots && F.layer > 0) {
        g.fillStyle = rgb(back, 0.55);
        for (let i = 3; i <= 6; i++) { g.beginPath(); g.arc(xs[i], ys[i] - hh[i] * 0.2, 0.012 * L, 0, TAU); g.fill(); }
      }
      // gill line, pectoral fin, eye
      g.strokeStyle = rgb(back, 0.35);
      g.lineWidth = Math.max(0.6, 0.008 * L);
      g.beginPath();
      g.moveTo(xs[2], ys[2] - hh[2] * 0.7);
      g.quadraticCurveTo(xs[2] - 0.025 * L, ys[2], xs[2], ys[2] + hh[2] * 0.7);
      g.stroke();
      g.fillStyle = rgb(fin, 0.5);
      g.beginPath();
      g.ellipse(xs[3] - 0.04 * L, ys[3] + hh[3] * 0.25, 0.07 * L, 0.022 * L, 0.35 + 0.15 * Math.sin(beat * 0.5), 0, TAU);
      g.fill();
      g.fillStyle = rgb(tone([215, 220, 210]));
      g.beginPath(); g.arc(xs[1] - 0.005 * L, ys[1] - hh[1] * 0.2, 0.03 * L, 0, TAU); g.fill();
      g.fillStyle = rgb(tone([12, 16, 20]));
      g.beginPath(); g.arc(xs[1] - 0.003 * L, ys[1] - hh[1] * 0.2, 0.018 * L, 0, TAU); g.fill();
      g.restore();
    };

    const stepFish = (dt) => {
      const s = dt / 1000;
      for (const F of fishes) {
        F.age += s;
        // startle: fish near the pointer bolt away from it
        if (F.layer > 0 && ptr.seen) {
          const dx = F.x - ptr.x, dy = F.y - ptr.y, d = Math.hypot(dx, dy);
          const reach = F.L * 1.6 + 60;
          if (d < reach && F.scare < 0.3) {
            F.scare = 1;
            F.kick = 1;
            if (Math.sign(dx) !== F.dir && !F.group) F.dir = Math.sign(dx) || F.dir;   // turn tail
            F.dodge = (dy >= 0 ? 1 : -1) * H * 0.12;
            if (F.group) for (const o of school) { o.scare = 1; o.kick = 1; o.dodge = F.dodge; }
          }
        }
        F.scare = Math.max(0, F.scare - s * 0.7);
        F.kick = Math.max(0, F.kick - s * 6);
        const burst = 1 + 2.4 * F.scare * F.scare;
        F.beat += TAU * F.f * burst * s;
        F.U = F.U0 * burst;
        if (F.dodge) { F.y0 += F.dodge * s * 2 * F.scare; F.y0 = clamp(F.y0, H * 0.1, H * 0.9); if (F.scare <= 0) F.dodge = 0; }

        if (F.group && F !== lead) {
          // hold a loose slot in the formation behind and beside the leader
          const tx = lead.x + F.slot[0] * lead.dir * 1.6 + Math.sin(F.age * 0.9 + F.wob) * 6;
          const ty = lead.y + F.slot[1] * 1.6 + Math.sin(F.age * 0.7 + F.wob * 2) * 5;
          F.dir = lead.dir;
          const ax = (tx - F.x) * 2.2;
          F.x += (lead.dir * F.U + ax) * s;
          const ny = F.y + (ty - F.y) * Math.min(1, s * 2.5);
          F.vy = (ny - F.y) / Math.max(s, 1e-3);
          F.y = ny;
          continue;
        }
        F.x += F.dir * F.U * s;
        const ny = F.y0 + Math.sin(F.age * 0.35 + F.wob) * H * 0.04;
        F.vy = (ny - F.y) / Math.max(s, 1e-3) * 0.5 + F.vy * 0.5;
        F.y = F.y + (ny - F.y) * Math.min(1, s * 4);
        const off = F.L + 40 + (F.group ? 220 : 0);
        if ((F.dir > 0 && F.x > W + off) || (F.dir < 0 && F.x < -off)) {
          // swim back in later from the far side
          F.dir = Math.random() < 0.5 ? 1 : -1;
          F.x = F.dir > 0 ? -off - rand(0, F.group ? 120 : 1400) : W + off + rand(0, F.group ? 120 : 1400);
          F.y0 = clamp(F.y0 + rand(-H * 0.15, H * 0.15), H * 0.15, H * 0.85);
          if (F.group) for (const o of school) if (o !== F) { o.x = F.x + o.slot[0] * F.dir * 1.6; o.y = F.y0 + o.slot[1] * 1.6; }
        }
      }
    };

    /* ---- layers -------------------------------------------------------------- */
    let fx = null;
    try { fx = gl(stage, FRAG, { snapshot: ctx.snapshot, maxPixels: 1.3e6 }); } catch (err) { console.warn(err); fx = null; }
    let tint = null;
    if (!fx) {
      // no WebGL: approximate the water with a tinted, slightly softened
      // backdrop under a clip that follows the waterline
      css(`${R} .sfx-uw-tint{position:absolute;inset:0;
 background:linear-gradient(180deg,rgba(20,120,150,.26) 0%,rgba(10,80,116,.44) 55%,rgba(4,40,72,.6) 100%);
 -webkit-backdrop-filter:blur(.8px) saturate(.85) brightness(.9) hue-rotate(-10deg);
 backdrop-filter:blur(.8px) saturate(.85) brightness(.9) hue-rotate(-10deg);
 clip-path:inset(100% 0 0 0);}`);
      tint = div('sfx-uw-tint');
      stage.insertBefore(tint, stage.firstChild);
    }
    if (ctx.snapshot && fx) lockScroll();

    // fish canvases: offscreen layers for the shader, or one visible canvas
    const offscreen = (res) => {
      const cv = el('canvas');
      cv.width = Math.max(2, Math.round(W * res));
      cv.height = Math.max(2, Math.round(H * res));
      const g = cv.getContext('2d');
      g.setTransform(res, 0, 0, res, 0, 0);
      return { cv, g, res };
    };
    let lay = null, fishLayer = null;
    if (fx) {
      const dpr1 = Math.min(1.25, window.devicePixelRatio || 1);
      lay = [offscreen(LAYERS[0].res), offscreen(LAYERS[1].res * dpr1), offscreen(Math.min(dpr1, 1.25))];
    } else {
      fishLayer = canvasLayer(stage);
    }

    let gov = null;
    if (fx) {
      const g = fx.gl;
      const wv = [];
      const dirs = [0.35, 1.05, -0.5, 2.3, -1.6, 0.8, 2.9, -2.6];
      const lens = [260, 205, 170, 140, 113, 96, 78, 64];
      for (let i = 0; i < 8; i++) {
        const k = TAU / lens[i], th = dirs[i] + rand(-0.15, 0.15);
        wv.push(Math.cos(th) * k, Math.sin(th) * k, Math.sqrt(G * k), 0.035 / k);
      }
      fx.set('uW', new Float32Array(wv), '4fv');
      fx.set('uRefr', 52);
      fx.set('uCaus', 240);
      fx.set('uPxm', PXM);
      fx.set('uFish', 1);
      // fish layers are premultiplied so their soft edges filter cleanly
      g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      fx.texture('uFar', lay[0].cv, 1);
      fx.texture('uMid', lay[1].cv, 2);
      fx.texture('uNear', lay[2].cv, 3);
      gov = governor(fx, W, H);
    }

    const clearCv = (o) => {
      o.g.setTransform(1, 0, 0, 1, 0, 0);
      o.g.clearRect(0, 0, o.cv.width, o.cv.height);
      o.g.setTransform(o.res, 0, 0, o.res, 0, 0);
    };
    const visible = (F) => F.x > -F.L * 1.4 && F.x < W + F.L * 1.4;

    const frame = (t, raw) => {
      clock += (raw / 1000) * (RM ? 0.5 : 1);         // wall clock for the waves
      const dt = Math.min(raw, 100);                   // physics step, capped
      stir = t < T1 ? 1 + 0.9 * Math.sin(Math.PI * t / T1) : 1;
      const lv = levelAt(t);
      stepPointer(dt, lv);
      stepBubbles(dt, t, lv);
      stepFish(dt);
      const fade = clamp(Math.min(t / 100, (total - t) / 150), 0, 1);
      const wet = lv < H + 10;
      if (fx) {
        if (wet) {
          lay.forEach(clearCv);
          for (const F of fishes) {
            if (!visible(F)) continue;
            drawFish(lay[F.layer].g, F, lv, true);
          }
          fx.texture('uFar', lay[0].cv, 1);
          fx.texture('uMid', lay[1].cv, 2);
          fx.texture('uNear', lay[2].cv, 3);
        }
        fx.set('uLevel', lv);
        fx.set('uAmp', AMP * stir);
        fx.set('uT', clock);
        fx.set('uB', bubbleBuf, '4fv');
        fx.set('uRip', ripBuf, '4fv');
        fx.canvas.style.opacity = String(fade);
        fx.canvas.style.visibility = wet ? 'visible' : 'hidden';
        if (wet) fx.draw(clock);
        return;
      }
      if (tint) {
        const pts = [];
        for (let x = 0; x <= W + 1; x += Math.max(24, W / 40)) pts.push(`${x.toFixed(0)}px ${lineY(x, lv).toFixed(1)}px`);
        pts.push(`${W}px ${lineY(W, lv).toFixed(1)}px`, `${W}px ${H}px`, `0px ${H}px`);
        tint.style.clipPath = `polygon(${pts.join(',')})`;
        tint.style.opacity = String(fade);
      }
      // fish and bubbles live only below the waterline
      const fg = fishLayer.g;
      fg.clearRect(0, 0, W, H);
      fishLayer.cv.style.visibility = wet ? 'visible' : 'hidden';
      if (wet) {
        fg.save();
        fg.beginPath();
        fg.moveTo(0, lineY(0, lv) + 3);
        for (let x = 24; x <= W + 24; x += 24) fg.lineTo(x, lineY(x, lv) + 3);
        fg.lineTo(W, H); fg.lineTo(0, H); fg.closePath();
        fg.clip();
        fg.globalAlpha = fade;
        for (const F of fishes) if (visible(F)) drawFish(fg, F, lv, false);
        drawBubbles2d(fg, bubbles);
        fg.restore();
        drawLine2d(fg, lv, lineY, W, fade);
      }
    };
    frame(0, 0);
    loop((dt, t, raw) => {
      if (t > total) return false;
      const r = raw === undefined ? dt : raw;
      if (gov) gov(r);
      frame(t, r);
    });
    return total;
  }

  /* No-WebGL fallbacks: the same bubbles and waterline, drawn in 2D. */
  function drawBubbles2d(g, bubbles) {
    for (const b of bubbles) {
      const gr = g.createRadialGradient(b.x - b.r * 0.3, b.y - b.r * 0.35, b.r * 0.05, b.x, b.y, b.r);
      gr.addColorStop(0, `rgba(255,255,255,${(0.9 * b.a).toFixed(3)})`);
      gr.addColorStop(0.25, `rgba(210,240,255,${(0.12 * b.a).toFixed(3)})`);
      gr.addColorStop(0.72, `rgba(200,235,250,${(0.08 * b.a).toFixed(3)})`);
      gr.addColorStop(0.92, `rgba(225,248,255,${(0.75 * b.a).toFixed(3)})`);
      gr.addColorStop(1, 'rgba(225,248,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(b.x, b.y, b.r, 0, TAU); g.fill();
    }
  }
  function drawLine2d(g, lv, lineY, W, fade) {
    g.save();
    g.globalAlpha = fade;
    g.strokeStyle = 'rgba(225,246,255,.85)';
    g.lineWidth = 1.5;
    g.beginPath();
    for (let x = 0; x <= W + 12; x += 12) (x ? g.lineTo : g.moveTo).call(g, x, lineY(x, lv));
    g.stroke();
    g.strokeStyle = 'rgba(190,230,245,.35)';
    g.lineWidth = 10;
    g.beginPath();
    for (let x = 0; x <= W + 12; x += 12) (x ? g.lineTo : g.moveTo).call(g, x, lineY(x, lv) + 7);
    g.stroke();
    g.restore();
  }

  sfx.register('underwater', underwater);
})();
