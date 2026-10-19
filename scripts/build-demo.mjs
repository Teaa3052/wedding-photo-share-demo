// Builds the static demo into demo-dist/: the guest page from public/ plus demo/demo.js, which answers the /api/*
// calls in the browser instead of server.js. The output needs no backend and can be hosted on GitHub Pages.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'demo-dist');

const COPY = ['styles.css', 'app.js', 'bouquet-top-right.png', 'bouquet-bottom-left.png'];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const name of COPY) await cp(path.join(root, 'public', name), path.join(out, name));
await cp(path.join(root, 'demo', 'demo.js'), path.join(out, 'demo.js'));

// GitHub Pages serves a project site under /<repo>/, so the page's root-relative asset paths become relative.
let html = await readFile(path.join(root, 'public', 'index.html'), 'utf8');
html = html
  .replace(/(href|src)="\/(?!\/)/g, '$1="./')
  .replace('<script src="./app.js"></script>', '<script src="./demo.js"></script>\n  <script src="./app.js"></script>');
if (!html.includes('./demo.js')) throw new Error('Could not inject demo.js before app.js in index.html.');

await writeFile(path.join(out, 'index.html'), html);
await writeFile(path.join(out, '.nojekyll'), '');
console.log(`Demo built in ${path.relative(root, out)}/`);
