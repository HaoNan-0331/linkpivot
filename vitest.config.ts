import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    // src/**/*.test.ts：renderer 侧纯函数测试（26-02 topologyLayout，无 native/@testing-library 依赖）
    include: ['tests/**/*.test.ts', 'electron/**/*.test.ts', 'src/**/*.test.ts'],
    // 排除 tests/electron/**（Phase 12 真路径套件，需 electron.exe ABI 运行时，Pitfall 6 物理隔离）
    // 否则 plain node npm test 会采集 db.real.test.ts 等真路径测试，better-sqlite3 ABI 不匹配崩（DEP-1）
    exclude: ['tests/electron/**', '**/node_modules/**', '**/dist/**'],
    server: {
      deps: {
        inline: ['../../electron'],
      },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
})
