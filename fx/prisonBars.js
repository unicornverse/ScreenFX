/* ScreenFX effect module — registers into the runtime in content.js. */
(() => {
  const sfx = window.__screenFX;
  if (!sfx || !sfx.kit) return;
  // eslint-disable-next-line no-unused-vars
  const { R, SPRING, SPRING_MS, rand, rint, pick, clamp, svgFrom, el, div, later, listen, loop, canvasLayer, envelope, easeOut3, easeIn2, shake, breathe, pageLuminance, gl, lockScroll, blocks } = sfx.kit;

  /* ========================================================================
   * 1. PRISON BARS — a heavy steel gate drops in front of the page, slams
   *    into the floor, bounces, rattles, kicks up dust, and is winched back
   *    up at the end.
   *
   *    SHADING (one WebGL pass, physically based): each bar is a cylinder
   *    whose normal comes from the pixel's position across it. Steel is a
   *    conductor, so there is no diffuse term — Schlick Fresnel with
   *    F0 = (0.56, 0.57, 0.58) for iron, an anisotropic GGX lobe (smooth
   *    along the bar, rough across it: brushed along its length) for the key
   *    light, and an environment term. A vertical cylinder only reflects a
   *    horizontal slice of the world: toward the viewer that is the room
   *    (a bright window side and a dark side), and at the grazing edges the
   *    reflected ray points back at the wall behind it — so the rims show a
   *    blurred copy of THE PAGE beside the bar, taken from the snapshot.
   *    Rust is fbm noise biased toward the bottom where water would run;
   *    it is a rough dielectric, so it only gets diffuse light.
   *
   *    THE PAGE. The gate hangs D = 46 px in front of the page. Its shadow
   *    is the gate projected along the light direction onto the page plane
   *    (offset D * L.xy / L.z down and to the right), widened by the
   *    cylinder's projection and softened by a penumbra that grows with D.
   *    Ambient occlusion from a cylinder at height D falls off as
   *    D^2 / (D^2 + x^2). Both multiply the page (rendered as a black layer
   *    with alpha, so the live page stays live underneath).
   *
   *    IMPACT. Free fall under gravity, collision with restitution e = 0.22
   *    (a few diminishing bounces), then a damped rattle. The real page
   *    shakes with it (the snapshot, offset, for half a second), and dust is
   *    a puff of drag-dominated particles from every bar foot.
   * ====================================================================== */

  const FRAG = `
uniform float uY;          // gate vertical offset (px, negative = up)
uniform float uRattle;     // gate horizontal rattle (px)
uniform vec2 uShake;       // page shake offset (px)
uniform float uPageA;      // 1 while the page itself is redrawn (shake)
uniform float uSp;         // bar spacing
uniform float uR;          // bar radius
uniform float uST;         // top strap centre (gate space)
uniform float uSB;         // bottom strap centre
uniform float uTh;         // strap thickness
uniform vec2 uOff;         // shadow offset on the page
uniform float uSoft;       // penumbra half-width
uniform float uLum;        // page luminance (for reflections without a snapshot)
uniform float uBottom;     // gate bottom (gate space)

const vec3 LD = vec3(-0.4191, -0.4990, 0.7585);   // toward the light
const vec3 F0 = vec3(0.56, 0.57, 0.58);           // iron

vec3 pageBlur(vec2 p) {
  if (uHasPage < 0.5) return vec3(uLum);
  vec3 c = pageAt(p).rgb * 0.28;
  c += pageAt(p + vec2(0.0, 9.0)).rgb * 0.18;
  c += pageAt(p - vec2(0.0, 9.0)).rgb * 0.18;
  c += pageAt(p + vec2(7.0, 4.0)).rgb * 0.18;
  c += pageAt(p - vec2(7.0, 4.0)).rgb * 0.18;
  return c;
}

float strapMask(float y) {
  return max(1.0 - smoothstep(uTh * 0.5 - 0.8, uTh * 0.5 + 0.6, abs(y - uST)),
             1.0 - smoothstep(uTh * 0.5 - 0.8, uTh * 0.5 + 0.6, abs(y - uSB)));
}

vec3 steel(vec3 n, vec2 q, float idx, vec2 p, float xc, float brushAlongY) {
  // perspective: the eye sits ~1.2 screen-heights in front of the middle
  vec3 E = normalize(vec3(uRes * 0.5 - p, uRes.y * 1.2));
  vec3 H = normalize(LD + E);
  float NdL = max(0.0, dot(n, LD));
  float NdV = max(0.05, dot(n, E));
  float NdH = max(0.0, dot(n, H));
  float brush = brushAlongY > 0.5
    ? vnoise(vec2(q.x * 0.9 + idx * 13.0, q.y * 0.012)) * 0.6 + vnoise(vec2(q.x * 2.6, q.y * 0.05)) * 0.4
    : vnoise(vec2(q.x * 0.012, q.y * 0.9 + idx * 5.0)) * 0.6 + vnoise(vec2(q.x * 0.05, q.y * 2.6)) * 0.4;
  // anisotropic GGX: smooth along the brushing direction, rough across it
  vec3 T = brushAlongY > 0.5 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 B = normalize(cross(n, T));
  T = normalize(cross(B, n));
  float at = 0.2, ab = 0.42 * (0.8 + 0.4 * brush);
  float th = dot(H, T) / at, bh = dot(H, B) / ab;
  float dd = th * th + bh * bh + NdH * NdH;
  float D = 1.0 / (3.14159 * at * ab * dd * dd);
  float VdH = max(0.0, dot(E, H));
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VdH, 5.0);
  vec3 spec = D * F * NdL / (4.0 * VdH * VdH + 0.001) * 0.5;
  // environment: a horizontal slice of the room, and the page at grazing angles
  vec3 Rf = reflect(-E, n);
  float window = smoothstep(0.55, -0.9, Rf.x) * smoothstep(-0.2, 0.5, Rf.z + 0.3);
  vec3 room = mix(vec3(0.13, 0.135, 0.15), vec3(0.8, 0.82, 0.85), window);
  room += vec3(0.10) * smoothstep(0.0, -1.0, Rf.y);        // ceiling, for the strap bevels
  room *= 1.0 - 0.75 * smoothstep(0.1, 1.0, Rf.y);          // floor is dark
  vec2 sideP = vec2(xc + sign(n.x) * (uR + 18.0 + 40.0 * max(0.0, -Rf.z)), p.y);
  vec3 env = mix(room, pageBlur(sideP) * 0.85, smoothstep(0.25, -0.55, Rf.z) * brushAlongY);
  vec3 Fe = F0 + (1.0 - F0) * pow(1.0 - NdV, 5.0);
  vec3 metal = env * Fe * (0.82 + 0.36 * brush) + spec;
  // rust and grime: rough dielectric, diffuse only
  float rn = fbm(vec2(q.x * 0.05 + idx * 7.3, q.y * 0.016));
  float low = smoothstep(uBottom * 0.35, uBottom, q.y);
  float rust = smoothstep(0.7, 0.86, rn + 0.16 * low + 0.08 * vnoise(q * 0.35)) * 0.8;
  float pit = step(0.965, hash12(floor(q * 1.2))) * 0.12;
  vec3 rustC = mix(vec3(0.24, 0.12, 0.06), vec3(0.42, 0.22, 0.11), vnoise(q * 0.45));
  rustC *= 0.22 + 0.9 * NdL;
  vec3 col = mix(metal, rustC, rust * 0.9);
  col *= 1.0 - pit * (1.0 - rust);
  return col;
}

void main() {
  vec2 p = cssPos();
  vec2 q = p - vec2(uRattle, uY);                // gate space
  vec4 base = vec4(0.0);
  vec3 under = vec3(0.0);

  // ---- shadow and ambient occlusion on the page ------------------------
  vec2 sp = q - uOff;                             // occluder that shadows this pixel
  float ib = floor(sp.x / uSp);
  float dxs = sp.x - (ib + 0.5) * uSp;
  float halfW = uR * 1.14;
  float sh = 1.0 - smoothstep(halfW - uSoft, halfW + uSoft, abs(dxs));
  sh *= 1.0 - smoothstep(uBottom - uSoft, uBottom + uSoft, sp.y);
  float shS = max(1.0 - smoothstep(uTh * 0.5 - uSoft, uTh * 0.5 + uSoft, abs(sp.y - uST)),
                  1.0 - smoothstep(uTh * 0.5 - uSoft, uTh * 0.5 + uSoft, abs(sp.y - uSB)));
  float shadow = max(sh, shS);
  float i0 = floor(q.x / uSp);
  float dx0 = q.x - (i0 + 0.5) * uSp;
  float Dd = 46.0;
  float ao = (2.0 * uR / (3.14159 * Dd)) * Dd * Dd / (Dd * Dd + dx0 * dx0) * (1.0 - smoothstep(uBottom - 30.0, uBottom + 40.0, q.y));
  float aoS = 0.6 * (2.0 * uTh / (3.14159 * Dd)) * (Dd * Dd / (Dd * Dd + pow(min(abs(q.y - uST), abs(q.y - uSB)), 2.0)));
  float mult = (1.0 - 0.4 * shadow) * (1.0 - 0.32 * clamp(ao + aoS, 0.0, 0.6));
  float dark = 1.0 - mult;

  if (uPageA > 0.5) {
    vec3 pg = pageAt(p + uShake).rgb;
    base = vec4(pg * mult, 1.0);
  } else {
    base = vec4(0.0, 0.0, 0.0, dark);
  }

  // ---- bars --------------------------------------------------------------
  float idx = i0;
  float xc = (idx + 0.5) * uSp;
  float u = dx0 / uR;
  float cov = (1.0 - smoothstep(uR - 1.0, uR + 0.2, abs(dx0))) * (1.0 - smoothstep(uBottom - 1.0, uBottom + 0.5, q.y));
  vec4 outc = base;
  if (cov > 0.0) {
    float uu = clamp(u, -0.999, 0.999);
    vec3 n = vec3(uu, 0.0, sqrt(1.0 - uu * uu));
    // a slight rounding at the foot of the bar
    float foot = smoothstep(uBottom - 6.0, uBottom, q.y);
    n = normalize(n + vec3(0.0, foot * 1.2, 0.0));
    vec3 c = steel(n, q, idx, p, xc + uRattle, 1.0);
    // the straps are in front: they shadow the bar just below them
    float zgap = 6.0 + uR * (1.0 - n.z);
    float so = zgap * 0.97;
    float strapSh = max(1.0 - smoothstep(uTh * 0.5 - 3.0, uTh * 0.5 + 3.0, abs(q.y - uST - so)),
                        1.0 - smoothstep(uTh * 0.5 - 3.0, uTh * 0.5 + 3.0, abs(q.y - uSB - so)));
    c *= 1.0 - 0.55 * strapSh;
    // ambient occlusion where the bar meets the straps
    c *= 0.9 + 0.1 * n.z;
    float a = base.a + cov * (1.0 - base.a);
    outc = vec4((c * cov + base.rgb * base.a * (1.0 - cov)) / max(a, 0.001), a);
  }

  // ---- straps (in front of the bars) ----------------------------------------
  float sm = strapMask(q.y);
  if (sm > 0.0) {
    float sc = abs(q.y - uST) < abs(q.y - uSB) ? uST : uSB;
    float ys = q.y - sc;
    float bev = 3.0;
    vec3 n = vec3(0.0, 0.0, 1.0);
    if (ys < -uTh * 0.5 + bev) n = normalize(vec3(0.0, -1.0, 1.0));
    else if (ys > uTh * 0.5 - bev) n = normalize(vec3(0.0, 1.0, 1.0));
    // hammered surface
    n = normalize(n + vec3(vnoise(q * 0.21) - 0.5, vnoise(q * 0.23 + 9.0) - 0.5, 0.0) * 0.05);
    vec3 c = steel(n, q + vec2(0.0, 300.0), 40.0, p, q.x, 0.0);
    // rivets at every crossing
    vec2 rv = vec2(q.x - xc, ys);
    float rr = 6.5;
    float rd = length(rv);
    if (rd < rr + 1.0) {
      float k = clamp(rd / rr, 0.0, 0.999);
      vec3 nr = normalize(vec3(rv / rr, sqrt(1.0 - k * k) + 0.15));
      vec3 cr = steel(nr, q * 3.0, idx + 3.0, p, xc, 0.0) * 1.05;
      float ra = 1.0 - smoothstep(rr - 0.6, rr + 0.6, rd);
      c = mix(c * (1.0 - 0.45 * (1.0 - smoothstep(rr, rr + 3.0, rd))), cr, ra);
    }
    float a = outc.a + sm * (1.0 - outc.a);
    outc = vec4((c * sm + outc.rgb * outc.a * (1.0 - sm)) / max(a, 0.001), a);
  }
  gl_FragColor = outc;
}
`;

  /* Same light and material as the shader, evaluated across a cylinder in JS,
     for the no-WebGL fallback: gradient stops for one bar. */
  function cylinderStops(n, lum, horizontal) {
    const L = [-0.4191, -0.4990, 0.7585];
    const stops = [];
    for (let i = 0; i <= n; i++) {
      const u = -0.98 + 1.96 * (i / n);
      const nz = Math.sqrt(1 - u * u);
      const nx = horizontal ? 0 : u, ny = horizontal ? u : 0;
      const ndl = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      const rx = 2 * nx * nz, rz = 2 * nz * nz - 1, ry = 2 * ny * nz;
      const win = clamp((0.55 - rx) / 1.45, 0, 1);
      let env = 0.07 + 0.6 * win;
      if (horizontal) env = clamp(0.35 - ry * 0.4, 0.06, 0.8);
      if (rz < 0) env = env * (1 + rz) + lum * 0.85 * -rz;
      const fe = 0.56 + 0.44 * Math.pow(1 - nz, 5);
      const hx = L[0], hy = L[1], hz = L[2] + 1, hl = Math.hypot(hx, hy, hz);
      const ndh = Math.max(0, (nx * hx + ny * hy + nz * hz) / hl);
      const spec = Math.pow(ndh, 60) * 1.4 * ndl;
      const v = clamp(env * fe + spec, 0, 1);
      const c = Math.round(v * 255);
      stops.push([i / n, `rgb(${c},${Math.min(255, c + 3)},${Math.min(255, c + 7)})`]);
    }
    return stops;
  }

  function prisonBars(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const count = clamp(Math.round(W / 118), 5, 14);
    const SP = W / count;
    const BR = clamp(SP * 0.16, 12, 21);              // bar radius
    const TH = clamp(H * 0.034, 18, 30);               // strap thickness
    const ST = H * 0.13, SB = H * 0.85;
    const lum = pageLuminance();
    const reduced = ctx.reduced;

    // light (toward it) and the shadow it throws from D = 46 px
    const Lx = -0.4191, Ly = -0.4990, Lz = 0.7585, DEPTH = 46;
    const OFF = [-Lx / Lz * DEPTH, -Ly / Lz * DEPTH];   // ~(25, 30) px
    const SOFT = 3 + DEPTH * 0.07;
    const HIDE = -(H + 40 + OFF[1] + SOFT * 2);         // gate + its shadow fully above the top

    /* ---- timing ------------------------------------------------------------- */
    const N_FALL = 430, N_SETTLE = 760, N_LIFT = 820;
    const f = ctx.fit(N_FALL + N_SETTLE, N_LIFT, 300);
    const k = f.k;                                     // < 1 only for very short settings
    const FALL = N_FALL * k;
    const G = 2 * -HIDE / Math.pow(FALL / 1000, 2);    // px/s^2: lands exactly at FALL
    const E = 0.22;                                    // restitution, steel on stone
    const LIFT_AT = f.intro + f.hold, LIFT = f.outro;
    const total = LIFT_AT + LIFT;

    /* ---- gate dynamics ------------------------------------------------------- */
    let Y = HIDE, impacts = 0, lastImpact = -1, impactV = 0;
    // impact speeds: v0 = G * T_fall, then e^n * v0 until it stops bouncing
    const BOUNCES = [G * FALL / 1000];
    while (BOUNCES.length < 6 && BOUNCES[BOUNCES.length - 1] * E > 140) BOUNCES.push(BOUNCES[BOUNCES.length - 1] * E);
    const gateAt = (ts) => {
      const tf = FALL / 1000;
      if (ts < tf) return { y: HIDE + 0.5 * G * ts * ts, n: 0 };
      let t0 = tf;
      for (let i = 0; i < BOUNCES.length; i++) {
        const up = (i + 1 < BOUNCES.length) ? BOUNCES[i] * E : 0;   // rebound speed
        const air = 2 * up / G;
        if (ts < t0 + air) { const tt = ts - t0; return { y: -(up * tt - 0.5 * G * tt * tt), n: i + 1 }; }
        t0 += air;
      }
      return { y: 0, n: BOUNCES.length };
    };
    let rattle = 0, shakeX = 0, shakeY = 0, pageA = 0;
    const scrollAt0 = [window.scrollX, window.scrollY];
    let shakeOK = !!ctx.snapshot && !reduced;

    /* ---- layers ------------------------------------------------------------- */
    let fx = null;
    try { fx = gl(stage, FRAG, { snapshot: ctx.snapshot }); } catch (err) { fx = null; }
    const dust = canvasLayer(stage, 'sfx-dust');
    let cv2 = null;
    if (fx) {
      fx.set('uSp', SP); fx.set('uR', BR); fx.set('uST', ST); fx.set('uSB', SB); fx.set('uTh', TH);
      fx.set('uOff', OFF); fx.set('uSoft', SOFT); fx.set('uLum', lum); fx.set('uBottom', H);
    } else {
      cv2 = canvasLayer(stage, 'sfx-bars2d');
      // the fallback sits under the dust
      stage.insertBefore(cv2.cv, dust.cv);
    }

    /* ---- 2D fallback ------------------------------------------------------------ */
    let barGrad = null, strapGrad = null, shadowGrad = null, aoGrad = null, strapShadowGrad = null;
    const draw2d = () => {
      const g = cv2.g;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cv2.cv.width, cv2.cv.height);
      g.setTransform(cv2.dpr, 0, 0, cv2.dpr, 0, 0);
      const oy = Y, ox = rattle;
      // shadows + occlusion. Penumbrae are gradient edges, not ctx.filter
      // blur: a full-screen blur per frame stalls software rasterisers.
      if (!shadowGrad) {
        const hw = BR * 1.14;
        shadowGrad = g.createLinearGradient(-hw - SOFT, 0, hw + SOFT, 0);
        shadowGrad.addColorStop(0, 'rgba(0,0,0,0)');
        shadowGrad.addColorStop(SOFT * 2 / (2 * hw + 2 * SOFT), 'rgba(0,0,0,0.4)');
        shadowGrad.addColorStop(1 - SOFT * 2 / (2 * hw + 2 * SOFT), 'rgba(0,0,0,0.4)');
        shadowGrad.addColorStop(1, 'rgba(0,0,0,0)');
        aoGrad = g.createLinearGradient(-DEPTH * 1.6, 0, DEPTH * 1.6, 0);
        for (let i = 0; i <= 8; i++) {
          const x = -1.6 + 3.2 * i / 8;
          aoGrad.addColorStop(i / 8, `rgba(0,0,0,${(0.32 * (2 * BR / (Math.PI * DEPTH)) / (1 + x * x)).toFixed(3)})`);
        }
        strapShadowGrad = g.createLinearGradient(0, -TH / 2 - SOFT, 0, TH / 2 + SOFT);
        strapShadowGrad.addColorStop(0, 'rgba(0,0,0,0)');
        strapShadowGrad.addColorStop(0.3, 'rgba(0,0,0,0.4)');
        strapShadowGrad.addColorStop(0.7, 'rgba(0,0,0,0.4)');
        strapShadowGrad.addColorStop(1, 'rgba(0,0,0,0)');
      }
      for (let i = 0; i < count; i++) {
        const xc = (i + 0.5) * SP + ox;
        g.save(); g.translate(xc + OFF[0], 0);
        g.fillStyle = shadowGrad;
        g.fillRect(-BR * 1.14 - SOFT, -50, (BR * 1.14 + SOFT) * 2, H + oy + OFF[1] + 50);
        g.restore();
        g.save(); g.translate(xc, 0);
        g.fillStyle = aoGrad;
        g.fillRect(-DEPTH * 1.6, -50, DEPTH * 3.2, H + oy + 50);
        g.restore();
      }
      [ST, SB].forEach((sy) => {
        g.save(); g.translate(0, sy + oy + OFF[1]);
        g.fillStyle = strapShadowGrad;
        g.fillRect(-20, -TH / 2 - SOFT, W + 40, TH + SOFT * 2);
        g.restore();
      });
      if (!barGrad) {
        barGrad = g.createLinearGradient(-BR, 0, BR, 0);
        cylinderStops(14, lum, false).forEach(([s, c]) => barGrad.addColorStop(s, c));
        strapGrad = g.createLinearGradient(0, -TH / 2, 0, TH / 2);
        cylinderStops(8, lum, true).forEach(([s, c]) => strapGrad.addColorStop(s, c));
      }
      for (let i = 0; i < count; i++) {
        g.save();
        g.translate((i + 0.5) * SP + ox, 0);
        g.fillStyle = barGrad;
        g.fillRect(-BR, -60, BR * 2, H + oy + 60);
        g.restore();
      }
      [ST, SB].forEach((sy) => {
        g.save();
        g.translate(0, sy + oy);
        g.fillStyle = strapGrad;
        g.fillRect(-20, -TH / 2, W + 40, TH);
        for (let i = 0; i < count; i++) {
          const rg = g.createRadialGradient((i + 0.5) * SP + ox - 2, -2, 0.5, (i + 0.5) * SP + ox, 0, 6.5);
          rg.addColorStop(0, '#f2f4f6'); rg.addColorStop(0.5, '#8a9098'); rg.addColorStop(1, '#2a2d32');
          g.fillStyle = rg;
          g.beginPath(); g.arc((i + 0.5) * SP + ox, 0, 6.5, 0, 6.2832); g.fill();
        }
        g.restore();
      });
    };

    /* ---- dust ----------------------------------------------------------------- */
    const motes = [];
    const puff = (strength) => {
      const n = reduced ? 3 : Math.round(9 * strength);
      for (let i = 0; i < count; i++) {
        const xc = (i + 0.5) * SP;
        for (let j = 0; j < n; j++) {
          const side = Math.random() < 0.5 ? -1 : 1;
          const sp = rand(60, 420) * strength;
          motes.push({ x: xc + side * rand(0, BR), y: H - rand(0, 6), vx: side * sp * rand(0.5, 1), vy: -sp * rand(0.15, 0.6),
            r: rand(8, 20), life: rand(800, 1700), age: 0, chip: false });
        }
        // a couple of chips of grit, ballistic
        if (!reduced) for (let j = 0; j < 2; j++) {
          motes.push({ x: xc + rand(-BR, BR), y: H - 2, vx: rand(-260, 260) * strength, vy: -rand(200, 520) * strength,
            r: rand(1, 2.2), life: 900, age: 0, chip: true });
        }
      }
    };
    const dustCol = lum > 0.5 ? '120,108,92' : '196,184,166';
    const drawDust = (dt) => {
      const g = dust.g;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, dust.cv.width, dust.cv.height);
      g.setTransform(dust.dpr, 0, 0, dust.dpr, 0, 0);
      const s = dt / 1000;
      for (let i = motes.length - 1; i >= 0; i--) {
        const m = motes[i];
        m.age += dt;
        if (m.age > m.life) { motes.splice(i, 1); continue; }
        if (m.chip) {
          m.vy += 1800 * s; m.x += m.vx * s; m.y += m.vy * s;
          if (m.y > H - 1) { m.y = H - 1; m.vy *= -0.3; m.vx *= 0.6; }
          g.fillStyle = `rgba(${dustCol},${(1 - m.age / m.life).toFixed(3)})`;
          g.fillRect(m.x, m.y, m.r, m.r);
          continue;
        }
        // drag-dominated: velocity relaxes fast, a little buoyant rise
        const kd = Math.exp(-s * 5);
        m.vx *= kd; m.vy = m.vy * kd - 18 * s;
        m.x += m.vx * s; m.y += m.vy * s;
        m.r += s * 34;
        const a = (lum > 0.5 ? 0.2 : 0.11) * Math.pow(1 - m.age / m.life, 1.6);
        const grd = g.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r);
        grd.addColorStop(0, `rgba(${dustCol},${a.toFixed(3)})`);
        grd.addColorStop(0.5, `rgba(${dustCol},${(a * 0.45).toFixed(3)})`);
        grd.addColorStop(1, `rgba(${dustCol},0)`);
        g.fillStyle = grd;
        g.beginPath(); g.arc(m.x, m.y, m.r, 0, 6.2832); g.fill();
      }
    };

    if (!shakeOK) { /* the stage itself rattles instead */ }

    /* ---- loop ---------------------------------------------------------------- */
    let lastDrawn = '';
    loop((dt, t) => {
      if (t > total) return false;
      dt = Math.max(0, Math.min(dt, 34));
      const s = dt / 1000;

      if (t < LIFT_AT) {
        // Closed-form in wall time, so the slam lands on schedule at any
        // frame rate: free fall, then bounces at e^n * v0 with airtime 2v/G.
        const st = gateAt(t / 1000);
        Y = st.y;
        if (st.n > impacts) {
          for (let b = impacts + 1; b <= st.n; b++) {
            const v = BOUNCES[b - 1];
            if (b === 1) {
              impactV = v; lastImpact = t;
              puff(1);
              if (shakeOK && (window.scrollX !== scrollAt0[0] || window.scrollY !== scrollAt0[1])) shakeOK = false;
              if (!shakeOK && !reduced) shake(stage, 0, 480);
            } else if (v > 400) puff(0.35);
          }
          impacts = st.n;
        }
      } else {
        // winch: accelerate up, gate and its shadow leave the top
        const p = clamp((t - LIFT_AT) / LIFT, 0, 1);
        const e = p * p * (3 - 2 * p) * 0.35 + easeIn2(p) * 0.65;
        Y = HIDE * e;
      }

      // rattle after the slam, and the page shaking with it
      const since = lastImpact >= 0 ? (t - lastImpact) / 1000 : -1;
      const amp = clamp(impactV / 4000, 0, 1.2);
      if (since >= 0 && since < 0.7) {
        rattle = (reduced ? 0 : 2.6) * amp * Math.exp(-since / 0.16) * Math.sin(since * 2 * Math.PI * 13);
        if (shakeOK && since < 0.5) {
          const d = Math.exp(-since / 0.12) * 9 * amp;
          shakeX = d * Math.sin(since * 2 * Math.PI * 11); shakeY = d * 0.7 * Math.cos(since * 2 * Math.PI * 9.3);
          pageA = 1;
        } else { shakeX = shakeY = 0; pageA = 0; }
      } else { rattle = 0; pageA = 0; shakeX = shakeY = 0; }

      const key = Y.toFixed(2) + '|' + rattle.toFixed(2) + '|' + shakeX.toFixed(2) + '|' + shakeY.toFixed(2) + '|' + pageA;
      if (key !== lastDrawn) {
        lastDrawn = key;
        if (fx) {
          fx.set('uY', Y); fx.set('uRattle', rattle); fx.set('uShake', [shakeX, shakeY]); fx.set('uPageA', pageA);
          fx.draw(t / 1000);
        } else draw2d();
      }
      if (motes.length || t - lastImpact < 50) drawDust(dt);
    });

    return total;
  }

  sfx.register('prisonBars', prisonBars);
})();
