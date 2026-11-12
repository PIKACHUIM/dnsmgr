# 发布与回滚

本页描述当前仓库可执行的验证、发布与回滚步骤。所有命令都要求在仓库根目录、使用 Node ≥ 22.11，并先完成 `npm ci`。没有真实平台账号与凭据时，只能完成本地构建和单测，不能视为线上验收。

## 发布前检查

```bash
npm run typecheck
npm test
npm run test:compat
npm run build:cloudflare
npm run build:edgeone
npm run build:esa
npm run docs:build
npm run docs:verify
```

GitHub Actions 的 `Verify` 工作流（`.github/workflows/verify.yml`）会在 push 到 `main` 和 Pull Request 时执行同一组检查。`compat` 检查只验证旧 PHP 契约基线未漂移，不代表 TypeScript 功能覆盖率。

上线前还需确认：

- `DB_FORMAT=sql`；DNS 账户、域名、分类与审计表依赖 SQL 协调库。
- `COORDINATOR_ID` 与存储身份保持不变。修改驱动、格式、数据库 URL 或对象命名空间会被识别为换库并拒绝启动。
- `APP_KEY`、`SETUP_TOKEN` 只存在于平台 Secret，不进入 `wrangler.toml`、构建产物或前端包。
- 已用真实 DNS 账户至少验证一次凭据校验、域名同步与一条记录的增删改；驱动单测使用构造请求，不能替代真实冒烟。

## Cloudflare Workers 发布

首次升级到登录验证码版本时，先备份 D1 并确认 `login_captcha_challenges` 尚不存在，再应用新增迁移；它为缺省配置启用验证码，但保留已有 `vcode` 设置，不修改用户、密码或会话：

```bash
npx wrangler d1 execute dnsmgrui-data --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='login_captcha_challenges'"
npx wrangler d1 execute dnsmgrui-data --remote --file migrations/0009_login_captcha.sql
```

如果表已存在，不要重复执行 `0009_login_captcha.sql`。证书订单首阶段需要另行备份 D1，并仅在 `cert_orders` 尚不存在时应用迁移：

```bash
npx wrangler d1 execute dnsmgrui-data --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='cert_orders'"
npx wrangler d1 execute dnsmgrui-data --remote --file migrations/0010_certificates.sql
```

若订单表已存在，不要重放该建表迁移。它只创建 TS 证书订单/域名表，不会导入旧 PHP MySQL 订单或证书材料。手动执行 SQL 不会登记到 Wrangler migration history；迁移完成后用表结构查询确认，再部署 Worker：

ACME DNS-01 签发需要再次备份 D1，并应用 `0011_certificate_acme.sql`。该迁移会重建 `cert_orders` / `cert_order_domains` 以放宽 `source` 约束并保留外键，同时新增 `cert_acme_accounts`、`cert_acme_orders`；请在维护窗口内执行。它不能逐语句回滚，失败时只能从备份恢复，因此先记录行数，迁移后再核对：

```bash
npx wrangler d1 export dnsmgrui-data --remote --output backup-before-acme-$(date +%Y%m%d-%H%M).sql
npx wrangler d1 execute dnsmgrui-data --remote --command "SELECT (SELECT COUNT(*) FROM cert_orders) AS orders, (SELECT COUNT(*) FROM cert_order_domains) AS domains"
npx wrangler d1 execute dnsmgrui-data --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='cert_acme_accounts'"
npx wrangler d1 execute dnsmgrui-data --remote --file migrations/0011_certificate_acme.sql
npx wrangler d1 execute dnsmgrui-data --remote --command "SELECT (SELECT COUNT(*) FROM cert_orders) AS orders, (SELECT COUNT(*) FROM cert_order_domains) AS domains"
```

`cert_acme_accounts` 已存在时不要重放 `0011`。该版本不会自动续签或部署证书；生产 CA 注册必须由管理员在界面显式确认，staging 默认用于验证。每次推进签发任务只执行一个 CA/DNS 操作，结果未知时先核对再重试。证书账户页可单独注册 ACME 账户，证书订单页负责签发、导入与 PFX 导出。

```bash
npx wrangler d1 execute dnsmgrui-data --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='login_captcha_challenges'"
npx wrangler deploy
npx wrangler deployments list
```

`wrangler.toml` 中的 `name` 为 `dnsmgrui-work`，D1 绑定为 `dnsmgrui-data`。部署完成后至少检查：

```bash
curl -fsS https://<worker-domain>/health
```

首次安装使用 `POST /install` 并携带 `X-Setup-Token`；安装完成后移除或轮换 `SETUP_TOKEN`，避免重复初始化尝试。

### 回滚 Worker 代码

Cloudflare 保留历史版本，优先回滚到上一个已验证版本：

```bash
npx wrangler deployments list
npx wrangler rollback <deployment-id>
```

`wrangler rollback` 只回退 Worker 代码，不回退 D1 数据。数据库迁移按“只向前”处理：如果新版本已写入新表或新列，旧版本必须能忽略这些结构，否则应先恢复数据库快照再回滚代码。

### 数据库备份与恢复

发布前导出 D1：

```bash
npx wrangler d1 export dnsmgrui-data --remote --output backup-$(date +%Y%m%d-%H%M).sql
```

恢复时先停止写入（回滚 Worker 或暂停流量），再导入到空数据库：

```bash
npx wrangler d1 execute dnsmgrui-data --remote --file backup-YYYYMMDD-HHMM.sql
npx wrangler d1 execute dnsmgrui-data --remote --command "PRAGMA foreign_keys = ON"
```

不要直接把生产库导出文件提交到仓库；备份包含账户密文、会话与审计数据，应按敏感数据保管。

## EdgeOne Makers 与阿里云 ESA

首次升级到登录验证码版本前，先备份各自配置的 Turso/libSQL 数据库，将 `migrations/0009_login_captcha.sql` 应用一次，再部署新构建。该迁移默认开启验证码并保留已存在的 `vcode` 值；如果 `login_captcha_challenges` 表已存在，不要重放建表 SQL。各平台使用数据库的受控 SQL 工具执行，不要把凭据或生产备份提交到仓库。

回滚代码时，两者不回退 Cloudflare Worker，而是重新部署上一份构建产物：

1. 在本地检出上一个已验证的提交，执行对应 `npm run build:edgeone` 或 `npm run build:esa`。
2. 按平台控制台重新上传 `cloud-functions/_worker.mjs` 或 `dist/esa/worker.mjs`，并同步静态目录。
3. 保持平台变量、Secret 与存储绑定不变；换绑会被存储身份校验拒绝。
4. 用 `/health` 和一次只读请求确认入口生效。

ESA 每次请求的外部 `fetch` 预算有限，回滚后应优先验证 DNS 列表读取，而非批量写入。Makers Node Function 尚无受认证的 KV bridge，KV 模式不要作为 Makers 的回滚目标。

## 文档站回滚

文档站由 `.github/workflows/docs.yml` 通过 GitHub Pages 发布，不部署到 Cloudflare：

1. 在 GitHub Actions 中找到最近一次成功的 `Deploy docs` 运行。
2. 重新运行该运行的部署作业，或回退对应提交后重新触发工作流。
3. 确认自定义域名仍指向 Pages，且站点资源仍为根路径 `/assets/`。项目子路径（`/<repo>/`）会触发 `docs:verify` 失败，不要绕过校验发布。

## 回滚后必须复查

- `/health` 返回 `code: 0`。
- 管理员可以登录，旧会话按预期失效或恢复。
- 域名列表、解析记录读取正常；写入操作只对单个测试记录执行。
- 审计日志继续写入，且没有出现重复调度器同时控制同一条 DNS 记录。
- D1 表数量与迁移版本符合预期；对象存储活动版本指针与 SQL 协调库一致。
