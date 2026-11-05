# 彩虹聚合DNS管理系统

<div align="center">

[![GitHub stars](https://img.shields.io/github/stars/netcccyun/dnsmgr?style=flat)](https://github.com/netcccyun/dnsmgr/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/netcccyun/dnsmgr?style=flat)](https://github.com/netcccyun/dnsmgr/forks)
[![Docker Pulls](https://img.shields.io/docker/pulls/netcccyun/dnsmgr?style=flat)](https://hub.docker.com/r/netcccyun/dnsmgr)
[![GitHub release (latest by date)](https://img.shields.io/github/v/release/netcccyun/dnsmgr)](https://github.com/netcccyun/dnsmgr/releases)
[![GitHub last commit](https://img.shields.io/github/last-commit/netcccyun/dnsmgr)](https://github.com/netcccyun/dnsmgr/commits/main)

</div>

彩虹聚合DNS管理系统 是一款基于ThinkPHP开发的网站程序，可实现在单一网站内管理多个平台的域名解析，目前已支持的域名解析平台有：阿里云、腾讯云、华为云、百度云、西部数码、火山引擎、DNSLA、CloudFlare、AWS Route 53、Namesilo、PowerDNS

## 功能特性

- 多用户管理，可为每个用户可分配不同的域名解析权限；
- 提供API接口，可获取域名单独的登录链接，方便各种IDC系统对接；
- 容灾切换功能，支持ping、tcp、http(s)检测协议并自动暂停/修改域名解析，并支持发送通知；
- 定时切换功能，设置在指定时间/周期，自动修改/开启/暂停/删除域名解析；
- CF优选IP功能，支持获取最新的Cloudflare优选IP，并自动更新到解析记录；
- SSL证书申请与自动部署功能，支持从Let's Encrypt等渠道申请SSL证书，并自动部署到各种面板、云服务商、服务器等；
- 支持邮件、微信公众号、Telegram、钉钉、飞书、企业微信等多种通知渠道。

## Serverless 改造（进行中）

本仓库正在将旧 ThinkPHP 项目改造为 **TypeScript + Hono + React**。旧 PHP 源码保留原位置用于语义对照；**当前新应用仍处于基础阶段，不是完整业务替代品，不应上线接管生产 DNS**。

### 当前进度与恢复点

| 阶段 | 当前状态 |
| --- | --- |
| Wave 1：三平台工程与兼容基线 | 已完成本地构建和基础路由验证 |
| Wave 2：存储与安全 | SQL、事务、租约 fencing、map/key 不可变版本、key 增量写删/分页、安装/会话/CSRF/TOTP、CF KV/R2、ESA EdgeKV、Makers Blob 已接入并通过本地假绑定测试；Makers KV bridge、恢复回收、格式切换、验证码与快捷登录仍待完成 |
| Wave 3：DNS/Cloudflare | 22 个 DNS 驱动全部接入：Cloudflare、阿里云、DNSPod、腾讯云 EdgeOne、阿里云 ESA、AWS Route53、百度云、华为云、火山引擎、京东云、青云、NameSilo、Spaceship、西部数码、宝塔、DNSLA、DNSMGR、dynv6、GoEdge、HE.net、PowerDNS、Technitium；账户、域名、解析记录 CRUD/启停/备注可用；支持对 A、AAAA、CNAME、MX、TXT、NS、SOA、PTR、SRV、CAA 记录执行只读公网 DNS 检查，使用固定 AliDNS DoH 端点并限流，不改写服务商记录；域名分类、批量操作、操作日志、记录批量添加与厂商日志（阿里云/DNSPod）、Cloudflare 自定义主机名/Fallback Origin/DCV 委派与 Tunnel（公网主机名自动 CNAME、CIDR/主机名路由）已接入；单域名手动 RDAP 到期时间刷新已接入（IANA 引导，仅允许 HTTPS 注册信息端点），数据表见 `migrations/0002_dns.sql` 与 `migrations/0003_dns_aliases.sql`。驱动与 Cloudflare 扩展仅通过本地构造请求单测，未使用真实服务商凭据冒烟；显性/隐性 URL 转发类型已接入阿里云、DNSPod、京东云、DNSLA 与 Cloudflare（URI）；DNSPod 域名别名（本地镜像 `dns_domain_aliases`）已接入 |
| Wave 4：任务/SSL/通知/执行器 | 定时解析切换任务（一次性/每天/每周/每月，启用/暂停/删除/改值）、`/cron?key=`、时区与密钥设置已实现，数据表见 `migrations/0004_schedule.sql`；`/cron` 每次最多执行一次域名到期 RDAP 查询：优先处理首次查询/批量加入队列，再按 -5 至 +30 天窗口、至少间隔 24 小时复查已有到期记录，队列索引见 `migrations/0006_domain_expiration_queue.sql`、`migrations/0007_domain_periodic_expiration_queue.sql`；基于公网 HTTP(S) 健康检查的 DNS 主备容灾切换、自定义 Webhook、WxPusher、Telegram、企业微信群机器人、钉钉与飞书群机器人通知已接入，容灾表见 `migrations/0005_failover.sql`；通知凭据使用 AES-GCM 密文存储，旧版明文 Webhook 设置在首次读取时迁移；域名到期提醒天数策略 API/前端设置页已接入。到期提醒 cron 触发、20 小时去重、09:00 门槛与事件级渠道分发、证书签发/部署、CF 优选 IP、邮件/QQ 机器人与自托管执行器仍待移植 |
| Wave 5：前端 | 安装、登录、会话控制台、域名账户、域名列表（到期时间展示、单域名手动刷新、批量排队刷新及自动查询状态）、解析记录（含只读公网 DNS 生效检查）、到期提醒天数设置、定时任务及容灾概览/策略管理页面可用；其余旧模板对应模块仍待移植 |
| Wave 6：同步与最终交付 | 本地 PHP 差异扫描与 GitHub Actions `Verify` CI 可用；发布/回滚步骤已写入 `docs/guide/release.md`；定期上游同步与真实云回滚演练尚待完成 |

继续开发时按剩余模块推进证书签发/部署、CF 优选 IP、其余通知渠道与执行器；`src/dns/registry.ts` 的 `unportedProviders` 现为空数组，新增驱动时若有未实现项应登记到该列表并保持 `providerCatalog().unported` 与实际一致。`tests/fixtures/legacy-contracts.json` 是旧 PHP 契约基线，记录 149 条路由、141 个公开方法、101 处分派比较、51 个模板和 205 个模板调用；它**不代表 TypeScript 实现覆盖率**。`/domain/dnscheck` 缺少旧控制器方法，`huoshan` 证书实现未注册，已记录为基线诊断。

新界面仅显示真实运行环境与迁移状态，不伪造域名、证书或任务数据。域名账户、域名与解析记录直接调用服务商 API，凭据以 AES-GCM 加密存储（用途绑定账户 ID），写入前校验平台凭据；未知驱动类型返回 400，服务商不支持的操作显式报错，不会静默降级。未知 API、`/quicklogin`、`/cron` 不会被 SPA HTML 兜底吞掉。

### VitePress 文档站

文档站源码位于 `docs/`，使用 VitePress 构建为独立静态站，由 `.github/workflows/docs.yml` 自动构建并发布到 **GitHub Pages**，不部署到 Cloudflare。构建基路径固定为 `/`：站点根为 `https://docs.example.com/` 时页面资源请求 `https://docs.example.com/assets/...`，不会出现 `/dnsmgr/` 仓库路径。

因此 GitHub Pages 必须先绑定自定义域名（Settings → Pages → Custom domain）。工作流会在缺少自定义域名时直接失败，避免发布出 `/<repo>/assets/...` 这类坏链接。触发条件为推送到 `main` 且改动 `docs/`、`scripts/docs/` 或依赖清单，也可手动 `workflow_dispatch`。文档站产物不得写入 DNS 应用的 `dist/*/public`，两套站点互不覆盖。

```bash
npm run docs:dev
npm run docs:build
npm run docs:verify
npm run docs:preview
npm run docs:e2e
```

VitePress 配置使用 `vitepress/theme-without-fonts`，不请求默认 Google Fonts Inter；标题采用 Georgia / CJK serif 字族，正文优先本地 Aptos/中文字体，数据与代码使用等宽字族。静态产物生成在 `docs/.vitepress/dist/`。

### 本地开发与验证

开发、SQLite 测试和浏览器测试推荐 **Node.js 24**；Makers 构建配置使用其预装的 Node.js 22.11，构建工具版本已锁定并审计。先在项目根目录执行：

```bash
npm ci --ignore-scripts
npm run build:frontend
```

首次本地运行生成独立密钥文件，存在文件时命令拒绝覆盖；不要将它提交到 Git：

```bash
node -e "const fs=require('node:fs'),c=require('node:crypto');fs.writeFileSync('.env.local','APP_KEY='+c.randomBytes(32).toString('base64')+'\nSETUP_TOKEN='+c.randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});"
npm run dev
```

访问 `http://127.0.0.1:8787`，使用 `.env.local` 中的 `SETUP_TOKEN` 完成首次初始化并自行设置管理员密码。本地 SQLite 独立保存在 `runtime/serverless.sqlite`，不读取旧 MySQL。后续启动必须复用原 `APP_KEY`；丢失密钥会导致已有加密凭据不可读。热更新前端可另开终端执行 `npm run dev:frontend`，访问 `http://127.0.0.1:5173`；代理只重写这个明确的本地 Origin，不放行任意跨站请求。

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

`test:e2e` 使用本机 Chrome 和独立内存测试库，验证安装、登录、刷新恢复、375/768/1440 响应式导航、深链与退出；截图在 `test-results/`。没有安装 Chrome 时需先配置 Playwright 可用的浏览器。测试不会访问生产 DNS 或云端数据库。

### 三平台产物与配置边界

| 平台 | 入口 / 配置 | 静态资源目录 |
| --- | --- | --- |
| Cloudflare Workers | `dist/cloudflare/worker.mjs` / `wrangler.toml` | `dist/cloudflare/public` |
| EdgeOne Makers | `cloud-functions/index.js`、`cloud-functions/[[default]].js` 引用构建产物 `_worker.mjs` / `edgeone.json` | `dist/edgeone/public` |
| 阿里云 ESA | `dist/esa/worker.mjs` / `esa.jsonc`；`fetch(request, context, env)` 第三个参数读取变量 | `dist/esa/public` |

只托管新 `public` 产物，不上传旧 `public/`、PHP、SQL、配置或 Worker 文件作为静态资源。不配置全局 SPA fallback；页面 shell 由 Hono 在受控页面路径返回。Cloudflare Workers 已部署到 `dnsmgrui-work`（D1 `dnsmgrui-data`）；**尚未验证套餐 CPU 配额，Makers 与 ESA 仍未部署**。

应用支持 D1/Turso 协调 SQL。Cloudflare 需配置 `DB` D1 绑定并依次执行 `migrations/0001_core.sql`、`migrations/0002_dns.sql`、`migrations/0003_dns_aliases.sql`、`migrations/0004_schedule.sql`、`migrations/0005_failover.sql`；Makers/ESA 配置 `TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`，并在独立 SQLite/libSQL 库执行同样的迁移。D1 必须提供稳定的 `COORDINATOR_ID`，初始化后用于识别库身份；不要随意复用同一标识指向不同数据库。DNS 账户/域名/审计表目前只在 `DB_FORMAT=sql` 下可用，其他格式会明确返回 501。Cloudflare 对象模式的绑定名分别为 `KV` 与 `BUCKET`（R2），并设置相应稳定的 `PAYLOAD_STORE_ID`；ESA 的 EdgeKV 使用 `ESA_KV_NAMESPACE`。Makers Blob 设置 `BLOB_NAMESPACE`，Node Function 暂无 KV bridge。平台 secrets 至少包括 32 字节 Base64 `APP_KEY` 和不少于 32 字符的 `SETUP_TOKEN`；可设置 `PUBLIC_ORIGIN` 固定站点来源。不要把 Token、密码或主密钥放入 `VITE_*` 或前端代码。

存储契约为 `DB_DRIVER=d1|turso|kv|blob|auto` 与 `DB_FORMAT=sql|map|key`。`map` 整对象与 `key` 逐实体格式使用不可变快照/实体键，活动版本仅由 SQL 协调库 fencing + CAS 指针发布；所有数据读取均校验版本与 SHA-256 摘要。对象驱动还须提供稳定的 `PAYLOAD_STORE_ID`（ESA 默认使用 KV namespace 标识），Blob 命名空间可用 `BLOB_NAMESPACE` 指定。驱动、格式或任一存储标识变化都视为不同数据集；需要显式迁移工具，目前尚未提供。

平台适配现状与限制：

- Cloudflare：已接入 D1 协调、Workers KV 与 R2。R2 使用 `If-None-Match: *` 条件创建；KV 无 CAS 且跨 POP 最终一致，但每个对象使用随机版本 UUID + 内容哈希，并由 SQL pointer 决定可见版本。KV 短暂读不到已提交对象时会 fail closed，不返回空数据。
- EdgeOne Makers：Hono Node Cloud Function 可使用 SQL/Turso 与 `BLOB_NAMESPACE` Blob。Blob SDK 已锁定 `@edgeone/pages-blob@0.0.18`，该版本类型声明标明 `onlyIfNew` 已废弃且不保证防覆盖；适配器不依赖该参数，而用强一致读回校验、随机版本/哈希键和 SQL 指针。Makers 原生 KV 仅在 Edge Functions 可用，目前 Node Function 的受认证 KV bridge 尚未实现，故缺少 KV binding 时会 fail closed。
- 阿里云 ESA：已适配 EdgeKV `get/put` 到 `map/key`；SDK 返回未命中的 `undefined` 统一转换为缺失，单值超过文档的 1.8 MB 上限时在调用前拒绝。EdgeKV 最终一致，强一致性和上线后的全局传播尚未实测；可能短暂读到缺失对象时服务会报存储不可用，不会回退空数据。ESA 暂无 Blob adapter。

对象存储读写必须与 SQL 协调库同时可用。数据缺失、损坏、写后读回不一致或协调库不可用时停止操作，不会在内存或 SQL 自动降级。密码使用 bcrypt，账户凭据通过用途分离的 HKDF/AES-GCM 加密；会话、权限版本、一次性 TOTP 挑战和防重放计数均存 SQL。Cloudflare 免费套餐 CPU 配额尚未真实验证能否承载 bcrypt；ESA 每请求最多 4 次外部 fetch，Turso 和 KV/Blob 的协调操作共享请求预算，超限时拒绝本次操作，后续业务流程应按任务分步。所有适配仅通过本地 fake binding/标准 API 验证，**未连接真实云资源、未部署**。

### 上游契约差异检查

```bash
node scripts/compat/diff.mjs --php-root ../dnsmgr-upstream
```

参数必须指向已准备好的上游 PHP 源码；此命令只读比较，不拉取远程、不修改 TS 或基线。发现差异后先审核业务语义、移植并补测试，再显式运行 `npm run compat:generate` 更新基线。不得把未知 PHP 语法静默跳过或将自动差异检测当成自动跨语言合并。

本次执行边界：未修改参考仓库与旧 PHP。按用户要求创建了 Cloudflare D1 `dnsmgrui-data` 与 Worker `dnsmgrui-work` 并完成部署，执行了 `0001`/`0002` 迁移；未修改任何真实 DNS 解析，Makers 与 ESA 仍未部署。原 PHP Docker 工作流仍只用于原 PHP 版本。

### VitePress 文档站

文档源文件位于 `docs/`，通过 VitePress 构建为独立静态站点。`docs/.vitepress/config.mts` 固定 `base: '/'`：若网站部署在 `https://example.com/`，资源 URL 是 `https://example.com/assets/...`，不会附加 `/dnsmgr/`。将 `docs/.vitepress/dist/` 中的**内容**发布到独立文档域名的站点根目录；若托管地址只能使用 GitHub 项目子路径，须先配置自定义域名/根站点才能满足该路径要求。

构建和预览：

```bash
npm run docs:dev
npm run docs:build
npm run docs:verify
npm run docs:preview
npm run docs:e2e
```

生产产物位于 `docs/.vitepress/dist/`。站点配置固定 `base: '/'`，因此部署到域名根目录时页面静态资源 URL 为 `https://<域名>/assets/...`，页面路由为 `https://<域名>/guide/...`；不是仓库名子路径下的 `/dnsmgr/assets/...`。部署时将 `docs/.vitepress/dist/` **目录内容**发布到目标站点 Web 根目录。该构建目录不会并入 Cloudflare／Makers／ESA 的 DNS 管理应用产物；若共享一个域名，须由部署层将文档站指定为根站点，DNS 管理应用另行放在独立域名/路由，不能假设两者会自动共存。

根路径部署约束来自 [VitePress 官方 `base` 配置说明](https://vitepress.dev/reference/site-config#base)：仅当站点部署在子路径时才添加 base 前缀，本项目要求根路径，故保持 `/`。

## 原 PHP 版本部署方式

### 自部署

可以使用宝塔、Kangle等任意支持PHP-MySQL的环境部署

* 从[Release](https://github.com/netcccyun/dnsmgr/releases)页面下载安装包

* 运行环境要求PHP8.0+，MySQL5.6+

* 设置网站运行目录为`public`

* 设置伪静态为`ThinkPHP`

* 如果是下载的Source code包，还需Composer安装依赖（Release页面下载的安装包不需要）

  ```
  composer install --no-dev
  ```

* 访问网站，会自动跳转到安装页面，根据提示安装完成

* 访问首页登录控制面板

* 后续更新方式：重新下载安装包上传覆盖即可

##### 伪静态规则

* Nginx

```
location ~* (runtime|application)/ {
    return 403;
}
location / {
    if (!-e $request_filename) {
        rewrite ^(.*)$ /index.php?s=$1 last; break;
    }
}
```

* Apache

```
<IfModule mod_rewrite.c>
  Options +FollowSymlinks -Multiviews
  RewriteEngine On

  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteRule ^(.*)$ index.php/$1 [QSA,PT,L]
</IfModule>
```

### Docker 部署

首先需要安装Docker，然后执行以下命令拉取镜像并启动（启动后监听8081端口）：

```
docker run --name dnsmgr -dit -p 8081:80 -v /var/dnsmgr:/app/www netcccyun/dnsmgr
```

访问并安装好后如果容灾切换未自动启动，重启容器即可：

```
docker restart dnsmgr
```

从国内镜像地址拉取：

```
docker pull swr.cn-east-3.myhuaweicloud.com/netcccyun/dnsmgr:latest
```

### docker-compose 部署

```
services:
  dnsmgr-web:
    container_name: dnsmgr-web
    stdin_open: true
    tty: true
    ports:
      - 8081:80
    volumes:
      - ./web:/app/www
    image: netcccyun/dnsmgr
    depends_on:
      - dnsmgr-mysql
    networks:
      - dnsmgr-network

  dnsmgr-mysql:
    container_name: dnsmgr-mysql
    restart: always
    ports:
      - 3306:3306
    volumes:
      - ./mysql/conf/my.cnf:/etc/mysql/my.cnf
      - ./mysql/logs:/logs
      - ./mysql/data:/var/lib/mysql
    environment:
      - MYSQL_ROOT_PASSWORD=123456
      - TZ=Asia/Shanghai
    image: mysql:5.7
    networks:
      - dnsmgr-network

networks:
  dnsmgr-network:
    driver: bridge
```

在运行之前请创建好目录

```
mkdir -p ./web
mkdir -p ./mysql/conf
mkdir -p ./mysql/logs
mkdir -p ./mysql/data

vim mysql/conf/my.cnf
[mysqld]
sql_mode=STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION
```

登陆mysql容器创建数据库

```
docker exec -it dnsmgr-mysql /bin/bash
mysql -uroot -p123456
create database dnsmgr;
```

在install界面链接IP填写dnsmgr-mysql

## 演示截图

添加域名账户

![](https://p0.meituan.net/csc/090508cdc7aaabd185ba9c76a8c099f9283946.png)

域名管理列表

![](https://p0.meituan.net/csc/60bf3f607d40f30f152ad1f6ee3be098357839.png)

域名DNS解析管理，支持解析批量操作

![](https://p0.meituan.net/csc/f99c599d4febced404c88672dd50d62c212895.png)

用户管理添加用户，支持为用户开启API接口

![](https://p0.meituan.net/csc/d1bd90bedca9b6cbc5da40286bdb5cd5228438.png)

CF优选IP功能，添加优选IP任务

![](https://p1.meituan.net/csc/da70c76753aee4bce044d16fadd56e5f217660.png)

SSL证书申请功能

![](https://blog.cccyun.cn/content/uploadfile/202412/QQ%E6%88%AA%E5%9B%BE20241221154857.png)

![](https://blog.cccyun.cn/content/uploadfile/202412/QQ%E6%88%AA%E5%9B%BE20241221154652.png?a)

SSL证书自动部署功能

![](https://blog.cccyun.cn/content/uploadfile/202412/QQ%E6%88%AA%E5%9B%BE20241221154702.png)

![](https://blog.cccyun.cn/content/uploadfile/202412/QQ%E6%88%AA%E5%9B%BE20241221154804.png)

## 支持与反馈

🌐 作者信息：消失的彩虹海(https://blog.cccyun.cn)

⭐ 如果您觉得本项目对您有帮助，欢迎给项目点个 Star

🤝 捐赠：

<img height="240" src="https://wkphoto.bj.bcebos.com/d8f9d72a6059252db065f556249b033b5bb5b976.jpg">

### 其他推荐

- [彩虹云主机 - 免备案CDN/虚拟主机](https://www.cccyun.net/)
- [小白云高防云服务器](https://www.xiaobaiyun.cn/aff/GMLPMFOV)

