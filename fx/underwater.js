/* ScreenFX effect module — registers into the runtime in content.js. */
(() => {
  const sfx = window.__screenFX;
  if (!sfx || !sfx.kit) return;
  const { R, rand, clamp, div, loop, canvasLayer, gl, lockScroll } = sfx.kit;

  /* ========================================================================
   * UNDERWATER — the page floods. The waterline rises from the bottom, the
   * page is seen through moving water, then it drains away.
   *
   * Physical model:
   *  Surface   sum of 8 deep-water sine waves, h = Σ Aᵢ sin(kᵢ·x − ωᵢt + φᵢ),
   *            dispersion ωᵢ = √(g kᵢ) (g scaled to screen px), steepness Aᵢkᵢ
   *            ≈ 0.035. Gradient and Hessian are analytic.
   *  Refraction  n = normalize(−∇h, 1); Snell via refract(view, n, 1/1.333);
   *            the page is sampled at x + d·R.xy/|R.z|, so text wobbles.
   *  Caustics  light refracted at the surface lands at x' = x − c∇h with
   *            c = D(1 − 1/n). Irradiance is the inverse area ratio of that
   *            map, I = 1/|det J|, det J = (1 − c hₓₓ)(1 − c h_yy) − c²hₓᵧ²
   *            (Jacobian / "Wallace" caustics, single pass). n differs per
   *            channel (1.331…1.340) → faint dispersion fringes.
   *  Absorption  Beer–Lambert T = exp(−K·(depth + viewing path)). Pure water
   *            (Pope & Fry 1997) is 0.34 / 0.057 / 0.0092 m⁻¹ at 650/550/450 nm;
   *            sea water adds particles and CDOM, so K is Jerlov oceanic
   *            type II: 0.40 / 0.085 / 0.062 m⁻¹ — red goes first, then green.
   *            In-scattering adds the water colour with 1 − exp(−b·z).
   *  Waterline  seen edge-on: a meniscus (thin magnifying film above the
   *            line), the bright edge, and below it the underside of the
   *            surface acting as a mirror (total internal reflection, θ >
   *            48.6°), fading with Fresnel.
   *  Bubbles   air spheres in water are diverging lenses: a minified upright
   *            image inside, a total-internal-reflection rim where the
   *            incidence exceeds the critical angle (ρ > 1/1.333). Rise at
   *            terminal velocity (≈ 0.25 m/s, slower when small), zig-zag
   *            path instability, and grow on the way up (Boyle: r ∝ P^(−1/3)).
   *  Fish      carangiform swimmers: lateral body wave h(s,t) = a(s)·
   *            sin(2π(s/λ − f t)), a(s) = L(0.02 − 0.08s + 0.16s²) (Videler),
   *            speed U ≈ 0.7·L·f, countershaded, hazed by the same Beer–
   *            Lambert law for their distance. Three depth layers → parallax.
   *  Draining  Torricelli: the level falls as h(t) = h₀(1 − t/T)².
   * ====================================================================== */

  const NB = 20;                     // bubble slots in the shader
  const G = 229;                     // px/s², shared by every wave so they disperse alike
  const SIG = [0.40, 0.085, 0.062];  // m⁻¹, Jerlov oceanic II K_d (Pope & Fry water + particles)
  const BAND = 22;                   // TIR mirror band under the waterline, px
  const TAU = Math.PI * 2;

  const FRAG = `
uniform float uLevel;
uniform float uAmp;
uniform float uT;
uniform float uRefr;
uniform float uCaus;
uniform vec4 uW[8];
uniform vec4 uB[${NB}];

const vec3 SIG = vec3(0.40, 0.085, 0.062);
const float BAND = ${BAND.toFixed(1)};

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

float rays(vec2 p, float dz) {
  vec2 v = p - vec2(uRes.x * 0.3, -uRes.y * 1.3);
  float u = v.x / v.y * uRes.y;
  float r = 0.65 * vnoise(vec2(u * 0.011, uT * 0.2)) + 0.35 * vnoise(vec2(u * 0.031 + 3.0, uT * 0.33 + 9.0));
  r = smoothstep(0.44, 0.78, r);
  return r * r * exp(-dz / (uRes.y * 0.75)) * smoothstep(0.0, 50.0, dz);
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

void main() {
  vec2 p = cssPos();
  float yl = lineY(p.x);
  float dz = p.y - yl;
  bool hasPage = uHasPage > 0.5;
  // dry: transparent, so the live page shows through at full sharpness
  if (dz < -9.0) { gl_FragColor = vec4(0.0); return; }

  vec2 grad; vec3 hs;
  waves(p, grad, hs);
  float wIn = smoothstep(0.0, 26.0, dz);

  // Snell refraction through the moving surface
  vec3 Rr = refract(vec3(0.0, 0.0, -1.0), normalize(vec3(-grad, 1.0)), 0.7502);
  vec2 off = uRefr * Rr.xy / max(-Rr.z, 0.2) * wIn;

  // depth (m) and Beer–Lambert transmittance along sun path + view path
  float dm = 1.0 + 4.6 * clamp(max(dz, 0.0) / uRes.y, 0.0, 1.3);
  float Zv = 1.5;
  vec3 Tr = exp(-SIG * (dm + Zv));
  vec3 waterC = vec3(0.0, 0.19, 0.25) * exp(-SIG * dm * 0.6) + vec3(0.0, 0.02, 0.04);
  float haze = 1.0 - exp(-0.42 * (Zv + dm * 0.35));

  // caustics: irradiance = 1/|det J| of the refraction map, per wavelength
  vec2 xs = p + uCaus * grad;
  vec2 g2; vec3 h2;
  waves(xs, g2, h2);
  vec3 kk = vec3(0.985, 1.0, 1.015);
  vec3 a = kk * uCaus * h2.x, b = kk * uCaus * h2.y, c = kk * uCaus * h2.z;
  vec3 det = (1.0 - a) * (1.0 - b) - c * c;
  vec3 I = min(1.0 / (abs(det) + 0.2), 4.0) * 0.82;
  float causAmt = exp(-dm * 0.32) * wIn;
  vec3 caus = 1.0 + (I - 1.0) * 0.5 * causAmt;

  float ry = rays(p, dz);
  float sn = snow(p, 150.0, vec2(0.05, -0.035), 3.7, 2.6) * 0.8 + snow(p, 70.0, vec2(0.03, -0.02), 11.3, 1.3) * 0.55;
  sn *= wIn;
  vec3 sunC = vec3(0.78, 0.94, 1.0);

  vec3 col;
  vec3 em;          // light added on top (overlay mode uses only this)
  float cover = 0.0;
  if (dz < 0.0) {
    // meniscus: a thin film climbing the page, magnifying toward the line
    float men = smoothstep(-9.0, 0.0, dz);
    vec3 pg = page(p + vec2(0.0, 3.5 * men * men));
    col = pg * mix(vec3(1.0), vec3(0.9, 1.0, 1.02), men);
    em = vec3(0.85, 0.97, 1.0) * exp(-pow((dz + 1.6) / 1.3, 2.0)) * 0.5;
    cover = men * 0.25;
  } else {
    vec3 pg = page(p + off);
    vec3 light = 0.8 * caus;
    col = pg * light * Tr + waterC * haze;
    em = sunC * exp(-SIG * dm * 0.7) * (ry * 0.42) + sunC * sn * Tr * 0.55 + vec3(0.5, 0.85, 1.0) * 0.14 * exp(-dz / 110.0);
    if (dz < BAND) {
      // the underside of the surface, seen at grazing incidence: a mirror
      float k = dz / BAND;
      vec3 rc = page(vec2(p.x + off.x * 2.0, yl + BAND + (BAND - dz) * 1.4)) * Tr * 0.92 + waterC * haze;
      float fr = pow(1.0 - k, 1.5) * 0.78;
      col = mix(col, rc, fr);
      em += vec3(0.8, 0.95, 1.0) * exp(-dz / 1.7) * 0.55;
      cover = fr * 0.45;
    }
    cover = max(cover, 0.0);
  }

  // bubbles
  float bCov = 0.0;
  vec3 bAcc = vec3(0.0);
  for (int i = 0; i < ${NB}; i++) {
    vec4 B = uB[i];
    if (B.w <= 0.0) continue;
    vec2 d = p - B.xy;
    float rho = length(d) / B.z;
    if (rho > 1.0) continue;
    vec2 u = d / B.z;
    vec3 inside = page(B.xy + d * 0.38 + off) * Tr * 1.08 + waterC * haze * 0.7;
    float tir = smoothstep(0.66, 0.84, rho);
    vec3 env = mix(vec3(0.82, 0.96, 1.0), waterC * 1.4 + 0.04, smoothstep(-0.9, 0.9, u.y));
    vec2 hl = u - vec2(-0.33, -0.4);
    float spec = exp(-dot(hl, hl) * 38.0);
    float aa = (1.0 - smoothstep(1.0 - 1.4 / B.z, 1.0, rho)) * B.w;
    vec3 bc = mix(hasPage ? inside : vec3(0.0), env, tir) + spec;
    col = mix(col, bc, aa);
    bAcc = mix(bAcc, env * tir + spec, aa);
    bCov = max(bCov, aa * max(tir, spec));
  }

  if (hasPage) {
    gl_FragColor = vec4(col + em, 1.0);
  } else {
    // live page underneath: only light, the mirror band and the bubble rims are ours
    vec3 L = em + sunC * max(caus - 1.0, 0.0) * 0.22 * causAmt + bAcc;
    float A = clamp(max(max(L.r, L.g), L.b) * 0.9 + cover + bCov, 0.0, 1.0);
    vec3 C = mix(L, mix(waterC * 2.2, L, 0.5), cover);
    gl_FragColor = vec4(C / max(A, 1e-3), A);
  }
}
`;

  const governor = (fx) => {
    let n = 0, acc = 0, last = performance.now(), done = false;
    return () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (done || ++n < 6) return;
      acc += dt;
      if (n >= 30) {
        done = true;
        if (acc / (n - 5) > 24) {
          fx.canvas.width = Math.round(fx.W * fx.dpr * 0.7);
          fx.canvas.height = Math.round(fx.H * fx.dpr * 0.7);
        }
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
    const PXM = H / 4.6;                // px per metre of depth (matches the shader)

    let clock = 0;                      // animation time, s (slower when reduced)
    const lineY = (x, lv) =>
      lv + AMP * (5 * Math.sin(x * 0.0105 - clock * 1.551 + 0.4) + 2.6 * Math.sin(x * 0.023 + clock * 2.295 + 1.7) + 1.2 * Math.sin(x * 0.051 - clock * 3.418));

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

    // Beer–Lambert colour of an object at screen y, `hz` (0..1) of the way into the haze
    const waterify = (rgb, y, lv, hz) => {
      const dm = 1.0 + 4.6 * clamp((y - lv) / H, 0, 1.3);
      const out = [];
      for (let i = 0; i < 3; i++) {
        const T = Math.exp(-SIG[i] * (dm + 1.5 + hz * 2.2)) * 0.8;
        const wc = [0.0, 0.19, 0.25][i] * Math.exp(-SIG[i] * dm * 0.6) + [0, 0.02, 0.04][i];
        const hzz = 1 - Math.exp(-0.42 * (1.5 + dm * 0.35 + hz * 3));
        out.push(Math.round(255 * clamp(rgb[i] / 255 * T + wc * hzz, 0, 1)));
      }
      return out;
    };

    /* ---- bubbles --------------------------------------------------------- */
    const bubbles = [];
    const vents = [rand(0.08, 0.3), rand(0.4, 0.62), rand(0.7, 0.94)].map((k) => ({ x: k * W, next: rand(0, 600) }));
    const bubbleBuf = new Float32Array(NB * 4);
    const stepBubbles = (dt, t, lv) => {
      const s = dt / 1000;
      if (t < T2 + f.outro * 0.15 && lv < H - 40) {
        for (const v of vents) {
          v.next -= dt;
          if (v.next <= 0 && bubbles.length < NB) {
            const r0 = Math.random() < 0.25 ? rand(4, 7) : rand(1.6, 4);
            bubbles.push({ x: v.x + rand(-6, 6), x0: v.x + rand(-6, 6), y: H + 8, r0, r: r0, ph: rand(0, TAU), a: 0, age: 0 });
            v.next = Math.random() < 0.7 ? rand(90, 260) : rand(700, 1800);   // trains, then pauses
            if (RM) v.next *= 2.5;
          }
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
        b.r = b.r0 * Math.cbrt((1 + 0.0981 * 5.6) / (1 + 0.0981 * (d + 1.0)));  // Boyle: P = 1 atm + ρgd
        b.a = Math.min(1, b.age * 6);
        if (b.y < lineY(b.x, lv) + b.r || b.y < -20) bubbles.splice(i, 1);
      }
      bubbleBuf.fill(0);
      bubbles.forEach((b, i) => bubbleBuf.set([b.x, b.y, b.r, b.a], i * 4));
    };

    /* ---- fish -------------------------------------------------------------- */
    const SPECIES = {
      sardine: { back: [38, 72, 98], flank: [158, 182, 196], belly: [232, 238, 240], fin: [120, 150, 165], spots: true },
      mullet: { back: [70, 86, 92], flank: [168, 178, 180], belly: [226, 228, 224], fin: [110, 120, 118], spots: false },
      jack: { back: [52, 92, 110], flank: [176, 198, 204], belly: [236, 240, 238], fin: [196, 170, 90], spots: false }
    };
    // depth layer: apparent scale, haze, parallax speed factor
    const FS = clamp(Math.min(W, H) / 760, 0.6, 1.4);            // fish scale with the viewport
    const LAYERS = [{ s: 0.5 * FS, hz: 0.8 }, { s: 0.78 * FS, hz: 0.5 }, { s: 1.12 * FS, hz: 0.18 }];
    const fishes = [];
    const spawn = (o) => {
      const L = o.L * LAYERS[o.layer].s;
      const U = o.bl * L * (RM ? 0.6 : 1);                        // body lengths / s
      fishes.push({
        ...o, L, U, f: U / (0.7 * L), ph: rand(0, TAU), vy: 0, wob: rand(0, TAU),
        sp: SPECIES[o.sp]
      });
    };
    const school = (dir, x0, y0) => {
      for (let i = 0; i < 7; i++) {
        spawn({ layer: 1, sp: 'sardine', L: 82 * rand(0.9, 1.1), bl: 1.7 * rand(0.96, 1.04), dir,
          x: x0 + rand(-90, 90) - dir * i * 18, y: y0 + rand(-45, 45), y0: 0, group: 1 });
      }
    };
    const startDir = Math.random() < 0.5 ? 1 : -1;
    school(startDir, W * rand(0.25, 0.6), H * rand(0.35, 0.6));
    spawn({ layer: 0, sp: 'mullet', L: 150, bl: 0.7, dir: -startDir, x: W * rand(0.2, 0.8), y: H * rand(0.2, 0.4) });
    spawn({ layer: 0, sp: 'jack', L: 130, bl: 0.8, dir: startDir, x: W * rand(0.1, 0.9), y: H * rand(0.65, 0.85) });
    spawn({ layer: 2, sp: 'jack', L: 160, bl: 1.25, dir: -startDir, x: -startDir > 0 ? -260 - rand(0, 900) : W + 260 + rand(0, 900), y: H * rand(0.45, 0.8) });
    fishes.forEach((F) => { F.y0 = F.y; });

    const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    const prof = (s) => Math.max(0, Math.sqrt(s) * (1.08 - s)) / 0.432;

    let gpu = true;                     // set once WebGL is known to exist
    const drawFish = (g, F, lv) => {
      const L = F.L, N = 14, BODY = 0.8;
      const beat = TAU * F.f * F.age + F.ph;
      const xs = [], ys = [], hh = [];
      let tailSlope = 0;
      for (let i = 0; i <= N; i++) {
        const s = i / N;
        const a = L * (0.02 - 0.08 * s + 0.16 * s * s);
        const lat = a * Math.sin(TAU * (s / 0.95) - beat);
        xs.push((0.5 - s * BODY) * L);
        ys.push(lat * 0.3);                           // we see the yaw wave slightly from above
        hh.push(L * 0.115 * prof(s));
        if (i === N) tailSlope = (a * TAU / 0.95) * Math.cos(TAU * (s / 0.95) - beat) / (BODY * L);
      }
      const hz = LAYERS[F.layer].hz;
      const back = waterify(F.sp.back, F.y, lv, hz);
      const flank = waterify(F.sp.flank, F.y, lv, hz);
      const belly = waterify(F.sp.belly, F.y, lv, hz);
      const fin = waterify(F.sp.fin, F.y, lv, hz);

      g.save();
      // depth of field + forward scatter; software canvases (no GPU) render filters badly
      if (F.layer < 2 && gpu) g.filter = F.layer ? 'blur(0.5px)' : 'blur(1.1px)';
      g.translate(F.x, F.y);
      g.rotate(clamp(F.vy / Math.max(30, F.U), -0.3, 0.3) * F.dir);
      g.scale(F.dir, 1);

      // caudal fin: vertical, foreshortened as the tail sweeps toward/away from us
      const tx = xs[N], ty = ys[N];
      const cf = Math.max(0.25, Math.abs(Math.cos(Math.atan(tailSlope * 2.2))));
      g.fillStyle = rgb(fin, 0.82);
      g.beginPath();
      g.moveTo(tx + 2, ty - hh[N] * 0.9);
      g.quadraticCurveTo(tx - 0.12 * L * cf, ty - 0.1 * L, tx - 0.22 * L * cf, ty - 0.19 * L);
      g.quadraticCurveTo(tx - 0.12 * L * cf, ty - 0.03 * L, tx - 0.1 * L * cf, ty);
      g.quadraticCurveTo(tx - 0.12 * L * cf, ty + 0.03 * L, tx - 0.22 * L * cf, ty + 0.19 * L);
      g.quadraticCurveTo(tx - 0.12 * L * cf, ty + 0.1 * L, tx + 2, ty + hh[N] * 0.9);
      g.closePath();
      g.fill();

      // dorsal + anal fins
      const fy = (i) => ys[i];
      g.beginPath();
      g.moveTo(xs[5], fy(5) - hh[5] * 0.95);
      g.lineTo(xs[6] + 0.02 * L, fy(6) - hh[6] - 0.09 * L);
      g.lineTo(xs[8], fy(8) - hh[8] * 0.95);
      g.closePath();
      g.moveTo(xs[9], fy(9) + hh[9] * 0.9);
      g.lineTo(xs[10], fy(10) + hh[10] + 0.05 * L);
      g.lineTo(xs[11], fy(11) + hh[11] * 0.9);
      g.closePath();
      g.fill();

      // body, countershaded: dark back, silver flank, white belly
      const gr = g.createLinearGradient(0, -0.12 * L, 0, 0.11 * L);
      gr.addColorStop(0, rgb(back));
      gr.addColorStop(0.42, rgb(back));
      gr.addColorStop(0.58, rgb(flank));
      gr.addColorStop(1, rgb(belly));
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(xs[0] + 0.012 * L, ys[0]);
      for (let i = 0; i <= N; i++) g.lineTo(xs[i], ys[i] - hh[i]);
      for (let i = N; i >= 0; i--) g.lineTo(xs[i], ys[i] + hh[i] * 0.92);
      g.closePath();
      g.fill();

      // flank flash: silver scales catching the light as the body yaws
      const flash = Math.max(0, Math.sin(beat - 0.6)) * (1 - hz) * 0.28;
      if (flash > 0.01) {
        g.fillStyle = `rgba(235,248,255,${flash.toFixed(3)})`;
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
      g.fillStyle = rgb(waterify([215, 220, 210], F.y, lv, hz));
      g.beginPath(); g.arc(xs[1] - 0.005 * L, ys[1] - hh[1] * 0.2, 0.03 * L, 0, TAU); g.fill();
      g.fillStyle = rgb(waterify([12, 16, 20], F.y, lv, hz));
      g.beginPath(); g.arc(xs[1] - 0.003 * L, ys[1] - hh[1] * 0.2, 0.018 * L, 0, TAU); g.fill();
      g.restore();
    };

    const stepFish = (dt) => {
      const s = dt / 1000;
      for (const F of fishes) {
        F.age = (F.age || 0) + s;
        F.x += F.dir * F.U * s;
        const ny = F.y0 + Math.sin(F.age * 0.35 + F.wob) * H * 0.04;
        F.vy = (ny - F.y) / Math.max(s, 1e-3);
        F.y = ny;
        const off = F.L + 40;
        if ((F.dir > 0 && F.x > W + off) || (F.dir < 0 && F.x < -off)) {
          // swim back in later from the far side
          F.dir = Math.random() < 0.5 ? 1 : -1;
          F.x = F.dir > 0 ? -off - rand(0, F.group ? 200 : 1400) : W + off + rand(0, F.group ? 200 : 1400);
          F.y0 = clamp(F.y0 + rand(-H * 0.15, H * 0.15), H * 0.12, H * 0.88);
        }
      }
      // keep the school together: share the leader's heading
      const sc = fishes.filter((F) => F.group);
      if (sc.length && sc.some((F) => F.dir !== sc[0].dir)) {
        const lead = sc[0];
        sc.forEach((F, i) => {
          if (F === lead) return;
          F.dir = lead.dir;
          F.x = lead.x - lead.dir * (20 + i * 22) + rand(-40, 40);
          F.y0 = lead.y0 + rand(-45, 45);
        });
      }
    };
    fishes.sort((a, b) => a.layer - b.layer);

    /* ---- layers -------------------------------------------------------------- */
    const fx = gl(stage, FRAG, { snapshot: ctx.snapshot });
    let tint = null;
    if (!ctx.snapshot || !fx) {
      // no page pixels to absorb: approximate the water with a tinted,
      // slightly softened backdrop under a clip that follows the waterline
      css(`${R} .sfx-uw-tint{position:absolute;inset:0;
 background:linear-gradient(180deg,rgba(20,120,150,.24) 0%,rgba(12,84,118,.4) 55%,rgba(6,44,74,.56) 100%);
 -webkit-backdrop-filter:blur(.8px) saturate(.85) brightness(.9) hue-rotate(-10deg);
 backdrop-filter:blur(.8px) saturate(.85) brightness(.9) hue-rotate(-10deg);
 clip-path:inset(100% 0 0 0);}`);
      tint = div('sfx-uw-tint');
      stage.insertBefore(tint, stage.firstChild);
    }
    gpu = !!fx;
    if (ctx.snapshot && fx) lockScroll();
    const fishLayer = canvasLayer(stage);
    const fg = fishLayer.g;

    let gov = null;
    if (fx) {
      const wv = [];
      const dirs = [0.35, 1.05, -0.5, 2.3, -1.6, 0.8, 2.9, -2.6];
      const lens = [260, 205, 170, 140, 113, 96, 78, 64];
      for (let i = 0; i < 8; i++) {
        const k = TAU / lens[i], th = dirs[i] + rand(-0.15, 0.15);
        wv.push(Math.cos(th) * k, Math.sin(th) * k, Math.sqrt(G * k), 0.035 / k);
      }
      // water softens the page anyway: cap the buffer at 1.5x (dry pixels are
      // transparent, so the sharp live page is never replaced by this copy)
      if (fx.dpr > 1.5) {
        fx.dpr = 1.5;
        fx.canvas.width = Math.round(W * 1.5);
        fx.canvas.height = Math.round(H * 1.5);
      }
      fx.set('uW', new Float32Array(wv), '4fv');
      fx.set('uAmp', AMP);
      fx.set('uRefr', 52);
      fx.set('uCaus', 240);
      gov = governor(fx);
    }

    const frame = (t, raw) => {
      clock += (raw / 1000) * (RM ? 0.5 : 1);         // wall clock for the waves
      const dt = Math.min(raw, 100);                   // physics step, capped
      const lv = levelAt(t);
      stepBubbles(dt, t, lv);
      stepFish(dt);
      const fade = clamp(Math.min(t / 100, (total - t) / 150), 0, 1);
      if (fx) {
        fx.set('uLevel', lv);
        fx.set('uT', clock);
        fx.set('uB', bubbleBuf, '4fv');
        fx.canvas.style.opacity = String(fade);
        fx.draw(clock);
      }
      if (tint) {
        const pts = [];
        for (let x = 0; x <= W + 1; x += Math.max(24, W / 40)) pts.push(`${x.toFixed(0)}px ${lineY(x, lv).toFixed(1)}px`);
        pts.push(`${W}px ${lineY(W, lv).toFixed(1)}px`, `${W}px ${H}px`, `0px ${H}px`);
        tint.style.clipPath = `polygon(${pts.join(',')})`;
        tint.style.opacity = String(fade);
      }
      // fish (and, without WebGL, the bubbles) live only below the waterline
      fg.clearRect(0, 0, W, H);
      const wet = lv < H + 10;
      fishLayer.cv.style.visibility = wet ? 'visible' : 'hidden';   // nothing of ours left once drained
      if (wet) {
        fg.save();
        fg.beginPath();
        fg.moveTo(0, lineY(0, lv) + 3);
        for (let x = 24; x <= W + 24; x += 24) fg.lineTo(x, lineY(x, lv) + 3);
        fg.lineTo(W, H); fg.lineTo(0, H); fg.closePath();
        fg.clip();
        fg.globalAlpha = fade;
        for (const F of fishes) if (F.x > -F.L * 1.4 && F.x < W + F.L * 1.4) drawFish(fg, F, lv);
        if (!fx) drawBubbles2d(fg, bubbles);
        fg.restore();
        if (!fx) drawLine2d(fg, lv, lineY, W, fade);
      }
    };
    frame(0, 0);
    loop((dt, t, raw) => {
      if (t > total) return false;
      if (gov) gov();
      frame(t, raw === undefined ? dt : raw);
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
