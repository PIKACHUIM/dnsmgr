# 项目概览

DnsMgr 原版是 ThinkPHP + PHP + MySQL 的 DNS 管理系统。当前仓库正在迁移为 TypeScript + Hono + React 的 Serverless 项目；旧 PHP 源码留在原位置，作为行为和上游差异的对照基线。

> 当前新应用仍处于基础阶段，尚不能替代旧版接管生产 DNS。文档描述的是仓库现有实现，不代表已在 Cloudflare、EdgeOne 或 ESA 线上部署验证。

## 目标平台与边界

| 平台 | Web/API 入口 | 协调数据库 | 对象存储 |
| --- | --- | --- | --- |
| Cloudflare Workers | `src/platform/cloudflare.ts` | D1 | Workers KV / R2 |
| EdgeOne Makers | Node Cloud Function | Turso/libSQL | Makers Blob；Node Function 尚无原生 KV bridge |
| 阿里云 ESA | Edge Routine `fetch(request, context, env)` | Turso/libSQL | EdgeKV |

Hono 公共核心负责请求路由、认证和业务服务。DNS 驱动、域名分类、批量操作与操作日志已实现，但域名别名、URL 转发、证书、定时/容灾任务、通知、执行器以及相关管理页面仍在迁移中。

## 当前能力

已完成本地实现与测试的基础包括：

- 首次安装授权、bcrypt 密码哈希、服务端 Cookie 会话、CSRF 校验及 TOTP 防重放。
- D1 和 Turso SQL 适配、版本迁移、协调租约和 fencing。
- `map` 快照与 `key` 不可变实体、单键 CAS 写/删与分页索引；活动版本由 SQL 指针发布。
- Cloudflare KV/R2、EdgeOne Blob、ESA EdgeKV 适配。平台适配测试使用本地替身，尚未连接真实云资源。
- DNS 账户、域名同步与解析记录 CRUD，22 个服务商驱动已全部实现（Cloudflare、阿里云、DNSPod、EdgeOne、阿里云 ESA、Route53、百度云、华为云、火山引擎、京东云、青云、NameSilo、Spaceship、西部数码、宝塔、DNSLA、DNSMGR、dynv6、GoEdge、HE.net、PowerDNS、Technitium）；凭据 AES-GCM 加密，写操作审计入库。驱动目前仅有本地请求构造单测，未经真实凭据冒烟。
- 旧 PHP 路由、控制器分派、提供方注册与模板调用清单。

尚未完成：Makers Node Function 的 KV bridge、格式/驱动导出导入和故障恢复/回收工具、验证码与快捷登录、域名别名与 URL 转发、Cloudflare SaaS 与 Tunnel、证书与任务、执行器、完整业务界面及上游定期同步 CI。

> Cloudflare Workers 已部署用于验证基础链路，但 DNS 业务尚未在真实服务商凭据下做线上冒烟；Makers 与 ESA 未部署。

## 项目结构

- `src/app.ts`：Hono 应用和受控静态页面路径。
- `src/platform/`：Cloudflare、EdgeOne、ESA 入口及平台适配。
- `src/storage/`：SQL、协调租约、实体与 `map`/`key` 版本存储。
- `migrations/`：SQLite-compatible 版本化 schema，不执行破坏性全表重建。
- `frontend/`：React/Vite 管理控制台基础界面。
- `docs/`：本 VitePress 手册；与运行中的 DNS 管理应用分别构建。
- `tests/fixtures/legacy-contracts.json`：旧 PHP 契约扫描结果，不等同于 TS 移植完成率。

## 下一步阅读

- [本地开发](./local-development)：安装依赖、运行测试和生成本地密钥。
- [存储模型](./storage)：驱动、格式、协调库与一致性边界。
- [平台构建与根路径部署](./platforms)：三平台构建产物及 `/assets/` URL 要求。
- [迁移与兼容状态](./compatibility)：旧接口清单和尚未移植模块。
