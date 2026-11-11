/* Screenick effect module — registers into the runtime in content.js. */
(() => {
  const sfx = window.__screenick;
  if (!sfx || !sfx.kit) return;
  // eslint-disable-next-line no-unused-vars
  const { R, SPRING, SPRING_MS, rand, rint, pick, clamp, svgFrom, el, div, later, listen, loop, canvasLayer, envelope, easeOut3, easeIn2, shake, breathe, pageLuminance, gl, lockScroll, blocks } = sfx.kit;

  /* ========================================================================
   * 4. GLITCH: a digital video decoder losing the stream, applied to the
   *    real page.
   *
   *    MODEL. The page snapshot is treated as a decoded frame of a block-coded
   *    video (MPEG/H.264 style), and the failures are the ones real decoders
   *    show when bits go missing:
   *
   *    - Transform quantisation. Each 8x8 block is re-coded through a 4-point
   *      DCT (DC plus the first AC terms) with a brutal quantiser step, in
   *      YCbCr. Fine detail goes and the block turns into a flat or gradient
   *      tile. The DC term survives, so the block's mean luminance is
   *      unchanged. That keeps the corruption from flashing.
   *    - Datamosh. P-frames hold motion vectors plus residuals relative to the
   *      previous frame. When an I-frame is lost, the decoder keeps applying
   *      vectors to stale pixels. Here that is literal: the last output frame
   *      is copied into a texture (GPU-side copy, no upload) and moshed
   *      macroblocks resample it along a coherent per-block vector field, so
   *      content smears and melts until the next "I-frame" restores it.
   *    - Slice loss. A lost slice blanks the rest of a macroblock row. With no
   *      concealment, zeroed YCbCr bytes decode to the famous dark green
   *      (0,135,0). With concealment, the previous frame shows through.
   *    - 4:2:0 chroma. Chroma is decimated and its timing slips against luma,
   *      so colour bleeds out of the shapes. Corrupt blocks swap or invert
   *      Cb/Cr ("wrong chroma") with luma intact.
   *    - Sync. Line-buffer offsets on slice-aligned bands (multiples of 16px)
   *      wrap around horizontally, a sync slip shears everything below a line,
   *      and vertical hold loss rolls the picture through a blanking bar until
   *      lock is regained exactly one frame later.
   *    - RGB misregistration varies per band, bit-crush bands posterise, and
   *      dropout bands repeat one line (line hold) or show snow.
   *
   *    TIMING. Errors arrive in bursts with irregular, noise-driven gaps. The
   *    corruption "frame" re-rolls at 9-18 Hz inside a burst, like a decoder at
   *    video rate. The strong phase is capped at about 4.7s whatever duration
   *    was asked for. After that come sparse, mild hiccups, and the last one
   *    resolves into a clean I-frame.
   *
   *    PHOTOSENSITIVITY. Nothing inverts or fills the screen. Large-area events
   *    (roll, slice loss, dropout) are spaced at least 400ms apart, so there
   *    are never more than 3 per second, and they are band-limited to well
   *    under a quarter of the screen. Block re-coding keeps local mean
   *    luminance. ctx.reduced gives one static, gently degraded frame that
   *    fades in and out with no strobing.
   * ====================================================================== */

  const FRAG = `
uniform sampler2D uPrev;
uniform float uHasPrev;
uniform float uAmt, uSeed, uMoshSeed, uBlk, uMosh, uTear, uRgb, uChroma, uCrush, uRoll;
uniform vec4 uSlice;  // x first row, y first column, z rows, w mode (1 green, 2 conceal)
uniform vec4 uDrop;   // x top px, y height px, z mode (1 line hold, 2 snow)
uniform vec2 uSkew;   // x slip line px, y shear px
const float PI = 3.14159265;

vec3 pg(vec2 p) { return pageAt(clamp(p, vec2(0.5), uRes - 0.5)).rgb; }
vec3 pv(vec2 p) { p = clamp(p, vec2(0.5), uRes - 0.5); return texture2D(uPrev, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)).rgb; }
vec3 toYCC(vec3 c) { float y = dot(c, vec3(0.299, 0.587, 0.114)); return vec3(y, (c.b - y) * 0.564, (c.r - y) * 0.713); }
vec3 toRGB(vec3 y) { return vec3(y.x + 1.403 * y.z, y.x - 0.344 * y.y - 0.714 * y.z, y.x + 1.773 * y.y); }
float wrapX(float x) { return mod(x, uRes.x); }

// The decoded picture at source position q: per-band RGB misregistration and
// decimated, delayed 4:2:0 chroma.
vec3 base(vec2 q, float band) {
  float s = uRgb * (0.35 + 1.3 * hash12(vec2(band, uSeed + 4.4)));
  vec3 c = vec3(pg(vec2(wrapX(q.x + s), q.y)).r, pg(q).g, pg(vec2(wrapX(q.x - s), q.y)).b);
  if (uChroma > 0.0) {
    float cs = 2.0 + floor(uChroma * 3.0) * 2.0;
    vec2 cell = vec2(cs * 2.0, cs);
    vec2 cq = (floor(q / cell) + 0.5) * cell + vec2(uChroma * 7.0, 0.0);
    vec3 cc = toYCC(pg(vec2(wrapX(cq.x), cq.y)));
    vec3 yc = toYCC(c);
    c = toRGB(vec3(yc.x, mix(yc.yz, cc.yz, min(1.0, uChroma * 1.4))));
  }
  return c;
}

// One 8x8 block re-coded: 4x4 decimated 4-point DCT, DC + first AC terms,
// coarse quantiser, chroma reduced to a single DC pair.
vec3 dctBlock(vec2 sp, vec2 shift, float qs) {
  vec2 o = floor(sp / 8.0) * 8.0;
  vec2 f = (sp - o) / 8.0;
  float c00 = 0.0, c10 = 0.0, c01 = 0.0, c11 = 0.0;
  vec2 ch = vec2(0.0);
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 tp = o + vec2(float(i), float(j)) * 2.0 + 1.0 + shift;
      vec3 y = toYCC(pg(vec2(wrapX(tp.x), tp.y)));
      float bx = cos(PI * (float(i) + 0.5) / 4.0);
      float by = cos(PI * (float(j) + 0.5) / 4.0);
      c00 += y.x; c10 += y.x * bx; c01 += y.x * by; c11 += y.x * bx * by;
      ch += y.yz;
    }
  }
  c00 /= 16.0; c10 /= 8.0; c01 /= 8.0; c11 /= 4.0;
  c00 = floor(c00 * 32.0 + 0.5) / 32.0;
  c10 = floor(c10 / qs + 0.5) * qs;
  c01 = floor(c01 / qs + 0.5) * qs;
  c11 = floor(c11 / (qs * 2.0) + 0.5) * qs * 2.0;
  ch = floor(ch / 16.0 * 10.0 + 0.5) / 10.0;
  float Y = c00 + c10 * cos(PI * f.x) + c01 * cos(PI * f.y) + c11 * cos(PI * f.x) * cos(PI * f.y);
  return toRGB(vec3(Y, ch));
}

void main() {
  vec2 sp = cssPos();
  if (uAmt <= 0.0 && uRoll == 0.0) { gl_FragColor = vec4(pg(sp), 1.0); return; }

  // vertical hold lost: the picture rolls through the blanking interval
  const float BAR = 34.0;
  if (uRoll != 0.0) {
    float y = mod(sp.y + uRoll, uRes.y + BAR);
    if (y > uRes.y) {
      float n = hash12(vec2(floor(sp.x / 3.0), floor(y) + uSeed));
      float sync = step(uRes.y + BAR * 0.5, y) * step(y, uRes.y + BAR * 0.68);
      gl_FragColor = vec4(vec3(0.03 + 0.04 * n + 0.07 * sync), 1.0);
      return;
    }
    sp.y = y;
  }

  // horizontal sync: slice-aligned band offsets, line jitter, sync slip
  float bh = 16.0 * (1.0 + floor(hash12(vec2(uSeed, 1.7)) * 4.0));
  float band = floor(sp.y / bh);
  float torn = step(1.0 - 0.6 * uTear, hash12(vec2(band, uSeed * 1.31)));
  float dx = torn * (hash12(vec2(band, uSeed + 9.2)) - 0.5) * 2.0 * (10.0 + 150.0 * uTear * uTear);
  dx += (hash12(vec2(floor(sp.y), uSeed)) - 0.5) * 3.0 * uTear;
  if (uSkew.y != 0.0 && sp.y > uSkew.x) dx += uSkew.y * min(1.0, (sp.y - uSkew.x) / 80.0);
  vec2 shift = vec2(floor(dx + 0.5), 0.0);
  vec2 q = vec2(wrapX(sp.x + shift.x), sp.y);

  vec2 mb = floor(sp / 16.0);
  // errors run along a macroblock row until the decoder resyncs
  float runL = 1.0 + floor(hash12(vec2(mb.y, uSeed + 3.3)) * 7.0);
  vec2 run = vec2(floor(mb.x / runL), mb.y);
  float hm = hash12(run + fract(uSeed * 0.1234) * 97.0);
  float cl = vnoise(mb * 0.21 + uSeed * 3.7);
  float hot = 0.1 + 3.2 * cl * cl * cl;                    // corruption clusters
  float mcl = vnoise(mb * 0.17 + uMoshSeed * 5.1) * 0.72 + hash12(mb + uMoshSeed) * 0.28;
  bool sliceHit = uSlice.w > 0.0 && mb.y >= uSlice.x && mb.y < uSlice.x + uSlice.z && (mb.y > uSlice.x || mb.x >= uSlice.y);
  vec3 col;

  if (sliceHit && uSlice.w < 1.5) {
    // lost slice, no concealment: zeroed YCbCr decodes to dark green
    col = vec3(0.0, 0.53, 0.0) + (hash12(mb + uSeed) - 0.5) * 0.04;
  } else if (sliceHit) {
    col = uHasPrev > 0.5 ? pv(sp) : base(q, band);
  } else if (uMosh > 0.0 && mcl > 1.0 - uMosh) {
    // datamosh: stale pixels dragged along this macroblock's motion vector
    vec2 mv = vec2(vnoise(mb * 0.13 + uMoshSeed * 2.3), vnoise(mb * 0.13 + uMoshSeed * 2.3 + 7.7)) - 0.5;
    mv = floor(mv * 14.0 * 2.0 + 0.5) / 2.0;          // half-pel vectors
    col = uHasPrev > 0.5 ? pv(sp - mv) : base(q - mv, band);
  } else if (hm < uBlk * hot) {
    // a corrupt block: what kind depends on which syntax element was hit
    float kind = hash12(run * 1.37 + uSeed + 5.0);
    if (kind < 0.4) {
      // residual lost: coarse re-quantisation, sometimes with Cb/Cr crossed
      vec3 y = toYCC(dctBlock(sp, shift, mix(0.05, 0.6, hash12(mb * 1.7 + uSeed))));
      float hc = hash12(mb + uSeed * 0.71);
      if (uChroma > 0.4 && hc > 0.7) y.yz = hc > 0.85 ? y.zy : -y.yz;
      col = toRGB(y);
    } else if (kind < 0.72) {
      // motion vector corrupt: the run predicts from the wrong place
      vec2 off = floor((hash22(run + floor(uSeed)) - 0.5) * vec2(46.0, 18.0) + 0.5) * 8.0;
      col = base(vec2(wrapX(q.x + off.x), q.y + off.y), band);
    } else if (kind < 0.8) {
      // chroma DC corrupt: luma intact, the colour of the whole block wrong
      vec3 y = toYCC(dctBlock(sp, shift, 0.08));
      y.yz = (hash22(run * 2.1 + uSeed) - 0.5) * 0.36 * (0.12 + 0.88 * 4.0 * y.x * (1.0 - y.x));
      col = toRGB(y);
    } else {
      // streak: the decoder repeats the block's edge column or top row
      vec2 o = floor(sp / 16.0) * 16.0;
      vec2 s2 = hm > uBlk * hot * 0.5 ? vec2(wrapX(o.x + shift.x), q.y) : vec2(q.x, o.y);
      col = base(s2, band);
    }
  } else {
    col = base(q, band);
  }

  // bit-crush bands, with an ordered dither like a cheap encoder
  float cb = floor(sp.y / (bh * 2.0));
  if (uCrush > 0.0 && hash12(vec2(cb, uSeed + 2.9)) > 1.0 - 0.32 * uCrush) {
    float L = 2.0 + floor(hash12(vec2(cb, uSeed + 5.3)) * 4.0);
    vec2 d2 = mod(floor(sp), 2.0);
    float dith = (d2.x * 2.0 + d2.y - 1.5) / 4.0 / L;
    col = floor((col + dith) * L + 0.5) / L;
  }

  // dropout band: one line held for the whole band, or snow
  if (uDrop.z > 0.0 && sp.y >= uDrop.x && sp.y < uDrop.x + uDrop.y) {
    if (uDrop.z < 1.5) {
      col = base(vec2(q.x, uDrop.x), band);
    } else {
      float lum = dot(pg(vec2(q.x, uDrop.x)), vec3(0.299, 0.587, 0.114));
      float n = hash12(floor(sp) + fract(uSeed * 0.37) * 311.0);
      col = vec3(mix(lum, n, 0.55));
    }
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

  function glitch(stage, css, ctx) {
    let fx = null;
    if (ctx.snapshot) {
      try { fx = gl(stage, FRAG, { snapshot: ctx.snapshot }); } catch (err) { fx = null; }
      if (!fx) stage.textContent = '';
    }
    if (!fx) return glitchCss(stage, css, ctx);
    lockScroll();

    const total = ctx.duration;
    const f = ctx.fit(160, 520, 300);
    const OUT_AT = f.intro + f.hold;                 // signal re-locks here
    const cv = fx.canvas;
    const g = fx.gl;

    const zero = () => {
      fx.set('uAmt', 0); fx.set('uRoll', 0); fx.set('uBlk', 0); fx.set('uMosh', 0);
      fx.set('uTear', 0); fx.set('uRgb', 0); fx.set('uChroma', 0); fx.set('uCrush', 0);
      fx.set('uSlice', [0, 0, 0, 0]); fx.set('uDrop', [0, 0, 0, 0]); fx.set('uSkew', [0, 0]);
      fx.set('uHasPrev', 0); fx.set('uSeed', 1); fx.set('uMoshSeed', 1);
    };
    zero();

    if (ctx.reduced) {
      // One static, gently degraded frame. No strobe, no motion.
      fx.set('uAmt', 0.3); fx.set('uRgb', 1.4); fx.set('uChroma', 0.45); fx.set('uBlk', 0.05);
      fx.set('uSeed', rand(1, 50));
      fx.draw(0);
      const fade = Math.min(600, total / 4);
      cv.style.opacity = '0';
      cv.style.transition = `opacity ${fade}ms cubic-bezier(0.22,1,0.36,1)`;
      later(() => { cv.style.opacity = '1'; }, 30);
      later(() => { cv.style.opacity = '0'; }, Math.max(0, total - fade));
      return total;
    }

    // ---- previous-frame buffer for datamosh / slice concealment ------------
    const prevTex = g.createTexture();
    g.activeTexture(g.TEXTURE2);
    g.bindTexture(g.TEXTURE_2D, prevTex);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, cv.width, cv.height, 0, g.RGBA, g.UNSIGNED_BYTE, null);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    fx.set('uPrev', 2, '1i');
    let hasPrev = false;
    const grabPrev = () => {
      g.activeTexture(g.TEXTURE2);
      g.bindTexture(g.TEXTURE_2D, prevTex);
      g.copyTexSubImage2D(g.TEXTURE_2D, 0, 0, 0, 0, 0, cv.width, cv.height);
      hasPrev = true;
    };

    // ---- burst schedule ------------------------------------------------------
    const STRONG = Math.min(4700, OUT_AT);
    const bursts = [];
    let t = 0;
    while (t < STRONG - 120) {
      const dur = t === 0 ? rand(420, 700) : rand(220, 820);
      bursts.push({ a: t, b: Math.min(t + dur, STRONG), amp: rand(0.55, 1), strong: true,
        mosh: t > 0 && Math.random() < 0.42, ms: rand(1, 99) });
      t += dur + rand(90, 520) * (Math.random() < 0.25 ? 2.2 : 1);
    }
    t = Math.max(t, STRONG + rand(600, 1400));
    const lastCalm = OUT_AT - 700;
    while (t < lastCalm) {
      const dur = rand(110, 360);
      bursts.push({ a: t, b: t + dur, amp: rand(0.16, 0.36), strong: false, mosh: Math.random() < 0.2, ms: rand(1, 99) });
      t += dur + rand(1100, 3400);
    }
    // the final hiccup the signal recovers from; mild once past the strong phase
    if (OUT_AT - 420 > (bursts.length ? bursts[bursts.length - 1].b + 150 : 0)) {
      bursts.push({ a: OUT_AT - 380, b: OUT_AT - 60, amp: OUT_AT > STRONG + 400 ? 0.45 : 0.75,
        strong: OUT_AT <= STRONG + 400, mosh: false, ms: rand(1, 99) });
    }

    // Large-area events: at least 400ms apart, so never more than 3 per second.
    const big = [];
    let lastBig = -1e9;
    const canBig = (at) => at - lastBig >= 400;
    let rolled = 0;
    bursts.forEach((b) => {
      if (!b.strong) return;
      const len = b.b - b.a;
      if (!rolled && len > 420 && b.a > 350 && b.a + 700 < OUT_AT && canBig(b.a)) {
        big.push({ kind: 'roll', a: b.a + 60, b: b.a + 60 + rand(520, 700) });
        lastBig = b.a + 700; rolled++;
        return;
      }
      const at = b.a + rand(0.15, 0.6) * len;
      if (Math.random() < 0.7 && canBig(at)) {
        const kind = pick(['slice', 'slice', 'drop', 'skew']);
        big.push({ kind, a: at, b: at + rand(90, 200), r: Math.random(), r2: Math.random() });
        lastBig = at;
      }
    });

    const W = fx.W, H = fx.H;
    const env = (b, tt) => clamp(Math.min((tt - b.a) / 30, (b.b - tt) / 70), 0, 1);
    let seed = rand(1, 50), nextSeed = 0;
    let drewClean = false;
    let fading = false;

    loop((dt, tt) => {
      if (tt >= total) return false;
      if (!fading && tt >= total - 220) {
        fading = true;
        cv.style.transition = 'opacity 200ms cubic-bezier(0.22,1,0.36,1)';
        cv.style.opacity = '0';
      }

      // amplitude: bursts with a fast noisy flicker, small residue between
      let A = 0, cur = null;
      for (const b of bursts) {
        if (tt >= b.a && tt < b.b) { cur = b; A = Math.max(A, b.amp * env(b, tt)); }
      }
      if (cur) {
        const step = Math.floor(tt / 70);
        const h = Math.sin(step * 91.7 + cur.ms * 7.3) * 43758.5453;
        A = Math.min(1, A * (0.45 + 0.75 * (h - Math.floor(h))));
      } else if (tt < STRONG && tt > 40) {
        A = 0.05;                                    // the line never quite settles
      }
      let roll = 0, slice = [0, 0, 0, 0], drop = [0, 0, 0, 0], skew = [0, 0];
      for (const e of big) {
        if (tt < e.a || tt >= e.b) continue;
        const u = (tt - e.a) / (e.b - e.a);
        if (e.kind === 'roll') {
          // slips, accelerates through one full frame, locks again on the next
          const s = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
          roll = s * (H + 34);
          if (roll === 0) roll = 0.001;
          A = Math.max(A, 0.25);
        } else if (e.kind === 'slice') {
          const rows = Math.ceil(H / 16);
          slice = [Math.floor(e.r * rows * 0.9), Math.floor(e.r2 * W / 16), e.r < 0.5 ? 1 : 2,
            e.r2 < 0.35 ? 1 : 2];
        } else if (e.kind === 'drop') {
          drop = [Math.floor(e.r * (H - 60)), 18 + e.r2 * 30, e.r2 < 0.6 ? 1 : 2, 1];
        } else {
          skew = [e.r * H * 0.8, (e.r2 - 0.5) * 2 * rand(20, 60)];
        }
      }

      const active = A > 0.002 || roll !== 0;
      if (!active) {
        // Between bursts the live page shows through untouched (a video or
        // animation underneath keeps playing): a clean frame is the page.
        if (!drewClean) { zero(); fx.draw(tt / 1000); drewClean = true; hasPrev = false; cv.style.visibility = 'hidden'; }
        return;
      }
      if (drewClean) cv.style.visibility = 'visible';
      drewClean = false;

      // the corruption pattern re-rolls at decoder rate: 9-18 Hz, slower when calm
      if (tt >= nextSeed) {
        seed = rand(1, 200);
        nextSeed = tt + (cur && !cur.strong ? rand(140, 240) : rand(55, 110));
      }
      const strong = cur ? cur.strong : tt < STRONG;
      fx.set('uAmt', A);
      fx.set('uSeed', seed);
      fx.set('uMoshSeed', cur ? cur.ms : 1);
      fx.set('uTear', A);
      fx.set('uRgb', 0.6 + 5 * A);
      fx.set('uChroma', clamp(A * 1.2, 0, 1));
      fx.set('uBlk', 0.62 * A);
      fx.set('uCrush', strong ? clamp((A - 0.45) * 1.8, 0, 1) : 0);
      fx.set('uMosh', cur && cur.mosh ? clamp(0.12 + 0.5 * (tt - cur.a) / Math.max(1, cur.b - cur.a), 0, 0.55) : 0);
      fx.set('uRoll', roll);
      fx.set('uSlice', slice);
      fx.set('uDrop', drop);
      fx.set('uSkew', skew);
      fx.set('uHasPrev', hasPrev ? 1 : 0);
      fx.draw(tt / 1000);
      grabPrev();
    });

    return total;
  }

  /* ---- fallback: no snapshot or no WebGL --------------------------------
     backdrop-filter slices still tear through the live page. Strobing is
     capped at 3 cycles no matter how long the user asked for. After that it
     settles into a non-strobing residual wash. No full-screen white flash,
     and the full-screen inversion fires once per cycle (under 1 Hz). */
  function glitchCss(stage, css, ctx) {
    const cyclesFit = clamp(Math.floor(ctx.duration / 1560), 1, 3);
    const CYCLE = cyclesFit * 1560 > ctx.duration ? Math.floor(ctx.duration / cyclesFit) : 1560;

    if (ctx.reduced) {
      const total = ctx.duration;
      css(`${R} .sfx-calm{position:absolute;inset:0;opacity:0;
 -webkit-backdrop-filter:saturate(.25) contrast(1.15) hue-rotate(20deg);
 backdrop-filter:saturate(.25) contrast(1.15) hue-rotate(20deg);}`);
      const calm = div('sfx-calm');
      breathe(calm, total, 400, 450);
      stage.appendChild(calm);
      return total;
    }

    const cycles = cyclesFit;
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
${R} .sfx-noise{position:absolute;left:-50%;top:-50%;width:200%;height:200%;opacity:.14;
 animation:sfx-noise 160ms steps(1,end) infinite;}
${R} .sfx-resid{position:absolute;inset:0;opacity:0;
 -webkit-backdrop-filter:contrast(1.22) saturate(.3) hue-rotate(-12deg);
 backdrop-filter:contrast(1.22) saturate(.3) hue-rotate(-12deg);}
@keyframes sfx-scan{from{transform:translate3d(0,0,0)}to{transform:translate3d(0,6px,0)}}
@keyframes sfx-band{from{transform:translate3d(0,-110%,0)}to{transform:translate3d(0,${window.innerHeight + 40}px,0)}}
@keyframes sfx-noise{0%{transform:translate3d(0,0,0)}25%{transform:translate3d(-7%,4%,0)}50%{transform:translate3d(5%,-6%,0)}75%{transform:translate3d(-3%,-2%,0)}100%{transform:translate3d(6%,3%,0)}}
@keyframes sfx-ginv{0%{opacity:0}43%{opacity:1}47%{opacity:0}100%{opacity:0}}
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
    stage.append(scan, div('sfx-ginv'), div('sfx-band'));
    stage.style.animation = `sfx-jit ${CYCLE}ms steps(1,end) ${cycles} both`;

    if (residual > 0) {
      const resid = div('sfx-resid');
      resid.style.animation =
        `sfx-fade-in 500ms cubic-bezier(0.22,1,0.36,1) ${Math.max(0, strobe - 250)}ms both,` +
        `sfx-fade-out 500ms cubic-bezier(0.22,1,0.36,1) ${total - 500}ms forwards`;
      stage.appendChild(resid);
      later(() => {
        stage.querySelectorAll('.sfx-gs, .sfx-ginv, .sfx-band').forEach((n) => n.remove());
        scan.style.opacity = '.3';
      }, strobe);
    }
    later(() => { scan.style.opacity = '0'; }, total - 340);
    return total;
  }

  sfx.register('glitch', glitch);
})();
