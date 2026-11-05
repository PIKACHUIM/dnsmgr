import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(join(root, '.env.local')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!process.env.APP_KEY || !process.env.SETUP_TOKEN) throw new Error('Configure APP_KEY and SETUP_TOKEN in .env.local or the local process environment');
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local PORT');
const shell = await readFile(join(root, 'dist/frontend/index.html'), 'utf8');
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/app.ts', 'src/platform/runtime.ts'],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  outdir: 'unused', define: { __APP_SHELL__: JSON.stringify(shell) },
});
const [appCode, runtimeCode] = result.outputFiles;
const { createApp } = await import(`data:text/javascript;base64,${Buffer.from(appCode.contents).toString('base64')}`);
const { environment } = await import(`data:text/javascript;base64,${Buffer.from(runtimeCode.contents).toString('base64')}`);
await stat(join(root, 'runtime'));
const sqlite = new DatabaseSync(process.env.LOCAL_EPHEMERAL === '1' ? ':memory:' : join(root, 'runtime/serverless.sqlite'));
sqlite.exec('PRAGMA foreign_keys=ON');
const version = Number(sqlite.prepare('PRAGMA user_version').get().user_version);
const migrations = [
  '0001_core.sql', '0002_dns.sql', '0003_dns_aliases.sql', '0004_schedule.sql',
  '0005_failover.sql', '0006_domain_expiration_queue.sql', '0007_domain_periodic_expiration_queue.sql',
];
if (version > migrations.length) throw new Error('Local schema version is newer than this application');
for (const [index, migration] of migrations.entries()) {
  const nextVersion = index + 1;
  if (nextVersion <= version) continue;
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    sqlite.exec(await readFile(join(root, 'migrations', migration), 'utf8'));
    sqlite.exec(`PRAGMA user_version=${nextVersion}`);
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}
const execute = (sql, args = []) => {
  const rows = sqlite.prepare(sql).all(...args);
  const changes = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql) ? Number(sqlite.prepare('SELECT changes() AS changes').get().changes) : 0;
  return { rows, changes };
};
const db = {
  async query(sql, args = []) { return execute(sql, args).rows; },
  async execute(sql, args = []) { return execute(sql, args); },
  async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(({ sql, args }) => execute(sql, args)); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  },
};
const bindings = {
  DB_DRIVER: 'd1', DB_FORMAT: 'sql', DB: {}, COORDINATOR_ID: 'local-sqlite', APP_KEY: process.env.APP_KEY, SETUP_TOKEN: process.env.SETUP_TOKEN,
  PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (!/^\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2)$/.test(path)) return new Response(null, { status: 404 });
      try {
        const data = await readFile(join(root, 'dist/frontend', path));
        const type = path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2' : 'text/javascript';
        return new Response(data, { headers: { 'Content-Type': type } });
      } catch (error) { if (error.code === 'ENOENT') return new Response(null, { status: 404 }); throw error; }
    },
  },
};
const app = createApp({ database: db });
const server = createServer(async (incoming, outgoing) => {
  try {
    let length = 0;
    const chunks = [];
    for await (const chunk of incoming) {
      length += chunk.length;
      if (length > 64 * 1024) { outgoing.writeHead(413, { 'content-type': 'application/json' }); outgoing.end('{"code":-1,"msg":"请求体超过64KB"}'); return; }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
      method: incoming.method, headers,
      body: ['GET', 'HEAD'].includes(incoming.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await app.fetch(request, environment(bindings, 'local'));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500); outgoing.end('Local server error'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Local-only DnsMgr: http://127.0.0.1:${port}; ${process.env.LOCAL_EPHEMERAL === '1' ? 'ephemeral test database' : 'runtime/serverless.sqlite'}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { sqlite.close(); process.exit(0); }));
