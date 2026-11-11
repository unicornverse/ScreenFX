/* Screenick effect module — registers into the runtime in content.js. */
(() => {
  const sfx = window.__screenick;
  if (!sfx || !sfx.kit) return;
  // eslint-disable-next-line no-unused-vars
  const { R, SPRING, SPRING_MS, rand, rint, pick, clamp, svgFrom, el, div, later, listen, loop, canvasLayer, envelope, easeOut3, easeIn2, shake, breathe, pageLuminance, gl, lockScroll, blocks } = sfx.kit;

  /* ========================================================================
   * 11. THUNDERSTORM: the real page goes overcast, rain runs down the glass
   *     in front of it, and lightning lights the page itself.
   *
   *     Models
   *     - Relighting: the snapshot is treated as albedo. Overcast is a drop in
   *       illuminance (E ~ 0.4, cooler, desaturated, drifting cloud shadow),
   *       and a stroke adds E_flash = I(t) * (0.28 + 0.9 / (1 + (d/0.22H)^2))
   *       where d is the distance to the channel, so the page is lit near the
   *       bolt and falls off away from it. The page is never pushed past its
   *       own normal brightness, so the screen never goes flat white.
   *     - Lightning: a stepped leader is a biased random walk (steps of tens of
   *       metres, ~0.5 rad jitter, branching with p ~ 0.07 per step, like a
   *       dielectric-breakdown model) that is 20-100x dimmer than the return
   *       stroke. On attachment the return stroke lights the main channel,
   *       decaying with tau ~ 70 ms plus a continuing-current tail; one
   *       re-strike follows the same channel ~ 60-110 ms later (real inter-
   *       stroke gaps are 40-80 ms). That is two flashes per strike, strikes
   *       >= 1.9 s apart: never more than 3 flashes in any second.
   *     - Thunder: the rumble arrives after a delay that grows with the
   *       strike's distance (sound ~ 3 s/km, compressed), and shakes only the
   *       page image a few px. No shake and no lightning under reduced motion.
   *     - Glass: drops are spherical caps acting as small lenses, so each one
   *       shows an inverted, minified image of the page behind it (sample at
   *       c - 1.4 (p - c)), with a dark rim (refraction away / TIR) and a
   *       specular highlight. Beads pop in on impact and evaporate; runners
   *       move with stick-slip (pinned by contact-angle hysteresis until
   *       gravity wins, then slip) along a zig-zag wet track, leaving a clear
   *       trail and beads behind. A thin water film fogs the rest slightly.
   *     - Rain in air: terminal velocity ~9 m/s, so streaks are motion-
   *       blurred (length = v * exposure), at three depths, slanted by gusts.
   * ====================================================================== */

  const FRAG = `
uniform float uOver;      // overcast 0..1
uniform float uWet;       // glass wetness 0..1
uniform float uRun;       // running drops 0..1
uniform float uFlash;     // lightning illuminance
uniform vec2 uShake;      // thunder shake, CSS px
uniform vec2 uBolt[8];    // main channel, CSS px
uniform sampler2D uBoltTex; // the bolt itself, drawn behind the glass
uniform float uBoltOn;
vec3 boltAt(vec2 p) { vec4 b = texture2D(uBoltTex, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)); return b.rgb * b.a; }

float saw(float b, float t) { return smoothstep(0.0, b, t) * smoothstep(1.0, b, t); }

// impact bead: pops in, then slowly evaporates. xy = lens offset, z = mask, w = 0 centre .. 1 rim
vec4 bead(vec2 p, float cell, float seed, float dens, float t) {
  vec2 id = floor(p / cell);
  if (hash12(id * 1.37 + seed) > dens) return vec4(0.0);
  float life = fract(t * (0.06 + 0.08 * hash12(id + seed * 5.0)) + hash12(id * 2.1 + seed));
  float sz = smoothstep(0.0, 0.02, life) * (1.0 - smoothstep(0.7, 1.0, life));
  vec2 c = (id + 0.22 + 0.56 * hash22(id + seed)) * cell;
  float r = cell * (0.1 + 0.2 * hash12(id + seed + 9.1)) * (0.4 + 0.6 * sz);
  vec2 rel = p - c;
  float d = length(rel * vec2(1.0, 0.92)) / r;
  return vec4(-rel * 2.4, smoothstep(1.0, 0.8, d) * step(0.01, sz), d);
}

// runner: stick-slip down a column, zig-zag on its wet track; trail = cleared path
vec4 runner(vec2 p, float t, float cw, float seed, float gate, out float trail) {
  trail = 0.0;
  float col = floor(p.x / cw);
  float on = smoothstep(0.0, 0.15, gate - hash12(vec2(col, seed + 11.0)));
  if (on <= 0.0) return vec4(0.0);
  float ch = cw * 3.0;
  float f = mix(0.3, 0.6, hash12(vec2(col, seed + 4.0)));
  float yq = p.y / ch - t * f + hash12(vec2(col, seed));
  vec2 id = vec2(col, floor(yq));
  vec3 n = vec3(hash22(id * 1.13 + seed), hash12(id + seed * 2.7));
  vec2 st = vec2(fract(p.x / cw) - 0.5, fract(yq));
  float yy = p.y / cw * 1.3;
  float x = (n.x - 0.5) * 0.5;
  x += sin(yy + sin(yy * 0.7 + n.z * 6.0)) * (0.5 - abs(x)) * (n.z - 0.5) * 0.6;
  float y = 0.94 - 0.86 * saw(0.85, fract(t * f + n.z));
  vec2 rel = (st - vec2(x, y)) * vec2(cw, ch);
  float r = cw * mix(0.11, 0.17, n.y);
  float d = length(rel * vec2(1.0, 0.8)) / r;
  vec4 o = vec4(-rel * 2.4, smoothstep(1.0, 0.8, d), d);
  // the clear trail above it, narrowing and fading upward
  float up = (y - st.y);
  float tl = step(0.0, up) * smoothstep(0.85, 0.0, up);
  trail = smoothstep(r * 0.9, r * 0.4, abs(rel.x)) * tl;
  // beads left behind in the trail
  float row = floor(p.y / 9.0);
  vec2 bc = vec2((x + 0.5 + col) * cw, (row + 0.5) * 9.0);
  float br = 1.3 + 2.2 * hash12(vec2(row, col + seed));
  vec2 brel = p - bc;
  float bd = length(brel) / br;
  float bm = smoothstep(1.0, 0.75, bd) * tl * step(0.4, hash12(vec2(row * 3.1, col + seed)));
  if (bm > o.z) o = vec4(-brel * 2.4, bm, bd);
  o.z *= on; trail *= on;
  return o;
}

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-3), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec2 p = cssPos();

  // ---- water on the glass ------------------------------------------------
  vec4 w = vec4(0.0);
  float trail = 0.0;
  if (uWet > 0.005) {
    w = bead(p, 24.0, 1.0, 0.5 * uWet, uTime);
    vec4 b2 = bead(p + 5.0, 10.0, 4.0, 0.3 * uWet, uTime * 1.3);
    if (b2.z > w.z) w = b2;
    float t1, t2;
    vec4 r1 = runner(p, uTime, 70.0, 1.0, uRun, t1);
    vec4 r2 = runner(p + vec2(23.0, 0.0), uTime * 1.07, 46.0, 7.0, uRun * 0.8, t2);
    if (r1.z > w.z) w = r1;
    if (r2.z > w.z) w = r2;
    trail = max(t1, t2);
  }
  float fogAmt = uWet * 0.85 * (1.0 - trail) * (1.0 - w.z);

  // ---- lighting -----------------------------------------------------------
  float yN = p.y / uRes.y;
  float cloud = vnoise(vec2(p.x / 520.0 + uTime * 0.045, p.y / 320.0)) * 0.65 + vnoise(vec2(p.x / 190.0 + uTime * 0.07, p.y / 140.0)) * 0.35;
  float E = mix(1.0, 0.36 + 0.09 * yN - 0.12 * (cloud - 0.5), uOver);
  vec3 Ec = vec3(E) * mix(vec3(1.0), vec3(0.9, 0.95, 1.07), uOver);
  float dmin = 1e5;
  for (int i = 0; i < 7; i++) dmin = min(dmin, segDist(p, uBolt[i], uBolt[i + 1]));
  // the page is lit, but kept below the channel's own brightness so the
  // bolt still reads as the brightest thing on screen, even on white
  float fall = 0.26 + 0.5 / (1.0 + pow(dmin / (0.24 * uRes.y), 2.0));
  vec3 Ef = uFlash * fall * vec3(0.8, 0.87, 1.0);

  float rim = smoothstep(0.55, 1.0, w.w) * w.z;
  vec2 rn = (length(w.xy) > 1e-3 ? normalize(-w.xy) : vec2(0.0)) * w.w;   // (p - c) / r
  float hl = w.z * smoothstep(0.42, 0.0, length(rn - vec2(-0.3, -0.38)));
  float caus = w.z * smoothstep(0.5, 1.0, w.w) * smoothstep(0.0, 0.6, rn.y) * 0.5;   // light focused at the bottom
  vec3 emit = (hl * (0.16 + 0.9 * uFlash) + caus * (0.05 + 0.35 * uFlash)) * vec3(0.9, 0.95, 1.0);

  if (uHasPage > 0.5) {
    vec2 sp = p + uShake;
    vec3 P = pageAt(sp).rgb;
    vec3 B = uBoltOn > 0.5 ? boltAt(sp) : vec3(0.0);
    if (fogAmt > 0.02) {
      // the water film scatters: a small blur of whatever is behind the glass
      float r = 0.8 + 2.4 * fogAmt;
      float a0 = hash12(p) * 6.2831;
      vec3 s = P;
      for (int i = 1; i < 8; i++) {
        float fi = float(i), a = a0 + fi * 2.39996;
        vec2 q = sp + vec2(cos(a), sin(a)) * r * sqrt(fi / 7.0);
        s += pageAt(q).rgb;
      }
      float k = smoothstep(0.0, 0.3, fogAmt);
      P = mix(P, s / 8.0, k);
    }
    if (w.z > 0.01) {
      P = mix(P, pageAt(sp + w.xy).rgb, w.z);
      if (uBoltOn > 0.5) B = mix(B, boltAt(sp + w.xy), w.z);
    }
    float lum = dot(P, vec3(0.2126, 0.7152, 0.0722));
    vec3 alb = mix(P, vec3(lum), 0.55 * uOver);
    vec3 col = alb * (Ec + Ef);
    col += fogAmt * 0.05 * (Ec + Ef);
    col *= 1.0 - 0.45 * rim;
    col += emit + B;
    gl_FragColor = vec4(min(col, vec3(1.0)), smoothstep(0.0, 0.01, max(uOver, uWet)));
  } else {
    // no snapshot: the same illuminance as an alpha blend over the live page
    float k = dot(Ec + Ef, vec3(0.333)) * (1.0 - 0.45 * rim);
    k = min(k, 1.0);
    float a = 1.0 - k;
    vec3 B = uBoltOn > 0.5 ? boltAt(w.z > 0.01 ? p + w.xy : p) : vec3(0.0);
    float bA = clamp(max(B.r, max(B.g, B.b)), 0.0, 1.0);
    vec3 c = (emit + B + fogAmt * 0.05 * Ec + (1.0 - k) * vec3(0.03, 0.04, 0.07)) / max(a, 1e-3);
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), clamp(max(a, bA) + length(emit) * 0.6, 0.0, 1.0));
  }
}
`;

  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 0.5;

  /* Stepped leader: a biased random walk from the cloud base towards the
     attachment point, branching as it goes. Every point carries the step at
     which the leader reached it, so the leader can be drawn growing. */
  function makeBolt(W, H, targets) {
    const S = H / 800;
    let tx, ty;
    const tgt = targets.length && Math.random() < 0.7 ? pick(targets) : null;
    if (tgt) { tx = tgt[0]; ty = tgt[1]; } else { tx = rand(0.1, 0.9) * W; ty = H + 12; }
    // the cloud cell is roughly overhead: lightning is mostly vertical
    const x0 = clamp(tx + rand(-0.12, 0.12) * W, 0.05 * W, 0.95 * W);
    const main = [[x0, -12, 0]];
    const branches = [];
    let x = x0, y = -12, step = 0, drift = gauss() * 0.3;
    const walk = (bx, by, ang, n, s0, depth) => {
      const pts = [[bx, by, s0]];
      let a = ang, xx = bx, yy = by;
      for (let i = 1; i <= n; i++) {
        a = a * 0.75 + (Math.PI / 2) * 0.25 + gauss() * 0.45;
        a = clamp(a, Math.PI * 0.04, Math.PI * 0.96);
        const L = rand(5, 12) * S;
        xx += Math.cos(a) * L; yy += Math.sin(a) * L;
        pts.push([xx, yy, s0 + i]);
        if (depth < 2 && Math.random() < 0.05 && branches.length < 22) {
          walk(xx, yy, a + (Math.random() < 0.5 ? -1 : 1) * rand(0.4, 0.9), rint(4, Math.max(5, (n - i) >> 1)), s0 + i, depth + 1);
        }
      }
      branches.push({ pts, depth });
    };
    while (y < ty && main.length < 420) {
      // tortuous at two scales: a slowly wandering heading plus per-step
      // jitter, pulled toward the attachment point as it closes in
      drift = clamp(drift * 0.9 + gauss() * 0.12, -0.7, 0.7);
      const want = Math.atan2(ty - y, tx - x);
      const pull = clamp(y / Math.max(1, ty), 0, 1);
      const a = clamp(Math.PI / 2 + drift + (want - Math.PI / 2) * (0.3 + 0.7 * pull) + gauss() * 0.42, Math.PI * 0.1, Math.PI * 0.9);
      const L = rand(6, 15) * S;
      x += Math.cos(a) * L; y += Math.sin(a) * L; step++;
      main.push([x, Math.min(y, ty), step]);
      if (Math.random() < 0.07 && y < ty * 0.85) {
        walk(x, y, a + (Math.random() < 0.5 ? -1 : 1) * rand(0.35, 0.95), rint(6, 30), step, 1);
      }
    }
    // eight control points for the shader's distance falloff
    const ctl = new Float32Array(16);
    for (let i = 0; i < 8; i++) {
      const q = main[Math.round((i / 7) * (main.length - 1))];
      ctl[i * 2] = q[0]; ctl[i * 2 + 1] = q[1];
    }
    return { main, branches, steps: step, ctl, x0, endY: ty };
  }

  /* Relative illuminance of one strike, t ms after attachment (negative =
     leader still descending). Two return strokes, each a fast exponential
     with a continuing-current tail. */
  const strokeI = (ts, s) => {
    if (ts < 0) return 0.05 * clamp(1 + ts / s.leaderMs, 0, 1);    // the faint leader
    let v = 0;
    for (const k of s.strokes) {
      if (ts < k.t) continue;
      const d = ts - k.t;
      v += k.a * (Math.exp(-d / 70) * 0.75 + Math.exp(-d / 320) * 0.25);
    }
    return Math.min(1, v);
  };

  function thunderstorm(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const f = ctx.fit(1600, 1500, 600);
    const total = ctx.duration;
    const OUT_AT = f.intro + f.hold;
    const red = ctx.reduced;

    let fx = null;
    try { fx = gl(stage, FRAG, { snapshot: ctx.snapshot }); } catch (err) {
      console.warn('[Screenick] thunderstorm shader, using fallback:', err);
      fx = null;
      stage.textContent = '';
    }
    let sky = null;
    if (fx) {
      if (ctx.snapshot) lockScroll();
      fx.set('uBolt', new Float32Array(16).fill(-1e4), '2fv');
    } else {
      css(`${R} .sfx-sky{position:absolute;inset:0;opacity:0;background:rgba(10,14,24,.42);
 -webkit-backdrop-filter:brightness(.6) saturate(.45);backdrop-filter:brightness(.6) saturate(.45);}`);
      sky = div('sfx-sky');
      stage.appendChild(sky);
    }

    const rain = canvasLayer(stage);
    const rg = rain.g;
    // The bolt is outside the window: with WebGL it is drawn offscreen and the
    // shader composites it BEHIND the water (refracted by drops, fogged by the
    // film). It is only re-uploaded on frames where it changes.
    let boltCv, bg, boltL = null;
    if (fx) {
      boltCv = document.createElement('canvas');
      boltCv.width = W; boltCv.height = H;
      bg = boltCv.getContext('2d');
      fx.texture('uBoltTex', boltCv, 1);
      fx.set('uBoltOn', 0);
    } else {
      boltL = canvasLayer(stage);
      boltCv = boltL.cv; bg = boltL.g;
    }

    /* ---- strikes ----------------------------------------------------------- */
    let targets = [];
    try {
      targets = blocks({ max: 80, minSize: 50 })
        .filter((b) => b.y > H * 0.42 && b.y < H * 0.9 && b.w < W * 0.9)
        .map((b) => [b.x + b.w * rand(0.2, 0.8), b.y]);
    } catch (err) { targets = []; }
    const strikes = [];
    if (!red) {
      const first = Math.max(f.intro * 0.75, 500);
      const last = OUT_AT + f.outro * 0.15;
      for (let t = first; t < last; t += rand(1900, 4200)) strikes.push(t);
      if (!strikes.length) strikes.push(Math.min(first, total * 0.45));
    }
    const plan = strikes.map((at) => {
      const I = rand(0.72, 1);
      const dist = rand(0, 1);                            // 0 near .. 1 far
      return {
        at, I, dist, bolt: null,
        leaderMs: rand(110, 170),
        strokes: [{ t: 0, a: 1 }, { t: rand(60, 110), a: rand(0.5, 0.72) }],
        rumbleAt: 0, rumbleAmp: (1.2 + 2.4 * (1 - dist)) * I
      };
    });

    /* ---- rain in the air --------------------------------------------------- */
    const N = Math.round(clamp((W * H) / 4200, 150, 420) * (red ? 0.4 : 1));
    const vs = H / 900;
    const drops = [];
    for (let i = 0; i < N; i++) {
      const lay = i % 3;                                  // 0 far, 1 mid, 2 near
      drops.push({ x: rand(-0.2, 1.1) * W, y: rand(-H, H), lay, v: (1250 + 650 * lay) * vs * rand(0.9, 1.1), live: true });
    }
    const LAYER = [
      { w: 0.7, len: 16, a: 0.16 },
      { w: 1.1, len: 30, a: 0.22 },
      { w: 2.0, len: 52, a: 0.16 }
    ];

    const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

    const strokePath = (pts, upto) => {
      bg.beginPath();
      let started = false;
      for (const q of pts) {
        if (q[2] > upto) break;
        if (started) bg.lineTo(q[0], q[1]); else { bg.moveTo(q[0], q[1]); started = true; }
      }
      bg.stroke();
    };
    const drawBolt = (b, upto, lvl, leader) => {
      bg.lineCap = 'round'; bg.lineJoin = 'round';
      const passes = leader
        ? [[5, 'rgba(170,180,255,.06)'], [1.1, 'rgba(225,230,255,.32)']]
        : [[30, 'rgba(120,140,255,.06)'], [13, 'rgba(150,170,255,.14)'], [5.5, 'rgba(205,215,255,.5)'], [2.6, 'rgba(255,255,255,1)']];
      for (const [wd, col] of passes) {
        bg.strokeStyle = col;
        bg.globalAlpha = leader ? 1 : lvl;
        bg.lineWidth = wd;
        strokePath(b.main, upto);
        bg.globalAlpha = leader ? 0.8 : Math.pow(lvl, 1.6) * 0.7;
        for (const br of b.branches) {
          bg.lineWidth = wd * (br.depth === 1 ? 0.55 : 0.35);
          strokePath(br.pts, upto);
        }
      }
      bg.globalAlpha = 1;
    };

    let boltDrawn = false;
    loop((dt, t) => {
      const done = t >= total;
      const s = dt / 1000;
      const ou = clamp((t - OUT_AT) / f.outro, 0, 1);

      const over = done ? 0 : Math.min(smooth(t / f.intro), 1 - smooth(ou / 0.92));
      const wet = done ? 0 : Math.min(smooth((t - 0.12 * f.intro) / (0.9 * f.intro)), 1 - smooth((ou - 0.05) / 0.85));
      const run = done ? 0 : Math.min(smooth((t - 0.45 * f.intro) / f.intro), 1 - smooth((ou - 0.1) / 0.75));
      const rainAmt = done ? 0 : Math.min(smooth(t / (0.6 * f.intro)), 1 - smooth(ou / 0.45));

      // lightning
      let flash = 0, live = null, shakeX = 0, shakeY = 0;
      for (const st of plan) {
        const ts = t - st.at - st.leaderMs;               // ms since attachment
        if (ts < -st.leaderMs) continue;
        if (!st.bolt) {
          st.bolt = makeBolt(W, H, targets);
          st.rumbleAt = st.at + st.leaderMs + 380 + st.dist * 1300;
        }
        if (ts > 1200) continue;
        const v = strokeI(ts, st) * st.I;
        if (!live || v > flash) { flash = v; live = { st, ts, v }; }
      }
      if (!red) {
        for (const st of plan) {
          if (!st.rumbleAt) continue;
          const u = (t - st.rumbleAt) / 1100;
          if (u < 0 || u > 1) continue;
          const e = (u < 0.12 ? u / 0.12 : Math.pow(1 - (u - 0.12) / 0.88, 1.6)) * st.rumbleAmp;
          shakeX += e * (Math.sin(t * 0.061) * 0.6 + Math.sin(t * 0.137 + 1.3) * 0.4);
          shakeY += e * 0.6 * (Math.sin(t * 0.083 + 2.1) * 0.6 + Math.sin(t * 0.171) * 0.4);
        }
      }

      if (fx) {
        fx.set('uOver', over);
        fx.set('uWet', wet);
        fx.set('uRun', run);
        fx.set('uFlash', done ? 0 : flash * 0.8);
        fx.set('uShake', [shakeX, shakeY]);
        if (live) fx.set('uBolt', live.st.bolt.ctl, '2fv');
      } else {
        sky.style.opacity = String(over * (1 - 0.55 * flash));
      }
      const tr = `translate3d(${(-shakeX).toFixed(2)}px,${(-shakeY).toFixed(2)}px,0)`;
      rain.cv.style.transform = tr;
      if (boltL) boltL.cv.style.transform = tr;

      // bolt
      let boltChanged = false;
      if (live && !done && (live.ts < 0 || live.v > 0.03)) {
        bg.clearRect(0, 0, W, H);
        const b = live.st.bolt;
        if (live.ts < 0) drawBolt(b, b.steps * (1 + live.ts / live.st.leaderMs), 0, true);
        else drawBolt(b, 1e9, clamp(live.v / live.st.I, 0, 1), false);
        boltDrawn = true; boltChanged = true;
      } else if (boltDrawn) {
        bg.clearRect(0, 0, W, H);
        boltDrawn = false; boltChanged = true;
      }
      if (fx) {
        if (boltChanged) fx.texture('uBoltTex', boltCv, 1);
        fx.set('uBoltOn', boltDrawn ? 1 : 0);
        fx.draw(t / 1000);
      }

      // rain streaks
      rg.clearRect(0, 0, W, H);
      if (!done && rainAmt > 0) {
        const gust = 0.13 + 0.09 * Math.sin(t / 2100) + 0.06 * Math.sin(t / 830 + 1) + 0.08 * Math.max(0, Math.sin(t / 4700 + 2));
        const sx = Math.sin(gust), cy = Math.cos(gust);
        rg.lineCap = 'round';
        const lit = 1 + 2.2 * flash;
        for (let l = 0; l < 3; l++) {
          const Ly = LAYER[l];
          rg.strokeStyle = `rgba(205,218,238,${Math.min(0.8, Ly.a * lit * rainAmt).toFixed(3)})`;
          rg.lineWidth = Ly.w;
          rg.beginPath();
          for (let i = l; i < N; i += 3) {
            const d = drops[i];
            if (!d.live) continue;
            d.y += d.v * s * cy;
            d.x += d.v * s * sx;
            if (d.y > H + 60) {
              if (t > OUT_AT && Math.random() > rainAmt) { d.live = false; continue; }
              d.y = rand(-120, -20); d.x = rand(-0.2, 1.05) * W;
            }
            if (i / N > rainAmt) continue;
            const len = Ly.len * vs;
            rg.moveTo(d.x, d.y);
            rg.lineTo(d.x - sx * len, d.y - cy * len);
          }
          rg.stroke();
        }
      }
      return !done;
    });

    return total;
  }

  sfx.register('thunderstorm', thunderstorm);
})();
