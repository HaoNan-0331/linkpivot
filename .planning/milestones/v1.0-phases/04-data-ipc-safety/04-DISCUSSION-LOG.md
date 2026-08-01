# Phase 4: Data / IPC Safety - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-28
**Phase:** 4-Data / IPC Safety
**Areas discussed:** 分页模型选型, 默认上限与无回归

---

## 分页模型选型

### Q1 — 分页契约模型

| Option | Description | Selected |
|--------|-------------|----------|
| 上限默认+参数(推荐) | 默认行为=防御性上限(向后兼容), IPC 签名暴露 limit/offset, Phase 5 可选接翻页 UI 无需再改通道。anomaly 已是此模型(有 limit), 补 offset 统一。 | ✓ |
| 仅纯上限 maxRows | 不暴露 offset, 只截断防病态数据(如万行 ARP)。翻页留待未来(届时需再改 IPC 签名)。最简但扩展性差。 | |
| 真分页+本阶段改 UI | 4 个 Tab 现在就加翻页 UI。最完整但越界 Phase 5(前端重构)工作边界, 且本阶段 UI hint=no。 | |

**User's choice:** 上限默认+参数(推荐)
**Notes:** hybrid 模型——现在交付（默认有界）又不越界 Phase 5（翻页 UI 留前端 phase）。success criteria 字面允许"分页参数或上限"，此选项同时满足两者。决策 → D-4-1。

### Q2 — 截断信号

| Option | Description | Selected |
|--------|-------------|----------|
| 信封 rows+total(推荐) | 返回 {rows,total,truncated}, 明确告知截断。契合核心价值(设备/数据安全可控, 不静默藏 rogue 设备)。需调用方改读 .rows(属 success criteria #3 适配工作)。 | ✓ |
| 数组+静默截断 | 返回值仍 any[]。默认 cap 调高到合法数据永不触发, 仅病态数据静默截断防崩溃。最简, 但运维遇病态数据不知有隐藏行。 | |
| 数组+独立 count 通道 | 返回仍数组, 另加 xxx:getCount 通道让 UI 可选查总数比对。向后兼容但多出 4 个通道与往返调用。 | |

**User's choice:** 信封 rows+total(推荐)
**Notes:** 运维工具不可静默藏数据——截断后必须告知，否则漏看 rogue 设备违背核心价值。这是安全语义非体验。决策 → D-4-2。

---

## 默认上限与无回归

### Q1 — 默认 cap 取值策略

| Option | Description | Selected |
|--------|-------------|----------|
| 按数据尺度差异化(推荐) | getIPDetails 默认 2000(覆盖到 /22≈1022 主机); oui:getAll 默认 5000(本用户 OUI 通常数百, 全量 IEEE 40k 走 oui:search/分页); anomaly 维持默认 100(补 offset)。截断由信封告知, 无静默回归。 | ✓ |
| 统一大上限 50000 | 所有通道默认 50000, 纯防病态数据(百万行)崩溃。正常运维数据绝不截断(最保守无回归), 但单次 IPC payload 仍可能偏大。 | |
| 差异化+用户可配 | 每通道设上限且在设置页暴露可调。最灵活但引入配置项持久化/UI 复杂度(超出 DATA-01 数据安全层 scope)。 | |

**User's choice:** 按数据尺度差异化(推荐)
**Notes:** 三值基于本用户实际数据尺度（拓扑可视化单网段 /24、OUI 数百、anomaly 现状 100），非拍脑袋。"无回归"由信封兜底（truncated 告知）。决策 → D-4-3。

### Q2 — 硬性上限（limit 参数 ceiling）

| Option | Description | Selected |
|--------|-------------|----------|
| 每通道硬上限(推荐) | getIPDetails/oui:getAll 硬上限 50000(超出校验拒绝/钳制), anomaly 维持 10000。复用既有 validateLimit 先例(anomalyIpc.ts:7-11)。防 caller 传 limit=千万重新引入无界 payload。 | ✓ |
| 统一硬上限 10000 | 所有通道 limit 参数上限 10000, 与 anomaly 对齐。最严, 但未来需单次取超万行(如导出预览)会受限。 | |
| 不设硬上限 | 默认值是 cap, 但 caller 传参不限。最灵活但有被绕过重新传超大 payload 的风险(违背 DATA-01 本意)。 | |

**User's choice:** 每通道硬上限(推荐)
**Notes:** 若 caller 传参无硬上限，可传 limit=千万绕过，重新引入无界 payload 违背 DATA-01。硬上限是"payload 有界"的强制闸门，复用 anomaly validateLimit 先例。决策 → D-4-4。

---

## Claude's Discretion

用户委托、Claude 拍板的 gray area（用户保留 plan 前审阅权）：

- **export 通道归属 → D-4-5**：export:arpTable 的 IPC payload 是 CSV 文件路径（极小），不存在"超大传输"。但纳入 DATA-01——改造点在主进程内存侧：`exportARPTable` 全量读+拼巨型字符串改**流式分块写 CSV**（逐批 SELECT + 追加写文件），满足 criteria #2。导出语义=全部，不引入 limit/offset，返回形态（path）不变。
- **getIPDetails 边界策略 → D-4-6**：保持 JS 端 CIDR 过滤，分页在过滤后数组做，**不把 ipInCIDR 下推 SQL**（schema 改 + WR-04 健壮语义对齐，风险高收益低）。DB 全量读受 ip_status 表真实行数约束。⚠️ **researcher 必查** ip_status 表增长语义（TTL/清理？）。

---

## Deferred Ideas

- 翻页 UI（分页器/加载更多）→ Phase 5 前端重构
- ipInCIDR 下推 SQL / ip_status 数值列 → 若 ip_status 无界增长成真问题再评估
- cap 用户可配置（设置页）→ backlog，超 DATA-01 scope
- oui:getAll 全量 IEEE 40k 专用优化 → 本阶段靠 search+分页覆盖
- export 流式写进度回调 → 本阶段不做
