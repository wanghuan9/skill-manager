import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { App } from "@/app/App";
import { resetMcpAutoProbeRuntimeForTests } from "@/app/routes/mcp";
import * as skillClient from "@/features/skills/api/skill-client";
import { formatSkillUpdatedAt } from "@/features/skills/utils/skill-time";

beforeEach(() => {
  window.localStorage.clear();
  delete (window as Window & { __SKILLM_MCP_WORKSPACE__?: unknown }).__SKILLM_MCP_WORKSPACE__;
  skillClient.resetMcpImportSessionForTests();
  resetMcpAutoProbeRuntimeForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("renders MCP toolbar in the page header and hides the app matrix", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));

  const toolbar = await screen.findByLabelText("MCP 工具栏");
  expect(toolbar).toBeInTheDocument();
  expect(toolbar.closest(".page-header__row")).not.toBeNull();
  expect(await screen.findByText(/扫描、编辑并同步 \d+ 个工具的 MCP 配置/)).toBeInTheDocument();
  expect(screen.queryByLabelText("MCP 目标软件")).not.toBeInTheDocument();
  expect(toolbar).not.toHaveTextContent("工具可同步");
  expect(screen.getByRole("searchbox", { name: "搜索 MCP" })).toBeInTheDocument();
  const batchModeButton = within(toolbar).getByRole("button", { name: "批量选择" });
  const refreshButton = within(toolbar).getByRole("button", { name: "刷新" });
  expect(batchModeButton.compareDocumentPosition(refreshButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const goInstallButton = within(toolbar).getByRole("button", { name: "去安装" });
  expect(goInstallButton).toHaveClass("skills-toolbar-button--go-install");
  expect(toolbar.lastElementChild).toBe(goInstallButton);
});

test("batch enables the selected MCP across supported installed apps", async () => {
  const toggleSpy = vi.spyOn(skillClient, "toggleMcpServerApp");
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await userEvent.click(await screen.findByRole("button", { name: "批量选择" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "选择 MCP context7" }));

  const enableButton = screen.getByRole("button", { name: "启用 1 个" });
  expect(screen.getByLabelText("批量操作")).toHaveTextContent("已选 1 个");
  await userEvent.click(enableButton);

  await waitFor(() => {
    expect(toggleSpy).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "context7",
      enabled: true,
    }));
  });
  await waitFor(() => {
    expect(screen.queryByRole("checkbox", { name: "选择 MCP context7" })).not.toBeInTheDocument();
  });
});

test("shows a confirmation dialog before batch deleting MCP servers", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await userEvent.click(await screen.findByRole("button", { name: "批量选择" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "选择 MCP context7" }));
  await userEvent.click(screen.getByRole("button", { name: "删除 1 个" }));

  expect(screen.getByRole("dialog", { name: "删除 1 个 MCP？" })).toHaveTextContent("此操作无法撤销");
});

test("switches MCP servers to cards, opens details in a dialog, and restores the preference", async () => {
  const firstRender = render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await screen.findByText("context7");
  const context7ListRow = screen.getByRole("button", { name: "展开 context7" }).closest(".mcp-server-card");
  expect(context7ListRow?.querySelector(".mcp-server-card__chevron")).toBeInTheDocument();
  expect(within(context7ListRow as HTMLElement).getByRole("button", {
    name: "已启用 2/11，点击全部启用",
  })).toHaveClass("plugins-page__toggle-icon-button", "is-partial");
  await userEvent.click(screen.getByRole("button", { name: "卡片" }));

  expect(document.querySelector(".mcp-server-list")).toHaveClass("tool-card-grid");
  expect(window.localStorage.getItem("mcp:view-mode")).toBe("grid");
  const context7Card = screen.getByRole("button", { name: "展开 context7" }).closest(".mcp-server-card");
  expect(context7Card?.querySelector(".mcp-server-card__title-row")?.children[1]).toHaveTextContent("2 tools");
  expect(context7Card?.querySelectorAll(".mcp-server-card__grid-meta .skill-card__tool-icon")).toHaveLength(2);
  expect(context7Card?.querySelector(".mcp-server-card__grid-meta > .status-badge")).toHaveTextContent("已启用 2");
  expect(context7Card?.querySelector(".mcp-server-card__actions > .skill-card__grid-source-label"))
    .toHaveTextContent("STDIO");
  expect(within(context7Card as HTMLElement).getByRole("button", {
    name: "已启用 2/11，点击全部启用",
  })).toHaveClass("plugins-page__toggle-icon-button", "is-partial");
  expect(context7Card?.querySelector(".mcp-server-card__chevron")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "展开 context7" }));
  const detailDialog = screen.getByRole("dialog", { name: "基本信息 context7" });
  expect(detailDialog).toBeInTheDocument();
  expect(within(detailDialog).getByRole("button", { name: "编辑 context7" })).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "基本信息 context7" })).not.toBeInTheDocument();

  firstRender.unmount();
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await screen.findByText("context7");
  expect(document.querySelector(".mcp-server-list")).toHaveClass("tool-card-grid");
});

test("opens MCP install page from the toolbar go-install action", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  const toolbar = await screen.findByLabelText("MCP 工具栏");
  await userEvent.click(within(toolbar).getByRole("button", { name: "去安装" }));

  expect(screen.getByRole("heading", { name: "安装", level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("heading", { name: "安装源", level: 2 })).toBeInTheDocument();
});

test("guides empty MCP library to scan import before marketplace install", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const fetchSpy = vi.spyOn(skillClient, "fetchMcpWorkspace").mockResolvedValue({
    ...workspace,
    servers: [],
  });

  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));

  const emptyHeading = await screen.findByRole("heading", { name: "还没有安装 MCP" });
  const emptyState = emptyHeading.closest<HTMLElement>(".empty-state");
  if (!emptyState) {
    throw new Error("missing MCP empty state");
  }
  expect(within(emptyState).getByText("扫描导入已有工具配置，或去商店安装 MCP 服务，之后可在这里统一管理和启用。")).toBeInTheDocument();

  const scanImportButton = within(emptyState).getByRole("button", { name: "扫描导入" });
  const marketplaceButton = within(emptyState).getByRole("button", { name: "去商店安装" });
  expect(Boolean(scanImportButton.compareDocumentPosition(marketplaceButton) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

  await userEvent.click(marketplaceButton);

  expect(screen.getByRole("heading", { name: "安装", level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("heading", { name: "安装源", level: 2 })).toBeInTheDocument();

  fetchSpy.mockRestore();
});

test("refreshes MCP workspace from the toolbar", async () => {
  window.localStorage.clear();
  const fetchSpy = vi.spyOn(skillClient, "fetchMcpWorkspace");
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await screen.findByText("context7");

  fetchSpy.mockClear();
  const refreshButton = screen.getByRole("button", { name: "刷新" });
  await userEvent.click(refreshButton);

  await waitFor(() => {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

test("refresh button stays locked until failed or undiscovered MCP tools reprobe finishes", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const undiscoveredWorkspace = {
    ...workspace,
    servers: workspace.servers.map((server) => (
      server.id === "canva"
        ? {
            ...server,
            tools: [],
            toolsDiscoveredAt: "",
            toolsDiscoveryError: "",
          }
        : server
    )),
  };
  let resolveRefresh: ((snapshot: typeof undiscoveredWorkspace) => void) | undefined;
  const fetchSpy = vi
    .spyOn(skillClient, "fetchMcpWorkspace")
    .mockResolvedValueOnce(workspace)
    .mockResolvedValue(undiscoveredWorkspace);
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
  );
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await screen.findByText("context7");

    const refreshButton = screen.getByRole("button", { name: "刷新" });
    await userEvent.click(refreshButton);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
      expect(refreshButton).toBeDisabled();
    });

    resolveRefresh?.(undiscoveredWorkspace);

    await waitFor(() => {
      expect(refreshButton).toBeEnabled();
    });
  } finally {
    fixtureSpy.mockRestore();
    refreshSpy.mockRestore();
    fetchSpy.mockRestore();
  }
});

test("refresh retries failed MCP tools discovery only", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const failedWorkspace = {
    ...workspace,
    servers: workspace.servers.map((server) => (
      server.id === "linear"
        ? {
            ...server,
            tools: [],
            toolsDiscoveredAt: "2026/5/10 22:39:32",
            toolsDiscoveryError: "MCP tools 探测超时",
          }
        : server
    )),
  };
  const fetchSpy = vi
    .spyOn(skillClient, "fetchMcpWorkspace")
    .mockResolvedValue(workspace)
    .mockResolvedValueOnce(workspace)
    .mockResolvedValueOnce(failedWorkspace);
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools").mockResolvedValue(failedWorkspace);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await screen.findByText("context7");

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledWith("linear");
    });
    expect(refreshSpy).not.toHaveBeenCalledWith("context7");
  } finally {
    fixtureSpy.mockRestore();
    refreshSpy.mockRestore();
    fetchSpy.mockRestore();
  }
});

test("imports MCP servers and probes every server that still lacks tools", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const emptyToolsWorkspace = {
    ...workspace,
    servers: workspace.servers.map((server) => (
      server.id === "context7" || server.id === "linear"
        ? {
            ...server,
            tools: [],
            toolsDiscoveredAt: "",
            toolsDiscoveryError: "",
          }
        : server
    )),
  };
  const importSpy = vi.spyOn(skillClient, "importMcpServersFromApps").mockResolvedValueOnce(0);
  const fetchSpy = vi
    .spyOn(skillClient, "fetchMcpWorkspace")
    .mockResolvedValue(emptyToolsWorkspace)
    .mockResolvedValueOnce(emptyToolsWorkspace);
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools").mockResolvedValue(emptyToolsWorkspace);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await userEvent.click(await screen.findByRole("button", { name: "扫描导入" }));

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledWith("context7");
      expect(refreshSpy).toHaveBeenCalledWith("linear");
    });
  } finally {
    fixtureSpy.mockRestore();
    refreshSpy.mockRestore();
    fetchSpy.mockRestore();
    importSpy.mockRestore();
  }
});

test("automatically scan imports when the MCP workspace is empty", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const emptyWorkspace = {
    ...workspace,
    storageInitialized: true,
    servers: [],
  };
  const importedWorkspace = {
    ...workspace,
    storageInitialized: true,
  };
  let resolveImport: ((count: number) => void) | undefined;
  const fetchSpy = vi
    .spyOn(skillClient, "fetchMcpWorkspace")
    .mockResolvedValueOnce(emptyWorkspace)
    .mockResolvedValue(importedWorkspace);
  const importSpy = vi.spyOn(skillClient, "importMcpServersFromApps").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
  );
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools").mockResolvedValue(importedWorkspace);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));

    await waitFor(() => {
      expect(importSpy).toHaveBeenCalledTimes(1);
      expect(within(screen.getByLabelText("MCP 工具栏")).getByRole("button", { name: "扫描中..." })).toBeDisabled();
    });

    const finishImport = resolveImport;
    if (!finishImport) {
      throw new Error("auto import handler was not called");
    }
    finishImport(1);

    expect(await screen.findByText("context7")).toBeInTheDocument();
    expect(refreshSpy).not.toHaveBeenCalled();
  } finally {
    fixtureSpy.mockRestore();
    refreshSpy.mockRestore();
    importSpy.mockRestore();
    fetchSpy.mockRestore();
  }
});

test("does not automatically scan import again during the empty MCP cooldown", async () => {
  window.localStorage.clear();
  window.localStorage.setItem("skilldock.mcp.emptyAutoImportLastAttemptAt", String(Date.now()));
  const workspace = await skillClient.fetchMcpWorkspace();
  const emptyWorkspace = {
    ...workspace,
    storageInitialized: true,
    servers: [],
  };
  const fetchSpy = vi.spyOn(skillClient, "fetchMcpWorkspace").mockResolvedValue(emptyWorkspace);
  const importSpy = vi.spyOn(skillClient, "importMcpServersFromApps").mockResolvedValue(0);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));

    expect(await screen.findByRole("heading", { name: "还没有安装 MCP" })).toBeInTheDocument();
    expect(importSpy).not.toHaveBeenCalled();
  } finally {
    fixtureSpy.mockRestore();
    importSpy.mockRestore();
    fetchSpy.mockRestore();
  }
});

test("does not auto probe MCP servers that already have tools even when discovered time is missing", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const partialToolsWorkspace = {
    ...workspace,
    servers: workspace.servers.map((server) => (
      server.id === "linear"
        ? {
            ...server,
            tools: server.tools.slice(0, 1),
            toolsDiscoveredAt: "",
            toolsDiscoveryError: "",
          }
        : server
    )),
  };
  const importSpy = vi.spyOn(skillClient, "importMcpServersFromApps").mockResolvedValueOnce(0);
  const fetchSpy = vi
    .spyOn(skillClient, "fetchMcpWorkspace")
    .mockResolvedValue(partialToolsWorkspace)
    .mockResolvedValueOnce(partialToolsWorkspace);
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools").mockResolvedValue(partialToolsWorkspace);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await userEvent.click(await screen.findByRole("button", { name: "扫描导入" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "扫描导入" })).toBeEnabled();
    });
    expect(refreshSpy).not.toHaveBeenCalled();
  } finally {
    fixtureSpy.mockRestore();
    refreshSpy.mockRestore();
    fetchSpy.mockRestore();
    importSpy.mockRestore();
  }
});

test("keeps MCP import progress state when switching away and back", async () => {
  window.localStorage.clear();
  let resolveImport: ((count: number) => void) | undefined;
  const importSpy = vi.spyOn(skillClient, "importMcpServersFromApps").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
  );

  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await screen.findByText("context7");
  const toolbar = await screen.findByLabelText("MCP 工具栏");
  const importButton = within(toolbar).getAllByRole("button")[1];
  await userEvent.click(importButton);

  await waitFor(() => {
    expect(within(toolbar).getByRole("button", { name: "扫描中..." })).toBeDisabled();
  });

  await userEvent.click(screen.getByRole("button", { name: "工具" }));
  await userEvent.click(screen.getByRole("button", { name: "MCP" }));

  await waitFor(() => {
    expect(within(screen.getByLabelText("MCP 工具栏")).getByRole("button", { name: "扫描中..." })).toBeDisabled();
  });

  const finishImport = resolveImport;
  if (!finishImport) {
    throw new Error("import handler was not called");
  }
  finishImport(1);

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "扫描导入" })).toBeEnabled();
  });

  importSpy.mockRestore();
});

test("clears MCP import progress after import completes", async () => {
  const workspace = await skillClient.fetchMcpWorkspace();
  let importListener: ((snapshot: skillClient.McpImportSessionSnapshot) => void) | undefined;
  const importSpy = vi.spyOn(skillClient, "importMcpServersFromApps").mockImplementation(async () => {
    importListener?.({
      isImporting: true,
      progress: {
        appId: "codex",
        appName: "Codex",
        serverId: "context7",
        serverName: "context7",
        importedCount: 1,
        scannedCount: 1,
        phase: "imported",
        changed: true,
        workspace,
      },
    });
    return 1;
  });
  const subscribeSpy = vi
    .spyOn(skillClient, "subscribeMcpImportSessionChange")
    .mockImplementation((listener) => {
      importListener = listener;
      listener(skillClient.getMcpImportSessionSnapshot());
      return () => {
        importListener = undefined;
      };
    });

  try {
    await skillClient.startMcpServersImport();

    expect(skillClient.getMcpImportSessionSnapshot()).toEqual({
      isImporting: false,
      progress: null,
    });
  } finally {
    subscribeSpy.mockRestore();
    importSpy.mockRestore();
  }
});

test("ignores completed MCP import progress snapshots when entering the MCP tab", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const staleProgressWorkspace = {
    ...workspace,
    servers: workspace.servers.map((server) => (
      server.id === "context7"
        ? {
            ...server,
            tools: [],
            toolsDiscoveredAt: "",
            toolsDiscoveryError: "",
          }
        : server
    )),
  };
  const completedImportSnapshot: skillClient.McpImportSessionSnapshot = {
    isImporting: false,
    progress: {
      appId: "codex",
      appName: "Codex",
      serverId: "context7",
      serverName: "context7",
      importedCount: 1,
      scannedCount: 1,
      phase: "hydrated",
      changed: true,
      workspace: staleProgressWorkspace,
    },
  };
  const fetchSpy = vi.spyOn(skillClient, "fetchMcpWorkspace").mockResolvedValue(workspace);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  const subscribeSpy = vi
    .spyOn(skillClient, "subscribeMcpImportSessionChange")
    .mockImplementation((listener) => {
      listener(completedImportSnapshot);
      return () => undefined;
    });

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));

    expect(await screen.findByText("context7")).toBeInTheDocument();
    expect(await screen.findByText("2 tools")).toBeInTheDocument();
    expect(screen.queryByText("工具待探测")).not.toBeInTheDocument();
  } finally {
    subscribeSpy.mockRestore();
    fixtureSpy.mockRestore();
    fetchSpy.mockRestore();
  }
});

test("does not restart undiscovered MCP probing on every import progress workspace update", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const undiscoveredWorkspace = {
    ...workspace,
    servers: workspace.servers.map((server) => (
      server.id === "linear"
        ? {
            ...server,
            tools: [],
            toolsDiscoveredAt: "",
            toolsDiscoveryError: "",
          }
        : server
    )),
  };
  let importListener: ((snapshot: skillClient.McpImportSessionSnapshot) => void) | undefined;
  const importSpy = vi.spyOn(skillClient, "importMcpServersFromApps").mockImplementation(async () => {
    importListener?.({
      isImporting: true,
      progress: {
        appId: "codex",
        appName: "Codex",
        serverId: "linear",
        serverName: "linear",
        importedCount: 1,
        scannedCount: 1,
        phase: "imported",
        changed: true,
        workspace: undiscoveredWorkspace,
      },
    });
    importListener?.({
      isImporting: true,
      progress: {
        appId: "codex",
        appName: "Codex",
        serverId: "filesystem",
        serverName: "filesystem",
        importedCount: 2,
        scannedCount: 2,
        phase: "imported",
        changed: true,
        workspace: undiscoveredWorkspace,
      },
    });
    importListener?.({
      isImporting: false,
      progress: {
        appId: "codex",
        appName: "Codex",
        serverId: "filesystem",
        serverName: "filesystem",
        importedCount: 2,
        scannedCount: 2,
        phase: "hydrated",
        changed: true,
        workspace: undiscoveredWorkspace,
      },
    });
    return 2;
  });
  const fetchSpy = vi.spyOn(skillClient, "fetchMcpWorkspace").mockResolvedValue(undiscoveredWorkspace);
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools").mockResolvedValue(undiscoveredWorkspace);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);
  const subscribeSpy = vi
    .spyOn(skillClient, "subscribeMcpImportSessionChange")
    .mockImplementation((listener) => {
      importListener = listener;
      listener(skillClient.getMcpImportSessionSnapshot());
      return () => {
        importListener = undefined;
      };
    });

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await screen.findByText("context7");

    await userEvent.click(screen.getByRole("button", { name: "扫描导入" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "扫描导入" })).toBeEnabled();
    });

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith("linear");
  } finally {
    subscribeSpy.mockRestore();
    fixtureSpy.mockRestore();
    refreshSpy.mockRestore();
    fetchSpy.mockRestore();
    importSpy.mockRestore();
  }
});

test("shows MCP import scan and update counts separately", async () => {
  window.localStorage.clear();
  const progressWorkspace = await skillClient.fetchMcpWorkspace();
  const importingSnapshot: skillClient.McpImportSessionSnapshot = {
    isImporting: true,
    progress: {
      appId: "codex",
      appName: "Codex",
      serverId: "filesystem",
      serverName: "filesystem",
      importedCount: 0,
      scannedCount: 3,
      phase: "imported",
      changed: false,
      workspace: progressWorkspace,
    },
  };
  const snapshotSpy = vi
    .spyOn(skillClient, "getMcpImportSessionSnapshot")
    .mockReturnValue(importingSnapshot);
  const subscribeSpy = vi
    .spyOn(skillClient, "subscribeMcpImportSessionChange")
    .mockImplementation((listener) => {
      listener(importingSnapshot);
      return () => undefined;
    });

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));

    await waitFor(() => {
      expect(screen.getByText("已扫描 3")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "正在导入 MCP，已扫描 3 项，已导入 0 项" })).toBeDisabled();
    });
  } finally {
    subscribeSpy.mockRestore();
    snapshotSpy.mockRestore();
  }
});

test("auto refreshes existing MCP servers that still lack tools after a repeat scan", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const existingWithoutTools = {
    ...workspace,
    servers: workspace.servers.map((server) => (
      server.id === "linear"
        ? {
            ...server,
            tools: [],
            toolsDiscoveredAt: "",
            toolsDiscoveryError: "",
          }
        : server
    )),
  };
  const importSpy = vi.spyOn(skillClient, "importMcpServersFromApps").mockResolvedValueOnce(0);
  const fetchSpy = vi
    .spyOn(skillClient, "fetchMcpWorkspace")
    .mockResolvedValue(existingWithoutTools);
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools").mockResolvedValue(existingWithoutTools);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await userEvent.click(await screen.findByRole("button", { name: "扫描导入" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "扫描导入" })).toBeEnabled();
      expect(refreshSpy).toHaveBeenCalledWith("linear");
    });
  } finally {
    fixtureSpy.mockRestore();
    refreshSpy.mockRestore();
    fetchSpy.mockRestore();
    importSpy.mockRestore();
  }
});

test("auto refreshes newly installed MCP servers that still show undiscovered tools after page load", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const installedWithoutTools = {
    ...workspace,
    servers: [
      {
        id: "canva",
        name: "canva",
        serverType: "http",
        commandLabel: "https://mcp.canva.com/mcp",
        description: "Canva MCP server",
        sourceUrl: "https://mcp.directory/servers/canva",
        serverJson: JSON.stringify({
          type: "http",
          url: "https://mcp.canva.com/mcp",
        }, null, 2),
        enabledAppCount: 0,
        apps: workspace.apps.map((app) => ({
          appId: app.id,
          appName: app.name,
          configPath: app.configPath,
          statusLabel: app.statusLabel,
          isEnabled: false,
        })),
        tools: [],
        toolsDiscoveredAt: "",
        toolsDiscoveryError: "",
        installedAt: "2026/5/15 13:09:26",
      },
      ...workspace.servers.filter((server) => server.id !== "canva"),
    ],
  };
  const fetchSpy = vi
    .spyOn(skillClient, "fetchMcpWorkspace")
    .mockResolvedValue(installedWithoutTools);
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools").mockResolvedValue(installedWithoutTools);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await screen.findByText("canva");

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledWith("canva");
    });
  } finally {
    fixtureSpy.mockRestore();
    refreshSpy.mockRestore();
    fetchSpy.mockRestore();
  }
});

test("does not probe a marketplace MCP while its app sync is pending", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const pendingWorkspace = {
    ...workspace,
    servers: workspace.servers.map((server) => (
      server.id === "linear"
        ? {
            ...server,
            tools: [],
            toolsDiscoveredAt: "",
            toolsDiscoveryError: "",
            hasPendingSync: true,
          }
        : server
    )),
  };
  const fetchSpy = vi.spyOn(skillClient, "fetchMcpWorkspace").mockResolvedValue(pendingWorkspace);
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools").mockResolvedValue(pendingWorkspace);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await screen.findByText("linear");

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    expect(refreshSpy).not.toHaveBeenCalledWith("linear");
  } finally {
    fixtureSpy.mockRestore();
    refreshSpy.mockRestore();
    fetchSpy.mockRestore();
  }
});

test("does not auto refresh MCP servers that already have tools after page load", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const existingWithToolsMissingTimestamp = {
    ...workspace,
    servers: workspace.servers.map((server) => (
      server.id === "linear"
        ? {
            ...server,
            toolsDiscoveredAt: "",
            toolsDiscoveryError: "",
          }
        : server
    )),
  };
  const fetchSpy = vi
    .spyOn(skillClient, "fetchMcpWorkspace")
    .mockResolvedValue(existingWithToolsMissingTimestamp);
  const refreshSpy = vi
    .spyOn(skillClient, "refreshMcpServerTools")
    .mockResolvedValue(existingWithToolsMissingTimestamp);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await screen.findByText("linear");

    expect(refreshSpy).not.toHaveBeenCalled();
  } finally {
    fixtureSpy.mockRestore();
    refreshSpy.mockRestore();
    fetchSpy.mockRestore();
  }
});

test("retries failed MCP tools discovery after page load", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const failedWorkspace = {
    ...workspace,
    servers: workspace.servers.map((server) => (
      server.id === "linear"
        ? {
            ...server,
            tools: [],
            toolsDiscoveredAt: "2026/5/10 22:39:32",
            toolsDiscoveryError: "MCP tools 探测超时",
          }
        : server
    )),
  };
  const fetchSpy = vi
    .spyOn(skillClient, "fetchMcpWorkspace")
    .mockResolvedValue(failedWorkspace);
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools").mockResolvedValue(failedWorkspace);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await screen.findByText("context7");

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledWith("linear");
    });
  } finally {
    fixtureSpy.mockRestore();
    refreshSpy.mockRestore();
    fetchSpy.mockRestore();
  }
});

test("does not auto reprobe failed MCP tools when switching back to the MCP tab within cooldown", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const failedWorkspace = {
    ...workspace,
    servers: workspace.servers.map((server) => (
      server.id === "linear"
        ? {
            ...server,
            tools: [],
            toolsDiscoveredAt: "2026/5/10 22:39:32",
            toolsDiscoveryError: "MCP tools 探测超时",
          }
        : server
    )),
  };
  const fetchSpy = vi.spyOn(skillClient, "fetchMcpWorkspace").mockResolvedValue(failedWorkspace);
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools").mockResolvedValue(failedWorkspace);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await screen.findByText("context7");

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(refreshSpy).toHaveBeenCalledWith("linear");
    });

    await userEvent.click(screen.getByRole("button", { name: "工具" }));
    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await screen.findByText("context7");

    expect(refreshSpy).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledTimes(2);
    });
  } finally {
    fixtureSpy.mockRestore();
    refreshSpy.mockRestore();
    fetchSpy.mockRestore();
  }
});

test("shows failed tools discovery reason after auto refreshing an undiscovered MCP", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const canvaUndiscovered = {
    ...workspace,
    servers: [
      {
        id: "canva",
        name: "canva",
        serverType: "http",
        commandLabel: "https://mcp.canva.com/mcp",
        description: "Canva MCP server",
        sourceUrl: "https://mcp.directory/servers/canva",
        serverJson: JSON.stringify({
          type: "http",
          url: "https://mcp.canva.com/mcp",
        }, null, 2),
        enabledAppCount: 0,
        apps: workspace.apps.map((app) => ({
          appId: app.id,
          appName: app.name,
          configPath: app.configPath,
          statusLabel: app.statusLabel,
          isEnabled: false,
        })),
        tools: [],
        toolsDiscoveredAt: "",
        toolsDiscoveryError: "",
        installedAt: "2026/5/15 13:09:26",
      },
      ...workspace.servers.filter((server) => server.id !== "canva"),
    ],
  };
  const canvaFailed = {
    ...canvaUndiscovered,
    servers: canvaUndiscovered.servers.map((server) => (
      server.id === "canva"
        ? {
            ...server,
            toolsDiscoveredAt: "2026/5/15 13:16:46",
            toolsDiscoveryError: "MCP tools 探测需要 OAuth 授权，请先在目标工具中完成登录",
          }
        : server
    )),
  };
  const fetchSpy = vi.spyOn(skillClient, "fetchMcpWorkspace").mockResolvedValue(canvaUndiscovered);
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools").mockResolvedValue(canvaFailed);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await userEvent.click(await screen.findByRole("button", { name: "展开 canva" }));

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledWith("canva");
      expect(screen.getByText("获取失败")).toBeInTheDocument();
      expect(screen.getByText("获取 tools 失败：MCP tools 探测需要 OAuth 授权，请先在目标工具中完成登录")).toBeInTheDocument();
    });
  } finally {
    fixtureSpy.mockRestore();
    refreshSpy.mockRestore();
    fetchSpy.mockRestore();
  }
});

test("opens a prefilled feedback issue from MCP import failures", async () => {
  window.localStorage.clear();
  vi.spyOn(skillClient, "importMcpServersFromApps").mockRejectedValueOnce(new Error("Codex MCP 配置解析失败"));
  const feedbackSpy = vi.spyOn(skillClient, "recordFailureFeedback").mockResolvedValueOnce({
    title: "[Bug] import_mcp_servers_from_apps 失败",
    body: "diagnostics",
    issueUrl: "https://github.com/wanghuan9/skilldock/issues/new?title=test",
    logPath: "~/.skilldock/logs/errors.jsonl",
  });
  const openSpy = vi.spyOn(skillClient, "openExternalLink").mockResolvedValueOnce(undefined);
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await userEvent.click(await screen.findByRole("button", { name: "扫描导入" }));

  await waitFor(() => {
    expect(screen.getByRole("alert")).toHaveTextContent("Codex MCP 配置解析失败");
    expect(screen.getByRole("button", { name: "反馈" })).toBeInTheDocument();
  });

  await userEvent.click(screen.getByRole("button", { name: "反馈" }));

  await waitFor(() => {
    expect(feedbackSpy).toHaveBeenCalledWith(expect.objectContaining({
      operation: "import_mcp_servers_from_apps",
      message: "Codex MCP 配置解析失败",
    }));
    expect(openSpy).toHaveBeenCalledWith("https://github.com/wanghuan9/skilldock/issues/new?title=test");
  });

  feedbackSpy.mockRestore();
  openSpy.mockRestore();
});

test("keeps feedback entry for business-like MCP import failures and records diagnostics immediately", async () => {
  window.localStorage.clear();
  vi.spyOn(skillClient, "importMcpServersFromApps").mockRejectedValueOnce("导入 Cursor MCP \"feishu-mcp\" 失败: stdio 类型 MCP 服务器必须填写 command");
  const feedbackSpy = vi.spyOn(skillClient, "recordFailureFeedback").mockResolvedValueOnce({
    title: "[Bug] import_mcp_servers_from_apps 失败",
    body: "diagnostics",
    issueUrl: "https://github.com/wanghuan9/skilldock/issues/new?title=test",
    logPath: "~/.skilldock/logs/errors.jsonl",
  });
  const openSpy = vi.spyOn(skillClient, "openExternalLink").mockResolvedValueOnce(undefined);
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await userEvent.click(await screen.findByRole("button", { name: "扫描导入" }));

  await waitFor(() => {
    expect(screen.getByRole("alert")).toHaveTextContent(
      "导入 Cursor MCP \"feishu-mcp\" 失败: stdio 类型 MCP 服务器必须填写 command",
    );
    expect(screen.getByRole("button", { name: "反馈" })).toBeInTheDocument();
    expect(feedbackSpy).toHaveBeenCalledWith(expect.objectContaining({
      operation: "import_mcp_servers_from_apps",
      kind: "unknown",
      message: "导入 Cursor MCP \"feishu-mcp\" 失败: stdio 类型 MCP 服务器必须填写 command",
    }));
  });

  await userEvent.click(screen.getByRole("button", { name: "反馈" }));

  await waitFor(() => {
    expect(openSpy).toHaveBeenCalledWith("https://github.com/wanghuan9/skilldock/issues/new?title=test");
  });

  feedbackSpy.mockRestore();
  openSpy.mockRestore();
});

test("shows supported MCP apps in enable-to-tool controls", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  expect(await screen.findByText("context7")).toBeInTheDocument();
  const summaryButtons = await screen.findAllByRole("button", { name: /展开 / });
  expect(summaryButtons[0]).toHaveAccessibleName("展开 context7");
  expect(summaryButtons[1]).toHaveAccessibleName("展开 linear");
  expect(screen.getByText("已启用 2")).toBeInTheDocument();
  expect(screen.getAllByText("2 tools").length).toBeGreaterThan(0);
  expect(screen.queryByText("stdio")).not.toBeInTheDocument();
  expect(screen.queryByText("未获取 tools")).not.toBeInTheDocument();

  const expandContext7Button = screen.getByRole("button", { name: "展开 context7" });
  expect(expandContext7Button).toHaveAttribute("aria-expanded", "false");
  expect(expandContext7Button.querySelector(".link-badge")).not.toBeNull();
  expect(screen.queryByText("简介")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Claude Code" })).not.toBeInTheDocument();
  expect(screen.getByText("Up-to-date code documentation for LLMs and AI code editors")).not.toHaveAttribute(
    "data-tooltip",
  );

  await userEvent.click(expandContext7Button);

  expect(screen.getByRole("button", { name: "收起 context7" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("基本信息")).toBeInTheDocument();
  expect(screen.getByText("简介")).toBeInTheDocument();
  expect(screen.getAllByText("Up-to-date code documentation for LLMs and AI code editors")).toHaveLength(2);
  const installedAtLabel = screen.getByText("安装时间");
  expect(installedAtLabel).toBeInTheDocument();
  expect(screen.getByText(formatSkillUpdatedAt("1778401800000"))).toBeInTheDocument();
  expect(screen.queryByText("来源类型")).not.toBeInTheDocument();
  expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  expect(screen.getByText("完整命令")).toBeInTheDocument();
  expect(screen.getByText("npx -y @upstash/context7-mcp")).not.toHaveAttribute("data-tooltip");
  const sourceLabel = screen.getByText("来源");
  expect(sourceLabel).toBeInTheDocument();
  expect(Boolean(installedAtLabel.compareDocumentPosition(sourceLabel) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  expect(screen.getByText("https://github.com/upstash/context7")).toBeInTheDocument();
  expect(screen.getByText("启用到工具")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Claude Code" })[0]).toHaveClass("tool-pill");
  expect(screen.getAllByRole("button", { name: "Codex" })[0]).toHaveClass("tool-pill");
  const enabledAppsSection = screen.getByText("启用到工具").closest("section");
  if (!enabledAppsSection) {
    throw new Error("missing enabled apps section");
  }
  const enabledAppButtons = within(enabledAppsSection)
    .getAllByRole("button")
    .filter((button) => button.classList.contains("tool-pill"));
  expect(enabledAppButtons.map((button) => button.textContent?.trim())).toEqual([
    "Claude Code",
    "Codex",
    "OpenCode",
    "Cursor",
    "Gemini CLI",
    "Antigravity",
    "Devin",
    "OpenClaw",
    "Continue",
    "iFlow",
    "Kiro",
  ]);
  expect(screen.queryByRole("button", { name: "Trae" })).not.toBeInTheDocument();
  expect(screen.getByText("Tools")).toBeInTheDocument();
  expect(screen.getAllByText("2 tools").length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "收起 context7 Tools" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "全部开启" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "全部关闭" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "resolve-library-id" })).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(screen.getByRole("button", { name: "收起 context7 Tools" }));
  expect(screen.getByRole("button", { name: "展开 context7 Tools" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "resolve-library-id" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "展开 context7 Tools" }));
  expect(screen.getByRole("button", { name: "收起 context7 Tools" })).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(screen.getByRole("button", { name: "resolve-library-id" }));
  expect(screen.getByText("已启用 2")).toBeInTheDocument();
  expect(screen.getAllByText("1/2 tools").length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "resolve-library-id" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "全部开启" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "全部关闭" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "全部开启" }));
  expect(screen.getAllByText("2 tools").length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "全部开启" })).toBeDisabled();
  expect(screen.getAllByText("Antigravity").length).toBeGreaterThan(0);
  expect(screen.queryByText("CodeBuddy")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "手动添加" }));

  await waitFor(() => {
    expect(screen.getByRole("dialog", { name: "手动添加 MCP" })).toBeInTheDocument();
  });
  expect((screen.getByLabelText("JSON 配置") as HTMLTextAreaElement).value).not.toContain("\"type\": \"stdio\"");
  expect(screen.getAllByText("Antigravity").length).toBeGreaterThan(0);
});

test("expanding one MCP server collapses the previously opened server", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));

  await userEvent.click(await screen.findByRole("button", { name: "展开 context7" }));
  expect(screen.getByRole("button", { name: "收起 context7" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("npx -y @upstash/context7-mcp")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "展开 linear" }));

  expect(screen.getByRole("button", { name: "展开 context7" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: "收起 linear" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByText("npx -y @upstash/context7-mcp")).not.toBeInTheDocument();
  expect(screen.getByText("https://mcp.linear.app/sse")).toBeInTheDocument();
});

test("hides uninstalled MCP target apps from the add dialog", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const workspaceWithUninitializedCursor = {
    ...workspace,
    apps: workspace.apps.map((app) => (
      app.id === "cursor" ? { ...app, statusLabel: "未安装" } : app
    )),
    servers: workspace.servers.map((server) => ({
      ...server,
      apps: server.apps.map((app) => (
        app.appId === "cursor" ? { ...app, statusLabel: "未安装" } : app
      )),
    })),
  };
  vi.spyOn(skillClient, "fetchMcpWorkspace").mockResolvedValueOnce(workspaceWithUninitializedCursor);

  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await userEvent.click(await screen.findByRole("button", { name: "展开 context7" }));

  expect(screen.queryByRole("button", { name: "Cursor" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "手动添加" }));

  await waitFor(() => {
    expect(screen.getByRole("dialog", { name: "手动添加 MCP" })).toBeInTheDocument();
  });
  expect(screen.queryByRole("checkbox", { name: /Cursor/ })).not.toBeInTheDocument();
});

test("creates MCP without asking the user for an ID", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await userEvent.click(await screen.findByRole("button", { name: "手动添加" }));

  const dialog = await screen.findByRole("dialog", { name: "手动添加 MCP" });
  expect(dialog).not.toHaveTextContent("MCP ID");

  await userEvent.type(screen.getByLabelText("名称"), "Playwright Tools");
  await userEvent.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "手动添加 MCP" })).not.toBeInTheDocument();
  });
  expect(screen.getByText("playwright tools")).toBeInTheDocument();
});

test("probes tools right after manually creating an MCP server", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const createdWorkspace = {
    ...workspace,
    servers: [
      {
        id: "playwright-tools",
        name: "playwright tools",
        serverType: "stdio",
        commandLabel: "npx",
        description: "playwright tools",
        sourceUrl: "",
        serverJson: JSON.stringify({
          command: "npx",
          args: [],
        }, null, 2),
        enabledAppCount: 0,
        apps: workspace.apps.map((app) => ({
          appId: app.id,
          appName: app.name,
          configPath: app.configPath,
          statusLabel: app.statusLabel,
          isEnabled: false,
        })),
        tools: [],
        toolsDiscoveredAt: "",
        toolsDiscoveryError: "",
        installedAt: "2026/5/15 13:09:26",
      },
      ...workspace.servers,
    ],
  };
  const fetchSpy = vi.spyOn(skillClient, "fetchMcpWorkspace").mockResolvedValue(workspace);
  const saveSpy = vi.spyOn(skillClient, "saveMcpServer").mockResolvedValue(createdWorkspace);
  const refreshSpy = vi.spyOn(skillClient, "refreshMcpServerTools").mockResolvedValue(createdWorkspace);
  const fixtureSpy = vi.spyOn(skillClient, "shouldUseFixtureData").mockReturnValue(false);

  try {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await screen.findByText("context7");
    refreshSpy.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "手动添加" }));
    await userEvent.type(await screen.findByLabelText("名称"), "Playwright Tools");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalled();
      expect(refreshSpy).toHaveBeenCalledWith("playwright-tools");
    });
  } finally {
    fixtureSpy.mockRestore();
    refreshSpy.mockRestore();
    saveSpy.mockRestore();
    fetchSpy.mockRestore();
  }
});

test("opens GitHub source url from MCP details", async () => {
  window.localStorage.clear();
  const openSpy = vi.spyOn(skillClient, "openExternalLink").mockResolvedValueOnce(undefined);
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await userEvent.click(await screen.findByRole("button", { name: "展开 context7" }));
  await userEvent.click(screen.getByRole("link", { name: "https://github.com/upstash/context7" }));

  expect(openSpy).toHaveBeenCalledWith("https://github.com/upstash/context7");
  openSpy.mockRestore();
});

test("filters MCP servers by description", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await screen.findByText("context7");
  await userEvent.type(
    screen.getByRole("searchbox", { name: "搜索 MCP" }),
    "issue tracking",
  );

  expect(screen.getByText("linear")).toBeInTheDocument();
  expect(screen.queryByText("context7")).not.toBeInTheDocument();
});

test("tool toggles stay visually stable while updating", async () => {
  window.localStorage.clear();
  const initialSnapshot = await skillClient.fetchMcpWorkspace();
  const nextSnapshot = {
    ...initialSnapshot,
    servers: initialSnapshot.servers.map((server) => (
      server.id === "context7"
        ? {
            ...server,
            tools: server.tools.map((tool) => (
              tool.name === "resolve-library-id"
                ? { ...tool, isEnabled: false }
                : tool
            )),
          }
        : server
    )),
  };
  let resolveToggle: ((value: typeof nextSnapshot) => void) | undefined;
  const toggleSpy = vi.spyOn(skillClient, "toggleMcpServerTool").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveToggle = resolve;
      }),
  );

  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await userEvent.click(await screen.findByRole("button", { name: "展开 context7" }));
  await userEvent.click(screen.getByRole("button", { name: "resolve-library-id" }));

  expect(screen.getByRole("button", { name: "resolve-library-id" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "get-library-docs" })).toBeEnabled();
  expect(screen.queryByText("处理中")).not.toBeInTheDocument();
  expect(screen.getAllByText("1/2 tools").length).toBeGreaterThan(0);

  const finishToggle = resolveToggle;
  if (!finishToggle) {
    throw new Error("toggle handler was not called");
  }
  finishToggle(nextSnapshot);

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "resolve-library-id" })).toHaveAttribute("aria-pressed", "false");
  });

  toggleSpy.mockRestore();
});

test("app toggles update immediately without showing processing text", async () => {
  window.localStorage.clear();
  const initialSnapshot = await skillClient.fetchMcpWorkspace();
  const nextSnapshot = {
    ...initialSnapshot,
    servers: initialSnapshot.servers.map((server) => (
      server.id === "context7"
        ? {
            ...server,
            enabledAppCount: 1,
            apps: server.apps.map((app) => (
              app.appId === "claude-code"
                ? { ...app, isEnabled: false }
                : app
            )),
          }
        : server
    )),
  };
  let resolveToggle: ((value: typeof nextSnapshot) => void) | undefined;
  const toggleSpy = vi.spyOn(skillClient, "toggleMcpServerApp").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveToggle = resolve;
      }),
  );

  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await userEvent.click(await screen.findByRole("button", { name: "展开 context7" }));
  const claudeButton = screen.getAllByRole("button", { name: "Claude Code" })[0];
  await userEvent.click(claudeButton);

  expect(screen.getAllByRole("button", { name: "Claude Code" })[0]).toBeDisabled();
  expect(screen.queryByText("处理中")).not.toBeInTheDocument();
  expect(screen.getAllByText("已启用 1").length).toBeGreaterThan(0);
  expect(screen.getAllByRole("button", { name: "Claude Code" })[0]).toHaveAttribute("aria-pressed", "false");

  const finishToggle = resolveToggle;
  if (!finishToggle) {
    throw new Error("toggle handler was not called");
  }
  finishToggle(nextSnapshot);

  await waitFor(() => {
    expect(screen.getAllByRole("button", { name: "Claude Code" })[0]).toBeEnabled();
  });

  toggleSpy.mockRestore();
});

test("bulk toggles MCP target apps from server details", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await userEvent.click(await screen.findByRole("button", { name: "展开 context7" }));

  const enableAllAppsButton = screen.getByRole("button", { name: "全部开启 context7 启用到工具" });
  const disableAllAppsButton = screen.getByRole("button", { name: "全部关闭 context7 启用到工具" });
  expect(enableAllAppsButton).toHaveTextContent("全部开启");
  expect(disableAllAppsButton).toHaveTextContent("全部关闭");
  expect(enableAllAppsButton).toHaveClass("secondary-button--compact");
  expect(enableAllAppsButton.closest(".tool-sync-panel__actions")).not.toBeNull();

  await userEvent.click(enableAllAppsButton);

  await waitFor(() => {
    const openCodeButton = screen.getByRole("button", { name: "OpenCode" });
    expect(openCodeButton).toHaveAttribute("aria-pressed", "true");
    expect(openCodeButton).toBeEnabled();
  });
  expect(screen.getByText("已启用 11")).toBeInTheDocument();
  expect(enableAllAppsButton).toBeDisabled();

  await userEvent.click(disableAllAppsButton);

  await waitFor(() => {
    const claudeCodeButton = screen.getAllByRole("button", { name: "Claude Code" })[0];
    expect(claudeCodeButton).toHaveAttribute("aria-pressed", "false");
    expect(claudeCodeButton).toBeEnabled();
  });
  expect(screen.getAllByText("未启用").length).toBeGreaterThan(0);
  expect(disableAllAppsButton).toBeDisabled();
});

test("bulk enables MCP target apps from the list power action", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  const bulkToggleButton = await screen.findByRole("button", {
    name: "已启用 2/11，点击全部启用",
  });

  await userEvent.click(bulkToggleButton);

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "全部关闭 context7 启用到工具" })).toBeEnabled();
  });
  expect(screen.getByText("已启用 11")).toBeInTheDocument();
});

test("shows MCP tools discovery errors when refresh fails due to missing env", async () => {
  window.localStorage.clear();
  const workspace = await skillClient.fetchMcpWorkspace();
  const failedWorkspace = {
    ...workspace,
    servers: [
      {
        id: "bright-data",
        name: "bright data",
        serverType: "stdio",
        commandLabel: "npx -y @brightdata/mcp",
        description: "Official Bright Data MCP server.",
        sourceUrl: "https://mcp.directory/servers/bright-data",
        serverJson: JSON.stringify({
          command: "npx",
          args: ["-y", "@brightdata/mcp"],
          env: { BRIGHTDATA_API_TOKEN: "<YOUR_TOKEN>" },
        }, null, 2),
        enabledAppCount: 0,
        apps: workspace.apps.map((app) => ({
          appId: app.id,
          appName: app.name,
          configPath: app.configPath,
          statusLabel: app.statusLabel,
          isEnabled: false,
        })),
        tools: [],
        toolsDiscoveredAt: "2026/5/10 22:39:32",
        toolsDiscoveryError: "MCP server 启动失败：缺少环境变量 API_TOKEN",
        installedAt: "2026/5/10 22:37:23",
      },
    ],
  };
  vi.spyOn(skillClient, "fetchMcpWorkspace").mockResolvedValueOnce(failedWorkspace);

  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await userEvent.click(await screen.findByRole("button", { name: "展开 bright data" }));

  expect(screen.getByText("获取失败")).toBeInTheDocument();
  expect(screen.getByText("需配置参数")).toHaveAttribute(
    "data-tooltip",
    "需要配置参数：API_TOKEN, BRIGHTDATA_API_TOKEN",
  );
  expect(screen.getByText("获取 tools 失败：MCP server 启动失败：缺少环境变量 API_TOKEN")).toBeInTheDocument();
});
