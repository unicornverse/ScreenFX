/* Screenick effect module — registers into the runtime in content.js. */
(() => {
  const sfx = window.__screenick;
  if (!sfx || !sfx.kit) return;
  const { R, clamp, div, loop, canvasLayer, gl, lockScroll } = sfx.kit;

  /* ========================================================================
   * BLACK HOLE — a Schwarzschild hole opens over the page, lenses it, eats
   * it, then evaporates and lets it go.
   *
   * Physical model (all lengths in Schwarzschild radii rs = 2GM/c²):
   *
   *  Lensing of the page (the page is the background "sky"):
   *    deflection α(b) = smooth-max( 2/b + (15π/16)/b²           weak field, 2nd order
   *                                  −ln(b/b_c − 1) − 0.4002 )   Bozza 2002 strong limit
   *    b_c = 3√3/2 ≈ 2.598 (photon capture → the shadow), thin-lens map
   *    β = b − L·α(b)  (→ β = θ − θE²/θ far out, θE ≈ 2·b_c). β < 0 is the
   *    mirrored secondary image inside the Einstein ring.
   *
   *  Accretion disk (thin, optically thick, inclination i ≈ 80°), analytic, no
   *  ray march. A pixel at screen angle χ sees the disk point on its photon
   *  plane at bending angle ψ:  cot ψ = −sin χ · tan i.  Image radius from
   *  Beloborodov 2002, 1 − cos α = (1 − cos ψ)(1 − 1/r), b = r sin α/√(1 − 1/r),
   *  which is a quadratic in r (solved in closed form, with its ψ→π term
   *  re-weighted toward the weak-field Einstein radius b² = 2r). The lensed
   *  far side (ψ > π, the arc under the shadow and the thin arc over it) uses
   *  Bozza's exponential approach to b_c:  b − b_c ∝ e^{−(ψ−π)}.
   *    temperature   T(r) ∝ r^{−3/4} (1 − √(r_isco/r))^{1/4}, r_isco = 3
   *    redshift      g = √(1 − 1.5/r) / (1 + Ω·b_x·sin i),  Ω = √(0.5/r³)
   *                  (Doppler + gravitational; b_x is the photon's angular
   *                  momentum about the disk axis)
   *    observed      T_obs = g·T,  I_obs ∝ g⁴T⁴, colour = Planck B(λ, T_obs)
   *                  at 610/550/465 nm. Turbulence co-rotates at Kepler Ω.
   *
   *  Eating the page: the page's own pixels flow into a 2D sink-vortex
   *  (incompressible, so it stretches radially and squeezes tangentially —
   *  spaghettification for free):  r₀² = r² + E²(t),  φ₀ = φ − κ·ln(r₀/r),
   *  E² ∝ swallowed area, growing linearly (constant inflow). Matter heats as
   *  it nears the sink and glows as a blackbody.
   *
   *  Collapse: Hawking evaporation, M(t) ∝ (t_end − t)^{1/3}, T_H ∝ 1/M →
   *  it brightens as it shrinks, ends in one flash, and the page springs back
   *  out (the sink map run in reverse as a source with a damped overshoot).
   * ====================================================================== */

  const FRAG = `
uniform vec2 uC;
uniform float uRs;
uniform float uE2;
uniform float uSwirl;
uniform float uDisk;
uniform float uTd;
uniform float uRot;
uniform float uFlash;
uniform float uHawk;
uniform float uHot;
uniform vec2 uShake;
uniform vec2 uInc;
uniform vec2 uRoll;
uniform float uLens;

const float BC = 2.5980762;
const float ISCO = 3.0;
const float ROUT = 12.0;

vec3 planck(float T) {
  vec3 lam = vec3(0.610, 0.550, 0.465);
  vec3 l5 = lam * lam * lam * lam * lam;
  vec3 b = 1.0 / (l5 * (exp(min(vec3(80.0), 14388.0 / (lam * max(T, 450.0)))) - 1.0));
  return b / max(max(b.r, b.g), b.b);
}

// intensity -> colour, sampled from NASA's 2019 render (SVS 13326):
// #350000 -> #6d0000 -> #ca2400 -> #fd6800 -> #ffa647 -> #ffe7cf
vec3 nasa(float k) {
  k = clamp(k, 0.0, 1.0);
  vec3 c0 = vec3(0.208, 0.0, 0.0), c1 = vec3(0.427, 0.0, 0.0), c2 = vec3(0.792, 0.141, 0.0);
  vec3 c3 = vec3(0.992, 0.408, 0.0), c4 = vec3(1.0, 0.651, 0.278), c5 = vec3(1.0, 0.906, 0.812);
  vec3 c = mix(c0 * k / 0.12, c0, step(0.12, k));
  c = mix(c, mix(c0, c1, (k - 0.12) / 0.16), step(0.12, k));
  c = mix(c, mix(c1, c2, (k - 0.28) / 0.22), step(0.28, k));
  c = mix(c, mix(c2, c3, (k - 0.50) / 0.20), step(0.50, k));
  c = mix(c, mix(c3, c4, (k - 0.70) / 0.17), step(0.70, k));
  c = mix(c, mix(c4, c5, (k - 0.87) / 0.13), step(0.87, k));
  return c;
}

float lump(vec2 p) {
  return 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 5.2) + 0.15 * vnoise(p * 4.1 + 1.7);
}

// disk texture in the co-rotating (Keplerian) frame; two clocks cross-fade so
// differential rotation never winds the pattern into hairlines
float diskTex(vec2 dp, float r) {
  float om = sqrt(0.5 / (r * r * r)) * 16.0;
  float P = 7.0;
  float f = fract(uRot / P);
  float ta = f * P, tb = fract(f + 0.5) * P;
  float wa = 1.0 - abs(2.0 * f - 1.0);
  float a1 = om * ta, a2 = om * tb;
  vec2 pa = vec2(cos(a1) * dp.x + sin(a1) * dp.y, -sin(a1) * dp.x + cos(a1) * dp.y);
  vec2 pb = vec2(cos(a2) * dp.x + sin(a2) * dp.y, -sin(a2) * dp.x + cos(a2) * dp.y);
  float n = mix(lump(pb * 0.9 + 13.0), lump(pa * 0.9), wa);
  // fine, low-contrast filaments sheared along the orbit; hard concentric
  // stripes read as a vinyl record, not as turbulent plasma
  // fine laminar streaks along each orbit (NASA SVS 13326): a radial
  // stripe whose phase wanders with the turbulence, so it never reads as a
  // ruled set of circles
  float w = vnoise(dp * 1.3) * 4.0 + n * 9.0;
  float streak = 0.5 + 0.25 * sin(r * 17.0 + w) + 0.25 * sin(r * 41.0 + w * 1.7);
  return (0.5 + 0.7 * n) * (0.55 + 0.7 * streak);
}

// emitted radiance (rgb) and coverage (a) of the disk at radius r
vec4 diskShade(float r, vec2 dp, float bx) {
  if (r < ISCO - 0.25 || r > ROUT) return vec4(0.0);
  float rr = max(r, ISCO + 0.01);
  float f = pow(rr, -0.75) * pow(max(1.0 - sqrt(ISCO / rr), 0.0), 0.25) / 0.214;
  float om = sqrt(0.5 / (rr * rr * rr));
  float g = sqrt(max(1.0 - 1.5 / rr, 0.0)) / (1.0 + om * bx * uInc.x);
  float tex = diskTex(dp, rr);
  float T = uTd * (0.12 + f) * (0.8 + 0.35 * tex);
  float Tobs = g * T;
  float I = pow(Tobs / uTd, 4.0) * (0.35 + 0.8 * tex);
  float edge = smoothstep(ISCO - 0.25, ISCO + 0.35, r) * (1.0 - smoothstep(ROUT * 0.5, ROUT, r));
  float cover = edge * smoothstep(0.0, 0.25, edge) * clamp(0.82 + 0.3 * tex, 0.0, 1.0);
  // the colour is the intensity, through NASA's ramp; Doppler-boosted
  // gas climbs toward cream, the receding side sinks to deep red
  float k = 1.0 - exp(-I * 0.85 * edge * uDisk);
  return vec4(nasa(k), cover * min(uDisk * 2.0, 1.0));
}

vec3 space(vec2 s) {
  vec2 cell = floor(s / 38.0);
  vec2 h = hash22(cell);
  vec2 sp = (cell + 0.2 + 0.6 * h) * 38.0;
  float d2 = dot(s - sp, s - sp);
  float m = hash12(cell + 7.31);
  float star = step(0.8, m) * exp(-d2 / 1.3) * (m - 0.8) * 6.0;
  return vec3(0.004, 0.004, 0.011) + star * mix(vec3(1.0, 0.86, 0.72), vec3(0.74, 0.84, 1.0), h.x);
}

// where the page's matter now at source position s came from (sink-vortex)
vec3 matterAt(vec2 s, out float heat, out float inside) {
  vec2 d = s - uC;
  float r2 = dot(d, d) + 1e-3;
  float r = sqrt(r2);
  float r0 = uE2 >= 0.0 ? sqrt(r2 + uE2) : r2 / sqrt(r2 - uE2);
  float tw = uSwirl * log(r0 / r);
  float c = cos(tw), sn = sin(tw);
  vec2 p0 = uC + (r0 / r) * vec2(c * d.x - sn * d.y, sn * d.x + c * d.y);
  vec2 m = min(p0, uRes - p0);
  heat = uE2 > 0.0 ? uE2 / (r2 + uE2) : 0.0;
  // edges soften where the flow squeezes the page (r0/r large), instead of aliasing
  float w = 0.75 + 0.02 * r0 / r * r0 / r;
  inside = smoothstep(-w, w, min(m.x, m.y));
  return pageAt(clamp(p0 + uShake, vec2(0.5), uRes - 0.5)).rgb;
}

void main() {
  vec2 p = cssPos();
  vec2 d = p - uC;
  float bpx = length(d) + 1e-4;
  vec2 s = p;
  float shadow = 0.0;
  float a1 = 0.0, a2 = 0.0;
  float zdim = 1.0;
  float plane = 0.0;
  vec3 e1 = vec3(0.0), e2 = vec3(0.0), ring = vec3(0.0), halo = vec3(0.0);

  if (uRs > 0.25) {
    vec2 q = d / uRs; q.y = -q.y;
    q = vec2(uRoll.x * q.x + uRoll.y * q.y, -uRoll.y * q.x + uRoll.x * q.y);
    float b = bpx / uRs;

    // ---- lensing of the page
    float bb = max(b, BC + 1e-3);
    float weak = 2.0 / bb + 2.9452 / (bb * bb);
    float strong = -log(bb / BC - 1.0) - 0.4002;
    float alp = max(weak, strong) + log(1.0 + exp(-6.0 * abs(weak - strong))) / 6.0;
    s = uC + (d / bpx) * (b - uLens * alp) * uRs;
    shadow = 1.0 - smoothstep(BC * uRs - 1.2, BC * uRs + 0.6, bpx);

    // ---- accretion disk, primary image
    float sc = q.y / max(b, 1e-3), cc = q.x / max(b, 1e-3);
    float si = uInc.x, ci = uInc.y;
    float cpsi = -sc * si / sqrt(ci * ci + sc * sc * si * si);
    float spsi = sqrt(max(1.0 - cpsi * cpsi, 0.0));
    float x = 1.0 - cpsi;
    float A = x * (2.0 - x);
    float B = 0.5 * x * x * (2.0 - 0.5 * x);
    float hx = 0.5 * x;
    float Cc = 3.0 * hx * hx * hx * hx;
    float k = b * b - Cc;
    vec2 nd = vec2(spsi * cc, spsi * sc * ci - cpsi * si);
    if (k > 0.0) {
      float r1 = 2.0 * k / (B + sqrt(B * B + 4.0 * A * k));
      vec4 sh = diskShade(r1, r1 * nd, q.x);
      e1 = sh.rgb; a1 = sh.a;
    }
    // ---- lensed far side (ψ = ψ1 + π) and the photon ring
    if (b > BC) {
      float psi1 = atan(spsi, cpsi);
      float bpi = (b - BC) * exp(psi1) + BC;
      float r2 = (bpi * bpi - 3.0) * 0.5;
      vec4 sh = diskShade(r2, -r2 * nd, q.x);
      // higher-order images pile up against the shadow as a hairline ring;
      // keep the gap clean, as the user asked
      float gapCut = smoothstep(BC * 1.17, BC * 1.25, b);
      e2 = sh.rgb; a2 = sh.a * gapCut;
      float om = sqrt(0.5 / 64.0);
      float g = sqrt(1.0 - 1.5 / 4.0) / (1.0 + om * q.x * si);
      ring = vec3(0.0);   // the reference renders show at most a faint hairline; drawn as nothing
    }
    // scattered disk light: a thin warm glow hugging the disk plane, not a disc
    halo = vec3(0.0);
    // gravitational redshift of everything seen close to the horizon: light
    // climbing out loses energy (1+z = 1/sqrt(1 - rs/r)), so infalling page
    // matter reddens and fades to black instead of piling up as bright rings
    // pure black from the shadow out to the inner edge of the lensed arcs
    // (~1.25x the photon ring in the NASA render): light from that close is
    // redshifted away, so there is nothing to see — no lensed page junk
    // the gap only exists framed by the lit arcs: tie it to the disk, so the
    // hole never shows as a bare black ball with a dark rim
    zdim = mix(1.0, smoothstep(BC * 1.22, BC * 1.32, b), smoothstep(4.0, 14.0, uRs) * smoothstep(0.3, 0.9, uDisk));
    // infalling gas settles into the disk plane before it is swallowed
    plane = exp(-abs(q.y) * 0.45);
  }

  // ---- the page: lensed, then traced back through the sink flow
  float heat, inside;
  vec3 page = matterAt(s, heat, inside);
  float glow = smoothstep(0.8, 1.0, heat);
  glow = glow * glow * inside * uHot;
  glow *= zdim * (0.15 + 0.85 * plane);
  float Tm = 1100.0 + 1700.0 * glow;
  vec3 hot = planck(Tm) * glow * (0.05 + 0.22 * glow);
  // redshift: blue goes first, then green, then it is gone
  page *= zdim;
  // the page's own Einstein ring (s -> centre, infinitely compressed): a
  // hairline of nothing, hidden rather than drawn as a grey hoop
  page *= 1.0 - smoothstep(0.985, 0.9995, heat);
  vec3 bg;
  float bgA;
  if (uHasPage > 0.5) {
    bg = mix(space(s), page * (1.0 - 0.75 * glow), inside);
    bgA = 1.0;
  } else {
    // live page underneath: only the void and the hot streams are ours
    float streams = 0.35 + 0.9 * fbm((s - uC) * 0.012 + vec2(0.0, uE2 * 1e-5));
    hot *= streams;
    bg = space(s);
    bgA = (1.0 - inside);
  }
  bg *= (1.0 - shadow) * zdim;
  bgA = max(bgA, shadow);

  float occ = (1.0 - a2) * (1.0 - a1);
  vec3 em = hot * (1.0 - shadow) * occ + halo;
  vec3 disk = e2 * a2 * (1.0 - a1) + e1 * a1;
  em += uHawk * (exp(-bpx / 26.0) * 3.0 + exp(-bpx / 140.0) * 0.5) * vec3(0.82, 0.9, 1.0);
  em += uFlash * (2.6 * exp(-bpx / (0.22 * max(uRes.x, uRes.y))) + 0.35) * vec3(1.0, 0.97, 0.93);
  float Lm = max(max(em.r, em.g), em.b);
  vec3 lit = Lm > 1e-5 ? em * ((1.0 - exp(-Lm * 1.25)) / Lm) : vec3(0.0);
  // only the very hottest cores bleach toward white, as film does
  lit = mix(lit, vec3(1.0), smoothstep(1.6, 4.0, Lm) * 0.35);
  float cover = max(bgA, max(a1, a2));
  vec3 col = bg * occ + disk + lit;
  if (uHasPage > 0.5) {
    gl_FragColor = vec4(col, 1.0);
  } else {
    float A = clamp(cover + max(lit.r, max(lit.g, lit.b)), 0.0, 1.0);
    col = bg * occ + disk + lit;
    gl_FragColor = vec4(col / max(A, 1e-3), A);
  }
}
`;

  /* A frame-time governor: if the GPU cannot keep up at full resolution,
     drop the drawing buffer once to 70%. Uniforms and textures survive a
     canvas resize, so this costs nothing but sharpness. */
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

  // damped camera shake, in CSS px
  const shakeAt = (t, t0, amp, dur) => {
    const u = (t - t0) / dur;
    if (u < 0 || u > 1) return [0, 0];
    const a = amp * Math.pow(1 - u, 2);
    const w = (t - t0) / 1000;
    return [a * Math.sin(w * 71 + 1.3) * Math.cos(w * 23), a * Math.sin(w * 59 + 0.4)];
  };

  function blackhole(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const f = ctx.fit(1700, 1700, 600);
    const total = f.intro + f.hold + f.outro;
    const T1 = f.intro, T2 = f.intro + f.hold;
    const RM = ctx.reduced;
    const cx = W / 2, cy = H / 2;
    const D = Math.hypot(W, H) / 2;
    const R0 = clamp(Math.min(W, H) * 0.04, 18, 56);       // rs in CSS px
    const EMAX = D * (RM ? 0.75 : 1.03);
    const SWIRL = RM ? 0.45 : 1.15;
    const COLLAPSE = 0.4;                                    // share of the outro
    const tFlash = T2 + f.outro * COLLAPSE;
    const incl = 80 * Math.PI / 180, roll = -7 * Math.PI / 180;

    // shared timeline → physical parameters at time t (ms)
    const state = (t) => {
      let rs = 0, e2 = 0, disk = 0, hawk = 0, flash = 0, hot = 1;
      if (t < T1) {
        const u = t / T1;
        rs = R0 * (1 - Math.pow(1 - u, 3));
        disk = Math.pow(clamp(u / 0.45, 0, 1), 0.8);   // ignites with the hole
        e2 = EMAX * EMAX * 0.03 * u * u;
      } else if (t < T2) {
        const v = (t - T1) / Math.max(1, f.hold);
        rs = R0 * (1 + 0.22 * v);                    // it grows as it feeds
        disk = 1 + 0.35 * v;                         // accretion-powered
        e2 = EMAX * EMAX * (0.03 + 0.97 * Math.pow(v, 1.6)); // Bondi: Ṁ ∝ M², runs away
      } else if (t < tFlash) {
        const a = (t - T2) / (tFlash - T2);
        rs = R0 * 1.22 * Math.cbrt(Math.max(0, 1 - a));      // M ∝ τ^(1/3)
        disk = 1.35 * (1 - a) * (1 - a);
        hawk = Math.pow(a, 3);                               // T_H ∝ 1/M
        e2 = EMAX * EMAX;
      } else {
        const bt = clamp((t - tFlash) / Math.max(1, total - tFlash), 0, 1);
        let x = Math.exp(-6.2 * bt) * Math.cos(9.2 * bt);   // one overshoot, settled well before the end
        if (x < 0) x *= 0.6;
        x *= 1 - smooth(0.7, 0.92, bt);
        e2 = EMAX * EMAX * x;
        hot = Math.max(0, 1 - bt * 3);
      }
      if (t >= tFlash - 40) {
        const k = (t - tFlash) / (RM ? 260 : 170);
        flash = (t < tFlash ? (t - tFlash + 40) / 40 : Math.exp(-k)) * (RM ? 0.35 : 1);
      }
      return { rs, e2, disk, hawk, flash, hot };
    };

    const gfx = gl(stage, FRAG, { snapshot: ctx.snapshot });
    if (!gfx) return fallback2d(stage, css, ctx, { W, H, cx, cy, R0, EMAX, SWIRL, total, state, T1, tFlash });

    if (ctx.snapshot) lockScroll();
    else {
      // no page pixels to bend: blur and darken the live page around the hole
      css(`${R} .sfx-bh-lens{position:absolute;left:50%;top:50%;border-radius:50%;
 -webkit-backdrop-filter:blur(3px) brightness(.7) saturate(1.3);backdrop-filter:blur(3px) brightness(.7) saturate(1.3);
 -webkit-mask-image:radial-gradient(closest-side,#000 40%,rgba(0,0,0,.5) 70%,transparent);mask-image:radial-gradient(closest-side,#000 40%,rgba(0,0,0,.5) 70%,transparent);
 transform:translate(-50%,-50%) scale(0);}`);
      const lens = div('sfx-bh-lens', `width:${(R0 * 22).toFixed(0)}px;height:${(R0 * 22).toFixed(0)}px;`);
      stage.insertBefore(lens, gfx.canvas);
      gfx.lensEl = lens;
    }

    gfx.set('uC', [cx, cy]);
    gfx.set('uSwirl', SWIRL);
    gfx.set('uTd', 2750);
    gfx.set('uInc', [Math.sin(incl), Math.cos(incl)]);
    gfx.set('uRoll', [Math.cos(roll), Math.sin(roll)]);
    gfx.set('uLens', 6.0);
    const gov = governor(gfx);
    const cv = gfx.canvas;
    // The page on screen is bent out of place, so the real page underneath
    // must not take clicks: a click would land on whatever control happens
    // to sit there (a form, a link) with no visible target. The canvas
    // catches them; the dismiss button sits above it and still works.
    if (ctx.snapshot) {
      cv.style.pointerEvents = 'auto';
      cv.style.cursor = 'default';
      cv.addEventListener('pointerdown', (e) => e.preventDefault());
    }

    let rot = 0;
    const frame = (t, raw) => {
      const st = state(t);
      rot += (raw / 1000) * (RM ? 0.5 : 1);           // wall clock: the disk keeps its speed at low fps
      let sh = [0, 0];
      if (!RM) {
        const a = shakeAt(t, 0, 5, 750), b = shakeAt(t, tFlash, 11, 700);
        sh = [a[0] + b[0], a[1] + b[1]];
      }
      gfx.set('uRs', st.rs);
      gfx.set('uE2', st.e2);
      gfx.set('uDisk', st.disk);
      gfx.set('uHawk', st.hawk);
      gfx.set('uFlash', st.flash);
      gfx.set('uHot', st.hot * Math.min(1, st.rs / R0 + (t > tFlash ? 1 : 0)));
      gfx.set('uRot', rot);
      gfx.set('uShake', sh);
      // seamless edges: the frame is the page at both ends, fade the layer anyway
      cv.style.opacity = String(clamp(Math.min(t / 140, (total - t) / 180), 0, 1));
      if (gfx.lensEl) {
        const k = st.rs / R0;
        gfx.lensEl.style.transform = `translate(-50%,-50%) scale(${(k * (1 + st.e2 / (EMAX * EMAX) * 0.8)).toFixed(3)})`;
      }
      gfx.draw(t / 1000);
    };
    frame(0, 0);
    loop((dt, t, raw) => {
      if (t > total) return false;
      gov();
      frame(t, raw === undefined ? dt : raw);
    });
    return total;
  }

  function smooth(a, b, x) {
    const u = clamp((x - a) / (b - a), 0, 1);
    return u * u * (3 - 2 * u);
  }

  /* No WebGL. Canvas 2D can still do the radial part of the physics: the
     lens + sink map is radially symmetric, so the page is redrawn in thin
     annuli, each scaled and twisted by that ring's mapping. The disk is
     drawn as gradients with the same Doppler asymmetry. */
  function fallback2d(stage, css, ctx, o) {
    const { W, H, cx, cy, EMAX, SWIRL, total, state } = o;
    const { g } = canvasLayer(stage);
    const img = ctx.snapshot;
    if (img) lockScroll();
    const D = Math.hypot(W, H) / 2;
    const BC = 2.598;
    const rings = [];
    for (let b = 2; b < D + 40; b += Math.max(2, b * 0.028)) rings.push(b);

    const lensMap = (bpx, rs) => {
      if (rs < 0.3) return bpx;
      const b = Math.max(bpx / rs, BC + 1e-3);
      const weak = 2 / b + 2.9452 / (b * b), strong = -Math.log(b / BC - 1) - 0.4002;
      const a = Math.max(weak, strong) + Math.log(1 + Math.exp(-6 * Math.abs(weak - strong))) / 6;
      return (bpx / rs - 13.5 * a) * rs;
    };

    loop((dt, t) => {
      if (t > total) return false;
      const st = state(t);
      g.clearRect(0, 0, W, H);
      g.globalAlpha = clamp(Math.min(t / 140, (total - t) / 180), 0, 1);
      if (img) {
        g.fillStyle = '#020205';
        g.fillRect(0, 0, W, H);
        for (let i = 0; i < rings.length - 1; i++) {
          const b0 = rings[i], b1 = rings[i + 1], bm = (b0 + b1) / 2;
          if (b1 < BC * st.rs) continue;
          const s = lensMap(bm, st.rs);
          const as = Math.abs(s) + 1e-3;
          const r0 = st.e2 >= 0 ? Math.sqrt(as * as + st.e2) : (as * as) / Math.sqrt(as * as - st.e2);
          const m = (r0 / bm) * Math.sign(s || 1);
          const tw = SWIRL * 0.35 * Math.log(r0 / as);   // annuli step the twist: keep it gentle
          g.save();
          g.beginPath();
          g.arc(cx, cy, b1 + 0.6, 0, Math.PI * 2);
          g.arc(cx, cy, Math.max(0, b0 - 0.6), 0, Math.PI * 2, true);
          g.clip();
          g.translate(cx, cy);
          g.rotate(-tw);
          g.scale(1 / m, 1 / m);
          g.translate(-cx, -cy);
          g.drawImage(img, 0, 0, W, H);
          g.restore();
        }
      } else {
        const k = clamp(st.e2 / (EMAX * EMAX), 0, 1);
        const vg = g.createRadialGradient(cx, cy, 0, cx, cy, D);
        vg.addColorStop(0, `rgba(2,2,6,${(0.5 + 0.5 * k).toFixed(3)})`);
        vg.addColorStop(clamp(1 - k, 0.05, 1), `rgba(2,2,6,${(0.25 + 0.75 * k).toFixed(3)})`);
        vg.addColorStop(1, `rgba(2,2,6,${(0.1 + 0.9 * k * k).toFixed(3)})`);
        g.fillStyle = vg;
        g.fillRect(0, 0, W, H);
      }
      const rs = st.rs;
      if (rs > 0.3) {
        const L = Math.min(1.2, st.disk);
        g.save();
        g.translate(cx, cy);
        g.rotate(-0.12);
        g.globalCompositeOperation = 'lighter';
        // thin disk seen at i = 80°: concentric ellipses, ry = r·cos i; the
        // approaching (left) side Doppler-boosted, T ∝ r^-3/4 → I ∝ r^-3
        const band = (front) => {
          for (let r = 3.2; r < 12; r += 0.5) {
            const a = clamp(L * Math.pow(3.2 / r, 1.5) * 0.55, 0, 1);
            const gr = g.createLinearGradient(-r * rs, 0, r * rs, 0);
            gr.addColorStop(0, `rgba(255,244,226,${a.toFixed(3)})`);
            gr.addColorStop(0.5, `rgba(255,190,120,${(a * 0.6).toFixed(3)})`);
            gr.addColorStop(1, `rgba(220,90,30,${(a * 0.22).toFixed(3)})`);
            g.strokeStyle = gr;
            g.lineWidth = rs * 0.55;
            g.beginPath();
            g.ellipse(0, 0, r * rs, r * rs * 0.17, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2);
            g.stroke();
          }
        };
        band(false);
        // lensed far side: arcs bent over the shadow at b = sqrt(2r + 3)
        for (let r = 3.2; r < 10; r += 0.5) {
          const bb = Math.sqrt(2 * r + 3) * rs;
          const a = clamp(L * Math.pow(3.2 / r, 1.5) * 0.5, 0, 1);
          g.strokeStyle = `rgba(255,214,160,${a.toFixed(3)})`;
          g.lineWidth = rs * 0.5;
          g.beginPath();
          g.ellipse(0, 0, bb, bb * 0.92, 0, Math.PI * 1.06, Math.PI * 1.94);
          g.stroke();
        }
        g.globalCompositeOperation = 'source-over';
        g.fillStyle = '#000';
        g.beginPath(); g.arc(0, 0, rs * BC, 0, Math.PI * 2); g.fill();
        g.globalCompositeOperation = 'lighter';
        g.strokeStyle = `rgba(255,230,200,${(0.8 * Math.min(1, L)).toFixed(3)})`;
        g.lineWidth = 1.5;
        g.beginPath(); g.arc(0, 0, rs * BC * 1.03, 0, Math.PI * 2); g.stroke();
        band(true);
        g.restore();
        g.globalCompositeOperation = 'source-over';
      }
      if (st.flash > 0.01 || st.hawk > 0.01) {
        g.globalCompositeOperation = 'lighter';
        const fl = g.createRadialGradient(cx, cy, 0, cx, cy, D);
        const a = clamp(st.flash * 0.9 + st.hawk * 0.4, 0, 1);
        fl.addColorStop(0, `rgba(255,250,240,${a.toFixed(3)})`);
        fl.addColorStop(0.4, `rgba(255,240,220,${(a * 0.35).toFixed(3)})`);
        fl.addColorStop(1, 'rgba(255,240,220,0)');
        g.fillStyle = fl;
        g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = 'source-over';
      }
      g.globalAlpha = 1;
    });
    return total;
  }

  sfx.register('blackhole', blackhole);
})();
