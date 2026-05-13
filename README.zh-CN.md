<p align="center">
  <img src="src-tauri/icons/icon.png" width="160" alt="SkillDock" />
</p>

<h1 align="center">SkillDock</h1>

---

<p align="center">
  一个应用，统一管理 Skills、MCP Servers、Git 更新和 Coding Agent 同步状态。
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-blue" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20now%20%7C%20Windows%20planned-lightgrey" />
  <img alt="Preview" src="https://img.shields.io/badge/source-closed%20preview-lightgrey" />
</p>

## 功能

- **Skills 管理** — 安装、更新、删除、编辑和查看本地 skills。
- **完整 Git 工作流** — 每个 Git 来源的 skill 都保留为真实仓库，支持远端更新检测、本地修改检测、待推送状态、更新预览和推送预览。
- **市场安装** — 从 `skills.sh`、`skillsmp` 等来源浏览并安装 skills。
- **Git 仓库安装** — 从 GitHub、GitLab、Gitee 等兼容仓库发现并安装 skills。
- **本地导入** — 扫描已有本地 skills 目录，并纳入 SkillDock 管理。
- **多工具同步** — 将 skills 同步到 29 个内置 Coding Agent / IDE 工具目录。
- **MCP 管理** — 浏览、安装、导入、启用、停用和同步 MCP server 配置。
- **MCP tools 探测** — 探测 MCP server 暴露的 tools，判断配置是否可用。

## Git-Aware Skills

SkillDock 不会把 Git skill 拍平成普通复制目录，而是保留完整 Git 元信息。

- 检查 skill 是否有远端更新。
- 查看本地 skill 是否有未提交修改。
- 更新前预览将要拉取的变更。
- 推送前预览将要提交的变更。
- 为团队维护的 skills 保留来源仓库信息。

## 支持的工具

Claude Code · Codex · Cursor · Windsurf · IntelliJ IDEA · OpenCode · Gemini · Antigravity · Continue · GitHub Copilot · Qwen Code · Trae · Trae CN · Cline · Roo Code · Kilo Code · Kiro · Goose · Junie · Augment · CodeBuddy · Droid · OpenClaw · CommandCode · Crush · Qoder · Zencoder · Hermes · iFlow

## 下载

安装包会发布在 [Releases](../../releases) 页面。

| 平台 | 状态 |
| --- | --- |
| macOS | 即将发布 |
| Windows | 计划支持 |

## 快速开始

1. 下载并打开 SkillDock。
2. 从市场、Git 仓库或本地目录安装 skills。
3. 为你的 Coding Agent 启用 skills 和 MCP servers。
4. 使用 Git-aware 状态查看更新、本地修改和推送预览。

## 路线图

- [ ] 公开安装包和截图。
- [ ] 更清晰的 skill 状态：可更新、本地已修改、待推送、冲突。
- [ ] 更完整的 MCP 生命周期：安装、参数配置、tools 探测、跨工具同步。
- [ ] 更好的 Git 流程：分支选择、团队仓库回推、PR/MR 交接。
- [ ] macOS 工作流稳定后支持 Windows。

## 源码说明

SkillDock 当前以闭源预览版形式发布。

源码是否开放会在首个公开版本稳定后再决定。
