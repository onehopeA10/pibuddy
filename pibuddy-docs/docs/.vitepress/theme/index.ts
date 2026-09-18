import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import Home from './Home.vue'
import './style.css'

// 自定义主题：注册首页 <Home> 组件，其余沿用 VitePress 默认主题
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Home', Home)
  },
} satisfies Theme
