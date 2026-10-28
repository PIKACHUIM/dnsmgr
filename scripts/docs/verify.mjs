import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const siteRoot = join(root, 'docs/.vitepress/dist');
const config = await readFile(join(root, 'docs/.vitepress/config.mts'), 'utf8');
if (!/\bbase\s*:\s*['"]\/['"]/.test(config)) throw new Error('VitePress base must remain /');
const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) files.push(path);
  }
}
await collect(siteRoot);
const relativeFiles = new Set(files.map((file) => file.slice(siteRoot.length + 1).replaceAll('\\', '/')));
const htmlFiles = files.filter((file) => extname(file).toLowerCase() === '.html');
if (!htmlFiles.some((file) => file === join(siteRoot, 'index.html'))) throw new Error('Missing VitePress root index.html');

function checkInternalUrl(rawUrl, sourceFile) {
  const decoded = rawUrl.replaceAll('&amp;', '&');
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(decoded)) return;
  const pathname = decoded.split(/[?#]/, 1)[0];
  if (!pathname) return;
  const rootAbsolute = pathname.startsWith('/');
  const candidate = resolve(rootAbsolute ? siteRoot : dirname(sourceFile), `.${rootAbsolute ? pathname : `/${pathname}`}`);
  if (!candidate.startsWith(`${siteRoot}${process.platform === 'win32' ? '\\' : '/'}`) && candidate !== siteRoot) {
    throw new Error(`${sourceFile}: URL escapes the site output: ${rawUrl}`);
  }
  const relative = candidate.slice(siteRoot.length).replaceAll('\\', '/').replace(/^\//, '');
  const candidates = [relative];
  if (!extname(relative)) candidates.push(`${relative}.html`, join(relative, 'index.html').replaceAll('\\', '/'));
  if (!candidates.some((file) => relativeFiles.has(file))) throw new Error(`${sourceFile}: missing internal URL target ${rawUrl}`);
  if (rootAbsolute && pathname.startsWith('/dnsmgr/')) throw new Error(`${sourceFile}: forbidden repository subpath in URL ${rawUrl}`);
}

let references = 0;
for (const file of files) {
  const extension = extname(file).toLowerCase();
  if (!['.html', '.css', '.js', '.json'].includes(extension)) continue;
  const contents = await readFile(file, 'utf8');
  if (extension === '.html') {
    for (const match of contents.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      checkInternalUrl(match[1], file);
      references++;
    }
  } else if (extension === '.css') {
    for (const match of contents.matchAll(/url\(["']?([^\)"']+)["']?\)/g)) {
      checkInternalUrl(match[1], file);
      references++;
    }
  }
}

const indexHtml = await readFile(join(siteRoot, 'index.html'), 'utf8');
const emittedCss = files.filter((file) => extname(file).toLowerCase() === '.css');
for (const file of emittedCss) {
  const css = await readFile(file, 'utf8');
  if (css.includes('fonts.googleapis.com') || /font-family\s*:\s*Inter\b/.test(css)) {
    throw new Error(`${file}: default remote Inter font must not be included`);
  }
}
if (!/href=["']\/assets\/[^"']+\.css["']/.test(indexHtml) || !/src=["']\/assets\/[^"']+\.js["']/.test(indexHtml)) {
  throw new Error('Root page must load its CSS and JavaScript from /assets/');
}
if (!relativeFiles.has('vp-icons.css') || !relativeFiles.has('guide/platforms.html')) throw new Error('Missing required root asset or guide route');
if (files.some((file) => /\.(?:php|sql|env)$/i.test(file))) throw new Error('Private source files were included in the docs site');
console.log(`VitePress root-path verification passed: ${htmlFiles.length} HTML pages, ${references} internal HTML/CSS URLs; asset prefix /assets/; base /.`);
