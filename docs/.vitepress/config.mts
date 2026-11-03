import { defineConfig } from 'vitepress';

export default defineConfig({
  base: '/',
  vite: { resolve: { preserveSymlinks: true } },
  lang: 'zh-CN',
  title: 'DnsMgr 文档',
  description: '彩虹聚合 DNS 管理系统：Serverless 改造、开发与部署文档。',
  cleanUrls: true,
  lastUpdated: true,
  appearance: false,
  markdown: { lineNumbers: true },
  head: [
    ['meta', { name: 'theme-color', content: '#f4f6f8' }],
    ['meta', { name: 'color-scheme', content: 'light' }],
  ],
  themeConfig: {
    siteTitle: 'DNSMGR / 手册',
    nav: [
      { text: '项目概览', link: '/guide/overview' },
      { text: '开发指南', link: '/guide/local-development' },
      { text: '平台部署', link: '/guide/platforms' },
      { text: '迁移状态', link: '/guide/compatibility' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '项目',
          items: [
            { text: '项目概览', link: '/guide/overview' },
            { text: '迁移与兼容状态', link: '/guide/compatibility' },
          ],
        },
        {
          text: '开发与运行',
          items: [
            { text: '本地开发', link: '/guide/local-development' },
            { text: '存储配置', link: '/guide/storage' },
            { text: '平台构建与根路径部署', link: '/guide/platforms' },
            { text: '发布与回滚', link: '/guide/release' },
          ],
        },
      ],
    },
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/PIKACHUIM/dnsmgr' },
    ],
    footer: {
      message: '开源改造进行中 · 当前版本尚未替代旧版生产 DNS 服务',
      copyright: '基于当前仓库实现编写；云端部署与持久化尚未实测。',
    },
    outline: { level: [2, 3], label: '本页内容' },
    docFooter: { prev: '上一页', next: '下一页' },
    returnToTopLabel: '返回顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '外观',
    langMenuLabel: '语言',
  },
});
