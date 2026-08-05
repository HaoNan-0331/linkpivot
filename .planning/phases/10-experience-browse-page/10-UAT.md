---
status: testing
phase: 10-experience-browse-page
source: [10-01-SUMMARY.md, 10-02-SUMMARY.md, 10-03-SUMMARY.md, 10-VERIFICATION.md, 10-REVIEW.md]
started: 2026-08-05
updated: 2026-08-05
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

number: 19
name: Phase 9 不回归
expected: |
  ReviewConfirmModal 正常 + validateDraft 单一来源 + 查看原始会话链路
awaiting: user response

## Tests

### 1. 冷启动 + v10 迁移
expected: kill Electron → npm run dev → 应用启动无错；迁移 v10 跑通（severity 列添加）；知识库页 Tabs 可加载。
result: pass（dev server 日志确认：build + vite ready + electron main + DB init 802ms + kb_chunks_fts integrity-check OK，无报错）

### 2. Tabs 改造（BROWSE-01）
expected: 知识库页顶部见 AntD Tabs「文档 | 经验」；默认「文档」Tab；切「经验」首次懒加载 ExperienceTab；路由/侧边栏不变。
result: pass（用户反馈总体很好）

### 3. 列表 Table 9 列 + severity Tag 语义色
expected: 经验 Tab 列表 9 列齐全；severity Tag 色正确；非 troubleshooting 显「—」灰；标题蓝字。
result: pass

### 4. 关联设备列 + 状态 Tag
expected: 关联设备列有关联显「N 台」，无关联显灰 Tag「全局」；状态 Tag 有效=绿/失效=灰（不染红）。
result: pass

### 5. 关键词搜索
expected: 搜索框输入标题/正文关键词，回车或防抖后列表只显 LIKE 命中条目；清空恢复全量。
result: pass

### 6. 分类/严重度/状态筛选（含 CR-02 专项）
expected: 分类/严重度/状态 Select 各自筛选生效；CR-02 历史 fallback 一致性。
result: issue
reported: "状态筛选 + 「显示已失效」Switch 逻辑 bug：(a) 配置筛选有效时，开启显示已失效能看到无效信息；(b) 筛选无效时，无法筛选出无效信息，开关开/关都不显示失效；(c) 期望设计：筛选无效信息时自动开启显示已失效开关。"
severity: major
root_cause: "ExperienceTab.tsx: `status` Select 与 `includeInvalid` Switch 解耦为两个独立 state。失效经验 status 列仍是 'published'（invalidate 不动 status，只落 invalid_at bi-temporal），选「已失效」传 status='invalid' 查不到；且 includeInvalid 默认 false → service 加 `WHERE invalid_at IS NULL OR invalid_at > now` 把失效全过滤。根因双层：(1) 状态 Select「已失效」语义与 bi-temporal 不匹配（应筛 invalid_at<=now 而非 status='invalid'）；(2) Switch 与状态不联动，选「已失效」不自动开 includeInvalid。"

### 7. 设备多选 + 标签多选筛选
expected: 设备/标签 Select mode=multiple 选 2+ OR 命中任一。
result: pass（设备 Select 多选生效——但候选只含 ssh/telnet 设备，见问题 1）

### 8. 「显示已失效」Switch
expected: Switch 默认 off（仅有效）；打开 on → 失效条目出现；关闭 → 失效条目剔除。
result: issue（与测试 6 同根因：Switch 与状态 Select 解耦，且选「已失效」时不联动开启——并入测试 6 修复）

### 9. 手动新增（BROWSE-03）
expected: 点「新增经验」→ Modal（width 640，footer「保存」）；质量门禁用；填齐保存成功；直 published。
result: pass

### 10. 关联设备保存（relateDevices 修复验证）
expected: 手动新增时关联设备 Select 选 2 台设备 → 保存 → 列表该条关联设备列显「2 台」。
result: pass（保存功能 ok——relateDevices 第二参回传 + diff 同步生效）
note: 关联设备候选只显 ssh/telnet 设备（设计限制，见问题 1）

### 11. 手动编辑（预填 + 关联设备 diff）
expected: 点「编辑」→ Modal 预填；改字段 + 关联设备 2→3 台 → 保存 → 列表更新。
result: pass（编辑 + diff 同步 ok）
note: 标签输入 UX 待优化（见问题 3）

### 12. 标失效（软）
expected: Popconfirm 软确认 + 状态变灰「已失效」+ 默认视图剔除。
result: pass

### 13. 恢复有效
expected: 「恢复有效」按钮 → restore → 状态回绿。
result: pass

### 14. 物理删除（硬）
expected: Popconfirm 硬不可恢复 + danger 红 + 列表移除。
result: pass

### 15. 详情 Modal（SC5）
expected: width 900 footer null；元数据齐全；正文 pre-wrap 滚动；troubleshooting attrs 块；底部三按钮。
result: pass

### 16. 来源会话回链
expected: AI 沉淀经验点「查看原始会话」→ SessionMessagesModal 叠层；手动录入无按钮。
result: pass

### 17. draft 不进浏览页
expected: Phase 9 draft 在浏览页不可见。
result: skipped
reason: "用户未产生 draft 样本（前端 filter r.status !== 'draft' 已在代码确认）"

### 18. 时间显示（WR-05 formatTs 专项）
expected: yyyy-MM-dd HH:mm 格式，无 ISO T/Z/毫秒异常。
result: pass（用户未报时间异常 —— formatTs slice(0,16) 对 'yyyy-MM-dd HH:mm' 字符串生效；但 WR-05 仍记：若 DB 返回 ISO 'T' 格式会显异常，code review 警告未消除，建议 gap plan 一并补 formatTs 兼容 ISO）

### 19. Phase 9 不回归
expected: ReviewConfirmModal 正常 + validateDraft 单一来源 + 查看原始会话链路。
result: pass（用户反馈总体很好，Phase 9 链路正常）

## Summary

total: 19
passed: 16
issues: 1
pending: 0
skipped: 1

## Gaps

```yaml
- truth: "状态筛选应正确返回失效经验，且选「已失效」时自动开启显示已失效"
  status: failed
  reason: "User reported: 状态=已失效 查不到失效经验；开关开/关都不显示；期望选「已失效」自动开 Switch"
  severity: major
  test: 6
  root_cause: "status Select 与 includeInvalid Switch 解耦；失效经验 status 列仍 'published'（bi-temporal invalid_at），选「已失效」传 status='invalid' 查不到 + includeInvalid=false 把失效过滤"
  artifacts:
    - src/components/knowledge/ExperienceTab.tsx
    - electron/services/experienceService.ts
  missing:
    - "状态 Select「已失效」语义改为筛 invalid_at<=now（非 status='invalid'）"
    - "选「已失效」自动 setIncludeInvalid(true)；选「有效」自动 setIncludeInvalid(false)"
    - "service listExperiences 加 invalidOnly 选项 或 renderer 过滤 invalid_at<=now"
    - "状态 Select 与 Switch 联动单向同步（Switch 仍可独立 toggle）"

- truth: "经验应能关联所有类型设备（不只 ssh/telnet）"
  status: design
  reason: "User reported: 关联设备仅 ssh/telnet，但经验应含所有设备。根因两层：(1a) ExperienceEditForm.tsx:107 filter connectionType==='ssh'||'telnet'（手动 CRUD 候选受限）；(1b) ai 助手聊天设备勾选也限 ssh/telnet（上游 Phase 8/9 限制）。"
  severity: design
  test: 10
  root_cause: "ExperienceEditForm.tsx:107 device.list().filter(ssh||telnet)（注释 T-10-08 mitigation 沿用 Phase 9）；上游 ai 助手聊天模块设备选择同样限制（非 ssh/telnet 不能连接设备→排除勾选）"
  artifacts:
    - src/components/knowledge/ExperienceEditForm.tsx
  missing:
    - "1a（Phase 10 内）：ExperienceEditForm 放开 device filter，手动 CRUD 可关联所有设备"
    - "1b（新需求）：ai 助手聊天模块放开设备勾选范围，非 ssh/telnet 设备可勾选（只聊天+查资料库+总结经验，不连接）——产品设计变更，建议独立 phase/milestone item"

- truth: "标签输入应可复用已有标签（下拉已有标签供选择/引用，无匹配再新建）"
  status: enhancement
  reason: "User reported: 标签每次新建，搜索框应显示已有标签供复用。当前 Select mode='tags' 未传 options（纯新建模式）。"
  severity: enhancement
  test: 11
  root_cause: "ExperienceEditForm 标签 Select mode='tags' 未聚合已有标签作 options；需拉取所有经验 tags 聚合 + 传入，用户输入时下拉匹配可复用"
  artifacts:
    - src/components/knowledge/ExperienceEditForm.tsx
    - 新增 service 聚合接口（或复用 listExperiences 聚合 tags）
  missing:
    - "讨论后处理（用户明确：需讨论再做）"
    - "方案：listExperiences 拉 tags 聚合 / 新增 experience:listTags 接口 → Select options"
```
