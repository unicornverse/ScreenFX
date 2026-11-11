/* ============================================================================
 * ScreenFX icon generator
 * ----------------------------------------------------------------------------
 * Rasterizes the brand mark (icons/brand.svg) into the extension's PNG icons.
 *
 *   npm install        (dev only: pulls @resvg/resvg-js)
 *   npm run icons      (or: node tools/make-icons.mjs)
 *
 * Sizes:
 *   16, 32   simplified mark (thicker strokes, bigger sparkle, no highlight
 *            or shadow) so it stays crisp in the toolbar
 *   48       full master, full bleed
 *   128      full master drawn at 96px, centred with 16px transparent padding
 *            (Chrome Web Store icon guidance)
 *
 * resvg is a build-time devDependency only; nothing the extension loads at
 * runtime references node_modules.
 * ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const ICONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const master = readFileSync(join(ICONS, 'brand.svg'), 'utf8');

/* Same mark, tuned for 16/32px: no hairline inner stroke, no top highlight,
   no shadow, heavier screen outline and a bigger, wider-gapped sparkle. */
const small = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4F7BFF"/><stop offset="1" stop-color="#8A4DFF"/></linearGradient>
<path id="star" d="M44 6Q45.8 18.2 58 20Q45.8 21.8 44 34Q42.2 21.8 30 20Q42.2 18.2 44 6Z"/>
<mask id="gap" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
<rect width="64" height="64" fill="#fff"/>
<use href="#star" fill="#000" stroke="#000" stroke-width="9" stroke-linejoin="round"/>
</mask>
</defs>
<rect width="64" height="64" rx="14" fill="url(#bg)"/>
<rect x="9" y="24" width="37" height="30" rx="7" fill="none" stroke="#fff" stroke-width="7" mask="url(#gap)"/>
<use href="#star" fill="#fff" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
</svg>`;

const raster = (svg, size) =>
  new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();

/* Embed the master at `art` px inside a transparent `canvas` px square. */
const padded = (svg, canvas, art) => {
  const off = (canvas - art) / 2;
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">` +
    `<svg x="${off}" y="${off}" width="${art}" height="${art}" viewBox="0 0 64 64">${inner}</svg></svg>`;
};

const jobs = [
  [16, raster(small, 16)],
  [32, raster(small, 32)],
  [48, raster(master, 48)],
  [128, raster(padded(master, 128, 96), 128)],
];

for (const [size, png] of jobs) {
  const file = join(ICONS, `icon${size}.png`);
  writeFileSync(file, png);
  console.log('wrote', file, `${png.length} bytes`);
}
