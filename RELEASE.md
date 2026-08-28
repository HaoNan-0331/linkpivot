# 灵枢（LinkPivot）发布指南

> 本文档面向维护者，记录从源码到 GitHub Release 的完整发布流程。0.5.0（v1.5）首次落地并全链实测，未来版本照此复现。

## 发布流程（七步）

### 第 1 步：敏感信息检查（硬前置，公开仓库红线）

按 CLAUDE.md「GitHub 上传规范」：公开仓库扫描到敏感信息**禁止上传**。推送/发布前对增量 diff 与发布资产执行模式扫描：

- 四正则：`AKIA[0-9A-Z]{16}`（AWS AK）/ `sk-[A-Za-z0-9]{20,}`（大模型 Key）/ `BEGIN (RSA|EC|OPENSSH|DSA) PRIVATE KEY`（私钥块）/ `(password|secret|token|api_key)\s*[:=]\s*['"]...`（凭证赋值）
- 补充：`ghp_` / `github_pat_` / `xox` / `AIza`
- 边界复核：diff 零 `.planning/`、零 `release/`、零 `*.db`、零 `master.key`
- 命中分诊：测试夹具合成值（`tok-dev1`、`keep-1` 等）属既有白名单先例（2026-08-28 用户裁决）；**真实凭证模式命中 = 立即停止发布并报告用户**

### 第 2 步：version 确认 + 构建

- `package.json` 的 `version` 确认为目标版本（如 0.5.0）
- 打包前置（Windows 本机）：①停 electron:dev 实例（运行中 dev 持 better_sqlite3.node DLL 锁 → electron-rebuild EPERM）②百度云退出含隐形服务 `YunDetectService.exe` 查杀 ③后台长构建勿用管道掩盖退出码
- 执行 `npm run electron:build`（本地无 CI tag → electron-builder `isPublish=false` 不自动上传，三产物仅落 `release/`）
- 六项核验全过再进入下一步：三产物齐备 + latest.yml 三键（url/path/size 与产物逐字符一致）/ app-update.yml 四键（owner HaoNan-0331、repo linkpivot、provider github、updaterCacheDirName linkpivot-updater）/ 主程序 VersionInfo（ProductName=灵枢 码点 28789,26530、FileVersion）/ 修复特征串入 bundle + 与 asar 内同源（sha256 比对）/ asar 红线（零 .db/.bak/master.key/credential + electron-updater external 94 项基线）/ 体积区间 sanity（105–120MB）

### 第 3 步：产物名核查（名链三位一体）

`release/` 产物名 === latest.yml `files[0].url` === `path` 字段，**逐字符一致**（ASCII `nsis.artifactName: "Setup.${version}.${ext}"` 保证；0.4.0 中文名产物被 safeArtifactName 清洗链改名的坑已由此根治）。

### 第 4 步：gh release create 上传三资产

```bash
gh release create vX.Y.Z \
  "release/Setup.X.Y.Z.exe" \
  "release/Setup.X.Y.Z.exe.blockmap" \
  "release/latest.yml" \
  --title "灵枢（LinkPivot）vX.Y.Z —— <里程碑主题>" \
  --notes-file <临时中文说明文件>
```

- 三资产缺一不可：`latest.yml` 是 electron-updater 的检测源，缺它 = 全体客户端「检查更新」静默失败
- 不可用 `--draft` / `--prerelease`：draft/prerelease 对 `/releases/latest` 端点不可见，自动更新检测不到
- 网络注意：本机 gh/git 走直连（禁代理，代理 10809 会 TLS eof）
- notes 临时文件用后即删（不入库）

### 第 5 步（可选）：灰度发布

electron-builder 26 **无** `stagedRollout` 配置项；如需灰度 = **上传前**手改 `release/latest.yml` 加一行 `stagingPercentage: 10`（10% 用户可见新版；electron-updater 按 `x-user-staging-id` 机器确定性哈希分桶）。0.5.0 首版未灰度（用户基数≈0，全量直发）。

### 第 6 步：禁止发布后在 GitHub UI 改资产名（红线）

**发布后严禁在 GitHub 网页端修改 Release 资产名。** 改名即更换下载 URL，而 latest.yml 内 `url` 字段保持旧名 → 全体客户端自动更新下载 404、升级全数失败。0.4.0 时代「上传后手动改名整理」的惯例自 0.5.0 起废止——资产名在构建时已由 ASCII artifactName 定死，上传原名即终态。

### 第 7 步：发布后验证（GitHub 真链）

- `gh release view` 核对三资产名与 latest.yml `url` 逐字符一致
- `curl -I` 验证 `Setup.X.Y.Z.exe` 浏览器下载直链返回 302/200
- 装有该版本的机器：设置页 → 关于 → 「检查更新」应得「已是最新版本 vX.Y.Z」气泡（走 `/releases/latest` 真链，证明 latest.yml 挂载生效）

## 0.4.0 → 0.5.0 手动升级（鸡生蛋）

**0.4.0 用户首次升级必须手动**——0.4.0 不含 updater，且其 Release（tag v1.4）仅 `Setup.0.4.0.exe` 单资产、无 latest.yml，不存在任何自动升级路径：

1. 在可访问 GitHub 的机器下载 `Setup.0.5.0.exe`（Release 页直链），拷贝到目标机器
2. 直接运行覆盖安装（NSIS per-user 语义：**不卸载旧版**、安装路径由注册表记忆、`deleteAppDataOnUninstall: false` 保证 DB userData 不动）
3. 首次启动自动完成数据目录迁移（`%APPDATA%\网络拓扑管理工具` → `%APPDATA%\LinkPivot`，同卷原子 rename + premigration 备份）与 DB 迁移（user_version 24 → 31）

**旧版善后（重要）**：0.5.0 更换了 appId（com.linkpivot.app），旧 0.4.0 安装不会自动消失——**安装新版并确认数据完整后，请卸载旧版「网络拓扑管理工具」**；期间切勿在旧版录入新数据（旧版找不到原数据目录会新建空库，造成「数据消失」假象）。0.5.0 起后续版本升级走应用内自动更新（弹窗 → 立即升级 → 下载 → 静默安装重启），不再手动。

## 历史与产物

- 全链实测证据（Spike A 十步走查 / SC 红线 / 下载中途失败恢复 / 代理三形态分诊 / 0.5.0 六项核验）：`.planning/phases/30-auto-update/30-SPIKE-RECORD.md`（本地规划目录，gitignored）
- 0.5.0 发布实况（v1.5 收官）：tag `v0.5.0`，三资产名链三位一体核验通过，GitHub 真链检测闭环；发布前清偿 30.1 code review WR-01~03（fresh install 建目录 / 并发迁移复核 / 单实例锁）
- Release tag 惯例：`vX.Y.Z` 与应用版本一一对应（2026-08-28 用户裁决，option-a）；里程碑语义写入 Release 标题与说明
