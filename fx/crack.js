/* ScreenFX effect module — registers into the runtime in content.js. */
(() => {
  const sfx = window.__screenFX;
  if (!sfx || !sfx.kit) return;
  // eslint-disable-next-line no-unused-vars
  const { R, SPRING, SPRING_MS, rand, rint, pick, clamp, svgFrom, el, div, later, listen, loop, canvasLayer, envelope, easeOut3, easeIn2, shake, breathe, pageLuminance, gl, lockScroll, blocks } = sfx.kit;

  /* ========================================================================
   * 6. SCREEN CRACK: a dropped phone, rendered through the real page.
   *
   *    MODEL. A cracked screen is two damaged layers, and both act on the
   *    actual pixels underneath.
   *
   *    GLASS. Cover glass breaks from the impact point with radial cracks,
   *    concentric chords (hoop stress), branching where the crack front runs
   *    fast, and a pulverised core. A crack front in soda-lime glass tops out
   *    around 1500 m/s (0.4-0.6 of the Rayleigh wave speed), so the whole
   *    pattern exists within a frame or two. Each crack is a sub-micron air
   *    gap with chipped, bevelled flanks, which makes it an optical element:
   *      - the page is REFRACTED across it (offset along the face normal),
   *        with dispersion, so red and blue separate into thin fringes;
   *      - the bevel that faces the light glints and the opposite bevel falls
   *        into shadow, so you see a specular line on one flank only;
   *      - on a bright page the gap scatters light away and reads grey; on a
   *        dark page it is the only thing reflecting, so it reads silver;
   *      - the crushed core is a frosted powder that blurs and whitens what
   *        is under it, ringed by fragments that grow with distance.
   *    The panel is laminated to the glass, so shards cannot slide. They only
   *    tilt a fraction of a degree, which shows as a sub-pixel to 3px
   *    refraction step at each crack and a faint per-shard sheen. A broken-
   *    mirror shift would be wrong.
   *
   *    PANEL. Under the glass the LCD itself is broken: liquid crystal bleeds
   *    out of ruptured cells as an opaque black amoeba with a violet/amber
   *    fringe that actually covers content, row/column driver failures draw
   *    hard saturated lines across the whole screen that ignore the cracks,
   *    pressure leaves a rainbow mura, and the backlight leaks around the
   *    impact.
   *
   *    RENDERING. The fracture geometry is rasterised once into textures:
   *    crack core (R), a blurred halo (G) whose gradient is the face normal,
   *    and the ink field (B), plus a half-resolution shard map labelled by
   *    flood fill (each connected shard gets a random tilt). Everything else
   *    happens in one fragment shader over the page snapshot. Nothing is
   *    uploaded per frame. Without a snapshot or WebGL, an SVG/CSS rendering
   *    of the same geometry is drawn over the live page.
   * ====================================================================== */

  /* ---- fracture geometry: shared by both renderers ------------------------ */
  function fracture(W, H) {
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
    const rc = rand(11, 19);                          // pulverised core radius

    /* radials. Heavy jitter on the gaps. Evenly spaced spokes read as a
       starburst. */
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

    /* branches: inner third only, 30-45 degrees */
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

    /* concentric chords, at geometrically growing radii. This is what turns
       a star into a shatter, and the growth gives the density gradient: tiny
       cells at the impact, big ones far out. */
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

    /* slivers, micro-cracks and the fragment cluster */
    const extra = [];
    // Long thin wedges trapped between two near-parallel radials.
    for (let i = 0; i < n; i++) {
      const A = spokes[i], B = spokes[(i + 1) % n];
      if (Math.abs(B.a - A.a) > gap * 1.1) continue;
      if (Math.random() < 0.45) continue;
      const r0 = rand(rc * 2, reach * 0.4), r1 = r0 * rand(1.5, 2.6);
      if (radiusOf(A.pts[A.pts.length - 1]) < r1) continue;
      extra.push({ pts: [atRadius(A.pts, r0), atRadius(B.pts, r1)], w: 0.9, op: 0.5, sep: true });
    }
    // Hair-thin secondary cracking inside the bigger outer cells.
    for (let i = 0; i < 22; i++) {
      const a = rand(spanLo, spanHi), r = rand(reach * 0.3, reach * 0.9);
      const x = ox + Math.cos(a) * r, y = oy + Math.sin(a) * r;
      if (x < -40 || x > W + 40 || y < -40 || y > H + 40) continue;
      const d = rand(0, Math.PI * 2), l = rand(18, 62);
      extra.push({ pts: [[x, y], [x + Math.cos(d) * l, y + Math.sin(d) * l]], w: 0.75, op: rand(0.16, 0.34) });
    }
    // The pulverised ring: dozens of tiny fragments hugging the crush zone.
    for (let i = 0; i < 34; i++) {
      const a = rand(0, Math.PI * 2), b = a + rand(-0.7, 0.7);
      const r0 = rc * rand(0.9, 2.4), r1 = r0 * rand(1.3, 2.4);
      extra.push({
        pts: [[ox + Math.cos(a) * r0, oy + Math.sin(a) * r0], [ox + Math.cos(b) * r1, oy + Math.sin(b) * r1]],
        w: 1, op: rand(0.5, 1), sep: true
      });
    }

    /* ribbons: width(s) = wmax * sqrt(s/L) behind the tip: blunt nearly all
       the way, needle-sharp only at the very end. A linear taper is the tell. */
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

    // Alpha wanders along every crack. Constant alpha looks drawn, not broken.
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

    // Polylines that actually separate glass into shards (for the shard map).
    const lines = [].concat(
      spokes.map((s) => s.pts), branches.map((b) => b.pts), rings.map((r) => r.pts),
      extra.filter((e) => e.sep).map((e) => e.pts)
    );

    /* panel damage: an amoeba, not a circle. Several lobes and one long
       finger, elongated by gravity, anchored where the cells ruptured. */
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

    // Driver damage: hard saturated lines across the full screen that ignore
    // the crack geometry entirely. Clustered, never evenly spaced.
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
    const mura = { x: ox - rand(140, 260), y: oy - rand(90, 170), w: rand(280, 520), h: rand(150, 300) };

    return { ox, oy, rc, reach, parts, lines, blob, bands, hBands, mura };
  }

  /* ---- timing shared by both renderers ----------------------------------- */
  const RACE = 90;                 // crack front: effectively instant
  const BLEED_AT = 160, BLEED_MS = 900;
  const INTRO = BLEED_AT + BLEED_MS, OUTRO = 700;

  function crack(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const G = fracture(W, H);
    let fx = null;
    if (ctx.snapshot) {
      try { fx = gl(stage, FRAG, { snapshot: ctx.snapshot }); } catch (err) { fx = null; }
      if (!fx) stage.textContent = '';
    }
    return fx ? crackGl(stage, css, ctx, G, fx) : crackSvg(stage, css, ctx, G);
  }

  /* ---- hard impact shake: bigger and sharper than the kit's default ------ */
  const impact = (stage, css, ctx) => {
    if (ctx.reduced) return;
    css(`@keyframes sfx-crk-shake{0%{transform:translate3d(0,0,0)}
5%{transform:translate3d(-15px,9px,0) rotate(-.55deg)}13%{transform:translate3d(12px,-8px,0) rotate(.45deg)}
22%{transform:translate3d(-9px,-5px,0) rotate(-.2deg)}33%{transform:translate3d(7px,5px,0) rotate(.18deg)}
45%{transform:translate3d(-4px,3px,0)}58%{transform:translate3d(3px,-2px,0)}72%{transform:translate3d(-1.5px,1px,0)}
86%{transform:translate3d(.6px,-.4px,0)}100%{transform:translate3d(0,0,0)}}`);
    stage.style.animation = 'sfx-crk-shake 620ms cubic-bezier(.2,.7,.3,1) both';
  };

  /* ======================================================================
   * WebGL path: optics on the real page
   * ==================================================================== */
  const FRAG = `
uniform sampler2D uCrack;   // R crack core, G halo, B ink field
uniform sampler2D uShard;   // RG shard tilt (0.5 = none)
uniform vec2 uO, uLight, uMuraC, uMuraS;
uniform float uRc, uReach, uFront, uInk, uInkR, uLinesOn, uMura, uBloom, uMix;
uniform vec4 uLines[10];    // pos, width, horizontal?, opacity
uniform vec3 uLineCol[10];

vec4 ck(vec2 p) { return texture2D(uCrack, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 hue(float h) { return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }

void main() {
  vec2 p = cssPos();
  vec3 clean = pageAt(p).rgb;
  if (uMix <= 0.0) { gl_FragColor = vec4(clean, 1.0); return; }

  vec2 dv = p - uO;
  float d = length(dv);
  // the fracture front, slightly ragged
  float rev = clamp((uFront - d - vnoise(p * 0.04) * 60.0) / 30.0, 0.0, 1.0);

  vec4 c0 = ck(p);
  float core = c0.r * rev;
  float halo = c0.g * rev;
  // halo gradient = the bevel normal, pointing into the crack
  const float E = 1.25;
  vec2 grad = vec2(ck(p + vec2(E, 0.0)).g - ck(p - vec2(E, 0.0)).g,
                   ck(p + vec2(0.0, E)).g - ck(p - vec2(0.0, E)).g) / (2.0 * E) * rev;
  float gl = length(grad);
  vec2 nn = gl > 1e-4 ? grad / gl : vec2(0.0);

  // laminated shards: a tiny tilt each, more near the impact
  vec2 tilt = (texture2D(uShard, vUv).rg - 0.5) * 2.0 * rev;
  float nearO = exp(-d / (uReach * 0.16));
  vec2 off = tilt * (0.3 + 1.3 * nearO) + grad * 6.0;

  // refraction with dispersion: blue bends more than red
  vec2 disp = grad * 5.0 + tilt * 0.25 * nearO;
  vec3 col = vec3(pageAt(p + off - disp).r, pageAt(p + off).g, pageAt(p + off + disp).b);
  float L0 = luma(col);
  float bright = smoothstep(0.22, 0.62, L0);

  /* ---- panel (under the glass) ---------------------------------------- */
  if (uInk > 0.0 && d < uInkR) {
    // ragged, fingering edge: the crystal wicks along cell rows unevenly
    vec2 warp = (vec2(fbm(p * 0.018), fbm(p * 0.018 + 31.7)) - 0.5) * 70.0 + vec2(0.0, (vnoise(p * vec2(0.09, 0.012)) - 0.5) * 26.0);
    float iv = ck(p + warp).b + (vnoise(p * 0.08) - 0.5) * 0.05;
    float thr = 1.0 - 0.5 * uInk;
    float ink = smoothstep(thr, thr + 0.025, iv);
    float rim = smoothstep(thr - 0.16, thr, iv) * (1.0 - ink);
    vec3 fringe = mix(vec3(0.62, 0.40, 0.12), vec3(0.24, 0.12, 0.48), smoothstep(thr - 0.16, thr - 0.03, iv));
    col = mix(col, fringe * (0.3 + 0.5 * L0), rim * 0.9);
    float teal = smoothstep(0.02, 0.0, abs(iv - thr + 0.004)) * 0.5;
    col = mix(col, vec3(0.06, 0.36, 0.31), teal * (1.0 - ink));
    vec3 inkCol = vec3(0.016, 0.018, 0.035) + vec3(0.03, 0.01, 0.05) * fbm(p * 0.02 + 7.0);
    col = mix(col, inkCol, ink);
  }
  if (uMura > 0.0) {
    vec2 mq = (p - uMuraC) / uMuraS;
    float mm = exp(-dot(mq, mq) * 1.8) * uMura;
    if (mm > 0.004) {
      vec3 rb = hue(atan(mq.y, mq.x) / 6.2832 + fbm(p * 0.008) * 0.8);
      col = mix(col, col * (0.55 + 0.9 * rb), mm * 0.4);
    }
  }
  if (uBloom > 0.0) {
    col += vec3(1.0, 0.95, 0.88) * uBloom * 0.28 * exp(-d / (uRc * 5.5));
  }
  if (uLinesOn > 0.0) {
    for (int i = 0; i < 10; i++) {
      vec4 Ln = uLines[i];
      if (Ln.w <= 0.0) continue;
      float pos = Ln.z > 0.5 ? p.y : p.x;
      float on = step(Ln.x - 0.01, pos) * step(pos, Ln.x + Ln.y - 0.01);
      col = mix(col, uLineCol[i], on * Ln.w);
    }
  }

  /* ---- glass (on top) -------------------------------------------------- */
  // the gap: scatters light away on bright content, glints on dark
  col = mix(col, col * 0.3 + 0.07, core * 0.9 * bright);
  col += core * (1.0 - bright) * vec3(0.58, 0.61, 0.66);
  // the bevel facing the light glints, the other falls into shadow
  float band = smoothstep(0.2, 0.55, halo) * (1.0 - c0.r);
  float facing = dot(nn, uLight);
  float spark = 0.35 + 0.65 * smoothstep(0.45, 0.85, vnoise(p * 0.11));
  float spec = pow(max(facing, 0.0), 4.0) * band * spark;
  float shade = pow(max(-facing, 0.0), 4.0) * band;
  vec3 specCol = mix(vec3(1.0), hue(fract(dot(p, vec2(0.013, 0.009)))), 0.25);
  col += specCol * spec * (0.34 + 0.4 * (1.0 - bright));
  col *= 1.0 - shade * 0.2;
  // each shard reflects the room a little differently
  col += dot(tilt, uLight) * 0.03 * (1.0 - 0.6 * bright);

  // pulverised core + the ring of fragments around it
  float crushR = uRc * 5.5;
  if (d < crushR && rev > 0.0) {
    float cs = 2.5 + d * 0.16;
    vec4 v = voronoi(p / cs);
    float ring = 1.0 - smoothstep(uRc * 1.6, crushR, d);
    float edge = (1.0 - smoothstep(0.0, 0.1, v.y)) * ring * rev;
    col = mix(col, col * 0.45 + 0.08, edge * 0.75 * bright);
    col += edge * (1.0 - bright) * 0.45;
    col += (hash12(v.zw) - 0.5) * 0.14 * ring * rev;
    float fr = (1.0 - smoothstep(uRc * 0.9, uRc * 2.4, d + (fbm(p * 0.09) - 0.5) * uRc * 1.4)) * rev;
    if (fr > 0.0) {
      vec3 bl = vec3(0.0);
      for (int k = 0; k < 8; k++) {
        float a = float(k) * 0.785398 + hash12(p) * 0.6;
        bl += pageAt(p + vec2(cos(a), sin(a)) * 3.5).rgb;
      }
      bl /= 8.0;
      vec3 powder = bl * 0.55 + vec3(0.86, 0.89, 0.93) * 0.45 + (hash12(floor(p)) - 0.5) * 0.08;
      col = mix(col, powder, fr * 0.92);
    }
  }

  gl_FragColor = vec4(clamp(mix(clean, col, uMix), 0.0, 1.0), 1.0);
}
`;

  const hexRgb = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

  /* Rasterise the crack geometry: R core, G halo (blurred), B ink field. */
  function crackTexture(G, W, H, dpr) {
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { c, g };
    };
    const main = mk();
    main.g.fillStyle = '#000';
    main.g.fillRect(0, 0, W, H);
    main.g.globalCompositeOperation = 'lighter';
    G.parts.forEach((pt) => {
      main.g.fillStyle = `rgb(${Math.round(255 * pt.op)},0,0)`;
      main.g.fill(new Path2D(pt.d));
    });

    // halo: the crack polylines stroked wide, then blurred into a soft ridge
    const halo = mk();
    halo.g.strokeStyle = 'rgb(0,255,0)';
    halo.g.lineCap = 'round'; halo.g.lineJoin = 'round';
    G.lines.forEach((pts) => {
      halo.g.lineWidth = pts.length > 3 ? 2.6 : 1.8;
      halo.g.beginPath();
      halo.g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) halo.g.lineTo(pts[i][0], pts[i][1]);
      halo.g.stroke();
    });
    main.g.setTransform(1, 0, 0, 1, 0, 0);
    main.g.filter = `blur(${(2.2 * dpr).toFixed(1)}px)`;
    main.g.drawImage(halo.c, 0, 0);

    // ink field: high at the rupture, ~0.55 at the blob's rim, blurred out
    const ink = mk();
    ink.g.translate(G.ox, G.oy);
    const gr = ink.g.createRadialGradient(0, 0, 0, 0, 0, G.blob.rx * 1.9);
    gr.addColorStop(0, 'rgb(0,0,255)');
    gr.addColorStop(0.5, 'rgb(0,0,190)');
    gr.addColorStop(1, 'rgb(0,0,140)');
    ink.g.fillStyle = gr;
    ink.g.fill(new Path2D(G.blob.d));
    main.g.filter = `blur(${(12 * dpr).toFixed(1)}px)`;
    main.g.drawImage(ink.c, 0, 0);
    main.g.filter = 'none';
    return main.c;
  }

  /* Shard map at half resolution: flood-fill the regions the cracks enclose
     and give each one a small random tilt. Crack pixels take a neighbour's
     label, so the refraction step sits on the crack line itself. */
  function shardTexture(G, W, H) {
    const sw = Math.max(2, Math.round(W / 2)), shh = Math.max(2, Math.round(H / 2));
    const c = document.createElement('canvas');
    c.width = sw; c.height = shh;
    const g = c.getContext('2d', { willReadFrequently: true });   // CPU canvas: one cheap readback
    g.fillStyle = '#fff';
    g.fillRect(0, 0, sw, shh);
    g.scale(0.5, 0.5);
    g.strokeStyle = '#000';
    g.lineWidth = 2.2;
    g.lineCap = 'round'; g.lineJoin = 'round';
    G.lines.forEach((pts) => {
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.stroke();
    });
    const img = g.getImageData(0, 0, sw, shh);
    const px = img.data;
    const N = sw * shh;
    const lab = new Int32Array(N).fill(-1);
    const stack = new Int32Array(N);
    const sizes = [];
    for (let i = 0; i < N; i++) {
      if (lab[i] !== -1 || px[i * 4] < 128) continue;
      const id = sizes.length;
      let top = 0, count = 0;
      stack[top++] = i; lab[i] = id;
      while (top) {
        const k = stack[--top];
        count++;
        const x = k % sw, y = (k / sw) | 0;
        if (x > 0 && lab[k - 1] === -1 && px[(k - 1) * 4] >= 128) { lab[k - 1] = id; stack[top++] = k - 1; }
        if (x < sw - 1 && lab[k + 1] === -1 && px[(k + 1) * 4] >= 128) { lab[k + 1] = id; stack[top++] = k + 1; }
        if (y > 0 && lab[k - sw] === -1 && px[(k - sw) * 4] >= 128) { lab[k - sw] = id; stack[top++] = k - sw; }
        if (y < shh - 1 && lab[k + sw] === -1 && px[(k + sw) * 4] >= 128) { lab[k + sw] = id; stack[top++] = k + sw; }
      }
      sizes.push(count);
    }
    // crack pixels inherit a neighbouring shard
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < N; i++) {
        if (lab[i] !== -1) continue;
        const x = i % sw;
        const nb = (x > 0 && lab[i - 1] !== -1) ? lab[i - 1] : (i >= sw && lab[i - sw] !== -1) ? lab[i - sw]
          : (x < sw - 1 && lab[i + 1] !== -1) ? lab[i + 1] : (i + sw < N && lab[i + sw] !== -1) ? lab[i + sw] : -1;
        if (nb !== -1) lab[i] = nb;
      }
    }
    // the biggest region is the glass that did not break: no tilt
    let biggest = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[biggest]) biggest = i;
    const tx = new Uint8Array(sizes.length), ty = new Uint8Array(sizes.length);
    for (let i = 0; i < sizes.length; i++) {
      const a = Math.random() * Math.PI * 2, m = i === biggest ? 0 : Math.sqrt(Math.random());
      tx[i] = Math.round(128 + Math.cos(a) * m * 126);
      ty[i] = Math.round(128 + Math.sin(a) * m * 126);
    }
    for (let i = 0; i < N; i++) {
      const id = lab[i];
      px[i * 4] = id < 0 ? 128 : tx[id];
      px[i * 4 + 1] = id < 0 ? 128 : ty[id];
      px[i * 4 + 2] = 0;
      px[i * 4 + 3] = 255;
    }
    return img;
  }

  function crackGl(stage, css, ctx, G, fx) {
    const W = fx.W, H = fx.H;
    const f = ctx.fit(INTRO, OUTRO, 600);
    const k = f.k;
    const total = f.intro + f.hold + f.outro;
    const OUT_AT = f.intro + f.hold;
    lockScroll();

    fx.texture('uCrack', crackTexture(G, W, H, fx.dpr), 1);
    fx.texture('uShard', shardTexture(G, W, H), 2, { linear: false });
    fx.set('uO', [G.ox, G.oy]);
    fx.set('uRc', G.rc);
    fx.set('uReach', G.reach);
    fx.set('uInkR', G.blob.rx * 2.1 + 90);      // blob + blur + edge warp
    fx.set('uMuraC', [G.mura.x + G.mura.w / 2, G.mura.y + G.mura.h / 2]);
    fx.set('uMuraS', [G.mura.w / 2, G.mura.h / 2]);

    const lines = new Float32Array(40), cols = new Float32Array(30);
    G.bands.concat(G.hBands).slice(0, 10).forEach((b, i) => {
      const hz = b.y !== undefined;
      lines.set([hz ? Math.round(b.y) : Math.round(b.x), hz ? b.h : b.w, hz ? 1 : 0, b.o], i * 4);
      cols.set(hexRgb(b.c), i * 3);
    });
    fx.set('uLines', lines, '4fv');
    fx.set('uLineCol', cols, '3fv');

    // A live damaged panel's driver lines drop out now and then, irregularly.
    const blinks = [];
    if (!ctx.reduced) {
      for (let t = RACE + 600; t < OUT_AT - 400; t += rand(1600, 5200)) blinks.push([t, t + rand(40, 95)]);
    }

    impact(stage, css, ctx);

    const baseAng = Math.atan2(-0.8, -0.6) + rand(-0.4, 0.4);   // light from above
    const race = RACE * k, bleedAt = BLEED_AT * k, bleedMs = BLEED_MS * k;
    let frame = 0;
    let fading = false;
    loop((dt, t) => {
      if (t >= total) return false;
      frame++;
      const inHold = t > f.intro && t < OUT_AT;
      // during the hold only the slow glint drift moves: 30 Hz is plenty
      if (inHold && frame % 2) return;
      if (!fading && t >= total - 200) {
        fading = true;
        fx.canvas.style.transition = 'opacity 180ms linear';
        fx.canvas.style.opacity = '0';
      }
      fx.set('uFront', G.reach * 1.2 * easeOut3(t / race));
      fx.set('uInk', easeOut3((t - bleedAt) / bleedMs));
      const blink = blinks.some((b) => t >= b[0] && t < b[1]);
      fx.set('uLinesOn', t > race * 0.5 && !blink ? 1 : 0);
      fx.set('uMura', 0.9 * easeOut3((t - race * 0.7) / (620 * k)));
      fx.set('uBloom', easeOut3((t - 90 * k) / (420 * k)));
      // the phone is never held perfectly still: the light drifts a little
      const a = baseAng + (ctx.reduced ? 0 : 0.35 * Math.sin(t / 1900) + 0.12 * Math.sin(t / 730));
      fx.set('uLight', [Math.cos(a), Math.sin(a)]);
      fx.set('uMix', t < OUT_AT ? 1 : 1 - (1 - Math.pow(1 - clamp((t - OUT_AT) / f.outro, 0, 1), 2)));
      fx.draw(t / 1000);
    });
    return total;
  }

  /* ======================================================================
   * Fallback: no snapshot or no WebGL. The same geometry as SVG/CSS over the
   * live page. Fragments stay put (laminated glass), the panel layer is
   * opaque ink.
   * ==================================================================== */
  function crackSvg(stage, css, ctx, G) {
    const W = window.innerWidth, H = window.innerHeight;
    const { ox, oy, rc, reach, parts, blob, bands, hBands } = G;
    const uid = 'sfx' + ((Math.random() * 1e9) | 0).toString(36);
    const light = pageLuminance() > 0.5;
    // On a bright page the crack scatters away more light than the surround
    // returns, so it reads grey; on a dark page it goes silver.
    const core = light ? 'rgba(74,80,90,.88)' : 'rgba(236,244,252,.8)';
    const flank = light ? 'rgba(255,255,255,.85)' : 'rgba(6,9,14,.75)';

    const f = ctx.fit(INTRO, OUTRO, 600);
    const k = f.k;
    const race = Math.round(210 * k), bleedAt = Math.round(BLEED_AT * k), bleedMs = Math.round(BLEED_MS * k);
    const total = f.intro + f.hold + f.outro;
    const OUT_AT = f.intro + f.hold;

    const layer = (fill) => parts.map((p) => `<path d="${p.d}" fill="${fill}" opacity="${p.op}"/>`).join('');

    css(`
${R} .sfx-glass{position:absolute;inset:0;}
${R} .sfx-flank{transform:translate3d(1.1px,1.1px,0);}
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
 -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);
 transform:scale(.3);animation:sfx-crush 360ms cubic-bezier(.14,.88,.3,1) 20ms forwards;}
${R} .sfx-bloom{position:absolute;left:${ox.toFixed(1)}px;top:${oy.toFixed(1)}px;
 width:${(rc * 13).toFixed(1)}px;height:${(rc * 13).toFixed(1)}px;
 margin:${(-rc * 6.5).toFixed(1)}px 0 0 ${(-rc * 6.5).toFixed(1)}px;border-radius:50%;
 background:radial-gradient(circle,rgba(255,246,232,.34) 0%,rgba(255,244,226,.12) 36%,transparent 72%);
 mix-blend-mode:screen;opacity:0;
 animation:sfx-bloom-in 420ms cubic-bezier(.2,.9,.3,1) 90ms forwards;}
${R} .sfx-panel{position:absolute;inset:0;opacity:0;
 animation:sfx-bleed ${bleedMs}ms cubic-bezier(.16,.72,.3,1) ${bleedAt}ms forwards;}
${R} .sfx-ink{fill:#05060B;}
${R} .sfx-ink-v{fill:none;stroke:${light ? '#2E2145' : '#5B3F8C'};stroke-width:14;filter:blur(4px);}
${R} .sfx-ink-a{fill:none;stroke:${light ? '#3A2A18' : '#8A5C22'};stroke-width:6;filter:blur(2px);}
${R} .sfx-ink-t{fill:none;stroke:#0F5C50;stroke-width:1.6;opacity:.7;}
${R} .sfx-ink-h{position:absolute;left:${ox.toFixed(1)}px;top:${oy.toFixed(1)}px;
 width:${(blob.rx * 4).toFixed(0)}px;height:${(blob.rx * 3.2).toFixed(0)}px;
 margin:${(-blob.rx * 1.6).toFixed(0)}px 0 0 ${(-blob.rx * 2).toFixed(0)}px;border-radius:50%;
 background:radial-gradient(circle,rgba(46,20,60,.6) 0%,rgba(30,14,42,.3) 44%,transparent 74%);
 filter:blur(10px);}
${R} .sfx-vb{position:absolute;top:0;bottom:0;}
${R} .sfx-hb{position:absolute;left:0;right:0;}
${R} .sfx-bandw{position:absolute;inset:0;opacity:0;
 animation:sfx-fade-in 90ms steps(1,end) ${(race * 0.5).toFixed(0)}ms forwards;}
${R} .sfx-mura{position:absolute;border-radius:50%;mix-blend-mode:overlay;
 background:conic-gradient(from 0deg,#FF4D4D,#FFD24D,#4DFF88,#4DD2FF,#8A4DFF,#FF4DC4,#FF4D4D);
 filter:blur(60px);opacity:0;
 animation:sfx-mura-in 620ms cubic-bezier(.2,.9,.3,1) ${(race * 0.7).toFixed(0)}ms forwards;}
@keyframes sfx-mura-in{to{opacity:.26}}
@keyframes sfx-bloom-in{to{opacity:.8}}
@keyframes sfx-crush{from{transform:scale(.2)}to{transform:scale(1)}}
@keyframes sfx-race{from{r:0}to{r:${(reach * 1.14).toFixed(0)}}}
@keyframes sfx-bleed{from{opacity:0;transform:scale(.24)}to{opacity:1;transform:scale(1)}}
`);

    // one wrapper owns the outro opacity (the layers' own animations hold theirs)
    const wrap = div('sfx-glass');
    stage.appendChild(wrap);
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
    wrap.appendChild(panel);

    const mura = div('sfx-mura',
      `left:${G.mura.x.toFixed(0)}px;top:${G.mura.y.toFixed(0)}px;` +
      `width:${G.mura.w.toFixed(0)}px;height:${G.mura.h.toFixed(0)}px;`);
    wrap.appendChild(mura);

    const bandw = div('sfx-bandw');
    bands.forEach((b) => bandw.appendChild(div('sfx-vb',
      `left:${b.x.toFixed(0)}px;width:${b.w}px;background:${b.c};opacity:${b.o.toFixed(2)};`)));
    hBands.forEach((b) => bandw.appendChild(div('sfx-hb',
      `top:${b.y.toFixed(0)}px;height:${b.h}px;background:${b.c};opacity:${b.o.toFixed(2)};`)));
    wrap.appendChild(bandw);
    wrap.append(div('sfx-bloom'));

    const svg = svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" class="sfx-glass" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs><clipPath id="${uid}r"><circle class="sfx-race" cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="0"/></clipPath></defs>
  <g clip-path="url(#${uid}r)">
    <g class="sfx-flank">${layer(flank)}</g>
    <g>${layer(core)}</g>
  </g>
</svg>`);
    wrap.appendChild(svg);
    svg.querySelector('.sfx-race').style.animation = `sfx-race ${race}ms cubic-bezier(.05,.86,.28,1) forwards`;
    wrap.append(div('sfx-frost'), div('sfx-crush'));
    impact(stage, css, ctx);

    if (!ctx.reduced) {
      for (let t = race + 600; t < OUT_AT - 400; t += rand(1600, 5200)) {
        const at = t;
        later(() => { bandw.style.opacity = '0'; }, at);
        later(() => { bandw.style.opacity = '1'; }, at + rand(40, 95));
      }
    }
    // The shake owns stage.transform, so fade the wrapper rather than the stage.
    later(() => {
      wrap.style.transition = `opacity ${f.outro}ms cubic-bezier(0.22,1,0.36,1)`;
      wrap.style.opacity = '0';
    }, OUT_AT);
    return total;
  }

  sfx.register('crack', crack);
})();
