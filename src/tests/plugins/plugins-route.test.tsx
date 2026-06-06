import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { PluginsRoute, resetPluginScanSessionForTests } from "@/app/routes/plugins";
import * as skillClient from "@/features/skills/api/skill-client";
import { pluginFixtures } from "@/features/skills/state/skill-fixtures";
import type { PluginSummary } from "@/features/skills/state/skill-store";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { renderWithI18n } from "@/tests/helpers/render-with-i18n";

vi.mock("@/features/skills/state/skill-workspace", () => ({
  useSkillWorkspace: vi.fn(),
}));

const mockedUseSkillWorkspace = vi.mocked(useSkillWorkspace);

beforeEach(() => {
  delete (window as Window & { __SKILLM_PLUGINS__?: unknown }).__SKILLM_PLUGINS__;
  resetPluginScanSessionForTests();
  mockedUseSkillWorkspace.mockReturnValue({
    language: "zh-CN",
  } as ReturnType<typeof useSkillWorkspace>);
});

test("shows disabled plugin state with description-first source details", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Claude Code/ });
  expect(await screen.findByText("ecc")).toBeInTheDocument();
  expect(screen.getAllByText("未启用").length).toBeGreaterThan(0);

  await userEvent.click(screen.getByRole("button", { name: /展开 ecc/ }));
  expect(screen.getByText("基本信息")).toBeInTheDocument();
  expect(screen.getByText("简介")).toBeInTheDocument();
  expect(screen.getAllByText("Claude Code 官方插件，用于管理和运行扩展命令。").length)
    .toBeGreaterThanOrEqual(2);
  expect(screen.getByText("来源类型")).toBeInTheDocument();
  expect(screen.getByText("Git 仓库")).toBeInTheDocument();
  expect(screen.getByText("来源")).toBeInTheDocument();
  expect(screen.getByText("目录")).toBeInTheDocument();
  expect(screen.queryByText("Git 地址")).not.toBeInTheDocument();
  expect(screen.queryByText("宿主")).not.toBeInTheDocument();
  expect(screen.queryByText("安装状态")).not.toBeInTheDocument();
  expect(screen.queryByText("启用状态")).not.toBeInTheDocument();
  expect(screen.queryByText("启用范围")).not.toBeInTheDocument();
  expect(screen.queryByText("用户级")).not.toBeInTheDocument();
});

test("keeps plugin scan import action in the toolbar", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Claude Code/ });

  expect(screen.getByRole("button", { name: "扫描导入" })).toBeInTheDocument();
});

test("opens plugin git source links externally", async () => {
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Claude Code/ });
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
  vi.spyOn(skillClient, "fetchInstalledPlugins").mockResolvedValueOnce(plugins);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Cursor/ });
  await userEvent.click(screen.getByRole("tab", { name: /Cursor/ }));
  await screen.findByText("raisely");
  await userEvent.click(screen.getByRole("button", { name: /展开 raisely/ }));

  expect(screen.getByText("https://github.com/raisely/cursor-plugin.git")).toBeInTheDocument();
});

test("renders component summaries as separate badges and keeps the plugin description as subtitle", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Codex/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  await screen.findByText("Repo Scout");
  const repoScoutRow = screen.getByRole("button", { name: /展开 Repo Scout/ });
  const subtitle = repoScoutRow.querySelector(".tool-list-row__subtitle");
  const pluginIcon = repoScoutRow.querySelector(".plugins-page__plugin-icon");
  const badgeTexts = Array.from(
    repoScoutRow.querySelectorAll(".status-badge"),
  ).map((node) => node.textContent?.trim());

  expect(pluginIcon).toBeInTheDocument();
  expect(pluginIcon).toHaveTextContent("R");
  expect(subtitle).toHaveTextContent("扫描仓库中的插件组件，并帮助追踪插件资产来源。");
  expect(badgeTexts[0]).toBe("已启用");
  expect(badgeTexts[1]).toBe("7 skill");
  expect(badgeTexts[2]).toBe("1 mcp");
  expect(badgeTexts[3]).toBe("7 agents");
  expect(badgeTexts[4]).toBe("1 command");
  expect(badgeTexts[5]).toBe("1 rule");
  expect(badgeTexts[6]).toBe("1 hook");
  expect(badgeTexts).toHaveLength(7);
});

test("filters plugin list by enabled state", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Claude Code/ });
  expect(await screen.findByText("ecc")).toBeInTheDocument();

  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "筛选插件状态" }),
    "disabled",
  );

  expect(screen.queryByText("Repo Scout")).not.toBeInTheDocument();
  expect(screen.getByText("ecc")).toBeInTheDocument();
});

test("shows refresh loading animation in the plugin toolbar", async () => {
  const deferredFetch: {
    resolve?: (value: PluginSummary[]) => void;
  } = {};
  const fetchSpy = vi
    .spyOn(skillClient, "fetchInstalledPlugins")
    .mockResolvedValueOnce(pluginFixtures)
    .mockImplementationOnce(
      () =>
        new Promise<PluginSummary[]>((resolve) => {
          deferredFetch.resolve = resolve;
        }),
    );

  renderWithI18n(<PluginsRoute />);

  try {
    await screen.findByRole("tab", { name: /Claude Code/ });
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
    .mockResolvedValueOnce(pluginFixtures)
    .mockImplementationOnce(
      () =>
        new Promise<PluginSummary[]>((resolve) => {
          deferredFetch.resolve = resolve;
        }),
    );

  const { unmount } = renderWithI18n(<PluginsRoute />);

  try {
    await screen.findByRole("tab", { name: /Claude Code/ });
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
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("toggles plugin enabled state from the plugin list", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Claude Code/ });
  expect(await screen.findByText("ecc")).toBeInTheDocument();
  expect(screen.getAllByText("未启用").length).toBeGreaterThan(0);

  const toggleButton = screen.getByRole("button", { name: "开启 ecc 插件" });
  expect(toggleButton).toHaveClass("skill-card__icon-button");

  await userEvent.click(toggleButton);

  expect(await screen.findByRole("button", { name: "关闭 ecc 插件" })).toBeInTheDocument();
  expect(screen.getAllByText("已启用").length).toBeGreaterThan(0);
});

test("opens a plugin folder from the plugin list", async () => {
  const openPathSpy = vi.spyOn(skillClient, "openPathInFinder").mockResolvedValue(undefined);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Claude Code/ });
  expect(await screen.findByText("ecc")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "在访达中打开 ecc 插件目录" }));

  expect(openPathSpy).toHaveBeenCalledWith({
    path: "/Users/demo/.claude/plugins/cache/ecc/ecc/1.10.0",
  });

  openPathSpy.mockRestore();
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

test("shows plugin toggle failures without inserting an empty list card", async () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const toggleSpy = vi
    .spyOn(skillClient, "setPluginEnabled")
    .mockRejectedValueOnce(new Error("write failed"));

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Claude Code/ });
  await userEvent.click(screen.getByRole("button", { name: "开启 ecc 插件" }));

  expect(await screen.findByText("开启插件失败，请检查宿主配置。")).toHaveClass("plugins-page__inline-error");
  expect(screen.getByText("ecc")).toBeInTheDocument();
  expect(screen.getAllByText("未启用").length).toBeGreaterThan(0);
  expect(screen.queryByText("当前筛选条件下没有匹配的插件。")).not.toBeInTheDocument();

  toggleSpy.mockRestore();
  warnSpy.mockRestore();
});

test("switches plugin list by host tab and shows cross-host relation in details", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Codex/ });
  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  expect(await screen.findByText("Repo Scout")).toBeInTheDocument();
  expect(screen.queryByText("ecc")).not.toBeInTheDocument();

  await userEvent.click(
    screen.getByRole("button", { name: /展开 Repo Scout/ }),
  );
  expect(screen.getByText("分支")).toBeInTheDocument();
  expect(screen.getByText("main")).toBeInTheDocument();
  expect(screen.getByText("Revision")).toBeInTheDocument();
  expect(screen.getAllByText("4f2c1ab").length).toBeGreaterThan(0);
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
    screen.getByRole("button", { name: /mcp.json/ }).querySelector(".plugins-page__component-icon--mcp svg"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /codebase-researcher/ }).querySelector(".plugins-page__component-icon--subagent svg"),
  ).toBeInTheDocument();
  expect(screen.getAllByText("View 2 More").length).toBeGreaterThan(0);
  expect(screen.getByText("也安装在")).toBeInTheDocument();
  const relatedHostsField = screen.getByText("也安装在").closest("div");

  expect(relatedHostsField).not.toBeNull();
  expect(
    within(relatedHostsField as HTMLDivElement).getByText("Claude Code"),
  ).toBeInTheDocument();
});

test("expands and collapses hidden plugin components by section", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Codex/ });
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
      name: "View 2 More",
    }),
  );

  expect(screen.getByText("repo-release-notes")).toBeInTheDocument();
  expect(screen.getByText("repo-owner-map")).toBeInTheDocument();

  await userEvent.click(
    within(skillsSection as HTMLElement).getByRole("button", {
      name: "Show Less",
    }),
  );

  expect(screen.queryByText("repo-release-notes")).not.toBeInTheDocument();
});

test("opens a plugin component preview from the component list", async () => {
  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: /Codex/ });
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

test("keeps Cursor expansion scoped to the clicked install instance when plugin ids repeat", async () => {
  const fetchSpy = vi
    .spyOn(skillClient, "fetchInstalledPlugins")
    .mockResolvedValueOnce([
      buildCursorPlugin("Chrome", "/Users/demo/.cursor/plugins/cache/chrome/1"),
      buildCursorPlugin(
        "Example Plugin",
        "/Users/demo/.cursor/plugins/cache/example-plugin/1",
      ),
      buildCursorPlugin("Harness", "/Users/demo/.cursor/plugins/cache/harness/1"),
    ]);

  renderWithI18n(<PluginsRoute />);

  await screen.findByRole("tab", { name: "Cursor 3" });
  await userEvent.click(await screen.findByRole("button", { name: "展开 Chrome" }));

  expect(screen.getByRole("button", { name: "收起 Chrome" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开 Example Plugin" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开 Harness" })).toBeInTheDocument();
  expect(screen.getAllByText("Chrome")).toHaveLength(1);
  expect(screen.getByText("基本信息")).toBeInTheDocument();

  fetchSpy.mockRestore();
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
