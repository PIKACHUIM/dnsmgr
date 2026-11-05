import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const cli = resolve(root, 'node_modules/vitest/vitest.mjs');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
