import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // 演示部署在 https://<host>/base/ 下
  base: '/base/',
  plugins: [vue()],
})
