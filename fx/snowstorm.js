/* Screenick effect module — registers into the runtime in content.js. */
(() => {
  const sfx = window.__screenick;
  if (!sfx || !sfx.kit) return;
  // eslint-disable-next-line no-unused-vars
  const { R, SPRING, SPRING_MS, rand, rint, pick, clamp, svgFrom, el, div, later, listen, loop, canvasLayer, envelope, easeOut3, easeIn2, shake, breathe, pageLuminance, gl, lockScroll, blocks } = sfx.kit;

  /* ========================================================================
   * 9. DEEP FREEZE: frost grows over the glass in front of the real page,
   *    snow falls past and settles on the page's own ledges, then it thaws.
   *
   *    Models
   *    - Growth: frost on a pane nucleates at the cold frame and at scratches,
   *      then grows diffusion-limited, so the front slows as sqrt(t) (the
   *      Stefan/DLA regime). Tips outrun flat faces (the Mullins-Sekerka
   *      instability), which is why fern frost runs ahead of the dense layer as
   *      dendrites: a stem with side branches at 60 degrees (hexagonal ice
   *      lattice), branching again. The dendrites are grown once on a canvas
   *      with a per-segment arrival time; the shader thresholds it against the
   *      front F(t), so the ice visibly grows tip-first.
   *    - Base field: T(p) = dx*dy/(dx+dy) (normalised), where dx, dy are the
   *      distances to the frame. It is 0 on the edges and halves along the
   *      diagonals, so the corners (coldest on a real window) freeze deepest.
   *    - Optics: frost is a rough, scattering ice film. Per pixel, with
   *      thickness tau and relief normal n:
   *        page' = blur(page(p + k*n.xy), r(tau))           refraction + scatter
   *        out   = page' * T + S + spec
   *        T     = (1 - 0.72 tau) * (1 - 0.55 * slope)      steep faces lose
   *                light to total internal reflection, so ridges go DARK
   *        S     = tau * ambient * (0.72 + 1.2 (n.L - L.z)) forward scatter,
   *                shaded by the relief
   *      On a white page that lands at a pale blue-grey with dark crystal
   *      edges; on a black page it reads as glowing white ice. That is why it
   *      is visible on any background, the way real frost is.
   *    - Snow: terminal velocity ~1 m/s, so screen speed is ~1/depth; flakes
   *      flutter (lateral sway, period ~1-2 s), near ones are defocused.
   *      Against a bright background a back-lit flake reads grey, against a
   *      dark one white; each flake is toned by the page luminance under it.
   *    - Thaw: thin frost melts first, the thick frame last; the melt leaves
   *      beads of water that act as small inverted lenses, and runnels that
   *      slide down with stick-slip, then evaporate.
   *    The pointer wipes the frost (passive pointermove; clicks go through),
   *    and the wiped track refreezes over a few seconds.
   * ====================================================================== */

  const MAX_CAPS = 16;

  /* Grow the fern frost once. Coordinates are CSS px. Each segment carries
     its arrival time in units of the growth front F. */
  function growFrost(W, H, reduced) {
    const norm = (W * H) / (2 * (W + H));
    const tb = (x, y) => {
      const dx = Math.max(0, Math.min(x, W - x)), dy = Math.max(0, Math.min(y, H - y));
      return (dx * dy) / (dx + dy + 1e-3) / norm;
    };
    const segs = [];                       // [x0, y0, x1, y1, cls, arrival]
    const LIMIT = reduced ? 16000 : 34000;
    const SPEED = [1.15, 1.5, 1.9];         // arrival per normalised length, by depth
    const fern = (x, y, ang, len, t0, depth) => {
      const step = depth === 0 ? 5 : 4;
      const n = Math.max(2, Math.round(len / step));
      const curv = rand(-1, 1) * (depth === 0 ? 0.005 : 0.01);
      let px = x, py = y, along = 0;
      for (let i = 0; i < n && segs.length < LIMIT; i++) {
        ang += curv * step + rand(-0.07, 0.07);
        const nx = px + Math.cos(ang) * step, ny = py + Math.sin(ang) * step;
        along += step;
        const arr = t0 + (along / norm) * SPEED[depth];
        segs.push([px, py, nx, ny, depth, arr]);
        // feather branching: both sides, ~60 degrees, shorter towards the tip
        if (depth < 2 && i > 0 && i < n - 1 && i % 2 === 0) {
          const f = i / n;
          for (const sd of [1, -1]) {
            if (Math.random() < (depth === 0 ? 0.8 : 0.55)) {
              const bl = Math.min((n - i) * step * 0.9, len * rand(0.14, 0.32) * (1 - f * 0.75));
              if (bl > 5) fern(nx, ny, ang + sd * (Math.PI / 3) * rand(0.88, 1.12), bl, arr, depth + 1);
            }
          }
        }
        px = nx; py = ny;
        if (px < -6 || py < -6 || px > W + 6 || py > H + 6) break;
      }
    };
    // seeds on the frame, pointing inward, longest towards the corners
    const gap = reduced ? 120 : 74;
    const seed = (x, y, inward) => {
      const corner = Math.pow(1 - Math.min(1, tb(x === 0 ? 1 : x, y === 0 ? 1 : y) * 6), 2);
      fern(x, y, inward + rand(-0.55, 0.55), norm * rand(0.22, 0.5) * (1 + 0.6 * corner),
        rand(0.0, 0.08), 0);
    };
    const edgeSeeds = [];
    for (let x = rand(0, gap); x < W; x += gap * rand(0.6, 1.4)) {
      edgeSeeds.push([x, -1, Math.PI / 2], [x, H + 1, -Math.PI / 2]);
    }
    for (let y = rand(0, gap); y < H; y += gap * rand(0.6, 1.4)) {
      edgeSeeds.push([-1, y, 0], [W + 1, y, Math.PI]);
    }
    // corners: diagonal stems
    edgeSeeds.push([0, 0, Math.PI / 4], [W, 0, Math.PI * 0.75], [0, H, -Math.PI / 4], [W, H, -Math.PI * 0.75]);
    edgeSeeds.sort(() => Math.random() - 0.5).forEach((s) => seed(s[0], s[1], s[2]));
    // a few nuclei on scratches inside the pane: six-armed stars, later
    for (let i = 0, m = reduced ? 3 : 7; i < m; i++) {
      const x = rand(0.08, 0.92) * W, y = rand(0.08, 0.92) * H;
      const t = tb(x, y);
      if (t < 0.18 || t > 0.62) continue;
      const a0 = rand(0, Math.PI);
      const L = norm * rand(0.1, 0.2);
      for (let k = 0; k < 6; k++) fern(x, y, a0 + (k * Math.PI) / 3, L, 0.35 + t * 0.6, 1);
    }

    // granular hoarfrost for the dense layer: needles, small six-armed stars
    // and hexagonal plates, clustered (nucleation is patchy, not uniform)
    const grains = [];
    const want = reduced ? 2600 : 7000;
    const ph = [rand(0, 6), rand(0, 6), rand(0, 6)];
    const cluster = (x, y) => 0.55 + 0.45 * Math.sin(x / 53 + ph[0] + Math.sin(y / 71 + ph[1])) * Math.cos(y / 47 + ph[2] + Math.sin(x / 89));
    for (let tries = 0; tries < want * 8 && grains.length < want; tries++) {
      const x = Math.random() * W, y = Math.random() * H;
      const t = tb(x, y);
      if (Math.random() > Math.max(0, 1 - t / 0.5) * cluster(x, y)) continue;
      const u = Math.random();
      grains.push([x, y, rand(0.8, 3.2) * (1.1 - t), rand(0, Math.PI), u < 0.55 ? 1 : u < 0.85 ? 3 : 6]);
    }
    return { segs, grains, norm, tb };
  }

  /* Paint the grown frost into two textures: relief (R fern, G grain) and
     arrival time (R, white = never). */
  function frostTextures(W, H, fr) {
    const s = Math.min(1, 1400 / W);
    const TW = Math.round(W * s), TH = Math.round(H * s);
    const mk = () => { const c = document.createElement('canvas'); c.width = TW; c.height = TH; return c; };
    const hc = mk(), ac = mk();
    // CPU-backed canvases: painted once, uploaded once; GPU raster of
    // thousands of tiny strokes is far slower to flush
    const hg = hc.getContext('2d', { willReadFrequently: true }), ag = ac.getContext('2d', { willReadFrequently: true });
    const WIDTH = [1.5, 0.95, 0.6];
    const BINS = 48;
    const AMAX = 1.25;
    const buckets = [];
    for (const sg of fr.segs) {
      const b = Math.min(BINS - 1, Math.floor((sg[5] / AMAX) * BINS));
      const k = b * 3 + sg[4];
      (buckets[k] || (buckets[k] = [])).push(sg);
    }
    const path = (g, list) => {
      g.beginPath();
      for (const sg of list) { g.moveTo(sg[0], sg[1]); g.lineTo(sg[2], sg[3]); }
      g.stroke();
    };
    // arrival: min over everything drawn ('darken')
    ag.fillStyle = '#fff'; ag.fillRect(0, 0, TW, TH);
    ag.setTransform(s, 0, 0, s, 0, 0);
    ag.globalCompositeOperation = 'darken';
    ag.lineCap = 'round';
    buckets.forEach((list, k) => {
      if (!list) return;
      const b = Math.floor(k / 3), cls = k % 3;
      const v = Math.round(((b + 0.5) / BINS) * 255);
      ag.strokeStyle = `rgb(${v},${v},${v})`;
      ag.lineWidth = WIDTH[cls] + 2.2;
      path(ag, list);
    });
    // relief: blurred ridge + sharp core, accumulated ('lighter')
    hg.fillStyle = '#000'; hg.fillRect(0, 0, TW, TH);
    hg.setTransform(s, 0, 0, s, 0, 0);
    hg.globalCompositeOperation = 'lighter';
    hg.lineCap = 'round';
    const byCls = [[], [], []];
    fr.segs.forEach((sg) => byCls[sg[4]].push(sg));
    const grainPath = () => {
      hg.beginPath();
      for (const [x, y, r, a, kind] of fr.grains) {
        if (kind === 6) {                    // hexagonal plate
          for (let k = 0; k <= 6; k++) {
            const px = x + Math.cos(a + (k * Math.PI) / 3) * r, py = y + Math.sin(a + (k * Math.PI) / 3) * r;
            if (k) hg.lineTo(px, py); else hg.moveTo(px, py);
          }
          continue;
        }
        for (let k = 0; k < kind; k++) {     // needle, or a six-armed star
          const rr = kind === 1 ? r * 1.6 : r;
          const c = Math.cos(a + (k * Math.PI) / 3) * rr, d = Math.sin(a + (k * Math.PI) / 3) * rr;
          hg.moveTo(x - c, y - d); hg.lineTo(x + c, y + d);
        }
      }
      hg.stroke();
    };
    // a ridge profile without ctx.filter (slow in software): wide faint
    // strokes under a narrow strong one
    byCls.forEach((list, cls) => { hg.strokeStyle = 'rgba(255,0,0,.36)'; hg.lineWidth = WIDTH[cls] * 2.8; path(hg, list); });
    byCls.forEach((list, cls) => { hg.strokeStyle = 'rgba(255,0,0,.62)'; hg.lineWidth = WIDTH[cls]; path(hg, list); });
    hg.strokeStyle = 'rgba(0,255,0,.5)'; hg.lineWidth = 1.0; grainPath();
    return { hc, ac, AMAX };
  }

  const FRAG = `
uniform sampler2D uH;      // relief: r fern ridges, g grain crystals
uniform sampler2D uA;      // fern arrival time (r * uAmax), white = never
uniform sampler2D uWipe;   // r: time of the last pointer wipe (0 = never)
uniform float uF;          // growth front
uniform float uCold;       // cold cast over the whole pane, 0..1
uniform float uMelt;       // thaw progress, 0..1.3
uniform float uWater;      // meltwater amount, 0..1
uniform float uAcc;        // settled snow, 0..1
uniform float uNorm, uAmax, uTotal, uWipeOn;
uniform vec4 uCap[${MAX_CAPS}];
uniform float uCapN;

vec2 tc(vec2 p) { return vec2(p.x / uRes.x, 1.0 - p.y / uRes.y); }

float baseT(vec2 p) {
  float dx = max(0.0, min(p.x, uRes.x - p.x)), dy = max(0.0, min(p.y, uRes.y - p.y));
  float e = dx * dy / (dx + dy + 1e-3) / uNorm;
  float n = vnoise(p / 150.0) * 0.57 + vnoise(p / 74.0) * 0.29 + vnoise(p / 37.0) * 0.14;   // 3-octave fbm
  return e + (n - 0.5) * 0.4 * smoothstep(0.0, 0.12, e);
}

vec3 pageBlur(vec2 p, float r) {
  vec3 s = pageAt(p).rgb;
  float a0 = hash12(p * 1.7) * 6.2831;
  for (int i = 1; i < 12; i++) {
    float fi = float(i);
    float a = a0 + fi * 2.39996;
    s += pageAt(p + vec2(cos(a), sin(a)) * r * sqrt(fi / 11.0)).rgb;
  }
  return s / 12.0;
}

// a bead of water: xy = lens sample offset (inverted image), z = mask, w = 0 centre .. 1 rim
vec4 bead(vec2 p, float cell, float seed, float dens) {
  vec2 id = floor(p / cell);
  if (hash12(id * 1.37 + seed) > dens) return vec4(0.0);
  vec2 c = (id + 0.22 + 0.56 * hash22(id + seed)) * cell;
  float r = cell * (0.1 + 0.22 * hash12(id + seed + 9.1));
  vec2 rel = p - c;
  float d = length(rel * vec2(1.0, 0.92)) / r;
  return vec4(-rel * 2.4, smoothstep(1.0, 0.8, d), d);
}

float saw(float b, float t) { return smoothstep(0.0, b, t) * smoothstep(1.0, b, t); }
// meltwater runnel: stick-slip slide down a column, zig-zagging on its wet track
vec4 runnel(vec2 p, float t, float cw, float seed) {
  float ch = cw * 3.0;
  float col = floor(p.x / cw);
  float f = mix(0.35, 0.7, hash12(vec2(col, seed + 4.0)));
  float yq = p.y / ch - t * f + hash12(vec2(col, seed));
  vec2 id = vec2(col, floor(yq));
  vec3 n = vec3(hash22(id * 1.13 + seed), hash12(id + seed * 2.7));
  vec2 st = vec2(fract(p.x / cw) - 0.5, fract(yq));
  float yy = p.y / cw * 1.3;
  float x = (n.x - 0.5) * 0.5;
  x += sin(yy + sin(yy * 0.7 + n.z * 6.0)) * (0.5 - abs(x)) * (n.z - 0.5) * 0.6;
  float y = 0.94 - 0.86 * saw(0.85, fract(t * f + n.z));
  vec2 rel = (st - vec2(x, y)) * vec2(cw, ch);
  float r = cw * mix(0.12, 0.18, n.y);
  float d = length(rel * vec2(1.0, 0.8)) / r;
  vec4 o = vec4(-rel * 2.2, smoothstep(1.0, 0.8, d), d);
  // beads left in the trail above it
  float above = step(st.y, y) * smoothstep(y - 0.75, y - 0.1, st.y);
  float row = floor(p.y / 8.0);
  vec2 bc = vec2((x + 0.5) * cw + floor(p.x / cw) * cw, (row + 0.5) * 8.0);
  float br = 1.2 + 2.0 * hash12(vec2(row, col + seed));
  vec2 brel = p - bc;
  float bd = length(brel) / br;
  float bm = smoothstep(1.0, 0.75, bd) * above * step(0.35, hash12(vec2(row * 3.1, col)));
  if (bm > o.z) o = vec4(-brel * 2.2, bm, bd);
  return o;
}

void main() {
  vec2 p = cssPos();
  vec2 uv = tc(p);
  float Tb = baseT(p);

  // ---- frost thickness ---------------------------------------------------
  float Fd = uF * 0.42;                                  // dense layer front
  float dense = smoothstep(0.0, 0.07, Fd - Tb);
  float age = clamp((Fd - Tb) / 0.25, 0.0, 1.0);
  float haze = smoothstep(0.0, 0.2, uF * 0.62 - Tb) * 0.1;
  vec4 hC = texture2D(uH, uv);
  float arr = texture2D(uA, uv).r * uAmax;
  float fernOn = smoothstep(arr, arr + 0.025, uF);
  // patchy: real hoarfrost is thicker where it nucleated early, thin between
  float patch = smoothstep(0.15, 0.85, vnoise(p / 46.0) * 0.65 + vnoise(p / 13.0) * 0.35);
  float frost0 = clamp(dense * (0.3 + 0.25 * age + 0.3 * patch + 0.35 * hC.g) + fernOn * hC.r * 0.85, 0.0, 1.0);
  float tau0 = clamp(frost0 + haze, 0.0, 1.0);

  // pointer wipe, refreezing over ~5 s
  float wipe = 0.0;
  if (uWipeOn > 0.5) {
    float wv = texture2D(uWipe, uv).r;
    if (wv > 0.002) {
      float wt = (wv * 255.0 - 1.0) / 254.0 * uTotal;
      wipe = smoothstep(5.0, 0.6, uTime - wt);
    }
  }
  tau0 *= 1.0 - 0.95 * wipe;
  frost0 *= 1.0 - 0.95 * wipe;

  // thaw: thin frost goes first, the thick cold frame last
  float rank = clamp(tau0 * 0.3 + (1.0 - clamp(Tb * 1.5, 0.0, 1.0)) * 0.7, 0.0, 1.0);
  float remain = 1.0 - smoothstep(rank, rank + 0.2, uMelt);
  float tau = tau0 * remain;
  float melted = frost0 * (1.0 - remain);

  // ---- meltwater ---------------------------------------------------------
  vec4 w = vec4(0.0);
  // a wiped track stays wet: beads of condensate until it refreezes
  float wetA = clamp(uWater * melted * 1.6 + 0.55 * wipe, 0.0, 1.0);
  if (wetA > 0.01) {
    w = bead(p, 15.0, 3.0, 0.8 * wetA);
    vec4 b2 = bead(p + 7.0, 27.0, 11.0, 0.5 * wetA);
    if (b2.z > w.z) w = b2;
    if (uWater > 0.05 && melted > 0.2) {
      vec4 rn = runnel(p, uTime, 54.0, 5.0);
      rn.z *= smoothstep(0.2, 0.6, melted);
      if (rn.z > w.z) w = rn;
    }
    w.z *= wetA;
  }

  // ---- relief normal -----------------------------------------------------
  vec2 grad = vec2(0.0);
  if (tau > 0.002) {                                    // clear glass: no relief to shade
    vec2 px = vec2(1.6 / uRes.x, 0.0), py = vec2(0.0, 1.6 / uRes.y);
    vec2 wgt = vec2(fernOn, dense * 0.45);
    float hx1 = dot(texture2D(uH, uv + px).rg, wgt);
    float hx0 = dot(texture2D(uH, uv - px).rg, wgt);
    float hy1 = dot(texture2D(uH, uv - py).rg, wgt);   // texture v is flipped: -py is further DOWN the screen
    float hy0 = dot(texture2D(uH, uv + py).rg, wgt);
    grad = vec2(hx1 - hx0, hy1 - hy0) * 1.7 * remain;
    grad += (vec2(vnoise(p / 4.0), vnoise(p / 4.0 + 31.0)) - 0.5) * 0.22 * dense * remain;
  }
  vec3 n = normalize(vec3(-grad, 1.0));
  float slope = length(grad);

  vec3 L = normalize(vec3(-0.5, -0.62, 0.6));
  float shade = clamp(dot(n, L) - L.z, -0.5, 0.5);
  float spec = pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 70.0) * tau * 1.1;
  // ice glitter: a few facets catch the light, twinkling slowly
  vec2 gc = floor(p / 3.0);
  float glint = step(0.988, hash12(gc)) * tau * (0.6 + 0.4 * sin(uTime * 2.0 + hash12(gc + 7.0) * 30.0));
  spec += glint * 1.1 * smoothstep(0.2, 0.5, hC.r + hC.g);

  float T = (1.0 - 0.7 * tau) * (1.0 - 0.36 * smoothstep(0.12, 0.9, slope) * tau);
  vec3 S = vec3(0.62, 0.70, 0.80) * tau * (0.86 + 1.1 * shade);

  // water beads: dark rim (light refracted away) + a highlight + caustic
  float rim = smoothstep(0.55, 1.0, w.w) * w.z;
  T *= 1.0 - 0.42 * rim;
  vec2 wr = w.xy / 2.4;                               // = -rel
  float hl = w.z * smoothstep(0.42, 0.0, length(w.w * normalize(-wr + 1e-4) - vec2(-0.3, -0.36))) ;
  vec3 E = S + vec3(spec) + vec3(0.9, 0.95, 1.0) * hl * 0.55;

  // ---- snow settled on the page's ledges ---------------------------------
  float capA = 0.0; vec3 capC = vec3(1.0);
  if (uAcc > 0.01) {
    for (int i = 0; i < ${MAX_CAPS}; i++) {
      if (float(i) >= uCapN) break;
      vec4 c = uCap[i];
      float u = (p.x - c.x) / c.z;
      float dy = c.y - p.y;
      if (u < 0.0 || u > 1.0 || dy < -1.5 || dy > c.w * 1.7) continue;
      float prof = smoothstep(0.0, 0.07, u) * smoothstep(1.0, 0.93, u);
      float h = c.w * uAcc * prof * (0.65 + 0.6 * vnoise(vec2(p.x / 11.0, float(i) * 7.3)));
      float inside = smoothstep(h + 0.7, h - 0.7, dy) * smoothstep(-1.5, -0.5, dy);
      if (inside > capA) {
        float v = clamp(dy / max(h, 0.5), 0.0, 1.0);
        vec3 body = mix(vec3(0.70, 0.78, 0.90), vec3(0.985, 0.993, 1.0), smoothstep(0.0, 0.75, v));
        float edge = smoothstep(h - 1.8, h - 0.3, dy);
        capC = mix(body, vec3(0.62, 0.70, 0.83), edge * 0.5);
        capA = inside;
      }
    }
  }

  // cool white balance over the clear pane
  vec3 wb = mix(vec3(1.0), vec3(0.955, 0.985, 1.03), uCold);

  if (uHasPage > 0.5) {
    vec3 B;
    float r = 0.6 + 9.5 * dense * (0.5 + 0.5 * age) * remain + 3.0 * fernOn * hC.r * remain + 2.0 * haze;
    vec2 refr = n.xy * (5.0 + 9.0 * tau) * tau;
    if (tau > 0.01) B = pageBlur(p + refr, r);
    else B = pageAt(p).rgb;
    if (w.z > 0.01) B = mix(B, pageAt(p + w.xy).rgb, w.z);
    float lum = dot(B, vec3(0.2126, 0.7152, 0.0722));
    B = mix(B, vec3(lum), 0.4 * tau + 0.12 * uCold) * wb;
    B = B * (1.0 - 0.03 * uCold) + vec3(0.015, 0.022, 0.035) * uCold;
    B = mix(B, capC, capA);
    vec3 col = B * T + E;
    float strength = max(max(tau, capA), max(w.z, uCold));
    gl_FragColor = vec4(min(col, vec3(1.0)), smoothstep(0.0, 0.01, strength));
  } else {
    // no snapshot: the same light budget as an alpha blend over the live page
    float coldA = 0.07 * uCold;
    float keep = T * (1.0 - capA) * (1.0 - coldA);
    vec3 emit = T * (capA * capC + coldA * vec3(0.62, 0.76, 1.0)) + E;
    float a = 1.0 - keep;
    gl_FragColor = vec4(clamp(emit / max(a, 1e-3), 0.0, 1.0), clamp(a, 0.0, 1.0));
  }
}
`;

  /* Flake sprites: a white one for dark backgrounds, a grey back-lit one for
     bright backgrounds, each sharp / soft / defocused. */
  function flakeSprites() {
    const SZ = 40, mid = SZ / 2;
    const tones = [
      [[255, 255, 255, 1], [250, 252, 255, 0.95], [236, 243, 252, 0.55], [230, 238, 250, 0]],
      [[255, 255, 255, 1], [226, 234, 246, 0.96], [140, 156, 184, 0.72], [140, 156, 184, 0]]
    ];
    const blurs = [0.25, 0.55, 0.9];
    return tones.map((stops) => blurs.map((bl) => {
      const c = document.createElement('canvas');
      c.width = c.height = SZ;
      const g = c.getContext('2d');
      const core = 8 * (1 - bl) + 2;
      const gr = g.createRadialGradient(mid, mid, 0, mid, mid, mid - 1);
      gr.addColorStop(0, `rgba(${stops[0].join(',')})`);
      gr.addColorStop(Math.min(0.9, (core / (mid - 1)) * 0.6), `rgba(${stops[1].join(',')})`);
      gr.addColorStop(Math.min(0.95, core / (mid - 1) + bl * 0.25), `rgba(${stops[2].join(',')})`);
      gr.addColorStop(1, `rgba(${stops[3].join(',')})`);
      g.fillStyle = gr;
      g.fillRect(0, 0, SZ, SZ);
      return c;
    }));
  }

  /* Luminance of the page on a coarse grid, to tone each flake. */
  function lumGrid(snapshot) {
    const GW = 64, GH = 36;
    if (snapshot) {
      try {
        const c = document.createElement('canvas');
        c.width = GW; c.height = GH;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(snapshot, 0, 0, GW, GH);
        const d = g.getImageData(0, 0, GW, GH).data;
        const out = new Float32Array(GW * GH);
        for (let i = 0; i < out.length; i++) {
          out[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
        }
        return { GW, GH, at: (x, y, W, H) => out[clamp((y / H * GH) | 0, 0, GH - 1) * GW + clamp((x / W * GW) | 0, 0, GW - 1)] };
      } catch (err) { /* fall through */ }
    }
    const L = pageLuminance();
    return { at: () => L };
  }

  /* Ledges for settling snow: top edges of real elements, de-duplicated. */
  function ledges(W, H) {
    const out = [];
    let list = [];
    try { list = blocks({ max: 120, minSize: 60 }); } catch (err) { list = []; }
    list.sort((a, b) => b.w - a.w);
    const SOLID = /^(img|video|canvas|svg|picture|figure|button|input|textarea|select|table|pre|blockquote|article|section|aside|nav|header|footer)$/;
    for (const b of list) {
      if (out.length >= MAX_CAPS) break;
      if (!SOLID.test(b.tag) || b.h < 24) continue;
      const x = Math.max(0, b.x), x1 = Math.min(W, b.x + b.w), y = b.y;
      if (x1 - x < 60 || y < 36 || y > H - 12) continue;
      if (b.w > W * 0.96 && b.h > H * 0.6) continue;           // page-sized wrappers
      const dup = out.some((c) => Math.abs(c[1] - y) < 8 &&
        Math.min(c[0] + c[2], x1) - Math.max(c[0], x) > 0.4 * Math.min(c[2], x1 - x));
      if (dup) continue;
      out.push([x, y, x1 - x, 5 + Math.min(6, (x1 - x) / 80)]);
    }
    return out;
  }

  function snowstorm(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const f = ctx.fit(2600, 1900, 600);
    const total = ctx.duration;
    const THAW = f.intro + f.hold;
    const red = ctx.reduced;

    const fr = growFrost(W, H, red);

    /* ---- the frost layer: WebGL over the snapshot, or a CSS fallback ------- */
    let fx = null;
    try { fx = gl(stage, FRAG, { snapshot: ctx.snapshot }); } catch (err) {
      console.warn('[Screenick] snowstorm shader, using fallback:', err);
      fx = null;
      stage.textContent = '';
    }
    let wipeCv = null, wipeG = null, wipeDirty = false, caps = [];
    let fallback = null;
    if (fx) {
      if (ctx.snapshot) lockScroll();
      const tex = frostTextures(W, H, fr);
      fx.texture('uH', tex.hc, 1);
      fx.texture('uA', tex.ac, 2);
      fx.set('uNorm', fr.norm);
      fx.set('uAmax', tex.AMAX);
      fx.set('uTotal', total / 1000);
      wipeCv = document.createElement('canvas');
      wipeCv.width = Math.ceil(W / 4); wipeCv.height = Math.ceil(H / 4);
      wipeG = wipeCv.getContext('2d');
      wipeG.fillStyle = '#000'; wipeG.fillRect(0, 0, wipeCv.width, wipeCv.height);
      wipeG.lineCap = 'round'; wipeG.lineJoin = 'round'; wipeG.lineWidth = 12;
      wipeG.filter = 'blur(1.5px)';             // a soft fingertip, not a hard stencil
      wipeG.globalCompositeOperation = 'lighten';
      fx.texture('uWipe', wipeCv, 3);
      fx.set('uWipeOn', 0);
      caps = ledges(W, H);
      const arr = new Float32Array(MAX_CAPS * 4);
      caps.forEach((c, i) => arr.set(c, i * 4));
      fx.set('uCap', arr, '4fv');
      fx.set('uCapN', caps.length);
    } else {
      fallback = buildFallback(stage, css, W, H, fr, total);
    }

    /* ---- pointer wipes the frost ------------------------------------------- */
    let t0 = performance.now(), lastPt = null, wipeOn = false;
    if (fx) {
      listen(window, 'pointermove', (e) => {
        const now = (performance.now() - t0) / 1000;
        if (now * 1000 > THAW) return;
        const v = Math.round(1 + clamp(now / (total / 1000), 0, 1) * 254);
        const x = e.clientX / 4, y = e.clientY / 4;
        wipeG.strokeStyle = `rgb(${v},0,0)`;
        wipeG.beginPath();
        if (lastPt && Math.hypot(x - lastPt[0], y - lastPt[1]) < 60) wipeG.moveTo(lastPt[0], lastPt[1]);
        else wipeG.moveTo(x, y);
        wipeG.lineTo(x + 0.01, y);
        wipeG.stroke();
        lastPt = [x, y];
        wipeDirty = true; wipeOn = true;
      }, { passive: true });
    }

    /* ---- snow ---------------------------------------------------------------- */
    const snow = canvasLayer(stage);
    const sg = snow.g;
    const sprites = flakeSprites();
    const lum = lumGrid(ctx.snapshot);
    const flakes = [];
    const N = Math.round(clamp((W * H) / 6500, 110, 300) * (red ? 0.4 : 1));
    const vs = (H / 900) * (red ? 0.6 : 1);
    for (let i = 0; i < N; i++) {
      const z = Math.pow(Math.random(), 1.5);          // 0 far .. 1 near
      flakes.push({
        x: rand(-40, W + 40), y: rand(-H * 0.25, H), z,
        r: 0.9 + 6.2 * z * z, v: (45 + 210 * z) * vs * rand(0.85, 1.15),
        amp: (4 + 20 * z) * (red ? 0.4 : 1), w: rand(2.4, 6.5), ph: rand(0, 6.28),
        lvl: z > 0.72 ? 2 : z > 0.42 ? 1 : 0, a: 0.55 + 0.35 * z, live: true
      });
    }
    flakes.sort((a, b) => a.z - b.z);

    const sqrtEase = (u) => Math.pow(clamp(u, 0, 1), 0.72);
    const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

    loop((dt, t) => {
      const done = t >= total;
      const s = dt / 1000;

      // growth front: fast nucleation, then diffusion-limited sqrt(t) slowdown
      let F;
      if (t < f.intro) F = 0.86 * sqrtEase(t / f.intro);
      else F = 0.86 + 0.14 * Math.sqrt(clamp((t - f.intro) / Math.max(1, f.hold + f.outro * 0.3), 0, 1));
      const cold = done ? 0 : Math.min(smooth(t / (1200 * f.k)), 1 - smooth((t - THAW) / f.outro));
      const ou = clamp((t - THAW) / f.outro, 0, 1);
      const melt = t < THAW ? 0 : 1.22 * Math.pow(clamp(ou / 0.7, 0, 1), 0.8);
      const water = t < THAW ? 0 : smooth(ou / 0.15) * (1 - smooth((ou - 0.55) / 0.37));
      const acc = (1 - Math.exp(-t / 5000)) * 0.75 + 0.25 * smooth(t / Math.max(1, THAW));
      const accNow = acc * (1 - smooth(ou / 0.6));

      if (fx) {
        fx.set('uF', done ? 0 : F);
        fx.set('uCold', cold);
        fx.set('uMelt', done ? 2 : melt);
        fx.set('uWater', done ? 0 : water);
        fx.set('uAcc', done ? 0 : accNow);
        if (wipeDirty) { fx.texture('uWipe', wipeCv, 3); wipeDirty = false; }
        fx.set('uWipeOn', wipeOn ? 1 : 0);
        fx.draw(t / 1000);
      } else {
        fallback.frame(t, F, cold, ou, done);
      }

      // snow
      sg.clearRect(0, 0, W, H);
      if (!done) {
        const stopping = t > THAW;
        const fade = Math.min(smooth(t / (900 * f.k)), 1 - smooth((ou - 0.4) / 0.5));
        const wind = (Math.sin(t / 3100) * 30 + Math.sin(t / 1270 + 2) * 16 +
          Math.max(0, Math.sin(t / 5300 + 1)) * 34) * (red ? 0.4 : 1) * (H / 900);
        for (const p of flakes) {
          if (!p.live) continue;
          p.ph += s * p.w * (0.6 + 0.4 * p.z);
          p.y += p.v * s * (1 + 0.18 * Math.sin(p.ph * 0.5));
          p.x += (wind * (0.3 + 0.9 * p.z)) * s + Math.cos(p.ph) * p.amp * p.w * 0.16 * s;
          if (p.y > H + 12) {
            if (stopping) { p.live = false; continue; }
            p.y = -12 - Math.random() * 30; p.x = rand(-60, W + 60);
          }
          if (p.x < -70) p.x += W + 140; else if (p.x > W + 70) p.x -= W + 140;
          const bgL = lum.at(p.x, p.y, W, H);
          const k = clamp((bgL - 0.5) / 0.35, 0, 1);    // 0 = dark bg (white flake) .. 1 = bright bg (grey)
          const rr = p.r * (p.lvl === 2 ? 1.9 : p.lvl === 1 ? 1.35 : 1.1);
          const al = p.a * fade * (p.lvl === 2 ? 0.62 : 1);
          if (k < 0.99) {
            sg.globalAlpha = al * (1 - k);
            sg.drawImage(sprites[0][p.lvl], p.x - rr, p.y - rr, rr * 2, rr * 2);
          }
          if (k > 0.01) {
            sg.globalAlpha = al * k;
            sg.drawImage(sprites[1][p.lvl], p.x - rr, p.y - rr, rr * 2, rr * 2);
          }
        }
        sg.globalAlpha = 1;
      }
      return !done;
    });

    return total;
  }

  /* Without WebGL: a frosted backdrop blur and the same dendrites drawn as
     ice (dark refraction edge under a bright core, so it reads on white),
     both behind a mask that grows in from the frame. */
  function buildFallback(stage, css, W, H, fr, total) {
    css(`
${R} .sfx-cold{position:absolute;inset:0;background:rgba(150,190,240,.10);
 -webkit-backdrop-filter:saturate(.75) hue-rotate(-6deg);backdrop-filter:saturate(.75) hue-rotate(-6deg);}
${R} .sfx-frosted{position:absolute;inset:0;background:rgba(190,212,236,.34);
 -webkit-backdrop-filter:blur(7px) saturate(.55);backdrop-filter:blur(7px) saturate(.55);}
`);
    const cold = div('sfx-cold');
    stage.appendChild(cold);
    const frosted = div('sfx-frosted');
    stage.appendChild(frosted);
    const cr = canvasLayer(stage);
    const g = cr.g;
    g.lineCap = 'round';
    const WIDTH = [1.9, 1.15, 0.7];
    [[2.4, 'rgba(52,78,118,.42)'], [0, 'rgba(255,255,255,.9)']].forEach(([extra, col]) => {
      g.strokeStyle = col;
      for (let d = 0; d < 3; d++) {
        g.lineWidth = WIDTH[d] + extra;
        g.beginPath();
        fr.segs.forEach((s) => { if (s[4] === d) { g.moveTo(s[0], s[1]); g.lineTo(s[2], s[3]); } });
        g.stroke();
      }
    });
    const els = [frosted, cr.cv];
    return {
      frame(t, F, coldV, ou, done) {
        cold.style.opacity = String(coldV);
        const cover = done ? 0 : F * (1 - ou);
        const inner = 100 - 46 * cover;
        const m = `radial-gradient(farthest-corner at 50% 50%,transparent ${inner.toFixed(1)}%,#000 ${(inner + 20).toFixed(1)}%)`;
        els.forEach((n) => { n.style.webkitMaskImage = m; n.style.maskImage = m; n.style.opacity = done ? '0' : '1'; });
      }
    };
  }

  sfx.register('snowstorm', snowstorm);
})();
