---
layout: home
hero:
  name: DNSMGR
  text: DNS 管理，运行在边缘
  tagline: >-
    面向 Cloudflare Workers、EdgeOne Makers 与阿里云 ESA 的
    Serverless 改造工程手册。当前状态、配置边界与验证方式均以仓库实现为准。
  actions:
    - theme: brand
      text: 从本地开发开始
      link: /guide/local-development
    - theme: alt
      text: 查看迁移状态
      link: /guide/compatibility
features:
  - title: 一套 Hono 核心
    details: 三个平台入口共享路由、鉴权和服务；平台能力差异在各自适配层显式处理。
    link: /guide/platforms
    linkText: 平台入口与构建
  - title: SQL 协调，不假装强一致
    details: D1 / Turso 保存安全状态和活动指针；KV、Blob 仅承载不可变对象版本。
    link: /guide/storage
    linkText: 存储模型与限制
  - title: 迁移状态可核对
    details: 记录旧 PHP 契约规模与当前未实现范围，不把文件登记或路由占位算作完成。
    link: /guide/compatibility
    linkText: 查看兼容清单
---

<div class="home-status">
  <span class="home-status-mark" aria-hidden="true"></span>
  <div>
    <strong>FOUNDATION / 本地开发阶段</strong>
    <p>认证、存储基础与三平台打包已建立。DNS、证书、任务和执行器业务尚未完成迁移。</p>
  </div>
</div>

<div class="home-footnote">
  本站与 DNS 管理 Worker 是分开的静态文档产物。部署在域名根目录时，页面静态资源直接请求 <code>/assets/…</code>；构建基路径固定为 <code>/</code>，不添加仓库名子路径。
</div>
