# 项目概览

DnsMgr 原版是 ThinkPHP + PHP + MySQL 的 DNS 管理系统。当前仓库正在迁移为 TypeScript + Hono + React 的 Serverless 项目；旧 PHP 源码留在原位置，作为行为和上游差异的对照基线。

> 当前新应用仍处于基础阶段，尚不能替代旧版接管生产 DNS。文档描述的是仓库现有实现，不代表已在 Cloudflare、EdgeOne 或 ESA 线上部署验证。

## 目标平台与边界

| 平台 | Web/API 入口 | 协调数据库 | 对象存储 |
| --- | --- | --- | --- |
| Cloudflare Workers | `src/platform/cloudflare.ts` | D1 | Workers KV / R2 |
| EdgeOne Makers | Node Cloud Function | Turso/libSQL | Makers Blob；Node Function 尚无原生 KV bridge |
| 阿里云 ESA | Edge Routine `fetch(request, context, env)` | Turso/libSQL | EdgeKV |

Hono 公共核心负责请求路由、认证和业务服务。DNS 驱动、域名分类、批量操作、操作日志、支持类型的只读公网 DNS 生效检查、单域名手动 RDAP 到期时间刷新与 `/cron` 首次自动查询、定时解析切换、自定义 Webhook、WxPusher、Telegram、企业微信群机器人、钉钉、飞书群机器人、邮件与 QQ 机器人通知已实现；HTTP(S) 健康检查驱动的 DNS 主备容灾切换也已接入。通知凭据使用 AES-GCM 加密，旧版明文 Webhook 设置会在首次读取时迁移。证书模块支持手动 RSA PEM 导入、加密存储和管理员 PFX 导出，并已接入多 CA 的 ACME 账户、DNS-01 分步签发、自动续签、CNAME 代理、自动部署与执行器；CF 优选 IP、用户管理、代理设置和在线更新只读检查也已接入。旧版解析记录批量接口与页面入口继续兼容。

## 当前能力

已完成本地实现与测试的基础包括：

- 首次安装授权、管理员可开关的图形验证码登录、bcrypt 密码哈希、服务端 Cookie 会话、CSRF 校验及 TOTP 防重放；本人修改密码页面复用 `POST /setpwd`，只修改当前会话用户，成功后撤销旧会话并要求重新登录。本人 TOTP 管理页支持启用、二维码/手动密钥绑定和关闭；登录及会话状态只返回 `totpEnabled` 布尔值，受会话、CSRF 与当前密码保护的 `POST /totp/generate` 在设备绑定时才返回密钥/URI；绑定使用一次性 challenge，bind/close 成功后撤销旧会话；遗失认证器可由运维通过 `POST /auth/totp/reset`（`X-Setup-Token` 授权）重置并撤销旧会话，管理员也可在用户管理中解绑。
- D1 和 Turso SQL 适配、版本迁移、协调租约和 fencing。
- `map` 快照与 `key` 不可变实体、单键 CAS 写/删与分页索引；活动版本由 SQL 指针发布。
- Cloudflare KV/R2、EdgeOne Blob、ESA EdgeKV 与 Makers Node Function 的受认证 KV bridge 客户端适配；快照版本可经管理员接口导出、导入、回滚与回收。平台适配测试使用本地替身，尚未连接真实云资源。
- DNS 账户、域名同步与解析记录 CRUD、旧签名 API 域名列表（`POST /api/domain`），提供单域名 Excel 首表预览导入和逐行写入结果，使用仓库内 SheetJS 0.20.3 parser；支持类型的只读公网 DNS 生效检查；域名到期支持单条手动刷新、管理员批量排队及 `/cron` 周期复查（-5 至 +30 天窗口、至少间隔 24 小时、每次最多一个查询）；管理员可配置到期提醒天数及逐渠道到期提醒开关，`/cron` 在无 RDAP 查询工作时于配置时区 09:00 后按天分组发送，最多 10 个域名一组，域名级 20 小时冷却，发送到已配置且启用的新 TS 通知渠道（缺省全部启用，可逐渠道开关）；22 个服务商驱动已全部实现（Cloudflare、阿里云、DNSPod、EdgeOne、阿里云 ESA、Route53、百度云、华为云、火山引擎、京东云、青云、NameSilo、Spaceship、西部数码、宝塔、DNSLA、DNSMGR、dynv6、GoEdge、HE.net、PowerDNS、Technitium）；凭据 AES-GCM 加密，写操作审计入库。旧签名域名详情、记录读取/备注/更新/启停/删除、一次性快捷登录（`GET /quicklogin`）以及批量添加/修改、服务商日志、权重、分组、按记录值搜索与智能添加页面均已迁移。驱动目前仅有本地请求构造单测，未经真实凭据冒烟。
- 证书订单支持手动 RSA PEM 导入与旧接口兼容的 PFX 导出；ACME 账户密钥、订单 CSR 私钥与证书材料均以 AES-GCM 用途绑定加密。ACME 支持 ZeroSSL、Google、LiteSSL 与自定义 Directory（含 EAB），DNS-01 可使用 Cloudflare 或订单绑定的已同步 DNS 账户，CNAME 代理要求所有域名最终落到同一 Zone；自动续签由 `/cron` 每次推进一步，证书更新后可经 Webhook 或自托管执行器自动部署，执行器使用独立 Bearer 令牌并回报运行结果。证书失败、部署失败与续签失败进入通知 outbox，可按主题开关通过邮件或 QQ 机器人投递。订单或 TXT 创建、删除结果未知时返回 `503 ACME_OUTCOME_UNKNOWN` 并要求先核对，不自动重试非幂等调用。生产 CA 注册需要管理员显式确认，staging 为默认环境。
- 系统设置包含用户管理（CRUD、域名权限、API Key 轮换、最后管理员保护）、执行器代理配置（凭据加密并随任务下发）与在线更新只读检查（应用版本、`d1_migrations`/`PRAGMA user_version` 与待执行迁移）；在线更新不会自动执行迁移。旧签名 `POST /api/record/add/:id` 与 `POST /api/record/batch/:id` 已开放，批量操作限制 1–100 条并返回成功/失败计数。
- 旧 PHP 路由、控制器分派、提供方注册与模板调用清单。

仍待完善：上游定期同步 CI。通知、部署、执行器与 ACME 目前仅有本地模拟测试，尚未使用真实邮件、QQ 机器人、CA、执行器或服务商凭据冒烟。容灾当前仅支持公网 HTTP(S) 健康检查与 DNS 主备值切换，不包含 ICMP/TCP 探测。

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
