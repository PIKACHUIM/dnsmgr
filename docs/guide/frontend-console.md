# 控制台前端开发说明

本文面向接手 `frontend/` 的开发者，说明当前控制台的目录结构、主题与语言机制、导航与布局规范、弹窗约定、已知边界和验证流程。文中的「边界」是刻意保留的取舍，不是遗漏；改动前请先确认是否要突破这些边界，以及需要同步修改哪些测试。

> 对应交付：提交 `39d235a`（主题、语言、弹窗与间距轮次），Worker 版本 `70b07d39-34a1-42a4-8541-eeb489a90624`；其后一轮的侧边栏收窄 / 折叠与系统设置合并见 §6.3、§6.4。

## 本次交付摘要

这一轮前端改动来自五条明确需求：补齐元素边距并统一位置、把「添加账户」这类表单改成弹窗、侧边栏菜单统一四个汉字、亮暗主题切换、中英语言切换。落到代码上包括：

| 需求 | 实现 | 主要文件 |
| --- | --- | --- |
| 统一边距 | 新增 `--panel-gutter` 栅格变量，面板内边距 / 标题通栏 / 页脚通栏统一，相邻面板补 24px 间距，表格与表单不再贴边 | `styles.css` |
| 表单弹窗化 | 新增 `Modal`，DNS 账户的新增、用户新增/编辑/域名权限改为弹窗 | `Modal.tsx`、`DnsAccounts.tsx`、`Users.tsx` |
| 四字导航 | 全部菜单项与分组名改为四个汉字，动态页标题同步 | `navigation.ts` |
| 亮暗主题 | `PreferencesProvider` + `data-theme` + 暗色 token 覆盖，选择持久化 | `preferences.tsx`、`styles.css`、`main.tsx` |
| 中英切换 | 中文原文即词条 key，外壳 / 登录 / 首页 / DNS 账户页完成英文化 | `preferences.tsx`、`Console.tsx`、`Auth.tsx` |

同时补充了图标（`sun` / `moon` / `globe` / `plus`），并同步更新了 e2e 断言（导航标签、`localStorage` 键前缀、主题/语言切换、账户弹窗的打开与 Esc 关闭）。

交付验证（在本仓库执行）：`npm run typecheck` 通过；`npm test` 23 个文件 330 条通过；`npm run test:e2e` 2 条通过；`npm run build:cloudflare` 成功并部署。线上 `/health` 返回 `{"code":0,"service":"dnsmgr-serverless","stage":"foundation"}`，`assets/index-MeBz4m5M.css` 已确认包含 `--panel-gutter`、`.modal-backdrop` 与 `:root[data-theme=dark]`。本轮只验证了 Cloudflare 构建，EdgeOne 与 ESA 产物未重新构建。

涉及的是纯前端资源与导航文案，没有新增 D1 迁移，回滚只需 `git revert 39d235a` 后重新部署，或直接回退 Worker 版本；数据库无需处理。

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
| `Auth.tsx` | 初始化、登录、TOTP 第二步、图形验证码、登录页主题/语言按钮 |
| `Console.tsx` | 控制台外壳（侧边栏、顶栏、页脚）、首页面板、按 `canonicalPath(path)` 分发业务组件 |
| `navigation.ts` | 导航数据（分组、标签、说明、能力位）、`mergedPaths` / `canonicalPath()` 旧路径映射与 `resolvePage()` 动态页解析 |
| `SystemPages.tsx` | 系统设置的三个聚合页，只做组件组合 |
| `preferences.tsx` | 主题/语言 Context、英文词条表、`ThemeToggle` / `LanguageToggle` |
| `Modal.tsx` | 可访问弹窗（焦点锁定、Esc、遮罩、滚动锁定） |
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

## 4. 主题（亮色 / 暗色）

### 4.1 机制

`PreferencesProvider` 在挂载后把主题写到根元素：

```ts
document.documentElement.dataset.theme = theme;   // 'light' | 'dark'
document.documentElement.style.colorScheme = theme;
```

CSS 中 `:root` 定义亮色 token，`:root[data-theme='dark']` 覆盖同名 token，所有组件只引用 token，不写死颜色（少数刻意例外见 4.4）。选择保存在 `localStorage` 的 `dnsmgr-theme`；没有保存值时读取 `prefers-color-scheme`。

### 4.2 新增或调整颜色

只改 `styles.css` 顶部的两处 token 块，不要在组件里写颜色。常用 token：

| token | 用途 |
| --- | --- |
| `--color-bg` / `--color-surface` | 页面底色 / 卡片底色 |
| `--color-text` / `--color-muted` | 主文字 / 次要文字 |
| `--color-subtle` / `--color-border` / `--color-control-border` | 浅底块 / 分隔线 / 表单控件边框 |
| `--color-accent` / `--color-accent-hover` / `--color-accent-soft` | 主色与浅底 |
| `--color-sidebar*` | 侧边栏（亮暗两套均为深色，暗色更深） |
| `--color-success` / `--color-warning` / `--color-error*` | 状态色 |
| `--color-backdrop` / `--shadow-*` / `--color-focus` | 遮罩、阴影、焦点环 |

暗色下主按钮使用 `--color-accent` 作底色、`--color-surface` 作文字色，新增按钮样式请沿用这一组合，避免硬编码 `#fff`。

### 4.3 已知边界

- **首屏可能闪一下亮色**。主题在 React 挂载后的 effect 里写入 `data-theme`，默认 CSS 是亮色，已保存暗色的用户在首帧会看到亮色。彻底修复需要在 `frontend/index.html` 的 `<head>` 内加一段同步脚本，在首屏渲染前读取 `dnsmgr-theme` 并设置 `documentElement.dataset.theme`；当前未做。
- **不跟随系统主题实时变化**。只在首次加载时读取一次 `prefers-color-scheme`，之后以用户选择为准，不监听 `matchMedia` 变化。
- **主题不随账号同步**。偏好仅存本机 `localStorage`（键前缀 `dnsmgr-`），换设备或换浏览器需要重新选择；服务端没有偏好接口。
- **`<meta name="theme-color">` 固定为 `#182230`**（`frontend/index.html`），移动端浏览器地址栏颜色不会随主题变化。

### 4.4 刻意不随主题的部分

- TOTP 二维码容器 `.totp-qr` 固定浅底深码（`--color-qr-*` 局部变量），因为多数扫码器在深底反色下识别率差。
- 侧边栏在亮色下也是深色导航，暗色只是进一步压深，这是有意的视觉分层。

## 5. 多语言（中文 / 英文）

### 5.1 机制

中文原文就是词条 key，英文查表：

```ts
t('证书订单')                  // zh: '证书订单'，en: 'Orders'
t('已保留「{label}」的导航入口…', { label: t(page.item.label) })
```

- `t()` 只在语言为 `en` 时查表；查不到时原样返回 key，因此**漏翻不会报错，也不会显示 undefined**。
- 支持 `{name}` 占位符替换，用于把变量安全插进句子。
- 语言写在 `document.documentElement.lang`，保存到 `localStorage` 的 `dnsmgr-language`。
- 无词条文件拆分，全部在 `preferences.tsx` 的 `english` 常量里，按「导航 / 页面说明 / 控制台框架 / 偏好 / 登录 / DNS 账户 / 服务商字段」分区注释。

### 5.2 新增文案的两种写法

1. 固定文案：JSX 里直接写 `{t('中文原文')}`，再在 `english` 中补一条。
2. 动态文案（服务端返回或模板字符串）：服务端文案不要直接当 key 用；需要拼接时先翻译片段再拼接，例如登录过期提示 `setError(`${errorMessage(failure)} ${t('本次验证请求已失效，请重新输入密码登录。')}`)`。

`Auth.tsx` 里存在 `{t(error)}` 的写法：错误状态存中文原文，渲染时尝试翻译。这样做的好处是切换语言时已有错误也能跟着变；风险是如果服务端返回的文案恰好等于某个词条 key，会被误翻。当前没有冲突，新增词条时注意避免与常见服务端错误文案重名。

### 5.3 覆盖范围边界

已英文化：

- 控制台外壳：顶栏、侧边栏分组与菜单、页面标题与说明、状态角标、页脚、未移植占位面板；
- 首页运行环境 / 当前会话 / 功能迁移状态三块面板；
- 登录、初始化、TOTP、图形验证码整页；
- DNS 账户页（含服务商凭据字段标签、可选后缀）。

**仍为中文**：

- 其余业务页正文、表头、按钮与提示（域名、解析记录、证书、通知、用户管理、日志等）；
- 服务端返回的所有消息（`errorMessage()` 直接展示后端中文），以及服务商名称、部分服务商字段值；
- 浏览器标签标题 `document.title`（`main.tsx` 仍拼中文）；
- 品牌块 `Brand`（「聚合 DNS」/「管理系统 / CONTROL」）保持中文。

这是有意的分阶段交付：先保证外壳与登录链路完整可用，避免出现「菜单英文、页面半中半英」的错位感。继续扩展时按页面整体翻译，不要逐句零散补。

### 5.4 关于本地存储的硬约束

`tests/e2e/foundation.spec.ts` 会断言 `localStorage` 的所有键都以 `dnsmgr-` 开头。新增偏好可以继续用该前缀，但**不得**把用户名、会话、CSRF token、服务商凭据写进浏览器存储。

## 6. 侧边栏规范：统一四个汉字

### 6.1 规则

分组名与菜单项名一律四个汉字，便于在 216px 侧边栏（`--sidebar-width`）内对齐且不换行。长度检查方式：

```bash
grep -oP "label: '[^']*'" frontend/src/navigation.ts | sort -u
```

当前分组：工作空间、域名配置、容灾调度、证书管理、优选管理、系统设置、审计账户。菜单项与旧名对照：

| 旧名 | 新名 |
| --- | --- |
| 自动部署账户 / 自动部署任务 | 部署账户 / 部署任务 |
| CNAME 代理 / 自动续签设置 | 证书代理 / 续签设置 |
| 任务管理（优选） | 优选任务 |
| 到期提醒设置 | 到期提醒 |
| 批量添加解析 / 批量修改解析 | 批量添加 / 批量修改 |
| 按记录值搜索 / 智能批量添加 | 记录搜索 / 智能添加 |
| 服务商操作日志 / 解析记录分组 | 服务日志 / 记录分组 |
| 导入解析记录 | 导入记录 |
| Cloudflare 自定义主机名 / Cloudflare Tunnels | 自定义域 / 隧道管理 |
| 未移植页面 | 未知页面 |

路由路径未改，旧书签和外部链接仍然有效。仅「系统设置」分组因为页面合并而更换了入口路径，旧路径仍可访问（见 §6.4）。

### 6.2 改名会牵动的测试

`tests/e2e/foundation.spec.ts` 用链接名和一级标题定位页面。改名后必须同步：

- 链接定位：`getByRole('link', { name: '到期提醒' })`；
- 一级标题：`getByRole('heading', { level: 1, name: '批量添加' })`——标题来自 `navigation.ts` 的 `label`，不是组件内部 `<h2>`。

英文模式下的断言同理（如 `name: 'Orders'`）。

### 6.3 宽度与折叠

- 宽度只有一个来源：`:root { --sidebar-width: 216px }`，`.sidebar` 与 `.workspace` 都引用它；移动端抽屉单独写 248px，改宽度时两处都要看。
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

映射写在 `navigation.ts` 的 `mergedPaths`，由 `canonicalPath()` 查表，`resolvePage()` 与 `Console.tsx` 都先映射再匹配：

```ts
export function canonicalPath(path: string): string {
  return mergedPaths[path] ?? path;
}
```

旧 URL 会渲染新聚合页、标题也显示新菜单名，但**地址栏不会改写**（仍停留在旧路径）。合并的副作用是单页变长，移动端滚动距离增加；`CronSettings` 的 crontab 命令是 `<pre>`，靠 `.panel pre { max-width: 100%; overflow-x: auto }` 在块内滚动，不会撑破页面宽度——e2e 在 375px 断言的 `scrollWidth <= innerWidth` 正是为了让这类长代码块不把整页顶宽。

**合并或改名时同时要改**：`navigation` 与 `mergedPaths`、`Console.tsx` 的分发分支、`src/app.ts` 的 `pagePatterns`（旧路径要留在白名单，否则直连 404）。另外「Telegram」这类短标签在合并页里可能与「清除 Telegram 凭据」按钮重名，e2e 需用 `section[aria-labelledby="expiration-notice-title"]` 限定作用域。

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
- 所有新增移动端断点请复用 `--panel-gutter`，不要在组件里写死 16px/24px。

## 8. 弹窗

### 8.1 用途与用法

「添加账户」「新增用户」「编辑用户」「域名权限」使用 `Modal`，不再把表单常驻在页面底部。使用方式：

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

1. **语言覆盖不完整**：见 5.3。业务页仍为中文，英文模式下会出现「外壳英文、正文中文」的混合界面。
2. **服务端消息不翻译**：后端统一返回中文，`errorMessage()` 直接展示；要在英文界面消除中文错误，需要后端返回错误码并在前端映射。
3. **品牌与标题不翻译**：`Brand`、`document.title`、`<meta name="theme-color">` 均为固定中文/固定色。
4. **主题首帧闪烁**：见 4.3，需要在 `index.html` 加首屏脚本才能彻底消除。
5. **偏好不同步**：主题与语言只在本机，换设备需重选，服务端无偏好字段。
6. **弹窗不支持嵌套/叠加**，也不支持从弹窗内跳转到别的弹窗。
7. **间距方案依赖 DOM 结构**：`.panel` 的内边距 + 标题负外边距是全局约定，直接在 `.panel` 里塞入自带左右 padding 的第三方块会出现 48px 缩进。
8. **表格仍是普通表格**：无列冻结、无虚拟滚动、无列宽持久化；大数据量靠分页接口。
9. **单包构建**：`dist/frontend/assets/index-*.js` 约 528KB（gzip 约 141KB），未按路由拆分，构建时的 chunk 体积警告属预期。
10. **图标集很小**：`icons.tsx` 只有 `grid/dns/shield/menu/close/arrow/logout/server/lock/sun/moon/globe/plus/panel/panel-expand`，新增图标需同时改 `IconName` 与 `paths`。
11. **可访问性只做了基础项**：语义角色、焦点可见、焦点陷阱、跳过导航链接、`aria-label` 已覆盖；未做屏幕阅读器实测，也未接入自动对比度审计。
12. **自动化视觉验证有限**：e2e 只有两条用例（初始化→登录→响应式→证书→DNS 账户→TOTP→改密；解析工具页），其余页面靠手工截图目检。Playwright 固定 `channel: 'chrome'`，未覆盖 Firefox/Safari 与真机。
13. **无组件级测试**：`tests/record-import.test.ts` 只覆盖 `frontend/src/record-import.ts` 这类纯函数；`preferences`、`Modal`、`navigation` 与各页面组件没有渲染测试，交互行为依赖 e2e 与手工目检。
14. **暗色未做打印/导出适配**：打印样式未单独定义，深色界面直接打印会是深底。

## 10. 测试与验证

```bash
npm run typecheck
npm test                 # 330 条，服务端与共享逻辑
npm run test:e2e         # 2 条，自动构建前端并起本地服务（端口 8789）
npm run docs:build && npm run docs:verify
```

`test:e2e` 的依赖与注意点：

- 使用本机 Chrome（`channel: 'chrome'`）与内存 SQLite（`LOCAL_EPHEMERAL=1`），每次运行都是全新数据库；
- 断言文案、链接名、一级标题即导航标签，改名必须同步；
- 断言 `localStorage` 键以 `dnsmgr-` 开头；
- 截图调用传 `animations: 'disabled'`，否则入场动画会让断言/截图抓到半透明中间态；
- 登录接口与 `/api/v1/session` 被 `page.route` 改写以模拟 TOTP，业务接口按用例逐个 mock，**不会**调用真实 CA、Cloudflare 或第三方 API。

改动 UI 后建议的手工目检顺序（1440 与 375 两个宽度）：

1. `/login`：亮/暗各一次，验证码换行、密码显示切换、右上角主题与语言按钮；
2. `/`：三块面板、侧边栏滚动、四字菜单是否换行、桌面端折叠与刷新后保持；
3. `/account`、`/system/account`：弹窗打开/关闭、Esc、移动端全屏、提交后列表刷新；
4. `/domain`、`/cert/certorder`：多面板间距、表格左右留白、表单不贴边；
5. `/system/tasks`、`/system/maintenance`：合并页顺序与间距、375px 下 crontab 代码块只在块内横向滚动、旧路径 `/system/cronset` 直连仍能渲染；
6. `/setpwd`：TOTP 二维码在暗色下仍可扫描。

## 11. 新页面 Checklist

- [ ] 组件放 `frontend/src/<Name>.tsx`，接收 `session`、`onExpired`，写操作带 CSRF；
- [ ] `navigation.ts` 增四字菜单项，写清 `scope`、`capability`、`implemented`；
- [ ] `Console.tsx` 增加分发分支（管理员页面加 `level === 2`）；
- [ ] `src/app.ts` 的 `pagePatterns` 加同一条路径正则，否则直连 / 刷新会返回 404 JSON；
- [ ] 动态路由页面在 `resolvePage()` 增加正则与标题；
- [ ] 使用 `.panel` + `.panel-heading` + `.dns-form` / `.table-wrap`，不要自写左右 24px；
- [ ] 新增中文文案若属于已英文化范围，补 `english` 词条；
- [ ] 增删表单优先用 `Modal`；
- [ ] 更新 `tests/e2e/foundation.spec.ts` 中受影响的链接名与标题；
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

**加一条英文词条**

```ts
// preferences.tsx 的 english
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

1. 在 `frontend/index.html` 加首屏主题脚本，消除暗色闪烁（见 4.3）；
2. 按页面推进英文化：先 `/domain` 与 `/cert/*`，最后统一服务端错误码映射；
3. 为 `Modal`、`preferences`、`navigation` 增加组件级测试（可用 Vitest + Testing Library，或将关键路径并入 e2e）；
4. 拆分 528KB 主包（按页面动态 `import()`），同时评估首屏体积；
5. 引入暗色下的对比度自动检查（Playwright + axe-core），补齐 Firefox/WebKit 用例；
6. 侧边栏已支持整栏折叠；若菜单继续增长，考虑按分组折叠或二级菜单，而不是继续压缩命名。
