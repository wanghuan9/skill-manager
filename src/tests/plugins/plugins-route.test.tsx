import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { listen } from "@tauri-apps/api/event";
import { PluginsRoute, resetPluginScanSessionForTests } from "@/app/routes/plugins";
import * as skillClient from "@/features/skills/api/skill-client";
import { pluginFixtures } from "@/features/skills/state/skill-fixtures";
import type { PluginComponentPreview, PluginHostTool, PluginSummary } from "@/features/skills/state/skill-store";
import { formatSkillUpdatedAt } from "@/features/skills/utils/skill-time";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { renderWithI18n } from "@/tests/helpers/render-with-i18n";

vi.mock("@/features/skills/state/skill-workspace", () => ({
  useSkillWorkspace: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

const mockedUseSkillWorkspace = vi.mocked(useSkillWorkspace);
const mockedListen = vi.mocked(listen);

beforeEach(() => {
  delete (window as Window & { __SKILLM_PLUGINS__?: unknown }).__SKILLM_PLUGINS__;
  window.localStorage.clear();
  resetPluginScanSessionForTests();
  mockedUseSkillWorkspace.mockReturnValue({
    defaultOpenToolId: "finder",
    language: "zh-CN",
    toolConfigs: [],
  } as unknown as ReturnType<typeof useSkillWorkspace>);
  mockedListen.mockReset();
  mockedListen.mockResolvedValue(() => undefined);
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValue(pluginFixtures);
  vi.spyOn(skillClient, "fetchInstalledPlugins").mockResolvedValue(pluginFixtures);
  vi.spyOn(skillClient, "refreshPluginStates").mockResolvedValue(pluginFixtures);
  vi.spyOn(skillClient, "fetchLocalPluginStates").mockResolvedValue(pluginFixtures);
  vi.spyOn(skillClient, "refreshLocalPluginState").mockImplementation(async (input) => {
    const matchedPlugin = pluginFixtures.find((plugin) => (
      plugin.hostTool === input.hostTool && plugin.rootPath === input.rootPath
    ));
    return matchedPlugin ?? pluginFixtures[0];
  });
});

function setWorkspaceLanguage(language: "zh-CN" | "en") {
  mockedUseSkillWorkspace.mockReturnValue({
    defaultOpenToolId: "finder",
    language,
    toolConfigs: [],
  } as unknown as ReturnType<typeof useSkillWorkspace>);
}

test("places plugin batch selection after the filter and before refresh", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByText("Repo Scout");
  const toolbar = screen.getByLabelText("插件工具栏");
  const filter = within(toolbar).getByRole("combobox", { name: "筛选插件状态" })
    .closest(".plugins-page__toolbar-filter");
  const batchModeButton = within(toolbar).getByRole("button", { name: "批量选择" });
  const refreshButton = within(toolbar).getByRole("button", { name: "刷新" });
  const filterPosition = filter?.compareDocumentPosition(batchModeButton) ?? 0;
  expect(filterPosition & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(batchModeButton.compareDocumentPosition(refreshButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("hydrates plugins from runtime cache before the refresh request resolves", async () => {
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  const cachedPlugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      statusText: "来自启动缓存。",
    },
  ];
  (window as Window & { __SKILLM_PLUGINS__?: PluginSummary[] | null }).__SKILLM_PLUGINS__ = cachedPlugins;

  const deferredFetch: {
    resolve?: (value: PluginSummary[]) => void;
  } = {};
  const startupSpy = vi
    .spyOn(skillClient, "fetchStartupInstalledPlugins")
    .mockImplementationOnce(
      () =>
        new Promise<PluginSummary[]>((resolve) => {
          deferredFetch.resolve = resolve;
        }),
    );

  renderWithI18n(<PluginsRoute />);

  expect(screen.getByText("Repo Scout")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "全部 1" })).toBeInTheDocument();
  expect(screen.queryByText("正在加载插件...")).not.toBeInTheDocument();
  expect(screen.queryByText("当前筛选条件下没有匹配的插件。")).not.toBeInTheDocument();
  expect(startupSpy).toHaveBeenCalledTimes(1);

  if (!deferredFetch.resolve) {
    fixtureSpy.mockRestore();
    throw new Error("missing plugin fetch resolver");
  }
  deferredFetch.resolve(pluginFixtures);

  await screen.findByRole("tab", { name: /全部/ });
  startupSpy.mockRestore();
  fixtureSpy.mockRestore();
});

test("selects plugins without opening details and requires confirmation before batch deletion", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByText("Repo Scout");
  await userEvent.click(screen.getByRole("button", { name: "批量选择" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "选择插件 Repo Scout" }));

  expect(screen.queryByText("基本信息")).not.toBeInTheDocument();
  expect(screen.getByLabelText("批量操作")).toHaveTextContent("已选 1 个");
  await userEvent.click(screen.getByRole("button", { name: "删除 1 个" }));

  expect(screen.getByRole("dialog", { name: "删除 1 个插件？" })).toHaveTextContent("关联宿主安装");
});

test("deduplicates batch plugin updates that share the same repository", async () => {
  const sharedRoot = "/Users/demo/workspace/shared-plugin-repo";
  const sharedPlugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      id: "shared-alpha",
      packageId: "shared-alpha",
      name: "Shared Alpha",
      rootPath: sharedRoot,
      repoRootPath: sharedRoot,
      manifestPath: `${sharedRoot}/alpha/.codex-plugin/plugin.json`,
    },
    {
      ...pluginFixtures[0],
      id: "shared-beta",
      packageId: "shared-beta",
      name: "Shared Beta",
      rootPath: sharedRoot,
      repoRootPath: sharedRoot,
      manifestPath: `${sharedRoot}/beta/.codex-plugin/plugin.json`,
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(sharedPlugins);
  const updateSpy = vi.spyOn(skillClient, "updatePlugin").mockResolvedValue(sharedPlugins[0]);

  renderWithI18n(<PluginsRoute />);

  await screen.findByText("Shared Alpha");
  await userEvent.click(screen.getByRole("button", { name: "批量选择" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "选择插件 Shared Alpha" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "选择插件 Shared Beta" }));
  await userEvent.click(screen.getByRole("button", { name: "更新 2 个" }));

  await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
});

test("switches plugins to cards, opens details in a dialog, and restores the preference", async () => {
  const firstRender = renderWithI18n(<PluginsRoute />);

  await screen.findByText("Repo Scout");
  const repoScoutListRow = screen.getByRole("button", { name: "展开 Repo Scout" })
    .closest(".tool-list-row");
  const listEnabledBadge = repoScoutListRow?.querySelector(
    ".tool-list-row__title-row > .status-badge",
  );
  expect(listEnabledBadge).toHaveTextContent("已启用");
  expect(listEnabledBadge).toHaveClass("tone-info");
  expect(repoScoutListRow).not.toHaveTextContent("Git 仓库");

  await userEvent.click(screen.getByRole("button", { name: "卡片" }));

  expect(document.querySelector(".plugins-page > .card-list")).toHaveClass("tool-card-grid");
  expect(window.localStorage.getItem("plugins:view-mode")).toBe("grid");
  const repoScoutCard = screen.getByRole("button", { name: "展开 Repo Scout" }).closest(".tool-list-row");
  const eccCard = screen.getByRole("button", { name: "展开 ecc" }).closest(".tool-list-row");
  expect(repoScoutCard?.querySelectorAll(".tool-list-row__grid-badges > .status-badge")).toHaveLength(6);
  expect(eccCard?.querySelectorAll(".tool-list-row__grid-badges > .status-badge")).toHaveLength(1);
  const gridEnabledBadge = repoScoutCard?.querySelector(
    ".tool-list-row__grid-meta > .skill-card__grid-enabled-badge",
  );
  expect(gridEnabledBadge).toHaveTextContent("已启用");
  expect(gridEnabledBadge).toHaveClass("tone-info");
  expect(repoScoutCard?.querySelector(".tool-list-row__grid-meta .plugins-page__host-coverage-icon")).not.toBeNull();
  expect(repoScoutCard?.querySelector(".skill-card__git-source-badge")).toBeNull();
  expect(repoScoutCard?.querySelector(".tool-list-row__grid-footer")).toHaveTextContent("SkillDock 安装");
  expect(repoScoutCard).not.toHaveTextContent("Git 仓库");
  expect(repoScoutCard?.querySelector(".tool-list-row__actions > .tool-list-row__chevron")).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "展开 Repo Scout" }));
  const detailDialog = screen.getByRole("dialog", { name: "Repo Scout" });
  expect(detailDialog).toBeInTheDocument();
  expect(detailDialog.querySelectorAll(".tool-list-row__modal-badges > .status-badge")).toHaveLength(6);
  expect(within(detailDialog).getByText("基本信息")).toBeInTheDocument();
  expect(within(detailDialog).getByRole("button", { name: /打开.*Repo Scout/ })).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Repo Scout" })).not.toBeInTheDocument();

  firstRender.unmount();
  renderWithI18n(<PluginsRoute />);
  await screen.findByText("Repo Scout");
  expect(document.querySelector(".plugins-page > .card-list")).toHaveClass("tool-card-grid");
});

test("reconciles plugin config with a startup scan even when the plugin list is hydrated from cache", async () => {
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  const cachedPlugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      enabledState: "disabled",
      scopes: [
        {
          scopeId: "user",
          scopeLabel: "用户级",
          enabledState: "disabled",
          location: "~/.codex/config.toml",
        },
      ],
    },
  ];
  (window as Window & { __SKILLM_PLUGINS__?: PluginSummary[] | null }).__SKILLM_PLUGINS__ = cachedPlugins;
  const startupPlugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      enabledState: "enabled",
      scopes: [
        {
          scopeId: "user",
          scopeLabel: "用户级",
          enabledState: "enabled",
          location: "~/.codex/config.toml",
        },
      ],
    },
  ];
  const startupSpy = vi
    .spyOn(skillClient, "fetchStartupInstalledPlugins")
    .mockResolvedValueOnce(startupPlugins);
  const scanSpy = vi.spyOn(skillClient, "fetchInstalledPlugins");

  renderWithI18n(<PluginsRoute />);

  expect(screen.getByText("Repo Scout")).toBeInTheDocument();
  expect(screen.queryByText("正在加载插件...")).not.toBeInTheDocument();

  await waitFor(() => {
    expect(startupSpy).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => {
    expect(screen.getByText("已启用")).toBeInTheDocument();
  });
  expect(scanSpy).not.toHaveBeenCalled();
  fixtureSpy.mockRestore();
});

test("refreshes local plugin state again when returning to the plugin page window", async () => {
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  const initialPlugin: PluginSummary = {
    ...pluginFixtures[0],
    enabledState: "disabled",
    scopes: [
      {
        scopeId: "user",
        scopeLabel: "用户级",
        enabledState: "disabled",
        location: "~/.codex/config.toml",
      },
    ],
  };
  const syncedPlugin: PluginSummary = {
    ...pluginFixtures[0],
    enabledState: "enabled",
    scopes: [
      {
        scopeId: "user",
        scopeLabel: "用户级",
        enabledState: "enabled",
        location: "~/.codex/config.toml",
      },
    ],
  };
  const startupSpy = vi
    .spyOn(skillClient, "fetchStartupInstalledPlugins")
    .mockResolvedValueOnce([initialPlugin]);
  const localStatesSpy = vi
    .spyOn(skillClient, "fetchLocalPluginStates")
    .mockResolvedValueOnce([syncedPlugin]);
  const remoteRefreshSpy = vi.spyOn(skillClient, "refreshPluginStates").mockResolvedValue([syncedPlugin]);
  const localRefreshSpy = vi.spyOn(skillClient, "refreshLocalPluginState");

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });

  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });

  await waitFor(() => {
    expect(startupSpy).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => {
    expect(localStatesSpy).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => {
    expect(remoteRefreshSpy).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => {
    expect(screen.getByText("已启用")).toBeInTheDocument();
  });
  expect(localRefreshSpy).not.toHaveBeenCalled();
  fixtureSpy.mockRestore();
});

test("refreshes pending commit and pending push state on every focus", async () => {
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  const pendingCommitPlugin: PluginSummary = {
    ...pluginFixtures[0],
    installSource: "skilldock",
    updateMode: "auto",
    updateStrategy: "git",
    collabStatus: "pending-commit",
    updateAvailable: false,
    statusText: "插件目录存在本地未提交改动。",
  };
  const pendingPushPlugin: PluginSummary = {
    ...pendingCommitPlugin,
    collabStatus: "pending-push",
    statusText: "插件目录存在待推送提交。",
  };
  const cleanPlugin: PluginSummary = {
    ...pendingCommitPlugin,
    collabStatus: "clean",
    statusText: "插件目录已是最新。",
  };
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce([
    pendingCommitPlugin,
  ]);
  const remoteRefreshSpy = vi
    .spyOn(skillClient, "refreshPluginStates")
    .mockResolvedValue([pendingCommitPlugin]);
  const localStatesSpy = vi
    .spyOn(skillClient, "fetchLocalPluginStates")
    .mockResolvedValueOnce([pendingPushPlugin])
    .mockResolvedValueOnce([cleanPlugin]);

  renderWithI18n(<PluginsRoute />);

  await screen.findByText("待提交");
  await waitFor(() => {
    expect(remoteRefreshSpy).toHaveBeenCalledTimes(1);
  });

  window.dispatchEvent(new Event("focus"));
  await screen.findByText("待推送");

  window.dispatchEvent(new Event("focus"));
  await waitFor(() => {
    expect(screen.queryByText("待推送")).not.toBeInTheDocument();
  });

  expect(localStatesSpy).toHaveBeenCalledTimes(2);
  expect(remoteRefreshSpy).toHaveBeenCalledTimes(1);
  fixtureSpy.mockRestore();
});

test("refreshes remote plugin states in the background right after startup", async () => {
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  const startupPlugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      installSource: "skilldock",
      updateMode: "auto",
      updateStrategy: "hash",
      collabStatus: "clean",
      updateAvailable: false,
      statusText: "插件目录已是最新。",
    },
  ];
  const refreshedPlugins: PluginSummary[] = [
    {
      ...startupPlugins[0],
      collabStatus: "update-available",
      updateAvailable: true,
      statusText: "远端存在更新。",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(startupPlugins);
  const remoteRefreshSpy = vi.spyOn(skillClient, "refreshPluginStates").mockResolvedValueOnce(refreshedPlugins);
  const localRefreshSpy = vi.spyOn(skillClient, "refreshLocalPluginState");

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await waitFor(() => {
    expect(remoteRefreshSpy).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "更新 Repo Scout 插件" })).toBeInTheDocument();
  });
  expect(localRefreshSpy).not.toHaveBeenCalled();
  fixtureSpy.mockRestore();
});

test("stores the loaded plugin list in runtime cache", async () => {
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(pluginFixtures);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });

  expect(
    (window as Window & { __SKILLM_PLUGINS__?: PluginSummary[] | null }).__SKILLM_PLUGINS__,
  ).toEqual(pluginFixtures);
  fixtureSpy.mockRestore();
});

test("triggers one automatic scan import on the first empty open", async () => {
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  const startupSpy = vi
    .spyOn(skillClient, "fetchStartupInstalledPlugins")
    .mockResolvedValueOnce([]);
  const scanSpy = vi
    .spyOn(skillClient, "fetchInstalledPlugins")
    .mockResolvedValue(pluginFixtures);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });

  expect(startupSpy).toHaveBeenCalledTimes(1);
  await waitFor(() => {
    expect(scanSpy).toHaveBeenCalledTimes(1);
  });
  expect(window.localStorage.getItem("skilldock.plugins.firstEmptyAutoScanCompleted")).toBe("true");
  fixtureSpy.mockRestore();
});

test("does not trigger automatic scan import again after the first empty open", async () => {
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  window.localStorage.setItem("skilldock.plugins.firstEmptyAutoScanCompleted", "true");
  const startupSpy = vi
    .spyOn(skillClient, "fetchStartupInstalledPlugins")
    .mockResolvedValueOnce([]);
  const scanSpy = vi
    .spyOn(skillClient, "fetchInstalledPlugins")
    .mockResolvedValue(pluginFixtures);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });

  expect(startupSpy).toHaveBeenCalledTimes(1);
  expect(scanSpy).not.toHaveBeenCalled();
  fixtureSpy.mockRestore();
});

test("defaults to the all tab and shows deduplicated plugin packages", async () => {
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  const plugins: PluginSummary[] = [
    pluginFixtures[0],
    {
      ...pluginFixtures[0],
      hostTool: "claude-code",
      relatedHostTools: ["codex"],
      rootPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0",
      manifestPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0/.claude-plugin/plugin.json",
      installSource: "host",
      enabledState: "disabled",
      scopes: [
        {
          scopeId: "user",
          scopeLabel: "用户级",
          enabledState: "disabled",
          location: "~/.claude/settings.json",
        },
      ],
    },
    pluginFixtures[1],
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  const allTab = await screen.findByRole("tab", { name: "全部 2" });
  expect(allTab).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Claude Code 2" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Codex 1" })).toBeInTheDocument();
  expect(await screen.findByText("Repo Scout")).toBeInTheDocument();
  expect(screen.getByText("ecc")).toBeInTheDocument();
  expect(screen.getAllByText("Repo Scout")).toHaveLength(1);
  const repoScoutRow = screen.getByRole("button", { name: /展开 Repo Scout/ }).closest(".tool-list-row");
  expect(repoScoutRow?.querySelectorAll(".plugins-page__host-coverage-item")).toHaveLength(2);
  expect(repoScoutRow?.querySelector('[data-tooltip="Codex 已安装（已启用）"]')).toBeInTheDocument();
  expect(repoScoutRow?.querySelector('[data-tooltip="Claude Code 已安装（未启用）"]')).toBeInTheDocument();
  fixtureSpy.mockRestore();
});

test("aggregates the same plugin in all tab even when host package ids differ", async () => {
  const plugins: PluginSummary[] = [
    pluginFixtures[0],
    {
      ...pluginFixtures[0],
      id: "claude-code:repo-scout",
      packageId: "claude-repo-scout",
      hostTool: "claude-code",
      relatedHostTools: ["codex"],
      rootPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0",
      manifestPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0/.claude-plugin/plugin.json",
      installSource: "host",
      enabledState: "disabled",
      scopes: [
        {
          scopeId: "user",
          scopeLabel: "用户级",
          enabledState: "disabled",
          location: "~/.claude/settings.json",
        },
      ],
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  const allTab = await screen.findByRole("tab", { name: "全部 1" });
  expect(allTab).toHaveAttribute("aria-selected", "true");
  expect(screen.getAllByText("Repo Scout")).toHaveLength(1);
  const repoScoutRow = screen.getByRole("button", { name: /展开 Repo Scout/ }).closest(".tool-list-row");
  expect(repoScoutRow?.querySelector('[data-tooltip="Codex 已安装（已启用）"]')).toBeInTheDocument();
  expect(repoScoutRow?.querySelector('[data-tooltip="Claude Code 已安装（未启用）"]')).toBeInTheDocument();
});

test("aggregates cross-host plugins by canonical plugin name instead of display name", async () => {
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      id: "codex:example-plugin",
      packageId: "example-plugin",
      manifestName: "example-plugin",
      name: "Example Plugin",
      hostTool: "codex",
      sourceLabel: "example-plugin",
      sourceUrl: "https://github.com/example-org/example-plugin",
      repoRootPath: "/Users/demo/.codex/plugins/cache/example-org/example-plugin/0.1.0",
      rootPath: "/Users/demo/.codex/plugins/cache/example-org/example-plugin/0.1.0",
      manifestPath: "/Users/demo/.codex/plugins/cache/example-org/example-plugin/0.1.0/plugin.json",
      installSource: "host",
      relatedHostTools: ["claude-code"],
      enabledState: "enabled",
      scopes: [
        {
          scopeId: "project",
          scopeLabel: "工作区",
          enabledState: "enabled",
          location: "/Users/demo/project/.codex/config.toml",
        },
      ],
    },
    {
      ...pluginFixtures[0],
      id: "claude-code:example-plugin",
      packageId: "example-plugin",
      manifestName: "example-plugin",
      name: "example-plugin",
      hostTool: "claude-code",
      sourceLabel: "Example Plugin",
      sourceUrl: "https://github.com/example-org/example-plugin.git",
      repoRootPath: "/Users/demo/.claude/plugins/cache/example-org/example-plugin/0.1.0",
      relatedHostTools: ["codex"],
      rootPath: "/Users/demo/.claude/plugins/cache/example-org/example-plugin/0.1.0",
      manifestPath: "/Users/demo/.claude/plugins/cache/example-org/example-plugin/0.1.0/.claude-plugin/plugin.json",
      installSource: "host",
      enabledState: "enabled",
      scopes: [
        {
          scopeId: "user",
          scopeLabel: "用户级",
          enabledState: "enabled",
          location: "~/.claude/settings.json",
        },
      ],
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  const allTab = await screen.findByRole("tab", { name: "全部 1" });
  expect(allTab).toHaveAttribute("aria-selected", "true");
  expect(screen.getAllByText(/Example Plugin|example-plugin/)).toHaveLength(1);
  const row = screen.getByRole("button", { name: /展开 Example Plugin|展开 example-plugin/ }).closest(".tool-list-row");
  expect(row?.querySelector('[data-tooltip="Codex 已安装（已启用）"]')).toBeInTheDocument();
  expect(row?.querySelector('[data-tooltip="Claude Code 已安装（已启用）"]')).toBeInTheDocument();
});

test("aggregates cross-host plugins when source URL includes a git web branch and plugin path", async () => {
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      id: "codex:example-plugin",
      packageId: "example-plugin",
      manifestName: "example-plugin",
      name: "example-plugin",
      hostTool: "codex",
      sourceLabel: "skilldock",
      sourceUrl: "https://git.example.com/example-org/example-repo",
      repoRootPath: "/Users/demo/.skilldock/plugins/example-plugin-example-repo",
      rootPath: "/Users/demo/.codex/plugins/cache/skilldock/example-plugin",
      manifestPath: "/Users/demo/.codex/plugins/cache/skilldock/example-plugin/.codex-plugin/plugin.json",
      installSource: "skilldock",
      relatedHostTools: [],
      enabledState: "enabled",
      scopes: [],
      components: [],
    },
    {
      ...pluginFixtures[0],
      id: "claude-code:example-plugin",
      packageId: "example-plugin",
      manifestName: "example-plugin",
      name: "example-plugin",
      hostTool: "claude-code",
      sourceLabel: "skilldock",
      sourceUrl: "https://git.example.com/example-org/example-repo/tree/master/example-plugin",
      repoRootPath: "/Users/demo/.skilldock/plugins/example-plugin",
      rootPath: "/Users/demo/.claude/plugins/marketplaces/skilldock/plugins/example-plugin",
      manifestPath: "/Users/demo/.claude/plugins/marketplaces/skilldock/plugins/example-plugin/.claude-plugin/plugin.json",
      installSource: "skilldock",
      relatedHostTools: [],
      enabledState: "enabled",
      scopes: [],
      components: [],
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  const allTab = await screen.findByRole("tab", { name: "全部 1" });
  expect(allTab).toHaveAttribute("aria-selected", "true");
  expect(screen.getAllByText("example-plugin")).toHaveLength(1);
  const row = screen.getByRole("button", { name: /展开 example-plugin/ }).closest(".tool-list-row");
  expect(row?.querySelector('[data-tooltip="Codex 已安装（已启用）"]')).toBeInTheDocument();
  expect(row?.querySelector('[data-tooltip="Claude Code 已安装（已启用）"]')).toBeInTheDocument();
});

test("aggregates plugins by manifest name when Codex display name differs from other hosts", async () => {
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      id: "codex:shopify-plugin",
      packageId: "shopify-ai-toolkit",
      manifestName: "shopify-plugin",
      name: "Shopify",
      hostTool: "codex",
      sourceLabel: "skilldock",
      sourceUrl: "https://github.com/Shopify/Shopify-AI-Toolkit",
      repoRootPath: "/Users/demo/.skilldock/plugins/shopify-ai-toolkit",
      rootPath: "/Users/demo/.codex/plugins/cache/skilldock/shopify-plugin/1.4.1",
      displayRootPath: "/Users/demo/.codex/marketplaces/skilldock/plugins/shopify-plugin",
      manifestPath: "/Users/demo/.codex/marketplaces/skilldock/plugins/shopify-plugin/.codex-plugin/plugin.json",
      installSource: "skilldock",
      relatedHostTools: ["claude-code"],
      enabledState: "enabled",
      scopes: [],
      components: [],
    },
    {
      ...pluginFixtures[0],
      id: "claude-code:shopify-plugin",
      packageId: "shopify-ai-toolkit",
      manifestName: "shopify-plugin",
      name: "shopify-plugin",
      hostTool: "claude-code",
      sourceLabel: "Shopify",
      sourceUrl: "https://github.com/Shopify/Shopify-AI-Toolkit.git",
      repoRootPath: "/Users/demo/.skilldock/plugins/shopify-ai-toolkit",
      rootPath: "/Users/demo/.claude/plugins/shopify-plugin",
      displayRootPath: "/Users/demo/.claude/plugins/shopify-plugin",
      manifestPath: "/Users/demo/.claude/plugins/shopify-plugin/.claude-plugin/plugin.json",
      installSource: "skilldock",
      relatedHostTools: ["codex"],
      enabledState: "enabled",
      scopes: [],
      components: [],
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  const allTab = await screen.findByRole("tab", { name: "全部 1" });
  expect(allTab).toHaveAttribute("aria-selected", "true");
  expect(screen.getAllByText(/Shopify|shopify-plugin/)).toHaveLength(1);
  const row = screen.getByRole("button", { name: /展开 Shopify|展开 shopify-plugin/ }).closest(".tool-list-row");
  expect(row?.querySelector('[data-tooltip="Codex 已安装（已启用）"]')).toBeInTheDocument();
  expect(row?.querySelector('[data-tooltip="Claude Code 已安装（已启用）"]')).toBeInTheDocument();
});

test("uses manifest name as the visible plugin title when hosts disagree on display name", async () => {
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      id: "codex:shopify-plugin",
      packageId: "shopify-ai-toolkit",
      manifestName: "shopify-plugin",
      name: "Shopify",
      hostTool: "codex",
      sourceLabel: "skilldock",
      sourceUrl: "https://github.com/Shopify/Shopify-AI-Toolkit",
      repoRootPath: "/Users/demo/.skilldock/plugins/shopify-ai-toolkit",
      rootPath: "/Users/demo/.codex/plugins/cache/skilldock/shopify-plugin/1.4.1",
      displayRootPath: "/Users/demo/.codex/marketplaces/skilldock/plugins/shopify-plugin",
      manifestPath: "/Users/demo/.codex/marketplaces/skilldock/plugins/shopify-plugin/.codex-plugin/plugin.json",
      installSource: "skilldock",
      relatedHostTools: ["claude-code"],
      enabledState: "enabled",
      scopes: [],
      components: [],
    },
    {
      ...pluginFixtures[0],
      id: "claude-code:shopify-plugin",
      packageId: "shopify-ai-toolkit",
      manifestName: "shopify-plugin",
      name: "shopify-plugin",
      hostTool: "claude-code",
      sourceLabel: "Shopify",
      sourceUrl: "https://github.com/Shopify/Shopify-AI-Toolkit.git",
      repoRootPath: "/Users/demo/.skilldock/plugins/shopify-ai-toolkit",
      rootPath: "/Users/demo/.claude/plugins/shopify-plugin",
      displayRootPath: "/Users/demo/.claude/plugins/shopify-plugin",
      manifestPath: "/Users/demo/.claude/plugins/shopify-plugin/.claude-plugin/plugin.json",
      installSource: "skilldock",
      relatedHostTools: ["codex"],
      enabledState: "enabled",
      scopes: [],
      components: [],
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: "全部 1" });
  expect(screen.getByText("shopify-plugin")).toBeInTheDocument();
  expect(screen.queryByText("Shopify")).not.toBeInTheDocument();
});

test("shows disabled plugin state with description-first source details", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));
  expect(await screen.findByText("ecc")).toBeInTheDocument();
  expect(screen.getAllByText("未启用").length).toBeGreaterThan(0);
  const eccRow = screen.getByRole("button", { name: /展开 ecc/ }).closest(".tool-list-row");
  expect(eccRow?.querySelectorAll(".plugins-page__host-coverage-item")).toHaveLength(0);

  await userEvent.click(screen.getByRole("button", { name: /展开 ecc/ }));
  expect(screen.getByText("基本信息")).toBeInTheDocument();
  expect(screen.getByText("简介")).toBeInTheDocument();
  expect(screen.getByText("本地更新时间")).toBeInTheDocument();
  expect(screen.queryByText(/远端更新时间/)).not.toBeInTheDocument();
  expect(screen.queryByText(/更新人/)).not.toBeInTheDocument();
  expect(screen.queryByText("未获取")).not.toBeInTheDocument();
  expect(screen.getAllByText("Claude Code 官方插件，用于管理和运行扩展命令。").length)
    .toBeGreaterThanOrEqual(2);
  expect(screen.getByText("安装方式")).toBeInTheDocument();
  expect(screen.getByText("宿主安装")).toBeInTheDocument();
  expect(screen.getByText("来源类型")).toBeInTheDocument();
  expect(screen.getByText("Marketplace")).toBeInTheDocument();
  expect(screen.getByText("来源")).toBeInTheDocument();
  expect(screen.getByText("插件目录")).toBeInTheDocument();
  expect(screen.queryByText("分支")).not.toBeInTheDocument();
  expect(screen.queryByText("git")).not.toBeInTheDocument();
  expect(screen.queryByText("仓库")).not.toBeInTheDocument();
  expect(screen.queryByText("Git 地址")).not.toBeInTheDocument();
  expect(screen.queryByText("宿主")).not.toBeInTheDocument();
  expect(screen.queryByText("安装状态")).not.toBeInTheDocument();
  expect(screen.queryByText("启用状态")).not.toBeInTheDocument();
  expect(screen.queryByText("启用范围")).not.toBeInTheDocument();
  expect(screen.queryByText("用户级")).not.toBeInTheDocument();
});

test("hides remote update metadata for local plugins to match skill details", async () => {
  const localPlugin: PluginSummary = {
    ...pluginFixtures[0],
    id: "codex:local-plugin",
    name: "Local Plugin",
    hostTool: "codex",
    sourceType: "local",
    sourceLabel: "本地",
    sourceUrl: "",
    rootPath: "/Users/demo/.codex/plugins/local-plugin",
    repoRootPath: "/Users/demo/.codex/plugins/local-plugin",
    manifestPath: "/Users/demo/.codex/plugins/local-plugin/plugin.json",
    isGitRepo: false,
    remoteUpdatedAt: "1778488200000",
    localUpdatedAt: "1778488200000",
    lastEditor: "Local Maintainer",
  };
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce([localPlugin]);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: "全部 1" });
  await userEvent.click(screen.getByRole("button", { name: /展开 Local Plugin/ }));

  expect(screen.getByText("本地更新时间")).toBeInTheDocument();
  expect(screen.queryByText("远端更新时间")).not.toBeInTheDocument();
  expect(screen.queryByText("更新人")).not.toBeInTheDocument();
});

test("falls back to current timestamps instead of showing not fetched in plugin meta summary", async () => {
  const pluginWithoutTimes: PluginSummary = {
    ...pluginFixtures[1],
    id: "claude-code:compound-engineering-plugin",
    name: "Compound Engineering Plugin",
    remoteUpdatedAt: "",
    localUpdatedAt: "",
    lastEditor: "Szymon Kocot",
  };
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce([pluginWithoutTimes]);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: "全部 1" });
  await userEvent.click(screen.getByRole("button", { name: /展开 Compound Engineering Plugin/ }));

  expect(screen.queryByText("未获取")).not.toBeInTheDocument();
  expect(screen.getByText("本地更新时间")).toBeInTheDocument();
  expect(screen.queryByText(/远端更新时间/)).not.toBeInTheDocument();
});

test("falls back to stable updatedAt for plugin local update time instead of current time", async () => {
  const pluginWithoutLocalUpdatedAt: PluginSummary = {
    ...pluginFixtures[0],
    id: "codex:stable-local-updated-at",
    name: "Stable Local Updated At",
    sourceType: "marketplace",
    isGitRepo: false,
    updatedAt: "1778488200000",
    localUpdatedAt: "",
    remoteUpdatedAt: "",
    lastEditor: "",
  };
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce([pluginWithoutLocalUpdatedAt]);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: "全部 1" });
  await userEvent.click(screen.getByRole("button", { name: /展开 Stable Local Updated At/ }));

  expect(screen.getByText(formatSkillUpdatedAt(pluginWithoutLocalUpdatedAt.updatedAt))).toBeInTheDocument();
  expect(screen.queryByText("未获取")).not.toBeInTheDocument();
});

test("keeps plugin scan import action in the toolbar", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });

  expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "扫描导入" })).toBeInTheDocument();
});

test("renders go-install action in the plugin toolbar", async () => {
  const onGoInstall = vi.fn();

  renderWithI18n(<PluginsRoute onGoInstall={onGoInstall} />);

  await screen.findByRole("tab", { name: /全部/ });

  const goInstallButton = screen.getByRole("button", { name: "去安装" });
  expect(goInstallButton).toHaveClass("skills-toolbar-button--go-install");
  expect(goInstallButton.parentElement?.lastElementChild).toBe(goInstallButton);
  await userEvent.click(goInstallButton);
  expect(onGoInstall).toHaveBeenCalledOnce();
});

test("refreshes the plugin list from the toolbar", async () => {
  const deferredFetch: {
    resolve?: (value: PluginSummary[]) => void;
  } = {};
  const fetchSpy = vi
    .spyOn(skillClient, "fetchInstalledPlugins")
    .mockImplementationOnce(
      () =>
        new Promise<PluginSummary[]>((resolve) => {
          deferredFetch.resolve = resolve;
        }),
    );

  renderWithI18n(<PluginsRoute />);

  try {
    await screen.findByRole("tab", { name: /全部/ });
    const refreshButton = screen.getByRole("button", { name: "刷新" });

    await userEvent.click(refreshButton);

    await waitFor(() => {
      expect(refreshButton).toBeDisabled();
      expect(
        refreshButton.querySelector(".skills-toolbar-button__svg.is-spinning"),
      ).toBeInTheDocument();
    });

    if (!deferredFetch.resolve) {
      throw new Error("missing plugin fetch resolver");
    }
    deferredFetch.resolve(pluginFixtures);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("refreshes only the active host tab from the toolbar", async () => {
  const fetchSpy = vi.spyOn(skillClient, "fetchInstalledPlugins");
  const localRefreshSpy = vi
    .spyOn(skillClient, "refreshLocalPluginState")
    .mockImplementation(async (input) => {
      const matchedPlugin = pluginFixtures.find((plugin) => (
        plugin.hostTool === input.hostTool && plugin.rootPath === input.rootPath
      ));
      if (!matchedPlugin) {
        throw new Error("missing plugin fixture for refresh");
      }
      return {
        ...matchedPlugin,
        statusText: `${matchedPlugin.statusText}（已刷新）`,
      };
    });

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));

  const refreshButton = screen.getByRole("button", { name: "刷新" });
  await userEvent.click(refreshButton);

  await waitFor(() => {
    expect(refreshButton).toBeEnabled();
  });

  expect(fetchSpy).not.toHaveBeenCalled();
  const claudePlugins = pluginFixtures.filter((plugin) => plugin.hostTool === "claude-code");
  expect(localRefreshSpy).toHaveBeenCalledTimes(claudePlugins.length);
  for (const plugin of claudePlugins) {
    expect(localRefreshSpy).toHaveBeenCalledWith({
      hostTool: "claude-code",
      rootPath: plugin.rootPath,
    });
  }
  expect(localRefreshSpy).not.toHaveBeenCalledWith(
    expect.objectContaining({ hostTool: "codex" }),
  );
  expect(localRefreshSpy).not.toHaveBeenCalledWith(
    expect.objectContaining({ hostTool: "cursor" }),
  );
});

test("opens plugin git source links externally", async () => {
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));
  await userEvent.click(screen.getByRole("button", { name: /展开 ecc/ }));
  await userEvent.click(
    screen.getByRole("link", { name: "https://github.com/example/ecc" }),
  );

  expect(openSpy).toHaveBeenCalledWith(
    "https://github.com/example/ecc",
    "_blank",
    "noopener,noreferrer",
  );

  openSpy.mockRestore();
});

test("builds plugin source link with branch and plugin subdirectory", async () => {
  const plugin: PluginSummary = {
    ...pluginFixtures[0],
    id: "claude-code:coding-tutor",
    packageId: "coding-tutor",
    name: "Coding Tutor",
    hostTool: "claude-code",
    relatedHostTools: [],
    rootPath: "/Users/demo/.skilldock/plugins/coding-tutor/plugins/coding-tutor",
    repoRootPath: "/Users/demo/.skilldock/plugins/coding-tutor",
    pluginRelativePath: "plugins/coding-tutor",
    manifestPath:
      "/Users/demo/.skilldock/plugins/coding-tutor/plugins/coding-tutor/.claude-plugin/plugin.json",
    sourceType: "git",
    sourceLabel: "SkillDock",
    sourceUrl: "https://github.com/everyinc/compound-engineering-plugin",
    sourceRef: "main",
    sourceRevision: "6f9ab03a031c054a8046659926251",
    currentVersion: "1.0.0",
    currentBranch: "main",
    currentCommit: "6f9ab03a031c054a8046659926251",
    collabStatus: "clean",
    statusText: "SkillDock 安装的插件。",
    isGitRepo: true,
    updateMode: "auto",
    updateAvailable: false,
    installedAt: "",
    updatedAt: "",
    lastScannedAt: "",
    status: "ready",
    installState: "installed",
    installSource: "skilldock",
    enabledState: "enabled",
    scopes: [
      {
        scopeId: "user",
        scopeLabel: "用户级",
        enabledState: "enabled",
        location: "~/.claude/settings.json",
      },
    ],
    components: pluginFixtures[0].components,
  };
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce([plugin]);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));
  await screen.findByText("Coding Tutor");
  await userEvent.click(screen.getByRole("button", { name: /展开 Coding Tutor/ }));

  expect(
    screen.getByRole("link", {
      name: "https://github.com/everyinc/compound-engineering-plugin/tree/main/plugins/coding-tutor",
    }),
  ).toBeInTheDocument();
  expect(screen.queryByText("当前分支")).not.toBeInTheDocument();
});

test("prefers plugin source url over source label in details", async () => {
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      hostTool: "cursor",
      name: "raisely",
      sourceType: "git",
      sourceLabel: "raisely",
      sourceUrl: "https://github.com/raisely/cursor-plugin.git",
      rootPath: "/Users/demo/.cursor/plugins/local/raisely",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Cursor/ }));
  await screen.findByText("raisely");
  await userEvent.click(screen.getByRole("button", { name: /展开 raisely/ }));

  expect(screen.getByText("https://github.com/raisely/cursor-plugin.git")).toBeInTheDocument();
  expect(screen.getByText("git")).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "https://github.com/raisely/cursor-plugin.git" }),
  ).toHaveClass("detail-grid__single-line");
});

test("does not show tooltip attributes for plugin source details", async () => {
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      hostTool: "cursor",
      name: "raisely",
      sourceType: "git",
      sourceLabel: "raisely",
      sourceUrl: "https://github.com/raisely/cursor-plugin.git",
      rootPath: "/Users/demo/.cursor/plugins/local/raisely",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Cursor/ }));
  await screen.findByText("raisely");
  await userEvent.click(screen.getByRole("button", { name: /展开 raisely/ }));

  const sourceLink = screen.getByRole("link", {
    name: "https://github.com/raisely/cursor-plugin.git",
  });
  expect(sourceLink).not.toHaveAttribute("data-tooltip");
  expect(sourceLink.closest("dd")).not.toHaveAttribute("title");
});

test("shows SkillDock install source with real source and plugin directory only", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  await screen.findByText("Repo Scout");
  await userEvent.click(screen.getByRole("button", { name: /展开 Repo Scout/ }));

  expect(screen.getByText("SkillDock 安装")).toBeInTheDocument();
  expect(screen.getByText("https://github.com/example/repo-scout")).toBeInTheDocument();
  expect(screen.getByText("插件目录")).toBeInTheDocument();
  expect(screen.getByText("/Users/demo/workspace/repo-scout")).toBeInTheDocument();
  expect(screen.queryByText("仓库")).not.toBeInTheDocument();
  expect(screen.queryByText("Git 状态")).not.toBeInTheDocument();
});

test("shows SkillDock install source with original repository for Codex plugins", async () => {
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      id: "codex:coding-tutor",
      packageId: "coding-tutor",
      name: "Coding Tutor",
      description:
        "Personalized coding tutorials that use your actual codebase for examples with spaced repetition quizzes",
      hostTool: "codex",
      relatedHostTools: [],
      rootPath: "/Users/demo/.skilldock/plugins/coding-tutor/plugins/coding-tutor",
      repoRootPath: "/Users/demo/.skilldock/plugins/coding-tutor",
      pluginRelativePath: "plugins/coding-tutor",
      manifestPath:
        "/Users/demo/.skilldock/plugins/coding-tutor/plugins/coding-tutor/.codex-plugin/plugin.json",
      sourceType: "git",
      sourceLabel: "skilldock",
      sourceUrl: "https://github.com/everyinc/compound-engineering-plugin",
      sourceRef: "",
      sourceRevision: "6f9ab03a031c054a8046659926251",
      currentVersion: "1.0.0",
      currentBranch: "main",
      currentCommit: "6f9ab03a031c054a8046659926251",
      collabStatus: "clean",
      statusText: "SkillDock 安装的插件。",
      isGitRepo: true,
      updateMode: "auto",
      updateAvailable: false,
      installedAt: "",
      updatedAt: "",
      lastScannedAt: "",
      status: "ready",
      installState: "installed",
      installSource: "skilldock",
      enabledState: "enabled",
      scopes: [
        {
          scopeId: "user",
          scopeLabel: "用户级",
          enabledState: "enabled",
          location: "~/.codex/config.toml",
        },
      ],
      components: pluginFixtures[0].components,
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  await screen.findByText("Coding Tutor");
  await userEvent.click(screen.getByRole("button", { name: /展开 Coding Tutor/ }));

  expect(screen.getByText("SkillDock 安装")).toBeInTheDocument();
  expect(screen.getByText("Git 仓库")).toBeInTheDocument();
  expect(
    screen.getByText(
      "https://github.com/everyinc/compound-engineering-plugin/tree/main/plugins/coding-tutor",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText("/Users/wanghuan/.codex/marketplaces/skilldock")).not.toBeInTheDocument();
});

test("prefers Git repository source type when source url is a git address", async () => {
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      id: "codex:example-plugin",
      packageId: "example-plugin",
      name: "Example Plugin",
      hostTool: "codex",
      sourceType: "local",
      sourceLabel: "example-plugin",
      sourceUrl: "https://git.example.com/example-org/example-repo",
      installSource: "host",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  await screen.findByText("Example Plugin");
  await userEvent.click(screen.getByRole("button", { name: /展开 Example Plugin/ }));

  expect(screen.getByText("来源类型")).toBeInTheDocument();
  expect(screen.getByText("Git 仓库")).toBeInTheDocument();
  expect(screen.getByText("https://git.example.com/example-org/example-repo")).toBeInTheDocument();
});

test("shows SkillDock source metadata for Claude plugin installs", async () => {
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      id: "claude-code:coding-tutor",
      packageId: "coding-tutor",
      name: "Coding Tutor",
      description:
        "Personalized coding tutorials that use your actual codebase for examples with spaced repetition quizzes",
      hostTool: "claude-code",
      relatedHostTools: [],
      rootPath: "/Users/demo/.skilldock/plugins/coding-tutor/plugins/coding-tutor",
      repoRootPath: "/Users/demo/.skilldock/plugins/coding-tutor",
      pluginRelativePath: "plugins/coding-tutor",
      manifestPath:
        "/Users/demo/.skilldock/plugins/coding-tutor/plugins/coding-tutor/.claude-plugin/plugin.json",
      sourceType: "git",
      sourceLabel: "SkillDock",
      sourceUrl: "https://github.com/everyinc/compound-engineering-plugin",
      sourceRef: "",
      sourceRevision: "6f9ab03a031c054a8046659926251",
      currentVersion: "1.0.0",
      currentBranch: "main",
      currentCommit: "6f9ab03a031c054a8046659926251",
      collabStatus: "clean",
      statusText: "SkillDock 安装的插件。",
      isGitRepo: true,
      updateMode: "auto",
      updateAvailable: false,
      installedAt: "",
      updatedAt: "",
      lastScannedAt: "",
      status: "ready",
      installState: "installed",
      installSource: "skilldock",
      enabledState: "enabled",
      scopes: [
        {
          scopeId: "user",
          scopeLabel: "用户级",
          enabledState: "enabled",
          location: "~/.claude/settings.json",
        },
      ],
      components: pluginFixtures[0].components,
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));
  await screen.findByText("Coding Tutor");
  await userEvent.click(screen.getByRole("button", { name: /展开 Coding Tutor/ }));

  expect(screen.getByText("SkillDock 安装")).toBeInTheDocument();
  expect(screen.getByText("Git 仓库")).toBeInTheDocument();
  expect(
    screen.getByText(
      "https://github.com/everyinc/compound-engineering-plugin/tree/main/plugins/coding-tutor",
    ),
  ).toBeInTheDocument();
});

test("keeps long plugin names visible when summary badges are present", async () => {
  const longNamePlugin: PluginSummary = {
    ...pluginFixtures[0],
    id: "everything-claude-code",
    packageId: "everything-claude-code",
    name: "everything-claude-code",
    description: "Battle-tested Claude Code plugin for engineering teams",
    hostTool: "claude-code",
    relatedHostTools: [],
    enabledState: "disabled",
    collabStatus: "clean",
    updateAvailable: false,
    components: [
      ...Array.from({ length: 183 }, (_, index) => ({
        id: `skills/everything-${index + 1}`,
        name: `Everything Skill ${index + 1}`,
        description: `Skill ${index + 1}`,
        assetType: "skill" as const,
        ownerPluginId: "everything-claude-code",
        packageItemId: `skills/everything-${index + 1}`,
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `mcp/everything-${index + 1}`,
        name: `Everything MCP ${index + 1}`,
        description: `MCP ${index + 1}`,
        assetType: "mcp" as const,
        ownerPluginId: "everything-claude-code",
        packageItemId: `mcp/everything-${index + 1}`,
      })),
    ],
  };
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce([longNamePlugin]);

  renderWithI18n(<PluginsRoute />);

  const rowButton = await screen.findByRole("button", {
    name: /展开 everything-claude-code/,
  });

  expect(within(rowButton).getByText("everything-claude-code")).toBeInTheDocument();
  expect(within(rowButton).getByText("Battle-tested Claude Code plugin for engineering teams")).toBeInTheDocument();
  expect(within(rowButton).getByText("未启用")).toBeInTheDocument();
  expect(within(rowButton).getByText("183 skill")).toBeInTheDocument();
  expect(within(rowButton).getByText("6 mcp")).toBeInTheDocument();
});

test("shows plugin update status and updates from the list action", async () => {
  const updateSpy = vi.spyOn(skillClient, "updatePlugin").mockResolvedValue({
    ...pluginFixtures[0],
    collabStatus: "clean",
    updateAvailable: false,
    statusText: "插件目录已是最新。",
  });

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  await screen.findByText("Repo Scout");

  expect(screen.getByText("可更新")).toBeInTheDocument();
  const updateButton = screen.getByRole("button", { name: "更新 Repo Scout 插件" });
  expect(updateButton.querySelector(".skill-card__refresh-icon")).toBeInTheDocument();

  await userEvent.click(updateButton);

  await waitFor(() => {
    expect(updateSpy).toHaveBeenCalledWith({
      pluginId: "repo-scout",
      hostTool: "codex",
      rootPath: "/Users/demo/workspace/repo-scout",
    });
  });
  await waitFor(() => {
    expect(screen.queryByText("可更新")).not.toBeInTheDocument();
  });

  updateSpy.mockRestore();
});

test("shows the same spinning update icon state as skills while a plugin update is pending", async () => {
  const deferredUpdate: { resolve?: (plugin: PluginSummary) => void } = {};
  const updateSpy = vi.spyOn(skillClient, "updatePlugin").mockImplementation(
    () =>
      new Promise<PluginSummary>((resolve) => {
        deferredUpdate.resolve = resolve;
      }),
  );

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  await screen.findByText("Repo Scout");

  const updateButton = screen.getByRole("button", { name: "更新 Repo Scout 插件" });
  await userEvent.click(updateButton);

  await waitFor(() => {
    expect(updateButton).toBeDisabled();
    expect(updateButton.querySelector(".skill-card__refresh-icon.is-spinning")).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  if (!deferredUpdate.resolve) {
    updateSpy.mockRestore();
    throw new Error("missing plugin update resolver");
  }
  deferredUpdate.resolve({
    ...pluginFixtures[0],
    collabStatus: "clean",
    updateAvailable: false,
    statusText: "插件目录已是最新。",
  });

  await waitFor(() => {
    expect(screen.queryByText("可更新")).not.toBeInTheDocument();
  });

  updateSpy.mockRestore();
});

test("shows a spinning update icon for merged all-tab plugins while update is pending", async () => {
  const deferredUpdate: { resolve?: (plugin: PluginSummary) => void } = {};
  const updateSpy = vi.spyOn(skillClient, "updatePlugin").mockImplementation(
    () =>
      new Promise<PluginSummary>((resolve) => {
        deferredUpdate.resolve = resolve;
      }),
  );
  const refreshSpy = vi.spyOn(skillClient, "refreshLocalPluginState").mockImplementation(
    async ({ hostTool, rootPath }) => ({
      ...pluginFixtures[0],
      id: `${hostTool}:repo-scout`,
      hostTool,
      rootPath,
      repoRootPath: "/Users/demo/.skilldock/plugins/repo-scout",
      collabStatus: "clean",
      updateAvailable: false,
      statusText: "插件目录已是最新。",
    }),
  );
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce([
    {
      ...pluginFixtures[0],
      id: "codex:repo-scout",
      hostTool: "codex",
      rootPath: "/Users/demo/.skilldock/plugins/repo-scout/plugins/repo-scout",
      repoRootPath: "/Users/demo/.skilldock/plugins/repo-scout",
      manifestPath: "/Users/demo/.skilldock/plugins/repo-scout/plugins/repo-scout/.codex-plugin/plugin.json",
      relatedHostTools: ["claude-code"],
    },
    {
      ...pluginFixtures[0],
      id: "claude-code:repo-scout",
      hostTool: "claude-code",
      rootPath: "/Users/demo/.skilldock/plugins/repo-scout/plugins/repo-scout",
      repoRootPath: "/Users/demo/.skilldock/plugins/repo-scout",
      manifestPath: "/Users/demo/.skilldock/plugins/repo-scout/plugins/repo-scout/.claude-plugin/plugin.json",
      relatedHostTools: ["codex"],
      enabledState: "disabled",
    },
  ]);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: "全部 1" });

  const updateButton = screen.getByRole("button", { name: "更新 Repo Scout 插件" });
  await userEvent.click(updateButton);

  await waitFor(() => {
    expect(updateButton).toBeDisabled();
    expect(updateButton.querySelector(".skill-card__refresh-icon.is-spinning")).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  if (!deferredUpdate.resolve) {
    updateSpy.mockRestore();
    refreshSpy.mockRestore();
    throw new Error("missing plugin update resolver");
  }
  deferredUpdate.resolve({
    ...pluginFixtures[0],
    id: "codex:repo-scout",
    hostTool: "codex",
    rootPath: "/Users/demo/.skilldock/plugins/repo-scout/plugins/repo-scout",
    repoRootPath: "/Users/demo/.skilldock/plugins/repo-scout",
    collabStatus: "clean",
    updateAvailable: false,
    statusText: "插件目录已是最新。",
  });

  await waitFor(() => {
    expect(refreshSpy).toHaveBeenCalledTimes(2);
  });
  await waitFor(() => {
    expect(screen.queryByText("可更新")).not.toBeInTheDocument();
  });

  updateSpy.mockRestore();
  refreshSpy.mockRestore();
});

test("keeps the toggle button available and not spinning while plugin update is pending", async () => {
  const deferredUpdate: { resolve?: (plugin: PluginSummary) => void } = {};
  const updateSpy = vi.spyOn(skillClient, "updatePlugin").mockImplementation(
    () =>
      new Promise<PluginSummary>((resolve) => {
        deferredUpdate.resolve = resolve;
      }),
  );

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  await screen.findByText("Repo Scout");

  await userEvent.click(screen.getByRole("button", { name: "更新 Repo Scout 插件" }));

  const toggleButton = screen.getByRole("button", { name: "关闭 Repo Scout 插件" });
  await waitFor(() => {
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(toggleButton).toBeEnabled();
    expect(toggleButton.querySelector(".plugins-page__power-icon.is-spinning")).not.toBeInTheDocument();
  });

  if (!deferredUpdate.resolve) {
    updateSpy.mockRestore();
    throw new Error("missing plugin update resolver");
  }
  await act(async () => {
    deferredUpdate.resolve?.({
      ...pluginFixtures[0],
      collabStatus: "clean",
      updateAvailable: false,
      statusText: "插件目录已是最新。",
    });
  });
  await waitFor(() => {
    expect(screen.queryByText("可更新")).not.toBeInTheDocument();
  });

  updateSpy.mockRestore();
});

test("deduplicates shared plugin package updates in the all tab", async () => {
  const updateSpy = vi.spyOn(skillClient, "updatePlugin").mockResolvedValue({
    ...pluginFixtures[0],
    id: "codex:repo-scout",
    hostTool: "codex",
    rootPath: "/Users/demo/.skilldock/plugins/repo-scout/plugins/repo-scout",
    repoRootPath: "/Users/demo/.skilldock/plugins/repo-scout",
    collabStatus: "clean",
    updateAvailable: false,
    statusText: "插件目录已是最新。",
  });
  const refreshSpy = vi.spyOn(skillClient, "refreshLocalPluginState").mockImplementation(
    async ({ hostTool, rootPath }) => ({
      ...pluginFixtures[0],
      id: `${hostTool}:repo-scout`,
      hostTool,
      rootPath,
      repoRootPath: "/Users/demo/.skilldock/plugins/repo-scout",
      collabStatus: "clean",
      updateAvailable: false,
      statusText: "插件目录已是最新。",
    }),
  );
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce([
    {
      ...pluginFixtures[0],
      id: "codex:repo-scout",
      hostTool: "codex",
      rootPath: "/Users/demo/.skilldock/plugins/repo-scout/plugins/repo-scout",
      repoRootPath: "/Users/demo/.skilldock/plugins/repo-scout",
      manifestPath: "/Users/demo/.skilldock/plugins/repo-scout/plugins/repo-scout/.codex-plugin/plugin.json",
      relatedHostTools: ["claude-code"],
    },
    {
      ...pluginFixtures[0],
      id: "claude-code:repo-scout",
      hostTool: "claude-code",
      rootPath: "/Users/demo/.skilldock/plugins/repo-scout/plugins/repo-scout",
      repoRootPath: "/Users/demo/.skilldock/plugins/repo-scout",
      manifestPath: "/Users/demo/.skilldock/plugins/repo-scout/plugins/repo-scout/.claude-plugin/plugin.json",
      relatedHostTools: ["codex"],
      enabledState: "disabled",
    },
  ]);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: "全部 1" });
  await userEvent.click(screen.getByRole("button", { name: "更新 Repo Scout 插件" }));

  await waitFor(() => {
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });
  expect(refreshSpy).toHaveBeenCalledTimes(2);

  updateSpy.mockRestore();
  refreshSpy.mockRestore();
});

test("shows the backend update error message instead of a generic toast-only message", async () => {
  const updateSpy = vi.spyOn(skillClient, "updatePlugin").mockRejectedValue(
    new Error("插件目录存在本地未提交改动，请先推送或清理后再更新。"),
  );

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  await userEvent.click(screen.getByRole("button", { name: "更新 Repo Scout 插件" }));

  await waitFor(() => {
    expect(screen.getByRole("status")).toHaveTextContent(
      "插件目录存在本地未提交改动，请先推送或清理后再更新。",
    );
  });

  updateSpy.mockRestore();
});

test("prompts before updating a hash-based plugin with local modifications", async () => {
  const updateSpy = vi.spyOn(skillClient, "updatePlugin").mockResolvedValue({
    ...pluginFixtures[0],
    updateStrategy: "hash",
    localModified: false,
    collabStatus: "clean",
    updateAvailable: false,
    statusText: "插件目录已是最新。",
  });
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce([
    {
      ...pluginFixtures[0],
      updateStrategy: "hash",
      localModified: true,
      collabStatus: "update-available",
      updateAvailable: true,
    },
  ]);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  await screen.findByText("Repo Scout");
  await userEvent.click(screen.getByRole("button", { name: "更新 Repo Scout 插件" }));

  const confirmDialog = screen.getByRole("dialog");
  expect(confirmDialog).toHaveClass("plugins-page__confirm-dialog");
  expect(screen.getByText("更新将覆盖本地修改")).toBeInTheDocument();
  expect(updateSpy).not.toHaveBeenCalled();

  expect(screen.getByRole("button", { name: "取消" })).toHaveClass("secondary-button--compact");
  expect(screen.getByRole("button", { name: "继续更新" })).toHaveClass(
    "secondary-button--compact",
    "danger-button",
  );

  await userEvent.click(screen.getByRole("button", { name: "继续更新" }));

  await waitFor(() => {
    expect(updateSpy).toHaveBeenCalledWith({
      pluginId: "repo-scout",
      hostTool: "codex",
      rootPath: "/Users/demo/workspace/repo-scout",
    });
  });

  updateSpy.mockRestore();
});

test("places pending commit and update statuses at the top of plugin cards", async () => {
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      name: "Pending Plugin",
      manifestName: "pending-plugin",
      id: "pending-plugin",
      rootPath: "/Users/demo/workspace/pending-plugin",
      collabStatus: "pending-commit",
      updateAvailable: false,
      statusText: "插件目录存在本地未提交改动。",
    },
    {
      ...pluginFixtures[0],
      name: "Update Plugin",
      manifestName: "update-plugin",
      id: "update-plugin",
      rootPath: "/Users/demo/workspace/update-plugin",
      collabStatus: "update-available",
      updateAvailable: true,
      statusText: "远端存在插件目录更新。",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);
  window.localStorage.setItem("plugins:view-mode", "grid");

  renderWithI18n(<PluginsRoute />);

  const pendingCard = (await screen.findByRole("button", { name: "展开 pending-plugin" }))
    .closest(".tool-list-row");
  const updateCard = screen.getByRole("button", { name: "展开 update-plugin" })
    .closest(".tool-list-row");

  const pendingStatus = pendingCard?.querySelector(".plugins-page__action-status .status-badge");
  expect(pendingStatus).toHaveTextContent("待提交");
  expect(pendingStatus).toHaveClass("tone-pending-commit");
  expect(updateCard?.querySelector(".plugins-page__action-status")).toHaveTextContent("可更新");
  expect(within(updateCard as HTMLElement).getByRole("button", { name: "更新 update-plugin 插件" }))
    .toBeInTheDocument();
});

test("refreshes plugin states after plugin library changes", async () => {
  vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  const refreshedPlugin: PluginSummary = {
    ...pluginFixtures[0],
    rootPath: "/Users/demo/.skilldock/plugins/repo-scout/plugins/repo-scout",
    repoRootPath: "/Users/demo/.skilldock/plugins/repo-scout",
    installSource: "skilldock",
    collabStatus: "pending-push",
    updateAvailable: false,
    statusText: "插件目录存在本地未提交改动。",
  };
  const refreshSpy = vi.spyOn(skillClient, "refreshLocalPluginState").mockResolvedValueOnce(refreshedPlugin);
  const pluginLibraryChange: { handler?: (payload: { changedPaths: string[] }) => void } = {};
  vi.spyOn(skillClient, "subscribePluginLibraryChanges").mockImplementation(async (handler) => {
    pluginLibraryChange.handler = handler;
    return () => undefined;
  });
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce([refreshedPlugin]);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  if (!pluginLibraryChange.handler) {
    throw new Error("plugin library change handler was not registered");
  }
  pluginLibraryChange.handler({ changedPaths: ["/Users/demo/.skilldock/plugins/repo-scout/plugins/repo-scout/SKILL.md"] });

  await waitFor(() => {
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => {
    expect(screen.getByText("待推送")).toBeInTheDocument();
  });
  await waitFor(() => {
    const cachedPlugins = JSON.parse(
      window.localStorage.getItem("skilldock.pluginsCache") ?? "[]",
    ) as PluginSummary[];
    expect(cachedPlugins[0]?.collabStatus).toBe("pending-push");
  });
});

test("shows diverged status without an update action", async () => {
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      collabStatus: "diverged",
      updateAvailable: false,
      statusText: "本地与远端均有变化，建议先处理本地改动，再同步插件目录。",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);
  vi.spyOn(skillClient, "refreshPluginStates").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Codex/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  const repoScoutRow = await screen.findByRole("button", { name: /展开 Repo Scout/ });

  expect(repoScoutRow.closest(".tool-list-row")).toHaveTextContent("需处理");
  expect(screen.queryByRole("button", { name: "更新 Repo Scout 插件" })).not.toBeInTheDocument();
});

test("hides the git badge when plugin source is not a git address", async () => {
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      hostTool: "cursor",
      name: "local-plugin",
      sourceType: "local",
      sourceLabel: "local-plugin",
      sourceUrl: "",
      rootPath: "/Users/demo/.cursor/plugins/local/local-plugin",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Cursor/ }));
  await screen.findByText("local-plugin");
  await userEvent.click(screen.getByRole("button", { name: /展开 local-plugin/ }));

  expect(screen.getByText("local-plugin")).toBeInTheDocument();
  expect(screen.queryByText("git")).not.toBeInTheDocument();
});

test("renders component summaries as separate badges and keeps the plugin description as subtitle", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await screen.findByText("Repo Scout");
  const repoScoutRow = screen.getByRole("button", { name: /展开 Repo Scout/ });
  const subtitle = repoScoutRow.querySelector(".tool-list-row__subtitle");
  const toolListRow = repoScoutRow.closest(".tool-list-row");
  const pluginIcon = toolListRow?.querySelector(".plugins-page__plugin-icon");
  const badgeTexts = Array.from(
    repoScoutRow.querySelectorAll(".status-badge"),
  ).map((node) => node.textContent?.trim()).filter(Boolean);
  const hostCoverageItems = toolListRow?.querySelectorAll(".plugins-page__host-coverage-item");

  expect(pluginIcon).toBeInTheDocument();
  expect(pluginIcon).toHaveTextContent("R");
  expect(subtitle).toHaveTextContent("扫描仓库中的插件组件，并帮助追踪插件资产来源。");
  expect(badgeTexts).toEqual([
    "已启用",
    "7 skill",
    "3 mcp",
    "7 agents",
    "1 command",
    "1 rule",
    "1 hook",
  ]);
  expect(hostCoverageItems).toHaveLength(1);
});

test("shows host icons in the trailing host badge and collapses the rest into +N", async () => {
  const hostTools: PluginHostTool[] = [
    "codex",
    "claude-code",
    "cursor",
    "windsurf" as PluginHostTool,
    "gemini-cli" as PluginHostTool,
    "cline" as PluginHostTool,
    "roo-code" as PluginHostTool,
    "augment" as PluginHostTool,
  ];
  const multiHostPlugins: PluginSummary[] = hostTools.map((hostTool, index) => ({
    ...pluginFixtures[0],
    id: `${hostTool}:multi-host-plugin`,
    packageId: "multi-host-plugin",
    name: "Multi Host Plugin",
    hostTool,
    sourceLabel: "multi-host-plugin",
    sourceUrl: "https://github.com/example/multi-host-plugin",
    repoRootPath: `/Users/demo/plugins/cache/multi-host-plugin/${hostTool}`,
    relatedHostTools: hostTools.filter((candidate) => candidate !== hostTool),
    rootPath: `/Users/demo/workspace/${hostTool}/multi-host-plugin`,
    manifestPath: `/Users/demo/workspace/${hostTool}/multi-host-plugin/plugin.json`,
  }));
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(multiHostPlugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  const rowButton = await screen.findByRole("button", {
    name: /展开 Multi Host Plugin/,
  });
  const statusBadges = rowButton.querySelectorAll(".status-badge");
  const hostCoverageBadge = statusBadges[statusBadges.length - 1];

  expect(hostCoverageBadge?.querySelectorAll(".plugins-page__host-coverage-item")).toHaveLength(5);
  expect(within(hostCoverageBadge as HTMLElement).getByText("+3")).toBeInTheDocument();
});

test("aggregates launchdarkly aliases into one shared plugin card", async () => {
  const launchDarklyPlugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      id: "codex:launchdarkly-mcp",
      packageId: "launchdarkly-ai-tooling",
      manifestName: "launchdarkly-mcp",
      name: "launchdarkly-mcp",
      sourceLabel: "launchdarkly-ai-tooling",
      sourceUrl: "https://github.com/launchdarkly/ai-tooling",
      hostTool: "codex",
      relatedHostTools: ["claude-code"],
      rootPath: "/Users/demo/.codex/plugins/launchdarkly-ai-tooling/plugins/launchdarkly-mcp",
      repoRootPath: "/Users/demo/.codex/plugins/launchdarkly-ai-tooling",
      pluginRelativePath: "plugins/launchdarkly-mcp",
      manifestPath: "/Users/demo/.codex/plugins/launchdarkly-ai-tooling/plugins/launchdarkly-mcp/.codex-plugin/plugin.json",
    },
    {
      ...pluginFixtures[0],
      id: "claude-code:launchdarkly",
      packageId: "launchdarkly-ai-tooling",
      manifestName: "launchdarkly",
      name: "launchdarkly",
      sourceLabel: "launchdarkly-ai-tooling",
      sourceUrl: "https://github.com/launchdarkly/ai-tooling",
      hostTool: "claude-code",
      relatedHostTools: ["codex"],
      rootPath: "/Users/demo/.claude/plugins/launchdarkly-ai-tooling/plugins/launchdarkly",
      repoRootPath: "/Users/demo/.claude/plugins/launchdarkly-ai-tooling",
      pluginRelativePath: "plugins/launchdarkly",
      manifestPath: "/Users/demo/.claude/plugins/launchdarkly-ai-tooling/.claude-plugin/plugin.json",
    },
  ];

  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(launchDarklyPlugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });

  const launchdarklyButtons = screen.getAllByRole("button", {
    name: /展开 launchdarkly/i,
  });
  expect(launchdarklyButtons).toHaveLength(1);
  expect(screen.queryByRole("button", { name: /展开 launchdarkly-mcp/i })).not.toBeInTheDocument();
});

test("keeps the plugin chevron in the header's rightmost column", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  await screen.findByText("Repo Scout");

  const rowButton = screen.getByRole("button", { name: /展开 Repo Scout/ });
  const header = rowButton.closest(".tool-list-row")?.querySelector(".tool-list-row__header");
  const chevron = header?.querySelector(".tool-list-row__chevron");

  expect(header).toBeInTheDocument();
  expect(chevron).toBeInTheDocument();
  expect(header?.lastElementChild).toBe(chevron);
});

test("filters plugin list by enabled state", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));
  expect(await screen.findByText("ecc")).toBeInTheDocument();

  const filterSelect = screen.getByRole("combobox", { name: "筛选插件状态" });
  await userEvent.click(filterSelect);
  expect(screen.queryByRole("option", { name: /异常/ })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("option", { name: /未启用/ }));

  expect(screen.queryByText("Repo Scout")).not.toBeInTheDocument();
  expect(screen.getByText("ecc")).toBeInTheDocument();
});

test("shows refresh loading animation in the plugin toolbar", async () => {
  const deferredFetch: {
    resolve?: (value: PluginSummary[]) => void;
  } = {};
  const fetchSpy = vi
    .spyOn(skillClient, "fetchInstalledPlugins")
    .mockImplementationOnce(
      () =>
        new Promise<PluginSummary[]>((resolve) => {
          deferredFetch.resolve = resolve;
        }),
    );

  renderWithI18n(<PluginsRoute />);

  try {
    await screen.findByRole("tab", { name: /全部/ });
    const refreshButton = screen.getByRole("button", { name: "扫描导入" });

    await userEvent.click(refreshButton);

    const loadingButton = await screen.findByRole("button", { name: "扫描中..." });
    expect(loadingButton).toBeDisabled();
    expect(
      loadingButton.querySelector(".skills-toolbar-button__svg.is-spinning"),
    ).toBeInTheDocument();

    if (!deferredFetch.resolve) {
      throw new Error("missing plugin fetch resolver");
    }
    deferredFetch.resolve(pluginFixtures);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "扫描导入" }),
      ).toBeEnabled();
    });
  } finally {
    fetchSpy.mockRestore();
  }
});

test("keeps plugin scan import animation after remounting the route", async () => {
  const deferredFetch: {
    resolve?: (value: PluginSummary[]) => void;
  } = {};
  const fetchSpy = vi
    .spyOn(skillClient, "fetchInstalledPlugins")
    .mockImplementationOnce(
      () =>
        new Promise<PluginSummary[]>((resolve) => {
          deferredFetch.resolve = resolve;
        }),
    );

  const { unmount } = renderWithI18n(<PluginsRoute />);

  try {
    await screen.findByRole("tab", { name: /全部/ });
    await userEvent.click(screen.getByRole("button", { name: "扫描导入" }));

    expect(await screen.findByRole("button", { name: "扫描中..." })).toBeDisabled();

    unmount();
    renderWithI18n(<PluginsRoute />);

    const loadingButton = await screen.findByRole("button", { name: "扫描中..." });
    expect(loadingButton).toBeDisabled();
    expect(
      loadingButton.querySelector(".skills-toolbar-button__svg.is-spinning"),
    ).toBeInTheDocument();

    if (!deferredFetch.resolve) {
      throw new Error("missing plugin fetch resolver");
    }
    deferredFetch.resolve(pluginFixtures);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "扫描导入" })).toBeEnabled();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("toggles plugin enabled state from the plugin list", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));
  expect(await screen.findByText("ecc")).toBeInTheDocument();
  expect(screen.getAllByText("未启用").length).toBeGreaterThan(0);

  const toggleButton = screen.getByRole("button", { name: "开启 ecc 插件" });
  expect(toggleButton).toHaveClass("skill-card__icon-button");

  await userEvent.click(toggleButton);

  expect(await screen.findByRole("button", { name: "关闭 ecc 插件" })).toBeInTheDocument();
  expect(screen.getAllByText("已启用").length).toBeGreaterThan(0);
});

test("keeps the current plugin order after toggling its enabled state", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  expect(await screen.findByText("ecc")).toBeInTheDocument();

  const getPluginOrder = () => screen.getAllByRole("button", { name: /^展开 / })
    .map((button) => button.getAttribute("aria-label"));
  expect(getPluginOrder()).toEqual(["展开 Repo Scout", "展开 ecc"]);

  await userEvent.click(screen.getByRole("button", { name: "开启 ecc 插件" }));

  expect(await screen.findByRole("button", { name: "关闭 ecc 插件" })).toBeInTheDocument();
  expect(getPluginOrder()).toEqual(["展开 Repo Scout", "展开 ecc"]);
});

test("toggles Cursor plugin enabled state from the plugin list", async () => {
  const cursorPlugin = buildCursorPlugin(
    "Example Plugin",
    "/Users/demo/.cursor/plugins/local/example-plugin",
  );
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce([cursorPlugin]);
  const setPluginEnabledSpy = vi.spyOn(skillClient, "setPluginEnabled").mockResolvedValue({
    ...cursorPlugin,
    rootPath: "/Users/demo/.skilldock/disabled-plugins/cursor/example-plugin",
    enabledState: "disabled",
    scopes: cursorPlugin.scopes.map((scope) => ({ ...scope, enabledState: "disabled" })),
  });

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Cursor/ }));
  await userEvent.click(screen.getByRole("button", { name: "关闭 Example Plugin 插件" }));

  expect(setPluginEnabledSpy).toHaveBeenCalledWith({
    pluginId: cursorPlugin.id,
    hostTool: "cursor",
    rootPath: cursorPlugin.rootPath,
    enabled: false,
  });
  expect(await screen.findByRole("button", { name: "开启 Example Plugin 插件" })).toBeInTheDocument();
});

test("toggles OpenCode plugin enabled state from its host tab", async () => {
  const opencodePlugin: PluginSummary = {
    ...pluginFixtures[0],
    id: "opencode:demo-opencode",
    packageId: "demo-opencode",
    manifestName: "demo-opencode",
    name: "Demo OpenCode",
    hostTool: "opencode",
    relatedHostTools: [],
    rootPath: "/Users/demo/.skilldock/plugins/demo-opencode",
    displayRootPath: "/Users/demo/.config/opencode/plugins",
    repoRootPath: "/Users/demo/.skilldock/plugins/demo-opencode",
    manifestPath: "/Users/demo/.skilldock/plugins/demo-opencode/.opencode/plugins/demo.ts",
    enabledState: "enabled",
    scopes: [{
      scopeId: "user",
      scopeLabel: "用户级",
      enabledState: "enabled",
      location: "/Users/demo/.config/opencode/plugins",
    }],
  };
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce([opencodePlugin]);
  const setPluginEnabledSpy = vi.spyOn(skillClient, "setPluginEnabled").mockResolvedValue({
    ...opencodePlugin,
    enabledState: "disabled",
    scopes: opencodePlugin.scopes.map((scope) => ({ ...scope, enabledState: "disabled" })),
  });

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /OpenCode/ }));
  await userEvent.click(screen.getByRole("button", { name: "关闭 demo-opencode 插件" }));

  expect(setPluginEnabledSpy).toHaveBeenCalledWith({
    pluginId: opencodePlugin.id,
    hostTool: "opencode",
    rootPath: opencodePlugin.rootPath,
    enabled: false,
  });
  expect(await screen.findByRole("button", { name: "开启 demo-opencode 插件" })).toBeInTheDocument();
});

test("keeps unknown plugins disabled from toggle actions", async () => {
  const setPluginEnabledSpy = vi.spyOn(skillClient, "setPluginEnabled");
  const unknownPlugin: PluginSummary = {
    ...pluginFixtures[1],
    enabledState: "unknown",
    scopes: [
      {
        ...pluginFixtures[1].scopes[0],
        enabledState: "unknown",
      },
    ],
  };
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce([unknownPlugin]);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));

  const toggleButton = screen.getByRole("button", {
    name: /暂不支持在 SkillDock 内切换/,
  });
  expect(toggleButton).toBeDisabled();
  expect(toggleButton).toHaveClass("is-unknown");

  await userEvent.click(toggleButton);

  expect(setPluginEnabledSpy).not.toHaveBeenCalled();
  setPluginEnabledSpy.mockRestore();
});

test("toggles every installed host from the all-tab plugin row", async () => {
  const setPluginEnabledSpy = vi.spyOn(skillClient, "setPluginEnabled")
    .mockImplementation(async (input) => ({
      ...plugins.find((candidate) => candidate.hostTool === input.hostTool)!,
      enabledState: input.enabled ? "enabled" : "disabled",
      scopes: plugins.find((candidate) => candidate.hostTool === input.hostTool)!.scopes.map((scope) => ({
        ...scope,
        enabledState: input.enabled ? "enabled" : "disabled",
      })),
    }));
  const plugins: PluginSummary[] = [
    pluginFixtures[0],
    {
      ...pluginFixtures[0],
      id: "claude-code:repo-scout",
      hostTool: "claude-code",
      relatedHostTools: ["codex"],
      rootPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0",
      manifestPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0/.claude-plugin/plugin.json",
      installSource: "host",
      enabledState: "disabled",
      scopes: [
        {
          scopeId: "user",
          scopeLabel: "用户级",
          enabledState: "disabled",
          location: "~/.claude/settings.json",
        },
      ],
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: "全部 1" });
  await userEvent.click(screen.getByRole("button", { name: "关闭 Repo Scout 插件" }));

  await waitFor(() => {
    expect(setPluginEnabledSpy).toHaveBeenCalledTimes(2);
  });
  expect(setPluginEnabledSpy).toHaveBeenNthCalledWith(1, {
    pluginId: pluginFixtures[0].id,
    hostTool: "codex",
    rootPath: pluginFixtures[0].rootPath,
    enabled: false,
  });
  expect(setPluginEnabledSpy).toHaveBeenNthCalledWith(2, {
    pluginId: "claude-code:repo-scout",
    hostTool: "claude-code",
    rootPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0",
    enabled: false,
  });

  setPluginEnabledSpy.mockRestore();
});

test("opens a plugin folder from the plugin list", async () => {
  const openPluginSpy = vi.spyOn(skillClient, "openPluginInEditor").mockResolvedValue(undefined);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));
  expect(await screen.findByText("ecc")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "打开 ecc 目录" }));

  expect(openPluginSpy).toHaveBeenCalledWith({
    rootPath: "/Users/demo/.claude/plugins/cache/ecc/ecc/1.10.0",
    editorId: "finder",
  });
  expect(screen.getByRole("button", { name: "打开 ecc 目录" })).toHaveAttribute(
    "data-tooltip",
    "用默认工具打开 plugin 目录",
  );

  openPluginSpy.mockRestore();
});

test("opens the cursor plugin directory from the all tab when only cursor is installed", async () => {
  const openPluginSpy = vi.spyOn(skillClient, "openPluginInEditor").mockResolvedValue(undefined);
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      id: "cursor:coding-tutor",
      packageId: "coding-tutor",
      name: "Coding Tutor",
      hostTool: "cursor",
      rootPath: "/Users/demo/.skilldock/plugins/coding-tutor/plugins/coding-tutor",
      displayRootPath: "/Users/demo/.cursor/plugins/local/coding-tutor",
      repoRootPath: "/Users/demo/.skilldock/plugins/coding-tutor",
      pluginRelativePath: "plugins/coding-tutor",
      sourceType: "git",
      sourceUrl: "https://github.com/everyinc/compound-engineering-plugin",
      installSource: "skilldock",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  expect(await screen.findByText("Coding Tutor")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "打开 Coding Tutor 目录" }));

  expect(openPluginSpy).toHaveBeenCalledWith({
    rootPath: "/Users/demo/.cursor/plugins/local/coding-tutor",
    editorId: "finder",
  });

  openPluginSpy.mockRestore();
});

test("opens the skilldock repository root from the all tab when multiple hosts are installed", async () => {
  const openPluginSpy = vi.spyOn(skillClient, "openPluginInEditor").mockResolvedValue(undefined);
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      id: "cursor:coding-tutor",
      packageId: "coding-tutor",
      manifestName: "coding-tutor",
      name: "Coding Tutor",
      hostTool: "cursor",
      rootPath: "/Users/demo/.cursor/plugins/local/coding-tutor",
      displayRootPath: "/Users/demo/.cursor/plugins/local/coding-tutor",
      repoRootPath: "/Users/demo/.skilldock/plugins/coding-tutor",
      pluginRelativePath: "",
      sourceType: "git",
      sourceUrl: "https://github.com/everyinc/compound-engineering-plugin",
      installSource: "skilldock",
      relatedHostTools: ["claude-code"],
    },
    {
      ...pluginFixtures[0],
      id: "claude-code:coding-tutor",
      packageId: "coding-tutor",
      manifestName: "coding-tutor",
      name: "Coding Tutor",
      hostTool: "claude-code",
      rootPath: "/Users/demo/.claude/plugins/coding-tutor",
      displayRootPath: "/Users/demo/.claude/plugins/coding-tutor",
      repoRootPath: "/Users/demo/.skilldock/plugins/coding-tutor",
      pluginRelativePath: "",
      sourceType: "git",
      sourceUrl: "https://github.com/everyinc/compound-engineering-plugin",
      installSource: "skilldock",
      relatedHostTools: ["cursor"],
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("button", { name: /打开 .* 目录/ }));

  expect(openPluginSpy).toHaveBeenCalledWith({
    rootPath: "/Users/demo/.skilldock/plugins/coding-tutor",
    editorId: "finder",
  });

  openPluginSpy.mockRestore();
});

test("opens the cursor plugin copy from the cursor tab with the default tool", async () => {
  const openPluginSpy = vi.spyOn(skillClient, "openPluginInEditor").mockResolvedValue(undefined);
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      id: "cursor:coding-tutor",
      packageId: "coding-tutor",
      name: "Coding Tutor",
      hostTool: "cursor",
      rootPath: "/Users/demo/.skilldock/plugins/coding-tutor/plugins/coding-tutor",
      displayRootPath: "/Users/demo/.cursor/plugins/local/coding-tutor",
      repoRootPath: "/Users/demo/.skilldock/plugins/coding-tutor",
      pluginRelativePath: "plugins/coding-tutor",
      sourceType: "git",
      sourceUrl: "https://github.com/everyinc/compound-engineering-plugin",
      installSource: "skilldock",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Cursor/ }));
  expect(await screen.findByText("Coding Tutor")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "打开 Coding Tutor 目录" }));

  expect(openPluginSpy).toHaveBeenCalledWith({
    rootPath: "/Users/demo/.cursor/plugins/local/coding-tutor",
    editorId: "finder",
  });

  openPluginSpy.mockRestore();
});

test("opens a plugin folder from the detail directory row", async () => {
  const openFinderSpy = vi.spyOn(skillClient, "openPathInFinder").mockResolvedValue(undefined);
  const openPluginSpy = vi.spyOn(skillClient, "openPluginInEditor").mockResolvedValue(undefined);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));
  expect(await screen.findByText("ecc")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /展开 ecc/ }));
  const detailOpenButton = screen.getByRole("button", { name: "打开 ecc 插件文件夹" });
  await userEvent.click(detailOpenButton);

  expect(openFinderSpy).toHaveBeenCalledWith({
    path: "/Users/demo/.claude/plugins/cache/ecc/ecc/1.10.0",
  });
  expect(openPluginSpy).not.toHaveBeenCalled();
  expect(detailOpenButton).toHaveAttribute("data-tooltip", "打开插件文件夹");

  openFinderSpy.mockRestore();
  openPluginSpy.mockRestore();
});

test("shows and opens the Codex SkillDock cache directory", async () => {
  const openFinderSpy = vi.spyOn(skillClient, "openPathInFinder").mockResolvedValue(undefined);
  const openPluginSpy = vi.spyOn(skillClient, "openPluginInEditor").mockResolvedValue(undefined);
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[0],
      id: "codex:skilldock-plugin",
      packageId: "skilldock-plugin",
      name: "SkillDock Plugin",
      hostTool: "codex",
      rootPath: "/Users/demo/.codex/plugins/cache/skilldock/skilldock-plugin/latest",
      displayRootPath: "/Users/demo/.codex/plugins/cache/skilldock/skilldock-plugin",
      repoRootPath: "/Users/demo/.skilldock/plugins/skilldock-plugin",
      manifestPath: "/Users/demo/.codex/plugins/cache/skilldock/skilldock-plugin/latest/.codex-plugin/plugin.json",
      sourceType: "git",
      sourceUrl: "https://github.com/example/skilldock-plugin",
      installSource: "skilldock",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  expect(await screen.findByText("SkillDock Plugin")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "打开 SkillDock Plugin 目录" }));
  expect(openPluginSpy).toHaveBeenCalledWith({
    rootPath: "/Users/demo/.codex/plugins/cache/skilldock/skilldock-plugin",
    editorId: "finder",
  });

  await userEvent.click(screen.getByRole("button", { name: /展开 SkillDock Plugin/ }));

  expect(
    screen.getByText("/Users/demo/.codex/plugins/cache/skilldock/skilldock-plugin"),
  ).toBeInTheDocument();
  expect(screen.queryByText("/Users/demo/.skilldock/plugins/skilldock-plugin")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "打开 SkillDock Plugin 插件文件夹" }));

  expect(openFinderSpy).toHaveBeenCalledWith({
    path: "/Users/demo/.codex/plugins/cache/skilldock/skilldock-plugin",
  });

  openFinderSpy.mockRestore();
  openPluginSpy.mockRestore();
});

test("deletes a plugin only after confirmation", async () => {
  const deleteSpy = vi.spyOn(skillClient, "deletePlugin");

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Claude Code/ });
  expect(await screen.findByText("ecc")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "删除 ecc 插件" }));

  expect(deleteSpy).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "确认删除 ecc 插件" })).toHaveTextContent("确认");

  await userEvent.click(screen.getByRole("button", { name: "确认删除 ecc 插件" }));

  await waitFor(() => {
    expect(deleteSpy).toHaveBeenCalledWith({
      pluginId: "ecc",
      hostTool: "claude-code",
      rootPath: "/Users/demo/.claude/plugins/cache/ecc/ecc/1.10.0",
    });
  });
  expect(screen.queryByText("ecc")).not.toBeInTheDocument();

  deleteSpy.mockRestore();
});

test("keeps the delete confirmation button label stable while deleting", async () => {
  const deferredDelete: {
    resolve?: () => void;
  } = {};
  const deleteSpy = vi
    .spyOn(skillClient, "deletePlugin")
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          deferredDelete.resolve = resolve;
        }),
    );

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Claude Code/ });
  expect(await screen.findByText("ecc")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "删除 ecc 插件" }));
  await userEvent.click(screen.getByRole("button", { name: "确认删除 ecc 插件" }));

  const confirmButton = screen.getByRole("button", { name: "确认删除 ecc 插件" });
  expect(confirmButton).toHaveTextContent("确认");
  expect(confirmButton).not.toHaveTextContent("删除中");

  deferredDelete.resolve?.();
  await waitFor(() => {
    expect(screen.queryByText("ecc")).not.toBeInTheDocument();
  });

  deleteSpy.mockRestore();
});

test("deletes every installed host from the all-tab plugin row", async () => {
  const deleteSpy = vi.spyOn(skillClient, "deletePlugin").mockResolvedValue(undefined);
  const plugins: PluginSummary[] = [
    pluginFixtures[0],
    {
      ...pluginFixtures[0],
      id: "claude-code:repo-scout",
      hostTool: "claude-code",
      relatedHostTools: ["codex"],
      rootPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0",
      manifestPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0/.claude-plugin/plugin.json",
      installSource: "host",
      enabledState: "disabled",
      scopes: [
        {
          scopeId: "user",
          scopeLabel: "用户级",
          enabledState: "disabled",
          location: "~/.claude/settings.json",
        },
      ],
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: "全部 1" });
  await userEvent.click(screen.getByRole("button", { name: "删除 Repo Scout 插件" }));
  await userEvent.click(screen.getByRole("button", { name: "确认删除 Repo Scout 插件" }));

  await waitFor(() => {
    expect(deleteSpy).toHaveBeenCalledTimes(2);
  });
  expect(deleteSpy).toHaveBeenNthCalledWith(1, {
    pluginId: "repo-scout",
    hostTool: "codex",
    rootPath: "/Users/demo/workspace/repo-scout",
  });
  expect(deleteSpy).toHaveBeenNthCalledWith(2, {
    pluginId: "claude-code:repo-scout",
    hostTool: "claude-code",
    rootPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0",
  });
  expect(screen.queryByText("Repo Scout")).not.toBeInTheDocument();

  deleteSpy.mockRestore();
});

test("deletes codex skilldock plugins by their manifest root instead of display directory", async () => {
  const deleteSpy = vi.spyOn(skillClient, "deletePlugin").mockResolvedValue(undefined);
  const plugin: PluginSummary = {
    ...pluginFixtures[0],
    id: "codex:example-plugin",
    packageId: "example-plugin",
    manifestName: "example-plugin",
    name: "Example Plugin",
    hostTool: "codex",
    rootPath: "/Users/demo/.skilldock/plugins/example-plugin/example-plugin",
    displayRootPath: "/Users/demo/.codex/plugins/cache/skilldock/example-plugin",
    repoRootPath: "/Users/demo/.skilldock/plugins/example-plugin",
    manifestPath: "/Users/demo/.codex/marketplaces/skilldock/plugins/example-plugin/.codex-plugin/plugin.json",
    installSource: "skilldock",
  };
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce([plugin]);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: "全部 1" });
  await userEvent.click(screen.getByRole("button", { name: "删除 example-plugin 插件" }));
  await userEvent.click(screen.getByRole("button", { name: "确认删除 example-plugin 插件" }));

  await waitFor(() => {
    expect(deleteSpy).toHaveBeenCalledWith({
      pluginId: "codex:example-plugin",
      hostTool: "codex",
      rootPath: "/Users/demo/.skilldock/plugins/example-plugin/example-plugin",
    });
  });

  deleteSpy.mockRestore();
});

test("shows plugin toggle failures in the global notification stack", async () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const toggleSpy = vi
    .spyOn(skillClient, "setPluginEnabled")
    .mockRejectedValueOnce(new Error("write failed"));

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));
  await userEvent.click(screen.getByRole("button", { name: "开启 ecc 插件" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("开启插件失败，请检查宿主配置。");
  expect(screen.getByText("ecc")).toBeInTheDocument();
  expect(screen.getAllByText("未启用").length).toBeGreaterThan(0);
  expect(screen.queryByText("当前筛选条件下没有匹配的插件。")).not.toBeInTheDocument();

  toggleSpy.mockRestore();
  warnSpy.mockRestore();
});

test("shows plugin delete failures in the global notification stack", async () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const deleteSpy = vi
    .spyOn(skillClient, "deletePlugin")
    .mockRejectedValueOnce(new Error("permission denied"));

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Claude Code/ });
  expect(await screen.findByText("ecc")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "删除 ecc 插件" }));
  await userEvent.click(screen.getByRole("button", { name: "确认删除 ecc 插件" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("删除插件失败，请检查宿主配置和本地目录权限。");
  expect(screen.getByText("ecc")).toBeInTheDocument();

  deleteSpy.mockRestore();
  warnSpy.mockRestore();
});

test("switches plugin list by host tab and shows cross-host relation in details", async () => {
  const plugins: PluginSummary[] = [
    pluginFixtures[0],
    {
      ...pluginFixtures[0],
      id: "claude-code:repo-scout",
      hostTool: "claude-code",
      relatedHostTools: ["codex"],
      rootPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0",
      repoRootPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0",
      manifestPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0/.claude-plugin/plugin.json",
      installSource: "host",
      enabledState: "disabled",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  expect(await screen.findByText("Repo Scout")).toBeInTheDocument();
  expect(screen.queryByText("ecc")).not.toBeInTheDocument();
  const repoScoutRow = screen.getByRole("button", { name: /展开 Repo Scout/ }).closest(".tool-list-row");
  expect(repoScoutRow?.querySelectorAll(".plugins-page__host-coverage-item")).toHaveLength(0);

  await userEvent.click(
    screen.getByRole("button", { name: /展开 Repo Scout/ }),
  );
  expect(screen.queryByText("分支")).not.toBeInTheDocument();
  expect(screen.getByText("MCP")).toBeInTheDocument();
  expect(screen.getByText("Skills")).toBeInTheDocument();
  expect(screen.getByText("Subagents")).toBeInTheDocument();
  expect(screen.getByText("Rules")).toBeInTheDocument();
  expect(screen.getByText("Hooks")).toBeInTheDocument();
  expect(screen.getByText("repo-scout-skill")).toBeInTheDocument();
  expect(screen.getByText("codebase-researcher")).toBeInTheDocument();
  const detailPanel = screen.getByText("基本信息").closest(".plugins-page__detail-panel");
  expect(detailPanel).not.toBeNull();
  const sectionTitles = Array.from(
    (detailPanel as HTMLElement).querySelectorAll(".plugins-page__component-section-header h3"),
  ).map((heading) => heading.textContent?.trim());
  expect(sectionTitles.slice(0, 3)).toEqual(["Skills", "MCP", "Subagents"]);
  expect(
    screen.getByRole("button", { name: /repo-scout-skill/ }).querySelector(".plugins-page__component-icon--skill svg"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /repo-index/ }).querySelector(".plugins-page__component-icon--mcp svg"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /codebase-researcher/ }).querySelector(".plugins-page__component-icon--subagent svg"),
  ).toBeInTheDocument();
  expect(screen.getAllByText("查看剩余 2 项").length).toBeGreaterThan(0);
  expect(screen.getByText("安装宿主")).toBeInTheDocument();
  const relatedHostsField = screen.getByText("安装宿主").closest("div");

  expect(relatedHostsField).not.toBeNull();
  expect(
    (relatedHostsField as HTMLDivElement).querySelectorAll(".plugins-page__host-coverage-item"),
  ).toHaveLength(2);
  expect(
    (relatedHostsField as HTMLDivElement).textContent,
  ).not.toContain("Claude Code");
});

test("shows all installed host icons in all-tab merged plugin row", async () => {
  const plugins: PluginSummary[] = [
    pluginFixtures[0],
    {
      ...pluginFixtures[0],
      id: "claude-code:repo-scout",
      hostTool: "claude-code",
      relatedHostTools: ["codex", "cursor"],
      rootPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0",
      manifestPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0/.claude-plugin/plugin.json",
      installSource: "host",
      enabledState: "disabled",
    },
    {
      ...pluginFixtures[0],
      id: "cursor:repo-scout",
      hostTool: "cursor",
      relatedHostTools: ["codex", "claude-code"],
      rootPath: "/Users/demo/.cursor/plugins/cache/repo-scout/1.0.0",
      manifestPath: "/Users/demo/.cursor/plugins/cache/repo-scout/1.0.0/.cursor-plugin/plugin.json",
      installSource: "host",
      enabledState: "enabled",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: "全部 1" });
  const row = screen.getByRole("button", { name: /展开 Repo Scout/ }).closest(".tool-list-row");

  expect(
    row?.querySelectorAll(".plugins-page__host-coverage-item"),
  ).toHaveLength(3);
});

test("shows install-host icons consistently for cross-host marketplace plugins", async () => {
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[1],
      id: "claude-code:example-plugin",
      packageId: "example-plugin",
      name: "Example Plugin",
      hostTool: "claude-code",
      relatedHostTools: ["codex", "cursor"],
      sourceType: "marketplace",
      sourceLabel: "example-plugin",
      sourceUrl: "https://git.example.com/example-org/example-repo.git",
      sourceRef: "master",
      repoRootPath: "/Users/demo/.claude/plugins/cache/example-org/example-plugin/0.1.0",
      rootPath: "/Users/demo/.claude/plugins/cache/example-org/example-plugin/0.1.0",
      manifestPath: "/Users/demo/.claude/plugins/cache/example-org/example-plugin/0.1.0/.claude-plugin/plugin.json",
    },
    {
      ...pluginFixtures[1],
      id: "codex:example-plugin",
      packageId: "example-plugin",
      name: "Example Plugin",
      hostTool: "codex",
      relatedHostTools: ["claude-code", "cursor"],
      sourceType: "marketplace",
      sourceLabel: "example-plugin",
      sourceUrl: "https://git.example.com/example-org/example-repo.git",
      sourceRef: "master",
      repoRootPath: "/Users/demo/.codex/plugins/cache/example-org/example-plugin/0.1.0",
      rootPath: "/Users/demo/.codex/plugins/cache/example-org/example-plugin/0.1.0",
      manifestPath: "/Users/demo/.codex/plugins/cache/example-org/example-plugin/0.1.0/plugin.json",
    },
    {
      ...pluginFixtures[1],
      id: "cursor:example-plugin",
      packageId: "example-plugin",
      name: "Example Plugin",
      hostTool: "cursor",
      relatedHostTools: ["claude-code", "codex"],
      sourceType: "marketplace",
      sourceLabel: "example-plugin",
      sourceUrl: "https://git.example.com/example-org/example-repo.git",
      sourceRef: "master",
      repoRootPath: "/Users/demo/.cursor/plugins/cache/example-org/example-plugin/0.1.0",
      rootPath: "/Users/demo/.cursor/plugins/cache/example-org/example-plugin/0.1.0",
      manifestPath: "/Users/demo/.cursor/plugins/cache/example-org/example-plugin/0.1.0/.cursor-plugin/plugin.json",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));
  await userEvent.click(screen.getByRole("button", { name: /展开 Example Plugin/ }));

  const installHostsField = screen.getByText("安装宿主").closest("div");

  expect(installHostsField).not.toBeNull();
  expect(
    (installHostsField as HTMLDivElement).querySelectorAll(".plugins-page__host-coverage-item"),
  ).toHaveLength(3);
  expect(screen.queryByText("分支")).not.toBeInTheDocument();
  expect(screen.queryByText("git")).not.toBeInTheDocument();
});

test("renders plugin directory metadata below install method in plugin details", async () => {
  const plugins: PluginSummary[] = [
    {
      ...pluginFixtures[1],
      id: "claude-code:example-plugin",
      packageId: "example-plugin",
      name: "Example Plugin",
      hostTool: "claude-code",
      relatedHostTools: ["codex", "cursor"],
      sourceType: "marketplace",
      sourceLabel: "example-plugin",
      sourceUrl: "https://git.example.com/example-org/example-repo.git",
      sourceRef: "master",
      repoRootPath: "/Users/demo/.claude/plugins/cache/example-org/example-plugin/0.1.0",
      rootPath: "/Users/demo/.claude/plugins/cache/example-org/example-plugin/0.1.0",
      manifestPath: "/Users/demo/.claude/plugins/cache/example-org/example-plugin/0.1.0/.claude-plugin/plugin.json",
    },
    {
      ...pluginFixtures[1],
      id: "codex:example-plugin",
      packageId: "example-plugin",
      name: "Example Plugin",
      hostTool: "codex",
      relatedHostTools: ["claude-code", "cursor"],
      sourceType: "marketplace",
      sourceLabel: "example-plugin",
      sourceUrl: "https://git.example.com/example-org/example-repo.git",
      sourceRef: "master",
      repoRootPath: "/Users/demo/.codex/plugins/cache/example-org/example-plugin/0.1.0",
      rootPath: "/Users/demo/.codex/plugins/cache/example-org/example-plugin/0.1.0",
      manifestPath: "/Users/demo/.codex/plugins/cache/example-org/example-plugin/0.1.0/plugin.json",
    },
    {
      ...pluginFixtures[1],
      id: "cursor:example-plugin",
      packageId: "example-plugin",
      name: "Example Plugin",
      hostTool: "cursor",
      relatedHostTools: ["claude-code", "codex"],
      sourceType: "marketplace",
      sourceLabel: "example-plugin",
      sourceUrl: "https://git.example.com/example-org/example-repo.git",
      sourceRef: "master",
      repoRootPath: "/Users/demo/.cursor/plugins/cache/example-org/example-plugin/0.1.0",
      rootPath: "/Users/demo/.cursor/plugins/cache/example-org/example-plugin/0.1.0",
      manifestPath: "/Users/demo/.cursor/plugins/cache/example-org/example-plugin/0.1.0/.cursor-plugin/plugin.json",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));
  await userEvent.click(screen.getByRole("button", { name: /展开 Example Plugin/ }));

  const detailPanel = screen.getByText("基本信息").closest(".plugins-page__detail-panel");
  expect(detailPanel).not.toBeNull();

  const headings = Array.from(
    (detailPanel as HTMLElement).querySelectorAll("dt"),
  ).map((node) => node.textContent?.trim());

  expect(headings.indexOf("安装方式")).toBeGreaterThanOrEqual(0);
  expect(headings.indexOf("插件目录")).toBeGreaterThan(headings.indexOf("安装方式"));
  expect(headings.indexOf("安装宿主")).toBeGreaterThan(headings.indexOf("安装方式"));
});

test("hides plugin directory and related-host metadata in all-tab merged details", async () => {
  const plugins: PluginSummary[] = [
    pluginFixtures[0],
    {
      ...pluginFixtures[0],
      id: "claude-code:repo-scout",
      hostTool: "claude-code",
      relatedHostTools: ["codex", "cursor"],
      rootPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0",
      repoRootPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0",
      manifestPath: "/Users/demo/.claude/plugins/cache/repo-scout/1.0.0/.claude-plugin/plugin.json",
      installSource: "host",
      enabledState: "disabled",
    },
  ];
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: "全部 1" });
  await userEvent.click(screen.getByRole("button", { name: /展开 Repo Scout/ }));

  expect(screen.queryByText("插件目录")).not.toBeInTheDocument();
  expect(screen.queryByText("安装宿主")).not.toBeInTheDocument();
});

test("expands and collapses hidden plugin components by section", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  await userEvent.click(
    await screen.findByRole("button", { name: /展开 Repo Scout/ }),
  );

  const skillsSection = screen.getByRole("heading", {
    name: "Skills",
    level: 3,
  }).closest("section");
  expect(skillsSection).not.toBeNull();
  expect(screen.queryByText("repo-release-notes")).not.toBeInTheDocument();

  await userEvent.click(
    within(skillsSection as HTMLElement).getByRole("button", {
      name: "查看剩余 2 项",
    }),
  );

  expect(screen.getByText("repo-release-notes")).toBeInTheDocument();
  expect(screen.getByText("repo-owner-map")).toBeInTheDocument();

  await userEvent.click(
    within(skillsSection as HTMLElement).getByRole("button", {
      name: "收起",
    }),
  );

  expect(screen.queryByText("repo-release-notes")).not.toBeInTheDocument();
});

test("renders plugin chrome in English when workspace language is en", async () => {
  setWorkspaceLanguage("en");

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: "All 2" });
  expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Scan Import" })).toBeInTheDocument();
  expect(
    screen.getByPlaceholderText("Search plugins, hosts, or components"),
  ).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: /Claude Code/ }));
  await userEvent.click(screen.getByRole("button", { name: /Expand ecc/ }));

  expect(screen.getByText("Basic Info")).toBeInTheDocument();
  expect(screen.getByText("Description")).toBeInTheDocument();
  expect(screen.getByText("Install Method")).toBeInTheDocument();
  expect(screen.getByText("Host Install")).toBeInTheDocument();
});

test("opens a plugin component preview from the component list", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  await userEvent.click(
    await screen.findByRole("button", { name: /展开 Repo Scout/ }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: /repo-scout-skill/ }),
  );

  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(
    screen.getByText("Repo Scout · skills/repo-scout-skill/SKILL.md"),
  ).toBeInTheDocument();
  expect(screen.getAllByText("repo-scout-skill").length).toBeGreaterThan(0);
  expect(screen.getByText(/本地开发预览内容/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect(screen.getByRole("textbox")).toBeInTheDocument();
  expect(screen.getByDisplayValue(/本地开发预览内容/)).toBeInTheDocument();

  fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

test("shows nested files for plugin skill component previews", async () => {
  const previewEntries: PluginComponentPreview["entries"] = [
    { path: "skills/repo-scout-skill", name: "repo-scout-skill", entryType: "directory", depth: 0 },
    { path: "skills/repo-scout-skill/SKILL.md", name: "SKILL.md", entryType: "file", depth: 1 },
    { path: "skills/repo-scout-skill/reference", name: "reference", entryType: "directory", depth: 1 },
    { path: "skills/repo-scout-skill/reference/company-standards.md", name: "company-standards.md", entryType: "file", depth: 2 },
  ];
  const previewSpy = vi.spyOn(skillClient, "fetchPluginComponentPreview").mockImplementation(async (input) => ({
    path: input.componentId.endsWith(".md")
      ? input.componentId
      : "skills/repo-scout-skill/SKILL.md",
    title: "repo-scout-skill",
    assetType: "skill",
    content: input.componentId.endsWith("company-standards.md")
      ? "# Company Standards\n\n子目录内容。"
      : "# repo-scout-skill\n\n[Standards](reference/company-standards.md)",
    rootName: "repo-scout-skill",
    entries: previewEntries,
    initialFilePath: "skills/repo-scout-skill/SKILL.md",
  }));

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  await userEvent.click(
    await screen.findByRole("button", { name: /展开 Repo Scout/ }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: /repo-scout-skill/ }),
  );

  const dialog = await screen.findByRole("dialog");
  expect(dialog).toBeInTheDocument();
  expect(dialog.querySelector(".skill-file-dialog__tree-icon--markdown")).toBeInTheDocument();
  expect(within(dialog).queryByText("📄")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开 reference" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "展开 reference" }));
  await userEvent.click(screen.getByRole("button", { name: "company-standards.md" }));

  await waitFor(() => {
    expect(previewSpy).toHaveBeenLastCalledWith({
      pluginRoot: pluginFixtures[0].rootPath,
      componentId: "skills/repo-scout-skill/reference/company-standards.md",
      assetType: "skill",
    });
  });
  expect(screen.getByText("Repo Scout · skills/repo-scout-skill/reference/company-standards.md")).toBeInTheDocument();
  expect(screen.getByText(/子目录内容/)).toBeInTheDocument();
});

test("saves edited plugin component preview content", async () => {
  const saveSpy = vi.spyOn(skillClient, "savePluginComponentPreview").mockResolvedValue({
    path: "skills/repo-scout-skill/SKILL.md",
    title: "repo-scout-skill",
    assetType: "skill",
    content: "# repo-scout-skill\n\n已保存内容。",
    rootName: "repo-scout-skill",
    entries: [
      { path: "skills/repo-scout-skill", name: "repo-scout-skill", entryType: "directory", depth: 0 },
      { path: "skills/repo-scout-skill/SKILL.md", name: "SKILL.md", entryType: "file", depth: 1 },
    ],
    initialFilePath: "skills/repo-scout-skill/SKILL.md",
  });

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /全部/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  await userEvent.click(
    await screen.findByRole("button", { name: /展开 Repo Scout/ }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: /repo-scout-skill/ }),
  );
  await screen.findByRole("dialog");
  await userEvent.click(screen.getByRole("button", { name: "编辑" }));

  const textbox = screen.getByRole("textbox");
  await userEvent.clear(textbox);
  await userEvent.type(textbox, "# repo-scout-skill{enter}{enter}已保存内容。");
  await userEvent.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => {
    expect(saveSpy).toHaveBeenCalledWith({
      pluginRoot: pluginFixtures[0].rootPath,
      componentId: "skills/repo-scout-skill/SKILL.md",
      assetType: "skill",
      content: "# repo-scout-skill\n\n已保存内容。",
    });
  });
  await waitFor(() => {
    expect(screen.getByRole("textbox")).toHaveValue("# repo-scout-skill\n\n已保存内容。");
  });
});

test("keeps Cursor expansion scoped to the clicked install instance when plugin ids repeat", async () => {
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  const fetchSpy = vi
    .spyOn(skillClient, "fetchStartupInstalledPlugins")
    .mockResolvedValueOnce([
      buildCursorPlugin("Chrome", "/Users/demo/.cursor/plugins/cache/chrome/1"),
      buildCursorPlugin(
        "Example Plugin",
        "/Users/demo/.cursor/plugins/cache/example-plugin/1",
      ),
      buildCursorPlugin("Harness", "/Users/demo/.cursor/plugins/cache/harness/1"),
    ]);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: "全部 1" });
  await userEvent.click(screen.getByRole("tab", { name: "Cursor 3" }));
  await userEvent.click(await screen.findByRole("button", { name: "展开 Chrome" }));

  expect(screen.getByRole("button", { name: "收起 Chrome" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开 Example Plugin" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开 Harness" })).toBeInTheDocument();
  expect(screen.getAllByText("Chrome")).toHaveLength(1);
  expect(screen.getByText("基本信息")).toBeInTheDocument();

  fetchSpy.mockRestore();
  fixtureSpy.mockRestore();
});

function buildCursorPlugin(name: string, rootPath: string): PluginSummary {
  return {
    ...pluginFixtures[0],
    id: "cursor:chrome",
    name,
    description: `Control ${name} with Codex`,
    hostTool: "cursor",
    relatedHostTools: [],
    rootPath,
    manifestPath: `${rootPath}/.cursor-plugin/plugin.json`,
    sourceLabel: name.toLowerCase().replace(/\s+/g, "-"),
    sourceUrl: "",
    sourceRevision: "",
    currentVersion: "1.0.0",
    currentCommit: "",
    isGitRepo: false,
    enabledState: "enabled",
    scopes: [
      {
        scopeId: "user",
        scopeLabel: "用户级",
        enabledState: "enabled",
        location: `${rootPath}/.cursor-plugin/plugin.json`,
      },
    ],
    components: [
      {
        id: `skills/${name.toLowerCase().replace(/\s+/g, "-")}`,
        name: `${name} Skill`,
        description: `${name} skill`,
        assetType: "skill",
        ownerPluginId: "cursor:chrome",
        packageItemId: `skills/${name.toLowerCase().replace(/\s+/g, "-")}`,
      },
    ],
  };
}
