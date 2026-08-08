// vitest.electron.config.ts
//
// 真路径测试套件配置（Phase 12 DEP-1 ABI 缓解）。
// 与现有 vitest.config.ts（plain Node mock 套件）物理隔离（Pitfall 6）。
//
// 运行方式：经 npm run test:electron（cross-env ELECTRON_RUN_AS_NODE=1 electron.exe 跑 vitest），
// electron.exe 的 Node 运行时 ABI 与 @electron/rebuild 重建后的 native binding（better-sqlite3/ssh2）一致，
// 消除 plain Node 无法加载 electron-ABI native binding 的 DEP-1 限制（SC1）。
//
// 关键差异（vs vitest.config.ts）：
//   - include 严格限定 tests 目录下的 electron 真路径套件（绝不重复采集生产源码目录里的 co-located mock 套件，Pitfall 6）
//   - 不挂 vitest 的 inline 转换配置（真路径用 electron-ABI 真 binding，不做 plain-node 转换）
//   - 加 testTimeout/hookTimeout（ssh2/telnet 网络操作需要更长超时）

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/electron/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 10000,
  },
})
