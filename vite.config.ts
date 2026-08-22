import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/') || id.includes('node_modules/react-router-dom')) return 'vendor-react'
          if (id.includes('node_modules/antd') || id.includes('node_modules/@ant-design')) return 'vendor-antd'
          if (id.includes('node_modules/reactflow') || id.includes('node_modules/@reactflow')) return 'vendor-reactflow'
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // checkpoint 环境修复:强制 IPv4 监听——默认绑定退化为 [::1] only(IPv6)时,
    // Electron(main 进程)与 curl 解析 localhost→127.0.0.1 均不可达,renderer 白屏。
    host: '127.0.0.1',
    proxy: {
      '/proxy/ai': {
        target: process.env.VITE_AI_PROXY_TARGET || 'https://ark.cn-beijing.volces.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/ai/, ''),
      },
    },
  },
})
