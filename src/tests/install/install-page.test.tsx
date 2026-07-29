import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { App } from "@/app/App";
import { resetPluginInstallPanelState } from "@/features/install/components/PluginInstallPanel";
import { resetRepoInstallPanelState } from "@/features/install/components/RepoInstallPanel";
import * as skillClient from "@/features/skills/api/skill-client";
import {
  marketplaceSkillFixtures,
  mcpMarketplaceServerFixtures,
  toolConfigFixtures,
} from "@/features/skills/state/skill-fixtures";
import type { MarketplaceSkill, McpMarketplaceServer, PluginSummary } from "@/features/skills/state/skill-store";
import { getCachedMcpWorkspace } from "@/features/skills/utils/mcp-workspace-cache";
import { getCachedPlugins } from "@/features/skills/utils/plugin-cache";
import { clickNavInstall } from "@/tests/helpers/nav";

beforeEach(() => {
  resetRepoInstallPanelState();
  resetPluginInstallPanelState();
});

function resetMcpMarketplaceRuntimeCache() {
  delete (window as Window & { __SKILLM_MCP_MARKETPLACE_CACHE__?: unknown }).__SKILLM_MCP_MARKETPLACE_CACHE__;
  delete (window as Window & { __SKILLM_MCP_INSTALLED_SERVER_IDS__?: unknown }).__SKILLM_MCP_INSTALLED_SERVER_IDS__;
  delete (window as Window & { __SKILLM_MCP_WORKSPACE__?: unknown }).__SKILLM_MCP_WORKSPACE__;
}

function scrollMarketInstallToBottom() {
  const scrollContainer = document.querySelector(".market-install-scroll");
  if (!(scrollContainer instanceof HTMLElement)) {
    throw new Error("missing market install scroll container");
  }

  Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 700 });
  Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 260 });
  fireEvent.scroll(scrollContainer);
}

test("renders install-source and repository install panels", async () => {
  render(<App />);
  await clickNavInstall();
  expect(screen.getByRole("heading", { name: "安装", level: 1 })).toBeInTheDocument();
  expect(screen.getByText("通过安装源、Git 仓库或本地目录纳入新的 skill 和 MCP")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Skill" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "MCP" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Plugin" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "市场安装" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "skills.sh" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "skillsmp" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "skillhub" })).toBeInTheDocument();
  expect(screen.queryByText("安装后默认应用到所有已安装工具")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));
  expect(screen.getByRole("textbox", { name: "Git 仓库地址" })).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Git 分支" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "识别仓库技能" })).toBeInTheDocument();
});

test("discovers repo skills with the full branch from GitLab tree urls", async () => {
  const sourceUrl =
    "https://git.example.com/example-org/example-repo/-/tree/feature/FEATURE-123?ref_type=heads";
  const branchSpy = vi.spyOn(skillClient, "fetchGitRepoBranches").mockResolvedValue([
    { name: "main", isDefault: true, isSelected: false },
    { name: "feature/FEATURE-123", isDefault: false, isSelected: true },
  ]);
  const discoverSpy = vi.spyOn(skillClient, "installSkillFromRepo").mockResolvedValue([]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), sourceUrl);

  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toHaveAttribute(
      "data-value",
      "feature/FEATURE-123",
    );
  });
  await userEvent.click(screen.getByRole("button", { name: "识别仓库技能" }));

  await waitFor(() => {
    expect(discoverSpy).toHaveBeenCalledWith({
      repoUrl: sourceUrl,
      gitRef: "feature/FEATURE-123",
    });
  });

  branchSpy.mockRestore();
  discoverSpy.mockRestore();
});

test("probes plugin sources with Codex-style inputs and host selection", async () => {
  const sourceUrl =
    "https://git.example.com/example-org/example-repo/-/tree/master/example-plugin?ref_type=heads";
  const branchSpy = vi.spyOn(skillClient, "fetchGitRepoBranches").mockResolvedValue([
    { name: "main", isDefault: true, isSelected: false },
    { name: "master", isDefault: false, isSelected: true },
  ]);
  const probeSpy = vi.spyOn(skillClient, "probePluginSourceCandidates").mockResolvedValue([{
    tool: "codex",
    compatibleHostTools: ["codex", "claude-code"],
    kind: "plugin-repo",
    manifestName: "example-plugin",
    name: "example-plugin",
    description: "基于 Skill 的模块化 Example Plugin 框架",
    pluginRoot: "/tmp/example-repo/example-plugin",
    manifestPath: "/tmp/example-repo/example-plugin/.codex-plugin/plugin.json",
    marketplaceManifestPath: "",
    components: [
      {
        id: "skills/workflow-code-generation",
        name: "workflow-code-generation",
        description: "",
        assetType: "skill",
        ownerPluginId: "",
        packageItemId: "skills/workflow-code-generation",
      },
      {
        id: "skills/workflow-code-review",
        name: "workflow-code-review",
        description: "",
        assetType: "skill",
        ownerPluginId: "",
        packageItemId: "skills/workflow-code-review",
      },
      {
        id: "agents/codebase-researcher.md",
        name: "codebase-researcher.md",
        description: "",
        assetType: "subagent",
        ownerPluginId: "",
        packageItemId: "agents/codebase-researcher.md",
      },
      {
        id: "commands/code-review.md",
        name: "code-review.md",
        description: "",
        assetType: "command",
        ownerPluginId: "",
        packageItemId: "commands/code-review.md",
      },
      {
        id: ".mcp.json/context7",
        name: "context7",
        description: "",
        assetType: "mcp",
        ownerPluginId: "",
        packageItemId: ".mcp.json",
      },
    ],
    sourceType: "git",
    sourceUrl: "",
    isGitRepo: true,
    gitRoot: "/tmp/example-repo",
    confidence: "high",
    installStrategy: "codex-marketplace",
    warnings: [],
  }]);
  vi.spyOn(skillClient, "fetchInstalledPlugins").mockResolvedValue([]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Plugin" }));

  expect(screen.getByRole("textbox", { name: "Git 仓库地址" })).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Git 分支" })).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "稀疏路径" })).not.toBeInTheDocument();

  await userEvent.type(
    screen.getByRole("textbox", { name: "Git 仓库地址" }),
    sourceUrl,
  );
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toHaveAttribute("data-value", "master");
  });
  await userEvent.click(screen.getByRole("button", { name: "识别插件" }));

  await waitFor(() => {
    expect(probeSpy).toHaveBeenCalledWith({
      source: "https://git.example.com/example-org/example-repo",
      gitRef: "master",
      sparsePath: "example-plugin",
    });
  });
  expect(await screen.findByText("基于 Skill 的模块化 Example Plugin 框架")).toBeInTheDocument();
  expect(screen.getByText("2 skill")).toBeInTheDocument();
  expect(screen.getByText("1 mcp")).toBeInTheDocument();
  expect(screen.getByText("1 agents")).toBeInTheDocument();
  expect(screen.getByText("1 command")).toBeInTheDocument();
  expect(screen.getByText("基于 Skill 的模块化 Example Plugin 框架")).toBeInTheDocument();
  expect(screen.queryByText(/根目录:/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Manifest:/)).not.toBeInTheDocument();
  expect(screen.queryByText("兼容宿主")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /取消选择 Codex 作为 example-plugin 安装宿主/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: /取消选择 Claude Code 作为 example-plugin 安装宿主/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: /Cursor 作为 example-plugin 安装宿主/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "安装到选中宿主" })).toBeEnabled();

  probeSpy.mockRestore();
  branchSpy.mockRestore();
});

test("marks already installed plugin hosts and still allows installing remaining hosts", async () => {
  const sourceUrl = "https://git.example.com/example-org/example-repo";
  const branchSpy = vi.spyOn(skillClient, "fetchGitRepoBranches").mockResolvedValue([
    { name: "master", isDefault: true, isSelected: true },
  ]);
  const probeSpy = vi.spyOn(skillClient, "probePluginSourceCandidates").mockResolvedValue([{
    tool: "codex",
    compatibleHostTools: ["codex", "claude-code", "cursor"],
    kind: "plugin-repo",
    manifestName: "example-plugin",
    name: "example-plugin",
    description: "基于 Skill 的模块化 Example Plugin 框架",
    pluginRoot: "/tmp/example-repo/example-plugin",
    repoRoot: "/tmp/example-repo",
    pluginRelativePath: "example-plugin",
    manifestPath: "/tmp/example-repo/example-plugin/.codex-plugin/plugin.json",
    marketplaceManifestPath: "",
    components: [],
    sourceType: "git",
    sourceUrl: "https://git.example.com/example-org/example-repo",
    isGitRepo: true,
    gitRoot: "/tmp/example-repo",
    confidence: "high",
    installStrategy: "codex-marketplace",
    warnings: [],
  }]);
  const installedPlugins: PluginSummary[] = [
    {
      id: "claude-code:example-plugin",
      packageId: "example-plugin",
      manifestName: "example-plugin",
      name: "example-plugin",
      description: "",
      hostTool: "claude-code",
      relatedHostTools: ["cursor"],
      kind: "plugin-repo",
      rootPath: "/Users/demo/.skilldock/plugins/example-plugin/example-plugin",
      displayRootPath: "/Users/demo/.claude/plugins/marketplaces/skilldock/plugins/example-plugin",
      repoRootPath: "/Users/demo/.skilldock/plugins/example-plugin",
      pluginRelativePath: "example-plugin",
      manifestPath: "/Users/demo/.skilldock/plugins/example-plugin/example-plugin/.claude-plugin/plugin.json",
      sourceType: "git",
      sourceLabel: "skilldock",
      sourceUrl: "https://git.example.com/example-org/example-repo/tree/master/example-plugin",
      sourceRef: "master",
      sourceRevision: "abc123",
      currentVersion: "1.0.0",
      currentBranch: "master",
      currentCommit: "abc123",
      collabStatus: "clean",
      statusText: "",
      isGitRepo: true,
      updateMode: "auto",
      updateStrategy: "git",
      updateAvailable: false,
      baselineHash: "",
      localModified: false,
      installedAt: "1",
      updatedAt: "1",
      remoteUpdatedAt: "",
      localUpdatedAt: "",
      lastEditor: "",
      lastScannedAt: "1",
      status: "ready",
      installState: "installed",
      installSource: "skilldock",
      enabledState: "enabled",
      scopes: [],
      components: [],
    },
  ];
  const fetchInstalledPluginsSpy = vi.spyOn(skillClient, "fetchInstalledPlugins").mockResolvedValue(installedPlugins);
  const installSpy = vi.spyOn(skillClient, "installSelectedPluginProbes").mockResolvedValue([]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Plugin" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), sourceUrl);
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toHaveAttribute("data-value", "master");
  });
  await userEvent.click(screen.getByRole("button", { name: "识别插件" }));

  const codexButton = await screen.findByRole("button", { name: /选择 Codex 作为 example-plugin 安装宿主/ });
  const claudeButton = screen.getByRole("button", { name: "example-plugin 已安装到 Claude Code" });
  const cursorButton = screen.getByRole("button", { name: "example-plugin 已安装到 Cursor" });

  expect(codexButton).toHaveAttribute("aria-disabled", "false");
  expect(codexButton).toHaveAttribute("aria-pressed", "true");
  expect(claudeButton).toHaveAttribute("aria-disabled", "true");
  expect(claudeButton).toHaveAttribute("data-tooltip", "Claude Code · 已安装");
  expect(cursorButton).toHaveAttribute("aria-disabled", "true");
  expect(cursorButton).toHaveAttribute("data-tooltip", "Cursor · 已安装");
  expect(screen.getByRole("button", { name: "选择插件 example-plugin" })).toHaveClass("is-selected");
  expect(screen.getByRole("button", { name: "安装到选中宿主" })).toBeEnabled();

  await userEvent.click(screen.getByRole("button", { name: "安装到选中宿主" }));

  await waitFor(() => {
    expect(installSpy).toHaveBeenCalledWith({
      probes: [expect.objectContaining({ pluginRoot: "/tmp/example-repo/example-plugin" })],
      hostTools: ["codex"],
    });
  });

  branchSpy.mockRestore();
  probeSpy.mockRestore();
  fetchInstalledPluginsSpy.mockRestore();
  installSpy.mockRestore();
});

test("disables plugin install when every compatible host already has the plugin", async () => {
  const sourceUrl = "https://git.example.com/example-org/example-repo";
  const branchSpy = vi.spyOn(skillClient, "fetchGitRepoBranches").mockResolvedValue([
    { name: "master", isDefault: true, isSelected: true },
  ]);
  const probeSpy = vi.spyOn(skillClient, "probePluginSourceCandidates").mockResolvedValue([{
    tool: "codex",
    compatibleHostTools: ["codex", "claude-code"],
    kind: "plugin-repo",
    name: "example-plugin",
    description: "基于 Skill 的模块化 Example Plugin 框架",
    pluginRoot: "/tmp/example-repo/example-plugin",
    repoRoot: "/tmp/example-repo",
    pluginRelativePath: "example-plugin",
    manifestPath: "/tmp/example-repo/example-plugin/.codex-plugin/plugin.json",
    marketplaceManifestPath: "",
    components: [],
    sourceType: "git",
    sourceUrl: "https://git.example.com/example-org/example-repo",
    isGitRepo: true,
    gitRoot: "/tmp/example-repo",
    confidence: "high",
    installStrategy: "codex-marketplace",
    warnings: [],
  }]);
  const installedPlugins: PluginSummary[] = (["codex", "claude-code"] as const).map((hostTool) => ({
    id: `${hostTool}:example-plugin`,
    packageId: "example-plugin",
    name: "example-plugin",
    description: "",
    hostTool,
    relatedHostTools: hostTool === "codex" ? ["claude-code"] : ["codex"],
    kind: "plugin-repo",
    rootPath: `/Users/demo/${hostTool}/example-plugin`,
    displayRootPath: `/Users/demo/${hostTool}/example-plugin`,
    repoRootPath: `/Users/demo/${hostTool}/example-plugin`,
    pluginRelativePath: "example-plugin",
    manifestPath: `/Users/demo/${hostTool}/example-plugin/plugin.json`,
    sourceType: "git",
    sourceLabel: "skilldock",
    sourceUrl: "https://git.example.com/example-org/example-repo",
    sourceRef: "master",
    sourceRevision: "abc123",
    currentVersion: "1.0.0",
    currentBranch: "master",
    currentCommit: "abc123",
    collabStatus: "clean",
    statusText: "",
    isGitRepo: true,
    updateMode: "auto",
    updateStrategy: "git",
    updateAvailable: false,
    baselineHash: "",
    localModified: false,
    installedAt: "1",
    updatedAt: "1",
    remoteUpdatedAt: "",
    localUpdatedAt: "",
    lastEditor: "",
    lastScannedAt: "1",
    status: "ready",
    installState: "installed",
    installSource: "skilldock",
    enabledState: "enabled",
    scopes: [],
    components: [],
  }));
  const fetchInstalledPluginsSpy = vi.spyOn(skillClient, "fetchInstalledPlugins").mockResolvedValue(installedPlugins);
  const installSpy = vi.spyOn(skillClient, "installSelectedPluginProbes").mockResolvedValue([]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Plugin" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), sourceUrl);
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toHaveAttribute("data-value", "master");
  });
  await userEvent.click(screen.getByRole("button", { name: "识别插件" }));

  const installedCard = await screen.findByRole("button", { name: "插件 example-plugin 已安装" });
  expect(installedCard).toHaveAttribute("aria-disabled", "true");
  expect(installedCard).toHaveClass("is-disabled");
  expect(within(installedCard).getByText("已安装")).toBeInTheDocument();
  expect(within(installedCard).getByRole("heading", { name: "example-plugin" })).toHaveClass(
    "repo-install__option-title-text",
    "is-disabled",
  );
  expect(screen.getByRole("button", { name: "example-plugin 已安装到 Codex" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "example-plugin 已安装到 Claude Code" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "安装到选中宿主" })).toBeDisabled();

  expect(installSpy).not.toHaveBeenCalled();

  branchSpy.mockRestore();
  probeSpy.mockRestore();
  fetchInstalledPluginsSpy.mockRestore();
  installSpy.mockRestore();
});

test("probes GitLab tree plugin sources with sparse paths", async () => {
  const sourceUrl =
    "https://git.example.com/example-org/example-repo/-/tree/master/plugins/example-plugin?ref_type=heads";
  const branchSpy = vi.spyOn(skillClient, "fetchGitRepoBranches").mockResolvedValue([
    { name: "master", isDefault: true, isSelected: true },
  ]);
  const probeSpy = vi.spyOn(skillClient, "probePluginSourceCandidates").mockResolvedValue([{
    tool: "claude-code",
    compatibleHostTools: ["claude-code"],
    kind: "plugin-repo",
    name: "example-plugin",
    description: "面向工作流编排与项目初始化的插件集合",
    pluginRoot: "/tmp/example-repo/plugins/example-plugin",
    manifestPath: "/tmp/example-repo/plugins/example-plugin/.claude-plugin/plugin.json",
    marketplaceManifestPath: "",
    components: [],
    sourceType: "git",
    sourceUrl: "",
    isGitRepo: true,
    gitRoot: "/tmp/example-repo",
    confidence: "high",
    installStrategy: "claude-plugin-dir",
    warnings: [],
  }]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Plugin" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), sourceUrl);

  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toHaveAttribute("data-value", "master");
  });
  await userEvent.click(screen.getByRole("button", { name: "识别插件" }));

  await waitFor(() => {
    expect(probeSpy).toHaveBeenCalledWith({
      source: "https://git.example.com/example-org/example-repo",
      gitRef: "master",
      sparsePath: "plugins/example-plugin",
    });
  });

  branchSpy.mockRestore();
  probeSpy.mockRestore();
});

test("treats manifest name as the stable identity when plugin display names differ", async () => {
  const sourceUrl = "https://github.com/Shopify/Shopify-AI-Toolkit";
  const branchSpy = vi.spyOn(skillClient, "fetchGitRepoBranches").mockResolvedValue([
    { name: "main", isDefault: true, isSelected: true },
  ]);
  const probeSpy = vi.spyOn(skillClient, "probePluginSourceCandidates").mockResolvedValue([{
    tool: "codex",
    compatibleHostTools: ["codex", "claude-code", "cursor"],
    kind: "plugin-repo",
    manifestName: "shopify-plugin",
    name: "Shopify",
    description: "Search Shopify docs, validate GraphQL & Liquid, build Shopify apps faster.",
    pluginRoot: "/tmp/shopify-ai-toolkit",
    repoRoot: "/tmp/shopify-ai-toolkit",
    pluginRelativePath: "",
    manifestPath: "/tmp/shopify-ai-toolkit/.codex-plugin/plugin.json",
    marketplaceManifestPath: "",
    components: [],
    sourceType: "git",
    sourceUrl,
    isGitRepo: true,
    gitRoot: "/tmp/shopify-ai-toolkit",
    confidence: "high",
    installStrategy: "codex-marketplace",
    warnings: [],
  }]);
  const fetchInstalledPluginsSpy = vi.spyOn(skillClient, "fetchInstalledPlugins").mockResolvedValue([{
    id: "codex:shopify-plugin",
    packageId: "shopify-ai-toolkit",
    manifestName: "shopify-plugin",
    name: "Shopify",
    description: "Search Shopify docs, validate GraphQL & Liquid, build Shopify apps faster.",
    hostTool: "codex",
    relatedHostTools: [],
    kind: "plugin-repo",
    rootPath: "/Users/demo/.codex/plugins/cache/skilldock/shopify-plugin/1.4.1",
    displayRootPath: "/Users/demo/.codex/marketplaces/skilldock/plugins/shopify-plugin",
    repoRootPath: "/Users/demo/.skilldock/plugins/shopify-ai-toolkit",
    pluginRelativePath: "",
    manifestPath: "/Users/demo/.codex/marketplaces/skilldock/plugins/shopify-plugin/.codex-plugin/plugin.json",
    sourceType: "git",
    sourceLabel: "skilldock",
    sourceUrl,
    sourceRef: "",
    sourceRevision: "abc123",
    currentVersion: "1.4.1",
    currentBranch: "main",
    currentCommit: "abc123",
    collabStatus: "clean",
    statusText: "",
    isGitRepo: true,
    updateMode: "auto",
    updateStrategy: "git",
    updateAvailable: false,
    baselineHash: "",
    localModified: false,
    installedAt: "",
    updatedAt: "",
    remoteUpdatedAt: "",
    localUpdatedAt: "",
    lastEditor: "",
    lastScannedAt: "",
    status: "ready",
    installState: "installed",
    installSource: "skilldock",
    enabledState: "enabled",
    scopes: [],
    components: [],
  }]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Plugin" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), sourceUrl);

  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toHaveAttribute("data-value", "main");
  });
  await userEvent.click(screen.getByRole("button", { name: "识别插件" }));

  const codexButton = await screen.findByRole("button", { name: /Shopify 已安装到 Codex/ });
  expect(codexButton).toHaveAttribute("aria-disabled", "true");

  branchSpy.mockRestore();
  probeSpy.mockRestore();
  fetchInstalledPluginsSpy.mockRestore();
});

test("keeps plugin probes visible and stops blocking on workspace refresh after install", async () => {
  const sourceUrl = "https://github.com/Shopify/Shopify-AI-Toolkit";
  const branchSpy = vi.spyOn(skillClient, "fetchGitRepoBranches").mockResolvedValue([
    { name: "main", isDefault: true, isSelected: true },
  ]);
  const probeSpy = vi.spyOn(skillClient, "probePluginSourceCandidates").mockResolvedValue([{
    tool: "codex",
    compatibleHostTools: ["codex"],
    kind: "plugin-repo",
    manifestName: "shopify-plugin",
    name: "Shopify",
    description: "Search Shopify docs, validate GraphQL & Liquid, build Shopify apps faster.",
    pluginRoot: "/tmp/shopify-ai-toolkit",
    repoRoot: "/tmp/shopify-ai-toolkit",
    pluginRelativePath: "",
    manifestPath: "/tmp/shopify-ai-toolkit/.codex-plugin/plugin.json",
    marketplaceManifestPath: "",
    components: [],
    sourceType: "git",
    sourceUrl,
    isGitRepo: true,
    gitRoot: "/tmp/shopify-ai-toolkit",
    confidence: "high",
    installStrategy: "codex-marketplace",
    warnings: [],
  }]);
  const installSpy = vi.spyOn(skillClient, "installSelectedPluginProbes").mockResolvedValue([]);
  const refreshSpy = vi.spyOn(skillClient, "refreshPluginStates").mockResolvedValue([]);
  const workspaceRefreshSpy = vi
    .spyOn(skillClient, "fetchToolConfigs")
    .mockResolvedValueOnce(toolConfigFixtures)
    .mockImplementationOnce(() => new Promise(() => {}));

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Plugin" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), sourceUrl);
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toHaveAttribute("data-value", "main");
  });
  await userEvent.click(screen.getByRole("button", { name: "识别插件" }));
  await screen.findByText("Shopify");
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "安装到选中宿主" })).toBeEnabled();
  });

  await userEvent.click(screen.getByRole("button", { name: "安装到选中宿主" }));

  await waitFor(() => {
    expect(installSpy).toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalled();
  });
  expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "选择插件 Shopify" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "识别插件" })).not.toBeInTheDocument();

  branchSpy.mockRestore();
  probeSpy.mockRestore();
  installSpy.mockRestore();
  refreshSpy.mockRestore();
  workspaceRefreshSpy.mockRestore();
});

test("renders plugin probe title from manifest name instead of cache directory name", async () => {
  vi.spyOn(skillClient, "fetchInstalledPlugins").mockResolvedValue([]);
  const branchSpy = vi.spyOn(skillClient, "fetchGitRepoBranches").mockResolvedValue([
    { name: "main", isDefault: true, isSelected: true },
  ]);
  const probeSpy = vi.spyOn(skillClient, "probePluginSourceCandidates").mockResolvedValue([{
    tool: "cursor",
    compatibleHostTools: ["cursor"],
    kind: "plugin-repo",
    name: "raisely",
    description: "Connect Cursor to Raisely.",
    pluginRoot: "/tmp/plugin-https-github-com-raisely-cursor-plugin-git",
    manifestPath: "/tmp/plugin-https-github-com-raisely-cursor-plugin-git/.cursor-plugin/plugin.json",
    marketplaceManifestPath: "",
    components: [],
    sourceType: "git",
    sourceUrl: "https://github.com/raisely/cursor-plugin.git",
    isGitRepo: true,
    gitRoot: "/tmp/plugin-https-github-com-raisely-cursor-plugin-git",
    confidence: "high",
    installStrategy: "cursor-registration",
    warnings: [],
  }]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Plugin" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Git 仓库地址" }),
    "https://github.com/raisely/cursor-plugin.git",
  );
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toHaveAttribute("data-value", "main");
  });
  await userEvent.click(screen.getByRole("button", { name: "识别插件" }));

  expect(await screen.findByText("Connect Cursor to Raisely.")).toBeInTheDocument();
  expect(screen.queryByText("plugin-https-github-com-raisely-cursor-plugin-git")).not.toBeInTheDocument();

  branchSpy.mockRestore();
  probeSpy.mockRestore();
});

test("probes repository roots and lists every plugin candidate", async () => {
  const sourceUrl = "https://git.example.com/example-org/example-repo";
  const branchSpy = vi.spyOn(skillClient, "fetchGitRepoBranches").mockResolvedValue([
    { name: "master", isDefault: true, isSelected: true },
  ]);
  const probeSpy = vi.spyOn(skillClient, "probePluginSourceCandidates").mockResolvedValue([
    {
      tool: "codex",
      compatibleHostTools: ["codex", "claude-code", "cursor"],
      kind: "plugin-repo",
      name: "example-plugin",
      description: "基于 Skill 的模块化 Example Plugin 框架",
      pluginRoot: "/tmp/example-repo/example-plugin",
      manifestPath: "/tmp/example-repo/example-plugin/.codex-plugin/plugin.json",
      marketplaceManifestPath: "",
      components: [
        {
          id: "skills/workflow-code-generation",
          name: "workflow-code-generation",
          description: "",
          assetType: "skill",
          ownerPluginId: "",
          packageItemId: "skills/workflow-code-generation",
        },
      ],
      sourceType: "git",
      sourceUrl: "",
      isGitRepo: true,
      gitRoot: "/tmp/example-repo",
      confidence: "high",
      installStrategy: "codex-marketplace",
      warnings: [],
    },
    {
      tool: "claude-code",
      compatibleHostTools: ["claude-code"],
      kind: "plugin-repo",
      name: "example-plugin",
      description: "面向工作流编排与项目初始化的插件集合",
      pluginRoot: "/tmp/example-repo/plugins/example-plugin",
      manifestPath: "/tmp/example-repo/plugins/example-plugin/.claude-plugin/plugin.json",
      marketplaceManifestPath: "",
      components: [
        {
          id: "commands/init-project.md",
          name: "init-project.md",
          description: "",
          assetType: "command",
          ownerPluginId: "",
          packageItemId: "commands/init-project.md",
        },
      ],
      sourceType: "git",
      sourceUrl: "",
      isGitRepo: true,
      gitRoot: "/tmp/example-repo",
      confidence: "high",
      installStrategy: "claude-plugin-dir",
      warnings: [],
    },
  ]);
  vi.spyOn(skillClient, "fetchInstalledPlugins").mockResolvedValue([]);
  const installSpy = vi.spyOn(skillClient, "installSelectedPluginProbes").mockResolvedValue([]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Plugin" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), sourceUrl);

  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toHaveAttribute("data-value", "master");
  });
  await userEvent.click(screen.getByRole("button", { name: "识别插件" }));

  await waitFor(() => {
    expect(probeSpy).toHaveBeenCalledWith({
      source: sourceUrl,
      gitRef: "master",
    });
  });
  expect(await screen.findByText("example-plugin")).toBeInTheDocument();
  expect(screen.getByText("example-plugin")).toBeInTheDocument();
  expect(screen.getByText("1 skill")).toBeInTheDocument();
  expect(screen.getByText("1 command")).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Git 仓库地址" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "安装到选中宿主" })).toBeDisabled();
  expect(screen.getByText("example-plugin").closest(".plugin-install-preview__item")).not.toHaveClass("is-selected");
  expect(screen.getByRole("button", { name: /选择 Codex 作为 example-plugin 安装宿主/ })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: /选择 Claude Code 作为 example-plugin 安装宿主/ })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: /选择 Cursor 作为 example-plugin 安装宿主/ })).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(screen.getByRole("button", { name: /选择 Claude Code 作为 example-plugin 安装宿主/ }));
  await waitFor(() => {
    expect(screen.getByText("example-plugin").closest(".plugin-install-preview__item")).toHaveClass("is-selected");
    expect(screen.getByRole("button", { name: /取消选择 Claude Code 作为 example-plugin 安装宿主/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "安装到选中宿主" })).toBeEnabled();
  });
  await userEvent.click(screen.getByRole("button", { name: "安装到选中宿主" }));
  await waitFor(() => {
    expect(installSpy).toHaveBeenCalledWith({
      probes: [expect.objectContaining({ pluginRoot: "/tmp/example-repo/plugins/example-plugin" })],
      hostTools: ["claude-code"],
    });
  });

  branchSpy.mockRestore();
  probeSpy.mockRestore();
  installSpy.mockRestore();
});

test("uses browser fixtures to list example-repo plugin candidates", async () => {
  const sourceUrl = "https://git.example.com/example-org/example-repo";
  vi.spyOn(skillClient, "fetchInstalledPlugins").mockResolvedValue([]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Plugin" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), sourceUrl);

  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toBeInTheDocument();
  });
  await userEvent.click(screen.getByRole("button", { name: "识别插件" }));

  expect(await screen.findByText("example-plugin")).toBeInTheDocument();
  expect(await screen.findByText("example-plugin")).toBeInTheDocument();
  expect(screen.getByText("1 command")).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Git 仓库地址" })).not.toBeInTheDocument();
});

test("filters discovered plugin candidates by name and description", async () => {
  const sourceUrl = "https://git.example.com/example-org/example-repo";
  const fetchInstalledPluginsSpy = vi.spyOn(skillClient, "fetchInstalledPlugins").mockResolvedValue([]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Plugin" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), sourceUrl);

  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toBeInTheDocument();
  });
  await userEvent.click(screen.getByRole("button", { name: "识别插件" }));

  expect(await screen.findByText("example-plugin")).toBeInTheDocument();
  expect(await screen.findByText("example-plugin")).toBeInTheDocument();
  const searchInput = screen.getByRole("searchbox", { name: "搜索仓库插件" });

  await userEvent.type(searchInput, "workflow");
  expect(screen.queryByText("example-plugin")).not.toBeInTheDocument();
  expect(screen.getByText("example-plugin")).toBeInTheDocument();

  await userEvent.clear(searchInput);
  await userEvent.type(searchInput, "框架");
  expect(screen.getByText("example-plugin")).toBeInTheDocument();
  expect(screen.queryByText("example-plugin")).not.toBeInTheDocument();

  await userEvent.clear(searchInput);
  await userEvent.type(searchInput, "missing");
  expect(screen.getByText("暂无匹配的插件")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();

  fetchInstalledPluginsSpy.mockRestore();
});

test("selects and deselects visible plugin candidates from git install search results", async () => {
  const sourceUrl = "https://git.example.com/example-org/example-repo";
  const fetchInstalledPluginsSpy = vi.spyOn(skillClient, "fetchInstalledPlugins").mockResolvedValue([]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Plugin" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), sourceUrl);

  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toBeInTheDocument();
  });
  await userEvent.click(screen.getByRole("button", { name: "识别插件" }));

  expect(await screen.findByText("example-plugin")).toBeInTheDocument();
  expect(await screen.findByText("example-plugin")).toBeInTheDocument();
  const searchInput = screen.getByRole("searchbox", { name: "搜索仓库插件" });
  await userEvent.type(searchInput, "workflow");

  await userEvent.click(screen.getByRole("button", { name: "全选" }));
  expect(screen.getByRole("button", { name: "取消全选" })).toBeInTheDocument();
  expect(screen.getByText("example-plugin").closest(".plugin-install-preview__item")).toHaveClass("is-selected");

  await userEvent.clear(searchInput);
  expect(screen.getByRole("button", { name: "全选" })).toBeInTheDocument();
  expect(screen.getByText("example-plugin").closest(".plugin-install-preview__item")).toHaveClass("is-selected");
  expect(screen.getByText("example-plugin").closest(".plugin-install-preview__item")).not.toHaveClass("is-selected");

  await userEvent.click(screen.getByRole("button", { name: "全选" }));
  expect(screen.getByRole("button", { name: "取消全选" })).toBeInTheDocument();
  expect(screen.getByText("example-plugin").closest(".plugin-install-preview__item")).toHaveClass("is-selected");

  await userEvent.click(screen.getByRole("button", { name: "取消全选" }));
  expect(screen.getByText("example-plugin").closest(".plugin-install-preview__item")).not.toHaveClass("is-selected");
  expect(screen.getByText("example-plugin").closest(".plugin-install-preview__item")).not.toHaveClass("is-selected");

  fetchInstalledPluginsSpy.mockRestore();
});

test("keeps the plugin install result page open after installing selected hosts", async () => {
  const sourceUrl = "https://git.example.com/example-org/example-repo";
  const branchSpy = vi.spyOn(skillClient, "fetchGitRepoBranches").mockResolvedValue([
    { name: "master", isDefault: true, isSelected: true },
  ]);
  const probeSpy = vi.spyOn(skillClient, "probePluginSourceCandidates").mockResolvedValue([
    {
      tool: "codex",
      compatibleHostTools: ["codex", "claude-code", "cursor"],
      kind: "plugin-repo",
      name: "example-plugin",
      description: "基于 Skill 的模块化 Example Plugin 框架",
      pluginRoot: "/tmp/example-repo/example-plugin",
      repoRoot: "/tmp/example-repo",
      pluginRelativePath: "example-plugin",
      manifestPath: "/tmp/example-repo/example-plugin/.codex-plugin/plugin.json",
      marketplaceManifestPath: "",
      components: [],
      sourceType: "git",
      sourceUrl,
      isGitRepo: true,
      gitRoot: "/tmp/example-repo",
      confidence: "high",
      installStrategy: "codex-marketplace",
      warnings: [],
    },
  ]);
  const fetchInstalledPluginsSpy = vi.spyOn(skillClient, "fetchInstalledPlugins")
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      {
        id: "codex:example-plugin",
        packageId: "example-plugin",
        name: "example-plugin",
        description: "",
        hostTool: "codex",
        relatedHostTools: [],
        kind: "plugin-repo",
        rootPath: "/Users/demo/.codex/plugins/example-plugin",
        displayRootPath: "/Users/demo/.codex/plugins/example-plugin",
        repoRootPath: "/Users/demo/.codex/plugins/example-plugin",
        pluginRelativePath: "example-plugin",
        manifestPath: "/Users/demo/.codex/plugins/example-plugin/plugin.json",
        sourceType: "git",
        sourceLabel: "skilldock",
        sourceUrl,
        sourceRef: "master",
        sourceRevision: "abc123",
        currentVersion: "1.0.0",
        currentBranch: "master",
        currentCommit: "abc123",
        collabStatus: "clean",
        statusText: "",
        isGitRepo: true,
        updateMode: "auto",
        updateStrategy: "git",
        updateAvailable: false,
        baselineHash: "",
        localModified: false,
        installedAt: "1",
        updatedAt: "1",
        remoteUpdatedAt: "",
        localUpdatedAt: "",
        lastEditor: "",
        lastScannedAt: "1",
        status: "ready",
        installState: "installed",
        installSource: "skilldock",
        enabledState: "enabled",
        scopes: [],
        components: [],
      },
    ] as PluginSummary[]);
  const installSpy = vi.spyOn(skillClient, "installSelectedPluginProbes").mockResolvedValue([]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Plugin" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), sourceUrl);

  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toHaveAttribute("data-value", "master");
  });
  await userEvent.click(screen.getByRole("button", { name: "识别插件" }));

  expect(await screen.findByRole("button", { name: "选择插件 example-plugin" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "安装到选中宿主" }));

  await waitFor(() => {
    expect(installSpy).toHaveBeenCalledWith({
      probes: [expect.objectContaining({ pluginRoot: "/tmp/example-repo/example-plugin" })],
      hostTools: ["codex", "claude-code", "cursor"],
    });
  });
  expect(await screen.findByText("选中插件已安装")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Git 仓库地址" })).not.toBeInTheDocument();

  branchSpy.mockRestore();
  probeSpy.mockRestore();
  fetchInstalledPluginsSpy.mockRestore();
  installSpy.mockRestore();
});

test("updates the shared plugin cache right after plugin install completes", async () => {
  const sourceUrl = "https://git.example.com/example-org/example-repo";
  const installedPlugin: PluginSummary = {
    id: "codex:example-plugin",
    packageId: "example-plugin",
    name: "example-plugin",
    description: "",
    hostTool: "codex",
    relatedHostTools: [],
    kind: "plugin-repo",
    rootPath: "/Users/demo/.codex/plugins/example-plugin",
    displayRootPath: "/Users/demo/.codex/plugins/example-plugin",
    repoRootPath: "/Users/demo/.codex/plugins/example-plugin",
    pluginRelativePath: "example-plugin",
    manifestPath: "/Users/demo/.codex/plugins/example-plugin/plugin.json",
    sourceType: "git",
    sourceLabel: "skilldock",
    sourceUrl,
    sourceRef: "master",
    sourceRevision: "abc123",
    currentVersion: "1.0.0",
    currentBranch: "master",
    currentCommit: "abc123",
    collabStatus: "clean",
    statusText: "",
    isGitRepo: true,
    updateMode: "auto",
    updateStrategy: "git",
    updateAvailable: false,
    baselineHash: "",
    localModified: false,
    installedAt: "1",
    updatedAt: "1",
    remoteUpdatedAt: "",
    localUpdatedAt: "",
    lastEditor: "",
    lastScannedAt: "1",
    status: "ready",
    installState: "installed",
    installSource: "skilldock",
    enabledState: "enabled",
    scopes: [],
    components: [],
  };
  const branchSpy = vi.spyOn(skillClient, "fetchGitRepoBranches").mockResolvedValue([
    { name: "master", isDefault: true, isSelected: true },
  ]);
  const probeSpy = vi.spyOn(skillClient, "probePluginSourceCandidates").mockResolvedValue([
    {
      tool: "codex",
      compatibleHostTools: ["codex"],
      kind: "plugin-repo",
      name: "example-plugin",
      description: "基于 Skill 的模块化 Example Plugin 框架",
      pluginRoot: "/tmp/example-repo/example-plugin",
      repoRoot: "/tmp/example-repo",
      pluginRelativePath: "example-plugin",
      manifestPath: "/tmp/example-repo/example-plugin/.codex-plugin/plugin.json",
      marketplaceManifestPath: "",
      components: [],
      sourceType: "git",
      sourceUrl,
      isGitRepo: true,
      gitRoot: "/tmp/example-repo",
      confidence: "high",
      installStrategy: "codex-marketplace",
      warnings: [],
    },
  ]);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  const fetchInstalledPluginsSpy = vi.spyOn(skillClient, "fetchInstalledPlugins").mockResolvedValue([]);
  const refreshPluginStatesSpy = vi.spyOn(skillClient, "refreshPluginStates").mockResolvedValue([installedPlugin]);
  const installSpy = vi.spyOn(skillClient, "installSelectedPluginProbes").mockResolvedValue([]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Plugin" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), sourceUrl);
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toHaveAttribute("data-value", "master");
  });
  await userEvent.click(screen.getByRole("button", { name: "识别插件" }));
  await screen.findByRole("button", { name: "选择插件 example-plugin" });

  expect(getCachedPlugins()).toBeNull();

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "安装到选中宿主" })).toBeEnabled();
  });
  await userEvent.click(screen.getByRole("button", { name: "安装到选中宿主" }));

  await waitFor(() => {
    expect(refreshPluginStatesSpy).toHaveBeenCalledTimes(1);
    expect(getCachedPlugins()).toEqual([installedPlugin]);
  });

  branchSpy.mockRestore();
  probeSpy.mockRestore();
  fixtureSpy.mockRestore();
  fetchInstalledPluginsSpy.mockRestore();
  refreshPluginStatesSpy.mockRestore();
  installSpy.mockRestore();
});

test("shows newly installed plugin before the follow-up plugin refresh resolves", async () => {
  const sourceUrl = "https://github.com/raisely/cursor-plugin.git";
  const installedPlugin: PluginSummary = {
    id: "cursor:raisely",
    packageId: "raisely",
    manifestName: "raisely",
    name: "Raisely",
    description: "Connect Cursor to Raisely.",
    hostTool: "cursor",
    relatedHostTools: [],
    kind: "plugin-repo",
    rootPath: "/Users/demo/.cursor/plugins/local/raisely",
    displayRootPath: "/Users/demo/.cursor/plugins/local/raisely",
    repoRootPath: "/Users/demo/.skilldock/plugins/raisely",
    pluginRelativePath: "",
    manifestPath: "/Users/demo/.cursor/plugins/local/raisely/.cursor-plugin/plugin.json",
    sourceType: "git",
    sourceLabel: "skilldock",
    sourceUrl,
    sourceRef: "main",
    sourceRevision: "abc123",
    currentVersion: "1.0.0",
    currentBranch: "main",
    currentCommit: "abc123",
    collabStatus: "clean",
    statusText: "",
    isGitRepo: true,
    updateMode: "auto",
    updateStrategy: "hash",
    updateAvailable: false,
    baselineHash: "",
    localModified: false,
    installedAt: "1",
    updatedAt: "1",
    remoteUpdatedAt: "",
    localUpdatedAt: "",
    lastEditor: "",
    lastScannedAt: "1",
    status: "ready",
    installState: "installed",
    installSource: "skilldock",
    enabledState: "enabled",
    scopes: [],
    components: [],
  };
  const deferredRefresh: { resolve?: (plugins: PluginSummary[]) => void } = {};
  const branchSpy = vi.spyOn(skillClient, "fetchGitRepoBranches").mockResolvedValue([
    { name: "main", isDefault: true, isSelected: true },
  ]);
  const probeSpy = vi.spyOn(skillClient, "probePluginSourceCandidates").mockResolvedValue([
    {
      tool: "cursor",
      compatibleHostTools: ["cursor"],
      kind: "plugin-repo",
      manifestName: "raisely",
      name: "Raisely",
      description: "Connect Cursor to Raisely.",
      pluginRoot: "/tmp/raisely",
      repoRoot: "/tmp/raisely",
      pluginRelativePath: "",
      manifestPath: "/tmp/raisely/.cursor-plugin/plugin.json",
      marketplaceManifestPath: "",
      components: [],
      sourceType: "git",
      sourceUrl,
      isGitRepo: true,
      gitRoot: "/tmp/raisely",
      confidence: "high",
      installStrategy: "cursor-registration",
      warnings: [],
    },
  ]);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  const fetchInstalledPluginsSpy = vi.spyOn(skillClient, "fetchInstalledPlugins").mockResolvedValue([]);
  const refreshPluginStatesSpy = vi.spyOn(skillClient, "refreshPluginStates").mockImplementationOnce(
    () =>
      new Promise<PluginSummary[]>((resolve) => {
        deferredRefresh.resolve = resolve;
      }),
  );
  const installSpy = vi.spyOn(skillClient, "installSelectedPluginProbes").mockResolvedValue([installedPlugin]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Plugin" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), sourceUrl);
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Git 分支" })).toHaveAttribute("data-value", "main");
  });
  await userEvent.click(screen.getByRole("button", { name: "识别插件" }));
  await screen.findByRole("button", { name: "选择插件 Raisely" });

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "安装到选中宿主" })).toBeEnabled();
  });
  await userEvent.click(screen.getByRole("button", { name: "安装到选中宿主" }));
  await userEvent.click(screen.getByRole("button", { name: /插件/ }));

  await waitFor(() => {
    expect(refreshPluginStatesSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Raisely")).toBeInTheDocument();
    expect(getCachedPlugins()).toEqual([installedPlugin]);
  });
  await act(async () => {
    deferredRefresh.resolve?.([installedPlugin]);
  });

  branchSpy.mockRestore();
  probeSpy.mockRestore();
  fixtureSpy.mockRestore();
  fetchInstalledPluginsSpy.mockRestore();
  refreshPluginStatesSpy.mockRestore();
  installSpy.mockRestore();
});

test("shows MCP marketplace separately from skill-only install methods", async () => {
  window.localStorage.clear();
  resetMcpMarketplaceRuntimeCache();
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("tab", { name: "Git 安装" })).not.toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "本地安装" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "安装源", level: 2 })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "mcp.directory" })).toBeInTheDocument();
  expect(await screen.findByText("playwright")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
});

test("shows store and repository actions in skill marketplace detail", async () => {
  render(<App />);
  await clickNavInstall();

  const workflowHeading = await screen.findByRole("heading", { name: "workflow-critic", level: 3 });
  await userEvent.click(workflowHeading);

  const detailDialog = screen.getByRole("dialog", { name: "workflow-critic 详情" });
  expect(within(detailDialog).getByRole("link", { name: "查看商店" })).toBeInTheDocument();
  expect(within(detailDialog).getByRole("link", { name: "打开仓库" })).toBeInTheDocument();
  expect(within(detailDialog).getByText("来源 skills.sh · 作者 skills.sh · 731.2K 次下载")).toBeInTheDocument();
  expect(detailDialog.querySelector(".skill-detail-modal__meta")).not.toBeInTheDocument();
});

test("keeps MCP marketplace card and detail metadata consistent", async () => {
  window.localStorage.clear();
  resetMcpMarketplaceRuntimeCache();
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  const context7Heading = await screen.findByRole("heading", { name: "context7", level: 3 });
  const context7Card = context7Heading.closest("article");
  if (!context7Card) {
    throw new Error("context7 marketplace card was not rendered");
  }

  expect(within(context7Card).queryByText("来源: mcp.directory")).not.toBeInTheDocument();
  expect(within(context7Card).getByText("作者: upstash")).toBeInTheDocument();
  expect(within(context7Card).getByText("下载量: 36.7K")).toBeInTheDocument();
  expect(within(context7Card).getByText("分类: AI/ML")).toBeInTheDocument();

  await userEvent.click(context7Heading);

  const detailDialog = screen.getByRole("dialog", { name: "context7 详情" });
  expect(within(detailDialog).getByRole("link", { name: "查看商店" })).toBeInTheDocument();
  expect(within(detailDialog).getByRole("link", { name: "打开仓库" })).toBeInTheDocument();
  expect(within(detailDialog).queryByText("来源: mcp.directory")).not.toBeInTheDocument();
  expect(within(detailDialog).getByText("作者: upstash")).toBeInTheDocument();
  expect(within(detailDialog).getByText("下载量: 36.7K")).toBeInTheDocument();
  expect(within(detailDialog).getByText("分类: AI/ML")).toBeInTheDocument();
});

test("marks MCP marketplace avatars as loaded after image load events", async () => {
  window.localStorage.clear();
  resetMcpMarketplaceRuntimeCache();
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  const context7Heading = await screen.findByRole("heading", { name: "context7", level: 3 });
  const context7Card = context7Heading.closest("article");
  if (!context7Card) {
    throw new Error("context7 marketplace card was not rendered");
  }

  const avatarImage = context7Card.querySelector<HTMLImageElement>("img.install-card__avatar-image");
  if (!avatarImage) {
    throw new Error("context7 avatar image was not rendered");
  }

  fireEvent.load(avatarImage);

  expect(avatarImage).toHaveClass("is-loaded");
  expect(avatarImage.closest(".install-card__avatar")).toHaveClass("install-card__avatar--image-loaded");
});

test("loads and caches MCP install config when opening marketplace detail", async () => {
  window.localStorage.clear();
  resetMcpMarketplaceRuntimeCache();
  const playwrightServer = mcpMarketplaceServerFixtures.find((server) => server.name === "playwright");
  if (!playwrightServer) {
    throw new Error("missing playwright marketplace fixture");
  }

  const marketplaceServerWithoutConfig: McpMarketplaceServer = {
    ...playwrightServer,
    server: null,
  };
  let resolveConfigRequest!: (value: Record<string, unknown> | null) => void;
  const fetchMarketplaceServersSpy = vi
    .spyOn(skillClient, "fetchMcpMarketplaceServers")
    .mockResolvedValue([marketplaceServerWithoutConfig]);
  const installSpy = vi.spyOn(skillClient, "installMcpServerFromMarketplace");
  const fetchConfigSpy = vi
    .spyOn(skillClient, "fetchMcpMarketplaceServerConfig")
    .mockImplementation(() => new Promise<Record<string, unknown> | null>((resolve) => {
      resolveConfigRequest = resolve;
    }));

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  const playwrightHeading = await screen.findByRole("heading", { name: "playwright", level: 3 });
  await userEvent.click(playwrightHeading);

  const detailDialog = screen.getByRole("dialog", { name: "playwright 详情" });
  expect(within(detailDialog).getByText("正在加载安装配置...")).toBeInTheDocument();

  if (typeof resolveConfigRequest !== "function") {
    throw new Error("marketplace config request was not triggered");
  }
  resolveConfigRequest(playwrightServer.server ?? null);

  await waitFor(() => {
    expect(within(detailDialog).getByText(/"command": "npx"/)).toBeInTheDocument();
  });

  await userEvent.click(screen.getByRole("button", { name: "关闭详情" }));
  await userEvent.click(screen.getByRole("heading", { name: "playwright", level: 3 }));

  const reopenedDialog = screen.getByRole("dialog", { name: "playwright 详情" });
  expect(within(reopenedDialog).getByText(/"command": "npx"/)).toBeInTheDocument();
  expect(fetchMarketplaceServersSpy).toHaveBeenCalled();
  expect(fetchConfigSpy).toHaveBeenCalledTimes(1);

  await userEvent.click(screen.getByRole("button", { name: "关闭详情" }));
  const playwrightCard = screen.getByRole("heading", { name: "playwright", level: 3 }).closest("article");
  if (!playwrightCard) {
    throw new Error("playwright marketplace card was not rendered");
  }
  await userEvent.click(within(playwrightCard).getByRole("button", { name: "安装" }));

  await waitFor(() => {
    expect(installSpy).toHaveBeenCalledWith({
      server: expect.objectContaining({
        id: "mcp-directory-playwright",
        server: expect.objectContaining({
          command: "npx",
          args: ["-y", "@playwright/mcp"],
        }),
      }),
    });
  });

  fetchMarketplaceServersSpy.mockRestore();
  installSpy.mockRestore();
  fetchConfigSpy.mockRestore();
});

test("installs MCP marketplace servers into the managed MCP list with apps enabled by default", async () => {
  window.localStorage.clear();
  resetMcpMarketplaceRuntimeCache();
  const installSpy = vi.spyOn(skillClient, "installMcpServerFromMarketplace");
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  const playwrightHeading = await screen.findByRole("heading", { name: "playwright", level: 3 });
  const playwrightCard = playwrightHeading.closest("article");
  if (!playwrightCard) {
    throw new Error("playwright marketplace card was not rendered");
  }

  await userEvent.click(within(playwrightCard).getByRole("button", { name: "安装" }));

  expect(await within(playwrightCard).findByRole("button", { name: "已安装" })).toBeDisabled();
  await waitFor(() => {
    expect(installSpy).toHaveBeenCalledTimes(1);
  });
  await expect(installSpy.mock.results[0]?.value).resolves.toMatchObject({
    servers: expect.arrayContaining([
      expect.objectContaining({
        id: "playwright",
        name: "playwright",
        enabledAppCount: expect.any(Number),
        apps: expect.arrayContaining([
          expect.objectContaining({
            isEnabled: true,
          }),
        ]),
      }),
    ]),
  });
  installSpy.mockRestore();
});

test("refreshes marketplace MCP tools right after install when they are still undiscovered", async () => {
  window.localStorage.clear();
  resetMcpMarketplaceRuntimeCache();
  const installSpy = vi.spyOn(skillClient, "installMcpServerFromMarketplace");
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools");

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  const playwrightHeading = await screen.findByRole("heading", { name: "playwright", level: 3 });
  const playwrightCard = playwrightHeading.closest("article");
  if (!playwrightCard) {
    throw new Error("playwright marketplace card was not rendered");
  }

  await userEvent.click(within(playwrightCard).getByRole("button", { name: "安装" }));

  await waitFor(() => {
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  installSpy.mockRestore();
  refreshSpy.mockRestore();
});

test("stores refreshed MCP workspace after async tools discovery finishes", async () => {
  window.localStorage.clear();
  resetMcpMarketplaceRuntimeCache();
  const installResult = await skillClient.installMcpServerFromMarketplace({
    server: mcpMarketplaceServerFixtures.find((server) => server.name === "playwright")!,
  });
  const refreshedWorkspace = await skillClient.refreshMcpServerTools("playwright");
  const installSpy = vi.spyOn(skillClient, "installMcpServerFromMarketplace").mockResolvedValue(installResult);
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools").mockResolvedValue(refreshedWorkspace);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  const playwrightHeading = await screen.findByRole("heading", { name: "playwright", level: 3 });
  const playwrightCard = playwrightHeading.closest("article");
  if (!playwrightCard) {
    throw new Error("playwright marketplace card was not rendered");
  }

  await userEvent.click(within(playwrightCard).getByRole("button", { name: "安装" }));

  await waitFor(() => {
    expect(refreshSpy).toHaveBeenCalledWith("playwright");
    expect(getCachedMcpWorkspace()?.servers.find((server) => server.id === "playwright")).toEqual(
      expect.objectContaining(
        refreshedWorkspace.servers.find((server) => server.id === "playwright") ?? {},
      ),
    );
  });

  installSpy.mockRestore();
  refreshSpy.mockRestore();
});

test("clears installed MCP badge after the server is deleted from the MCP page", async () => {
  window.localStorage.clear();
  resetMcpMarketplaceRuntimeCache();
  const baseWorkspace = await skillClient.fetchMcpWorkspace();
  const playwrightServer = mcpMarketplaceServerFixtures.find((server) => server.name === "playwright");
  if (!playwrightServer) {
    throw new Error("missing playwright marketplace fixture");
  }
  const installedWorkspace = await skillClient.refreshMcpServerTools("playwright");
  const deletedWorkspace = {
    ...installedWorkspace,
    servers: installedWorkspace.servers.filter((server) => server.id !== "playwright"),
  };
  const fetchWorkspaceSpy = vi.spyOn(skillClient, "fetchMcpWorkspace");
  fetchWorkspaceSpy
    .mockResolvedValueOnce(baseWorkspace)
    .mockResolvedValueOnce(installedWorkspace);
  const deleteMcpServerSpy = vi.spyOn(skillClient, "deleteMcpServer").mockResolvedValue(deletedWorkspace);

  render(<App />);

  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  const playwrightHeading = await screen.findByRole("heading", { name: "playwright", level: 3 });
  const playwrightCard = playwrightHeading.closest("article");
  if (!playwrightCard) {
    throw new Error("playwright marketplace card was not rendered");
  }

  await userEvent.click(within(playwrightCard).getByRole("button", { name: "安装" }));
  expect(await within(playwrightCard).findByRole("button", { name: "已安装" })).toBeDisabled();

  await userEvent.click(within(screen.getByLabelText("Primary")).getByRole("button", { name: "MCP" }));
  const expandButton = await screen.findByRole("button", { name: "展开 playwright" });
  await userEvent.click(expandButton);
  await userEvent.click(screen.getByRole("button", { name: "删除 playwright" }));
  await userEvent.click(screen.getByRole("button", { name: "确认 playwright" }));

  await waitFor(() => {
    expect(screen.queryByText("playwright")).not.toBeInTheDocument();
  });

  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  const playwrightHeadingAfterDelete = await screen.findByRole("heading", { name: "playwright", level: 3 });
  const playwrightCardAfterDelete = playwrightHeadingAfterDelete.closest("article");
  if (!playwrightCardAfterDelete) {
    throw new Error("playwright marketplace card was not rendered after delete");
  }

  await waitFor(() => {
    expect(within(playwrightCardAfterDelete).getByRole("button", { name: "安装" })).toBeEnabled();
  });

  fetchWorkspaceSpy.mockRestore();
  deleteMcpServerSpy.mockRestore();
});

test("searches MCP marketplace and restores browse pagination after clearing query", async () => {
  window.localStorage.clear();
  resetMcpMarketplaceRuntimeCache();
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  expect(await screen.findByText("context7")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();

  const searchInput = screen.getByRole("searchbox", { name: "搜索 MCP" });
  await userEvent.type(searchInput, "playwright");

  await waitFor(() => {
    expect(screen.getByText("playwright")).toBeInTheDocument();
    expect(screen.queryByText("context7")).not.toBeInTheDocument();
  });
  expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();

  await userEvent.clear(searchInput);

  await waitFor(() => {
    expect(screen.getByText("context7")).toBeInTheDocument();
  });

  scrollMarketInstallToBottom();

  expect(await screen.findByText("已加载全部 MCP")).toBeInTheDocument();
});

test("loads appended MCP marketplace avatars eagerly after scrolling", async () => {
  window.localStorage.clear();
  resetMcpMarketplaceRuntimeCache();
  const pagedServers = Array.from({ length: 25 }, (_, index) => ({
    ...mcpMarketplaceServerFixtures[0],
    id: `mcp-directory-server-${index + 1}`,
    name: `server-${index + 1}`,
    sourceUrl: `https://github.com/demo/server-${index + 1}`,
    marketplaceUrl: `https://mcp.directory/servers/server-${index + 1}`,
    avatarUrl: `https://github.com/demo-${index + 1}.png`,
  }));
  const fetchMcpMarketplaceServersSpy = vi
    .spyOn(skillClient, "fetchMcpMarketplaceServers")
    .mockImplementation(async ({ page = 1, limit = 24 }) => {
      const startIndex = (page - 1) * limit;
      return pagedServers.slice(startIndex, startIndex + limit);
    });

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  expect(await screen.findByRole("heading", { name: "server-1", level: 3 })).toBeInTheDocument();

  scrollMarketInstallToBottom();

  const serverHeading = await screen.findByRole("heading", { name: "server-25", level: 3 });
  const serverCard = serverHeading.closest("article");
  if (!serverCard) {
    throw new Error("server-25 marketplace card was not rendered");
  }

  const avatarImage = serverCard.querySelector<HTMLImageElement>("img.install-card__avatar-image");
  if (!avatarImage) {
    throw new Error("server-25 avatar image was not rendered");
  }

  expect(avatarImage).toHaveAttribute("loading", "eager");

  fireEvent.load(avatarImage);

  expect(avatarImage).toHaveClass("is-loaded");
  const cachedPayload = JSON.parse(window.localStorage.getItem("skilldock.mcpMarketplaceCache") ?? "{}");
  expect(Object.keys(cachedPayload.pages ?? {})).toEqual(["1"]);
  expect(JSON.stringify(cachedPayload)).not.toContain("server-25");
  fetchMcpMarketplaceServersSpy.mockRestore();
});

test("keeps the current MCP list visible until pending search results return", async () => {
  window.localStorage.clear();
  resetMcpMarketplaceRuntimeCache();
  const originalFetchMcpMarketplaceServers = skillClient.fetchMcpMarketplaceServers;
  let resolvePendingSearch: ((value: McpMarketplaceServer[]) => void) | null = null;
  const fetchMcpMarketplaceServersSpy = vi
    .spyOn(skillClient, "fetchMcpMarketplaceServers")
    .mockImplementation((input) => {
      if (input.query === "playwright") {
        return new Promise((resolve) => {
          resolvePendingSearch = resolve;
        });
      }
      return originalFetchMcpMarketplaceServers(input);
    });

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  expect(await screen.findByText("context7")).toBeInTheDocument();

  const searchInput = screen.getByRole("searchbox", { name: "搜索 MCP" });
  await userEvent.type(searchInput, "playwright");

  await waitFor(() => {
    expect(fetchMcpMarketplaceServersSpy).toHaveBeenCalledWith(expect.objectContaining({ query: "playwright" }));
  });

  expect(screen.getByText("context7")).toBeInTheDocument();
  expect(screen.queryByText("正在搜索 MCP")).not.toBeInTheDocument();

  const finishPendingSearch = resolvePendingSearch as ((value: McpMarketplaceServer[]) => void) | null;
  if (!finishPendingSearch) {
    throw new Error("pending MCP marketplace search was not triggered");
  }
  finishPendingSearch(mcpMarketplaceServerFixtures.filter((server) => server.name === "playwright"));

  await waitFor(() => {
    expect(screen.getByText("playwright")).toBeInTheDocument();
    expect(screen.queryByText("context7")).not.toBeInTheDocument();
  });

  fetchMcpMarketplaceServersSpy.mockRestore();
});

test("keeps the current skill list visible until pending search results return", async () => {
  window.localStorage.clear();
  const originalFetchMarketplaceSkillsByPage = skillClient.fetchMarketplaceSkillsByPage;
  let resolvePendingSearch: ((value: MarketplaceSkill[]) => void) | null = null;
  const fetchMarketplaceSkillsByPageSpy = vi
    .spyOn(skillClient, "fetchMarketplaceSkillsByPage")
    .mockImplementation((input) => {
      if (input.query === "find") {
        return new Promise((resolve) => {
          resolvePendingSearch = resolve;
        });
      }
      return originalFetchMarketplaceSkillsByPage(input);
    });

  render(<App />);
  await clickNavInstall();

  expect(await screen.findByText("workflow-critic")).toBeInTheDocument();

  const searchInput = screen.getByRole("searchbox", { name: "搜索 skill" });
  await userEvent.type(searchInput, "find");

  await waitFor(() => {
    expect(fetchMarketplaceSkillsByPageSpy).toHaveBeenCalledWith(expect.objectContaining({ query: "find" }));
  });

  expect(screen.getByText("workflow-critic")).toBeInTheDocument();
  expect(screen.queryByText("正在搜索可安装技能")).not.toBeInTheDocument();

  const finishPendingSearch = resolvePendingSearch as ((value: MarketplaceSkill[]) => void) | null;
  if (!finishPendingSearch) {
    throw new Error("pending skill marketplace search was not triggered");
  }
  finishPendingSearch(marketplaceSkillFixtures.filter((skill) => skill.name === "workflow-critic"));

  await waitFor(() => {
    expect(screen.getByText("workflow-critic")).toBeInTheDocument();
    expect(screen.queryByText("正在搜索可安装技能")).not.toBeInTheDocument();
  });

  fetchMarketplaceSkillsByPageSpy.mockRestore();
});

test("reuses cached MCP marketplace results when switching away and back", async () => {
  window.localStorage.clear();
  resetMcpMarketplaceRuntimeCache();
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  expect(await screen.findByText("context7")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: "Skill" }));
  expect(screen.getByRole("searchbox", { name: "搜索 skill" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  expect(screen.getByText("context7")).toBeInTheDocument();
  expect(screen.queryByText("正在搜索 MCP")).not.toBeInTheDocument();
});

test("hydrates MCP marketplace from persisted cache on first open", async () => {
  window.localStorage.clear();
  window.localStorage.setItem(
    "skilldock.mcpMarketplaceCache",
    JSON.stringify({
      version: 2,
      timestamp: 0,
      pages: {
        "1": mcpMarketplaceServerFixtures,
      },
    }),
  );

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  expect(screen.getByText("context7")).toBeInTheDocument();
  expect(screen.queryByText("正在搜索 MCP")).not.toBeInTheDocument();

  await waitFor(() => {
    expect(screen.getByRole("tab", { name: "mcp.directory" })).toBeInTheDocument();
  });
});

test("prefetches GitHub source links and reuses the in-flight request on click", async () => {
  window.localStorage.clear();
  resetMcpMarketplaceRuntimeCache();
  let resolveSourceUrl!: (value: string) => void;
  const fetchSpy = vi
    .spyOn(skillClient, "fetchMcpMarketplaceServers")
    .mockResolvedValue(
      mcpMarketplaceServerFixtures.map((server) => ({
        ...server,
        sourceUrl: server.marketplaceUrl ?? server.sourceUrl,
      })),
    );
  const resolveSpy = vi
    .spyOn(skillClient, "resolveMcpMarketplaceSourceUrl")
    .mockImplementation((server) => {
      if (server.name !== "context7") {
        return Promise.resolve(server.sourceUrl);
      }

      return new Promise<string>((resolve) => {
        resolveSourceUrl = resolve;
      });
    });
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  const sourceLink = await screen.findByRole("link", { name: "打开 context7 仓库" });
  await waitFor(() => {
    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({
      name: "context7",
      sourceUrl: "https://mcp.directory/servers/context7",
    }));
  });
  await userEvent.click(sourceLink);

  const prefetchedServerCount = mcpMarketplaceServerFixtures.length;
  expect(fetchSpy).toHaveBeenCalled();
  expect(resolveSpy).toHaveBeenCalledTimes(prefetchedServerCount);
  expect(openSpy).not.toHaveBeenCalled();

  resolveSourceUrl("https://github.com/upstash/context7");
  await waitFor(() => {
    expect(resolveSpy).toHaveBeenCalledTimes(prefetchedServerCount);
    expect(openSpy).toHaveBeenCalledWith(
      "https://github.com/upstash/context7",
      "_blank",
      "noopener,noreferrer",
    );
  });

  fetchSpy.mockRestore();
  resolveSpy.mockRestore();
  openSpy.mockRestore();
});

test("discovers repo skills and allows multi-select install", async () => {
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));

  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), "https://github.com/team/skill-repo");
  await userEvent.click(screen.getByRole("button", { name: "识别仓库技能" }));

  expect(screen.getByRole("button", { name: "检查中..." })).toBeDisabled();
  expect(await screen.findByText("发现 2 个技能，请选择要安装的技能")).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Git 仓库地址" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "安装选中技能" })).toBeInTheDocument();
  expect(screen.getByText("service-observer")).toBeInTheDocument();
  expect(screen.getByText("release-scribe")).toBeInTheDocument();
  expect(screen.queryByText("skills/service-observer")).not.toBeInTheDocument();
  expect(screen.queryByText("skills/release-scribe")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "返回" }));
  expect(screen.getByRole("textbox", { name: "Git 仓库地址" })).toBeInTheDocument();
});

test("filters discovered repo skills by name and description", async () => {
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));

  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), "https://github.com/team/skill-repo");
  await userEvent.click(screen.getByRole("button", { name: "识别仓库技能" }));

  expect(await screen.findByText("发现 2 个技能，请选择要安装的技能")).toBeInTheDocument();
  const searchInput = screen.getByRole("searchbox", { name: "搜索仓库技能" });

  await userEvent.type(searchInput, "service");
  expect(screen.getByText("service-observer")).toBeInTheDocument();
  expect(screen.queryByText("release-scribe")).not.toBeInTheDocument();

  await userEvent.clear(searchInput);
  await userEvent.type(searchInput, "发布纪要");
  expect(screen.queryByText("service-observer")).not.toBeInTheDocument();
  expect(screen.getByText("release-scribe")).toBeInTheDocument();

  await userEvent.clear(searchInput);
  await userEvent.type(searchInput, "missing");
  expect(screen.getByText("暂无匹配的技能")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
});

test("selects and deselects visible repo skills from git install search results", async () => {
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));

  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), "https://github.com/team/skill-repo");
  await userEvent.click(screen.getByRole("button", { name: "识别仓库技能" }));

  expect(await screen.findByText("发现 2 个技能，请选择要安装的技能")).toBeInTheDocument();
  const searchInput = screen.getByRole("searchbox", { name: "搜索仓库技能" });
  await userEvent.type(searchInput, "service");

  await userEvent.click(screen.getByRole("button", { name: "全选" }));
  expect(screen.getByRole("button", { name: "取消全选" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /service-observer/i })).toHaveClass("is-selected");

  await userEvent.clear(searchInput);
  expect(screen.getByRole("button", { name: "全选" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /service-observer/i })).toHaveClass("is-selected");
  expect(screen.getByRole("button", { name: /release-scribe/i })).not.toHaveClass("is-selected");

  await userEvent.click(screen.getByRole("button", { name: "全选" }));
  expect(screen.getByRole("button", { name: "取消全选" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /release-scribe/i })).toHaveClass("is-selected");

  await userEvent.click(screen.getByRole("button", { name: "取消全选" }));
  expect(screen.getByRole("button", { name: /service-observer/i })).not.toHaveClass("is-selected");
  expect(screen.getByRole("button", { name: /release-scribe/i })).not.toHaveClass("is-selected");
});

test("keeps the git install selection page open after installing selected repo skills", async () => {
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));

  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), "https://github.com/team/skill-repo");
  await userEvent.click(screen.getByRole("button", { name: "识别仓库技能" }));

  expect(await screen.findByText("发现 2 个技能，请选择要安装的技能")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /service-observer/i }));
  await userEvent.click(screen.getByRole("button", { name: "安装选中技能" }));

  expect(await screen.findByText("选中技能已安装")).toBeInTheDocument();
  expect(screen.getByText("release-scribe")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Git 仓库地址" })).not.toBeInTheDocument();
});

test("installs a local skill from a typed path", async () => {
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "本地安装" }));
  await userEvent.click(screen.getByRole("tab", { name: "手动安装" }));

  expect(screen.queryByRole("dialog", { name: "手动安装本地 skill" })).not.toBeInTheDocument();
  await userEvent.type(screen.getByRole("textbox", { name: "本地 skill 路径" }), "/Users/demo/skills/local-helper");
  await userEvent.type(screen.getByRole("textbox", { name: "技能名称（可选）" }), "local-helper");
  await userEvent.click(screen.getByRole("button", { name: "安装技能" }));

  expect(await screen.findByText("本地技能已安装")).toBeInTheDocument();
});

test("discovers local project skills and allows multi-select install", async () => {
  const discoverSpy = vi.spyOn(skillClient, "discoverLocalInstallSkills");
  const installSpy = vi.spyOn(skillClient, "installSelectedLocalSkills");

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "本地安装" }));
  await userEvent.click(screen.getByRole("tab", { name: "手动安装" }));

  await userEvent.type(
    screen.getByRole("textbox", { name: "本地 skill 路径" }),
    "/Users/demo/projects/skill-pack",
  );
  await userEvent.click(screen.getByRole("button", { name: "安装技能" }));

  expect(await screen.findByText("发现 2 个技能，请选择要安装的技能")).toBeInTheDocument();
  expect(screen.getByText("service-observer")).toBeInTheDocument();
  expect(screen.getByText("release-scribe")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /service-observer/i }));
  await userEvent.click(screen.getByRole("button", { name: /release-scribe/i }));
  await userEvent.click(screen.getByRole("button", { name: "安装选中技能" }));

  await waitFor(() => {
    expect(discoverSpy).toHaveBeenCalledWith("/Users/demo/projects/skill-pack");
    expect(installSpy).toHaveBeenCalledWith({
      localPath: "/Users/demo/projects/skill-pack",
      selectedPaths: ["skills/service-observer", "skills/release-scribe"],
    });
  });
  expect(await screen.findByText("选中本地技能已安装")).toBeInTheDocument();
  discoverSpy.mockRestore();
  installSpy.mockRestore();
});

test("fills local skill path from a dropped file", async () => {
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "本地安装" }));
  await userEvent.click(screen.getByRole("tab", { name: "手动安装" }));

  const dropzone = screen.getByText("拖拽文件夹或压缩包到此处").closest(".local-install-dropzone");
  expect(dropzone).toBeInTheDocument();

  const droppedFile = new File([""], "local-helper.skill");
  Object.defineProperty(droppedFile, "path", { value: "/Users/demo/skills/local-helper.skill" });

  fireEvent.dragEnter(dropzone!);
  expect(dropzone).toHaveClass("is-dragging");

  fireEvent.drop(dropzone!, { dataTransfer: { files: [droppedFile] } });
  expect(screen.getByRole("textbox", { name: "本地 skill 路径" })).toHaveValue(
    "/Users/demo/skills/local-helper.skill",
  );
  expect(dropzone).toHaveTextContent("已选择:/Users/demo/skills/local-helper.skill");
  expect(dropzone).not.toHaveClass("is-dragging");
});

test("shows install errors in the global notification stack", async () => {
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));

  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), "invalid-url");
  await userEvent.click(screen.getByRole("button", { name: "识别仓库技能" }));

  expect(screen.getByRole("alert")).toHaveTextContent("请输入有效的 Git 仓库地址。");
});

test("accepts scp-like SSH repository urls for skill git install", async () => {
  const sourceUrl = "git@git.example.com:example-org/example-repo.git";
  const branchSpy = vi.spyOn(skillClient, "fetchGitRepoBranches").mockResolvedValue([
    { name: "main", isDefault: true, isSelected: true },
  ]);
  const discoverSpy = vi.spyOn(skillClient, "installSkillFromRepo").mockResolvedValue([]);

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));

  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), sourceUrl);
  await waitFor(() => {
    expect(branchSpy).toHaveBeenCalledWith({ repoUrl: sourceUrl });
  });
  await userEvent.click(screen.getByRole("button", { name: "识别仓库技能" }));

  await waitFor(() => {
    expect(discoverSpy).toHaveBeenCalledWith({ repoUrl: sourceUrl, gitRef: "main" });
  });
  expect(screen.queryByText("请输入有效的 Git 仓库地址。")).not.toBeInTheDocument();
  branchSpy.mockRestore();
  discoverSpy.mockRestore();
});

test("marks already installed repo skills as unavailable", async () => {
  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));

  await userEvent.type(
    screen.getByRole("textbox", { name: "Git 仓库地址" }),
    "https://github.com/team/duplicate-skill-repo",
  );
  await userEvent.click(screen.getByRole("button", { name: "识别仓库技能" }));

  expect(await screen.findByText("发现 2 个技能，请选择要安装的技能")).toBeInTheDocument();
  expect(screen.getByText("已安装")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /drawio-diagram/i })).toBeDisabled();
  expect(screen.getByRole("button", { name: /service-observer/i })).not.toBeDisabled();
});

test("searches marketplace skills across all supported sources", async () => {
  render(<App />);
  await clickNavInstall();

  const searchInput = screen.getByRole("searchbox", { name: "搜索 skill" });
  await userEvent.type(searchInput, "guardian");

  expect(await screen.findByText("release-guardian")).toBeInTheDocument();
  expect(screen.getByText("repo-guardian")).toBeInTheDocument();
});

test("sorts marketplace search results by popularity across sources", async () => {
  render(<App />);
  await clickNavInstall();

  await userEvent.type(screen.getByRole("searchbox", { name: "搜索 skill" }), "skills");

  await waitFor(() => {
    expect(screen.getAllByRole("heading", { level: 3 }).map((item) => item.textContent)).toEqual([
      "workflow-critic",
      "release-guardian",
      "design-system-reviewer",
      "repo-guardian",
    ]);
  });
});

test("keeps source results isolated and preserves the skills.sh display order", async () => {
  render(<App />);
  await clickNavInstall();

  const skillsShCards = screen
    .getAllByRole("heading", { level: 3 })
    .map((item) => item.textContent);
  expect(skillsShCards).toEqual(["workflow-critic", "design-system-reviewer"]);

  await userEvent.click(screen.getByRole("tab", { name: "skillsmp" }));

  const skillsMpCards = await screen.findAllByRole("heading", { level: 3 });
  expect(skillsMpCards.map((item) => item.textContent)).toEqual(["release-guardian", "repo-guardian"]);
  expect(screen.queryByText("workflow-critic")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: "skills.sh" }));
  expect(screen.getAllByRole("heading", { level: 3 }).map((item) => item.textContent)).toEqual([
    "workflow-critic",
    "design-system-reviewer",
  ]);
});

test("loads the next marketplace page after a refresh finishes at the scroll bottom", async () => {
  const firstPage = Array.from({ length: 18 }, (_, index): MarketplaceSkill => ({
    ...marketplaceSkillFixtures[0],
    id: `skillhub-first-${index + 1}`,
    name: `skillhub-first-${index + 1}`,
    sourceSite: "skillhub",
  }));
  const secondPageSkill: MarketplaceSkill = {
    ...marketplaceSkillFixtures[0],
    id: "skillhub-second-page",
    name: "skillhub-second-page",
    sourceSite: "skillhub",
  };
  let resolveRefresh: ((skills: MarketplaceSkill[]) => void) | undefined;
  const fetchMarketplaceSkillsByPageSpy = vi
    .spyOn(skillClient, "fetchMarketplaceSkillsByPage")
    .mockImplementation((input) => {
      if (input.sourceSite !== "skillhub") {
        return Promise.resolve([]);
      }
      if (input.page === 2) {
        return Promise.resolve([secondPageSkill]);
      }
      if (input.refresh) {
        return new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      }
      return Promise.resolve(firstPage);
    });

  render(<App />);
  await clickNavInstall();
  await userEvent.click(screen.getByRole("tab", { name: "skillhub" }));

  expect(await screen.findByRole("heading", { name: "skillhub-first-18", level: 3 })).toBeInTheDocument();
  await waitFor(() => {
    expect(resolveRefresh).toBeTypeOf("function");
  });

  scrollMarketInstallToBottom();
  expect(fetchMarketplaceSkillsByPageSpy).not.toHaveBeenCalledWith(expect.objectContaining({
    sourceSite: "skillhub",
    page: 2,
  }));

  await act(async () => {
    resolveRefresh?.(firstPage);
  });

  expect(await screen.findByRole("heading", { name: "skillhub-second-page", level: 3 })).toBeInTheDocument();
  expect(fetchMarketplaceSkillsByPageSpy).toHaveBeenCalledWith({
    sourceSite: "skillhub",
    page: 2,
    limit: 18,
  });

  fetchMarketplaceSkillsByPageSpy.mockRestore();
});
