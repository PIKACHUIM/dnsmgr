# 本地开发与验证

## 运行环境

- 文档站与前端构建：Node.js 22.11 或更高版本。
- 完整测试（包含 `node:sqlite`）建议 Node.js 24。
- Playwright 浏览器测试需要本机 Chrome。

## 安装依赖与构建管理界面

在仓库根目录执行：

```bash
npm ci --ignore-scripts
npm run build:frontend
```

首次本地运行，生成只在本机使用的密钥文件；命令以 `wx` 模式创建，文件已存在时不会覆盖：

```bash
node -e "const fs=require('node:fs'),c=require('node:crypto');fs.writeFileSync('.env.local','APP_KEY='+c.randomBytes(32).toString('base64')+'\nSETUP_TOKEN='+c.randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});"
npm run dev
```

打开 `http://127.0.0.1:8787`，用 `.env.local` 的 `SETUP_TOKEN` 进行一次性初始化。本地 SQLite 文件是 `runtime/serverless.sqlite`，不连接旧 MySQL。继续使用该数据库时，必须保留原 `APP_KEY`，否则无法解密已有账号凭据。

如需启用前端热更新，可在另一个终端启动：

```bash
npm run dev:frontend
```

访问 `http://127.0.0.1:5173`。Vite 代理只将其固定本地 Origin 重写到 `127.0.0.1:8787`。

## 运行 VitePress 文档站

```bash
npm run docs:dev
npm run docs:build
npm run docs:verify
npm run docs:preview
npm run docs:e2e
```

预览构建产物后，通过 `Ctrl+C` 停止 VitePress 服务。生产构建输出到 `docs/.vitepress/dist/`。

## 验证命令

```bash
npm run typecheck
npm test
npm run test:compat
npm run test:e2e
npm run build:cloudflare
npm run build:edgeone
npm run build:esa
npm run audit:dependencies
```

`npm test` 使用隔离的 SQLite 内存库及平台 API 替身；`test:e2e` 会启动本地服务，用 Chrome 验证初始化、登录、会话恢复、登录验证码设置与启用后的登录表单、响应式导航、到期提醒天数与逐渠道开关保存/重载、深链和退出。E2E 的独立临时数据库默认关闭验证码，避免初始化后无法自动登录；测试会显式启用并检查登录表单。测试不会连接生产 DNS、数据库或平台存储。

## 本地数据与安全

- `APP_KEY` 必须为 32 字节 Base64；`SETUP_TOKEN` 至少 32 字符。
- 不要把 `.env.local`、平台令牌、密码或加密主密钥加入版本控制。
- 本地默认 HTTP 仅绑定 `127.0.0.1`。任何公网部署都必须使用 HTTPS。
- 旧 PHP 安装流程与 Serverless 独立库互不读取；本次没有 MySQL 迁移脚本。
