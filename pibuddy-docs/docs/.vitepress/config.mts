import { defineConfig } from 'vitepress'

const sharedNavZh = [
  { text: '指南', link: '/guide/', activeMatch: '/guide/' },
  { text: '截图', link: '/screens/', activeMatch: '/screens/' },
  { text: '架构', link: '/architecture/', activeMatch: '/architecture/' },
  { text: '运行时', link: '/runtime/', activeMatch: '/runtime/' },
  { text: '安全', link: '/security/', activeMatch: '/security/' },
  { text: '数据', link: '/data/', activeMatch: '/data/' },
  { text: '交付', link: '/delivery/', activeMatch: '/delivery/' },
  { text: '扩展', link: '/extensions/', activeMatch: '/extensions/' },
]

const sharedNavEn = [
  { text: 'Guide', link: '/en/guide/', activeMatch: '/en/guide/' },
  { text: 'Screens', link: '/en/screens/', activeMatch: '/en/screens/' },
  { text: 'Architecture', link: '/en/architecture/', activeMatch: '/en/architecture/' },
  { text: 'Runtime', link: '/en/runtime/', activeMatch: '/en/runtime/' },
  { text: 'Security', link: '/en/security/', activeMatch: '/en/security/' },
  { text: 'Data', link: '/en/data/', activeMatch: '/en/data/' },
  { text: 'Delivery', link: '/en/delivery/', activeMatch: '/en/delivery/' },
  { text: 'Extensions', link: '/en/extensions/', activeMatch: '/en/extensions/' },
]

export default defineConfig({
  title: 'PiBuddy',
  cleanUrls: true,
  lastUpdated: true,
  appearance: true,

  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#0a0e14' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'PiBuddy Docs' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'PiBuddy — a local-first desktop agent for office work. Boundaries, contracts, evidence.',
      },
    ],
  ],

  themeConfig: {
    logo: {
      light: '/logo-light.svg',
      dark: '/logo.svg',
      alt: 'PiBuddy',
    },
    siteTitle: 'PiBuddy',
    outline: { level: [2, 3] },
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                noResultsText: '没有找到相关结果',
                resetButtonTitle: '清除查询条件',
                footer: {
                  selectText: '选择',
                  navigateText: '切换',
                  closeText: '关闭',
                },
              },
            },
          },
          en: {
            translations: {
              button: { buttonText: 'Search docs', buttonAriaLabel: 'Search docs' },
              modal: {
                noResultsText: 'No results found',
                resetButtonTitle: 'Clear query',
                footer: {
                  selectText: 'to select',
                  navigateText: 'to navigate',
                  closeText: 'to close',
                },
              },
            },
          },
        },
      },
    },
  },

  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'PiBuddy',
      description: '把产品当作一个系统来阅读 —— 面向办公用户的 pi 智能体桌面助手',
      themeConfig: {
        nav: sharedNavZh,
        outline: { label: '本页内容' },
        sidebar: {
          '/guide/': [
            {
              text: '指南',
              items: [
                { text: '从这里开始', link: '/guide/' },
                { text: '产品范围与里程碑', link: '/guide/product-scope' },
                { text: '截图 / Screens', link: '/screens/' },
              ],
            },
            {
              text: '深入',
              items: [
                { text: '架构总览', link: '/architecture/' },
                { text: '安全边界', link: '/security/' },
              ],
            },
          ],
          '/screens/': [
            {
              text: '指南',
              items: [
                { text: '从这里开始', link: '/guide/' },
                { text: '截图 / Screens', link: '/screens/' },
              ],
            },
          ],
          '/architecture/': [
            {
              text: '架构',
              items: [
                { text: '架构总览', link: '/architecture/' },
                { text: '事件流与信封', link: '/architecture/event-flow' },
              ],
            },
          ],
          '/runtime/': [{ text: '运行时', items: [{ text: 'pi 运行时生命周期', link: '/runtime/' }] }],
          '/security/': [{ text: '安全', items: [{ text: '威胁模型与权限', link: '/security/' }] }],
          '/data/': [{ text: '数据', items: [{ text: 'SQLite 分区与备份', link: '/data/' }] }],
          '/delivery/': [{ text: '交付', items: [{ text: '更新与发布', link: '/delivery/' }] }],
          '/extensions/': [{ text: '扩展', items: [{ text: 'Extension UI 与能力包', link: '/extensions/' }] }],
        },
        docFooter: { prev: '上一页', next: '下一页' },
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换到浅色',
        darkModeSwitchTitle: '切换到深色',
        returnToTopLabel: '返回顶部',
        sidebarMenuLabel: '菜单',
        langMenuLabel: '切换语言',
        lastUpdated: {
          text: '最后更新于',
          formatOptions: { dateStyle: 'short', timeStyle: 'short' },
        },
        footer: {
          message: '内容取材于 PiBuddy 主仓库工程文档 · 布局参考 pi-docs.aiuo.net',
          copyright: 'PiBuddy —— 面向办公用户的 pi 智能体桌面助手',
        },
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      title: 'PiBuddy',
      description: 'Read the product as a system — a local-first desktop agent for office work',
      themeConfig: {
        nav: sharedNavEn,
        outline: { label: 'On this page' },
        sidebar: {
          '/en/guide/': [
            {
              text: 'Guide',
              items: [
                { text: 'Start here', link: '/en/guide/' },
                { text: 'Product scope and milestones', link: '/en/guide/product-scope' },
                { text: 'Screens', link: '/en/screens/' },
              ],
            },
            {
              text: 'Go deeper',
              items: [
                { text: 'Architecture', link: '/en/architecture/' },
                { text: 'Security boundary', link: '/en/security/' },
              ],
            },
          ],
          '/en/screens/': [
            {
              text: 'Guide',
              items: [
                { text: 'Start here', link: '/en/guide/' },
                { text: 'Screens', link: '/en/screens/' },
              ],
            },
          ],
          '/en/architecture/': [
            {
              text: 'Architecture',
              items: [
                { text: 'Overview', link: '/en/architecture/' },
                { text: 'Event flow and envelope', link: '/en/architecture/event-flow' },
              ],
            },
          ],
          '/en/runtime/': [{ text: 'Runtime', items: [{ text: 'pi runtime lifecycle', link: '/en/runtime/' }] }],
          '/en/security/': [{ text: 'Security', items: [{ text: 'Threat model and permissions', link: '/en/security/' }] }],
          '/en/data/': [{ text: 'Data', items: [{ text: 'SQLite partitions and backup', link: '/en/data/' }] }],
          '/en/delivery/': [{ text: 'Delivery', items: [{ text: 'Updates and release', link: '/en/delivery/' }] }],
          '/en/extensions/': [{ text: 'Extensions', items: [{ text: 'Extension UI and capability packs', link: '/en/extensions/' }] }],
        },
        docFooter: { prev: 'Previous', next: 'Next' },
        darkModeSwitchLabel: 'Appearance',
        lightModeSwitchTitle: 'Switch to light',
        darkModeSwitchTitle: 'Switch to dark',
        returnToTopLabel: 'Return to top',
        sidebarMenuLabel: 'Menu',
        langMenuLabel: 'Change language',
        lastUpdated: {
          text: 'Last updated',
          formatOptions: { dateStyle: 'short', timeStyle: 'short' },
        },
        footer: {
          message: 'Sourced from PiBuddy engineering docs · layout inspired by pi-docs.aiuo.net',
          copyright: 'PiBuddy — a desktop agent for office work',
        },
      },
    },
  },
})
