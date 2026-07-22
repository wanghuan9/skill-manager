# SkillDock 与 Agent Skills CLI 如何协作

SkillDock 可以管理 `~/.agents/skills` 中的全局 Skill，包括 Agent Skills CLI 安装的 Skill和 SkillDock 安装的 Git Skill。

## Skill由谁更新

用户只需要在 SkillDock 中点击“更新”，软件会自动选择正确的方式：

| Skill 类型 | 更新方式 | 支持 Git 推送 |
| --- | --- | --- |
| SkillDock 安装的 Git Skill | SkillDock Git 更新 | 支持 |
| Agent Skills CLI 安装的 Skill | SkillDock 调用 Agent Skills CLI 更新 | 不支持 |
| 外部本地 Skill | 不自动更新 | 不支持 |

Skill位于 `~/.agents/skills` 并不代表一定由 Agent Skills CLI 更新。只要保留完整 `.git`，SkillDock 就会继续提供 Diff、提交和推送能力。

## 新安装的 Skill在哪里

- 默认模式：SkillDock 安装到 `~/.skilldock/skills`。
- Agent Skills CLI 兼容模式：SkillDock 安装到 `~/.agents/skills`。
- Agent Skills CLI 的全局 Skill也安装在 `~/.agents/skills`。

SkillDock 会自动识别不同来源，用户不需要选择更新工具。

## 一键迁移会做什么

设置页的“一键迁移到 Agent Skills”会把旧 `~/.skilldock/skills` 中的 Skill移动到 `~/.agents/skills`：

- 完整保留 `.git`、分支、远程地址、提交记录和未提交修改。
- 重建已启用工具的软链接。
- 遇到同名 Skill时使用 SkillDock 版本。
- 被替换的同名内容先备份到 `~/.skilldock/migration-backups/<时间>/<名称>`，不会直接删除。
- 迁移失败会恢复原目录和设置，不留下半迁移状态。

## 不迁移也能继续使用

一键迁移是可选操作。不迁移时，SkillDock 会继续通过软链接让 Agent Skills CLI 识别旧 Skill：

```text
~/.agents/skills/<名称> → ~/.skilldock/skills/<名称>
```

原 Git 仓库仍保存在 `~/.skilldock/skills`，Git 信息和现有工具链接不受影响。

## 需要记住的规则

- SkillDock 安装的 Git Skill由 SkillDock 更新和推送。
- Agent Skills CLI 安装的 Skill可以在 SkillDock 中更新和删除。
- 同一个 Skill不会同时使用 Git 和 Agent Skills CLI 两套更新机制。
- `~/.skilldock` 继续保存 SkillDock 的设置、状态、缓存、插件和 MCP 数据。
