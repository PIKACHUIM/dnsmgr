import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseline, diffManifest, fixturePath, scanLegacy } from './scan.mjs';

export async function diffPhpSource(phpRoot, manifestPath = fixturePath) {
  if (!phpRoot) throw new Error('必须显式提供只读 PHP 路径');
  const expected = JSON.parse(await readFile(resolve(manifestPath), 'utf8'));
  const actual = await scanLegacy(resolve(phpRoot));
  return { baseline, differences: diffManifest(expected, actual) };
}

async function main(args) {
  if (args.length !== 2 || args[0] !== '--php-root') throw new Error('用法: node scripts/compat/diff.mjs --php-root <PHP工程路径>；仅只读比对，不访问远程或覆盖基线');
  const result = await diffPhpSource(args[1]);
  console.log(JSON.stringify(result, null, 2));
  if (result.differences.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
