# SkillDock 与 Agent Skills CLI 兼容说明

SkillDock 可以识别 Agent Skills CLI 的全局 Skill，同时继续保留自己的托管能力。

## 两个托管目录

开启兼容模式后，SkillDock 会读取：

```text
~/.skilldock/skills/   # SkillDock 托管目录
~/.agents/skills/      # Agent Skills CLI 托管目录
```

“已托管”列表只包含真实目录位于这两个目录中的 Skill。SkillDock 不会迁移、复制、替换或删除 Agent CLI 的入口。

如果 `~/.agents/skills/<name>` 是软链接，SkillDock 会先解析真实目录：

- 真实目录仍在 `~/.agents/skills` 或 `~/.skilldock/skills` 内：按对应托管方展示。
- 真实目录位于 Cursor、Claude Code 等其他目录：不计入“已托管”列表。

列表中的归属标签使用 `SkillDock` 或 `Agent CLI`，详情页会同时显示托管方和真实目录，便于确认实际操作对象。

## 外部 Skill 如何出现

外部目录只在实际启用到支持的软件目录中扫描，例如 Cursor、Claude Code、Codex 等。未启用到任何软件的外部目录不会被扫描，也不会出现在列表中。

外部 Skill 不会自动导入。用户点击导入后，SkillDock 仍只会将副本导入 `~/.skilldock/skills`，之后由 SkillDock 托管。

## 同名 Skill

- 同名、同真实目录：合并为一个 Skill，并保留多个入口信息。
- 同名、不同真实目录：分别展示，不自动去重或覆盖。

从某个实例启用到其他软件时，目标软件的软链接会指向该实例的真实目录。关闭时只移除目标软件自己的分发链接，不影响真实目录和其他软件。

## 更新、删除和 Git

SkillDock 会根据实例的真实目录和来源执行操作：

- SkillDock 托管的 Git Skill：使用 Git 更新、删除和推送能力。
- Agent CLI 托管的 Skill：保留 Agent CLI 的目录和锁文件；SkillDock 可以直接打开、启用、关闭、检查更新、更新和删除。
- 外部目录 Skill：只作为工具目录中的未托管项展示，可导入到 SkillDock；导入前不纳入已托管操作。

卡片底部会用 `Git · SkillDock`、`Git · Agent CLI` 或 `本地 · SkillDock` 这样的摘要标识来源和托管方；GitHub、GitLab、Gitee 等 Git 服务统一显示为 `Git`。

Agent CLI Skill 会复用 SkillDock 原有的更新检查链路：启动后检查、每 10 分钟定时检查、窗口重新聚焦检查，以及手动刷新。检查过程不会修改真实的 `~/.agents/skills` 或 `~/.agents/.skill-lock.json`；只有确认存在新版本时，列表右侧才显示“可更新”状态和更新按钮，“全部更新”也只处理这些 Skill。

## 兼容模式开关

- 关闭：管理 `~/.skilldock/skills`，不扫描 Agent CLI 全局目录。
- 开启：额外识别 `~/.agents/skills` 中真实位于托管根目录内的 Skill；工具目录中的外部 Skill 仍按原有规则扫描。
- 关闭兼容模式不会修改 `~/.agents/skills` 的任何内容。
