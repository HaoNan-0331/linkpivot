# SEC-04 Pre-Release Hardening 甄别登记表（L1/L2/L3/L4/L6）

**Phase:** 13 (security-hardening-cluster) / **Plan:** 13-02 (SEC-04)
**登记日期:** 2026-08-09
**甄别依据:** D-13-4（researcher/planner 据审计 28 findings + 实际代码核对，判定「已满足 / 改动伤三红线 / 成本远超收益」则显式 defer 登记，不照单全修，学 Phase 14 FIX-02 甄别模式）
**SC2 硬要求:** 5 项无静默跳过，每项要么 FIXED 要么 DEFER 含 reason + 重评估条件。

原始来源：p9e `260726-p9e` 发版时显式排除这 5 项归「发版后迭代」（`.planning/quick/260726-p9e-pre-release-hardening-bump-0-1-2/260726-p9e-SUMMARY.md:142`），health audit §1.2 列为 medium 优先安全相关。

---

## L1

**删弱 SSH 算法**（group1-sha1 / group14-sha1 / diffie-hellman-group-exchange-sha1 / 3des-cbc / blowfish-cbc / ssh-dss 等）

- **结论：DEFER**
- **佐证：**
  - `electron/utils/sshConfig.ts:11-39` `SSH_ALGORITHMS` 全保留弱算法（kex 含 diffie-hellman-group1-sha1 / group14-sha1 / group-exchange-sha1；cipher 含 3des-cbc / blowfish-cbc；serverHostKey 含 ssh-dss），头部注释「宁可列宽不可漏连各种厂商/老型号设备」明示设计意图
  - 全仓 4 处 SSH 路径全量复用此常量零 drift：`electron/services/ai.ts:306-322 buildSSHConfig` / `electron/services/arpCollector.ts:68 executeSSH` / `electron/services/connection.ts connectSSH` + `testSSHConnection`（13-01 SEC-03 已落地）
- **审计引用：** `260726-p9e-SUMMARY.md:142`「L1 弱 SSH 算法」排除清单
- **reason：** D-13-1 锁定——运维兼容性优先。CLAUDE.md「设备安全可控是最高优先级」+ `sshConfig.ts:9-10` 注释「运维工具需连各种厂商/老型号设备，宁可列宽不可漏」。删弱算法有连不上老设备风险（group1-sha1 / ssh-dss / 3des-cbc 仍是部分老思科/H3C/华为设备的唯一支持项），与核心价值「设备安全可控」直接冲突。与 13-01 SEC-03 plan 同 defer 策略（T-13-01-02 / T-13-02-02 accept）。
- **重评估条件：** 未来设备清单（实测全设备清单）确认无老算法依赖（全设备支持 curve25519-sha256 / rsa-sha2-256 / aes128-gcm 等现代算法）时可重评估从 SSH_ALGORITHMS 删除弱算法项。需配套真机 HV 验证全清单设备仍可连。

---

## L2

**AI 调用限流**（messages 数量 / token / 频率 / 并发上限）

- **结论：DEFER**
- **佐证：**
  - `electron/main.ts:192` `ai:chat` 已 `secure` 包装（登录后特权通道，未登录直接 reject）
  - `electron/services/ai.ts:324-336 executeCommandsOnDevice` 内 `isCommandAllowed` 红线③强制（line 334 任何未经白名单通过的命令直接拒绝），同执行链 `ai.ts:890` 第二处 isCommandAllowed 守卫
  - `grep -rn "MAX_MESSAGES\|MAX_TOKENS\|rateLimit\|throttle" electron/services/ai.ts electron/main.ts` 命中 0——确认无 messages/token/频率/并发限流
- **审计引用：** `260726-p9e-SUMMARY.md:142`「L2 ai limit」排除清单（仅标签）；审计 28 findings 无独立 L2 finding 描述具体限流要求
- **reason：**
  1. 命令执行安全层（`commandSafety.isCommandAllowed` 红线③）已强制——AI 限流即使加也无法绕过命令安全层，AI 触发的任何远程命令必须经白名单校验
  2. 单机单用户桌面（CLAUDE.md「单机单用户场景」+ `auth.ts:7` 注释），用户自己用自己 API Key，不存在恶意客户端 DoS 自己或平台滥用的经济动机
  3. AI 调用成本由用户自付（自有 LLM API Key），无平台成本失控面
- **重评估条件：**
  1. 若未来转多用户/云部署形态（多人共享后端）→ 必须加 messages.slice 截断 + token 预算 + 频率限流防 context 溢出与滥用
  2. 若审计新增独立 L2 finding 描述具体限流要求（如「单次 chat messages 上限防 context overflow」）→ 重评估加 `MAX_MESSAGES` 截断

---

## L3

**captcha 加固**（文本 CSPRNG / 字符集 / TTL / 防重放）

- **结论：FIXED（核心已满足）+ renderSvg Math.random DEFER**
- **佐证：**
  - `electron/services/auth.ts:12-20 generateCaptcha` 文本用 `crypto.randomInt`（CSPRNG 非 Math.random，line 16）+ 4 位去歧义字符集 `'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'`（line 13，无 0/O/1/I）+ 5min TTL（`expires: Date.now() + 5 * 60 * 1000`，line 18）
  - `electron/services/auth.ts:22-28 verifyCaptcha` 一次一删防重放（line 25 过期删 + line 26 验证前删，verifyCaptcha 无论成功失败都 delete key）
- **审计引用：** `260726-p9e-SUMMARY.md:142`「L3 captcha」排除清单
- **reason：**
  - **核心已满足（FIXED）：** captcha 文本生成是安全敏感路径（攻击者需预测文本才能绕过 captcha 暴力破解登录），已用 CSPRNG（`crypto.randomInt`）+ 防重放（一次一删）+ TTL 过期三重防护
  - **renderSvg Math.random DEFER：** `electron/services/auth.ts:77-85 renderSvg` 用 `Math.random` 做 SVG 干扰线坐标 / 字符位置 / 颜色随机化——非安全敏感路径（仅 SVG 视觉干扰，文本已 CSPRNG 生成；攻击面在 captcha 文本可预测性，不在 SVG 噪声坐标），改用 `crypto.randomInt` 无安全收益
- **重评估条件（renderSvg Math.random）：** 若未来审计 finding 明示 SVG 噪声坐标可预测导致 OCR 攻击面（理论不存在，因噪声不参与文本生成），重评估 renderSvg 改 CSPRNG

---

## L4

**Login 加固**（captcha 前置 / 失败锁定 / 通用错误消息 / 口令强度）

- **结论：FIXED（核心已满足）**
- **佐证：**
  - `electron/services/auth.ts:37-58 login`：
    - captcha 前置（line 38 `verifyCaptcha` 先验，错则返「验证码错误」）
    - 失败计数锁定（line 40-43 `lockedUntil > Date.now()` 返「登录失败次数过多，请 5 分钟后再试」+ line 48-52 count++ 达 `MAX_ATTEMPTS=5` 置 `LOCK_MS=5min`）
    - 通用错误消息（line 53「用户名或密码错误」不区分用户存在性，防用户枚举）
  - `electron/services/auth.ts:30-35 validatePasswordStrength`：≥10 位 + 字母数字混合策略；`initAdmin:64-75` 用此策略
  - `electron/main.ts:153-160` auth:* 全 `safe` 包装（getCaptcha/login/isFirstRun/initAdmin 四 channel，260726-w67 已修审计 finding 6）
- **审计引用：** `260726-p9e-SUMMARY.md:142`「L4 Login」排除清单；审计 finding 6（auth:* IPC 异常脱敏）已由 quick 260726-w67 修
- **reason：** login 锁定（5 次失败锁 5min）+ captcha 前置 + 口令强度（≥10 位+字母数字）+ 通用错误消息（不区分用户存在性）+ auth:* safe 包装（异常脱敏防内部细节泄露）五项全已就位，核心加固已满足。
- **潜在加固 DEFER（接受残余风险）：**
  - 失败计数内存态不跨重启（`failedAttempts` Map 进程重启重置，攻击者重启应用可重置计数）——单机单用户桌面（`auth.ts:7` 注释「单机单用户场景足够」），无多用户/网络滥用面；且重启需本机物理/系统权限，能重启者已有更高级权限，内存态失败计数重启重置可接受
  - 无 IP 级限流——单机无 IP 概念（全部 127.0.0.1 本地 IPC），不适用
- **重评估条件：** 若未来转多用户/网络部署形态，需将失败计数持久化（users 表加 failed_count / locked_until 列）+ 引入 IP 级限流

---

## L6

**authGuard 加固**（secure/safe 包装未登录拒绝 + 异常脱敏）

- **结论：FIXED（核心已满足，本 plan Task 1 补单测确认）**
- **佐证：**
  - `electron/utils/authGuard.ts:31-41 secure`：未登录 reject 在 try 之外（line 33 `if (!authenticated) throw new Error('未登录或会话已过期')`）不被 sanitizeMessage 脱敏覆盖；已登录态 handler 抛错经 line 38 `sanitizeMessage` 脱敏后 reject
  - `electron/utils/authGuard.ts:17-24 sanitizeMessage`：路径脱敏（Windows 盘符 + Unix 通用绝对路径）+ 长度截断 200 + 空消息落「操作失败」；**本 plan Task 1 Rule 1+2 deviation 扩展**：Unix 路径正则从枚举前缀（`usr|home|Users|tmp|var|opt`）改为通用绝对路径匹配（`/[^\s'"()<>]*/`），覆盖 SQLite 等库报告的 `/app /data /root /private` 等部署路径（红线①异常脱敏实际加固，不削弱）
  - `electron/utils/authGuard.ts:44-53 safe`：仅脱敏不鉴权，供 auth:* 登录前 channel 用
  - `electron/main.ts:153-160` auth:* 全 `safe` 包装 + `electron/main.ts:192` `ai:chat` `secure` 包装（特权通道）
  - `tests/unit/authGuard.test.ts` 10 it（既有 7 + Task 1 新增 3）：secure 未登录拒绝（既有 line 10-13）+ secure 已登录返结果 + 4 个脱敏 it（Windows/Unix/超长/空消息）+ safe 脱敏 + Task 1 新增 safe 未登录不拒绝 + isAuthenticated 行为 + secure 脱敏 SQL 错误含路径
- **审计引用：**
  - finding 10「safe() 零 caller」是 doc-drift（CONCERNS.md 已证伪，现有 4 caller auth:getCaptcha/auth:login/auth:isFirstRun/auth:initAdmin 全 `safe` 包装，`main.ts:153-160`）
  - R5「安全核心零单测」由 quick 260726-vcu 修（authGuard + commandSafety 55/55 单测）
- **reason：** 260726-w67 修 auth:* safe 包装（审计 finding 6）；260726-vcu 补 authGuard 单测（R5）；本 plan 13-02 Task 1 扩展确认 safe 未登录行为（与 secure 区分）+ isAuthenticated 行为 + SQL 错误脱敏，并 Rule 1+2 加固 sanitizeMessage Unix 路径覆盖。
- **isAuthenticated 0 caller 决定保留（health §2.2 investigate 收尾）：** `authGuard.ts:12-14 isAuthenticated` 当前 0 caller（health audit §2.2 标记 investigate），经核对是预留查询入口（未来 renderer 检测登录态可暴露 `auth:check` IPC 用），非漏洞。本 plan Task 1 补单测确认行为正确（false→false / true→true）。本 phase 不引入新 IPC 保留现状——若未来有 renderer 检测登录态需求（如会话超时自动跳登录页），暴露 `auth:check` secure IPC 调用此函数即可。
- **重评估条件：** 若未来 renderer 需主动检测登录态（如长时间空闲后强制重登），暴露 `auth:check` IPC 调 isAuthenticated；若审计 finding 明示 isAuthenticated 应删（确认永不需要），重评估删除。

---

## 甄别汇总

| 项 | 结论 | 核心理由 |
|----|------|----------|
| L1 删弱 SSH 算法 | DEFER | D-13-1 运维兼容性优先（连老设备） |
| L2 ai limit | DEFER | 命令安全层红线③已强制 + 单机单用户无滥用面 + 审计无独立 finding |
| L3 captcha | FIXED（核心）+ renderSvg Math.random DEFER | 文本已 CSPRNG + 防重放；renderSvg 非安全敏感 |
| L4 Login | FIXED（核心） | captcha 前置 + 失败锁定 + 通用错误 + 口令强度 + safe 包装五项全就位 |
| L6 authGuard | FIXED（核心） | secure/safe 包装 + 异常脱敏 + 10 it 单测覆盖；本 plan 加固 sanitizeMessage Unix 路径覆盖 |

**SC2 满足确认：** 5 项逐项有明确结论（FIXED 或 DEFER）+ 代码层佐证（file:line）+ 审计引用 + reason（DEFER 项含重评估条件），无静默跳过。

**三红线（IPC secure/safe 鉴权 / 字段加密 _enc / commandSafety.isCommandAllowed）改动后仍生效确认：**
- 红线① IPC 鉴权：本 plan Task 1 仅扩展 authGuard 单测（safe 未登录不拒绝确认与 secure 区分 + isAuthenticated 行为 + SQL 错误脱敏），不改 secure/safe 鉴权逻辑（secure 未登录 reject 仍在 try 之外）；sanitizeMessage Unix 路径正则扩展是**加固**（覆盖更多路径）非削弱。既有 secure 未登录拒绝 it 保持绿（红线①不可回退有回归网兜底）
- 红线② 字段加密：本 plan 零改动 _enc/encField/decField 路径
- 红线③ commandSafety：本 plan 零改动 commandSafety.isCommandAllowed 路径（L2 甄别佐证其仍强制）

---

*Generated: 2026-08-09 by Plan 13-02 executor*
