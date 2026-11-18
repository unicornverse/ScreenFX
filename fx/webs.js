/* Screenick effect module — registers into the runtime in content.js. */
(() => {
  const sfx = window.__screenick;
  if (!sfx || !sfx.kit) return;
  const { R, rand, rint, pick, clamp, el, div, later, listen, loop, canvasLayer, easeOut3, easeIn2, blocks } = sfx.kit;

  const TAU = Math.PI * 2;

  /* ---- shared -------------------------------------------------------------
     Both web effects use the same silk, light and shadow.

     SILK is what the comics call web fluid: a white, fibrous cord that sets
     on contact. It is drawn white on every page, never dark-on-light: a dark
     line reads as a pen stroke. On a white page it stays legible the way real
     web on a white wall does, through its cast shadow and a faint grey rim.
     The cord is a few fibres twisted round a core, and each segment gets a
     Kajiya-Kay glint (specular ~ sin(T, H)^p, T the fibre tangent, H the half
     vector between the light and a perspective eye ~1.2 screen heights in
     front of the middle), so the highlight slides along a line as it swings.

     LIGHT comes from the upper left, slightly in front of the screen — the
     same light as the prison bars — so anything in front of the page casts
     its shadow down and to the right. */
  const LIGHT = [-0.4191, -0.4990, 0.7585];
  const CAST = [0.55, 0.66];                         // shadow offset per px of height above the page

  const glintAt = (W, H, x, y, tx, ty) => {
    let ex = W / 2 - x, ey = H / 2 - y, ez = H * 1.2;
    const el2 = Math.hypot(ex, ey, ez); ex /= el2; ey /= el2; ez /= el2;
    let hx = LIGHT[0] + ex, hy = LIGHT[1] + ey, hz = LIGHT[2] + ez;
    const hl = Math.hypot(hx, hy, hz); hx /= hl; hy /= hl; hz /= hl;
    const tl = Math.hypot(tx, ty) || 1;
    const th = (tx * hx + ty * hy) / tl;
    return Math.pow(Math.sqrt(Math.max(0, 1 - th * th)), 90);
  };

  const tracePath = (g, pts, ox = 0, oy = 0) => {
    g.beginPath();
    g.moveTo(pts[0][0] + ox, pts[0][1] + oy);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0] + ox, pts[i][1] + oy);
  };

  /* A web cord along a polyline. `lift` is its height above the page in px
     (sets the shadow offset); `alpha` fades the whole thing. */
  function drawSilk(g, pts, w, W, H, lift = 18, alpha = 1) {
    if (pts.length < 2 || alpha <= 0.01) return;
    g.save();
    g.globalAlpha *= alpha;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // cast shadow: a wide faint penumbra and a tighter umbra
    const sx = CAST[0] * lift, sy = CAST[1] * lift;
    g.strokeStyle = 'rgba(0,0,0,0.07)'; g.lineWidth = w + 5; tracePath(g, pts, sx, sy); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.13)'; g.lineWidth = w + 1.2; tracePath(g, pts, sx * 0.85, sy * 0.85); g.stroke();
    // grey rim, then the white body
    g.strokeStyle = 'rgba(64,70,80,0.42)'; g.lineWidth = w + 1.3; tracePath(g, pts); g.stroke();
    g.strokeStyle = '#F3F3EF'; g.lineWidth = w; tracePath(g, pts); g.stroke();
    // fibres twisted round the core: one in shade, one catching light
    if (w >= 1.5) {
      for (let k = 0; k < 2; k++) {
        g.strokeStyle = k ? 'rgba(255,255,255,0.95)' : 'rgba(150,158,170,0.65)';
        g.lineWidth = Math.max(0.5, w * 0.3);
        g.beginPath();
        let s = 0;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
          let tx = b[0] - a[0], ty = b[1] - a[1];
          const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
          if (i) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
          const o = Math.sin(s * 0.42 + k * Math.PI) * w * 0.3;
          const x = pts[i][0] - ty * o, y = pts[i][1] + tx * o;
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      }
    }
    // glint on the lit flank
    g.lineWidth = Math.max(0.6, w * 0.4);
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const sp = glintAt(W, H, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0);
      if (sp < 0.06) continue;
      g.strokeStyle = `rgba(255,255,255,${(sp * 0.9).toFixed(2)})`;
      g.beginPath(); g.moveTo(x0 - 0.4, y0 - 0.4); g.lineTo(x1 - 0.4, y1 - 0.4); g.stroke();
    }
    g.restore();
  }

  /* A web splat, rendered once into its own canvas (with its soft shadow
     baked in) and then only blitted. Built like the real thing: a glob of
     fluid in the middle, main cords thrown out radially — curved, tapering,
     some forking — tied together by sagging cross-links at irregular radii,
     with a thin film of web stretched across the inner part. */
  function splatSprite(r, dpr) {
    const pad = Math.ceil(r * 3.9);
    const d = Math.min(2, dpr || 1);
    const cv = el('canvas');
    cv.width = cv.height = Math.ceil(pad * 2 * d);
    const g = cv.getContext('2d');
    g.setTransform(d, 0, 0, d, pad * d, pad * d);
    g.lineCap = 'round'; g.lineJoin = 'round';

    const n = rint(15, 21);
    const cords = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rand(-0.13, 0.13);
      const len = r * (Math.random() < 0.2 ? rand(1.3, 1.9) : rand(2.1, 3.3));
      const bend = rand(-0.22, 0.22);
      const pt = (t, aa = a, L = len, b = bend) => {
        const rr = r * 0.3 + (L - r * 0.3) * t;
        const aa2 = aa + b * Math.sin(Math.PI * t) * 0.5 + b * t * 0.3;
        return [Math.cos(aa2) * rr, Math.sin(aa2) * rr];
      };
      const fork = Math.random() < 0.45 ? { at: rand(0.5, 0.75), da: rand(0.18, 0.34) * (Math.random() < 0.5 ? -1 : 1), len: rand(0.3, 0.5) } : null;
      cords.push({ a, len, pt, fork });
    }
    // cross-links between neighbouring cords
    const links = [];
    for (let i = 0; i < n; i++) {
      const A = cords[i], B = cords[(i + 1) % n];
      const lim = Math.min(A.len, B.len) * 0.92;
      const k = rint(1, 3);
      for (let j = 0; j < k; j++) {
        const rr = rand(r * 0.62, Math.max(r * 0.7, lim));
        links.push([A.pt(clamp((rr * rand(0.92, 1.08) - r * 0.3) / (A.len - r * 0.3), 0, 1)),
                    B.pt(clamp((rr * rand(0.92, 1.08) - r * 0.3) / (B.len - r * 0.3), 0, 1)), rand(0.1, 0.24)]);
      }
    }
    const lumps = [];
    for (let i = 0; i < 9; i++) lumps.push(r * rand(0.3, 0.48));
    const cordPath = (c, t0, t1, steps = 8) => {
      const pts = [];
      for (let s = 0; s <= steps; s++) pts.push(c.pt(t0 + (t1 - t0) * (s / steps)));
      return pts;
    };
    const geometry = (shadow) => {
      const ink = (c) => (shadow ? '#000' : c);
      // film across the inner web
      g.fillStyle = shadow ? 'rgba(0,0,0,0.5)' : 'rgba(250,250,247,0.3)';
      g.beginPath();
      cords.forEach((c, i) => { const p = c.pt(clamp(0.55 * r * 1.6 / c.len, 0.2, 0.7)); i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); });
      g.closePath(); g.fill();
      // cords, tapering: drawn in three pieces of falling width
      const widths = [r * 0.105, r * 0.065, r * 0.04].map((w) => Math.max(0.6, w));
      cords.forEach((c) => {
        for (let p = 0; p < 3; p++) {
          const pts = cordPath(c, p / 3, (p + 1) / 3, 4);
          if (!shadow) { g.strokeStyle = 'rgba(60,66,76,0.28)'; g.lineWidth = widths[p] + 0.8; tracePath(g, pts); g.stroke(); }
          g.strokeStyle = ink('#F4F4F0'); g.lineWidth = widths[p]; tracePath(g, pts); g.stroke();
        }
        if (c.fork) {
          const p0 = c.pt(c.fork.at);
          const pts = [];
          for (let s = 0; s <= 5; s++) {
            const t = s / 5;
            const rr = Math.hypot(p0[0], p0[1]) + c.len * c.fork.len * t;
            const aa = Math.atan2(p0[1], p0[0]) + c.fork.da * t;
            pts.push([Math.cos(aa) * rr, Math.sin(aa) * rr]);
          }
          if (!shadow) { g.strokeStyle = 'rgba(60,66,76,0.28)'; g.lineWidth = widths[2] + 0.8; tracePath(g, pts); g.stroke(); }
          g.strokeStyle = ink('#F4F4F0'); g.lineWidth = widths[2]; tracePath(g, pts); g.stroke();
        }
      });
      // cross-links, sagging toward the centre
      links.forEach(([a, b, sag]) => {
        const mx = (a[0] + b[0]) / 2 * (1 - sag), my = (a[1] + b[1]) / 2 * (1 - sag);
        g.beginPath(); g.moveTo(a[0], a[1]); g.quadraticCurveTo(mx, my, b[0], b[1]);
        if (!shadow) { g.strokeStyle = 'rgba(60,66,76,0.26)'; g.lineWidth = Math.max(0.6, r * 0.03) + 0.8; g.stroke(); }
        g.strokeStyle = ink('#F1F1EC'); g.lineWidth = Math.max(0.6, r * 0.03); g.stroke();
      });
      // the glob of fluid in the middle, lumpy
      g.beginPath();
      const m = lumps.length;
      for (let i = 0; i <= m; i++) {
        const a = (i / m) * TAU, am = ((i - 0.5) / m) * TAU;
        const rr = lumps[i % m], rm = (lumps[i % m] + lumps[(i + m - 1) % m]) * 0.56;
        if (!i) g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        else g.quadraticCurveTo(Math.cos(am) * rm, Math.sin(am) * rm, Math.cos(a) * rr, Math.sin(a) * rr);
      }
      g.closePath();
      if (shadow) { g.fillStyle = '#000'; g.fill(); return; }
      const gr = g.createRadialGradient(-r * 0.14, -r * 0.18, r * 0.04, 0, 0, r * 0.55);
      gr.addColorStop(0, '#FFFFFF');
      gr.addColorStop(0.55, '#ECEDEA');
      gr.addColorStop(1, '#BFC3C9');
      g.fillStyle = gr; g.fill();
      g.strokeStyle = 'rgba(60,66,76,0.45)'; g.lineWidth = 1; g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath(); g.ellipse(-r * 0.14, -r * 0.17, r * 0.11, r * 0.06, -0.6, 0, TAU); g.fill();
    };
    // soft cast shadow first (baked, so it costs nothing per frame)
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.3)';
    g.shadowBlur = 5 * d;
    g.shadowOffsetX = CAST[0] * 7 * d;
    g.shadowOffsetY = CAST[1] * 7 * d;
    g.globalAlpha = 0.55;
    geometry(true);
    g.restore();
    // clear the solid silhouette, keep only its blurred, offset shadow
    g.save();
    g.globalCompositeOperation = 'destination-out';
    geometry(true);
    g.restore();
    geometry(false);
    return { cv, pad };
  }
  const blitSplat = (g, sp, x, y, k) => {
    if (k <= 0.01) return;
    const s = sp.pad * 2 * k;
    g.drawImage(sp.cv, x - sp.pad * k, y - sp.pad * k, s, s);
  };

  /* A bar across the top of the page the line can be fixed to: a header or
     nav strip that starts at the top edge. Its bottom edge is the anchor. */
  function topBar(W, H, wantX) {
    const cands = [];
    const consider = (x, y, w, h, n) => {
      if (y > 40 || h < 28 || w < 220) return;
      const bottom = y + h;
      if (bottom < 36 || bottom > H * 0.32) return;
      if (wantX < x + 60 || wantX > x + w - 60) return;
      cands.push({ x, y, w, h, bottom, n });
    };
    let base = [];
    try { base = blocks({ max: 120, minSize: 60 }); } catch (err) { base = []; }
    base.forEach((b) => { if (b.tag === 'header' || b.tag === 'nav') consider(b.x, b.y, b.w, b.h, null); });
    const els = document.body ? document.body.querySelectorAll('header,nav,div,section') : [];
    for (let i = 0, seen = 0; i < els.length && seen < 500; i++) {
      const r = els[i].getBoundingClientRect();
      if (r.top > 40 || r.height < 28 || r.width < 220 || r.bottom > H * 0.32) continue;
      seen++;
      const cs = getComputedStyle(els[i]);
      const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
      const a = m ? (m[1].split(',')[3] === undefined ? 1 : parseFloat(m[1].split(',')[3])) : 0;
      if (a < 0.6 && cs.backgroundImage === 'none') continue;     // must be opaque to hide behind
      consider(r.left, r.top, r.width, r.height, els[i]);
    }
    cands.sort((a, b) => b.bottom - a.bottom);
    for (const c of cands) {
      const hit = document.elementFromPoint(clamp(wantX, 1, W - 1), c.bottom - 3);
      if (!hit || (hit.closest && hit.closest('#__screenick_root'))) continue;
      if (c.n && !(c.n === hit || c.n.contains(hit))) continue;
      return c;
    }
    return null;
  }

  /* ---- suit rendering --------------------------------------------------------
     The hero is an original design: a graphite suit with teal piping and a
     teal visor band, orange gloves and boots, a chevron on the chest.
     Limbs are tapered capsules shaded as cylinders (light from the upper
     left); `stripe` adds the suit's seam and teal piping along a limb. */
  const PAL = {
    suit: ['#10141B', '#262E3B', '#46526A'],
    suitFar: ['#0A0D12', '#1B212B', '#323B4C'],
    trim: ['#0C6F67', '#18B3A3', '#6FE6D8'],
    accent: ['#8E3A0E', '#E2672A', '#FFA066'],
    accentFar: ['#6A2A0A', '#B04E1F', '#D97A45']
  };
  const L2 = [-0.6, -0.8];

  function capsulePath(g, ax, ay, bx, by, ra, rb) {
    const dx = bx - ax, dy = by - ay;
    const l = Math.hypot(dx, dy) || 0.001;
    const a = Math.atan2(dy, dx);
    // tangent angle for unequal radii
    const s = clamp((ra - rb) / l, -0.95, 0.95);
    const off = Math.acos(s);
    g.beginPath();
    g.arc(ax, ay, ra, a + off, a - off + TAU, false);
    g.arc(bx, by, rb, a - off, a + off, false);
    g.closePath();
  }

  function shadeCapsule(g, ax, ay, bx, by, ra, rb, pal, tracery, U) {
    capsulePath(g, ax, ay, bx, by, ra, rb);
    let nx = -(by - ay), ny = bx - ax;
    const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    if (nx * L2[0] + ny * L2[1] < 0) { nx = -nx; ny = -ny; }
    const mx = (ax + bx) / 2, my = (ay + by) / 2, rm = Math.max(ra, rb);
    const gr = g.createLinearGradient(mx - nx * rm, my - ny * rm, mx + nx * rm, my + ny * rm);
    gr.addColorStop(0, pal[0]);
    gr.addColorStop(0.38, pal[1]);
    gr.addColorStop(0.72, pal[2]);
    gr.addColorStop(0.92, pal[1]);
    gr.addColorStop(1, pal[0]);
    g.fillStyle = gr;
    g.fill();
    if (tracery) {
      // a panel seam on the lit side, teal piping on the other
      g.save();
      g.clip();
      const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
      const tx = dx / l, ty = dy / l;
      const line = (f, w, c) => {
        g.strokeStyle = c; g.lineWidth = w;
        g.beginPath();
        g.moveTo(ax + nx * ra * f - tx * ra, ay + ny * ra * f - ty * ra);
        g.lineTo(bx + nx * rb * f + tx * rb, by + ny * rb * f + ty * rb);
        g.stroke();
      };
      line(0.42, Math.max(0.5, U * 0.03), 'rgba(255,255,255,0.16)');
      line(-0.5, Math.max(0.8, U * 0.07), PAL.trim[1]);
      line(-0.5, Math.max(0.4, U * 0.025), PAL.trim[2]);
      g.restore();
    }
    // a thin dark contour separates overlapping limbs
    capsulePath(g, ax, ay, bx, by, ra, rb);
    g.strokeStyle = 'rgba(10,4,8,0.55)';
    g.lineWidth = Math.max(0.6, U * 0.03);
    g.stroke();
  }

  /* ========================================================================
   * 1. WEB SLINGER — a masked hero (an original design) swings across the
   *    page and never stops: he enters off screen already swinging, lets go
   *    on the way up, fires the next line ahead as he starts to fall and is
   *    caught with no loss of speed, turns round in the air near the edges,
   *    throws a somersault or a dive when there is air time, and swings off
   *    screen as the time runs out. Lines he lets go of stay stuck and fall
   *    slack.
   *
   *    One live simulation drives it all: a point mass on an inextensible
   *    line at a fixed 240 Hz (g scaled so the figure is 1.8 m tall), with a
   *    small controller deciding releases, anchors and tricks, and pumping
   *    through the bottom of each arc to keep the speed in a lively band.
   *    The body is a 2D rig — torso, head, two-bone arms and legs. It never
   *    jumps: its angle follows a critically damped spring and every pose
   *    parameter eases toward its target, so a release or a catch flows
   *    into the next pose. The web arm is aimed straight up its line; at
   *    speed he leaves a short afterimage.
   * ====================================================================== */
  const P = {
    swing:  { lean: 0, neck: 10, sh: [172, 148], el: [4, 30], hip: [26, 10], kn: [-60, -28], ft: [10, 10] },
    swDown: { lean: -4, neck: 4, sh: [174, 70], el: [2, 40], hip: [-14, -30], kn: [-30, -62], ft: [20, 25] },
    swUp:   { lean: 6, neck: 18, sh: [172, -40], el: [4, 30], hip: [82, 58], kn: [-112, -96], ft: [0, 0] },
    reach:  { lean: 8, neck: -6, sh: [150, -50], el: [4, 34], hip: [36, -22], kn: [-56, -84], ft: [10, 20] },
    spread: { lean: 4, neck: 0, sh: [118, -62], el: [16, 24], hip: [44, -18], kn: [-40, -72], ft: [0, 20] },
    tuck:   { lean: 0, neck: 26, sh: [70, 58], el: [96, 106], hip: [124, 112], kn: [-150, -146], ft: [-20, -20] },
    prep:   { lean: 24, neck: -22, sh: [38, -128], el: [10, 22], hip: [98, 64], kn: [-114, -104], ft: [0, 10] },
    crouch: null,                       // solved by IK below, so both feet sit on the ledge
    zip:    { lean: -4, neck: -22, sh: [178, 150], el: [0, 36], hip: [10, -6], kn: [-24, -46], ft: [20, 30] },
    dive:   { lean: 0, neck: -16, sh: [172, 158], el: [2, 12], hip: [-16, -30], kn: [-12, -34], ft: [30, 30] },
    hang:   { lean: 0, neck: 6, sh: [166, 194], el: [12, 16], hip: [2, -4], kn: [-6, -12], ft: [34, 30] }
  };
  const lerpPose = (a, b, t) => {
    const o = {};
    for (const k in a) {
      if (Array.isArray(a[k])) o[k] = [a[k][0] + (b[k][0] - a[k][0]) * t, a[k][1] + (b[k][1] - a[k][1]) * t];
      else o[k] = a[k] + (b[k] - a[k]) * t;
    }
    return o;
  };
  const sstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const D2R = Math.PI / 180;

  /* Forward kinematics. Angles: 0 = along the torso's down direction,
     positive = toward the way he faces (`face` = +1 right, -1 left). */
  function solveRig(x, y, upAng, pose, face, U) {
    const dir = (a) => [Math.cos(a), Math.sin(a)];
    const ua = upAng + pose.lean * D2R * face;
    const up = dir(ua);
    const down = ua + Math.PI;
    const add = (p, a, l) => { const d = dir(a); return [p[0] + d[0] * l, p[1] + d[1] * l]; };
    const pelvis = [x, y];
    const chest = add(pelvis, ua, U * 2.15);
    const shoulder = add(pelvis, ua, U * 2.35);
    const neck = add(pelvis, ua, U * 2.6);
    const headAng = ua + pose.neck * D2R * face;
    const head = add(neck, headAng, U * 0.62);
    const arms = [0, 1].map((k) => {
      const a1 = down - pose.sh[k] * D2R * face;
      const e = add(shoulder, a1, U * 1.35);
      const a2 = a1 - pose.el[k] * D2R * face;
      const w = add(e, a2, U * 1.2);
      return { s: shoulder, e, w, h: add(w, a2, U * 0.28) };
    });
    const legs = [0, 1].map((k) => {
      const a1 = down - pose.hip[k] * D2R * face;
      const kn = add(pelvis, a1, U * 1.85);
      const a2 = a1 - pose.kn[k] * D2R * face;
      const an = add(kn, a2, U * 1.8);
      const toe = add(an, a2 - (Math.PI / 2 - 0.25 + (pose.ft ? pose.ft[k] : 0) * D2R) * face, U * 0.72);
      return { h: pelvis, k: kn, a: an, t: toe };
    });
    return { pelvis, chest, shoulder, neck, head, headAng, up, ua, arms, legs };
  }

  /* Two-bone IK: world angles of the upper and lower bone reaching from
     (x, y) toward (tx, ty); `bend` picks which side the joint goes. */
  function ik2(x, y, tx, ty, l1, l2, bend) {
    const dx = tx - x, dy = ty - y;
    const d = clamp(Math.hypot(dx, dy), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
    const th = Math.atan2(dy, dx);
    const gm = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
    const a1 = th - bend * gm;
    const kx = x + Math.cos(a1) * l1, ky = y + Math.sin(a1) * l1;
    return [a1, Math.atan2(ty - ky, tx - kx)];
  }

  /* The landing crouch, solved for a figure facing right with the pelvis at
     the origin: the near foot planted flat ahead, the far knee nearly on the
     ground with the toes tucked under, the near hand reaching for the ledge,
     the far arm thrown back for balance. Returns the pose and how far below
     the pelvis the soles are. */
  function crouchPose(U) {
    const lean = 52, hG = 2.15 * U;
    const ua = -Math.PI / 2 + lean * D2R, down = ua + Math.PI;
    const rel = (a) => (down - a) / D2R;
    const sole = 0.22 * U;
    const nl = ik2(0, 0, 1.2 * U, hG - sole, 1.85 * U, 1.8 * U, 1);
    const fl = ik2(0, 0, -1.45 * U, hG - 0.7 * U, 1.85 * U, 1.8 * U, 1);
    const sx = Math.cos(ua) * 2.35 * U, sy = Math.sin(ua) * 2.35 * U;
    const na = ik2(sx, sy, 2.3 * U, hG - 0.35 * U, 1.35 * U, 1.48 * U, -1);
    const pose = {
      lean, neck: -48,
      sh: [rel(na[0]), -64], el: [(na[0] - na[1]) / D2R, 38],
      hip: [rel(nl[0]), rel(fl[0])], kn: [(nl[0] - nl[1]) / D2R, (fl[0] - fl[1]) / D2R],
      ft: [0, 0]
    };
    // feet: near sole flat on the ledge, far foot toes-down
    pose.ft = [(nl[1] / D2R) - (90 - 14), (fl[1] / D2R) - (90 - 14) - 70];
    return { pose, drop: hG };
  }

  function drawRig(g, J, face, U, sil) {
    const far = 1, near = 0;
    const cap = (a, b, ra, rb, pal, tr) => {
      if (sil) { capsulePath(g, a[0], a[1], b[0], b[1], ra, rb); g.fill(); return; }
      shadeCapsule(g, a[0], a[1], b[0], b[1], ra, rb, pal, tr, U);
    };
    const leg = (k) => {
      const L = J.legs[k], fr = k === far;
      const suit = fr ? PAL.suitFar : PAL.suit, acc = fr ? PAL.accentFar : PAL.accent;
      cap(L.h, L.k, U * 0.5, U * 0.38, suit, !fr);
      cap(L.k, L.a, U * 0.37, U * 0.26, suit, !fr);
      // boot: the lower part of the shin and the foot
      const mid = [L.k[0] + (L.a[0] - L.k[0]) * 0.55, L.k[1] + (L.a[1] - L.k[1]) * 0.55];
      cap(mid, L.a, U * 0.31, U * 0.27, acc, false);
      cap(L.a, L.t, U * 0.26, U * 0.17, acc, false);
    };
    const arm = (k) => {
      const A = J.arms[k], fr = k === far;
      const suit = fr ? PAL.suitFar : PAL.suit, acc = fr ? PAL.accentFar : PAL.accent;
      cap(A.s, A.e, U * 0.37, U * 0.3, suit, !fr);
      cap(A.e, A.w, U * 0.3, U * 0.25, suit, !fr);
      // glove: a short orange cuff and the fist
      const cuff = [A.e[0] + (A.w[0] - A.e[0]) * 0.62, A.e[1] + (A.w[1] - A.e[1]) * 0.62];
      cap(cuff, A.w, U * 0.27, U * 0.25, acc, false);
      if (sil) { g.beginPath(); g.arc(A.h[0], A.h[1], U * 0.3, 0, TAU); g.fill(); return; }
      const gr = g.createRadialGradient(A.h[0] - U * 0.1, A.h[1] - U * 0.12, U * 0.04, A.h[0], A.h[1], U * 0.32);
      gr.addColorStop(0, acc[2]); gr.addColorStop(0.6, acc[1]); gr.addColorStop(1, acc[0]);
      g.fillStyle = gr;
      g.beginPath(); g.ellipse(A.h[0], A.h[1], U * 0.3, U * 0.26, Math.atan2(A.h[1] - A.w[1], A.h[0] - A.w[0]), 0, TAU); g.fill();
      g.strokeStyle = 'rgba(8,6,6,0.55)'; g.lineWidth = Math.max(0.6, U * 0.03); g.stroke();
    };

    arm(far);
    leg(far);
    // torso: graphite, a teal chevron on the chest, an orange belt line
    const pv = J.pelvis, ch = J.chest;
    const base = [pv[0] + J.up[0] * U * 0.15, pv[1] + J.up[1] * U * 0.15];
    cap(base, ch, U * 0.6, U * 0.8, PAL.suit, false);
    if (!sil) {
      g.save();
      capsulePath(g, base[0], base[1], ch[0], ch[1], U * 0.6, U * 0.8);
      g.clip();
      g.translate(ch[0], ch[1]);
      g.rotate(J.ua + Math.PI / 2);         // local: -y up the body, +x toward the front
      g.scale(face, 1);
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.strokeStyle = PAL.trim[1]; g.lineWidth = U * 0.16;
      g.beginPath(); g.moveTo(-U * 0.55, -U * 0.25); g.lineTo(U * 0.12, U * 0.32); g.lineTo(U * 0.95, -U * 0.3); g.stroke();
      g.strokeStyle = PAL.trim[2]; g.lineWidth = U * 0.05;
      g.beginPath(); g.moveTo(-U * 0.55, -U * 0.27); g.lineTo(U * 0.12, U * 0.3); g.lineTo(U * 0.95, -U * 0.32); g.stroke();
      g.strokeStyle = PAL.accent[1]; g.lineWidth = U * 0.1;
      g.beginPath(); g.moveTo(-U, U * 1.85); g.lineTo(U, U * 1.85); g.stroke();
      g.restore();
    }
    cap(J.shoulder, J.neck, U * 0.36, U * 0.27, PAL.suit, false);

    // head: a smooth mask with one wide teal visor band
    const hx = J.head[0], hy = J.head[1], ha = J.headAng;
    if (sil) { g.beginPath(); g.ellipse(hx, hy, U * 0.62, U * 0.52, ha, 0, TAU); g.fill(); }
    else {
      g.save();
      g.translate(hx, hy);
      g.rotate(ha + Math.PI / 2);           // local: -y is up the head, +x toward the face
      g.scale(face, 1);
      g.beginPath(); g.ellipse(0, 0, U * 0.52, U * 0.63, 0, 0, TAU);
      const gr = g.createRadialGradient(-U * 0.16, -U * 0.26, U * 0.05, 0, 0, U * 0.72);
      gr.addColorStop(0, PAL.suit[2]); gr.addColorStop(0.5, PAL.suit[1]); gr.addColorStop(1, PAL.suit[0]);
      g.fillStyle = gr; g.fill();
      g.save(); g.clip();
      // the visor wraps round the face side of the head
      g.beginPath();
      g.moveTo(-U * 0.1, -U * 0.2);
      g.quadraticCurveTo(U * 0.3, -U * 0.27, U * 0.62, -U * 0.16);
      g.lineTo(U * 0.62, U * 0.08);
      g.quadraticCurveTo(U * 0.3, U * 0.04, -U * 0.06, U * 0.06);
      g.closePath();
      const vg = g.createLinearGradient(0, -U * 0.24, 0, U * 0.08);
      vg.addColorStop(0, PAL.trim[2]); vg.addColorStop(0.45, PAL.trim[1]); vg.addColorStop(1, PAL.trim[0]);
      g.fillStyle = vg; g.fill();
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.beginPath(); g.ellipse(U * 0.26, -U * 0.17, U * 0.18, U * 0.035, -0.08, 0, TAU); g.fill();
      // an orange cheek plate behind the visor
      g.fillStyle = PAL.accent[1];
      g.beginPath(); g.ellipse(-U * 0.16, U * 0.24, U * 0.11, U * 0.07, 0.4, 0, TAU); g.fill();
      g.restore();
      g.beginPath(); g.ellipse(0, 0, U * 0.52, U * 0.63, 0, 0, TAU);
      g.strokeStyle = 'rgba(8,6,6,0.6)'; g.lineWidth = Math.max(0.6, U * 0.035); g.stroke();
      g.restore();
    }
    leg(near);
    arm(near);
  }


  /* Boxes on the page with a visible top edge to stand on: media, or an
     element with its own background, border or shadow. */
  function ledges(W, H, U) {
    const out = [];
    const nodes = document.body ? document.body.querySelectorAll('div,section,article,aside,figure,img,video,canvas,picture,button,table,pre,blockquote,main,li,form,iframe') : [];
    for (let i = 0, seen = 0; i < nodes.length && seen < 700 && out.length < 60; i++) {
      const n = nodes[i];
      const r = n.getBoundingClientRect();
      if (r.width < U * 6 || r.height < U * 1.5 || r.top < H * 0.3 || r.top > H * 0.85) continue;
      if (r.right < W * 0.12 || r.left > W * 0.88 || r.width > W * 0.96) continue;
      seen++;
      if (n.closest('#__screenick_root')) continue;
      let solid = /^(IMG|VIDEO|CANVAS|PICTURE|BUTTON|IFRAME)$/.test(n.tagName);
      if (!solid) {
        const cs = getComputedStyle(n);
        if (cs.visibility === 'hidden' || +cs.opacity < 0.3) continue;
        const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
        const a = m ? (m[1].split(',')[3] === undefined ? 1 : parseFloat(m[1].split(',')[3])) : 0;
        solid = a > 0.5 || parseFloat(cs.borderTopWidth) > 0.5 || cs.backgroundImage !== 'none' || (cs.boxShadow && cs.boxShadow !== 'none');
      }
      if (solid) out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return out;
  }

  function webSlinger(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const RM = ctx.reduced;
    const total = ctx.duration;
    const FIG = clamp(H * 0.26, 150, 290);       // standing height, px
    const U = FIG / 7.4;                          // head unit
    const PXM = FIG / 1.8;
    const GRAV = 9.81 * PXM * 1.65;               // above true g: heroes swing fast
    const layer = canvasLayer(stage, 'sfx-sling');
    const g = layer.g, dpr = layer.dpr;
    const SHOOT = 0.07;                           // s for a line to reach its anchor
    const DT = 1 / 240;
    const wrap = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
    const near = (a, ref) => ref + wrap(a - ref);  // the equivalent of angle a closest to ref

    let bar = null;
    try { bar = topBar(W, H, W / 2); } catch (err) { bar = null; }
    const barY = bar ? Math.round(bar.bottom) - 1 : 0;
    // a line fixes to the underside of the bar where there is one, else to
    // something above the top of the screen
    const anchorY = (x) => (bar && x > bar.x + 24 && x < bar.x + bar.w - 24 ? barY : -U * 2.5);
    // whatever passes behind the bar is hidden by it; nothing else is clipped
    if (bar) layer.cv.style.clipPath = `polygon(evenodd, -9999px -9999px, 9999px -9999px, 9999px 9999px, -9999px 9999px, -9999px -9999px, ${bar.x}px -9999px, ${bar.x}px ${barY}px, ${bar.x + bar.w}px ${barY}px, ${bar.x + bar.w}px -9999px, ${bar.x}px -9999px)`;

    /* ---- the swing: one live simulation, never paused ---------------------
       A point mass on an inextensible line. A small controller plays the
       swinger: lets go on the way up, picks the next anchor ahead as it
       starts to fall, keeps the speed in a lively band, turns round near the
       edges, throws the odd trick when there is air time, and heads off
       screen when time is nearly up. */
    const lowBand = [H * 0.56, H * 0.8];          // where the bottom of each arc should fall
    const vRef = Math.sqrt(GRAV * H * 0.42);      // typical speed at the bottom
    const topY = Math.max(barY, 0) + U * 3;       // never fly higher than this
    let dir = Math.random() < 0.5 ? 1 : -1;
    const sim = { x: 0, y: 0, vx: 0, vy: 0, mode: 'swing', A: null, L: 0, relTh: 0.72, shoot: null,
      air: 0, trick: null, turning: false, exiting: false, gone: false, swings: 0 };
    {
      const yb = rand(lowBand[0], lowBand[1]);
      const x0 = dir > 0 ? -FIG * 0.7 : W + FIG * 0.7;
      const th0 = 0.95;
      const ay0 = anchorY(W / 2);
      const L = yb - ay0;
      const A = { x: x0 + dir * Math.sin(th0) * L, y: anchorY(x0 + dir * Math.sin(th0) * L) };
      sim.A = A;
      sim.x = x0; sim.y = A.y + Math.cos(th0) * L;
      sim.L = Math.hypot(sim.x - A.x, sim.y - A.y);
      const sp = vRef * 0.75;
      sim.vx = dir * Math.cos(th0) * sp; sim.vy = Math.sin(th0) * sp;
    }

    const events = [];                            // released lines, landings of a line, for the renderer
    const release = () => {
      events.push({ type: 'drop', A: sim.A });
      sim.mode = 'fly'; sim.air = 0; sim.A = null; sim.swings++;
      const sp = Math.hypot(sim.vx, sim.vy);
      // where this jump would carry him: too close to an edge means turn round
      const px = sim.x + sim.vx * 0.6;
      const out = dir > 0 ? px > W - FIG * 0.9 : px < FIG * 0.9;
      sim.turning = false;
      if (!sim.exiting && out) {
        // out of room: pop up, kill most of the forward speed, turn round in the air
        sim.vy -= 260; sim.vx *= 0.3;
        sim.turning = true;
        sim.trick = { type: 'turn', t: 0, dur: 0.62, from: null };
      } else if (!RM && sp > vRef * 0.85 && sim.y > H * 0.35 && Math.random() < 0.3) {
        sim.vy -= 220;                             // a pump for the air time
        sim.trick = { type: Math.random() < 0.6 ? 'flip' : 'dive', t: 0, dur: 0.58, from: null };
      } else {
        sim.vy -= 90;
        sim.trick = null;
      }
      // cap the rise so the apex stays on screen
      sim.vy = Math.max(sim.vy, -Math.sqrt(2 * GRAV * Math.max(0, sim.y - topY)));
    };
    const fire = (side, again) => {
      // the next anchor: ahead, at 25-40 degrees from vertical, with a line
      // long enough that the arc bottoms out in the lower band
      const ax0 = sim.x + side * U * 6;
      const ay = anchorY(ax0);
      const dy = Math.max(U * 3, sim.y - ay);
      const yb = rand(lowBand[0], lowBand[1]);
      const L = Math.max(dy * 1.04, yb - ay, U * 8);
      let ax = sim.x + side * Math.sqrt(Math.max(0, L * L - dy * dy)) * rand(0.75, 0.95);
      if (!sim.exiting) {
        // the far end of this arc must stay on screen
        const reach = L * Math.sin(0.8);
        const lim = side > 0 ? W - FIG * 0.6 - reach : FIG * 0.6 + reach;
        if (side * (ax - lim) > 0) ax = lim;
        // no room ahead at all: turn round and swing back the other way
        if (side * (ax - sim.x) < U * 2 && !again) { dir = -side; return fire(dir, true); }
        ax = clamp(ax, FIG * 0.5, W - FIG * 0.5);
      }
      sim.shoot = { A: { x: ax, y: anchorY(ax) }, t: 0 };
    };
    const step = (t) => {
      const s = sim;
      if (s.mode === 'swing') {
        const A = s.A;
        s.vy += GRAV * DT;
        s.x += s.vx * DT; s.y += s.vy * DT;
        const dx = s.x - A.x, dy = s.y - A.y, d = Math.hypot(dx, dy);
        if (d > s.L) {
          const nx = dx / d, ny = dy / d;
          s.x = A.x + nx * s.L; s.y = A.y + ny * s.L;
          const vr = s.vx * nx + s.vy * ny;
          if (vr > 0) { s.vx -= nx * vr; s.vy -= ny * vr; }
        }
        const th = Math.atan2(dir * (s.x - A.x), s.y - A.y);
        s.th = th;
        // pumping through the bottom keeps the speed up
        if (Math.abs(th) < 0.25) {
          const sp = Math.hypot(s.vx, s.vy), want = vRef * (s.exiting ? 1.15 : 1.0);
          if (sp < want) { const k = 1 + Math.min(0.006, (want - sp) / want * 0.02); s.vx *= k; s.vy *= k; }
        }
        const atEdge = !s.exiting && s.vy < 0 && (dir > 0 ? s.x > W - FIG * 0.55 : s.x < FIG * 0.55);
        if ((th > s.relTh && s.vy < 0) || (atEdge && th > 0.15)) release();
        else if (th > 0.25 && s.vy > -40 && s.vy < 0) release();    // running out of swing
      } else {
        s.air += DT;
        s.vy += GRAV * (s.vy < 0 ? 0.75 : 1.2) * DT;
        s.x += s.vx * DT; s.y += s.vy * DT;
        if (s.trick) {
          s.trick.t += DT;
          if (s.trick.type === 'turn' && s.trick.t >= s.trick.dur * 0.5 && s.turning) { dir = -dir; s.turning = false; }
        }
        // drifting past an edge with time to spare: reverse and fire back in
        if (!s.exiting && !s.shoot && ((dir > 0 && s.x > W - FIG * 0.4) || (dir < 0 && s.x < FIG * 0.4))) {
          dir = -dir; s.turning = false; s.trick = null;
          fire(dir);
        }
        const trickBusy = s.trick && s.trick.t < s.trick.dur * 0.78;
        if (!s.shoot && s.air > 0.1 && !trickBusy && (s.vy > -80 || s.y > H * 0.7)) fire(dir);
        if (s.shoot) {
          s.shoot.t += DT;
          if (s.shoot.t >= SHOOT) {
            // the line takes him with no loss of speed: keep the tangential
            // direction, restore the magnitude
            const A = s.shoot.A;
            const sp = Math.hypot(s.vx, s.vy);
            const dx = s.x - A.x, dy = s.y - A.y, d = Math.hypot(dx, dy) || 1;
            const nx = dx / d, ny = dy / d;
            const vr = s.vx * nx + s.vy * ny;
            if (vr > 0) { s.vx -= nx * vr; s.vy -= ny * vr; }
            const sp2 = Math.hypot(s.vx, s.vy) || 1;
            const k = Math.min(1.6, (sp * 0.96) / sp2);
            s.vx *= k; s.vy *= k;
            s.A = A; s.L = d; s.mode = 'swing'; s.shoot = null; s.trick = null;
            s.relTh = rand(0.6, 0.87);
            events.push({ type: 'catch', A });
          }
        }
      }
      // time to go: carry on in this direction until off screen
      if (!s.exiting) {
        const edge = dir > 0 ? W + FIG - s.x : s.x + FIG;
        if (t > total - 700 - (1000 * edge) / Math.max(450, Math.abs(s.vx) * 0.8)) s.exiting = true;
      }
      if (s.exiting && (s.x < -FIG * 1.6 || s.x > W + FIG * 1.6)) s.gone = true;
    };

    /* ---- lines he let go of: pinned at their anchors, falling slack ------- */
    const M = 14;
    const slack = [];
    let tNow = 0;
    const dropLine = (A, hx, hy, vx, vy) => {
      const r = [];
      for (let i = 0; i < M; i++) {
        const k = i / (M - 1);
        const x = A.x + (hx - A.x) * k, y = A.y + (hy - A.y) * k;
        r.push({ x, y, px: x - (vx * k) / 120, py: y - (vy * k) / 120 });
      }
      r.seg = (Math.hypot(hx - A.x, hy - A.y) * 1.01) / (M - 1);
      r.A = A; r.acc = 0; r.born = tNow;
      slack.push(r);
      if (slack.length > 6) slack.shift();
    };
    const stepLine = (r) => {
      const RDT = 1 / 120;
      for (let i = 1; i < M; i++) {
        const n = r[i];
        const vx = (n.x - n.px) * 0.99, vy = (n.y - n.py) * 0.99;
        n.px = n.x; n.py = n.y;
        n.x += vx; n.y += vy + GRAV * 0.55 * RDT * RDT;
      }
      for (let k = 0; k < 5; k++) {
        for (let j = 0; j < M - 1; j++) {
          const i = k % 2 ? M - 2 - j : j;
          const a = r[i], b = r[i + 1];
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1e-4;
          const m = (d - r.seg) / d;
          const wa = i === 0 ? 0 : 0.5, wb = i === 0 ? 1 : 0.5;
          a.x += dx * m * wa; a.y += dy * m * wa;
          b.x -= dx * m * wb; b.y -= dy * m * wb;
        }
        r[0].x = r.A.x; r[0].y = r.A.y;
      }
    };

    const ptr = { x: 0, y: 0, seen: false };
    listen(window, 'pointermove', (e) => { ptr.x = e.clientX; ptr.y = e.clientY; ptr.seen = true; }, { passive: true, capture: true });

    const sprites = new Map();
    const spriteFor = (A) => { let sp = sprites.get(A); if (!sp) { sp = splatSprite(U * 0.75, dpr); sprites.set(A, sp); } return sp; };
    // the cast shadow is drawn small around the figure only, then blown up
    const shadow = el('canvas');
    const SHS = 0.22, BOX = FIG * 1.2;
    shadow.width = shadow.height = Math.ceil(BOX * 2 * SHS);
    const sg = shadow.getContext('2d');

    /* ---- rendered state, smoothed -----------------------------------------
       The physics can change its mind in one step (a release, a catch); the
       body never does. Its angle follows a critically damped spring, and
       every pose parameter eases toward its target, so each transition
       flows into the next. */
    const copyPose = (p) => JSON.parse(JSON.stringify(p));
    let pose = copyPose(P.swDown);
    let ang = Math.atan2(sim.A.y - sim.y, sim.A.x - sim.x), angV = 0;
    let face = dir;
    let acc = 0, headLook = 0;
    let prevHand = null, handV = [0, 0];
    const ghosts = [];
    let ghostT = 0, lastX = sim.x, lastY = sim.y;
    const easePose = (tgt, k) => {
      for (const key in tgt) {
        if (Array.isArray(tgt[key])) { pose[key][0] += (tgt[key][0] - pose[key][0]) * k; pose[key][1] += (tgt[key][1] - pose[key][1]) * k; }
        else pose[key] += (tgt[key] - pose[key]) * k;
      }
    };
    // aim the near arm straight along its line: the hand sits on the web
    const aimArm = (p, A) => {
      const J0 = solveRig(sim.x, sim.y, ang, p, face, U);
      const down = J0.ua + Math.PI;
      const rel = wrap((down - Math.atan2(A.y - J0.shoulder[1], A.x - J0.shoulder[0])) * face) / D2R;
      return { ...p, sh: [rel, p.sh[1]], el: [3, p.el[1]] };
    };

    loop((dt, t, raw) => {
      if (t > total) return false;
      tNow = t;
      const rdt = Math.min(0.1, (raw === undefined ? dt : Math.max(0, raw)) / 1000);
      const fade = clamp((total - t) / 170, 0, 1);

      // physics at a fixed 240 Hz, on the wall clock
      acc += rdt;
      while (acc >= DT) { step(t); acc -= DT; }

      // ---- what the body should be doing --------------------------------------
      let tgtAng, tgt;
      const s = sim;
      if (s.mode === 'swing') {
        tgtAng = Math.atan2(s.A.y - s.y, s.A.x - s.x);
        tgt = lerpPose(P.swDown, P.swUp, sstep(((s.th || 0) + 0.45) / 1.15));
      } else {
        const tr = s.trick;
        if (tr && !tr.from) tr.from = ang;
        if (tr && tr.type !== 'dive' && tr.t < tr.dur) {
          const u = tr.t / tr.dur;
          // a full somersault in the direction of travel
          tgtAng = tr.from + (wrap(-Math.PI / 2 + dir * 0.35 - tr.from) + dir * TAU) * sstep(u);
          tgt = u < 0.18 ? P.spread : u < 0.78 ? P.tuck : P.reach;
        } else if (tr && tr.type === 'dive' && tr.t < tr.dur) {
          // a dive: the body lies along the flight path, arms leading
          tgtAng = near(Math.atan2(s.vy, s.vx), ang);
          tgt = P.dive;
        } else {
          tgtAng = -Math.PI / 2 + dir * 0.4;
          tgt = s.shoot || s.vy > -80 ? P.reach : P.spread;
        }
        if (s.shoot) tgtAng = Math.atan2(s.shoot.A.y - s.y, s.shoot.A.x - s.x);
        tgtAng = tr && tr.type !== 'dive' && tr.t < tr.dur ? tgtAng : near(tgtAng, ang);
      }
      if (s.mode === 'swing') tgtAng = near(tgtAng, ang);
      // body angle: critically damped spring (fast enough to stay on the line)
      const w = s.mode === 'swing' ? 26 : 17;
      const ddt = Math.min(rdt, 0.05);
      angV += (w * w * (tgtAng - ang) - 2 * w * angV) * ddt;
      ang += angV * ddt;
      // the facing only changes while he is balled up mid-turn
      if (face !== dir && (!s.trick || s.trick.type !== 'turn' || s.trick.t >= s.trick.dur * 0.5)) face = dir;
      easePose(tgt, 1 - Math.exp(-rdt / 0.075));

      let drawPose = copyPose(pose);
      let lineA = null, lineP = 1;
      if (s.mode === 'swing') { lineA = s.A; drawPose = aimArm(drawPose, s.A); }
      else if (s.shoot) { lineA = s.shoot.A; lineP = clamp(s.shoot.t / SHOOT, 0, 1); drawPose = aimArm(drawPose, s.shoot.A); }
      // a glance at the pointer when it is close
      let look = 0;
      if (ptr.seen && Math.hypot(ptr.x - s.x, ptr.y - s.y) < FIG * 1.6) look = clamp(Math.atan2(ptr.y - s.y, (ptr.x - s.x) * face) / D2R, -30, 30);
      headLook += (look - headLook) * (1 - Math.exp(-rdt / 0.15));
      drawPose.neck += headLook;
      const J = solveRig(s.x, s.y, ang, drawPose, face, U);
      const hand = J.arms[0].h;

      // lines he let go of fall slack from their anchors
      while (events.length) {
        const e = events.shift();
        if (e.type === 'drop' && prevHand) dropLine(e.A, prevHand[0], prevHand[1], handV[0], handV[1]);
      }
      if (prevHand && rdt > 0) handV = [(hand[0] - prevHand[0]) / rdt * 0.6, (hand[1] - prevHand[1]) / rdt * 0.6];
      prevHand = hand;

      // speed, for the afterimage
      const sp = rdt > 0 ? Math.hypot(s.x - lastX, s.y - lastY) / rdt : 0;
      lastX = s.x; lastY = s.y;
      ghostT += dt;
      if (!RM && ghostT > 34) { ghostT = 0; if (sp > vRef * 0.9) ghosts.push({ J, t, face }); }
      while (ghosts.length && t - ghosts[0].t > 140) ghosts.shift();

      // ---- draw ------------------------------------------------------------------
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, layer.cv.width, layer.cv.height);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.globalAlpha = fade;

      for (let i = slack.length - 1; i >= 0; i--) {
        const r = slack[i];
        const la = clamp(1 - (t - r.born - 1100) / 600, 0, 1);
        if (la <= 0) { slack.splice(i, 1); continue; }
        r.acc = Math.min(r.acc + rdt, 0.1);
        while (r.acc >= 1 / 120) { stepLine(r); r.acc -= 1 / 120; }
        drawSilk(g, r.map((n) => [n.x, n.y]), 1.9, W, H, 20, la);
        if (r.A.y > 0) blitSplat(g, spriteFor(r.A), r.A.x, r.A.y + U * 0.3, la);
      }

      if (!s.gone) {
        // soft cast shadow: the figure in silhouette, small, blown up
        const bx = J.chest[0] - BOX, by = J.chest[1] - BOX;
        if (bx < W && by < H && bx + BOX * 2 > -40 && by + BOX * 2 > -40) {
          sg.setTransform(1, 0, 0, 1, 0, 0);
          sg.clearRect(0, 0, shadow.width, shadow.height);
          sg.setTransform(SHS, 0, 0, SHS, -bx * SHS, -by * SHS);
          sg.fillStyle = '#000';
          drawRig(sg, J, face, U, true);
          g.save();
          g.globalAlpha = fade * 0.2;
          g.drawImage(shadow, bx + CAST[0] * 26, by + CAST[1] * 26, BOX * 2, BOX * 2);
          g.restore();
        }
        // afterimage at speed: faint teal silhouettes trailing him
        ghosts.forEach((gh, i) => {
          const a = (1 - (t - gh.t) / 140) * 0.14 * (i + 1) / ghosts.length;
          if (a <= 0.005) return;
          g.save();
          g.globalAlpha = fade * a;
          g.fillStyle = PAL.trim[1];
          drawRig(g, gh.J, gh.face, U, true);
          g.restore();
        });
        // the live line: shooting out to its anchor, or taut under his weight
        if (lineA) {
          const tip = [hand[0] + (lineA.x - hand[0]) * lineP, hand[1] + (lineA.y - hand[1]) * lineP];
          drawSilk(g, [hand, tip], lineP < 1 ? 2.0 : 2.4, W, H, 26, 1);
          if (lineP >= 1 && lineA.y > 0) blitSplat(g, spriteFor(lineA), lineA.x, lineA.y + U * 0.3, 1);
        }
        drawRig(g, J, face, U, false);
      }
    });

    return total;
  }

  /* ========================================================================
   * 2. WEB SHOOTER — a gloved forearm comes in from the bottom-right, tracks
   *    the pointer, and fires where you click. The shot is a glob of fluid
   *    trailing a cord; it bursts into a web on the ELEMENT under the click:
   *    the splat is sized to it, cords that run past its edge stop there and
   *    fold over it (so a shot near a corner wraps the corner). The cord,
   *    pulled taut between wrist and target, is then cut at the wrist and
   *    left hanging from the splat, swinging under gravity until it settles.
   *
   *    Cords are verlet ropes (fixed 1/120 s step, distance constraints).
   *    Splats are rendered once, shadow baked in, and only blitted after.
   * ====================================================================== */
  function webShooter(stage, css, ctx) {
    const W = window.innerWidth, H = window.innerHeight;
    const total = ctx.duration;
    const FADE = 600;
    const reduced = ctx.reduced;

    // Elbow just off the bottom-right corner; the whole arm pivots about it.
    const ex = W + 40, ey = H + 70;
    const ARM = 150;                                  // elbow-to-palm, local units
    const REACH = clamp(Math.min(W, H) * 0.54, 300, 560);
    const S = REACH / ARM;
    const AIM_LO = -1.28, AIM_HI = -0.38;

    css(`
${R} .sfx-aim{position:absolute;inset:0;pointer-events:auto;cursor:crosshair;z-index:4;}
${R} .sfx-hint{position:absolute;left:0;right:0;bottom:38px;text-align:center!important;
 font:500 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif!important;
 color:rgba(255,255,255,.96)!important;opacity:0;}
${R} .sfx-hint span{display:inline-block;padding:7px 14px;border-radius:999px;
 background:rgba(22,22,24,.62)!important;
 box-shadow:inset 0 0 0 .5px rgba(255,255,255,.28),0 6px 20px rgba(0,0,0,.34)!important;
 -webkit-backdrop-filter:blur(20px) saturate(1.8);backdrop-filter:blur(20px) saturate(1.8);}
${R} .sfx-webs{animation:sfx-fade-out ${FADE}ms cubic-bezier(0.22,1,0.36,1) ${total - FADE}ms forwards;}
`);

    const layer = canvasLayer(stage, 'sfx-webs');
    const g = layer.g, dpr = layer.dpr;
    const shadowCv = el('canvas');
    const SHS = 0.2;
    shadowCv.width = Math.ceil(W * SHS); shadowCv.height = Math.ceil(H * SHS);
    const sg = shadowCv.getContext('2d');

    /* ---- the shooter's hand ----------------------------------------------
       Local frame (units, scaled by S): elbow at (0,0), forearm running up -y
       to the wrist at (0,-118), the back of the hand beyond it. A right hand
       seen from behind: thumb out to the left, index and little finger out,
       middle and ring curled down onto the trigger in the palm — the thwip. */
    const handParts = (sil) => {
      const C = (ax, ay, bx, by, ra, rb, pal, tr) => ({ a: [ax, ay], b: [bx, by], ra, rb, pal, tr });
      return [
        // forearm: blue underside, red over the top
        C(0, 26, 0, -112, 25, 17.5, PAL.suit, false),
        C(-3, 26, -2, -112, 20, 14, PAL.suit, true),
        // thumb, behind the hand
        C(-14, -128, -27, -146, 6.4, 5.4, PAL.accentFar, false),
        C(-27, -146, -33, -160, 5.4, 4.8, PAL.accentFar, false),
        // back of the hand
        C(0, -118, 0, -150, 17, 20, PAL.accent, false),
        // curled middle and ring fingers: only the first knuckle shows
        C(-5, -158, -5, -167, 5.6, 5.4, PAL.accentFar, false),
        C(5.5, -157, 6, -165.5, 5.4, 5.2, PAL.accentFar, false),
        // index and little finger, extended
        C(-13, -156, -17, -180, 5.5, 5, PAL.accent, false),
        C(-17, -180, -19, -198, 5, 4.4, PAL.accent, false),
        C(14, -154, 18, -174, 4.7, 4.3, PAL.accent, false),
        C(18, -174, 20.5, -188, 4.3, 3.8, PAL.accent, false)
      ].map((p) => (sil ? { ...p, pal: null } : p));
    };
    const HAND = handParts(false);

    const drawHand = (G, sil, aim, recoil) => {
      G.save();
      G.translate(ex, ey);
      G.rotate(aim);
      G.translate(0, recoil * 13 * S);
      G.scale(S, S);
      const U1 = 12;                                    // tracery spacing in local units
      for (const p of HAND) {
        if (sil) { capsulePath(G, p.a[0], p.a[1], p.b[0], p.b[1], p.ra, p.rb); G.fill(); continue; }
        shadeCapsule(G, p.a[0], p.a[1], p.b[0], p.b[1], p.ra, p.rb, p.pal, p.tr, U1);
      }
      if (!sil) {
        // the web-shooter: a slim metal band round the wrist, nozzle under the palm
        G.save();
        capsulePath(G, 0, 26, 0, -112, 25, 17.5);
        G.clip();
        const mg = G.createLinearGradient(-20, 0, 20, 0);
        mg.addColorStop(0, '#3B3F47'); mg.addColorStop(0.35, '#A9AFB8'); mg.addColorStop(0.55, '#E3E6EA'); mg.addColorStop(1, '#4A4F58');
        G.fillStyle = mg;
        G.fillRect(-26, -108, 52, 8);
        G.fillStyle = 'rgba(0,0,0,0.35)';
        G.fillRect(-26, -100, 52, 1.2);
        G.restore();
        G.fillStyle = '#2A2E35';
        G.beginPath(); G.ellipse(0, -104, 4.2, 3, 0, 0, TAU); G.fill();
        // joint creases on the extended fingers
        G.strokeStyle = 'rgba(10,4,8,0.55)'; G.lineWidth = 0.8; G.lineCap = 'round';
        G.beginPath();
        G.moveTo(-21, -181); G.lineTo(-13, -179);
        G.moveTo(15, -174.5); G.lineTo(21.5, -173.5);
        G.moveTo(-10, -160); G.quadraticCurveTo(0, -164, 11, -159);
        G.stroke();
      }
      G.restore();
    };
    const NOZZLE = [0, -104];
    const nozzleAt = (aim, recoil) => {
      const c = Math.cos(aim), s = Math.sin(aim);
      const lx = NOZZLE[0] * S, ly = (NOZZLE[1] + recoil * 13) * S;
      return { x: ex + lx * c - ly * s, y: ey + lx * s + ly * c };
    };

    /* ---- aiming ----------------------------------------------------------
       The arm rotates so the palm points at the pointer, easing toward it so
       it never snaps. Recoil is a short kick back down the arm's own axis. */
    let aim = -0.84;
    let want = aim;
    let recoil = 0;
    const setAim = (tx, ty) => { want = clamp(Math.atan2(tx - ex, -(ty - ey)), AIM_LO, AIM_HI); };
    setAim(W * 0.45, H * 0.35);
    aim = want;
    let palm = nozzleAt(aim, 0);

    /* ---- what got hit ------------------------------------------------------ */
    const hit = div('sfx-aim');
    const surfaceAt = (x, y) => {
      hit.style.pointerEvents = 'none';
      let n = null;
      try { n = document.elementFromPoint(x, y); } catch (err) { n = null; }
      hit.style.pointerEvents = '';
      while (n && n !== document.body && n !== document.documentElement) {
        if (n.closest && n.closest('#__screenick_root')) return null;
        const r = n.getBoundingClientRect();
        // only things with a visible boundary: media, controls, styled boxes.
        // A paragraph's line box is not an edge silk could fold over.
        if (r.width >= 24 && r.height >= 18 && r.width < W * 0.92 && r.height < H * 0.85) {
          const tag = n.tagName;
          let solid = /^(IMG|VIDEO|CANVAS|SVG|PICTURE|BUTTON|INPUT|TEXTAREA|SELECT|IFRAME)$/i.test(tag);
          if (!solid) {
            const cs = getComputedStyle(n);
            const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
            const a = m ? (m[1].split(',')[3] === undefined ? 1 : parseFloat(m[1].split(',')[3])) : 0;
            solid = a > 0.3 || parseFloat(cs.borderTopWidth) > 0.4 || cs.backgroundImage !== 'none' || (cs.boxShadow && cs.boxShadow !== 'none');
          }
          if (solid) return { x: r.left, y: r.top, w: r.width, h: r.height };
        }
        n = n.parentElement;
      }
      return null;
    };

    /* Where cords reach the element's edge they stop and fold over it: a
       short tab of silk running along the edge. */
    function makeHit(x, y, s) {
      const r = s ? clamp(Math.min(s.w, s.h) * 0.3, 15, 30) : rand(17, 26);
      const wraps = [];
      if (s) {
        const n = 16;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + rand(-0.15, 0.15);
          const len = r * rand(2.1, 3.3);
          const dx = Math.cos(a), dy = Math.sin(a);
          let cut = len, side = -1;
          const ts = [];
          if (dx > 0) ts.push([(s.x + s.w - x) / dx, 1]); else if (dx < 0) ts.push([(s.x - x) / dx, 3]);
          if (dy > 0) ts.push([(s.y + s.h - y) / dy, 2]); else if (dy < 0) ts.push([(s.y - y) / dy, 0]);
          ts.forEach(([tt, sd]) => { if (tt >= 0 && tt < cut) { cut = tt; side = sd; } });
          if (side >= 0) {
            const bx = x + dx * cut, by = y + dy * cut;
            const along = side === 0 || side === 2 ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1];
            const tab = clamp(len - cut, 4, 12);
            wraps.push([bx, by, bx + along[0] * tab, by + along[1] * tab]);
          }
        }
      }
      return { x, y, r, s, wraps, sprite: splatSprite(r, dpr) };
    }

    /* ---- shots ------------------------------------------------------------- */
    const RG = 2100, RDT = 1 / 120, RITER = 6;
    const shots = [];
    const puffs = [];
    let tNow = 0;

    const shoot = (tx, ty) => {
      const len0 = Math.hypot(tx - palm.x, ty - palm.y);
      if (len0 < 26) return;
      const sp = makeHit(tx, ty, surfaceAt(tx, ty));
      recoil = 1;
      // flight time grows with distance: the glob leaves at ~4000 px/s and drags
      const fly = clamp(len0 / 4.2, 70, 190);
      shots.push({ t0: tNow, fly, hx: palm.x, hy: palm.y, tx, ty, sp, rope: null, reel: null, acc: 0, seed: rand(0, TAU) });
      if (shots.length > 24) shots.shift();
      // a puff of fluid mist at the nozzle
      const dir = Math.atan2(ty - palm.y, tx - palm.x);
      for (let i = 0; i < 7; i++) {
        const a = dir + rand(-0.6, 0.6), v = rand(90, 260);
        puffs.push({ x: palm.x, y: palm.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t0: tNow, r: rand(1, 2.4) });
      }
    };

    const startRope = (sh) => {
      // pinned at the target, other end on the wrist, 5% slack -> catenary
      const M = 16;
      const d = Math.hypot(palm.x - sh.tx, palm.y - sh.ty);
      sh.seg = (d * 1.05) / (M - 1);
      sh.rope = [];
      for (let i = 0; i < M; i++) {
        const k = i / (M - 1);
        const x = sh.tx + (palm.x - sh.tx) * k, y = sh.ty + (palm.y - sh.ty) * k;
        sh.rope.push({ x, y, px: x, py: y });
      }
      sh.pinEnd = true;
    };

    const stepRope = (sh) => {
      const P2 = sh.rope, M = P2.length;
      for (let i = 1; i < M; i++) {
        const n = P2[i];
        const vx = (n.x - n.px) * 0.992, vy = (n.y - n.py) * 0.992;
        n.px = n.x; n.py = n.y;
        n.x += vx; n.y += vy + RG * RDT * RDT;
      }
      for (let k = 0; k < RITER; k++) {
        for (let j = 0; j < M - 1; j++) {
          const i = k % 2 ? M - 2 - j : j;
          const a = P2[i], b = P2[i + 1];
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.0001;
          const m = (d - sh.seg) / d;
          const wa = i === 0 ? 0 : 0.5, wb = (i + 1 === M - 1 && sh.pinEnd) ? 0 : 0.5;
          const sum = wa + wb || 1;
          a.x += dx * m * wa / sum; a.y += dy * m * wa / sum;
          b.x -= dx * m * wb / sum; b.y -= dy * m * wb / sum;
        }
        P2[0].x = sh.tx; P2[0].y = sh.ty;
        if (sh.pinEnd) { P2[M - 1].x = palm.x; P2[M - 1].y = palm.y; }
      }
    };

    hit.addEventListener('pointermove', (e) => setAim(e.clientX, e.clientY));
    hit.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      setAim(e.clientX, e.clientY);
      aim = want;
      palm = nozzleAt(aim, recoil);
      shoot(e.clientX, e.clientY);
    });
    stage.appendChild(hit);

    // Unprompted shots at real things on the page (near a corner, so the
    // wrap shows), so the effect explains itself to someone who never clicks.
    if (!reduced) {
      let targets = [];
      try {
        targets = blocks({ max: 120, minSize: 40 }).filter((b) => /^(img|video|canvas|picture|button|input|figure|pre|table)$/.test(b.tag) &&
          b.x + b.w * 0.5 < W * 0.8 && b.y + b.h * 0.5 < H * 0.7 && b.y > 10 && b.w < W * 0.9 && b.h < H * 0.7);
      } catch (err) { targets = []; }
      [520, 1180].forEach((at, i) => later(() => {
        let tx, ty;
        if (targets.length) {
          const b = pick(targets);
          tx = b.x + (Math.random() < 0.5 ? rand(0.06, 0.2) : rand(0.8, 0.94)) * b.w;
          ty = b.y + rand(0.12, 0.3) * b.h;
        } else { tx = rand(W * 0.12, W * 0.62); ty = rand(H * 0.12, H * 0.5); }
        setAim(tx, ty); if (!i) aim = want;
        palm = nozzleAt(aim, recoil);
        shoot(tx, ty);
      }, at));
    }

    const hint = div('sfx-hint');
    const hs = el('span');
    hs.textContent = 'Click to shoot';
    hint.appendChild(hs);
    hint.style.animation =
      `sfx-fade-in 420ms cubic-bezier(0.22,1,0.36,1) 900ms both,` +
      `sfx-fade-out 420ms cubic-bezier(0.22,1,0.36,1) ${Math.min(3200, total - FADE - 420)}ms forwards`;
    stage.appendChild(hint);

    // the arm swings in from the corner on the product spring
    const ENTER = 520;
    const enterK = (t) => {
      const u = clamp(t / ENTER, 0, 1);
      return 1 - Math.exp(-6 * u) * Math.cos(u * 3.2) * (1 - u * 0.2);
    };

    /* ---- loop ---------------------------------------------------------------- */
    loop((dt, t, raw) => {
      if (t > total) return false;
      dt = Math.max(0, dt);
      tNow = t;
      let d = want - aim;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      aim += d * Math.min(1, dt / 110);
      recoil *= Math.pow(0.85, dt / 16.67);
      palm = nozzleAt(aim, recoil);
      const ek = enterK(t);
      const off = (1 - ek) * 120;

      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, layer.cv.width, layer.cv.height);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);

      for (const sh of shots) {
        const age = t - sh.t0;
        if (age < sh.fly) {
          // in flight: the glob runs out from the wrist trailing its cord,
          // which ripples and straightens as it pays out
          const p = easeOut3(age / sh.fly);
          const x = sh.hx + (sh.tx - sh.hx) * p, y = sh.hy + (sh.ty - sh.hy) * p;
          const L = Math.hypot(x - sh.hx, y - sh.hy) || 1;
          const nx = -(y - sh.hy) / L, ny = (x - sh.hx) / L;
          const pts = [];
          for (let i = 0; i <= 10; i++) {
            const k = i / 10;
            const w = Math.sin(k * Math.PI * 3 + sh.seed + age * 0.05) * (1 - p) * 6 * Math.sin(Math.PI * k);
            pts.push([sh.hx + (x - sh.hx) * k + nx * w, sh.hy + (y - sh.hy) * k + ny * w + Math.sin(Math.PI * k) * L * 0.03]);
          }
          drawSilk(g, pts, 2.2, W, H, 30);
          const gr = g.createRadialGradient(x - 1.5, y - 1.5, 0.5, x, y, 6);
          gr.addColorStop(0, '#FFFFFF'); gr.addColorStop(0.7, '#E6E8EA'); gr.addColorStop(1, 'rgba(200,204,210,0)');
          g.fillStyle = gr;
          g.beginPath(); g.arc(x, y, 6, 0, TAU); g.fill();
          continue;
        }
        if (!sh.rope) startRope(sh);
        if (sh.pinEnd && age > sh.fly + 200) {
          // cut at the wrist: keep a dangling piece, the rest whips back in
          const M = sh.rope.length;
          const keep = clamp(Math.round(rand(110, 240) / sh.seg), 3, M - 3);
          sh.reel = { pts: sh.rope.slice(keep).map((n) => [n.x, n.y]), t0: t };
          sh.rope = sh.rope.slice(0, keep + 1);
          sh.pinEnd = false;
          const end = sh.rope[sh.rope.length - 1];
          end.px = end.x + (palm.x - sh.tx) * 0.006; end.py = end.y + 2;
        }
        sh.acc = Math.min(sh.acc + (raw === undefined ? dt : Math.max(0, raw)) / 1000, 0.1);
        while (sh.acc >= RDT) { stepRope(sh); sh.acc -= RDT; }

        // the splat opens on a damped spring: x(t) = 1 - (1 - s0) e^(-t/tau) cos(wt)
        const a2 = (age - sh.fly) / 1000;
        const k = 1 - 0.8 * Math.exp(-a2 / 0.06) * Math.cos(a2 * 30);
        const sp = sh.sp;
        g.save();
        if (sp.s) { g.beginPath(); g.rect(sp.s.x - 0.5, sp.s.y - 0.5, sp.s.w + 1, sp.s.h + 1); g.clip(); }
        blitSplat(g, sp.sprite, sp.x, sp.y, k);
        g.restore();
        if (sp.wraps.length && k > 0.9) {
          g.save();
          g.lineCap = 'round';
          sp.wraps.forEach(([x0, y0, x1, y1]) => {
            g.strokeStyle = 'rgba(64,70,80,0.45)'; g.lineWidth = 2.8;
            g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
            g.strokeStyle = '#F4F4F0'; g.lineWidth = 1.8;
            g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
          });
          g.restore();
        }
        drawSilk(g, sh.rope.map((n) => [n.x, n.y]), sh.pinEnd ? 2.3 : 1.9, W, H, sh.pinEnd ? 26 : 14);
        if (sh.reel) {
          const p = (t - sh.reel.t0) / 140;
          if (p < 1) {
            const pts = sh.reel.pts.map(([x, y]) => [x + (palm.x - x) * easeIn2(p), y + (palm.y - y) * easeIn2(p)]);
            drawSilk(g, pts, 1.7, W, H, 26, 1 - p);
          } else sh.reel = null;
        }
      }

      // nozzle mist
      for (let i = puffs.length - 1; i >= 0; i--) {
        const q = puffs[i], a = (t - q.t0) / 260;
        if (a >= 1) { puffs.splice(i, 1); continue; }
        const s2 = (t - q.t0) / 1000;
        const x = q.x + q.vx * s2 * (1 - a * 0.5), y = q.y + q.vy * s2 * (1 - a * 0.5);
        g.fillStyle = `rgba(250,250,248,${(0.85 * (1 - a)).toFixed(3)})`;
        g.beginPath(); g.arc(x, y, q.r * (1 + a), 0, TAU); g.fill();
      }

      // the arm: soft shadow on the page, then the arm itself
      g.save();
      g.translate(off * 0.8, off);
      sg.setTransform(1, 0, 0, 1, 0, 0);
      sg.clearRect(0, 0, shadowCv.width, shadowCv.height);
      sg.setTransform(SHS, 0, 0, SHS, CAST[0] * 34 * SHS, CAST[1] * 34 * SHS);
      sg.fillStyle = '#000';
      drawHand(sg, true, aim, recoil);
      g.globalAlpha = 0.24 * clamp(t / 200, 0, 1);
      g.drawImage(shadowCv, 0, 0, W, H);
      g.globalAlpha = clamp(t / 120, 0, 1);
      drawHand(g, false, aim, recoil);
      g.restore();
    });

    return total;
  }

  // the hero's rig and the web rendering, for other effects that use him
  sfx.rig = {
    solveRig, drawRig, ik2, crouchPose, P, lerpPose, sstep, D2R, PAL, CAST,
    capsulePath, shadeCapsule, drawSilk, splatSprite, blitSplat, topBar, ledges
  };

  sfx.register('spiderman', webSlinger);
  sfx.register('webShooter', webShooter);
})();
