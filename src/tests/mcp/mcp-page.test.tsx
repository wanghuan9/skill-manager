import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "@/app/App";
import * as skillClient from "@/features/skills/api/skill-client";

test("renders MCP toolbar in the page header and hides the app matrix", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));

  const toolbar = await screen.findByLabelText("MCP 工具栏");
  expect(toolbar).toBeInTheDocument();
  expect(toolbar.closest(".page-header__row")).not.toBeNull();
  expect(screen.queryByLabelText("MCP 目标软件")).not.toBeInTheDocument();
  expect(toolbar).not.toHaveTextContent("个 MCP");
  expect(toolbar).not.toHaveTextContent("工具可同步");
  expect(screen.getByRole("searchbox", { name: "搜索 MCP" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
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

test("shows only installed MCP-ready apps in enable-to-tool controls", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  expect(await screen.findByText("context7")).toBeInTheDocument();
  const summaryButtons = await screen.findAllByRole("button", { name: /展开 / });
  expect(summaryButtons[0]).toHaveAccessibleName("展开 context7");
  expect(summaryButtons[1]).toHaveAccessibleName("展开 linear");
  expect(screen.getByText("已启用 2")).toBeInTheDocument();
  expect(screen.getByText("2 tools")).toBeInTheDocument();
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
  expect(screen.getByText("2026/5/10 16:30:00")).toBeInTheDocument();
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
  expect(screen.getByText("Tools")).toBeInTheDocument();
  expect(screen.getByText("2/2 已启用")).toBeInTheDocument();
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
  expect(screen.getByText("1/2 tools")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "resolve-library-id" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "全部开启" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "全部关闭" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "全部开启" }));
  expect(screen.getByText("2 tools")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "全部开启" })).toBeDisabled();
  expect(screen.queryByText("Antigravity")).not.toBeInTheDocument();
  expect(screen.queryByText("CodeBuddy")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "新增 MCP" }));

  await waitFor(() => {
    expect(screen.getByRole("dialog", { name: "新增 MCP" })).toBeInTheDocument();
  });
  expect((screen.getByLabelText("JSON 配置") as HTMLTextAreaElement).value).not.toContain("\"type\": \"stdio\"");
  expect(screen.queryByText("Antigravity")).not.toBeInTheDocument();
  expect(screen.queryByText("CodeBuddy")).not.toBeInTheDocument();
});

test("creates MCP without asking the user for an ID", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await userEvent.click(await screen.findByRole("button", { name: "新增 MCP" }));

  const dialog = await screen.findByRole("dialog", { name: "新增 MCP" });
  expect(dialog).not.toHaveTextContent("MCP ID");

  await userEvent.type(screen.getByLabelText("名称"), "Playwright Tools");
  await userEvent.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "新增 MCP" })).not.toBeInTheDocument();
  });
  expect(screen.getByText("playwright tools")).toBeInTheDocument();
});

test("opens GitHub source url from MCP details", async () => {
  window.localStorage.clear();
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  await userEvent.click(await screen.findByRole("button", { name: "展开 context7" }));
  await userEvent.click(screen.getByRole("link", { name: "https://github.com/upstash/context7" }));

  expect(openSpy).toHaveBeenCalledWith(
    "https://github.com/upstash/context7",
    "_blank",
    "noopener,noreferrer",
  );
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
  expect(screen.getByText("1/2 tools")).toBeInTheDocument();

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
  expect(screen.getByText("已启用 8")).toBeInTheDocument();
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
