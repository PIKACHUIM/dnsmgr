# 迁移状态与旧版兼容

旧 PHP 源码暂留仓库原位置用于追踪上游差异。契约清单由 `scripts/compat/scan.mjs` 静态扫描，不会执行 PHP，也不会将未实现的 TypeScript 模块标为完成。

## 已盘点的旧版范围

`tests/fixtures/legacy-contracts.json` 记录当前检查到的基线：

| 范围 | 数量 | 含义 |
| --- | ---: | --- |
| 路由声明 | 149 | 含 public、登录中间件和签名 API route group |
| 控制器公开方法 | 141 | 用于路由目标完整性与分派追踪 |
| `action` / `act` 分派比较 | 101 | 静态提取的操作分支，不等价于全部运行时路径 |
| 模板 | 51 | 50 个 HTML 与 1 个 TPL 文件 |
| 模板调用点 | 205 | 仅扫描可静态识别的模板调用 |
| PHP 契约源文件 | 220 | 扫描纳入的 app、route、config 源 |

该清单是待实现工作量和差异基线，不是功能测试，也不代表迁移覆盖百分比。

## 当前状态

- **Wave 1**：三平台入口、Hono 公共核心、基础构建与契约扫描完成。
- **Wave 2**：SQL/协调租约、`map`/`key` 不可变存储、单键 CAS、基本分页、安装/登录/会话、CSRF、TOTP 和平台对象适配已实现。Makers Node KV bridge、恢复与对象回收、显式格式迁移、快捷登录仍待实现。
- **Wave 3**：22 个 DNS 驱动全部迁移（Cloudflare、阿里云、DNSPod、EdgeOne、阿里云 ESA、Route53、百度云、华为云、火山引擎、京东云、青云、NameSilo、Spaceship、西部数码、宝塔、DNSLA、DNSMGR、dynv6、GoEdge、HE.net、PowerDNS、Technitium），账户、域名、解析记录 CRUD/启停/备注、支持类型的只读公网 DNS 检查（固定 AliDNS DoH 端点、限流、不改写 DNS 记录）、域名分类、域名/记录批量操作、兼容旧签名 API 的只读域名列表（`POST /api/domain`）、本地操作日志与厂商日志（阿里云/DNSPod）、Cloudflare 自定义主机名/Fallback Origin/DCV 委派与 Tunnel（公网主机名自动 CNAME、CIDR/主机名路由）可用。驱动与 Cloudflare 扩展仅通过本地构造请求单测，尚未用真实服务商凭据冒烟；显性/隐性 URL 转发类型已接入阿里云、DNSPod、京东云、DNSLA 与 Cloudflare（URI）；DNSPod 域名别名与本地镜像表已接入；域名到期状态可通过 IANA RDAP 引导进行单域名手动刷新，按域名权限和 CSRF 保护，失败时保留旧到期时间。
旧签名 `POST /api/domain` 只读域名列表保留 `{total, rows}` 与旧字段名，并使用当前 `permissions` 表的本地域名 ID 授权；TS 尚无注册时间或旧 SSO 开关字段，因此 `regtime` 返回 `null`、`is_sso` 返回 `0`，这两个字段排序退回按 ID 排序。分页上限为 `limit=100`、`offset=1,000,000`。只读 `POST /api/domain/:id` 返回旧域名字段、`config` 的安全静态子集（`type`、`name`、`alias`）、服务商解析线路和最小 TTL；非管理员按当前权限表授权，不存在或无权访问统一返回 404。`loginurl=1` 会返回 `501 LEGACY_QUICKLOGIN_UNSUPPORTED`，不会签发或写入快捷登录令牌。ESA + Turso 下，GoEdge 与火山引擎读取完整线路将超过每请求 4 次 fetch 上限，详情接口明确返回 `501 LEGACY_DETAIL_BUDGET_UNSUPPORTED`，不会返回不完整线路。旧签名记录读写和证书私钥接口仍未迁移。
- **Wave 4**：定时解析切换（一次性/每天/每周/每月，启用/暂停/删除/改值）与 `/cron?key=` 入口已迁移，设置存于 `app_settings` 与 `dns_schedule_tasks`；`/cron` 每次最多执行一次域名到期 RDAP 查询，优先处理首次查询/手动批量队列，再按 -5 至 +30 天窗口、至少间隔 24 小时复查已有到期记录；执行索引见 `migrations/0006_domain_expiration_queue.sql` 与 `migrations/0007_domain_periodic_expiration_queue.sql`。无 RDAP 查询工作时，到期提醒按配置时区 09:00 门槛按剩余天数分组发送，每组最多 10 个域名，域名级 20 小时冷却；消息发往已配置且启用的新 TS 通知渠道（缺省全部启用，可逐渠道开关），发送失败仍计入冷却，索引见 `migrations/0008_domain_expiration_notices.sql`。基于公网 HTTP(S) 健康检查的 DNS 主备容灾切换已接入，策略与日志存于 `dns_failover_tasks` / `dns_failover_logs`（`migrations/0005_failover.sql`）。自定义 Webhook、WxPusher、Telegram、企业微信群机器人、钉钉与飞书群机器人支持测试发送，并用于定时任务失败和容灾切换/恢复通知；通知凭据以 AES-GCM 加密存储，旧版明文 Webhook 设置在首次读取时迁移。证书签发/部署、CF 优选 IP、邮件/QQ 机器人和自托管执行器尚未迁移。
- **Wave 5**：登录（兼容旧 `/verifycode` 与 `code` 字段；`vcode=1/2` 对应管理员 `/system/loginset` 开关，迁移默认启用）、基础状态控制台、本人修改密码页面（复用 `POST /setpwd`；用户由当前会话确定、要求 CSRF、成功后撤销旧会话，确认密码只在前端校验）、本人 TOTP 管理页面（启用、二维码/手动密钥绑定、关闭；登录与会话状态只暴露 `totpEnabled` 布尔值；经会话、CSRF 和当前密码校验的 `POST /totp/generate` 在绑定时返回密钥和 URI；绑定使用 180 秒一次性 challenge，关闭要求当前密码与有效动态口令，成功后撤销旧会话；绑定/关闭结果未知时锁定重复操作并要求刷新核对）、域名账户、域名列表（展示、单条手动刷新与批量排队刷新到期时间，并显示自动查询状态）、解析记录（含只读公网 DNS 检查、单域名 Excel 预览导入和逐行写入结果）、定时任务及容灾概览/策略管理页面可用；到期提醒天数及逐渠道设置页和 cron 提醒发送/去重已迁移。旧版不要求二次验证的直接重置及遗失认证器恢复流程、其余旧模板对应模块仍待迁移。
- **Wave 6**：显式上游 PHP 差异扫描与 GitHub Actions `Verify` CI 可用，发布与回滚步骤见[发布与回滚](./release)；定期上游同步和真实云回滚演练尚待完善。

旧 route 中 `/domain/dnscheck` 指向的方法在旧控制器中不存在，`huoshan` 证书 PHP 实现文件不在常规注册清单中。这些均为静态基线诊断，不应被当成新实现的需求完成项。

## 重跑基线与上游差异扫描

在仓库根目录：

```bash
npm run test:compat
```

扫描器默认只读重新扫描当前 PHP 文件并与 `tests/fixtures/legacy-contracts.json` 比较。仅在人工审查并接受基线变化后才更新 fixture：

```bash
npm run compat:generate
```

若已有只读检出的上游 PHP 仓库，可显式比较，不会拉取远程、覆盖源码或自动移植代码：

```bash
node scripts/compat/diff.mjs --php-root ../dnsmgr-upstream
```

跨语言行为仍须先人工审核，再编写 TypeScript 契约测试。路由数相符、provider 文件已登记或前端保留原 URL，都不能代替真实业务实现。

## API 兼容策略

旧公开 API 的 POST 表单 `uid/timestamp/sign`、MD5 签名与 ±300 秒时窗在新认证 middleware 中保留校验；授权后业务 endpoint 仍须按模块迁移。未知 API 返回 JSON 404。认证页面、`/quicklogin`、`/cron`、QQ Bot webhook 等不能由通用 SPA fallback 抢答。

迁移完成前不应让新 Hono 版本接管生产 DNS；也不可让旧版 cron 和新版本 scheduler 同时控制同一条 DNS 记录。
