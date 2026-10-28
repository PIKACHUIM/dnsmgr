import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanController, scanRegistry, scanRoutes } from './php.mjs';
import { scanTemplate } from './templates.mjs';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const fixturePath = join(repositoryRoot, 'tests/fixtures/legacy-contracts.json');
export const baseline = Object.freeze({
  commit: 'cb0254e94b65e5922bd9cda511d4d7c301de795f',
  fork: 'git@github.com:PIKACHUIM/dnsmgr.git',
  upstream: 'https://github.com/netcccyun/dnsmgr',
  evidence: { commit: 'local git rev-parse HEAD at Wave1 start', fork: 'local git remote origin at Wave1 start', upstream: 'README.md:5-9' },
  remoteAccess: false,
});

async function filesUnder(root, directory, predicate) {
  const files = [];
  const visit = async (relative) => {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`${path}: 兼容扫描不跟随符号链接`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && predicate(path)) files.push(path);
    }
  };
  await visit(directory);
  return files;
}

export async function scanLegacy(phpRoot = repositoryRoot) {
  const root = resolve(phpRoot);
  const inventoryPaths = [
    ...(await filesUnder(root, 'app', (file) => /\.(php|html|tpl)$/.test(file))),
    ...(await filesUnder(root, 'route', (file) => file.endsWith('.php'))),
    ...(await filesUnder(root, 'config', (file) => file.endsWith('.php'))),
  ].sort();
  const texts = new Map();
  const hashes = new Map();
  const sourceInventory = [];
  for (const file of inventoryPaths) {
    const text = (await readFile(join(root, file), 'utf8')).replace(/\r\n/g, '\n');
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    texts.set(file, text);
    hashes.set(file, sha256);
    sourceInventory.push({ file, sha256 });
  }
  const text = (file) => {
    if (!texts.has(file)) throw new Error(`${file}: 必需的 PHP 契约源文件缺失`);
    return texts.get(file);
  };
  const routeFiles = inventoryPaths.filter((file) => file.startsWith('route/'));
  if (routeFiles.length !== 1 || routeFiles[0] !== 'route/app.php') throw new Error('发现额外/缺失 route PHP 文件，需显式扩展扫描范围');
  const routing = scanRoutes(text('route/app.php'));
  const controllers = inventoryPaths.filter((file) => /^app\/controller\/[^/]+\.php$/.test(file)).map((file) => ({ ...scanController(text(file), file), sha256: hashes.get(file) }));
  const controllerPaths = inventoryPaths.filter((file) => file.startsWith('app/controller/') && file.endsWith('.php'));
  if (controllerPaths.length !== controllers.length) throw new Error('发现嵌套 controller 文件，需显式扩展控制器扫描范围');
  const missingTargets = routing.routes.filter((route) => {
    const [controllerName, methodName] = route.target.split('/');
    return !controllers.some((controller) => controller.name.toLowerCase() === controllerName.toLowerCase() && controller.publicMethods.some((method) => method.name.toLowerCase() === methodName.toLowerCase()));
  }).map((route) => ({ code: 'MISSING_CONTROLLER_METHOD', target: route.target, path: route.path, method: route.method, routeLine: route.line }));
  const providers = {};
  for (const [kind, helper, variable] of [['dns', 'DnsHelper', 'dns_config'], ['cert', 'CertHelper', 'cert_config'], ['deploy', 'DeployHelper', 'deploy_config']]) {
    const registryFile = `app/lib/${helper}.php`;
    const implementationFiles = inventoryPaths.filter((file) => file.startsWith(`app/lib/${kind}/`) && file.endsWith('.php'));
    const registered = scanRegistry(text(registryFile), variable, registryFile).map((entry) => {
      const implementationFile = `app/lib/${kind}/${entry.id}.php`;
      const exists = hashes.has(implementationFile);
      return { ...entry, implementationFile: exists ? implementationFile : null, sha256: exists ? hashes.get(implementationFile) : null, migrationStatus: 'not-implemented' };
    });
    providers[kind] = {
      registryFile,
      registrySha256: hashes.get(registryFile),
      registeredCount: registered.length,
      implementationFileCount: implementationFiles.length,
      registered,
      implementationFiles: implementationFiles.map((file) => ({ file, sha256: hashes.get(file), registered: registered.some((entry) => entry.implementationFile === file) })),
      unregisteredFiles: implementationFiles.filter((file) => !registered.some((entry) => entry.implementationFile === file)),
      missingImplementation: registered.filter((entry) => entry.implementationFile === null).map((entry) => entry.id),
    };
  }
  const templates = inventoryPaths.filter((file) => file.startsWith('app/view/') && /\.(html|tpl)$/.test(file)).map((file) => ({ ...scanTemplate(text(file), file), sha256: hashes.get(file), migrationStatus: 'not-implemented' }));
  return {
    schemaVersion: 1,
    baseline,
    scope: {
      phase: 'Wave1 contract inventory',
      migrationStatus: 'not-implemented',
      sourceHashAlgorithm: 'SHA-256 over UTF-8 text with CRLF normalized to LF',
      sourceDirectories: ['app/**/*.php', 'app/**/*.html', 'app/**/*.tpl', 'route/**/*.php', 'config/**/*.php'],
      parser: 'conservative lexical PHP subset; unknown Route syntax or unknown act/action dispatch fails',
      templateAnalysis: 'lexical inline-script URL call sites; dynamic expressions retained, not resolved or executed',
      excluded: ['PHP runtime behavior', 'TypeScript implementation completeness', 'provider network execution', 'frontend rendering equivalence', 'external static JavaScript call sites'],
    },
    counts: {
      routes: routing.routes.length,
      routeGroups: routing.groups.length,
      controllers: controllers.length,
      publicMethods: controllers.reduce((total, controller) => total + controller.publicMethods.length, 0),
      operationComparisons: controllers.reduce((total, controller) => total + controller.publicMethods.reduce((sum, method) => sum + method.operations.length, 0), 0),
      templates: templates.length,
      templateCalls: templates.reduce((total, template) => total + template.calls.length, 0),
      sourceFiles: sourceInventory.length,
    },
    routing: { file: 'route/app.php', sha256: hashes.get('route/app.php'), ...routing },
    controllers,
    providers,
    templates,
    diagnostics: [
      ...missingTargets,
      ...controllers.flatMap((controller) => controller.publicMethods.flatMap((method) => method.diagnostics.map((diagnostic) => ({ ...diagnostic, file: controller.file, method: method.name })))),
      ...Object.entries(providers).flatMap(([kind, provider]) => provider.unregisteredFiles.map((file) => ({ code: 'UNREGISTERED_PROVIDER_FILE', kind, file }))),
    ],
    sourceInventory,
  };
}

export function diffManifest(expected, actual) {
  const differences = [];
  const visit = (before, after, path) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
      for (const key of keys) visit(before[key], after[key], path ? `${path}.${key}` : key);
    } else differences.push({ path, expected: before === undefined ? null : before, actual: after === undefined ? null : after });
  };
  visit(expected, actual, '');
  return differences;
}

export async function checkManifest(path = fixturePath, root = repositoryRoot) {
  const expected = JSON.parse(await readFile(path, 'utf8'));
  return diffManifest(expected, await scanLegacy(root));
}

async function main(args) {
  if (args.some((argument) => !['--write', '--check'].includes(argument)) || args.length > 1) throw new Error('用法: node scripts/compat/scan.mjs [--write|--check]；默认重新扫描并比对基线');
  const manifest = await scanLegacy();
  if (args[0] === '--write') {
    await writeFile(fixturePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`已生成 tests/fixtures/legacy-contracts.json：${manifest.counts.routes} 路由，${manifest.counts.templates} 模板`);
  } else {
    const expected = JSON.parse(await readFile(fixturePath, 'utf8'));
    const differences = diffManifest(expected, manifest);
    if (differences.length) {
      console.error(`兼容基线不一致（${differences.length} 处）；先审查变化，再显式运行 npm run compat:generate`);
      for (const difference of differences.slice(0, 30)) console.error(`  ${difference.path}: ${JSON.stringify(difference.expected)} -> ${JSON.stringify(difference.actual)}`);
      process.exitCode = 1;
    } else console.log(`兼容基线检查通过：${manifest.counts.routes} 路由，${manifest.counts.templates} 模板，${manifest.counts.sourceFiles} 源文件`);
  }
  for (const diagnostic of manifest.diagnostics.filter((item) => item.code === 'MISSING_CONTROLLER_METHOD')) console.warn(`旧 PHP 缺少方法：${diagnostic.target}（${diagnostic.path}，route/app.php:${diagnostic.routeLine}）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
