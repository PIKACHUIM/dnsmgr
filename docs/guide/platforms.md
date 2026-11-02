# 平台构建与根路径部署

三个平台共享 Hono 业务核心，但使用各自的运行时入口及持久化绑定。当前构建已通过本地 bundle 检查；它只证明代码可打包，不等于平台账号、持久化资源、套餐配额或真实流量已验证。

## 根路径与静态资源 URL

文档站配置 `base: '/'`。若部署地址为 `https://docs.example.com/`，构建页内的脚本、样式资源地址形如：

```text
https://docs.example.com/assets/<hash>.js
https://docs.example.com/assets/<hash>.css
```

不要把站点部署在 `/dnsmgr/` 并把 `base` 改成 `/dnsmgr/`。将 `docs/.vitepress/dist/` **里面的内容**发布到目标域名的站点根目录。GitHub Pages 项目站点默认地址是 `https://<owner>.github.io/<repo>/`，不满足本项目的 URL 约束；必须在仓库 Settings → Pages 绑定自定义域名，`.github/workflows/docs.yml` 检测不到自定义域名时会直接失败，而不是发布坏链接。

DNS 管理应用本身也服务于根路径。文档站应发布到独立站点/域名根，或由部署层明确选择文档站作为该域名根站点；两套产物不可同时覆盖同一个根目录。

## 文档站发布（GitHub Actions）

| 项 | 值 |
| --- | --- |
| 工作流 | `.github/workflows/docs.yml` |
| 触发 | push 到 `main` 且改动 `docs/`、`scripts/docs/`、依赖清单；或手动 dispatch |
| 构建 | `npm ci --ignore-scripts` → `npm run docs:build` → `npm run docs:verify` |
| 发布 | `actions/upload-pages-artifact` + `actions/deploy-pages` |
| 权限 | `contents: read`、`pages: write`、`id-token: write` |

首次启用需在仓库设置里把 Pages 来源设为 **GitHub Actions**，并填写自定义域名。文档站不使用 Cloudflare Pages/Workers。

## Cloudflare Workers

构建命令：

```bash
npm run build:cloudflare
```

| 产物 | 路径 |
| --- | --- |
| Hono worker | `dist/cloudflare/worker.mjs` |
| 静态资源目录 | `dist/cloudflare/public/` |
| 平台配置 | `wrangler.toml` |

部署前需要自行创建 D1 数据库，配置 `DB` binding 并依次执行 `migrations/0001_core.sql`、`migrations/0002_dns.sql`。D1 SQL 模式的 `COORDINATOR_ID` 必须固定。DNS 账户/域名/审计表仅在 `DB_FORMAT=sql` 下可用。若使用对象格式，还需绑定 `KV` 或 `BUCKET`（R2），并固定 `PAYLOAD_STORE_ID`。敏感的 `APP_KEY` 与 `SETUP_TOKEN` 使用 Wrangler secrets，不写入 vars 或客户端 bundle。

例如（命令只设置当前 Cloudflare 项目的 Secret，不会由本地构建执行）：

```bash
npx wrangler secret put APP_KEY
npx wrangler secret put SETUP_TOKEN
```

## EdgeOne Makers

构建命令：

```bash
npm run build:edgeone
```

- Worker bundle：`cloud-functions/_worker.mjs`，由 `cloud-functions/index.js` 和 `cloud-functions/[[default]].js` 入口转发。
- 静态目录：`dist/edgeone/public/`；配置文件：`edgeone.json`。
- Node Function 需在平台配置 SQL/Turso 凭据；Blob 模式设置 `BLOB_NAMESPACE`。
- VitePress 的静态站点建议作为独立站点部署到域名根；不要把它复制进 DNS 应用 `public` 目录。
- Makers 原生 KV 当前属于 Edge Functions 能力；本项目 Node Cloud Function 的受认证 KV bridge 尚未实现。

`@edgeone/pages-blob` 的锁定版本将 `onlyIfNew` 标成废弃/不执行条件写；本项目适配器不使用它来模拟原子锁。

## 阿里云 ESA

构建命令：

```bash
npm run build:esa
```

- Edge Routine entry：`dist/esa/worker.mjs`。
- 静态目录：`dist/esa/public/`；入口与产物位置在 `esa.jsonc` 声明。
- 使用 ESA EdgeKV 时需在平台预先创建 namespace，并设置 `DB_DRIVER=kv`、`ESA_KV_NAMESPACE`、`PAYLOAD_STORE_ID` 和 `COORDINATOR_DRIVER=turso`，再配置 `TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN` 与数据库迁移。
- Edge Routine 从 `fetch(request, context, env)` 第三个参数读取函数变量；密钥保留在平台配置中。
- 每个请求只预留 4 次外部 fetch，数据库与对象存储操作共享预算；超预算时服务拒绝请求。

ESA 没有在本仓库验证 EdgeKV 的真实 namespace、传播延迟、Turso 权限或套餐 limits。不得将本地 fake binding 测试说成线上 smoke test。

## 上线前必须补充

1. 三平台分别配置好受限权限的 SQL 及 payload store，并运行 schema migration。
2. 用非生产环境验证 secret 注入、读写、恢复、一致性和 CORS/来源设置。
3. 量测目标套餐对 bcrypt、D1/Turso 请求预算及 ESA 外部 fetch 限额的承载。
4. 确认 DNS、证书、任务等业务模块已迁移且通过兼容测试后，才能评估生产切换。
