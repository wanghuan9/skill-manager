<p align="center">
  <img src="src-tauri/icons/icon.png" width="150" alt="SkillDock" />
</p>

<h1 align="center">SkillDock - AI Skills & MCP Manager</h1>

<p align="center">
  SkillDock is a skill manager and MCP manager for AI coding tools. It helps users install, view, edit, organize, sync, and update skills and MCP servers, with Git-aware updates for tracking upstream changes and local modifications.
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

SkillDock is a desktop control center for AI coding tools. It keeps your local Skills and MCP configurations visible, editable, and synced across Claude Code, Codex, Cursor, Windsurf, Gemini CLI, GitHub Copilot, and the tools you use every day.

- **Skills library** — Install, update, delete, edit, inspect, and sync local skills.
- **Source grouping** — Group installed skills by repository or local source so team-maintained skill sets stay easy to scan.
- **Git-aware workflow** — Keep Git-based skills as real repositories, detect upstream updates, local edits, pending pushes, and preview changes before pulling or pushing.
- **Marketplace install** — Browse and install skills from `skills.sh`, `skillsmp`, and other supported sources.
- **Git and local import** — Install skills from GitHub, GitLab, Gitee, compatible Git repos, or existing local folders.
- **Multi-tool sync** — Enable skills for built-in coding tools and IDEs without hand-copying files.
- **MCP management** — Browse, import, edit, enable, disable, sync, and inspect MCP server configs.
- **MCP tools discovery** — Detect exposed MCP tools and track whether each server config is usable.

## Skills

View every installed skill by source group, filter by status, inspect source metadata, and see Git collaboration state at a glance.

![Skills list](docs/images/skill_list.png)

![Skill groups by source](docs/images/skill_groups.png)

![Skill details and tool sync](docs/images/skill_detail.png)

SkillDock preserves source information and tool enablement per skill, so a team-maintained skill can stay connected to its upstream repository while still being applied selectively to Claude Code, Codex, Cursor, Gemini CLI, Windsurf, and other tools.

## MCP

Manage MCP servers in the same workspace as skills. SkillDock scans supported app config files, shows the server command and source, and lets you enable or disable server sync per tool.

![SkillDock MCP list](docs/images/mcp_list.png)

![MCP server details and tools](docs/images/mcp_detail.png)

## Tools

SkillDock detects supported coding tools, shows their skill and MCP config locations, and gives you one place to manage sync targets.

![Supported tools](docs/images/tools_list.png)

## Install

Install skills from marketplace sources, Git repositories, or local folders. SkillDock also separates MCP marketplace discovery so MCP servers can be installed and managed through their own lifecycle.

![Install skills from marketplace](docs/images/skill_install.png)

![Install skills from Git repositories](docs/images/skill_git_install.png)

![Install MCP servers](docs/images/mcp_install.png)

## Settings

Configure the app storage directory, default editor, update checks, default install behavior, and tool support status.

![SkillDock settings](docs/images/settings.png)

## Supported Tools

Claude Code · Codex · Cursor · Windsurf · IntelliJ IDEA · OpenCode · Gemini · Antigravity · Continue · GitHub Copilot · Qwen Code · Trae · Trae CN · Cline · Roo Code · Kilo Code · Kiro · Goose · Junie · Augment · CodeBuddy · Droid · OpenClaw · CommandCode · Crush · Qoder · Zencoder · Hermes · iFlow

## How It Works

SkillDock keeps installed skills in a managed local library, then enables them for each supported tool by creating links into that tool's own skills directory. This keeps one source of truth while still letting each tool read skills from the location it expects.

MCP servers use a different model: SkillDock manages them as shared configuration records and writes the enabled servers into each tool's MCP config file.

## Download

Installers will be published on the [Releases](../../releases) page.

| Platform | Status |
| --- | --- |
| macOS | Released |
| Windows | Planned |

## Getting Started

1. Download and open SkillDock.
2. Install skills from a marketplace, Git repository, or local folder.
3. Enable skills and MCP servers for your coding tools.
4. Use Git-aware status to review updates, local edits, and push previews.

## Roadmap

- [ ] Public installers.
- [ ] Clearer skill states: updateable, locally modified, pending push, conflicted.
- [ ] Fuller MCP lifecycle: install, configure, discover tools, and sync across tools.
- [ ] Better Git flows: branch selection, team repository pushback, PR/MR handoff.
- [ ] Windows support after the macOS workflow is stable.

## Source Availability

SkillDock is currently distributed as a closed-source preview.

Source code may be opened later after the first public release stabilizes.
