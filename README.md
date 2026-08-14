# 网络拓扑管理工具 (Network Topology Manager)

面向运维人员的桌面工具：在一个应用里可视化网络拓扑、安全地远程操控设备、用 AI 辅助分析与执行运维命令，并维护设备资料与运维知识库。

## ✨ 功能特性

- **拓扑可视化** — React Flow 画布展示网络拓扑；SSH 自动发现设备连接关系（AI 分析 ARP / 路由 / 接口数据推断）
- **设备管理** — 设备台账与凭证管理；凭证 AES-256-GCM 字段级加密，主密钥经 Windows DPAPI（safeStorage）绑定机器落盘
- **远程连接** — SSH / Telnet / Web / RDP 四类远程通道，独立终端窗口（xterm.js），按窗口隔离会话
- **AI 运维助手** — 自然语言分析网络问题 + 远程命令执行；命令白名单强制校验、高危命令二次确认、执行日志全量审计
- **知识库** — PDF / DOCX 文档解析、自动分章节、全文检索；AI 运维对话沉淀为可检索、可溯源的长期经验资产
- **IP / MAC 监控** — ARP 定时采集，新 IP / MAC 变更 / IP 复用异常检测，白名单排除，CSV 导出

## 📥 下载安装

到 [Releases](https://github.com/HaoNan-0331/network-topology-manager/releases) 下载最新 `Setup.x.x.x.exe`（Windows x64，NSIS 安装包），双击安装即可。

所有数据（设备资料 / 凭证 / 知识库 / 监控记录）存储在本地 SQLite 数据库，无需服务端。

## 🛠 从源码构建

环境要求：Windows、Node.js 18+、npm

```bash
npm install                # 安装依赖
npm run rebuild:native     # 按 Electron ABI 重建 native 模块（better-sqlite3 / ssh2）
npm run electron:dev       # 开发调试
npm test                   # 单元测试（vitest）
npm run test:electron      # 真路径测试（真实 better-sqlite3 / ssh2 / telnet 协议库）
npm run electron:build     # 打包 NSIS 安装包（输出 release/）
```

> `test:electron` 必须用 `npm run test:electron`（经 electron.exe 运行以匹配 native ABI），不要直接 `npx vitest`。

更多细节见 [docs/开发与发布指南.md](docs/开发与发布指南.md)。

## 🧰 技术栈

Electron · React 19 · TypeScript（strict） · Vite · Ant Design 6 · React Flow 11 · Zustand 5 · better-sqlite3（WAL） · ssh2 · xterm.js

## 🔒 安全设计

- **凭证加密**：敏感字段 AES-256-GCM 加密存储（版本化密文格式，向后兼容历史数据），主密钥经 Windows DPAPI 保护
- **进程隔离**：renderer `contextIsolation` + `sandbox` + `nodeIntegration: false`，仅经 preload 白名单桥接访问能力，renderer 永不接触明文凭证
- **IPC 鉴权网关**：特权通道登录鉴权 + 异常信息脱敏；登录前通道仅脱敏
- **命令安全**：AI / 远程执行命令统一过白名单校验（分隔符注入拦截 + 黑名单 + 首词严格匹配），高危命令强制二次确认
- **数据可靠**：SQLite WAL 模式 + 版本化幂等迁移 + 迁移前自动备份 + 周期备份轮换
