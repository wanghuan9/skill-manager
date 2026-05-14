# macOS 安装问题：Apple 无法验证 SkillDock

如果第一次打开 SkillDock 时看到下面类似提示，这是 macOS 的 Gatekeeper 安全机制在拦截应用：

- “未打开 ‘SkillDock’”
- “Apple 无法验证 ‘SkillDock’ 是否包含可能危害 Mac 安全或泄漏隐私的恶意软件。”
- 系统设置里显示“已阻止 ‘SkillDock’ 以保护 Mac。”

<img src="images/install-open-warning.png" width="520" alt="SkillDock 打开异常提示" />

## 原因

SkillDock 当前通过 GitHub Releases 分发，不是从 Mac App Store 安装。macOS 可能无法直接验证应用来源，所以第一次打开时会要求用户手动确认。

这个提示不等于 SkillDock 有恶意软件。只要你是从本项目 GitHub Releases 页面下载的安装包，可以按下面步骤继续打开。

Apple 官方说明：<https://support.apple.com/guide/mac-help/mchleab3a043/mac>

## 解决方法

### 方法一：在系统设置中允许打开

1. 在弹窗中点击“完成”，不要点击“移到废纸篓”。
2. 打开“系统设置”。
3. 进入“隐私与安全性”。
4. 向下滚动到“安全性”区域。
5. 找到“已阻止 ‘SkillDock’ 以保护 Mac。”这一行。
6. 点击右侧的“仍要打开”或“Open Anyway”。
7. 按提示输入登录密码，或使用 Touch ID 确认。
8. 再次打开 SkillDock。

<img src="images/install-open-anyway.png" width="720" alt="在隐私与安全性中允许打开 SkillDock" />

确认一次后，macOS 会把 SkillDock 记录为例外，之后通常可以像普通应用一样双击打开。

如果没有看到“仍要打开”按钮，请重新双击打开一次 SkillDock，让系统再次拦截，然后回到“系统设置 > 隐私与安全性”查看。这个按钮通常只会在尝试打开应用后短时间内显示。

### 方法二：终端移除隔离标记

打开终端执行下面的命令。它会移除 macOS 给下载应用添加的隔离标记，让系统不再按“未验证下载项”拦截 SkillDock：

```bash
xattr -dr com.apple.quarantine /Applications/SkillDock.app
```

然后再次打开 SkillDock。

## 仍然打不开怎么办

如果问题仍然存在，可以在 GitHub Issues 中反馈你的 macOS 版本、Mac 芯片类型、下载的安装包文件名，以及完整的系统提示截图。
