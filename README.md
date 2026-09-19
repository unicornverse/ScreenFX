# ScreenFX

A "click when bored" Chrome extension. Hit the toolbar icon, pick one of eight effects, and
a full-screen animation plays over whatever tab you're on, then cleans itself up. You
choose how long it lasts, and you can book one in advance so it ambushes you at 4pm on a
Tuesday.

Manifest V3. No build step, no dependencies, no remote assets — every effect is plain
CSS, SVG and vanilla JS.

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

| # | Effect | What happens |
|---|--------|--------------|
| 1 | Prison bars | Steel bars slam down with overshoot, the screen takes an impact shake, bars lift back up |
| 2 | Web slinger | A line anchors in the top-right corner and lowers a web-slinger smoothly down the page, where he hangs and sways before being drawn back up |
| 3 | Web shooter | A gloved forearm reaches in from the bottom-right and tracks your pointer. Click anywhere and a line thwips out to a web that sticks |
| 4 | Flood | Silt-laden water surges up from below, swallows the page whole, drifts debris across its surface, then drains away |
| 5 | Underwater | The page goes under. Light shafts, caustics, rising bubbles and fish swimming past at three depths |
| 6 | Glitch | Backdrop-filter slices tear through the real page, chromatic fringing, scanlines, inversion hits |
| 7 | Confetti | Mixed shapes fall with independent sway and tumble |
| 8 | Screen crack | A dropped phone: cracked cover glass over a broken display — liquid-crystal bleed, driver line bands, rainbow mura and backlight blowout |

Press **1–8** in the popup to play one without clicking. Every overlay has a dismiss
button in the top-right whose ring counts the remaining time down, and **Esc** ends an
effect early.

## Time on screen

The popup's segmented control sets how long an effect stays up: **3s / 6s / 12s / 30s**.
It is stored in `chrome.storage.sync`, so it follows your Chrome profile.

Longer does not mean slower. Each effect plays its intro at natural speed, sits in a
**hold** phase for the remaining budget, then plays its outro — a slam is a slam whether
you asked for 3 seconds or 30. What the hold looks like is the effect's own business:
the bars just stay down, the silhouette keeps swinging, the flood sits at high water, and
confetti keeps being emitted rather than falling in slow motion.

Two deliberate exceptions:

- **Glitch caps its strobing at 3 cycles (~4.7s)** no matter what you set, then settles
  into a non-strobing dead-signal wash for the rest. A 30-second strobe is a
  photosensitivity hazard, not a longer joke.
- **Flood compresses** rather than overruns. Its surge and drain are ~2.6s together, which
  does not fit the 3s setting, so both scale down to land inside the budget.

Under `prefers-reduced-motion: reduce` the camera shakes are dropped, Glitch replaces its
strobe with a single soft desaturating wash, the web slinger's rope is damped so it descends
straight instead of swaying, the flood skips its spray, and the cracked panel stops flickering.

## Where the effects get their behaviour

Four of the eight are built on measured physics or on reference photography rather than on
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
- **Flood** is opaque on purpose. Flood water is silt-laden, so anything it covers is simply
  gone until it leaves, and a heavy backdrop-filter under a silt-coloured body is the only
  honest way to take the page away without touching the page. A surge rises fast and then
  slows as it spreads, so the rise is strongly eased out; the surface runs two crests at
  different periods against each other, because a single scrolling wave reads as a loop.
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
content.js             the injected runtime: overlay lifecycle + EFFECTS registry
theme.css              design system: OKLCH colour, spring easings, type roles,
                       and the shared primitives (grouped list, segmented control,
                       switch, buttons)
popup.html/.css/.js    the toolbar popup: effect grid, duration, keyboard handling
options.html/.css/.js  full-tab settings: defaults, theme, schedules
icons/                 16/32/48/128px toolbar icons
tools/make-icons.mjs   regenerates icons/ (node tools/make-icons.mjs)
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

The popup calls `chrome.scripting.executeScript` twice: once to load `content.js` into the
active tab, once to call `window.__screenFX.play(name, { duration })`. `content.js` guards
against double-definition, so repeat clicks just re-run `play()`.

`play()` tears down any live overlay before mounting a new one, so effects can never
stack. The new overlay is a single `position: fixed` element at `z-index: 2147483600`
with `pointer-events: none`, so clicks, scrolls and selection all pass straight through to
the page; only the dismiss button opts back in with `pointer-events: auto`. Teardown is
scheduled from the duration the effect returns, with the requested duration + 2.5s as a
backstop.

The service worker keeps no state in variables — Chrome tears it down after ~30s idle, so
every handler reads `chrome.storage` fresh and every listener is registered synchronously
at the top level.

Effects that need to stay legible on both light and dark pages (Web Drop, Screen Crack)
sample the page's background luminance and pick their line colour from it, backed by a
halo in the opposite tone.

## Adding a ninth effect

1. In `content.js`, write the effect:

```js
function myEffect(stage, css, ctx) {
  const INTRO = 400, OUTRO = 400;
  const HOLD = ctx.hold(INTRO, OUTRO, 300);   // or ctx.fit() — see below
  const total = INTRO + HOLD + OUTRO;

  css(`${R} .sfx-thing{position:absolute;inset:0;background:rgba(220,242,75,.2);}`);
  const thing = div('sfx-thing');
  breathe(thing, total, INTRO, OUTRO);        // fade in at the start, out at the end
  stage.appendChild(thing);

  return total;                               // the overlay tears down after this
}
```

   `stage` is an empty full-viewport div you own. `css(text)` appends scoped CSS that is
   discarded with the overlay. `ctx` gives you:

   | | |
   |---|---|
   | `ctx.duration` | what the user asked for, in ms |
   | `ctx.reduced` | true under `prefers-reduced-motion` |
   | `ctx.hold(intro, outro, min)` | ms to sit still between intro and outro |
   | `ctx.fit(intro, outro, min)` | same, but returns compressed `{intro, outro, hold}` when your intro + outro cannot fit the shortest setting |

   Prefix every selector with `${R}`, animate only `transform` / `opacity` / `filter`, and
   keep `linear` for genuinely constant motion only.

2. Register it:

```js
const EFFECTS = { prisonBars, spiderman: webSlinger, webShooter, waterfall: flood,
                  underwater, glitch, confetti, crack, myEffect };
```

3. In `popup.js`, append one entry to the `EFFECTS` array with a matching `id`, a `label`,
   a short `sub`, and a 26×26 `currentColor` SVG glyph. The grid, the numbering, the
   keyboard shortcut and the hover choreography hooks all follow from that.

4. In `options.js`, add the same id to `EFFECT_LABELS` so it can be scheduled.

## Regenerating the icons

```
node tools/make-icons.mjs
```

The icons are drawn procedurally (accent-blue tile, white fractured bolt) and written
with a small hand-rolled PNG encoder, so the repo carries no binary source assets.
