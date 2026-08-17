# Feature: 统一 Skill 工具展示顺序

**作者**: Codex  
**日期**: 2026-08-17  
**状态**: Quick Draft

---

## 1. 背景 (Background)

### 1.1 问题描述

- Skill 来源筛选、Skill 卡片已启用工具摘要和“启用到工具”标签使用的排序逻辑不完全一致，同一组工具会以不同顺序展示。
- 当前前几名工具的顺序也不符合期望，需要调整为 `Claude Code → Codex → Cursor → OpenCode`。

### 1.2 现状分析

- `src/features/skills/utils/tool-logo.ts` 维护 `TOOL_DISPLAY_ORDER`，来源筛选与卡片摘要通过 `getToolDisplayRank` 使用该顺序。
- `src/features/skills/components/SkillCard.tsx` 仅对已启用工具摘要应用 `getToolDisplayRank`，传给 `ToolSyncPanel` 的完整工具数组仍沿用上游顺序。
- `src/features/skills/components/ToolSyncPanel.tsx` 直接渲染 `SkillCard` 传入的工具数组，因此当前标签顺序与摘要不一致。

### 1.3 主要使用场景

- 用户在 Skills 页面切换工具来源时查看工具列表。
- 用户查看 Skill 卡片上的已启用工具摘要与图标。
- 用户展开 Skill 详情，在“启用到工具”区域查看或切换工具状态。

## 2. 目标 (Goals)

- 上述三处统一按同一份工具展示顺序渲染。
- 前四名固定为 `Claude Code → Codex → Cursor → OpenCode`。
- 第五名及之后保持当前 `TOOL_DISPLAY_ORDER` 的相对顺序不变。

### 2.1 非目标 (Non-Goals)

- 不重排第五名及之后的工具。
- 不改变工具安装状态、Skill 启用状态或后端返回顺序。
- 不调整样式、交互、文案或工具图标。
- 不修改“工具”设置页中与默认打开工具相关的独立排序语义。

## 3. 需求细化 (Requirements)

### 3.1 功能性需求

- 更新公共展示顺序的前四名。
- “启用到工具”标签在渲染前应用公共展示顺序。
- 开关工具后保持标签位置稳定，不因状态变更恢复为上游顺序。
- 未登记工具继续使用名称作为稳定兜底顺序。

### 3.2 非功能性需求

- 兼容现有 `SkillToolSyncStatus[]` 数据结构和交互接口。
- 排序只作用于展示副本，不原地修改 props 或工作区状态数组。
- 不引入新的持久化配置、异步流程或运行时依赖。

## 4. 设计方案 (Design)

### 4.1 方案概览

- 继续以 `tool-logo.ts` 中的 `TOOL_DISPLAY_ORDER` 作为展示顺序的唯一数据源，只微调其前四项。
- 来源筛选和卡片摘要沿用现有 `getToolDisplayRank` 调用链；工具同步面板在本地展示副本上应用相同排名。
- 数据流保持为“工作区状态 → SkillCard/ToolSyncPanel → 排序后的展示数组”，排序不回写业务状态。

### 4.2 组件设计 (Component Design)

#### 4.2.1 核心类/模块设计

- `tool-logo.ts`：拥有工具展示排名数据与排名查询函数。
- `SkillCard.tsx`：合并 Skill 状态与已安装工具后统一排序，并把同一个有序数组提供给摘要与 `ToolSyncPanel`。

#### 4.2.2 接口设计

- 不新增或修改对外接口；继续使用 `getToolDisplayRank(toolName)`。

#### 4.2.3 数据模型

- N/A：不新增数据结构或持久化字段。

#### 4.2.4 并发模型

- N/A：不改变现有 React 状态与异步切换流程。

#### 4.2.5 错误处理

- N/A：纯展示排序不会产生新的失败模式；未知工具按名称兜底。

### 4.3 核心逻辑实现

- 将公共顺序前缀调整为 `claude-code, codex, cursor, opencode`，移除这些工具在原数组后续位置的重复项。
- 在 `SkillCard` 中对 `mergeSkillToolsWithInstalledTools` 返回的新数组排序，摘要与 `ToolSyncPanel` 共用排序结果。
- 排名相同时按工具名称排序，保证未知工具展示稳定。

### 4.4 方案优劣分析

- 优点：改动局部、复用现有排名数据，不影响业务状态和后端。
- 局限：各展示组件仍需显式选择是否应用展示排名；新增展示位置时需要复用相同规则。

## 5. 备选方案 (Alternatives Considered)

- 在后端统一重排工具数组：会把 UI 展示语义下沉到数据层，并可能影响其他调用方，不采用。
- 全面按新的流行度榜单重排：超出用户提出的“只微调前面几个”范围，不采用。

## 6. 业界调研 (Industry Research)

### 6.1 业界方案

- N/A：本需求为项目内展示一致性修正，无需外部方案调研。

### 6.2 对比分析

- N/A。

## 7. 测试计划 (Test Plan)

### 7.1 单元测试

- 验证公共排名前四名为 `Claude Code、Codex、Cursor、OpenCode`。
- 验证 ToolSyncPanel 即使收到乱序工具，也按公共顺序渲染。
- 验证未知工具排名相同时按名称稳定排序。

### 7.2 集成测试

- 验证 SkillCard 的已启用工具无障碍标签与折叠图标使用新顺序。
- 验证工具启用/关闭交互及批量操作保持原有行为。

### 7.3 性能测试（如适用）

- N/A：工具数量为小规模固定列表，仅增加一次内存排序，无独立性能测试必要。

## 8. 可观测性 & 运维 (Observability & Operations)

### 8.1 可观测性

- N/A：纯前端展示调整，不新增日志、指标或告警。

### 8.2 配置参数 (Configuration)

- N/A：不新增配置。

### 8.3 运维接口 (Operations Interfaces)

- N/A：不新增命令或接口。

### 8.4 运维注意事项 (Operations Considerations)

- 可直接随前端版本发布；回滚代码即可恢复旧顺序，无数据迁移。

## 9. Changelog

| 日期 | 变更内容 | 作者 |
|------|----------|------|
| 2026-08-17 | 创建 Quick Draft，确认前四名及统一展示范围 | Codex |

## 10. 参考资料 (References)

- 用户提供的 Skills 页面截图与顺序确认。
