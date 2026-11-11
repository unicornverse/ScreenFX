# Screenick — Chrome Web Store submission sheet

Copy each block into the matching field of the Developer Dashboard.
Images for every slot are in this folder (see "Graphic assets" at the bottom).

---

## Package tab (read-only, comes from `manifest.json`)

| Field | Value | Limit |
|---|---|---|
| Name | `Screenick` | — |
| Summary (manifest `description`) | `Click when bored. Twelve full-screen visual pranks for whatever tab you are on, on demand or on a timer.` | 132 chars (this is 104) |
| Version | `2.0.0` | must go up on every upload |

---

## Store listing tab

### Category

**Just for Fun**

### Language

**English**

### Description

```
Screenick turns whatever tab you're on into a two-second prank. Click the toolbar icon, pick an effect, and a full-screen animation plays over the real page, then cleans itself up. Nothing on the page is changed.

TWELVE EFFECTS
• Prison bars: rusted steel bars slam down and cast shadows on the page.
• Screen crack: the glass shatters and bends the page through every crack.
• Glitch: the page corrupts like a failing video signal.
• Confetti: paper flutters down and piles up on the page's own edges.
• Fireworks: night falls and every burst lights up the page.
• Bug invasion: ladybirds and ants explore the layout. Click one to squash it.
• Web slinger: a masked figure drops from the page's header on a line.
• Web shooter: click anything on the page to web it.
• Underwater: water rises and the page wobbles under caustics and fish.
• Deep freeze: frost grows over the glass and blurs the page behind it.
• Thunderstorm: rain runs down the glass and lightning lights the page.
• Black hole: bends the page around it, then swallows it whole.

Or hit Surprise me for a random one.

YOU CHOOSE HOW LONG
Effects last 3, 6, 12 or 30 seconds. Each one plays its intro at full speed, holds, and finishes exactly on time. A countdown ring on the close button shows what's left, and Esc ends any effect early.

BOOK ONE FOR LATER
Schedules play an effect at a time and on the days you pick, on whichever tab you're looking at. Friday at 4 PM, every weekday at 9:30, whatever helps.

KEYBOARD FRIENDLY
Number keys 1 to = play effects straight from the popup, R plays a random one, and you can assign a Chrome shortcut that plays Surprise me without opening the popup.

PRIVATE BY DESIGN
• No accounts, no analytics, no network requests. Screenick never sends anything anywhere.
• Effects read a screenshot of the visible tab so they can bend and relight it. That image stays in your browser's memory and is discarded when the effect ends.
• By default Screenick only touches the one tab you clicked it on. Schedules need broader tab access because they fire without a click, so that permission is optional, asked for only when you turn schedules on, and can be switched off from the same place.

ACCESSIBLE
Respects reduced motion (no camera shake, softer glitch, fewer particles, no lightning flash), reduced transparency and high-contrast settings. Glitch caps its strobing at three short cycles and Thunderstorm keeps its flashes well below full white.

Screenick can't run on Chrome's own pages (chrome://, the Chrome Web Store, other extensions, the built-in PDF viewer). The popup tells you when that's the case.
```

> About 2,650 characters. The dashboard allows far more; no keyword is repeated more than five times.

### Graphic assets

| Slot | File |
|---|---|
| Store icon (128×128) | `store-icon-128.png` |
| Screenshot 1 | `screenshot-1-hero.png` |
| Screenshot 2 | `screenshot-2-underwater.png` |
| Screenshot 3 | `screenshot-3-crack.png` |
| Screenshot 4 | `screenshot-4-effects.png` |
| Screenshot 5 | `screenshot-5-schedules.png` |
| Small promo tile (440×280) | `promo-small-440x280.png` |
| Marquee promo tile (1400×560) | `promo-marquee-1400x560.png` |

### Additional fields

| Field | Value |
|---|---|
| Homepage URL | *(optional — your GitHub repo or landing page)* |
| Support URL | *(optional — e.g. the repo's Issues page)* |
| Mature content | **No** |

---

## Privacy tab

### Single purpose

```
Screenick plays short, full-screen visual prank animations over the tab the user is looking at, either when the user picks one from the toolbar popup or keyboard shortcut, or at a time the user has scheduled.
```

### Permission justifications

**activeTab**
```
When the user clicks the toolbar icon or presses the keyboard shortcut, activeTab grants temporary access to that one tab so the chosen effect can be shown on it and a screenshot of the visible area can be taken. The screenshot is used only to draw the effect over the page (for example bending it into the black hole) and is never stored or transmitted.
```

**scripting**
```
Used to inject the extension's own bundled effect code (content.js and the fx/ modules shipped in the package) into the active tab, start the effect the user selected, and stop it again. No remote code is loaded and the page's content is not read or modified.
```

**storage**
```
Saves the user's preferences in chrome.storage.sync: effect duration, appearance, which effects are included in Surprise me, the last effect played, and the user's schedules. Nothing else is stored.
```

**alarms**
```
Schedules are implemented with chrome.alarms, one alarm per schedule the user creates, so the chosen effect plays at the time and on the days the user picked.
```

**Host permission (optional_host_permissions: <all_urls>)**
```
Optional, and requested only when the user turns on "Allow scheduled effects" in the settings page. A scheduled effect fires without a user click, so activeTab cannot cover it; this permission lets the effect play on whichever tab is in front at that moment. It can be removed with the same switch. Without it, everything except schedules works on activeTab alone. Screenick never reads page content and makes no network requests.
```

### Remote code

**No, I am not using remote code.**

### Data usage

**What user data do you plan to collect from users now or in the future?** — leave every box **unchecked**.

Reasoning, in case a reviewer asks: Screenick makes no network requests, so nothing leaves the user's device. The tab screenshot is processed in memory inside the page and discarded when the effect ends. Settings live in `chrome.storage.sync`, which Chrome syncs through the user's own Google account; the developer never receives them.

**Certifications** — tick all three:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

Not strictly required when no data is collected, but recommended. Publish `PRIVACY.md` (next to this file) somewhere public — a GitHub Pages page or the raw file in a public repo — and paste that URL.

---

## Distribution tab

| Field | Value |
|---|---|
| Payments | Free |
| Visibility | **Public** (or **Unlisted** first if you want a soft launch) |
| Regions | All regions |

---

## Test instructions tab (optional, helps the reviewer)

```
No account or login is needed.
1. Open any normal https website (effects cannot run on chrome:// pages or the Web Store).
2. Click the Screenick toolbar icon and pick any effect, or press a number key 1 to = while the popup is open. Esc or the close button ends an effect early.
3. Schedules: open Settings (slider icon in the popup), switch on "Allow scheduled effects" (this requests the optional all-sites permission), add a schedule a minute or two in the future, and keep a website tab in front.
```

---

## Before you hit submit

- [x] Upload package built: `screenick-2.0.0.zip` (40 runtime files, `manifest.json` at the root, forward-slash paths, 196 KB). Upload this one, not the old `screenick-v2.0.0.zip` in the project root.
- [ ] Unzip it, load the folder unpacked at `chrome://extensions` once, and play a couple of effects.
- [ ] Decide on **Web slinger**: its icon and animation read as Spider-Man. Trademarked characters can get an item rejected or removed. The store images already leave it out; consider redesigning or dropping the effect before submitting.
- [ ] One-time developer registration fee paid, publisher name and contact email verified.
