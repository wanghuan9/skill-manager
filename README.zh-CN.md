<p align="center">
  <img src="src-tauri/icons/icon.png" width="150" alt="SkillDock" />
</p>

<h1 align="center">SkillDock - AI Skills, MCP & Plugins Manager</h1>

<p align="center">
  SkillDock 是一个面向 AI Coding 工具的 skills、MCP 和插件管理工具，支持安装、查看、编辑、整理、同步和更新 skills、MCP servers 与插件包，并提供 Git-aware 更新能力，用于跟踪上游变更和本地修改。
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="#下载">下载</a> · <a href="./docs/install-troubleshooting.zh-CN.md">安装失败？</a>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-blue" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20now%20%7C%20Windows%20planned-lightgrey" />
  <img alt="Preview" src="https://img.shields.io/badge/source-closed%20preview-lightgrey" />
</p>

## 它能做什么

SkillDock 是面向 AI Coding 工具的桌面管理台。它把本地 Skills、MCP 配置和插件包集中展示、编辑，并同步到 Claude Code、Codex、Cursor、Windsurf、Gemini CLI、GitHub Copilot 等常用工具，让你不再手动在多个工具目录之间复制文件。对于 Git 来源的 skills 和插件，它会检测远端更新、本地修改和待推送状态，并支持带预览的一键更新。

核心是面向团队协作的直连工作流，不需要中转目录。发布者本地修改 skills 或插件后可以一键推送回仓库；使用者可以一键更新，并看到更新人和更新内容。

- **Skills 管理** — 安装、更新、删除、编辑、查看和同步本地 skills。
- **MCP 管理** — 浏览、导入、编辑、启用、停用、同步和查看 MCP server 配置。
- **插件管理** — 安装、启用、停用、查看、一键更新和删除插件包，并为 Git 来源插件检测本地修改和待推送状态。
- **Skill 来源分组** — 按仓库或本地来源对已安装 skills 分组，团队维护的 skill 集合更容易浏览。
- **MCP tools 探测** — 探测 MCP server 暴露的 tools，追踪配置是否可用，并支持 tools 级别的启用和停用控制。
- **Skill 安装** — 支持从 `skills.sh`、`skillsmp` 市场一键安装，也支持 Git 仓库安装、本地导入及安装。
- **MCP 安装** — 支持从 `MCP.Directory` 市场一键安装 MCP servers，并纳入共享 MCP 配置生命周期。
- **Plugin 安装** — 支持从 Git 仓库一键安装 plugins，并启用其中包含的 skills、commands、agents 和集成能力。
- **完整 Git 工作流** — Git 来源的 skills 和插件会保留为真实仓库，支持远端更新检测、本地修改检测、待推送状态，以及更新和推送前预览。
- **多工具一键同步** — 将 skills、MCP servers 和插件启用到 Claude Code、Codex、Cursor、Windsurf、Gemini CLI、OpenCode 等常用 Coding 工具，避免手动复制和修改复杂配置文件。

## Skills

查看所有已安装 skill，按来源分组、按状态筛选，检查来源信息，并一眼看到 Git 协作状态。

**Skills 列表**

![Skills 列表](docs/images/skill_list.png)

**按来源分组展示 Skills**

![按来源分组展示 Skills](docs/images/skill_groups.png)

**Skill 详情和工具同步**

![Skill 详情和工具同步](docs/images/skill_detail.png)

SkillDock 会保留每个 skill 的来源和工具启用状态。团队维护的 skill 可以继续关联上游仓库，同时按需同步到 Claude Code、Codex、Cursor、Gemini CLI、Windsurf 等工具。

## MCP

MCP server 和 skills 放在同一个工作台中管理。SkillDock 会扫描受支持应用的配置文件，展示 server 命令、来源和 tools，并允许按工具启用或停用同步。

**MCP 列表**

![SkillDock MCP 列表](docs/images/mcp_list.png)

**MCP 详情和 tools**

![MCP 详情和 tools](docs/images/mcp_detail.png)

## Plugins

查看已安装插件，按宿主工具筛选，检查来源信息，并一眼看到其中包含的 skills、agents、commands、宿主集成能力、一键更新、本地修改和待推送状态。

**插件列表**

![SkillDock 插件列表](docs/images/plugin_list.png)

**插件详情**

![插件详情、skills 和 commands](docs/images/plugin_detail.png)

## 工具

SkillDock 会检测受支持的 Coding 工具，展示每个工具的 Skills 路径和 MCP 配置路径，并集中管理同步目标。

![支持的工具](docs/images/tools_list.png)

## 安装

安装流程按类型拆分，Skill、MCP server 和 Plugin 都可以按各自生命周期安装和管理。

### Skill 安装

支持从 `skills.sh`、`skillsmp` 市场一键安装，也支持 Git 仓库安装、本地导入及安装。

**Skill 市场安装**

![从市场安装 Skills](docs/images/skill_install.png)

**Skill Git 仓库安装和本地导入**

![从 Git 仓库安装 Skills](docs/images/skill_git_install.png)

### MCP 安装

支持从 `MCP.Directory` 市场一键安装 MCP servers，并管理共享 MCP 配置与 tools 生命周期。

![安装 MCP Servers](docs/images/mcp_install.png)

### Plugin 安装

支持从 Git 仓库一键安装完整插件包，选择支持的宿主工具，并启用其中包含的 skills、commands、agents 和集成能力。

![安装插件](docs/images/plugin_install.png)

## 设置

配置应用存储目录、默认编辑器、更新检查、默认安装行为和工具支持状态。

![SkillDock 设置](docs/images/settings.png)

## 支持的工具

Claude Code · Codex · Cursor · Windsurf · IntelliJ IDEA · OpenCode · Gemini · Antigravity · Continue · GitHub Copilot · Qwen Code · Trae · Trae CN · Cline · Roo Code · Kilo Code · Kiro · Goose · Junie · Augment · CodeBuddy · Droid · OpenClaw · CommandCode · Crush · Qoder · Zencoder · Hermes · iFlow

## 工作机制

SkillDock 会把安装的 skills 统一放在本地托管库中，再通过软链接启用到各个工具自己的 skills 目录。这样既保留一个统一管理源，也让每个工具仍然从自己期望的位置读取 skills。

插件会作为更高层级的包来管理。一个插件可以暴露 skills、agents、commands、MCP 集成和宿主专属能力；SkillDock
会统一安装插件包、追踪来源，并允许你为兼容的宿主工具启用或停用。

MCP servers 使用的是另一套机制：SkillDock 会把它们作为统一配置记录管理，并在启用时写入对应工具的 MCP 配置文件。

## 下载

安装包会发布在 [Releases](../../releases) 页面。

| 平台 | 状态 |
| --- | --- |
| macOS | 已发布 |
| Windows | 计划支持 |

## 快速开始

1. 下载并打开 SkillDock。
2. 从市场、Git 仓库或本地目录安装 plugins、skills 或 MCP servers。
3. 为你的 Coding Agent 启用 plugins、skills 和 MCP servers。
4. 使用 Git-aware 状态查看更新、本地修改和推送预览。

## 路线图

- [ ] 公开安装包。
- [ ] 更清晰的 skill 状态：可更新、本地已修改、待推送、冲突。
- [ ] 更完整的插件和 MCP 生命周期：安装、参数配置、tools 探测、跨工具同步。
- [ ] 更好的 Git 流程：分支选择、团队仓库回推、PR/MR 交接。
- [ ] macOS 工作流稳定后支持 Windows。

## 源码说明

SkillDock 当前以闭源预览版形式发布。

源码是否开放会在首个公开版本稳定后再决定。
