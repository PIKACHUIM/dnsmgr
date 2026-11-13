# 控制台前端开发说明

本文面向接手 `frontend/` 的开发者，说明当前控制台的目录结构、主题与语言机制、导航与布局规范、弹窗约定、已知边界和验证流程。文中的「边界」是刻意保留的取舍，不是遗漏；改动前请先确认是否要突破这些边界，以及需要同步修改哪些测试。

> 对应交付：本轮补齐旧版运维工具、站点默认皮肤与证书部署时间窗（提交 `2759584` 及后续）；再前几轮分别是业务页多语言（`6ff5cc7`）、四套主题与浏览器默认跟随（`09a3967`）、域名管理分组与解析管理（`7e3a023`）。

## 本轮交付摘要（旧版运维工具与站点默认皮肤）

| 需求 | 实现 | 主要文件 |
| --- | --- | --- |
| 站点默认皮肤 | 管理员在主题菜单点「设为站点默认」，写入 `app_settings.default_skin`；没有本地 `dnsmgr-skin` 的浏览器读取 `GET /api/v1/preferences/skin` 后应用，选择过皮肤的用户仍以本地值为准 | `ThemeMenu`、`preferences.tsx`、`Console.tsx` |
| 分用途通知渠道 | 证书设置弹窗内按渠道选择「关闭 / 开启 / 仅失败时」，容灾概览页「通知渠道」弹窗控制切换/恢复通知；全部关闭时通知标记 `DISABLED` | `CertificateSettings.tsx`、`DnsFailover.tsx`、`src/notify/channels.ts` |
| 证书部署时间窗 | 证书设置弹窗新增「部署时间窗」两个下拉（0–23 时），保存到 `deploy_hour_start`/`deploy_hour_end`；cron 只在该时段自动部署，手动运行不受限 | `CertificateSettings.tsx`、`src/routes/schedule.ts`、`src/deploy.ts` |
| 容灾 TCP 探测 | 新建策略可选 HTTP(S) 健康检查或 TCP 端口；TCP 目标由主机与端口组成，留空主机时使用主线路值；Cloudflare 平台通过 `cloudflare:sockets` 连接，其他运行时由 API 返回 400 `TCP_PROBE_UNSUPPORTED` | `DnsFailover.tsx`、`src/net/tcp.ts`、`src/schedule/failover.ts`、`src/platform/cloudflare.ts` |
| 运维工具入口 | 通知设置增加单渠道测试下拉、内容格式选择（HTML/Markdown/纯文本，请求头兼容行式写法）与 Telegram 反代地址；优选设置增加「查询积分」；容灾概览增加「清理日志」；代理设置增加「测试连通性」 | `NotifySettings.tsx`、`OptimizeIp.tsx`、`DnsFailover.tsx`、`ProxySettings.tsx` |

验证：typecheck、build:frontend、`npm test`、`npm run test:e2e`、`docs:build`/`docs:verify` 均通过（见提交说明）。

## 上一轮交付摘要（域名页多语言）

| 需求 | 实现 | 主要文件 |
| --- | --- | --- |
| 域名管理页 | 表格、筛选、批量操作、添加域名弹窗与全部提示改为 `t(...)`；到期日期按当前语言的 BCP 47 标签格式化，不再固定 `zh-CN` | `DnsDomains.tsx` |
| 域名分类面板 | 列表、重命名/删除确认、新建分类弹窗全部接入词典 | `DnsCategories.tsx` |
| 域名账户补充 | 同步与删除提示、未移植驱动说明、会话失效提示 | `DnsAccounts.tsx` |
| 词典守护 | 新增 `tests/locales.test.ts`，校验 10 份词典的键集合与 `{占位符}` 完全一致 | `tests/locales.test.ts`、`locales/*` |

验证：typecheck、build:frontend、`npm test` 24 个文件 350 条、`npm run test:e2e` 3 条、`docs:build`/`docs:verify` 均通过；10 份词典各 350 条 key。

## 再上一轮交付摘要（主题与浏览器默认）

| 需求 | 实现 | 主要文件 |
| --- | --- | --- |
| 四套主题 | `classic`（经典蓝）、`tech`（科技深空）、`elegant`（素雅暖砂）、`aurora`（极光幻紫），每套各有亮暗两组 token；顶栏调色板菜单切换 | `preferences.tsx`、`styles.css` |
| 跟随浏览器默认 | 无保存值时明暗取 `prefers-color-scheme` 并监听变化；语言取 `navigator.languages`，匹配不到用英文 | `preferences.tsx` |
| 主题控件 | 新增 `palette` 图标与 `ThemeMenu`（`role="menuitemradio"`），控制台顶栏与登录页都可用 | `icons.tsx`、`Console.tsx`、`Auth.tsx` |

验证：typecheck、build:frontend、`npm test` 330 条、`npm run test:e2e` 3 条、`docs:build`/`docs:verify` 均通过。

## 上一轮交付摘要（导航合并）

| 需求 | 实现 | 主要文件 |
| --- | --- | --- |
| 续签设置并入证书订单 | 「续签设置」移出导航，改为证书订单页标题右侧按钮 + `Modal`；`CertificateSettings` 增加可选 `onSaved`，保存后关闭弹窗并提示 | `CertificateOrders.tsx`、`CertificateSettings.tsx` |
| 证书代理并入证书账户 | 「证书代理」移出导航，`CertificateCname` 渲染在 ACME 账户面板下方，面板标题改为「CNAME 代理」 | `CertificateOrders.tsx`、`CertificateCname.tsx` |
| 域名管理分组 | 合并「工作空间」与「域名配置」为「域名管理」：系统概览、域名账号、域名管理、解析管理；域名分类并入域名账号页 | `navigation.ts`、`DnsAccounts.tsx` |
| 解析管理 | 新增 `/record`：顶部先选域名，再复用 `DnsRecords`（`embedded` 隐藏「返回域名列表」） | `DnsRecords.tsx`、`Console.tsx` |
| 侧边栏收窄 | `--sidebar-width` 216→196px，移动端抽屉 248→232px；长标签用省略号截断 | `styles.css` |
| 移除迁移状态 | 首页删除「功能迁移状态」面板与相关样式，只保留 `/api/v1/bootstrap` 能力位校验 | `Console.tsx`、`styles.css` |

旧路径 `/domain/category`、`/cert/cname`、`/cert/certset` 继续可访问，由 `mergedPaths` 映射到新页面。交付时验证：typecheck、build:frontend、`npm test` 330 条、`npm run test:e2e` 2 条、`docs:build`/`docs:verify` 均通过。

## 更早交付摘要（弹窗化与多语言）

这一轮前端改动来自四条明确需求：所有新增/编辑表单改成弹窗、同类信息（启用策略/备用线路/最近错误）保持一行、操作日志并入系统设置并把改密/退出收进头像菜单、语言扩到繁体中文与八种外语。落到代码上包括：

| 需求 | 实现 | 主要文件 |
| --- | --- | --- |
| 表单弹窗化 | 新增通用 `Modal` 调用约定，域名、记录、分类、别名、SaaS、Tunnel、定时任务、容灾策略、证书账户/订单/部署、优选任务、记录分组全部改为「面板标题右侧按钮 + 弹窗」 | `Modal.tsx` 与各业务页 |
| 说明收进图标 | 新增 `InfoTip`：悬停/聚焦显示提示，点击展开面板；页面正文不再保留解释段落 | `InfoTip.tsx`、`styles.css` |
| 头像菜单 | 顶栏右侧改为主题 / 语言 / 头像三件套，`Menu` 承载「修改密码」与「退出登录」 | `Menu.tsx`、`Console.tsx` |
| 导航合并 | 删除「审计账户」与「优选管理」分组：操作日志并入「系统设置」，优选设置改成优选任务页的按钮弹窗、优选任务并入「容灾调度」；`/setpwd` 只由头像菜单进入 | `navigation.ts`、`OptimizeIp.tsx` |
| 指标单行 | 指标块改为 `.metric-row`（标签 + 数值同一行、`nowrap`），避免「当前备用线路」之类被拆行 | `styles.css`、`DnsFailover.tsx` |
| 多语言 | 语言从 zh/en 扩到 `zh-Hans`、`zh-Hant`、`en`、`ja`、`ko`、`fr`、`de`、`it`、`es`、`pt`、`ru`，词条拆到 `locales/*.ts` | `preferences.tsx`、`locales/*` |

同时补充了图标（`info` / `alert` / `key`），并同步更新了 e2e（弹窗触发器、头像菜单、语言下拉、导航改名）。

交付验证（在本仓库执行）：`npm run typecheck` 通过；`npm run build:frontend` 成功；`npm test` 23 个文件 330 条通过；`npm run test:e2e` 2 条通过。本轮未部署，未跑 `build:cloudflare`。

涉及的是纯前端资源与导航文案，没有新增 D1 迁移，回滚只需回退提交后重新部署，数据库无需处理。

## 1. 构建与运行

```bash
npm ci --ignore-scripts
npm run build:frontend      # 产物在 dist/frontend
npm run dev                 # 本地 Hono + SQLite，默认 127.0.0.1:8787
npm run dev:frontend        # Vite 热更新，127.0.0.1:5173，代理到 8787
```

前端没有使用路由库、组件库或 CSS 框架：`react` + `react-dom` + 一份手写 `styles.css`，图标是内联 SVG。新增依赖前请先评估体积与离线可用性。

## 2. 文件职责

| 文件 | 职责 |
| --- | --- |
| `main.tsx` | 应用状态机（`loading` / `error` / `install` / `login` / `session`）、`PreferencesProvider` 挂载、`document.title` |
| `Auth.tsx` | 初始化、登录、TOTP 第二步、图形验证码、登录页主题/语言控件 |
| `Console.tsx` | 控制台外壳（侧边栏、顶栏、页脚）、首页面板、按 `canonicalPath(path)` 分发业务组件 |
| `navigation.ts` | 导航数据（分组、标签、说明、能力位）、`mergedPaths` / `canonicalPath()` 旧路径映射与 `resolvePage()` 动态页解析 |
| `SystemPages.tsx` | 系统设置的三个聚合页，只做组件组合 |
| `preferences.tsx` | 主题/语言 Context、语言清单、`ThemeToggle` / `LanguageToggle` |
| `locales/*.ts` | 各语言词条表，中文原文为 key；`en.ts` 与另外 9 份词典键一一对应 |
| `Modal.tsx` | 可访问弹窗（焦点锁定、Esc、遮罩、滚动锁定） |
| `Menu.tsx` | 通用下拉菜单（`role="menu"`、Esc/外部点击关闭、打开时聚焦首项） |
| `InfoTip.tsx` | 说明图标：悬停/聚焦提示、点击展开面板 |
| `icons.tsx` | 图标名到 SVG path 的映射、`Brand` 品牌块 |
| `styles.css` | 全部样式：设计 token、组件、响应式、暗色主题 |
| `api.ts` | `request` / `send` / `post`、`ApiError`、`readSession`、统一错误文案 |
| 其余 `*.tsx` | 各业务页面，均接收 `session` / `navigate` / `onExpired` 等属性 |

## 3. 运行时结构

### 3.1 状态机与渲染

`main.tsx` 的 `App` 先请求 `/api/v1/install/status`，再尝试 `/api/v1/session`：

- 未安装 → 渲染 `Auth` 的 `install` 模式，并把地址替换为 `/install`；
- 未登录（401）→ 渲染 `Auth` 的 `login` 模式，必要时替换为 `/login`；
- 已登录 → 渲染 `Console`。

没有 React Router。当前路径由 `window.location.pathname` 保存在 `path` 状态中，`navigate()` 用 `history.pushState` 更新并滚动到顶部，`popstate` 监听浏览器前进/后退。侧边栏与页面内链接都走 `followLink()`：按住 Ctrl/Cmd/Shift/Alt 或中键时不拦截，交给浏览器新开标签页。

### 3.2 页面分发

`Console.tsx` 用一条从具体到宽泛的三元链决定渲染哪个组件，例如：

```tsx
: path === '/account' && level === 2 ? <DnsAccounts ... />
: path === '/domain' ? <DnsDomains ... />
: ...
: recordMatch ? <DnsRecords domainId={Number(recordMatch[1])} ... />
: <未移植占位面板 />
```

**新增页面必须同时改三处**：`navigation.ts`（菜单与标题）、`Console.tsx`（分发分支）与 `src/app.ts` 的 `pagePatterns`（服务端 SPA 白名单）。只加组件不会出现在界面上；漏改白名单时页面能点开，但直接访问或刷新同一个 URL 会返回 `{"code":-1,"msg":"该路径尚未实现或不存在","reason":"NOT_FOUND"}`。管理员专属页面要带 `level === 2` 判断，否则普通用户可以直达 URL。

分发链使用 `canonicalPath(path)` 而不是原始 `path`：旧地址先映射到合并后的聚合页，再决定渲染哪个组件（见 §6.4）。

### 3.3 页面元信息

`resolvePage(path, level)` 返回 `{ item, group }`，`item` 含 `label`、`scope`、`capability`、`implemented`。动态页（如 `/record/123`）没有独立菜单项，由正则匹配生成标题与说明；匹配不到时返回「未知页面」，用于占位面板。

`item.implemented !== true` 时侧边栏显示「待移植」角标。当前所有菜单项均已实现，但该字段仍被外壳读取，新增页面请显式写 `implemented: true`。

### 3.4 请求与安全约束

所有写请求走 `api.ts` 的 `send()`，必须带 `X-CSRF-Token: session.csrfToken`；CSRF token 只存在内存，不写 `localStorage` 或 `sessionStorage`。401 统一交给 `onExpired()`，由上层切回登录页。**不要在组件里直接用 `fetch`**，登录/验证码图片是唯一例外（`Auth.tsx` 读取 SVG 响应）。

## 4. 主题（明暗 × 四套皮肤）

### 4.1 机制

`PreferencesProvider` 在挂载后把明暗与皮肤分别写到根元素：

```ts
document.documentElement.dataset.theme = theme;   // 'light' | 'dark'
document.documentElement.dataset.skin = skin;      // 'classic' | 'tech' | 'elegant' | 'aurora'
document.documentElement.style.colorScheme = theme;
```

CSS 分四层覆盖，组件只引用 token：

| 选择器 | 作用 |
| --- | --- |
| `:root` | `classic` 亮色（默认 token） |
| `:root[data-theme='dark']` | `classic` 暗色 |
| `:root[data-skin='tech'\|'elegant'\|'aurora']` | 该皮肤亮色 |
| `:root[data-skin='…'][data-theme='dark']` | 该皮肤暗色（特异性最高） |

默认值与跟随规则：

- 没有 `dnsmgr-theme` 时按 `prefers-color-scheme` 取明暗，并监听 `matchMedia('(prefers-color-scheme: dark)')` 实时跟随；点击顶栏太阳/月亮后写入 `dnsmgr-theme`，从此以用户选择为准。
- 皮肤存 `dnsmgr-skin`，缺省 `classic`；登录页与控制台顶栏都能切换。管理员可在主题菜单点「设为站点默认」写入服务端默认皮肤，只有本地没有 `dnsmgr-skin` 的浏览器会读取 `GET /api/v1/preferences/skin` 并应用；点过任何一套皮肤后即以本地值为准。
- 顶栏顺序：明暗切换 → 主题菜单（调色板图标，`role="menuitemradio"`，每项带渐变色板）→ 语言 → 头像菜单。

### 4.2 新增或调整颜色

每套皮肤都要写两组完整 token（亮色块 + `[data-theme='dark']` 块），漏写的 token 会回落到 `classic` 的值。常用 token：

| token | 用途 |
| --- | --- |
| `--color-bg` / `--color-surface` | 页面底色 / 卡片底色 |
| `--color-text` / `--color-muted` | 主文字 / 次要文字 |
| `--color-subtle` / `--color-border` / `--color-control-border` | 浅底块 / 分隔线 / 表单控件边框 |
| `--color-accent` / `--color-accent-hover` / `--color-accent-soft` | 主色与浅底 |
| `--color-sidebar*` | 侧边栏（亮暗两套均为深色，暗色更深） |
| `--color-success` / `--color-warning` / `--color-error*` | 状态色 |
| `--color-backdrop` / `--shadow-*` / `--color-focus` | 遮罩、阴影、焦点环 |
| `--app-ambient` / `--app-sidebar-image` | 页面光晕 / 侧边栏渐变，`classic` 为 `none` |

暗色下主按钮使用 `--color-accent` 作底色、`--color-surface` 作文字色，新增按钮样式请沿用这一组合，避免硬编码 `#fff`。皮肤可以加极低透明度的 `radial-gradient` 光晕，但不要引入布局尺寸变化。

### 4.3 已知边界

- **首屏可能闪一下默认皮肤与亮色**。明暗与皮肤都在 React 挂载后的 effect 里写入，默认 CSS 是 `classic` 亮色，已保存暗色或其它皮肤的用户在首帧会看到默认外观。彻底修复需要在 `frontend/index.html` 的 `<head>` 内加一段同步脚本，在首屏渲染前读取 `dnsmgr-theme` / `dnsmgr-skin`；当前未做。
- **手动切换后不再跟随系统**。这是有意行为：只有从未点过明暗按钮时才监听 `prefers-color-scheme`；清掉 `localStorage` 的 `dnsmgr-theme` 可恢复跟随。
- **明暗与语言不随账号同步**。偏好仅存本机 `localStorage`（键前缀 `dnsmgr-`），换设备或换浏览器需要重新选择。
- **站点默认皮肤只在本地无选择时生效**。`GET /api/v1/preferences/skin` 是唯一公开的无鉴权 JSON，只返回皮肤名；管理员改默认皮肤不会覆盖已在本机选过皮肤的用户。
- **`<meta name="theme-color">` 固定为 `#182230`**（`frontend/index.html`），移动端浏览器地址栏颜色不会随主题变化。

### 4.4 刻意不随主题的部分

- TOTP 二维码容器 `.totp-qr` 固定浅底深码（`--color-qr-*` 局部变量），因为多数扫码器在深底反色下识别率差。
- 侧边栏在亮色下也是深色导航，暗色只是进一步压深，这是有意的视觉分层。

## 5. 多语言（11 个语言选项）

### 5.1 机制

中文原文就是词条 key，其它语言查词典：

```ts
t('证书订单')                  // zh-Hans: '证书订单'，en: 'Orders'，ja: '証明書オーダー'
t('已保留「{label}」的导航入口…', { label: t(page.item.label) })
```

- 语言清单 `LANGUAGES` 定义在 `preferences.tsx`，顺序即下拉菜单顺序：简体中文、繁體中文、English、日本語、한국어、Français、Deutsch、Italiano、Español、Português、Русский。
- 简体中文直接返回 key；其它语言查 `DICTIONARIES`，查不到时回退 key，因此**漏翻不会报错，也不会显示 undefined**。
- 支持 `{name}` 占位符替换，用于把变量安全插进句子。
- `document.documentElement.lang` 按语言写成 `zh-CN`、`zh-TW`、`en`、`ja` 等 BCP 47 标签；用户手动选择后写入 `localStorage` 的 `dnsmgr-language`，未选择时不落盘、每次按浏览器默认检测。
- 没有保存值时按浏览器默认：依次检查 `navigator.languages` 与 `navigator.language`，`zh` / `zh-CN` / `zh-SG` / `zh-Hans*` 取简体，其它 `zh-*` 取繁体，`en/ja/ko/fr/de/it/es/pt/ru` 取主标签；**都匹配不上时用英文**。
- 旧版本只存过 `zh` / `en`，读取时把 `zh` 映射到 `zh-Hans`；保存值不是受支持的语言时重新按浏览器默认检测。
- 词条全部在 `frontend/src/locales/`：`en.ts`、`zh-Hant.ts`、`ja.ts`、`ko.ts`、`fr.ts`、`de.ts`、`it.ts`、`es.ts`、`pt.ts`、`ru.ts`。新增 key 必须同时补齐 10 份词典，键顺序与 `en.ts` 一致；`tests/locales.test.ts` 会校验键集合与 `{占位符}`，漏补或漏写占位符都会让 `npm test` 失败。

### 5.2 新增文案的两种写法

1. 固定文案：JSX 里直接写 `{t('中文原文')}`，再在 10 份词典里各补一条。
2. 动态文案（服务端返回或模板字符串）：服务端文案不要直接当 key 用；需要拼接时先翻译片段再拼接，例如登录过期提示 `setError(`${errorMessage(failure)} ${t('本次验证请求已失效，请重新输入密码登录。')}`)`。

`Auth.tsx` 里存在 `{t(error)}` 的写法：错误状态存中文原文，渲染时尝试翻译。这样做的好处是切换语言时已有错误也能跟着变；风险是如果服务端返回的文案恰好等于某个词条 key，会被误翻。当前没有冲突，新增词条时注意避免与常见服务端错误文案重名。

### 5.3 覆盖范围边界

已接入词典：

- 控制台外壳：顶栏、侧边栏分组与菜单、页面标题与提示、状态角标、页脚、未移植占位面板；
- 首页运行环境 / 当前会话两块面板（原「功能迁移状态」面板已移除，能力位只用于校验 `/api/v1/bootstrap` 响应）；
- 登录、初始化、TOTP、图形验证码整页；
- DNS 账户页（含服务商凭据字段标签、可选后缀）；
- 域名管理页整页：域名列表、搜索与筛选、批量操作、添加域名弹窗、到期时间（含「待刷新」「查询中」状态与本地化日期），以及域名账号页内的分类面板；
- 头像菜单、主题菜单、语言菜单、弹窗关闭按钮等公共控件。

**仍为中文**：

- 其余业务页正文、表头、按钮与提示（解析记录、证书、通知、用户管理、日志等）；
- 服务端返回的所有消息（`errorMessage()` 直接展示后端中文），以及服务商名称、部分服务商字段值；
- 浏览器标签标题 `document.title`（`main.tsx` 仍拼中文）；
- 品牌块 `Brand`（「聚合 DNS」/「管理系统 / CONTROL」）保持中文。

这是有意的分阶段交付：先保证外壳与登录链路完整可用，避免出现「菜单日文、页面半中半日」的错位感。继续扩展时按页面整体翻译，不要逐句零散补。

### 5.4 关于本地存储的硬约束

`tests/e2e/foundation.spec.ts` 会断言 `localStorage` 的所有键都以 `dnsmgr-` 开头。新增偏好可以继续用该前缀，但**不得**把用户名、会话、CSRF token、服务商凭据写进浏览器存储。

## 6. 侧边栏规范：统一四个汉字

### 6.1 规则

分组名与菜单项名一律四个汉字，便于在 196px 侧边栏（`--sidebar-width`）内对齐且不换行。长度检查方式：

```bash
grep -oP "label: '[^']*'" frontend/src/navigation.ts | sort -u
```

当前分组：域名管理、容灾调度、证书管理、系统设置。原「工作空间」与「域名配置」已合并为「域名管理」，菜单依次为 系统概览（`/`）、域名账号（`/account`）、域名管理（`/domain`）、解析管理（`/record`）；「域名分类」并入域名账号页。「证书管理」分组只保留 证书账户 / 证书订单 / 部署账户 / 部署任务：CNAME 代理并入证书账户页，续签设置改成证书订单页的按钮弹窗。原「审计账户」分组已删除，「操作日志」并入「系统设置」；「修改密码」不再出现在菜单里，只由右上角头像菜单进入（`/setpwd` 仍可直接访问，标题由 `resolvePage()` 特殊分支给出）。原「优选管理」分组也已删除：「优选设置」变成「优选任务」页标题右侧的按钮弹窗，「优选任务」并入「容灾调度」，旧路径 `/optimizeip/opipset` 由 `mergedPaths` 映射到 `/optimizeip/opiplist`（地址栏不改写，页面直接渲染合并页）。菜单项与旧名对照：

| 旧名 | 新名 |
| --- | --- |
| 工作空间 / 域名配置（分组） | 域名管理（分组） |
| 自动部署账户 / 自动部署任务 | 部署账户 / 部署任务 |
| CNAME 代理 / 自动续签设置 | 并入证书账户 / 证书订单页 |
| 域名分类 | 并入域名账号页 |
| 任务管理（优选） | 优选任务 |
| 到期提醒设置 / 通知设置 / 定时设置 | 任务通知 |
| 批量添加解析 / 批量修改解析 | 批量添加 / 批量修改 |
| 按记录值搜索 / 智能批量添加 | 记录搜索 / 智能添加 |
| 服务商操作日志 / 解析记录分组 | 服务日志 / 记录分组 |
| 导入解析记录 | 导入记录 |
| Cloudflare 自定义主机名 / Cloudflare Tunnels | 自定义域 / 隧道管理 |
| 未移植页面 | 未知页面 |

路由路径除「系统设置」「域名管理」「证书管理」里的合并项外未改，旧书签和外部链接仍然有效：`/domain/category`→`/account`、`/cert/cname`→`/cert/certaccount`、`/cert/certset`→`/cert/certorder`，均只映射渲染、不改写地址栏（见 §6.4、§6.5）。

### 6.2 改名会牵动的测试

`tests/e2e/foundation.spec.ts` 用链接名和一级标题定位页面。改名后必须同步：

- 链接定位：`getByRole('link', { name: '证书订单' })`；
- 一级标题：`getByRole('heading', { level: 1, name: '批量添加' })`——标题来自 `navigation.ts` 的 `label`，不是组件内部 `<h2>`；
- 头像菜单：`getByRole('button', { name: '账户菜单' })` 打开后，用 `getByRole('menuitem', { name: '修改密码' | '退出登录' })` 点击。

一级标题旁的 `InfoTip` 必须放在 `<h1>` 之外（`.page-title` 容器），否则标题的可访问名会变成「标题 + 页面说明」，`exact: true` 的断言会全部失败。

英文模式下的断言同理（如 `name: 'Orders'`）；语言切换改为下拉菜单，断言写成 `getByRole('menuitemradio', { name: 'English' })`。

### 6.3 宽度与折叠

- 宽度只有一个来源：`:root { --sidebar-width: 196px }`，`.sidebar` 与 `.workspace` 都引用它；移动端抽屉单独写 232px，改宽度时两处都要看。菜单文字超出时由 `.nav-group a > span:first-child` 省略号截断，不要靠加宽侧边栏解决。
- 顶栏左侧的 `.sidebar-toggle` 切换折叠，图标为 `panel` / `panel-expand`，`aria-expanded` 与 `aria-controls="workspace-navigation"` 同步，`aria-label` 用「收起侧边栏」/「展开侧边栏」。
- 状态存在 `localStorage` 的 `dnsmgr-sidebar`（值为 `collapsed` / `expanded`），`initialCollapsed()` 在首次渲染时读取；没有值时默认展开。
- 折叠样式只在 `@media (min-width: 901px)` 内生效：

```css
.console-layout.sidebar-collapsed .sidebar { visibility: hidden; transform: translateX(-100%); }
.console-layout.sidebar-collapsed .workspace { margin-left: 0; }
```

- `≤900px` 仍是原抽屉：`.menu-button` 打开、遮罩或关闭按钮收起，折叠按钮在该断点 `display: none`，折叠类不影响移动端。
- 折叠后的 `<aside>` 带 `inert`，内部链接退出 Tab 序与可访问性树；展开后移除。移动端抽屉打开时反过来给 `.workspace` 加 `inert`。

```tsx
<aside id="workspace-navigation" className="sidebar" ref={navRef}
  role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen ? true : undefined}
  aria-label={t('功能导航')} inert={!mobileOpen && collapsed}>
```

**改折叠行为要同步的断言**：`tests/e2e/foundation.spec.ts` 用按钮名「收起侧边栏」/「展开侧边栏」定位，断言 `.sidebar` 隐藏、`.workspace` 的 `margin-left` 为 `0px`，并 `reload` 验证持久化。

### 6.4 系统设置合并

「系统设置」从 7 个页面合并成 3 个聚合页。`SystemPages.tsx` 只做组合，不复制设置组件的内部逻辑：

| 入口 | 组合的组件 | 兼容的旧路径 |
| --- | --- | --- |
| `/system/account` 登录账户 | `LoginCaptchaSettings` + `Users` | `/system/loginset`、`/user` |
| `/system/tasks` 任务通知 | `CronSettings` + `NotifySettings` + `ExpirationNoticeSettings` | `/system/cronset`、`/system/noticeset`、`/domain/expirenotice` |
| `/system/maintenance` 系统维护 | `ProxySettings` + `SystemUpdate` | `/system/proxyset`、`/system/update` |
| `/log` 操作日志 | `DnsLogs`（原「审计账户」分组内，现归入系统设置，非管理员也可见） | — |

映射写在 `navigation.ts` 的 `mergedPaths`，由 `canonicalPath()` 查表，`resolvePage()` 与 `Console.tsx` 都先映射再匹配：

```ts
export function canonicalPath(path: string): string {
  return mergedPaths[path] ?? path;
}
```

旧 URL 会渲染新聚合页、标题也显示新菜单名，但**地址栏不会改写**（仍停留在旧路径）。合并的副作用是单页变长，移动端滚动距离增加；`CronSettings` 的 crontab 命令是 `<pre>`，靠 `.panel pre { max-width: 100%; overflow-x: auto }` 在块内滚动，不会撑破页面宽度——e2e 在 375px 断言的 `scrollWidth <= innerWidth` 正是为了让这类长代码块不把整页顶宽。

**合并或改名时同时要改**：`navigation` 与 `mergedPaths`、`Console.tsx` 的分发分支、`src/app.ts` 的 `pagePatterns`（旧路径要留在白名单，否则直连 404）。另外「Telegram」这类短标签在合并页里可能与「清除 Telegram 凭据」按钮重名，e2e 需用 `section[aria-labelledby="expiration-notice-title"]` 限定作用域。

### 6.5 域名管理与解析管理

「域名管理」分组的前三个页面沿用原入口，新增的 `/record` 是「解析管理」：

```ts
// navigation.ts
{ path: '/record', label: '解析管理', scope: '选择域名后管理解析记录', capability: 'dns', implemented: true },
```

- `RecordExplorer`（`DnsRecords.tsx` 尾部导出）先用 `GET /api/v1/dns/domains?page=1&pageSize=200` 取域名，顶部 `.tool-field` 里的 `<select aria-label="选择域名">` 选定后才挂载 `<DnsRecords key={domainId} … embedded />`；未选域名时只显示空面板，不会发记录请求。
- `embedded` 只隐藏「返回域名列表」按钮，记录列表、弹窗与批量操作和 `/record/:id` 是同一套实现；`key={domainId}` 让切换域名时重置分页、筛选与勾选。
- `/record/:id` 深链仍可用，一级标题仍是「解析记录」（由 `resolvePage()` 正则给出）；域名列表里的域名链接与「解析记录」按钮继续深链到该路径。
- `/record` 已加入 `src/app.ts` 的 `pagePatterns`，直连与刷新不会返回 404。
- 域名账号页（`/account`）在账户面板下直接渲染 `<DnsCategories />`；旧入口 `/domain/category` 由 `mergedPaths` 映射过来，一级标题显示「域名账号」。
- 证书账户页（`/cert/certaccount`）在 ACME 账户面板下渲染 `<CertificateCname />`（标题「CNAME 代理」）；证书订单页标题右侧的「续签设置」按钮打开 `<CertificateSettings onSaved>` 弹窗，保存成功后关闭弹窗并显示页面提示。该弹窗同时承载分用途通知渠道与「部署时间窗」（0–23 时，跨天环绕），手动运行部署不受时间窗限制。

## 7. 间距与栅格

### 7.1 一套变量控制栅格

`--panel-gutter` 在 `:root` 为 24px，`≤1200px` 为 20px，`≤650px` 为 16px。所有面板统一：

```css
.panel { padding: 0 var(--panel-gutter) var(--panel-gutter); }
.panel-heading { margin: 0 calc(var(--panel-gutter) * -1); padding: 17px var(--panel-gutter); }
.panel > .panel-footnote:last-child { margin-bottom: calc(var(--panel-gutter) * -1); }
```

含义：面板留出左右内边距，标题用负外边距回贴到边框，分隔线才能通栏；页脚同样通栏并抵消底部内边距。**组件本身不再写左右 24px**，否则会叠加成 48px。

### 7.2 各元素间距约定

| 元素 | 间距来源 |
| --- | --- |
| `.dns-form` | `padding: 20px 0 0`（基线）；`.certificate-*-form` 继承，不再单独写左右值 |
| `.certificate-security-note` | `padding: 16px 0 0`，位于标题与表单之间 |
| `.dns-search` / `.page-tools` | `margin: 18px 0 …` |
| `.table-wrap` | `margin-top: 16px`；表格左右由面板内边距控制 |
| `.panel-footnote` | 通栏，`padding: 12px var(--panel-gutter)` |
| 相邻面板 | `.main-content > .panel + .panel { margin-top: 24px }` |
| `.migration-panel` | 例外：`padding: 36px`（或移动端 24px/20px），内部自行排版 |

### 7.3 新增组件注意事项

- 直接放在 `.panel` 里的块级元素会落在栅格内，**不要**再加左右 24px。
- 需要通栏（贴到面板边框）的元素，用 `margin-inline: calc(var(--panel-gutter) * -1)` 并自己补回左右 padding，参考 `.panel-footnote`。
- 一行内标签换行会导致输入框错位，`.dns-form .form-field > input/select/textarea { margin-top: auto }` 负责同一行输入框底对齐，新增表单沿用 `.dns-form` 结构即可。
- 需要说明图标的字段写成 `<div className="form-field"><div className="form-label"><label htmlFor="x">标签</label><InfoTip …/></div><input id="x" …/></div>`。**不要**把 `InfoTip` 放进 `<label>`：标签内含按钮后，输入框拿不到可访问名，`getByLabel()` 会直接失效。
- 所有新增移动端断点请复用 `--panel-gutter`，不要在组件里写死 16px/24px。

## 8. 弹窗

### 8.1 用途与用法

新增/编辑类表单一律走弹窗，触发器放在面板标题右侧的 `.panel-heading-actions` 里，页面正文只保留列表与查询条件。当前已弹窗化：

| 页面 | 触发器 → 弹窗标题 |
| --- | --- |
| `/account` | 添加账户 → 添加 DNS 账户；新建分类 → 新建分类 |
| `/domain` | 添加域名 → 添加域名 |
| `/record`、`/record/:id` | 添加记录 → 添加解析记录（编辑时为「修改解析记录」）；文本批量添加 → 文本批量添加 |
| `/record/:id/alias` | 添加别名 → 添加别名 |
| `/cloudflare/hostnames/:id` | 创建主机名 → 创建自定义主机名 |
| `/cloudflare/tunnels/:id` | 创建 Tunnel → 创建 Tunnel；添加主机名 → 添加公网主机名 |
| `/schedule/stask` | 新建任务 → 新建定时切换 |
| `/dmonitor/task` | 新建策略 → 新建容灾策略（HTTP(S) 健康检查或 TCP 端口）；通知渠道 → 容灾通知渠道；清理日志 → 清理容灾日志 |
| `/cert/certaccount` | 添加账户 → 创建 ACME 账户；添加代理 → 添加 CNAME 代理 |
| `/cert/certorder` | 申请证书 → 申请新证书；导入证书 → 导入已签发证书；续签设置 → 续签设置（含通知渠道与部署时间窗） |
| `/cert/deployaccount`、`/cert/deploytask` | 添加账户 → 添加部署账户（编辑时为「编辑部署账户」）；新建任务 → 新建部署任务 |
| `/optimizeip/opiplist` | 新建任务 → 新建优选任务；优选设置 → 优选设置（数据源、密钥、执行间隔） |
| `/record/groups/:id` | 移动分组 → 移动记录到分组 |
| `/system/account` | 新增用户 / 编辑 / 域名权限 → 对应标题 |

使用方式：

```tsx
{formOpen && <Modal title="添加 DNS 账户" description="凭据加密保存" onClose={() => setFormOpen(false)}>
  <form className="dns-form" onSubmit={submit}>…</form>
</Modal>}
```

`Modal` 的行为：

- `role="dialog"`、`aria-modal="true"`、`aria-labelledby="modal-title"`；
- 打开时把焦点移到弹窗内容里的第一个可聚焦元素，关闭时还给触发元素；
- Esc 关闭、点击遮罩关闭、Tab 在弹窗内循环；
- 打开期间锁 `document.body` 滚动；
- `wide` 属性放宽到 720px；`≤650px` 变成全屏面板（无圆角、`min-height: 100svh`）。

### 8.2 约定与限制

- **同一时间只支持一个弹窗**：标题使用固定 id `modal-title`，嵌套会出现重复 id 和焦点陷阱互抢。需要二级确认时改用页面内面板或 `window.confirm`。
- 提交中关闭：`onClose` 由调用方决定是否允许，例如 `onClose={() => !busy && setFormOpen(false)}`；当前账户与用户弹窗允许随时关闭，请求完成后仍会刷新列表。
- 弹窗内的 `.dns-form` 已重置内边距（`.modal-body .dns-form { padding: 0 }`），不需要额外写间距。
- 弹窗内不要放 `.panel`（会出现双层边框），直接放标题 + 表单/列表。
- 删除等不可逆操作仍用 `window.confirm`，没有自绘确认框。

## 9. 设计边界与已知限制（交接重点）

1. **语言覆盖不完整**：见 5.3。11 个语言选项里，词典覆盖外壳、登录链路、DNS 账户页、域名管理页（含分类面板）与公共控件；其余业务页正文仍为中文，非中文模式下会出现「外壳外语、正文中文」的混合界面。10 份词典各 350 条 key，新增文案要同时补 10 处，`tests/locales.test.ts` 会兜住键集合与占位符的偏差，但兜不住译文质量。浏览器语言匹配不到时默认英文，因此非中文用户会直接看到「外壳英文、业务页中文」的混合界面，这正是 5.3 的覆盖范围问题。
2. **服务端消息不翻译**：后端统一返回中文，`errorMessage()` 直接展示；要消除中文错误，需要后端返回错误码并在前端映射。
3. **品牌与标题不翻译**：`Brand`、`document.title`、`<meta name="theme-color">` 均为固定中文/固定色。
4. **主题首帧闪烁**：见 4.3，明暗与皮肤都会在首帧回落到 `classic` 亮色，需要在 `index.html` 加首屏脚本才能彻底消除。
5. **偏好不同步**：主题与语言只在本机，换设备需重选，服务端无偏好字段。
6. **弹窗不支持嵌套/叠加**，也不支持从弹窗内跳转到别的弹窗。
7. **间距方案依赖 DOM 结构**：`.panel` 的内边距 + 标题负外边距是全局约定，直接在 `.panel` 里塞入自带左右 padding 的第三方块会出现 48px 缩进。
8. **表格仍是普通表格**：无列冻结、无虚拟滚动、无列宽持久化；大数据量靠分页接口。
9. **单包构建**：`dist/frontend/assets/index-*.js` 约 664KB（gzip 约 173KB），未按路由拆分，构建时的 chunk 体积警告属预期。
10. **图标集很小**：`icons.tsx` 只有 `grid/dns/shield/menu/close/arrow/logout/server/lock/sun/moon/globe/plus/panel/panel-expand/info/alert/key/sliders/palette`，新增图标需同时改 `IconName` 与 `paths`。
11. **可访问性只做了基础项**：语义角色、焦点可见、焦点陷阱、跳过导航链接、`aria-label` 已覆盖；未做屏幕阅读器实测，也未接入自动对比度审计。
12. **自动化视觉验证有限**：e2e 只有三条用例（初始化→登录→响应式→四套主题切换与暗色组合→11 语言切换→域名管理导航→证书弹窗与续签设置→到期提醒→登录设置→DNS 账户与分类→解析管理选域名→解析记录→TOTP→改密；解析工具页；浏览器语言与颜色方案默认值），其余页面靠手工截图目检。Playwright 固定 `channel: 'chrome'` 与 `locale: 'zh-CN'`，未覆盖 Firefox/Safari 与真机。
13. **无组件级测试**：`tests/record-import.test.ts` 只覆盖 `frontend/src/record-import.ts` 这类纯函数；`preferences`、`Modal`、`navigation` 与各页面组件没有渲染测试，交互行为依赖 e2e 与手工目检。
14. **暗色未做打印/导出适配**：打印样式未单独定义，深色界面直接打印会是深底。

## 10. 测试与验证

```bash
npm run typecheck
npm test                 # 350 条，服务端、共享逻辑与词典一致性
npm run test:e2e         # 3 条，自动构建前端并起本地服务（端口 8789）
npm run docs:build && npm run docs:verify
```

`test:e2e` 的依赖与注意点：

- 使用本机 Chrome（`channel: 'chrome'`）与内存 SQLite（`LOCAL_EPHEMERAL=1`），每次运行都是全新数据库；
- `use.locale` 固定为 `zh-CN`，否则浏览器默认英文会改变导航与按钮的可访问名；语言回退与系统暗色由第三条用例用独立 `browser.newContext({ locale, colorScheme })` 验证；
- 断言文案、链接名、一级标题即导航标签，改名必须同步；
- 断言 `localStorage` 键以 `dnsmgr-` 开头；
- 截图调用传 `animations: 'disabled'`，否则入场动画会让断言/截图抓到半透明中间态；
- 登录接口与 `/api/v1/session` 被 `page.route` 改写以模拟 TOTP，业务接口按用例逐个 mock，**不会**调用真实 CA、Cloudflare 或第三方 API。

改动 UI 后建议的手工目检顺序（1440 与 375 两个宽度）：

1. `/login`：四套主题 × 亮/暗各一次，验证码换行、密码显示切换、右上角明暗/主题/语言三个控件（语言 11 项、原生语言名）；
2. `/`：两块面板、侧边栏滚动、折叠按钮与窄侧边栏下菜单是否截断、桌面端折叠与刷新后保持、头像菜单；切换主题后确认侧边栏渐变与页面光晕不改变布局；
3. `/account`、`/system/account`：弹窗打开/关闭、Esc、移动端全屏、提交后列表刷新；域名账号页下方分类面板的间距；
4. `/domain`、`/cert/certorder`：多面板间距、表格左右留白、弹窗内字段不贴边、标题右侧触发器不换行；证书订单页的「续签设置」弹窗、证书账户页的 CNAME 代理面板；
5. `/system/tasks`、`/system/maintenance`：合并页顺序与间距、375px 下 crontab 代码块只在块内横向滚动、旧路径 `/system/cronset` 直连仍能渲染；
6. `/setpwd`：TOTP 二维码在暗色下仍可扫描；改密入口只走头像菜单；
7. `/dmonitor/overview`、`/dmonitor/task`、`/optimizeip/opiplist`：指标标签与数值在同一行，窄屏不出现半行换行；优选设置弹窗只覆盖设置项，保存后自动关闭。
8. `/record`：未选域名时只显示空面板；选中域名后记录表格与 `/record/1000` 一致，切换域名时筛选与分页重置，且不出现「返回域名列表」。

## 11. 新页面 Checklist

- [ ] 组件放 `frontend/src/<Name>.tsx`，接收 `session`、`onExpired`，写操作带 CSRF；
- [ ] `navigation.ts` 增四字菜单项，写清 `scope`、`capability`、`implemented`；
- [ ] `Console.tsx` 增加分发分支（管理员页面加 `level === 2`）；
- [ ] `src/app.ts` 的 `pagePatterns` 加同一条路径正则，否则直连 / 刷新会返回 404 JSON；
- [ ] 动态路由页面在 `resolvePage()` 增加正则与标题；
- [ ] 使用 `.panel` + `.panel-heading` + `.dns-form` / `.table-wrap`，不要自写左右 24px；
- [ ] 新增中文文案若属于已接入词典的范围，同步补 `frontend/src/locales/` 下 10 份词典（以 `en.ts` 的键为基准）；
- [ ] 颜色只用 token：改现有皮肤就补亮色与 `[data-theme='dark']` 两处；新增皮肤还要加 `SKINS`、完整的 28 个 token × 2 组、词典里的皮肤名与 `data-skin` 断言；
- [ ] 新控件若放在顶栏，确认 375px 下不挤出横向滚动（e2e 会断言 `scrollWidth <= innerWidth`）；
- [ ] 说明文字用 `InfoTip`，不要写成常驻段落；字段标签与图标分开写，见 7.3；
- [ ] 新增/编辑表单用 `Modal`，触发器放 `.panel-heading-actions`；
- [ ] 更新 `tests/e2e/foundation.spec.ts` 中受影响的链接名、标题与弹窗流程；
- [ ] 跑 typecheck / test / test:e2e / build:cloudflare，并按 10 节目检。

## 12. 常见改动示例

**加一个菜单项**

```ts
// navigation.ts
{ path: '/system/audit', label: '审计导图', scope: '导出指定时间范围的审计记录', implemented: true },
```

```tsx
// Console.tsx 分发链
: path === '/system/audit' && level === 2 ? <AuditExport session={session} onExpired={onExpired} />
```

**加一条词条**

```ts
// frontend/src/locales/en.ts（其余 9 份保持同样的键与顺序）
'审计导图': 'Audit export',
```

**加一个暗色可用的状态色**

在 `:root` 与 `:root[data-theme='dark']` 各加同名变量，再在组件里引用；不要在两处之外写死十六进制。

## 13. 发布与回滚

前端随 Worker 一起发布，没有独立静态站：

```bash
npm run build:cloudflare
npx -y wrangler@latest deploy
```

线上校验（本机若被 DNS 污染，用能正常解析的环境或 WebFetch）：

```bash
curl -s https://dnsmgrui-work.52pika.workers.dev/health
```

返回 `{"code":0,"service":"dnsmgr-serverless","stage":"foundation"}` 即 Worker 正常；再取首页引用的 `assets/index-*.css` 确认新规则已生效。回滚与数据库备份步骤见 [发布与回滚](./release.md)。

## 14. 建议的后续工作

优先级从高到低：

1. 在 `frontend/index.html` 加首屏主题脚本（同时读取 `dnsmgr-theme` 与 `dnsmgr-skin`），消除按需暗色/皮肤的闪烁（见 4.3）；
2. 按页面推进英文化：先 `/domain` 与 `/cert/*`，最后统一服务端错误码映射；
3. 为 `Modal`、`preferences`、`navigation` 增加组件级测试（可用 Vitest + Testing Library，或将关键路径并入 e2e）；
4. 拆分 528KB 主包（按页面动态 `import()`），同时评估首屏体积；
5. 引入暗色下的对比度自动检查（Playwright + axe-core），补齐 Firefox/WebKit 用例；
6. 侧边栏已支持整栏折叠；若菜单继续增长，考虑按分组折叠或二级菜单，而不是继续压缩命名。
