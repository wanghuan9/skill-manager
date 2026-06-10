<p align="center">
  <img src="src-tauri/icons/icon.png" width="150" alt="SkillDock" />
</p>

<h1 align="center">SkillDock - AI Skills, MCP & Plugins Manager</h1>

<p align="center">
  SkillDock is a skills, MCP, and plugin manager for AI coding tools. It helps users install, view, edit, organize, sync, and update skills, MCP servers, and plugin bundles, with Git-aware updates for tracking upstream changes and local modifications.
</p>

<p align="center">
  <a href="./README.zh-CN.md">中文说明</a> · <a href="#download">Download</a> · <a href="./docs/install-troubleshooting.md">Install issue?</a>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-blue" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20now%20%7C%20Windows%20planned-lightgrey" />
  <img alt="Preview" src="https://img.shields.io/badge/source-closed%20preview-lightgrey" />
</p>

## What It Does

SkillDock is a desktop control center for AI coding tools. It keeps your local Skills, MCP configurations, and plugin bundles visible, editable, and synced across Claude Code, Codex, Cursor, Windsurf, Gemini CLI, GitHub Copilot, and the tools you use every day. For Git-backed skills and plugins, it detects upstream updates, local changes, and pending pushes, then supports one-click updates with previewable changes.

The core workflow is team collaboration without intermediate handoff directories. Publishers can modify skills or plugins locally and push changes back with one click; users can update with one click while seeing who updated the package and what changed.

- **Skills library** — Install, update, delete, edit, inspect, and sync local skills.
- **MCP management** — Browse, import, edit, enable, disable, sync, and inspect MCP server configs.
- **Plugin management** — Install, enable, disable, inspect, one-click update, and remove plugin packages, with local change and pending-push detection for Git-backed plugins.
- **Skill source grouping** — Group installed skills by repository or local source so team-maintained skill sets stay easy to scan.
- **MCP tools discovery** — Detect exposed MCP tools, track whether each server config is usable, and control tool-level enablement.
- **Skill install** — Install skills with one click from `skills.sh` and `skillsmp`, or add them from Git repositories and local folders.
- **MCP install** — Install MCP servers with one click from `MCP.Directory`, then manage their shared configuration lifecycle.
- **Plugin install** — Install plugin packages with one click from Git repositories and enable their bundled skills, commands, agents, and integrations.
- **Git-aware workflow** — Keep Git-based skills and plugins as real repositories, detect upstream updates, local edits, and pending pushes, and preview changes before pulling or pushing.
- **One-click multi-tool sync** — Enable skills, MCP servers, and plugins across Claude Code, Codex, Cursor, Windsurf, Gemini CLI, OpenCode, and other coding tools to avoid hand-copying files and editing complex config files.

## Skills

View every installed skill by source group, filter by status, inspect source metadata, and see Git collaboration state at a glance.

**Skills list**

![Skills list](docs/images/skill_list.png)

**Skills grouped by source**

![Skill groups by source](docs/images/skill_groups.png)

**Skill details and tool sync**

![Skill details and tool sync](docs/images/skill_detail.png)

SkillDock preserves source information and tool enablement per skill, so a team-maintained skill can stay connected to its upstream repository while still being applied selectively to Claude Code, Codex, Cursor, Gemini CLI, Windsurf, and other tools.

## MCP

Manage MCP servers in the same workspace as skills. SkillDock scans supported app config files, shows the server command and source, and lets you enable or disable server sync per tool.

**MCP list**

![SkillDock MCP list](docs/images/mcp_list.png)

**MCP server details and tools**

![MCP server details and tools](docs/images/mcp_detail.png)

## Plugins

View installed plugins by supported host tool, inspect source metadata, see bundled skills, agents, commands, and host integrations, and track one-click updates, local changes, and pending pushes at a glance.

**Plugin list**

![SkillDock plugin list](docs/images/plugin_list.png)

**Plugin details**

![Plugin details with skills and commands](docs/images/plugin_detail.png)

## Tools

SkillDock detects supported coding tools, shows their skill and MCP config locations, and gives you one place to manage sync targets.

![Supported tools](docs/images/tools_list.png)

## Install

Install flows are split by package type so skills, MCP servers, and plugins can each follow their own lifecycle.

### Skill install

Install skills with one click from `skills.sh` and `skillsmp`, or add them from Git repositories and local folders.

**Skill marketplace install**

![Install skills from marketplace](docs/images/skill_install.png)

**Skill Git and local install**

![Install skills from Git repositories](docs/images/skill_git_install.png)

### MCP install

Install MCP servers with one click from `MCP.Directory`, then manage their shared configuration and tools lifecycle.

![Install MCP servers](docs/images/mcp_install.png)

### Plugin install

Install complete plugin packages with one click from Git repositories, select supported host tools, and enable bundled skills, commands, agents, and integrations.

![Install plugins](docs/images/plugin_install.png)

## Settings

Configure the app storage directory, default editor, update checks, default install behavior, and tool support status.

![SkillDock settings](docs/images/settings.png)

## Supported Tools

Claude Code · Codex · Cursor · Windsurf · IntelliJ IDEA · OpenCode · Gemini · Antigravity · Continue · GitHub Copilot · Qwen Code · Trae · Trae CN · Cline · Roo Code · Kilo Code · Kiro · Goose · Junie · Augment · CodeBuddy · Droid · OpenClaw · CommandCode · Crush · Qoder · Zencoder · Hermes · iFlow

## How It Works

SkillDock keeps installed skills in a managed local library, then enables them for each supported tool by creating links into that tool's own skills directory. This keeps one source of truth while still letting each tool read skills from the location it expects.

Plugins are managed as higher-level packages. A plugin can expose skills, agents, commands, MCP integrations, and host-specific capabilities; SkillDock installs the package once, tracks its source, and lets you enable or disable it for compatible host tools.

MCP servers use a different model: SkillDock manages them as shared configuration records and writes the enabled servers into each tool's MCP config file.

## Download

Installers will be published on the [Releases](../../releases) page.

| Platform | Status |
| --- | --- |
| macOS | Released |
| Windows | Planned |

## Getting Started

1. Download and open SkillDock.
2. Install plugins, skills, or MCP servers from a marketplace, Git repository, or local folder.
3. Enable plugins, skills, and MCP servers for your coding tools.
4. Use Git-aware status to review updates, local edits, and push previews.

## Roadmap

- [ ] Public installers.
- [ ] Clearer skill states: updateable, locally modified, pending push, conflicted.
- [ ] Fuller plugin and MCP lifecycle: install, configure, discover tools, and sync across tools.
- [ ] Better Git flows: branch selection, team repository pushback, PR/MR handoff.
- [ ] Windows support after the macOS workflow is stable.

## Source Availability

SkillDock is currently distributed as a closed-source preview.

Source code may be opened later after the first public release stabilizes.
