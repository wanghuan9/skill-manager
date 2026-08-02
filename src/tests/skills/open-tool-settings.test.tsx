import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { vi } from "vitest";
import { App } from "@/app/App";
import { requestOpenGithubSettings } from "@/app/github-settings-navigation";
import { alignExpandedRowIntoView } from "@/app/utils/align-expanded-row";
import * as appUpdateClient from "@/features/app-update/app-update-client";
import {
  appSettingsFixture,
  gitAccountFixture,
  githubConnectionFixture,
  installedSkillFixtures,
  localSkillFixtures,
  toolConfigFixtures,
} from "@/features/skills/state/skill-fixtures";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("@/app/utils/align-expanded-row", () => ({
  alignExpandedRowIntoView: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.mocked(isTauri).mockReturnValue(false);
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  Object.assign(githubConnectionFixture, {
    connected: false,
    authMethod: "",
    userId: null,
    username: "",
    avatarUrl: "",
    credentialPersisted: false,
    warning: "",
  });
});

test("opens GitHub account settings after a rate-limited Agent CLI refresh", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation(async (command) => {
    switch (command) {
      case "list_startup_installed_skills":
        return installedSkillFixtures;
      case "refresh_git_states":
        return {
          skills: installedSkillFixtures,
          githubRateLimited: true,
        };
      case "list_local_skill_candidates":
        return localSkillFixtures;
      case "list_tool_configs":
        return toolConfigFixtures;
      case "list_tool_skill_entries":
        return [];
      case "get_git_account_summary":
        return gitAccountFixture;
      case "get_app_settings":
        return appSettingsFixture;
      case "get_github_connection":
        return githubConnectionFixture;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });

  render(<App />);

  expect(
    await screen.findByText("GitHub API 配额已用尽，登录 GitHub 可提高访问额度。"),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "去配置" }));

  expect(await screen.findByRole("heading", { name: "账号与备份" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "登录 GitHub" })).toHaveClass(
    "primary-button",
    "settings-github-connect__action",
    "settings-github-connect__login",
  );
  expect(screen.queryByRole("button", { name: "使用 Personal Access Token" })).not.toBeInTheDocument();
});

test("opens GitHub account settings when the marketplace requests login", async () => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });

  render(<App />);
  act(() => requestOpenGithubSettings());

  expect(await screen.findByRole("heading", { name: "账号与备份" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "登录 GitHub" })).toBeInTheDocument();
});

test("automatically copies the GitHub device code and keeps manual copy available", async () => {
  const user = userEvent.setup();
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  const clipboardSpy = vi.spyOn(navigator.clipboard, "writeText");
  vi.mocked(invoke).mockResolvedValueOnce({
    deviceCode: "device-code",
    userCode: "045F-820D",
    verificationUri: "https://github.com/login/device",
    expiresIn: 900,
    interval: 5,
  });
  window.localStorage.clear();

  render(<App />);

  await user.click(screen.getByRole("button", { name: /设置/ }));
  await user.click(screen.getByRole("button", { name: "登录 GitHub" }));

  const codeButton = await screen.findByRole("button", { name: /045F-820D.*已复制/ });
  expect(clipboardSpy).toHaveBeenCalledTimes(1);
  expect(clipboardSpy).toHaveBeenLastCalledWith("045F-820D");
  expect(screen.getByText("验证码已复制，请直接粘贴")).toBeInTheDocument();
  expect(screen.getByText("等待 GitHub 授权")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "登录 GitHub" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "使用 Personal Access Token" })).not.toBeInTheDocument();

  await user.click(codeButton);
  expect(clipboardSpy).toHaveBeenCalledTimes(2);
  expect(clipboardSpy).toHaveBeenLastCalledWith("045F-820D");
  expect(await screen.findByText("已复制")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "打开 GitHub" }));
  expect(openSpy).toHaveBeenCalledTimes(2);
});

test("opens GitHub and preserves manual copy when automatic clipboard access fails", async () => {
  const user = userEvent.setup();
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  const clipboardSpy = vi.spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("clipboard unavailable"));
  vi.mocked(invoke).mockResolvedValueOnce({
    deviceCode: "device-code",
    userCode: "045F-820D",
    verificationUri: "https://github.com/login/device",
    expiresIn: 900,
    interval: 5,
  });
  window.localStorage.clear();

  render(<App />);

  await user.click(screen.getByRole("button", { name: /设置/ }));
  await user.click(screen.getByRole("button", { name: "登录 GitHub" }));

  const codeButton = await screen.findByRole("button", { name: /045F-820D.*复制/ });
  expect(clipboardSpy).toHaveBeenCalledTimes(1);
  expect(screen.getByText("在 GitHub 输入验证码")).toBeInTheDocument();
  expect(openSpy).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("复制 GitHub 验证码失败")).not.toBeInTheDocument();
  expect(screen.queryByText("连接 GitHub 失败")).not.toBeInTheDocument();

  await user.click(codeButton);
  expect(clipboardSpy).toHaveBeenCalledTimes(2);
  expect(await screen.findByText("验证码已复制，请直接粘贴")).toBeInTheDocument();
});

test("runs manual GitHub sync and backup from settings", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  Object.assign(githubConnectionFixture, {
    connected: true,
    authMethod: "oauth",
    userId: 1,
    username: "octocat",
    credentialPersisted: true,
  });
  const backupStatus = {
    enabled: true,
    repositoryOwner: "octocat",
    repositoryName: "skilldock-backup",
    repositoryUrl: "https://github.com/octocat/skilldock-backup.git",
    lastSyncAt: "",
    lastOperation: "",
    lastError: "",
    phase: "enabled",
    syncing: false,
    pendingConflicts: 0,
    progressStage: "",
    progressPercent: 0,
  };
  let backupStatusListener: ((event: { payload: typeof backupStatus }) => void) | undefined;
  let cloudBackupNodeRequestCount = 0;
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    if (event === "backup-status-changed") {
      backupStatusListener = handler as typeof backupStatusListener;
    }
    return () => undefined;
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    switch (command) {
      case "list_startup_installed_skills":
        return installedSkillFixtures;
      case "refresh_git_states":
        return { skills: installedSkillFixtures, githubRateLimited: false };
      case "list_local_skill_candidates":
        return localSkillFixtures;
      case "list_tool_configs":
        return toolConfigFixtures;
      case "list_tool_skill_entries":
        return [];
      case "get_git_account_summary":
        return gitAccountFixture;
      case "get_app_settings":
        return appSettingsFixture;
      case "get_github_connection":
        return githubConnectionFixture;
      case "get_backup_status":
        return backupStatus;
      case "list_backup_conflicts":
        return [];
      case "list_cloud_backup_nodes":
        cloudBackupNodeRequestCount += 1;
        return cloudBackupNodeRequestCount === 1
          ? [
              {
                commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                createdAt: "2026-07-31T02:44:00Z",
                deviceLabel: "MacBook Pro",
                skillCount: 0,
                mcpCount: 0,
                pluginCount: 0,
              },
              {
                commitId: "0123456789abcdef0123456789abcdef01234567",
                createdAt: "2026-07-30T07:57:00Z",
                deviceLabel: "MacBook Pro",
                skillCount: 21,
                mcpCount: 3,
                pluginCount: 2,
              },
            ]
          : [
              {
                commitId: "0123456789abcdef0123456789abcdef01234567",
                createdAt: "2026-07-30T07:57:00Z",
                deviceLabel: "MacBook Pro",
                skillCount: 21,
                mcpCount: 3,
                pluginCount: 2,
              },
              {
                commitId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                createdAt: "2026-07-29T07:57:00Z",
                deviceLabel: "MacBook Pro",
                skillCount: 19,
                mcpCount: 2,
                pluginCount: 1,
              },
            ];
      case "preview_cloud_backup_node":
        return { added: 4, overwritten: 18, deleted: 1 };
      case "delete_cloud_backup_node":
        return undefined;
      case "restore_cloud_backup_node":
        return {
          ...backupStatus,
          phase: "restoring",
          syncing: true,
          progressStage: "preparing",
          progressPercent: 3,
        };
      case "sync_backup_to_local":
      case "run_backup_sync":
        return backupStatus;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });

  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /设置/ }));

  expect(await screen.findByRole("heading", { name: "账号与备份" })).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "云端备份" })).toBeChecked();

  expect(screen.getByRole("button", { name: "octocat/skilldock-backup" })).toBeInTheDocument();
  expect(screen.getByText("尚未备份")).toBeInTheDocument();

  await waitFor(() => expect(backupStatusListener).toBeDefined());
  act(() => {
    backupStatusListener?.({
      payload: {
        ...backupStatus,
        lastSyncAt: "2026-07-31T02:44:00Z",
        lastOperation: "backup",
      },
    });
  });
  expect(await screen.findByText(/备份到云端 · 已完成 ·/)).toBeInTheDocument();

  act(() => {
    backupStatusListener?.({
      payload: {
        ...backupStatus,
        phase: "backingUp",
        syncing: true,
        progressStage: "uploading",
        progressPercent: 68,
      },
    });
  });
  expect(await screen.findByText("正在上传 Git 对象 · 68%"))
    .toBeInTheDocument();
  expect(screen.getByRole("button", { name: "备份中 68%" })).toBeDisabled();

  act(() => {
    backupStatusListener?.({
      payload: {
        ...backupStatus,
        phase: "restoring",
        syncing: true,
        progressStage: "restoring",
        progressPercent: 72,
      },
    });
  });
  expect(await screen.findByText("正在恢复本地文件 · 72%"))
    .toBeInTheDocument();
  expect(screen.getByRole("button", { name: "同步中 72%" })).toBeDisabled();

  act(() => {
    backupStatusListener?.({ payload: backupStatus });
  });

  const syncButton = await screen.findByRole("button", { name: "同步到本地" });
  const backupButton = screen.getByRole("button", { name: "备份到云端" });
  const historyButton = screen.getByRole("button", { name: "历史节点" });
  expect(syncButton.parentElement).toBe(backupButton.parentElement);
  expect(syncButton.parentElement).toBe(historyButton.parentElement);

  await userEvent.click(syncButton);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("sync_backup_to_local", {}));
  expect(screen.queryByRole("dialog", { name: "本机数据将被替换" })).not.toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalledWith("preview_cloud_backup_node", expect.anything());

  await userEvent.click(backupButton);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("run_backup_sync", {}));

  await userEvent.click(historyButton);
  expect(await screen.findByRole("dialog", { name: "云端历史备份节点" })).toBeInTheDocument();
  expect(await screen.findByText("21 Skills · 3 MCP · 2 插件")).toBeInTheDocument();
  expect(await screen.findAllByText("设备：MacBook Pro")).toHaveLength(2);

  await userEvent.click(screen.getAllByRole("button", { name: "从此节点恢复" })[1]);
  const restoreDialog = await screen.findByRole("dialog", { name: "确认恢复云端节点" });
  expect(within(restoreDialog).getByText(
    "将新增 4 项、覆盖 18 项、删除 1 项 SkillDock 托管数据，是否继续？",
  )).toBeInTheDocument();
  await userEvent.click(within(restoreDialog).getByRole("button", { name: "取消" }));
  expect(invoke).not.toHaveBeenCalledWith("restore_cloud_backup_node", expect.anything());

  await userEvent.click(screen.getAllByRole("button", { name: "删除节点" })[0]);
  const deleteDialog = await screen.findByRole("dialog", { name: "删除云端备份节点" });
  expect(within(deleteDialog).getByText(/Git 历史中的底层数据仍会保留/)).toBeInTheDocument();
  await userEvent.click(within(deleteDialog).getByRole("button", { name: "删除节点" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_cloud_backup_node", {
    commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }));
  expect(screen.queryByText("0 Skills · 0 MCP · 0 插件")).not.toBeInTheDocument();
  expect(await screen.findByText("19 Skills · 2 MCP · 1 插件")).toBeInTheDocument();
  expect(cloudBackupNodeRequestCount).toBe(2);

  await userEvent.click(screen.getAllByRole("button", { name: "从此节点恢复" })[0]);
  const confirmedRestoreDialog = await screen.findByRole("dialog", { name: "确认恢复云端节点" });
  await userEvent.click(within(confirmedRestoreDialog).getByRole("button", { name: "确认恢复" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("restore_cloud_backup_node", {
    commitId: "0123456789abcdef0123456789abcdef01234567",
  }));
  expect(screen.queryByRole("dialog", { name: "云端历史备份节点" })).not.toBeInTheDocument();
  expect(await screen.findByText("正在准备 · 3%")).toBeInTheDocument();
});

test("allows selecting default open tool in settings", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /设置/ }));

  expect(screen.getByText("/Users/demo/.skilldock")).toBeInTheDocument();
  expect(screen.getByLabelText("界面语言")).toHaveTextContent("简体中文");
  expect(screen.getByLabelText("默认编辑器").closest(".settings-form-item")?.previousElementSibling)
    .toHaveTextContent("界面语言");
  const select = screen.getByLabelText("默认编辑器");
  expect(select).toBeInTheDocument();
  expect(screen.getByLabelText("新增 Skill 默认启用")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByLabelText("新增 MCP 默认启用")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("工具状态")).toBeInTheDocument();

  await userEvent.click(select);
  expect(screen.getByRole("option", { name: "Cursor" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "VS Code" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "IntelliJ IDEA" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "文件夹" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Claude Code" })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Codex" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("option", { name: "Cursor" }));

  expect(select).toHaveTextContent("Cursor");

  await userEvent.click(select);
  await userEvent.click(screen.getByRole("option", { name: "文件夹" }));

  expect(select).toHaveTextContent("文件夹");

  await userEvent.click(screen.getByLabelText("新增 Skill 默认启用"));
  expect(screen.getByLabelText("新增 Skill 默认启用")).toHaveAttribute("aria-pressed", "false");

  await userEvent.click(screen.getByLabelText("新增 MCP 默认启用"));
  expect(screen.getByLabelText("新增 MCP 默认启用")).toHaveAttribute("aria-pressed", "false");

  await userEvent.click(screen.getByRole("button", { name: "工具状态" }));
  const toolStatusPanel = screen.getByText("展示当前支持的软件列表以及各软件的安装状态。").closest("section");
  if (!toolStatusPanel) {
    throw new Error("missing tool status panel");
  }

  expect(screen.getByText("CodeBuddy")).toBeInTheDocument();
  expect(within(toolStatusPanel).queryByText("IntelliJ IDEA")).not.toBeInTheDocument();
  expect(within(toolStatusPanel).queryByText("VS Code")).not.toBeInTheDocument();
  expect(screen.getAllByText("未安装").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0);
  expect(screen.getAllByText("已安装").length).toBeGreaterThan(0);
  expect(screen.getAllByText("编辑器").length).toBeGreaterThan(0);

  await userEvent.click(screen.getByRole("button", { name: "工具状态" }));
  expect(screen.queryByText("CodeBuddy")).not.toBeInTheDocument();
});

test("keeps the Personal Access Token entry hidden while disconnected", async () => {
  const user = userEvent.setup();
  window.localStorage.clear();
  render(<App />);

  await user.click(screen.getByRole("button", { name: /设置/ }));
  expect(screen.getByRole("heading", { name: "账号与备份" })).toBeInTheDocument();
  expect(screen.getByText("未连接")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "登录 GitHub" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "使用 Personal Access Token" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("GitHub Token")).not.toBeInTheDocument();
});

test("applies the shared card preference without locking individual page layouts", async () => {
  const user = userEvent.setup();
  window.localStorage.clear();
  render(<App />);

  await user.click(screen.getByRole("button", { name: /设置/ }));
  const preferenceGroup = screen.getByRole("group", { name: "卡片样式偏好" });
  await user.click(within(preferenceGroup).getByRole("button", { name: "卡片" }));

  expect(window.localStorage.getItem("skills:view-mode")).toBe("grid");
  expect(window.localStorage.getItem("mcp:view-mode")).toBe("grid");
  expect(window.localStorage.getItem("plugins:view-mode")).toBe("grid");

  await user.click(screen.getByRole("button", { name: /Skills/ }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "卡片" })).toHaveAttribute("aria-pressed", "true");
  });

  await user.click(screen.getByRole("button", { name: "列表" }));
  expect(window.localStorage.getItem("skills:view-mode")).toBe("list");
  expect(window.localStorage.getItem("mcp:view-mode")).toBe("grid");
  expect(window.localStorage.getItem("plugins:view-mode")).toBe("grid");

  await user.click(screen.getByRole("button", { name: "MCP" }));
  expect(screen.getByRole("button", { name: "卡片" })).toHaveAttribute("aria-pressed", "true");

  await user.click(screen.getByRole("button", { name: /Plugins/ }));
  expect(screen.getByRole("button", { name: "卡片" })).toHaveAttribute("aria-pressed", "true");

  await user.click(screen.getByRole("button", { name: /设置/ }));
  expect(
    within(screen.getByRole("group", { name: "卡片样式偏好" })).getByRole("button", { name: "卡片" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("switches Skills, MCP, and Plugins between current and compact header layouts", async () => {
  const user = userEvent.setup();
  window.localStorage.clear();
  const { container } = render(<App />);

  expect(screen.getByRole("tablist", { name: "Skill 来源" })).toBeInTheDocument();
  const currentHeader = container.querySelector(".page-header--split");
  expect(currentHeader).not.toHaveClass("management-page-header--compact");
  expect(currentHeader?.querySelector(".page-header__row .skills-header-bar__tools")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /设置/ }));
  const layoutGroup = screen.getByRole("group", { name: "管理页头布局" });
  const currentLayoutButton = within(layoutGroup).getByRole("button", { name: "横向来源导航" });
  const compactLayoutButton = within(layoutGroup).getByRole("button", { name: "紧凑来源选择" });
  expect(currentLayoutButton).toHaveAttribute("aria-pressed", "true");
  expect(compactLayoutButton).toHaveAttribute("aria-pressed", "false");
  await user.click(compactLayoutButton);
  await user.click(screen.getByRole("button", { name: /Skills/ }));

  const compactSkillsHeader = container.querySelector(".management-page-header--compact");
  const skillIdentity = compactSkillsHeader?.querySelector(".management-page-header__identity");
  const skillToolbarRow = compactSkillsHeader?.querySelector(".management-page-header__toolbar-row");
  expect(skillIdentity?.querySelector("h1")).toHaveTextContent("Skills");
  expect(skillIdentity?.querySelector("p")).toHaveTextContent("~/.skilldock/skills");
  expect(screen.queryByRole("tablist", { name: "Skill 来源" })).not.toBeInTheDocument();
  const sourceTrigger = screen.getByRole("button", { name: /已托管 4/ });
  expect(sourceTrigger.closest(".management-page-header__source")).toBeInTheDocument();
  expect(skillToolbarRow?.querySelector(".skills-header-bar__tools")).toBeInTheDocument();
  expect(compactSkillsHeader?.querySelector(".skills-source-divider")).toBeInTheDocument();
  expect(container.querySelector(".page-header-divider")).toHaveClass("page-header-divider--skills");

  await user.click(sourceTrigger);
  expect(screen.getByRole("menuitem", { name: /Codex 5/ })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "MCP" }));
  const compactMcpHeader = container.querySelector(".management-page-header--compact");
  expect(compactMcpHeader?.querySelector(".management-page-header__identity h1")).toHaveTextContent("MCP");
  expect(compactMcpHeader?.querySelector(".management-page-header__toolbar-row .mcp-toolbar")).toBeInTheDocument();
  expect(container.querySelector(".page-header-divider")).toHaveClass("page-header-divider--skills");

  await user.click(screen.getByRole("button", { name: /Plugins/ }));
  const compactPluginsHeader = container.querySelector(".management-page-header--compact");
  expect(compactPluginsHeader?.querySelector(".management-page-header__identity h1")).toHaveTextContent("Plugins");
  expect(compactPluginsHeader?.querySelector(".management-page-header__toolbar-row .plugins-page__toolbar-primary")).toBeInTheDocument();
  const pluginSourceTrigger = screen.getByRole("button", { name: "插件宿主" });
  expect(pluginSourceTrigger).toBeInTheDocument();
  expect(pluginSourceTrigger.querySelector("svg")).toBeInTheDocument();
  expect(pluginSourceTrigger).not.toHaveTextContent(/^P/);
  const pluginToolbar = compactPluginsHeader?.querySelector(".plugins-page__toolbar-primary");
  expect(pluginToolbar).toBeInTheDocument();
  expect(pluginToolbar).toContainElement(screen.getByRole("button", { name: "刷新" }));
  expect(pluginToolbar).toContainElement(screen.getByRole("button", { name: "扫描导入" }));
  expect(pluginToolbar).toContainElement(screen.getByRole("button", { name: "去安装" }));
  expect(container.querySelector(".page-header-divider")).toHaveClass("page-header-divider--skills");
});

test("toggles tool status from the full row", async () => {
  window.localStorage.clear();
  const alignMock = vi.mocked(alignExpandedRowIntoView);
  alignMock.mockClear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /设置/ }));

  await userEvent.click(screen.getByRole("button", { name: "工具状态" }));

  expect(screen.getByText("CodeBuddy")).toBeInTheDocument();
  expect(alignMock).toHaveBeenCalledWith(expect.any(HTMLElement));

  await userEvent.click(screen.getByRole("button", { name: "工具状态" }));

  expect(screen.queryByText("CodeBuddy")).not.toBeInTheDocument();
  expect(alignMock).toHaveBeenCalledTimes(1);
});

test("checks app updates from settings", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /设置/ }));

  expect(screen.getByText("软件更新")).toBeInTheDocument();
  expect(await screen.findByText("0.1.0")).toBeInTheDocument();
  expect(screen.getByText("尚未检查更新")).toBeInTheDocument();

  const checkButton = screen.getByRole("button", { name: "检查更新" });
  expect(checkButton.querySelector("svg")).not.toBeNull();

  await userEvent.click(checkButton);

  expect(await screen.findByText("当前已经是最新版本")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "下载并重启" })).not.toBeInTheDocument();
});

test("switches app update action to install when a new version is available", async () => {
  window.localStorage.clear();
  const install = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(appUpdateClient, "checkForAppUpdate").mockResolvedValue({
    available: true,
    currentVersion: "0.1.0",
    version: "0.2.0",
    releaseNotesHistory: [
      {
        version: "0.2.0",
        body: "## 修复\n\n- 修复首次安装默认编辑器未同步到实际打开行为。",
      },
      {
        version: "0.1.9",
        body: "## 优化\n\n- 默认语言选择由 IP 改为识别系统语言规则。",
      },
    ],
    install,
  });

  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /设置/ }));
  await userEvent.click(screen.getByRole("button", { name: "检查更新" }));

  expect(await screen.findByText("发现新版本 0.2.0")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "更新日志" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "检查更新" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "更新日志" }));

  expect(screen.getByText("更新内容")).toBeInTheDocument();
  expect(screen.getByText("Version 0.2.0")).toBeInTheDocument();
  expect(screen.getByText("Version 0.1.9")).toBeInTheDocument();
  expect(screen.getByText("修复首次安装默认编辑器未同步到实际打开行为。")).toBeInTheDocument();
  expect(screen.getByText("默认语言选择由 IP 改为识别系统语言规则。")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "更新日志" }));

  expect(screen.queryByText("更新内容")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "下载并重启" }));

  expect(install).toHaveBeenCalled();
  expect(screen.getByText("正在下载并安装更新...")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "安装中..." })).toBeDisabled();
});

test("shows release notes controls in English settings", async () => {
  window.localStorage.clear();
  vi.spyOn(appUpdateClient, "checkForAppUpdate").mockResolvedValue({
    available: true,
    currentVersion: "0.1.0",
    version: "0.2.0",
    releaseNotesHistory: [
      {
        version: "0.2.0",
        body: "## Fixes\n\n- Improve update summary readability.",
      },
    ],
    install: vi.fn().mockResolvedValue(undefined),
  });

  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /设置/ }));
  await userEvent.click(screen.getByLabelText("界面语言"));
  await userEvent.click(screen.getByRole("option", { name: "English" }));
  await userEvent.click(screen.getByRole("button", { name: "Check for Updates" }));

  expect(await screen.findByText("New version found: 0.2.0")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Release Notes" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download and Restart" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Release Notes" }));

  expect(screen.getByText("What's in this update")).toBeInTheDocument();
  expect(screen.getByText("Improve update summary readability.")).toBeInTheDocument();
});

test("opens the storage folder from settings", async () => {
  window.localStorage.clear();
  const invokeMock = vi.mocked(invoke);
  invokeMock.mockClear();

  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /设置/ }));
  expect(screen.getByText("/Users/demo/.skilldock")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "打开配置文件存储目录" })).toBeInTheDocument();

  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invokeMock.mockResolvedValue(undefined);
  await userEvent.click(screen.getByText("/Users/demo/.skilldock"));

  expect(invokeMock).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "打开配置文件存储目录" }));

  expect(invokeMock).toHaveBeenCalledWith("open_path_in_finder", {
    path: "/Users/demo/.skilldock",
  });

  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

test("switches interface language to English from settings", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /设置/ }));
  await userEvent.click(screen.getByLabelText("界面语言"));
  await userEvent.click(screen.getByRole("option", { name: "English" }));

  expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  expect(screen.getByText("App Preferences")).toBeInTheDocument();
  expect(screen.getByLabelText("Interface Language")).toHaveAttribute("data-value", "en");
});

test("defaults to the system theme and persists explicit theme choices", async () => {
  const user = userEvent.setup();
  window.localStorage.clear();
  const mediaQuery = {
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));
  render(<App />);

  await user.click(screen.getByRole("button", { name: /设置/ }));

  const darkThemeButton = screen.getByRole("button", { name: "深色" });
  const systemThemeButton = screen.getByRole("button", { name: "跟随系统" });
  expect(systemThemeButton).toHaveAttribute("aria-pressed", "true");
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  expect(window.localStorage.getItem("skilldock.settings.theme")).toBe("system");

  mediaQuery.matches = false;
  const handleSystemThemeChange = mediaQuery.addEventListener.mock.calls[0]?.[1] as (() => void) | undefined;
  handleSystemThemeChange?.();
  expect(document.documentElement).toHaveAttribute("data-theme", "light");

  await user.click(darkThemeButton);

  expect(darkThemeButton).toHaveAttribute("aria-pressed", "true");
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  expect(window.localStorage.getItem("skilldock.settings.theme")).toBe("dark");

  await user.click(screen.getByRole("button", { name: "Skills" }));
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  await user.click(screen.getByRole("button", { name: /设置/ }));

  const restoredLightThemeButton = screen.getByRole("button", { name: "浅色" });
  await user.click(restoredLightThemeButton);

  expect(restoredLightThemeButton).toHaveAttribute("aria-pressed", "true");
  expect(document.documentElement).toHaveAttribute("data-theme", "light");
  expect(window.localStorage.getItem("skilldock.settings.theme")).toBe("light");
});
