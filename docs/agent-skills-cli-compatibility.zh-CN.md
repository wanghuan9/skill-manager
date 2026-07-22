# SkillDock 与 Agent Skills CLI 如何协作

SkillDock 同时识别两个目录：

```text
~/.skilldock/skills/        # SkillDock 自己的 Skill 目录
~/.agents/skills/           # Agent Skills CLI 的全局 Skill 入口
```

兼容模式不会迁移、复制或删除任何 Skill 实体。它只读扫描 `~/.agents/skills` 中的目录和软链接，也不会自动创建或替换入口。

每个 Skill 实例都会显示 `SkillDock 托管`、`Agent CLI 托管` 或 `外部目录`，并显示解析后的真实路径。

## Agent CLI 的 Skill 不需要导入

`~/.agents/skills` 下的目录或软链接都视为已安装 Skill，不会出现在本地 Skill 导入列表中。

如果入口是软链接，SkillDock 会解析它的真实目录。例如：

```text
~/.agents/skills/demo -> ~/.cursor/skills/demo
```

SkillDock 会记录入口和真实目录，但实际编辑、查看和分发都使用真实目录。

## 同名 Skill 怎么显示

- 同名、同真实目录：合并为一个 Skill，展示多个入口。
- 同名、不同真实目录：作为同名 Skill 组中的多个实例，分别操作。
- 不同名：正常分别显示。

SkillDock 不会因为名称相同就自动覆盖某个目录或软链接。

## 启用到其他软件

从哪个 Skill 实例点击“启用到 Cursor”，Cursor 就链接到哪个实例的真实目录：

```text
~/.cursor/skills/demo -> ~/.skilldock/skills/demo
```

或者：

```text
~/.cursor/skills/demo -> ~/.cursor-source/skills/demo
```

关闭 Cursor 时只删除 Cursor 自己的分发链接，不删除真实 Skill，也不改动其他软件已有的链接。

如果 Cursor 已有同名 Skill 且指向另一个真实目录，SkillDock 会保留原链接并提示冲突，不会静默覆盖。

## 更新、删除和 Git 推送

| Skill 类型 | SkillDock 更新 | SkillDock 删除 | Git 推送 |
| --- | --- | --- | --- |
| SkillDock Git Skill | SkillDock Git | 删除 SkillDock 实体和相关链接 | 支持 |
| Agent CLI 非 Git Skill | 调用 `skills update` | 调用 `skills remove` | 不支持 |
| 软链接到 Git 真实目录 | 按真实目录走 Git 更新 | 按来源安全处理 | 有 remote 时支持 |
| 外部本地 Skill | 不自动更新 | 默认只解除链接 | 不支持 |

用户只点击一个“更新”按钮，SkillDock 会根据实际来源自动选择 Git 或 Agent Skills CLI。

## 兼容模式开关

- 关闭：只管理 `~/.skilldock/skills`。
- 开启：额外扫描并管理 `~/.agents/skills`，包括其中的软链接入口。
- 关闭兼容模式不会删除 `~/.agents/skills` 中的任何内容。
- SkillDock 安装的 Git Skill仍保存在 `~/.skilldock/skills`，不会因为开启兼容模式而迁移。
