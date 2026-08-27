# 灵枢 LinkPivot

灵枢（LinkPivot）是面向运维人员的桌面工具：在一个应用里可视化网络拓扑、安全地远程操控设备、用 AI 辅助分析与执行运维命令，并维护设备资料与运维知识库。

## ✨ 功能特性

- **拓扑可视化** — React Flow 画布展示网络拓扑；SSH 自动发现设备连接关系（AI 分析 ARP / 路由 / 接口数据推断）
- **设备管理** — 设备台账与凭证管理；凭证 AES-256-GCM 字段级加密，主密钥经 Windows DPAPI（safeStorage）绑定机器落盘
- **远程连接** — SSH / Telnet / Web / RDP 四类远程通道，独立终端窗口（xterm.js），按窗口隔离会话
- **AI 运维助手** — 自然语言分析网络问题 + 远程命令执行；命令白名单强制校验、高危命令二次确认、执行日志全量审计
- **知识库** — PDF / DOCX 文档解析、自动分章节、全文检索；AI 运维对话沉淀为可检索、可溯源的长期经验资产
- **IP / MAC 监控** — ARP 定时采集，新 IP / MAC 变更 / IP 复用异常检测，白名单排除，CSV 导出

## 📥 下载安装

到 [Releases](https://github.com/HaoNan-0331/linkpivot/releases) 下载最新 `Setup.x.x.x.exe`（Windows x64，NSIS 安装包），双击安装即可。

所有数据（设备资料 / 凭证 / 知识库 / 监控记录）存储在本地 SQLite 数据库，无需服务端。

## 🚀 快速上手

**首次启动没有默认账号**——应用会引导你创建自己的管理员账号：

1. 首次打开应用，进入「初始化管理员」页面
2. 自定管理员用户名 + 密码（密码至少 10 位，需同时包含字母和数字）
3. 创建后进入登录页，用该账号 + 验证码登录

> 登录连续失败 5 次将锁定 5 分钟；管理员密码强度要求是应用的安全策略，请妥善保管。

## 📖 功能说明

应用主界面分为以下模块：

### 网络拓扑
可视化画布展示全网拓扑：添加设备后可通过 SSH 自动发现（AI 分析 ARP / 路由 / 接口数据推断连接关系），也可手动连线；设备节点可直接发起远程连接。

### 设备管理
设备台账：录入设备信息（IP / 厂商 / 型号 / 备注）与登录凭证（SSH / Telnet / Web / RDP）。凭证加密存储，界面上只显示脱敏形式。每台设备可一键打开对应类型的远程连接（SSH / Telnet 独立终端窗口，RDP 远程桌面，Web 浏览器）。

### IP / MAC 管理
- **ARP 采集**：从网络设备定时采集 ARP 表（支持单设备 / 全网采集）
- **异常检测**：自动识别新 IP 接入、MAC 变更、IP 复用并告警；首次扫描自动建立基线，之后新出现的 IP 才计入告警；支持排除白名单（单 IP / CIDR / 通配符）；告警可逐条或批量确认
- **网段管理**：维护网段与 OUI 厂商识别
- **CSV 导出**：ARP 表与异常记录导出

### AI 助手
自然语言对话式运维：描述问题，AI 结合设备信息分析并可直接在指定设备上执行命令。**安全机制**：所有命令强制过白名单校验（分隔符注入拦截 + 黑名单 + 首词严格匹配），高危命令弹窗二次确认；对话可一键总结沉淀为知识库经验。

### 知识库
- **文档**：上传 PDF / DOCX 自动分章节解析，全文检索
- **经验**：AI 运维对话沉淀的长期经验资产（分类 / 等级 / 标签 / 设备关联 / 有效期），对话时 AI 自动检索相关经验辅助回答；支持手动编辑、标失效与恢复

### 日志审计
AI 命令执行日志全量审计：完整记录每条命令的输入输出与结果，可追溯。

### 设置
系统配置与账号管理。

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
