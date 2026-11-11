# ScreenFX

A "click when bored" Chrome extension. Hit the toolbar icon, pick one of twelve effects, and
a full-screen animation plays over whatever tab you're on, then cleans itself up. You
choose how long it lasts, and you can book one in advance so it ambushes you at 4pm on a
Tuesday.

Manifest V3. No build step, no runtime dependencies, no remote assets — every effect is
plain CSS, SVG, canvas and vanilla JS.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin ScreenFX to the toolbar, open any normal web page, and click the icon.

Reload the extension from `chrome://extensions` after editing any file.

Chrome blocks script injection on its own pages, so nothing will fire on `chrome://`
URLs, the Chrome Web Store, other extensions' pages, or the built-in PDF viewer. The
popup says so under the grid instead of failing silently.

## The effects

| Key | Effect | What happens to the real page |
|-----|--------|-------------------------------|
| 1 | Prison bars | Rusted, brushed-steel bars (Fresnel metal shading) drop under gravity and bounce. They cast shadows and ambient occlusion onto the page and reflect it in their rims |
| 2 | Screen crack | The fracture is rasterised once, then the page is refracted across each crack with chromatic dispersion and glints. LCD ink, driver lines and mura sit underneath |
| 3 | Glitch | The page snapshot is re-encoded like a failing video decoder: 8×8 DCT block quantisation, datamosh along motion vectors, chroma bleed, sync tearing, a vertical roll |
| 4 | Confetti | Andersen–Pesavento–Wang falling-plate aerodynamics (flutter and tumble). Paper lands and piles on the top edges of the page's own elements, then a gust clears it |
| 5 | Fireworks | The page is relit for night. Each burst is a point light that illuminates the page; stars follow drag ballistics |
| 6 | Bug invasion | Ladybirds, beetles and ants walk with a real tripod gait and follow the page's element edges. Ants follow a pheromone trail; bugs flee the pointer and squash on click |
| 7 | Web slinger | A verlet rope lowers him from under the page's own header bar, with a silk glint and a cast shadow |
| 8 | Web shooter | Click anything on the page: the web sticks to that element, wraps its corners, then snaps and dangles |
| 9 | Underwater | Snell refraction through dispersive waves, caustics, Beer–Lambert (Jerlov) absorption, a rising waterline with a meniscus, and lensing bubbles. The water drains by Torricelli's law |
| 0 | Deep freeze | Dendritic frost grows over the glass and refracts and scatters the page, so it reads on white and black alike. Snow settles on elements; wipe it with the pointer; the thaw leaves drips |
| - | Thunderstorm | Raindrops on the glass act as lenses onto the page under an overcast relight. Stepped-leader lightning lights up the actual page |
| = | Black hole | Schwarzschild lensing of the page (Einstein ring, shadow), a Doppler-beamed accretion disk, then a sink-vortex that spaghettifies and swallows the page before it evaporates |

**Surprise me** (or **R** in the popup, or the keyboard shortcut) plays a random effect.
The settings page lets you switch effects out of that mix and preview any of them.

Every overlay has a dismiss button in the top-right whose ring counts the remaining time
down, and **Esc** ends an effect early.

## Time on screen

The popup's segmented control sets how long an effect stays up: **3s / 6s / 12s / 30s**.
It is stored in `chrome.storage.sync`, so it follows your Chrome profile.

Longer does not mean slower. Each effect plays its intro at natural speed, sits in a
**hold** phase for the remaining budget, then plays its outro — a slam is a slam whether
you asked for 3 seconds or 30. When intro + outro do not fit the budget, they compress
proportionally (`ctx.fit`) instead of overrunning. **Every effect ends exactly on the chosen
duration**, and the countdown ring drains over the effect's real reported length.

One deliberate exception in character, not in length: **Glitch caps its strobing at 3
cycles (~4.7s)**, then settles into a non-strobing dead-signal wash for the rest. A
30-second strobe is a photosensitivity hazard. Thunderstorm likewise keeps its sky flash
well under full white, at most twice per strike, strikes ~1.8s+ apart.

Under `prefers-reduced-motion: reduce` camera shakes are dropped, Glitch becomes a soft
wash, the web slinger's rope is damped, the cracked panel stops flickering, Thunderstorm
loses its flash and flicker, and particle counts drop across the canvas effects.

## Where the effects get their behaviour

All twelve are built on measured physics or on reference photography rather than on
hand-tuned keyframes, because the details that make something read as real are exactly the
ones intuition gets wrong:

- **Web slinger** is a verlet rope — 18 nodes, fixed 1/120s timestep, 8 Gauss-Seidel
  constraint passes with the sweep direction alternating, and a bend constraint over the
  first few nodes so the line does not kink at its anchor. The rope pays out slower than he
  would fall, so it never goes slack: he is lowered rather than dropped. The physics is
  there for the sag, the slow pendulum (T = 2π√(L/g), about 2.7s at this length) and the way
  his arms trail the sway and settle late. Constraint iterations are kept deliberately low —
  a stiff solver propagates an impulse down the whole chain in one frame, which is what
  makes a simulated rope look like a pole.
- **Underwater** sells depth through parallax rather than through blue. Three layers: the far
  one small, pale, blurred and slow, the near one large, sharp and across the screen in a few
  seconds. Tail beat scales with fish size, which is most of what separates a shoal from a
  set of clones.
- **Screen crack** is two damaged layers, and the second is the one people actually name. The
  glass: a fracture is a sub-micron air gap, so it is an optical element, not a pen stroke —
  silver and bright on a dark page, mid-grey with a specular flank on a bright one, alpha
  wandering along its length, tapering where it arrests. Radials form first and all launch at
  once; concentric cracks form on the rebound as straight chords between adjacent radials, so
  the result is a mesh of panes whose size grows with distance from a pulverised core. The
  panel: liquid crystal bled out of ruptured cells as an opaque amoeba with a violet and amber
  fringe, driver damage as hard saturated bands that ignore the crack geometry entirely,
  pressure mura, backlight blowout, and an irregular flicker. Modern panels are laminated to
  the cover glass with about 0.2mm of adhesive, so the fragments cannot move — offsetting
  shards of content reads as a broken mirror, not a broken phone, and this deliberately
  does not do it.

## Schedules

Open the popup's **Schedules** row, or its settings button (or right-click the icon →
Options). Pick an
effect — including *Random effect* — a time, and which days it repeats on. At that time,
the effect plays on whichever tab you happen to be looking at.

Schedules are `chrome.alarms`, one per entry, each firing once and then scheduling its
own successor (a repeating alarm cannot express "09:30 on Mon/Wed/Fri"). They are
rebuilt from storage on install, on browser start, and whenever the schedule list
changes — including a change synced from another machine. Nothing fires while Chrome is
closed.

### Why scheduling asks for an extra permission

By default ScreenFX requests only `activeTab` — access to one tab, granted because you
clicked the toolbar icon, expiring when you navigate away. There is no install-time
"read and change all your data on all websites" warning.

A scheduled effect fires when you are not clicking anything, so `activeTab` cannot cover
it. `<all_urls>` is therefore declared as an **optional** host permission and requested
from the options page only when you turn scheduling on — and revocable from the same
button. The extension never reads page content and nothing leaves your browser.

The keyboard shortcut is the exception: a `commands` shortcut *is* a direct user gesture,
so it works on `activeTab` alone with no extra permission. It is unassigned by default —
assign it from the options page, which links to `chrome://extensions/shortcuts`.

## Files

```
manifest.json          MV3 manifest — activeTab, scripting, storage, alarms
                       + optional_host_permissions: <all_urls>
background.js          service worker: alarms, keyboard shortcut, permission flow
content.js             the injected core: overlay lifecycle, timing, kit helpers,
                       WebGL (gl + GLSL_LIB), lockScroll, blocks, play()
fx/*.js                one module per effect, registered into the core
theme.css              design system: OKLCH colour, spring easings, type roles,
                       and the shared primitives (grouped list, segmented control,
                       switch, buttons)
effects.js             the effect catalogue (ids, labels, blurbs, key order) shared by
                       popup and settings
popup.html/.css/.js    the toolbar popup: Surprise me, effect grid, duration, keys
options.html/.css/.js  full-tab settings: defaults, theme, effect gallery, schedules
icons/brand.svg        brand mark master; icon16/32/48/128.png are rendered from it
icons/fx/<id>.svg      one app-icon style tile per effect, plus random.svg
tools/make-icons.mjs   regenerates the PNGs (npm install && npm run icons)
```

There is no `effects.css`: each effect emits its own CSS at runtime through the `css()`
callback it is handed, into a `<style>` tag that lives inside the overlay. When the
overlay is removed the styles go with it, so nothing can leak into the host page. Every
selector is scoped under `#__screenfx_root`.

## Design

`theme.css` carries the whole system; `popup.css` and `options.css` add layout and
nothing else.

**Colour** is OKLCH, one meaning per colour. The neutrals are a single hue at near-zero
chroma, so the ramp has no hue drift across steps or between themes. Colour is not
decoration: the accent marks a selected state and exactly one primary action per view,
red means destructive and nothing else, and everything else is neutral. `--accent` and
`--accent-fill` are separate tokens because the bright tint that reads well as text on a
dark surface is too light to carry white text as a button. Every foreground/background
pair was measured in both appearances and clears WCAG AA.

**Motion** is springs, not durations. The easings are real critically-damped springs
sampled into CSS `linear()`, parameterised the way Apple parameterises them — a damping
ratio and a response time. Damping 1.0 (no overshoot) is the default for everything;
bounce is reserved for motion that followed a physical gesture, of which this interface
has none. Press feedback lands on pointer-down at 110ms, which is the only timing allowed
to be faster than the springs.

**Type** is the platform font with size-specific tracking: negative on the large title,
near zero on body, positive on small caps. Times use tabular figures so a row never
shifts as the clock changes.

**Surfaces** carry no shadows. The only two in the system are the segmented-control thumb,
which has to read as lifted, and the floating toast. Everything else separates with a
hairline or a fill step. The one translucent material is the dismiss control on the
overlay, because that is the only surface with live page content moving underneath it.

`prefers-reduced-motion`, `prefers-reduced-transparency` and `prefers-contrast: more` are
all honoured.

## How it works

**Acting on the real page.** Before an effect plays, the caller (popup, keyboard
shortcut or schedule) takes a screenshot of the visible tab with
`chrome.tabs.captureVisibleTab`. That is allowed by the same `activeTab` grant the
click already gave, or by the optional schedule permission, so it adds no install
warning. The screenshot goes into `play()` as `opts.snapshot`. Effects render it through
WebGL shaders (`kit.gl()`), so they bend, refract, relight, corrupt or swallow the
site's own pixels without touching a single node of the host page. While an effect
redraws the page, scrolling is locked so the image stays lined up with what is
underneath. Every effect also has a fallback for when there is no snapshot or no WebGL.
The settings-page preview is the common case: Chrome won't let an extension screenshot
its own page without that grant.

**Injection.** `sfxPlayInTab()` in `effects.js` runs the whole sequence. It injects
`SFX_FILES` (the `content.js` core, then every `fx/*.js` module, each registering itself),
stops any live effect, captures the tab, then calls
`window.__screenFX.play(name, { duration, pool, snapshot })`. `play()` is async and
resolves to whether the effect started. The core guards against double-definition by
`RUNTIME` version, so a newer build replaces an older one in a tab that is already open.

`play()` tears down any live overlay before mounting a new one, so effects can never
stack. The overlay is a single `position: fixed` element at `z-index: 2147483600`
with `pointer-events: none`. Clicks pass straight through to the page; only the
dismiss button, and effects that are interactive on purpose, opt back in. Teardown is
scheduled from the duration the effect returns, with the requested duration + 2.5s as a
backstop.

The service worker keeps no state in variables — Chrome tears it down after ~30s idle, so
every handler reads `chrome.storage` fresh and every listener is registered synchronously
at the top level.

Effects that need to stay legible on both light and dark pages (Web slinger, Web shooter, Screen crack)
sample the page's background luminance and pick their line colour from it, backed by a
halo in the opposite tone.

## Adding an effect

1. In `content.js`, write the effect:

```js
function myEffect(stage, css, ctx) {
  const f = ctx.fit(400, 400, 300);           // {intro, outro, hold, k}
  const total = f.intro + f.hold + f.outro;   // always === ctx.duration

  css(`${R} .sfx-thing{position:absolute;inset:0;background:rgba(220,242,75,.2);}`);
  const thing = div('sfx-thing');
  breathe(thing, total, f.intro, f.outro);    // fade in at the start, out at the end
  stage.appendChild(thing);

  return total;                               // the ring drains over this; teardown after
}
```

   `stage` is an empty full-viewport div you own. `css(text)` appends scoped CSS that is
   discarded with the overlay. `ctx` gives you:

   | | |
   |---|---|
   | `ctx.duration` | what the user asked for, in ms |
   | `ctx.reduced` | true under `prefers-reduced-motion` |
   | `ctx.fit(intro, outro, min)` | `{intro, outro, hold, k}` that sum to exactly `duration`; `k` < 1 when intro/outro had to compress |
   | `ctx.hold(intro, outro, min)` | just the `hold` from `fit()` |

   Helpers in scope: `canvasLayer(stage)` (DPR-aware full-viewport 2D canvas),
   `loop(step)` (rAF tied to the overlay's lifetime), `later(fn, ms)`,
   `listen(target, type, fn)` (host-page listeners removed on teardown), `envelope()`.

   Prefix every selector with `${R}`, animate only `transform` / `opacity` / `filter`, and
   keep `linear` for genuinely constant motion only.

2. Register it in the `EFFECTS` object in `content.js` and bump `RUNTIME`.

3. Add `{ id, label, blurb }` to `SFX_EFFECTS` in `effects.js`, and a 64×64 icon at
   `icons/fx/<id>.svg` in the same style as the others. Popup grid, keys, settings
   gallery and schedule picker all follow from that.

## Regenerating the icons

```
npm install
npm run icons
```

`tools/make-icons.mjs` rasterizes `icons/brand.svg` with resvg (a dev-only dependency;
the extension itself loads nothing from `node_modules`). 16 and 32px use a simplified
mark with heavier strokes so it stays crisp in the toolbar.
