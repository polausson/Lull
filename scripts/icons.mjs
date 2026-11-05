// Generates PNG app icons from the SVG design. Run: npm run icons
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const icon = (pad = 0, bg = true) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  ${bg ? '<rect width="512" height="512" fill="#1c2029"/>' : ''}
  <g transform="translate(256 256) scale(${1 - pad})">
    <circle r="168" fill="#9db8a4" opacity=".10"/>
    <circle r="124" fill="#9db8a4" opacity=".18"/>
    <circle r="82" fill="#9db8a4" opacity=".9"/>
  </g></svg>`;
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><circle cx="36" cy="36" r="14" fill="#fff"/><circle cx="36" cy="36" r="24" fill="none" stroke="#fff" stroke-width="4" opacity=".7"/></svg>`;

writeFileSync('public/favicon.svg', icon());
const out = [
  ['public/icon-192.png', icon(), 192],
  ['public/icon-512.png', icon(), 512],
  ['public/icon-maskable-512.png', icon(0.2), 512],
  ['public/apple-touch-icon.png', icon(), 180],
  ['public/badge-72.png', badge, 72],
];
for (const [file, svg, size] of out) await sharp(Buffer.from(svg)).resize(size, size).png().toFile(file);
console.log('icons written');
