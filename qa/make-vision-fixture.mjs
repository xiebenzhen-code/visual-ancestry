// Generate the fixed test picture used by the REAL vision smoke test.
// Deterministic structure: warm gradient ground, dark slab right, light disc
// left, dark band lower-third — enough geometry for a real model to classify.
// Idempotent: overwrites qa/fixtures/vision-probe.jpg on every run.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "vision-probe.jpg");
const W = 640;
const H = 480;

await mkdir(path.dirname(FIXTURE), { recursive: true });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#dccfae"/>
      <stop offset="1" stop-color="#8a7f66"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="452" y="120" width="148" height="260" rx="6" fill="#1c1c22"/>
  <circle cx="190" cy="192" r="96" fill="#efe4c8"/>
  <rect x="40" y="330" width="360" height="26" rx="4" fill="#3a3a42" opacity="0.85"/>
  <rect x="40" y="40" width="180" height="26" rx="4" fill="#f4ead2" opacity="0.9"/>
</svg>`;

await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(FIXTURE);
console.log("FIXTURE_OK " + FIXTURE);