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
- **Wave 2**：SQL/协调租约、`map`/`key` 不可变存储、单键 CAS、基本分页、安装/登录/会话、CSRF、TOTP、旧签名快捷登录、遗失认证器的 `SETUP_TOKEN` 重置、快照导出/导入/回滚/回收和平台对象适配已实现；Makers Node Function 通过受认证 HTTPS bridge 访问原生 KV。
- **Wave 3**：22 个 DNS 驱动全部迁移（Cloudflare、阿里云、DNSPod、EdgeOne、阿里云 ESA、Route53、百度云、华为云、火山引擎、京东云、青云、NameSilo、Spaceship、西部数码、宝塔、DNSLA、DNSMGR、dynv6、GoEdge、HE.net、PowerDNS、Technitium），账户、域名、解析记录 CRUD/启停/备注、支持类型的只读公网 DNS 检查（固定 AliDNS DoH 端点、限流、不改写 DNS 记录）、域名分类、域名/记录批量操作、兼容旧签名 API 的只读域名列表（`POST /api/domain`）、本地操作日志与厂商日志（阿里云/DNSPod）、Cloudflare 自定义主机名/Fallback Origin/DCV 委派与 Tunnel（公网主机名自动 CNAME、CIDR/主机名路由）可用。驱动与 Cloudflare 扩展仅通过本地构造请求单测，尚未用真实服务商凭据冒烟；显性/隐性 URL 转发类型已接入阿里云、DNSPod、京东云、DNSLA 与 Cloudflare（URI）；DNSPod 域名别名与本地镜像表已接入；域名到期状态可通过 IANA RDAP 引导进行单域名手动刷新，按域名权限和 CSRF 保护，失败时保留旧到期时间。
旧签名 `POST /api/domain` 只读域名列表保留 `{total, rows}` 与旧字段名，并使用当前 `permissions` 表的本地域名 ID 授权；TS 尚无注册时间或旧 SSO 开关字段，因此 `regtime` 返回 `null`、`is_sso` 返回 `0`，这两个字段排序退回按 ID 排序。分页上限为 `limit=100`、`offset=1,000,000`。只读 `POST /api/domain/:id` 返回旧域名字段、`config` 的安全静态子集（`type`、`name`、`alias`）、服务商解析线路和最小 TTL；非管理员按当前权限表授权，不存在或无权访问统一返回 404。`loginurl=1` 会生成一次性快捷登录链接并写入 `quick_tokens`（仅保存 SHA-256 哈希，300 秒有效）；`GET /quicklogin` 校验参数格式、±300 秒时间窗、`md5(APP_KEY+domain+timestamp+token+APP_KEY)` 签名和域名权限后消费令牌并建立会话，重复使用、签名不符或过期分别返回 401/403/400。ESA + Turso 下，GoEdge 读取完整线路需要 1 次 AccessToken 请求加 5 次线路请求，超过每请求 4 次 fetch 上限，详情接口明确返回 `501 LEGACY_DETAIL_BUDGET_UNSUPPORTED`，不会返回不完整线路；火山引擎只需 3 次 fetch（域名信息、内置线路、自定义线路），ESA 下同样返回完整线路。只读 `POST /api/record/data/:id` 复用旧签名认证和当前域名 ID 权限，缺失或无权访问返回 `{total:0,rows:[]}`，成功时输出 `{total, rows}` 与大小写旧记录字段；`LineName` 缺少线路目录时回退为线路 ID。`limit` 为 1–100，`offset` 不超过 1,000,000 且必须为 `limit` 的整数倍；`limit=0` 返回 400。旧白名单排序字段（`Name`/`Type`/`LineName`/`Value`/`UpdateTime`）会先按 provider 分页收集最多 2000 条（ESA 为 300 条）再本地排序分页，未知排序字段返回 400；旧版客户端分页 provider（AWS、百度云、HE.net、NameSilo、PowerDNS、Technitium）改为返回裸数组。过滤语义沿用各 TS provider；Cloudflare 在 `status=0` 时直接返回空结果，其余 provider 透传 `status`。青云未指定 `subdomain` 时按旧版页面语义返回主机组摘要行（`RecordId` 为完整主机名，`Type`/`Value`/`Line`/`TTL` 为 `null`，并带 `Count`），单次 fetch 完成分页，排序与类型/线路/状态过滤按旧版驱动配置忽略；指定 `subdomain` 时读取该主机明细，兼容相对名与旧客户端回传的完整主机名。旧签名 `POST /api/record/remark/:id` 复用各 provider 的备注能力设置或清除单条备注并写入本地审计；权限检查与签名认证按当前权限表执行。若 provider 调用或后续审计结果不确定，返回 `503 DNS_WRITE_OUTCOME_UNKNOWN`，不会自动重试，客户端应先核对服务商当前备注。旧签名 `POST /api/record/delete/:id` 复用各 provider 的删除能力并写入审计；超时或审计未确认时返回 `503 DNS_WRITE_OUTCOME_UNKNOWN`，不自动重试。旧签名 `POST /api/record/update/:id` 复用各 provider 的更新能力，旧版 MX 缺省值保留为 `1`，旧签名更新的空备注会清除 provider 备注（Cloudflare 为 comment；现有 session API 的更新行为不变）；更新按 TS provider 语义启用记录并写入审计，不使用客户端 `recordinfo` 判断真实旧值。更新或审计状态不确定时同样返回 `DNS_WRITE_OUTCOME_UNKNOWN`，不自动重试。旧签名 `POST /api/record/status/:id` 复用各 provider 的启停能力，`status=0/1` 分别暂停/启用；身份、存储身份、域名账户和权限在同一 SQL 查询中校验，再执行状态切换与审计，Cloudflare 路径为 GET+PATCH，ESA+Turso 成功路径共 4 fetch。状态写入或审计结果不确定时不自动重试。旧签名 `POST /api/record/add/:id` 已开放给 API 管理员和可写权限用户：请求字段沿用旧版 `name/type/value/line/ttl/mx/weight/remark`，缺省 TTL 600、MX 1、权重 0，经统一 provider 写入并落审计，成功返回 `{code:0,msg,id}`。旧签名不绑定路径/请求体且没有 nonce，仍存在重放与请求体替换风险，因此没有额外放宽权限模型；写结果或审计不确定时返回 `503 DNS_WRITE_OUTCOME_UNKNOWN`，不自动重试。旧签名 `POST /api/record/batch/:id` 支持 `open`、`pause`、`delete`、`remark`、`group`，`recordinfo` 接受 JSON 数组并限制 1–100 条，逐条执行并返回 `{success,failed}`；`group` 复用 provider 分组能力，阿里云调用 `ChangeRecordGroup`（`RecordIdList` 为 JSON 数组），DNSPod 调用 `ModifyRecordToGroup`（`RecordId` 以 `|` 连接，空分组编号映射为 `0`），其他服务商返回 `501 DNS_GROUP_UNSUPPORTED`，不做静默成功。批量操作可能部分成功，响应中的成功/失败计数即为最终结果，不提供跨记录事务。旧签名 `POST /api/cert/order` 已按旧响应字段开放给 API 管理员：从 TS 证书订单读取 `id/crt/key/pfx/issuetime/expiretime/domains`，PFX 为 Base64 PKCS#12，兼容密码为 `123456`；该路由沿用旧签名，签名不绑定请求路径/请求体且没有 nonce，因此仍只允许管理员访问；每次成功导出先写 `cert.order.export` 审计，审计只记录操作者和订单编号，不含证书、私钥、PFX 或密文。当前只支持经管理员导入、RSA 至少 2048 位且证书/私钥匹配的 PEM；材料以 AES-GCM 用途绑定加密，列表只返回元数据，导出响应 `no-store`。证书业务仅支持 `DB_FORMAT=sql`；TS 与旧 PHP 数据库独立，不会自动读取或迁移已有 PHP 订单。CA 账户与 ACME 单订单 DNS-01 签发已支持 staging/production（生产需显式确认），challenge 仅支持已同步的 Cloudflare Zone；自动续签、部署与非 Cloudflare challenge 仍待后续迁移。解析记录的新增、修改、删除、启停、备注、批量修改（类型/记录值/线路）、分组与权重写入均已迁移；旧签名接口仍不绑定路径/请求体且无 nonce，写入结果不确定时统一返回 `DNS_WRITE_OUTCOME_UNKNOWN`。
- **Wave 4**：定时解析切换（一次性/每天/每周/每月，启用/暂停/删除/改值）与 `/cron?key=` 入口已迁移，设置存于 `app_settings` 与 `dns_schedule_tasks`；`/cron` 每次最多执行一次域名到期 RDAP 查询，优先处理首次查询/手动批量队列，再按 -5 至 +30 天窗口、至少间隔 24 小时复查已有到期记录；执行索引见 `migrations/0006_domain_expiration_queue.sql` 与 `migrations/0007_domain_periodic_expiration_queue.sql`。无 RDAP 查询工作时，到期提醒按配置时区 09:00 门槛按剩余天数分组发送，每组最多 10 个域名，域名级 20 小时冷却；消息发往已配置且启用的新 TS 通知渠道（缺省全部启用，可逐渠道开关），发送失败仍计入冷却，索引见 `migrations/0008_domain_expiration_notices.sql`。基于公网 HTTP(S) 健康检查的 DNS 主备容灾切换已接入，策略与日志存于 `dns_failover_tasks` / `dns_failover_logs`（`migrations/0005_failover.sql`）。自定义 Webhook、WxPusher、Telegram、企业微信群机器人、钉钉与飞书群机器人支持测试发送，并用于定时任务失败和容灾切换/恢复通知；通知凭据以 AES-GCM 加密存储，旧版明文 Webhook 设置在首次读取时迁移。证书模块已接入手动 RSA PEM 导入、AES-GCM 加密存储、管理员列表/PFX 下载及旧签名导出；ACME 账户（staging/production、显式生产确认）、DNS-01（已同步的 Cloudflare Zone）分步签发与结果未知核对已接入，见 `migrations/0011_certificate_acme.sql`。证书自动续签、证书部署、非 Cloudflare challenge provider、CF 优选 IP、邮件/QQ 机器人和自托管执行器由 Wave 7 补齐。
- **Wave 5**：登录（兼容旧 `/verifycode` 与 `code` 字段；`vcode=1/2` 对应管理员 `/system/loginset` 开关，迁移默认启用）、基础状态控制台、本人修改密码页面（复用 `POST /setpwd`；用户由当前会话确定、要求 CSRF、成功后撤销旧会话，确认密码只在前端校验）、本人 TOTP 管理页面（启用、二维码/手动密钥绑定、关闭；登录与会话状态只暴露 `totpEnabled` 布尔值；经会话、CSRF 和当前密码校验的 `POST /totp/generate` 在绑定时返回密钥和 URI；绑定使用 180 秒一次性 challenge，关闭要求当前密码与有效动态口令，成功后撤销旧会话；绑定/关闭结果未知时锁定重复操作并要求刷新核对）、域名账户、域名列表（展示、单条手动刷新与批量排队刷新到期时间，并显示自动查询状态）、解析记录（含只读公网 DNS 检查、单域名 Excel 预览导入和逐行写入结果）、定时任务及容灾概览/策略管理页面可用；到期提醒天数及逐渠道设置页和 cron 提醒发送/去重已迁移。遗失认证器可由运维调用 `POST /auth/totp/reset`（`X-Setup-Token` 授权）清除动态口令、递增权限版本并撤销该用户全部会话，管理员也可在用户管理中解绑动态口令；旧版批量添加、批量修改、服务商日志、权重配置、记录分组、按记录值搜索与智能批量添加均已提供独立页面：`/record/batchadd/:id` 按行提交并展示逐行结果，`/record/batchedit/:id` 勾选记录后批量修改类型/记录值或线路（`POST /api/v1/dns/domains/:id/records/batch-edit`），`/record/log/:id` 分页读取服务商日志，`/record/weight/:id` 管理阿里云 SLB 权重开关与权重值，`/record/groups/:id` 管理阿里云/DNSPod 记录分组，`/record/search` 跨域名按记录值搜索并批量修改/删除，`/record/smartparse` 解析多域名输入并按域名批量添加；不支持相应能力的服务商在页面上明确提示，接口返回 `501`。
- **Wave 6**：显式上游 PHP 差异扫描与 GitHub Actions `Verify` CI 可用，发布与回滚步骤见[发布与回滚](./release)；定期上游同步和真实云回滚演练尚待完善。
- **Wave 7**：证书自动续签（复用 ACME 分步函数，cron 每次推进一步，TXT 创建 60 秒后再触发）、多 CA（ZeroSSL、Google、LiteSSL 与自定义 ACME Directory，支持 EAB）、订单/账户记录 CA 与失败通知、非 Cloudflare DNS-01（订单绑定已同步 DNS 账户与 provider）、CNAME 代理（`cert_cname_proxies`，要求最终落到同一 Zone）、证书部署（Webhook 与自托管执行器、运行记录与令牌轮换）、CF 优选 IP（wetest/hostmonitor/xingpingcn 线路，单次最多 5 次写操作）、邮件（Cloudflare `send_email` 绑定）与 QQ 机器人（Ed25519 验签、C2C OpenID 绑定）、通知 outbox 与 `/api/v1/system/notify/flush`、用户管理（CRUD、域名权限、API Key 轮换、最后管理员保护）、代理设置（执行器下发，凭据加密）与在线更新只读检查（应用版本、`d1_migrations`/`PRAGMA user_version` 与待执行迁移，不自动执行迁移）已接入。解析记录侧同时补齐 provider 分组能力（阿里云 `DescribeRecordGroups`/`ChangeRecordGroup`、DNSPod `DescribeRecordGroupList`/`ModifyRecordToGroup`）、阿里云 SLB 权重（`DescribeDNSSLBSubDomains`/`SetDNSSLBStatus`/`UpdateDNSSLBWeight`）与批量修改类型/记录值/线路接口，能力按 provider 可选实现，不支持时返回 501。相关迁移见 `0012`–`0017`；生产 CA 仍需显式确认，真实服务商与执行器冒烟尚未执行。

旧 route 中 `/domain/dnscheck` 指向的方法在旧控制器中不存在，`huoshan` 证书 PHP 实现文件不在常规注册清单中。这些均为静态基线诊断，不应被当成新实现的需求完成项。

## 旧版页面功能与当前实现的差异

按 `route/app.php`、`app/controller/*.php` 与 `src/routes/*.ts` 逐项对照，旧版页面与运维工具的当前状态如下（已迁移项注明等价范围，未迁移项标注原因；均不影响 DNS、证书、通知主链路）：

| 旧版功能 | 旧入口 | 当前状态 |
| --- | --- | --- |
| 在线自动更新 | `POST /system/doupdate` | 只做版本与迁移检查（`POST /api/v1/system/update/check`）；Worker 无法自我替换，升级改为重新部署 |
| 运行时缓存清理 | `GET /cleancache` | 不适用：没有 PHP runtime 缓存目录，数据在 D1 / KV |
| 服务端皮肤切换 | `POST /changeskin` | 已迁移为「站点默认皮肤」：管理员在主题菜单选「设为站点默认」，写入 `app_settings.default_skin`（`PUT /api/v1/system/skin`，审计 `system.skin`）；没有本地选择的浏览器读取 `GET /api/v1/preferences/skin` 后应用。个人切换仍存 `localStorage`（等价旧版非管理员 cookie） |
| 代理连通性测试 | `POST /system/proxytest` | 部分等价：`POST /api/v1/system/proxy/test` 校验代理地址格式并探测代理端口是否应答（HTTP/HTTPS）。Worker 运行时无法用代理发起出站请求，因此不验证出口 IP 与代理账号；SOCKS5 只校验配置，返回 `reachable: null` |
| 逐渠道通知测试 | `/system/mailtest`、`/system/tgbottest`、`/system/webhooktest`、`/system/customwebhooktest` | `POST /api/v1/system/notify/test` 支持 `channel`（`webhook`/`wxpusher`/`telegram`/`wecom`/`dingtalk`/`feishu`/`mail`/`qqbot`）单渠道发送；省略时发往全部已配置渠道。未配置的渠道返回 400 `NOTIFICATION_NOT_CONFIGURED`，未知渠道返回 400 `INVALID_NOTIFICATION_CHANNEL` |
| 分用途通知渠道开关 | `cert_notice_*`、`notice_*`、`expire_notice_*` | 已迁移：证书与部署通知用 `GET|PUT /api/v1/system/cert-notice`（`0` 关闭 / `1` 开启 / `2` 仅失败时），容灾切换通知用 `GET|PUT /api/v1/system/failover-notice`（开关两态），到期提醒沿用 `expire_notice_channels`；设置入口分别在证书设置弹窗与容灾概览页「通知渠道」。所有渠道关闭时，证书通知直接标记 `DISABLED`，不无限重试 |
| 自定义 Webhook 内容格式 | `custom_webhook_content_format` | 已迁移：`GET|PUT /api/v1/system/notify` 读写 `html` / `markdown` / `text`（缺省 `text`），发送前按旧版规则把 `<b>` 转 `**`、`<br/>` 转换行并去除标签；请求头同时接受旧版每行 `Key: Value` 与 JSON 对象；GET 按请求体模板展开查询参数，模板 JSON 无效时回退 `title`/`content` |
| Telegram 代理/反代 | `tgbot_proxy`、`tgbot_url` | 部分等价：Worker 无法使用系统代理，`tgbot_proxy=1` 不适用；自定义反代地址已迁移为 `telegramApiBase`（设置键 `tgbot_url`，`GET|PUT /api/v1/system/notify`），留空使用 `https://api.telegram.org`，保存前校验 http/https |
| 群机器人通用 Webhook | `webhook_url`、`webhook_user` | 已迁移为独立渠道：企业微信、钉钉、飞书分别保存 URL 与 @ 目标。首次读取旧设置时按域名自动拆分（钉钉/飞书同时迁移 `webhook_user`），随后删除旧键；旧版单一入口不再保留 |
| 容灾检测协议 | `checktype` 0/1/2（ping / TCP / HTTP） | 部分等价：HTTP(S) 健康检查（`checktype=2`）全平台可用，按状态码 2xx/3xx 判定并支持超时、失败阈值与主备切换；TCP 端口探测（`checktype=1`）在 Cloudflare 平台通过 `cloudflare:sockets` 提供，其他运行时创建 TCP 任务返回 400 `TCP_PROBE_UNSUPPORTED`；ICMP（`checktype=0`）不可用 |
| 邮件发送通道 | `mail_type`、SMTP / Sendcloud / 阿里云邮件推送 | 平台差异：Worker 没有原始 TCP，改用 Cloudflare Email `send_email` 绑定；收件人与已验证发件地址在 `GET|PUT /api/v1/system/notify` 配置，未绑定发信服务时拒绝启用 |
| 证书部署时间窗 | `deploy_hour_start`、`deploy_hour_end` | 已迁移：`GET|PUT /api/v1/system/certificate-renew` 读写 0–23 时，cron 按 `schedule_tz_offset` 换算本地小时，仅窗口内执行自动部署，跨天按环绕处理（如 22–6），起止相同表示只允许该小时；管理员手动「立即检查一次」与单任务运行不受窗口限制。非法小时返回 400 `INVALID_CERT_RENEW_SETTINGS` |
| 云厂商免费证书 | CertHelper 的 `tencent`、`aliyun`、`ucloud` | 未迁移：这些渠道依赖云厂商证书 API、账号授权与免费额度。当前统一走 ACME（Let's Encrypt、ZeroSSL、Google、LiteSSL、自定义 ACME），减少多套账号与签名模型；已有证书仍可手动导入并部署 |
| 证书部署目标 | DeployHelper 内置 50+ 服务商（宝塔、Kangle、S3、SSH、FTP、云厂商 CDN 等） | 平台差异：Worker 没有 SSH/FTP/系统命令，改为 Webhook 推送与自托管执行器领取任务；执行器运行在目标服务器上，可调用本地工具完成实际部署。部署账户、任务、运行记录与时间窗已迁移，旧版逐个服务商驱动不移植 |
| 优选数据源积分查询 | `POST /optimizeip/queryapi` | 已迁移为 `POST /api/v1/optimize/credit`（管理员 + CSRF，审计 `optimize.credit`）：wetest.vip 与 hostmonit 返回剩余次数；xingpingcn.top 无密钥免费源返回 400 `OPTIMIZE_CREDIT_NOT_APPLICABLE`。优选设置弹窗提供「查询积分」按钮 |
| 容灾日志按天清理 | `POST /dmonitor/clean` | 已迁移为 `POST /api/v1/failover/logs/clean`（`days` 0–3650，审计 `failover.clean`），容灾概览页「清理日志」弹窗；写入时仍保留每任务最近 500 条 |
| 外部状态探针 | `/dmtask/status`、`/optimizeip/status` | 已迁移，返回纯文本 `ok`/`error`：容灾按启用任务的 `last_check_at` 与 `2×间隔+60s` 判定，优选按启用任务的 `last_run_at` 与 3600 秒判定 |
| 旧调试页 | `GET /test` | 未迁移（旧实现为空方法） |

另有几类旧端点属于页面内部 AJAX 辅助，已被新接口取代、无需单独移植：`/domain/list` 与 `/domain/data` → `GET /api/v1/dns/domains`，`/domain/updatedate` 与 `/domain/setcategory` → `POST /api/v1/dns/domains/batch` / `PATCH /api/v1/dns/domains/:id`，`/record/list` → `GET /api/v1/dns/domains/:id/records?name=`，`/record/quickinfo/:id` → `GET /api/v1/dns/domains/:id/lines`，`/record/check/:id` → `POST /api/v1/dns/domains/:id/records/check`，`/user/data` → `GET /api/v1/users`，`/log/data` → `GET /api/v1/dns/logs`。`/domain/dnscheck` 旧版即无实现，属于死路由。

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
