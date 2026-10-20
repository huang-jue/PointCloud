/**
 * 应用入口：注册 Vue + Element Plus（暗色主题），挂载根组件。
 * dev 模式下额外把 store / viewer 引用挂到 window，便于调试与自动化测试。
 */
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css' // 暗色主题变量
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import './style.css'
import App from './App.vue'

const app = createApp(App)

// 全局注册所有 Element Plus 图标，模板中可直接用 <Aim /> <Plus /> 等
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(ElementPlus)
app.mount('#app')

if (import.meta.env.DEV) {
  import('./stores/useAnnotationStore.js').then((m) => {
    window.__store = m.store
    window.__state = m.state
  })
  import('./three/viewerRef.js').then((m) => {
    window.__viewer = m.viewerRef
  })
  // 便于调试 / 自动化测试：HTTP 封装与保存模块
  import('./utils/http.js').then((m) => {
    window.__http = m
  })
  import('./utils/save.js').then((m) => {
    window.__save = m
  })
}
