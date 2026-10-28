import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import fixture from './fixtures/legacy-contracts.json';
import { baseline, checkManifest, diffManifest, fixturePath, repositoryRoot, scanLegacy } from '../scripts/compat/scan.mjs';
import { diffPhpSource } from '../scripts/compat/diff.mjs';
import { scanController, scanRegistry, scanRoutes, tokenize } from '../scripts/compat/php.mjs';
import { scanTemplate } from '../scripts/compat/templates.mjs';

type Manifest = typeof fixture;
let manifest: Manifest;

function publicMethod(controller: string, method: string) {
  const result = manifest.controllers.find((entry) => entry.name === controller)?.publicMethods.find((entry) => entry.name === method);
  expect(result, `${controller}/${method} 必须归属于正确控制器`).toBeDefined();
  return result!;
}

beforeAll(async () => {
  manifest = await scanLegacy() as unknown as Manifest;
});

describe('旧 PHP 契约的独立语义约束', () => {
  it('锁定本地 commit、fork 与上游，不根据当前 HEAD 滚动基线', () => {
    expect(baseline.commit).toBe('cb0254e94b65e5922bd9cda511d4d7c301de795f');
    expect(baseline.fork).toBe('git@github.com:PIKACHUIM/dnsmgr.git');
    expect(baseline.remoteAccess).toBe(false);
    expect(manifest.scope.migrationStatus).toBe('not-implemented');
  });

  it('保留149声明的路由组、方法、参数、目标与鉴权边界', () => {
    expect(manifest.counts.routes).toBe(149);
    expect(manifest.routing.groups.map((group) => [group.id, group.routeCount])).toEqual([
      ['public', 10], ['authenticated', 129], ['api', 10],
    ]);
    expect(manifest.routing.routes.find((route) => route.path === '/login')).toMatchObject({
      group: 'public', method: 'ANY', target: 'auth/login', middleware: ['SessionInit', 'ViewOutput'],
    });
    expect(manifest.routing.routes.find((route) => route.path === '/record/data/:id')).toMatchObject({
      group: 'authenticated', method: 'POST', target: 'domain/record_data', middleware: ['CheckLogin', 'ViewOutput'],
    });
    expect(manifest.routing.routes.find((route) => route.path === '/api/record/data/:id')).toMatchObject({
      group: 'api', method: 'POST', target: 'domain/record_data', middleware: ['AuthApi'],
    });
    expect(manifest.routing.patterns).toEqual([{ parameter: 'id', expression: '\\d+' }]);
  });

  it('准确归属141 public方法，并明确保留旧 PHP 缺失方法', () => {
    expect(manifest.counts.controllers).toBe(12);
    expect(manifest.counts.publicMethods).toBe(141);
    expect(publicMethod('Domain', 'domain_op').operations.filter((operation) => operation.kind === 'branch').map((operation) => operation.value)).toEqual([
      'get', 'add', 'edit', 'del', 'batchadd', 'batchedit', 'batchsetnotice', 'batchdel', 'updateexpire',
    ]);
    expect(manifest.diagnostics.filter((diagnostic) => diagnostic.code === 'MISSING_CONTROLLER_METHOD')).toEqual([
      { code: 'MISSING_CONTROLLER_METHOD', target: 'domain/dnscheck', path: '/domain/dnscheck', method: 'ANY', routeLine: 90 },
    ]);
    expect(manifest.controllers.find((controller) => controller.name === 'Domain')?.publicMethods.some((method) => method.name === 'dnscheck')).toBe(false);
  });

  it.each([
    ['Cert', 'order_op', ['delete', 'reset', 'open', 'close']],
    ['Cert', 'deploy_op', ['cert', 'delete', 'reset', 'open', 'close', 'cert']],
    ['Dmonitor', 'task_op', ['delete', 'retry', 'open', 'close']],
    ['Schedule', 'stask_op', ['delete', 'open', 'close']],
  ])('枚举 %s/%s 的二次嵌套 operation/act 分支', (controller, method, values) => {
    const nested = publicMethod(controller, method).operations.filter((operation) => operation.parameter === 'act' && operation.kind === 'branch');
    expect(nested.map((operation) => operation.value)).toEqual(values);
    for (const operation of nested) {
      expect(operation.source).toBe('post');
      expect(operation.parents.flatMap((parent) => parent.selectors)).toContainEqual({
        parameter: 'action', source: 'param', operator: '==', value: 'operation',
      });
    }
    expect(publicMethod(controller, method).operations.some((operation) => operation.parameter === 'act' && operation.kind === 'comparison' && operation.value === 'open')).toBe(true);
  });

  it('区分注册数量与实现文件：22 DNS、8注册/9文件 cert、51 deploy', () => {
    expect(manifest.providers.dns.registeredCount).toBe(22);
    expect(manifest.providers.dns.implementationFileCount).toBe(22);
    expect(manifest.providers.cert.registeredCount).toBe(8);
    expect(manifest.providers.cert.implementationFileCount).toBe(9);
    expect(manifest.providers.cert.unregisteredFiles).toEqual(['app/lib/cert/huoshan.php']);
    expect(manifest.providers.cert.registered.map((entry) => entry.id)).not.toContain('huoshan');
    expect(manifest.providers.deploy.registeredCount).toBe(51);
    expect(manifest.providers.deploy.implementationFileCount).toBe(51);
    for (const provider of Object.values(manifest.providers)) {
      expect(provider.missingImplementation).toEqual([]);
      expect(provider.registered.every((entry) => entry.migrationStatus === 'not-implemented')).toBe(true);
    }
  });

  it('覆盖50 HTML和exception.tpl，并记录模板真实调用而不是臆测URL', () => {
    expect(manifest.counts.templates).toBe(51);
    expect(manifest.templates.some((template) => template.file === 'app/view/exception.tpl')).toBe(true);
    const template = manifest.templates.find((entry) => entry.file === 'app/view/cert/certorder.html');
    expect(template?.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'url-property', url: '/cert/order/data', resolution: 'literal' }),
      expect.objectContaining({ kind: 'url-property', url: '/cert/order/operation', resolution: 'literal' }),
      expect.objectContaining({ kind: 'jquery-post', url: '/cert/order/show_log', resolution: 'literal' }),
    ]));
    const dynamic = manifest.templates.find((entry) => entry.file === 'app/view/user/user.html')?.calls.find((call) => call.expression.includes("'/user/op/act/'+act"));
    expect(dynamic).toMatchObject({ literalPrefix: '/user/op/act/', resolution: 'dynamic', url: null });
    expect(manifest.sourceInventory.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
    expect(manifest.sourceInventory.some((entry) => entry.file === 'app/controller/Domain.php')).toBe(true);
  });

  it('默认 check 从 PHP 重新扫描，差异比较能发现删除、新增和 source hash 变化', async () => {
    expect(await checkManifest()).toEqual([]);
    const changed = structuredClone(manifest);
    changed.routing.routes.pop();
    changed.providers.cert.registeredCount++;
    changed.sourceInventory[0]!.sha256 = 'changed';
    expect(diffManifest(manifest, changed).map((difference: { path: string }) => difference.path)).toEqual(expect.arrayContaining([
      'routing.routes.148', 'providers.cert.registeredCount', 'sourceInventory.0.sha256',
    ]));
    expect(JSON.parse(await readFile(fixturePath, 'utf8'))).toEqual(manifest);
  });

  it('显式 PHP 路径 diff 仅读取，不改变源码和 fixture', async () => {
    const before = await readFile(fixturePath, 'utf8');
    const routeBefore = await readFile(join(repositoryRoot, 'route/app.php'), 'utf8');
    expect((await diffPhpSource(repositoryRoot)).differences).toEqual([]);
    expect(await readFile(fixturePath, 'utf8')).toBe(before);
    expect(await readFile(join(repositoryRoot, 'route/app.php'), 'utf8')).toBe(routeBefore);
    await expect(diffPhpSource('')).rejects.toThrow('必须显式提供');
  });
});

describe('解析器防静默遗漏', () => {
  it('忽略注释和字符串里的伪Route，但未知声明与链式方法必须失败', () => {
    const source = `<?php // Route::post('/ghost', 'ghost/index');
      Route::get('/real', 'index/index');`;
    expect(scanRoutes(source).routes.map((route: { path: string }) => route.path)).toEqual(['/real']);
    expect(() => scanRoutes(`<?php Route::resource('thing', 'Thing');`)).toThrow('未识别的 Route::resource');
    expect(() => scanRoutes(`<?php Route::get('/real', 'index/index')->name('x');`)).toThrow('未识别的 Route 链式语法');
    expect(() => scanRoutes(`<?php Route::get($path, 'index/index');`)).toThrow('必须为静态字符串');
  });

  it('控制器括号深度和字符串转义不把相邻/private方法的操作错误归属', () => {
    const scanned = scanController(`<?php class Example {
      public function first() { $action=input('param.action'); if ($action == 'operation') {
        foreach ([] as $id) { if (input('post.act') === 'delete') { $text="} { \\\""; } }
      } }
      private function hidden() { if (input('post.act') == 'secret') {} }
      public function second() { $act=input('get.act'); if ('edit' == $act) {} }
    }`, 'Example.php');
    expect(scanned.publicMethods.map((method: { name: string }) => method.name)).toEqual(['first', 'second']);
    expect(scanned.publicMethods[0]?.operations.map((operation: { value: string }) => operation.value)).toEqual(['operation', 'delete']);
    expect(scanned.publicMethods[1]?.operations.map((operation: { value: string }) => operation.value)).toEqual(['edit']);
  });

  it('含不确定 PHP 分支、反引号执行字串、heredoc 时不假装扫描成功', () => {
    expect(() => tokenize('<?php $text=`whoami`;')).toThrow('反引号');
    expect(() => tokenize('<?php $text=<<<TEXT\nhello\nTEXT;')).toThrow('heredoc');
    expect(() => scanController(`<?php class X { public function op() { switch(input('post.act')) { case 'delete': break; } } }`, 'X.php')).toThrow('switch 分支尚未支持');
    expect(() => scanController(`<?php class X { public function op() { $act=input('post.act'); if ($act == $dynamic) {} } }`, 'X.php')).toThrow('不是静态字面量');
    expect(() => scanController(`<?php class X { public function op() { $act=input('post.act'); if ($act == 'delete' . $suffix) {} } }`, 'X.php')).toThrow('比较含复合表达式');
    expect(() => scanController(`<?php class X { public function op() { $act=input('post.act'); if (in_array($act, ['delete'])) {} } }`, 'X.php')).toThrow('无法识别 act/action 条件分支');
    expect(() => scanController(`<?php class X { public function op() { $action=get_action(); if ($action == 'delete') {} } }`, 'X.php')).toThrow('变量绑定不明确');
    expect(() => scanController(`<?php class X { public function op() { if ($_POST['act'] == 'delete') {} } }`, 'X.php')).toThrow('原始请求数组分支尚未支持');
  });

  it('只枚举 provider 顶层 registry 键，不把嵌套 input 字段误认为 provider', () => {
    const entries = scanRegistry(`<?php class Helper { public static $cert_config=[
      'example'=>['name'=>'Example', 'inputs'=>['fake'=>['name'=>'Not a provider']]],
    ]; }`, 'cert_config', 'Helper.php');
    expect(entries.map((entry: { id: string }) => entry.id)).toEqual(['example']);
  });

  it('模板保留反引号插值和动态URL，并忽略注释里的调用', () => {
    const result = scanTemplate('<script>// $.post("/ghost", {});\nconst r=/url:["\\\']/;\n$.post(`/record/add/${id}`, {}); $.ajax({url: "/cert/order/" + action}); fetch("/api/domain");</script>', 'example.html');
    expect(result.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'jquery-post', literalPrefix: '/record/add/${id}', resolution: 'dynamic' }),
      expect.objectContaining({ kind: 'url-property', literalPrefix: '/cert/order/', url: null, resolution: 'dynamic' }),
      expect.objectContaining({ kind: 'fetch', url: '/api/domain', resolution: 'literal' }),
    ]));
    expect(result.calls).toHaveLength(3);
    expect(result.diagnostics).toHaveLength(2);
    expect(() => scanTemplate('<script>fetch(`/record/${`nested`}`);</script>', 'nested.html')).toThrow('尚不支持嵌套 JS 模板字串');
  });
});
