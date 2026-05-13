<p align="center">
  <img src="src-tauri/icons/icon.png" width="150" alt="SkillDock" />
</p>

<h1 align="center">SkillDock</h1>

<p align="center">
  一个 macOS 应用，统一管理 AI Skills、MCP Servers、Git 更新和 Coding Agent 同步状态。
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-blue" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20now%20%7C%20Windows%20planned-lightgrey" />
  <img alt="Preview" src="https://img.shields.io/badge/source-closed%20preview-lightgrey" />
</p>

## 它能做什么

SkillDock 是面向 AI Coding 工具的桌面管理台。它把本地 Skills 和 MCP 配置集中展示、编辑和同步，让你不再手动在多个工具目录之间复制文件。

- **Skills 管理** — 安装、更新、删除、编辑、查看和同步本地 skills。
- **完整 Git 工作流** — Git 来源的 skill 会保留为真实仓库，支持远端更新检测、本地修改检测、待推送状态，以及更新和推送前预览。
- **市场安装** — 从 `skills.sh`、`skillsmp` 等来源浏览并安装 skills。
- **Git 和本地导入** — 从 GitHub、GitLab、Gitee 等兼容仓库，或已有本地目录安装 skills。
- **多工具同步** — 将 skills 应用到内置 Coding Agent / IDE 工具目录，不需要手动复制。
- **MCP 管理** — 浏览、导入、编辑、启用、停用、同步和查看 MCP server 配置。
- **MCP tools 探测** — 探测 MCP server 暴露的 tools，并追踪配置是否可用。

## Skills

查看所有已安装 skill，按状态筛选，检查来源信息，并一眼看到 Git 协作状态。

![Skills 列表](docs/images/skill_list.png)

![Skill 详情和工具同步](docs/images/skill_detail.png)

SkillDock 会保留每个 skill 的来源和工具启用状态。团队维护的 skill 可以继续关联上游仓库，同时按需同步到 Claude Code、Codex、Cursor、Gemini CLI、Windsurf 等工具。

## MCP

MCP server 和 skills 放在同一个工作台中管理。SkillDock 会扫描受支持应用的配置文件，展示 server 命令、来源和 tools，并允许按工具启用或停用同步。

![SkillDock MCP 列表](docs/images/mcp_list.png)

![MCP 详情和 tools](docs/images/mcp_detail.png)

## 工具

SkillDock 会检测受支持的 Coding 工具，展示每个工具的 Skills 路径和 MCP 配置路径，并集中管理同步目标。

![支持的工具](docs/images/tools_list.png)

## 安装

从市场源、Git 仓库或本地目录安装 skills。MCP 市场也被独立拆分出来，便于按 MCP server 生命周期安装和管理。

![从市场安装 Skills](docs/images/skill_install.png)

![安装 MCP Servers](docs/images/mcp_install.png)

## 设置

配置应用存储目录、默认编辑器、更新检查、默认安装行为和工具支持状态。

![SkillDock 设置](docs/images/settings.png)

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

- [ ] 公开安装包。
- [ ] 更清晰的 skill 状态：可更新、本地已修改、待推送、冲突。
- [ ] 更完整的 MCP 生命周期：安装、参数配置、tools 探测、跨工具同步。
- [ ] 更好的 Git 流程：分支选择、团队仓库回推、PR/MR 交接。
- [ ] macOS 工作流稳定后支持 Windows。

## 源码说明

SkillDock 当前以闭源预览版形式发布。

源码是否开放会在首个公开版本稳定后再决定。
