import { build } from 'esbuild';
import { mkdir, readFile, readdir, cp, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.argv[2];
const outputs = {
  cloudflare: 'dist/cloudflare/worker.mjs',
  edgeone: 'cloud-functions/_worker.mjs',
  esa: 'dist/esa/worker.mjs',
};
if (!Object.hasOwn(outputs, platform)) throw new Error('Specify cloudflare, edgeone or esa');
const shell = await readFile(join(root, 'dist/frontend/index.html'), 'utf8');
if (!shell.includes('/assets/')) throw new Error('Frontend shell must reference hashed assets');
const assetOutput = join(root, `dist/${platform}/public/assets`);
await stat(root);
await mkdir(assetOutput, { recursive: true });
await cp(join(root, 'dist/frontend/assets'), assetOutput, { recursive: true });
const output = join(root, outputs[platform]);
await mkdir(dirname(output), { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: [`src/platform/${platform}.ts`],
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: platform === 'edgeone' ? 'node20' : 'es2022',
  minify: true,
  sourcemap: false,
  metafile: true,
  define: { __APP_SHELL__: JSON.stringify(shell) },
});
for (const path of Object.keys(result.metafile.inputs)) {
  if (/executor|node:|\.php$|\.sql$/.test(path)) throw new Error(`Invalid edge dependency: ${path}`);
}
for (const outputMetadata of Object.values(result.metafile.outputs)) {
  if (outputMetadata.imports.some((entry) => entry.external)) throw new Error('Platform artifact contains unresolved imports');
}
if (platform === 'esa' && (await stat(output)).size > 4 * 1024 * 1024) throw new Error('ESA bundle exceeds 4MB');
const assets = await readdir(assetOutput);
if (assets.some((asset) => /\.(php|sql|map|env)$/i.test(asset))) throw new Error('Private files in asset directory');
console.log(`${platform}: ${outputs[platform]} (${(await stat(output)).size} bytes), ${assets.length} hashed assets; no external imports`);
