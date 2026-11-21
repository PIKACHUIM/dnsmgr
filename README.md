<div align="center">

# DNSPanel

**多平台 DNS 管理 · 证书签发 · 自动部署**

彩虹聚合 DNS 管理系统（dnsmgr）的 TypeScript + Serverless 重写版，后端基于 Hono，前端基于 React 19，运行于 Cloudflare Workers / 腾讯云 EdgeOne Makers / 阿里云 ESA。

[![Stars](https://img.shields.io/github/stars/PIKACHUIM/dnsmgr?color=%23ED8936&logo=github)](https://github.com/PIKACHUIM/dnsmgr/stargazers)
[![Forks](https://img.shields.io/github/forks/PIKACHUIM/dnsmgr?color=%239F7AEA&logo=github)](https://github.com/PIKACHUIM/dnsmgr/forks)
[![Last commit](https://img.shields.io/github/last-commit/PIKACHUIM/dnsmgr)](https://github.com/PIKACHUIM/dnsmgr/commits/main)
[![License](https://img.shields.io/github/license/PIKACHUIM/dnsmgr)](./LICENSE)
[![Verify](https://img.shields.io/github/actions/workflow/status/PIKACHUIM/dnsmgr/verify.yml?branch=main&label=verify)](https://github.com/PIKACHUIM/dnsmgr/actions/workflows/verify.yml)

[功能简介](#功能简介) · [支持清单](#支持清单) · [快速开始](#快速开始) · [本地开发](#本地开发) · [技术架构](#技术架构) · [兼容边界](#兼容边界) · [上游项目](https://github.com/netcccyun/dnsmgr)

</div>

---

## 功能简介

DNSPanel 把分散在多家云厂商的域名解析、证书签发与证书部署收拢到一个控制台里。它不是静态面板：所有读写都直接调用服务商 API，凭据以 AES-GCM 加密存储，操作写入审计日志。

- **域名解析**：22 个 DNS 驱动，账户 / 域名 / 记录统一管理，支持批量添加、批量修改、批量启停删除、备注、分组、线路权重、Excel 导入、公网 DNS 生效检查、域名别名与分类。
- **Cloudflare 增强**：自定义主机名（SaaS）、Fallback Origin、DCV 委派、Tunnel 管理、CNAME 接入。
- **证书签发**：手动导入 PEM/PFX，或通过 ACME（Let's Encrypt / ZeroSSL / Google / LiteSSL / 自定义目录与 EAB）完成 DNS-01 签发；支持通配符、多域名、CNAME 代理验证、自动续签与分步 / 全自动推进。
- **证书部署**：47 个原生部署驱动，覆盖宝塔、1Panel、Kangle、CDN 面板、云厂商 CDN/CLB/WAF/对象存储等；另提供 Webhook 与轮询式执行器。
- **容灾切换**：HTTP(S) 健康检查失败后自动暂停或切换解析，恢复后切回，可发送通知。
- **定时任务**：按一次性 / 每天 / 每周 / 每月修改、启停、暂停或删除解析记录。
- **到期提醒**：基于 RDAP 查询域名到期时间，按天数和渠道发送提醒。
- **CF 优选 IP**：拉取优选 IP 数据源并自动更新解析记录，支持积分与任务状态查询。
- **通知渠道**：邮件、WxPusher、Telegram、企业微信、钉钉、飞书、QQ 机器人、自定义 Webhook。
- **安全与审计**：bcrypt 密码、TOTP 两步验证、图形验证码、会话与 CSRF 防护、权限校验、审计日志、存储快照导入导出与回滚。
- **多语言界面**：简体中文、繁體中文、English、日本語、한국어、Français、Deutsch、Italiano、Español、Português、Русский。

## 支持清单

### DNS 服务商（22）

Cloudflare、阿里云、腾讯云 DNSPod、腾讯云 EdgeOne、阿里云 ESA、AWS Route 53、百度云 DNS、华为云 DNS、火山引擎 DNS、京东云 DNS、青云 DNS、NameSilo、Spaceship、西部数码、宝塔 DNS、DNSLA、DNSMGR、dynv6、GoEdge、HE.net、PowerDNS、Technitium。

### 证书颁发机构

Let's Encrypt、ZeroSSL、Google Trust Services、LiteSSL、自定义 ACME Directory（支持 EAB）。

### 部署目标（47 + 2）

宝塔面板、宝塔 Win 极速版、Kangle 用户 / 管理员、雷池 WAF、堡塔云 WAF、Cdnfly、LeCDN、GoEdge、南墙 WAF、SamWaf、1Panel、MW 面板、AcePanel、耗子面板、小皮面板、AMH、CloudPanel、DirectAdmin、群晖、Lucky、Nginx Proxy Manager、Proxmox VE、K8S、阿里云、腾讯云、华为云、UCloud、七牛云、多吉云、AxisNow、又拍云、百度云、金山云、火山引擎、西部数码、网宿、白山云、天翼云、括彩云、全栈云、雨云、uniCloud、AWS、Gcore、Cachefly、S3 存储，以及 **Webhook** 与 **执行器**。

腾讯云驱动覆盖 16 种产品，并区分三种证书写入方式：

| 方式 | 行为 |
| --- | --- |
| 上传到证书管理 | 只新建一张证书，不改动任何实例 |
| 更新证书内容（证书ID不变） | 原地替换证书内容，需腾讯云加白 |
| 更新证书内容（生成新的ID） | 上传新证书并替换关联资源，可自动删除旧证书 |

## 快速开始

### 部署到 Cloudflare Workers

```bash
# 1. 安装依赖并构建前端与 Worker
npm ci --ignore-scripts
npm run build:cloudflare
```

2. 修改 `wrangler.toml`：把 `name`、`[[d1_databases]]` 的 `database_name` / `database_id`、`COORDINATOR_ID` 改成你自己的值。`COORDINATOR_ID` 参与存储身份校验，初始化后不可再改。

```bash
# 3. 创建 D1 并执行迁移
npx wrangler d1 create dnspanel-data
for file in migrations/*.sql; do npx wrangler d1 execute dnspanel-data --remote --file "$file"; done

# 4. 写入平台密钥（不要提交到仓库）
node -e "const c=require('node:crypto');console.log('APP_KEY='+c.randomBytes(32).toString('base64'));console.log('SETUP_TOKEN='+c.randomBytes(32).toString('hex'))"
npx wrangler secret put APP_KEY
npx wrangler secret put SETUP_TOKEN

# 5. 部署
npx wrangler deploy
```

首次打开站点会进入初始化向导，用 `SETUP_TOKEN` 创建管理员并设置密码。之后所有账户凭据都使用 `APP_KEY` 派生的密钥加密；**丢失 `APP_KEY` 会导致已有凭据无法解密**。

> `wrangler.toml` 中的 `[[send_email]]` 需要账户已启用 Email Routing，否则部署会失败；不需要邮件发信时可删除该绑定。

### 其他平台

| 平台 | 构建命令 | 入口 |
| --- | --- | --- |
| 腾讯云 EdgeOne Makers | `npm run build:edgeone` | `cloud-functions/`、`edgeone.json` |
| 阿里云 ESA | `npm run build:esa` | `dist/esa/worker.mjs`、`esa.jsonc` |

EdgeOne / ESA 使用 `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` 连接独立 SQLite/libSQL 库，并在该库执行同一组迁移。ESA 单次请求最多 4 个外部 fetch，长流程会按预算分步执行。

### 定时任务

- Cloudflare：在 `wrangler.toml` 启用 `[triggers] crons = ["* * * * *"]`，即可每分钟推进已启动的 ACME 签发任务。免费账户最多 5 个 Cron Trigger，名额不足时改用外部定时器。
- 外部定时器：在「系统设置 → Cron」启用并配置密钥，然后每分钟请求 `https://<你的域名>/cron?key=<密钥>`。
- 该入口会执行 DNS 计划任务、到期检查、自动续签与签发推进；不配置时，证书页仍可手动「自动完成签发」。

## 本地开发

推荐 Node.js 24（Makers 构建使用其预装的 Node.js 22.11）。

```bash
npm ci --ignore-scripts
npm run build:frontend

# 生成仅用于本地的密钥文件（已存在时命令会拒绝覆盖）
node -e "const fs=require('node:fs'),c=require('node:crypto');fs.writeFileSync('.env.local','APP_KEY='+c.randomBytes(32).toString('base64')+'\nSETUP_TOKEN='+c.randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});"

npm run dev
```

访问 `http://127.0.0.1:8787`，用 `.env.local` 里的 `SETUP_TOKEN` 完成初始化。本地数据保存在 `runtime/serverless.sqlite`，不会读写旧 MySQL。前端热更新另开终端执行 `npm run dev:frontend`（`http://127.0.0.1:5173`）。

常用校验：

```bash
npm run typecheck          # TypeScript
npm test                   # 单元与集成测试（内存 SQLite）
npm run test:compat        # 旧 PHP 契约扫描与基线比较
npm run test:e2e           # Playwright，本机 Chrome
npm run build:cloudflare   # 生产构建
npm run audit:dependencies # 高危依赖审计
```

`test:e2e` 使用独立内存库，验证安装、登录、会话恢复、验证码、响应式导航与深链，不会访问生产 DNS 或云端数据库。

## 技术架构

```text
浏览器 (React 19 + Vite)
        │  /api/v1/*
        ▼
Hono 应用 (TypeScript)
  ├─ routes/        HTTP 接口与权限、CSRF、会话校验
  ├─ dns/           22 个 DNS 驱动 + 统一记录模型
  ├─ certificates/  ACME 协议、证书生命周期
  ├─ deploy/        47 个部署驱动 + Webhook / 执行器
  ├─ notify/        通知渠道与 outbox
  ├─ schedule/      定时任务、容灾、到期提醒、优选 IP
  └─ storage/       D1 / Turso SQL、KV、Blob、快照版本
        │
        ▼
Cloudflare D1 · Turso/libSQL · Workers KV · R2 · EdgeKV · Blob
```

- **后端**：TypeScript、Hono、node-forge（X.509 / ACME JWS）、bcryptjs。
- **前端**：React 19、Vite，无第三方 UI 框架，自带设计系统与暗色适配。
- **构建**：esbuild 产出 `dist/<platform>/worker.mjs`，Wrangler / EdgeOne / ESA 分别部署。
- **数据**：默认为关系型 SQL（`DB_FORMAT=sql`），支持 D1 / Turso；对象模式使用不可变快照 + SQL 指针做版本控制。

## 配置变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_KEY` | 无 | 32 字节 Base64，用于加密凭据；平台 secret |
| `SETUP_TOKEN` | 无 | 初始化与重置授权令牌，≥32 字符；平台 secret |
| `DB_DRIVER` | `auto` | `d1` / `turso` / `kv` / `blob` / `auto` |
| `DB_FORMAT` | `sql` | `sql` / `map` / `key`；DNS、证书、部署表仅 `sql` 可用 |
| `COORDINATOR_ID` | 无 | D1 库身份标识，初始化后不可更改 |
| `PUBLIC_ORIGIN` | 请求来源 | 固定站点来源，用于快捷登录与回调校验 |
| `TURSO_DATABASE_URL` | 无 | EdgeOne / ESA 的 libSQL 地址 |
| `TURSO_AUTH_TOKEN` | 无 | libSQL 访问令牌 |
| `BLOB_NAMESPACE` | 无 | Makers Blob 命名空间 |
| `ESA_KV_NAMESPACE` | 无 | ESA EdgeKV 命名空间 |
| `MAKERS_KV_BRIDGE_URL` | 无 | Node Function 访问 Makers KV 的桥接地址 |
| `MAKERS_KV_BRIDGE_TOKEN` | 无 | 桥接令牌，≥32 字符 |

不要把 Token、密码或主密钥放进 `VITE_*` 或前端代码。

## 数据迁移

按顺序执行 `migrations/` 下的 SQL；已部署实例升级时只需执行新增文件。`app/` 保留旧 ThinkPHP 源码，仅用于行为对照与兼容扫描，不参与构建和部署。

`tests/fixtures/legacy-contracts.json` 记录旧版的 149 条路由、141 个公开方法、51 个模板与 205 处模板调用，是契约基线，不代表 TypeScript 覆盖率。修改上游语义前先读 `docs/guide/compatibility.md`。

## 兼容边界

以下是**已知且有意保留**的差异，其余能力以官方 PHP 版为准持续对齐：

- **需要 shell 或落盘的驱动**：`ssh`、`ftp`、`local`、`fnos` 未内置，因为 Workers 没有本地文件系统与 SSH 客户端。需要这类目标时使用「执行器」驱动，由你自己的机器轮询领取任务并落盘。
- **API 型免费证书**：腾讯云免费 SSL、阿里云测试证书、UCloud 免费证书按既定决策统一改走 ACME（Let's Encrypt / ZeroSSL / Google / LiteSSL / 自定义目录），以减少多套云账号与签名模型；已有证书仍可手动导入并部署。
- **出站代理**：Workers 不支持自定义出站代理，PHP 版各驱动中的「使用代理服务器」选项未提供。
- **请求预算**：ESA 单请求最多 4 次外部 fetch，Cloudflare 免费套餐 CPU 与子请求也有限，长流程统一拆分为多步 / 多次 cron。
- **真实云验证**：驱动大量使用本地构造请求与假绑定测试；生产环境已接入 Cloudflare D1 与部分真实 DNS，其他云厂商与邮件、执行器仍建议先在测试账户验证。

## 开源许可

本项目基于 [MIT License](./LICENSE)。旧版 PHP 项目版权归「消失的彩虹海」所有。

## 致谢

- [netcccyun/dnsmgr](https://github.com/netcccyun/dnsmgr)：功能语义与行为基线
- [Hono](https://hono.dev/)、[React](https://react.dev/)、[Vite](https://vite.dev/)、[node-forge](https://github.com/digitalbazaar/forge)
- 以及所有提交 Issue、反馈真实云差异的使用者
