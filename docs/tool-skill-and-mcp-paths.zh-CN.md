# SkillDock 工具 Skill / MCP 路径核对表

本文档用于核对当前代码里已经建模的工具 `skills` 路径与 MCP 配置路径。

- 核对基线：当前仓库实现
- 代码来源：`src-tauri/src/tool_adapters.rs`、`src-tauri/src/commands.rs`、`src-tauri/src/mcp_manager.rs`
- 更新时间：2026-07-27

## 当前结论

- 当前共建模了 35 个工具。
- 其中 32 个工具当前标记为 `支持 MCP，且路径已建模`。
- `IntelliJ IDEA`、`VS Code` 和 `Pi` 当前标记为 `不支持 MCP`。
- 当前没有处于 `支持 MCP，但路径未建模` 的工具。

## 状态说明

- `支持`：产品支持 MCP，且本地配置文件路径已经在代码里建模。
- `不支持`：当前产品未被我们标记为支持 MCP。

## 核对表

| 工具 | tool id | Skill 路径 | MCP 状态 | MCP 配置路径 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude/skills` | 支持 | `~/.claude.json` |
| Codex | `codex` | `~/.codex/skills` | 支持 | `~/.codex/config.toml` |
| Pi | `pi` | `~/.pi/agent/skills` | 不支持 | - |
| OMP | `omp` | `~/.omp/agent/skills` | 支持 | `~/.omp/agent/mcp.json` |
| Grok Build | `grok` | `~/.grok/skills` | 支持 | `~/.grok/config.toml` |
| MiMo Code | `mimo-code` | `~/.config/mimocode/skills` | 支持 | `~/.config/mimocode/mimocode.json` |
| WorkBuddy | `workbuddy` | `~/.workbuddy/skills` | 支持 | `~/.workbuddy/.mcp.json` |
| Cursor | `cursor` | `~/.cursor/skills` | 支持 | `~/.cursor/mcp.json` |
| Windsurf | `windsurf` | `~/.codeium/windsurf/skills` | 支持 | `~/.codeium/windsurf/mcp_config.json` |
| IntelliJ IDEA | `intellij` | `~/.junie/skills` | 不支持 | - |
| VS Code | `vscode` | - | 不支持 | - |
| OpenCode | `opencode` | `~/.config/opencode/skills` | 支持 | `~/.config/opencode/opencode.json` |
| Gemini CLI | `gemini` | `~/.gemini/skills` | 支持 | `~/.gemini/settings.json` |
| Antigravity | `antigravity` | `~/.gemini/config/skills` | 支持 | `~/.gemini/config/mcp_config.json` |
| Continue | `continue` | `~/.continue/skills` | 支持 | `~/.continue/config.yaml` |
| GitHub Copilot | `github-copilot` | `~/.copilot/skills` | 支持 | `~/.copilot/mcp-config.json` |
| Qwen Code | `qwen-code` | `~/.qwen/skills` | 支持 | `~/.qwen/settings.json` |
| Trae | `trae` | `~/.trae/skills` | 支持 | `~/Library/Application Support/Trae/User/mcp.json` |
| Trae CN | `trae-cn` | `~/.trae-cn/skills` | 支持 | `~/Library/Application Support/Trae CN/User/mcp.json` |
| Cline | `cline` | `~/.cline/skills` | 支持 | `~/.cline/data/settings/cline_mcp_settings.json` |
| Roo Code | `roo-code` | `~/.roo/skills` | 支持 | `~/Library/Application Support/Code/User/globalStorage/RooVeterinaryInc.roo-cline/settings/mcp_settings.json` |
| Kilo Code | `kilo-code` | `~/.kilocode/skills` | 支持 | `~/Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/settings/mcp_settings.json` |
| Kiro | `kiro` | `~/.kiro/skills` | 支持 | `~/.kiro/settings/mcp.json` |
| Goose | `goose` | `~/.agents/skills` | 支持 | `~/.config/goose/config.yaml` |
| Junie | `junie` | `~/.junie/skills` | 支持 | `~/.junie/mcp/mcp.json` |
| Augment | `augment` | `~/.augment/skills` | 支持 | `~/.augment/settings.json` |
| CodeBuddy | `codebuddy` | `~/.codebuddy/skills` | 支持 | `~/.codebuddy/.mcp.json` |
| Droid | `droid` | `~/.factory/skills` | 支持 | `~/.factory/mcp.json` |
| OpenClaw | `openclaw` | `~/.openclaw/skills` | 支持 | `~/.openclaw/openclaw.json` |
| CommandCode | `commandcode` | `~/.commandcode/skills` | 支持 | `~/.commandcode/mcp.json` |
| Crush | `crush` | `~/.config/crush/skills` | 支持 | `~/.config/crush/crush.json` |
| Qoder | `qoder` | `~/.qoder/skills` | 支持 | `~/.config/Qoder/SharedClientCache/mcp.json` |
| Zencoder | `zencoder` | `~/.zencoder/skills` | 支持 | `~/.zencoder/settings.json` |
| Hermes | `hermes` | `~/.hermes/skills` | 支持 | `~/.hermes/config.yaml` |
| iFlow | `iflow` | `~/.iflow/skills` | 支持 | `~/.iflow/settings.json` |

## 备注

- 这份表记录的是“我们软件当前会去读写的路径”，用于产品实现核对，不等同于官方文档原文摘录。
- 同一个工具如果官方后续调整了本地配置位置，需要同步更新代码与这份文档。
- `Trae`、`Trae CN` 的 `skills` 路径与 MCP 路径不在同一目录，这属于当前实现的预期行为。
- `Droid` 当前使用 `~/.factory/skills` 与 `~/.factory/mcp.json`。
- `Antigravity` 当前使用 Gemini 新版共享 skills 目录：`~/.gemini/config/skills`；MCP 配置仍位于 `~/.gemini/config/mcp_config.json`。
- `Goose` 当前以 `~/.agents/skills` 作为首选 skill 路径，同时兼容扫描旧路径 `~/.config/goose/skills`。
- `Pi` 核心不内置 MCP；MCP 通常由第三方扩展提供，因此 SkillDock 不猜测或写入 Pi MCP 配置。
- `MiMo Code` 路径与 MCP 格式依据官方文档：全局配置位于 `~/.config/mimocode/`，MCP 使用 `mcp` 对象，并支持本地与远程 server。
- `WorkBuddy` 当前使用用户确认的 `~/.workbuddy/skills` 与 `~/.workbuddy/.mcp.json`；官网暂未公开这两个本地文件路径。
