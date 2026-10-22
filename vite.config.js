import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // 演示部署在 https://<host>/base/ 下
  base: '/base/',
  plugins: [vue()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('/three/')) return 'three'
          if (id.includes('element-plus') || id.includes('@element-plus')) return 'element-plus'
          if (id.includes('@loaders.gl')) return 'loaders-gl'
          if (id.includes('/vue/') || id.includes('@vue/')) return 'vue'
          return undefined
        },
      },
    },
  },
})
