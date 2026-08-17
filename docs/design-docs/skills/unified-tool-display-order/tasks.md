# 实施任务清单

> 由 spec.md 生成  
> 任务总数: 2  
> 核心原则: 先统一公共排名与消费入口，再补齐三处展示顺序的回归测试

## 依赖关系总览

Task 1（统一工具展示顺序）
  ↓
Task 2（补充顺序一致性回归测试） ← 依赖 Task 1

## 变更影响概览

### 文件变更清单

| 文件 | 操作 | 涉及任务 | 说明 |
|------|------|---------|------|
| `src/features/skills/utils/tool-logo.ts` | 修改 | Task 1 | 调整公共展示顺序前四名 |
| `src/features/skills/components/SkillCard.tsx` | 修改 | Task 1 | 合并工具后统一排序，供摘要和标签共用 |
| `src/tests/skills/skill-card.test.tsx` | 修改 | Task 2 | 验证摘要、图标和启用标签顺序一致 |
| `src/tests/skills/skill-source-view.test.ts` | 修改 | Task 2 | 验证来源工具使用新公共顺序 |

### 受影响接口

| 接口 | 变更类型 | 调用方 | 涉及任务 |
|------|---------|--------|---------|
| `getToolDisplayRank(toolName)` | 行为调整，签名不变 | `SkillCard`、`listSkillSourceTools` | Task 1 |
| `ToolSyncPanel.tools` | 输入内容改为已排序副本，类型不变 | `SkillCard` | Task 1 |

### 构建系统变更

- 无。

## 风险与假设

| # | 描述 | 影响任务 | 假设/处理 |
|---|------|---------|----------|
| 1 | “只调整前面几个”未逐项说明第五名后的绝对位置 | Task 1, 2 | 仅把 `Claude Code、Codex、Cursor、OpenCode` 提到前四名，其余保持当前相对顺序 |
| 2 | 未登记工具没有公共排名 | Task 1, 2 | 沿用现有名称排序兜底，不改变兼容行为 |

## 任务列表

### 任务 1: [~] 统一工具展示顺序

- 文件: `src/features/skills/utils/tool-logo.ts`（修改）, `src/features/skills/components/SkillCard.tsx`（修改）
- 依赖: 无
- spec 映射: 2. 目标，3.1 功能性需求，3.2 非功能性需求，4.1 方案概览，4.3 核心逻辑实现
- 说明: 调整公共展示顺序前四名，并让 SkillCard 的完整工具数组在传入摘要与 ToolSyncPanel 前统一排序。
- context:
  - `src/features/skills/utils/tool-logo.ts:TOOL_DISPLAY_ORDER` — 公共展示排名数据源
  - `src/features/skills/utils/tool-logo.ts:getToolDisplayRank()` — 排名查询接口
  - `src/features/skills/components/SkillCard.tsx:compareToolsByDisplayOrder()` — 现有排序比较器
  - `src/features/skills/components/SkillCard.tsx:SkillCard()` — 合并工具状态并向摘要、ToolSyncPanel 分发数据
  - `src/features/skills/utils/skill-source-view.ts:listSkillSourceTools()` — 来源筛选对公共排名的下游消费方
  - `src/features/skills/components/ToolSyncPanel.tsx:ToolSyncPanel()` — 完整工具数组的下游消费方
- 验收标准:
  - [ ] `npm run build` 通过且无新 warning
  - [ ] 公共排名前四名依次为 `Claude Code、Codex、Cursor、OpenCode`
  - [ ] 第五名及之后保持原有相对顺序
  - [ ] 排序不原地修改 props 或工作区状态数组
  - [ ] Code Review PASS
- 子任务:
  - [x] 1.1: 调整 `TOOL_DISPLAY_ORDER` 前四项并移除后续重复项
  - [x] 1.2: 对合并后的 Skill 工具数组应用现有比较器
  - [ ] 1.3: 运行格式化、类型检查和相关静态检查

### 任务 2: [~] 补充顺序一致性回归测试

- 文件: `src/tests/skills/skill-card.test.tsx`（修改）, `src/tests/skills/skill-source-view.test.ts`（修改）
- 依赖: Task 1
- spec 映射: 3.1 功能性需求，7.1 单元测试，7.2 集成测试
- 说明: 覆盖来源筛选、卡片摘要/图标和“启用到工具”标签的新前四名顺序，并保留现有交互断言。
- context:
  - `src/tests/skills/skill-card.test.tsx:keeps expanded enabled tools in a stable shared order` — 卡片摘要现有顺序测试
  - `src/tests/skills/tool-sync-panel.test.tsx` — ToolSyncPanel 交互测试参考
  - `src/tests/skills/skill-source-view.test.ts:listSkillSourceTools` — 来源工具排序测试入口
  - `src/features/skills/components/SkillCard.tsx:SkillCard()` — 被测上游排序逻辑
  - `src/features/skills/components/ToolSyncPanel.tsx:ToolSyncPanel()` — 被测标签渲染下游
- 验收标准:
  - [ ] `npm test -- src/tests/skills/skill-card.test.tsx src/tests/skills/skill-source-view.test.ts` 全部通过
  - [ ] 测试明确断言 `Claude Code、Codex、Cursor、OpenCode` 的相对顺序
  - [ ] 测试覆盖至少一个第五名后的工具，验证其仍排在前四名之后
  - [ ] `npm run build` 通过且无新 warning
  - [ ] Code Review PASS
- 子任务:
  - [x] 2.1: 更新卡片摘要旧顺序期望
  - [x] 2.2: 增加启用标签 DOM 顺序断言
  - [x] 2.3: 增加来源工具顺序断言
  - [ ] 2.4: 运行定向测试与完整构建

## Spec 覆盖映射

| Spec 章节 | 任务 | 说明 |
|-----------|------|------|
| 2. 目标 | Task 1 | 实现统一前四名及其余顺序不变 |
| 2.1 非目标 | Task 1, 2 | 通过最小实现与定向测试控制范围 |
| 3.1 功能性需求 | Task 1, 2 | 实现并验证三处展示顺序一致 |
| 3.2 非功能性需求 | Task 1 | 保持接口兼容且不修改状态源数组 |
| 4.1 方案概览 | Task 1 | 复用现有公共排名与数据流 |
| 4.2 组件设计 | Task 1 | 保持模块职责和接口不变 |
| 4.3 核心逻辑实现 | Task 1 | 调整排名并统一排序入口 |
| 4.4 方案优劣分析 | Task 1 | 采用局部前端展示变更 |
| 5. 备选方案 | Task 1 | 不改后端、不全面重排 |
| 7. 测试计划 | Task 2 | 覆盖来源、摘要、图标和标签 |
| 8. 可观测性与运维 | Task 1 | 无配置、数据迁移或新增观测项 |
