// Generates the plain, print-ready QR sheet for the guests in three sizes (A4, A5 and A6 for the tables), each
// as a PDF plus the standalone HTML it is rendered from.
//
//   npm run qr:print
//   npm run qr:print -- --url=https://example.com --names="Ana & Marko"
//
// URL and names default to the values in app.yaml. The PDF is rendered with headless Chrome/Edge (set
// CHROME_PATH if it is not found); without one, only the HTML is written and can be printed to PDF from any
// browser. The QR code is vector, so the sheets stay sharp at any print size.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import QRCode from 'qrcode';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'print');

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [key, ...rest] = a.slice(2).split('=');
    return [key, rest.join('=')];
  })
);

function yamlValue(key) {
  const yaml = readFileSync(path.join(root, 'app.yaml'), 'utf8');
  const match = yaml.match(new RegExp(`^\\s*${key}:\\s*"([^"]*)"`, 'm'));
  return match ? match[1] : '';
}

const url = (args.url || yamlValue('BASE_URL')).replace(/\/$/, '');
const names = args.names || yamlValue('WEDDING_NAMES');
if (!url || !names) {
  console.error('Missing URL or names: set them in app.yaml or pass --url= and --names=.');
  process.exit(1);
}

const escapeHtml = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'H' });

// Every size is the A4 layout scaled: k scales spacing, tk scales text (the A6 table card keeps its text
// larger than a straight 50% would, which would be unreadable) and qr is the QR code's side in mm.
const sheets = [
  { name: 'a4', w: 210, h: 297, k: 1, tk: 1, qr: 120 },
  { name: 'a5', w: 148, h: 210, k: 148 / 210, tk: 148 / 210, qr: 120 * 148 / 210 },
  { name: 'a6', w: 105, h: 148, k: 0.5, tk: 0.8, qr: 68 }
];

const buildHtml = ({ w, h, k, tk, qr }) => {
  const mm = (v) => `${+(v * k).toFixed(2)}mm`;
  const pt = (v) => `${+(v * tk).toFixed(2)}pt`;
  return `<!doctype html>
<html lang="hr">
<head>
<meta charset="utf-8">
<title>QR • ${escapeHtml(names)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@600&family=Nunito:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  @page{size:${w}mm ${h}mm;margin:0}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{width:${w}mm;height:${h}mm;display:flex;align-items:center;justify-content:center;background:#fff;color:#2E2A26;font-family:'Nunito',sans-serif;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  main{width:${mm(170)}}
  .eyebrow{margin:0 0 ${mm(6)};font-size:${pt(11)};font-weight:600;letter-spacing:.15em}
  h1{margin:0 0 ${mm(5)};font-family:'Crimson Pro',Georgia,serif;font-weight:600;font-size:${pt(46)};line-height:1.15}
  .lead{margin:0;font-size:${pt(14)};text-wrap:balance}
  .qr{display:block;width:${+qr.toFixed(2)}mm;height:${+qr.toFixed(2)}mm;margin:${mm(10)} auto}
  .qr svg{display:block;width:100%;height:100%}
  .url{margin:0;font-size:${pt(11)};color:#8c7f68;word-break:break-all}
</style>
</head>
<body>
  <main>
    <p class="eyebrow">QR KOD ZA GOSTE</p>
    <h1>${escapeHtml(names)}</h1>
    <p class="lead">Skeniraj kod za dodavanje i pregled fotografija.</p>
    <div class="qr">${qrSvg}</div>
    <p class="url">${escapeHtml(url)}</p>
  </main>
</body>
</html>
`;
};

mkdirSync(outDir, { recursive: true });
for (const sheet of sheets) {
  writeFileSync(path.join(outDir, `qr-${sheet.name}.html`), buildHtml(sheet));
  console.log(`HTML: print/qr-${sheet.name}.html`);
}

const chrome = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].find((p) => p && existsSync(p));

if (!chrome) {
  console.warn('Chrome/Edge not found (set CHROME_PATH). Open the HTML files in a browser and print them at their own paper size.');
  process.exit(0);
}

// --virtual-time-budget lets the Google Fonts finish loading before the page is printed.
for (const sheet of sheets) {
  const htmlPath = path.join(outDir, `qr-${sheet.name}.html`);
  const pdfPath = path.join(outDir, `qr-${sheet.name}.pdf`);
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=15000',
    `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href
  ], { stdio: 'ignore' });
  console.log(`PDF:  print/qr-${sheet.name}.pdf`);
}
