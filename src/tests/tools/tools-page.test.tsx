import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "@/app/App";
import * as skillClient from "@/features/skills/api/skill-client";
import { appSettingsFixture, pluginFixtures } from "@/features/skills/state/skill-fixtures";
import type { PluginSummary } from "@/features/skills/state/skill-store";

afterEach(() => {
  vi.restoreAllMocks();
  appSettingsFixture.defaultOpenToolId = "";
});

test("renders installed tools only with manage action", async () => {
  window.localStorage.clear();
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "工具" }));
  expect(screen.getByText("Claude Code")).toBeInTheDocument();
  expect(screen.queryByText("IntelliJ IDEA")).not.toBeInTheDocument();
  expect(screen.queryByText("VS Code")).not.toBeInTheDocument();
  expect(screen.queryByText("Amp")).not.toBeInTheDocument();
  expect(screen.queryByText("Folder")).not.toBeInTheDocument();
  const manageButtons = screen.getAllByRole("button", { name: "管理" });
  expect(manageButtons.length).toBeGreaterThan(0);
  expect(manageButtons[0]).toHaveClass("tool-card__manage-button");
  expect(screen.getByRole("button", { name: "打开 Claude Code Skills 文件夹" })).toBeInTheDocument();
  expect(screen.getAllByText("MCP 配置：").length).toBeGreaterThan(0);
  expect(screen.getByText("/Users/demo/.claude.json")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "打开 Claude Code MCP 配置" })).toBeInTheDocument();
  expect(screen.getByText("/Users/demo/.gemini/config/mcp_config.json")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "打开 Antigravity MCP 配置" })).toBeEnabled();
});

test("can open a tool skills folder from the tools page", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "工具" }));
  await userEvent.click(screen.getByRole("button", { name: "打开 Claude Code Skills 文件夹" }));

  expect(screen.getByRole("button", { name: "打开 Claude Code Skills 文件夹" })).toBeEnabled();
});

test("can open a tool MCP config from the tools page", async () => {
  window.localStorage.clear();
  const openToolMcpConfigSpy = vi.spyOn(skillClient, "openToolMcpConfig").mockResolvedValue(undefined);
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "工具" }));
  await userEvent.click(screen.getByRole("button", { name: "打开 Claude Code MCP 配置" }));

  expect(openToolMcpConfigSpy).toHaveBeenCalledWith({
    toolId: "claude-code",
    editorId: "cursor",
  });
  expect(screen.getByRole("button", { name: "打开 Claude Code MCP 配置" })).toBeEnabled();
});

test("uses default editor for MCP config when a direct-open editor is selected", async () => {
  window.localStorage.clear();
  appSettingsFixture.defaultOpenToolId = "cursor";
  const openToolMcpConfigSpy = vi.spyOn(skillClient, "openToolMcpConfig").mockResolvedValue(undefined);

  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "工具" }));
  await userEvent.click(screen.getByRole("button", { name: "打开 Claude Code MCP 配置" }));

  expect(openToolMcpConfigSpy).toHaveBeenCalledWith({
    toolId: "claude-code",
    editorId: "cursor",
  });
});

test("can enable all visible skills from tool manage dialog", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "工具" }));
  const claudeToolCard = screen.getByText("Claude Code").closest("article");
  expect(claudeToolCard).not.toBeNull();
  await userEvent.click(within(claudeToolCard as HTMLElement).getByRole("button", { name: "管理" }));

  expect(screen.getByRole("tab", { name: "Skills" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "MCP" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "全部开启" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "全部关闭" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "全部开启" }));

  expect(await screen.findByText(/Skills 4\/4/)).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "全部关闭" }));

  expect(await screen.findByText(/Skills 0\/4/)).toBeInTheDocument();
});

test("can toggle MCP servers from tool manage dialog", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "工具" }));
  const claudeToolCard = screen.getByText("Claude Code").closest("article");
  expect(claudeToolCard).not.toBeNull();
  await userEvent.click(within(claudeToolCard as HTMLElement).getByRole("button", { name: "管理" }));

  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  expect(await screen.findByText("context7")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "关闭 context7" }));

  expect(await screen.findByText("Skills 3/4 · MCP 0/2 · 插件 0/1")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "启用 context7" })).toBeInTheDocument();
});

test("can manage plugins for a supported tool", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "工具" }));
  const claudeToolCard = screen.getByText("Claude Code").closest("article");
  expect(claudeToolCard).not.toBeNull();
  await userEvent.click(within(claudeToolCard as HTMLElement).getByRole("button", { name: "管理" }));

  expect(screen.getByRole("tab", { name: "Plugins" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "Plugins" }));

  expect(await screen.findByText("ecc")).toBeInTheDocument();
  expect(screen.getByText(/插件 0\/1/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "全部开启" }));

  expect(await screen.findByText(/插件 1\/1/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "关闭 ecc" }));

  expect(await screen.findByText(/插件 0\/1/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "启用 ecc" })).toBeInTheDocument();
});

test("can toggle Cursor plugins with a reload hint", async () => {
  window.localStorage.clear();
  const cursorPlugin: PluginSummary = {
    ...pluginFixtures[0],
    id: "cursor:example-plugin",
    name: "Example Plugin",
    hostTool: "cursor",
    relatedHostTools: [],
    rootPath: "/Users/demo/.cursor/plugins/local/example-plugin",
    manifestPath: "/Users/demo/.cursor/plugins/local/example-plugin/.cursor-plugin/plugin.json",
    enabledState: "enabled",
  };
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValue([cursorPlugin]);
  const setPluginEnabledSpy = vi.spyOn(skillClient, "setPluginEnabled").mockImplementation(async (input) => ({
    ...cursorPlugin,
    enabledState: input.enabled ? "enabled" : "disabled",
  }));
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "工具" }));
  const cursorToolCard = screen.getByText("Cursor").closest("article");
  expect(cursorToolCard).not.toBeNull();
  await userEvent.click(within(cursorToolCard as HTMLElement).getByRole("button", { name: "管理" }));

  await userEvent.click(screen.getByRole("tab", { name: "Plugins" }));

  expect(await screen.findByText("Example Plugin")).toBeInTheDocument();
  expect(screen.getByText(/插件 1\/1/)).toBeInTheDocument();
  expect(screen.getByText("Cursor 插件启停将在重载 Cursor 窗口后生效。")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "关闭 Example Plugin" }));

  expect(setPluginEnabledSpy).toHaveBeenCalledWith({
    pluginId: cursorPlugin.id,
    hostTool: "cursor",
    rootPath: cursorPlugin.rootPath,
    enabled: false,
  });
  expect(await screen.findByText(/插件 0\/1/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "启用 Example Plugin" })).toBeEnabled();
});

test("can manage OpenCode plugins", async () => {
  window.localStorage.clear();
  const opencodePlugin: PluginSummary = {
    ...pluginFixtures[0],
    id: "opencode:demo-opencode",
    manifestName: "demo-opencode",
    name: "Demo OpenCode",
    hostTool: "opencode",
    relatedHostTools: [],
    rootPath: "/Users/demo/.skilldock/plugins/demo-opencode",
    manifestPath: "/Users/demo/.skilldock/plugins/demo-opencode/.opencode/plugins/demo.ts",
    enabledState: "enabled",
  };
  vi.spyOn(skillClient, "fetchStartupInstalledPlugins").mockResolvedValue([opencodePlugin]);
  const setPluginEnabledSpy = vi.spyOn(skillClient, "setPluginEnabled").mockImplementation(async (input) => ({
    ...opencodePlugin,
    enabledState: input.enabled ? "enabled" : "disabled",
  }));
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "工具" }));
  const openCodeToolCard = screen.getByText("OpenCode").closest("article");
  expect(openCodeToolCard).not.toBeNull();
  await userEvent.click(within(openCodeToolCard as HTMLElement).getByRole("button", { name: "管理" }));
  await userEvent.click(screen.getByRole("tab", { name: "Plugins" }));
  await userEvent.click(await screen.findByRole("button", { name: "关闭 demo-opencode" }));

  expect(setPluginEnabledSpy).toHaveBeenCalledWith({
    pluginId: opencodePlugin.id,
    hostTool: "opencode",
    rootPath: opencodePlugin.rootPath,
    enabled: false,
  });
  expect(await screen.findByRole("button", { name: "启用 demo-opencode" })).toBeEnabled();
});

test("does not show plugin management for an unsupported tool", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "工具" }));
  const antigravityToolCard = screen.getByText("Antigravity").closest("article");
  expect(antigravityToolCard).not.toBeNull();
  await userEvent.click(within(antigravityToolCard as HTMLElement).getByRole("button", { name: "管理" }));

  expect(screen.queryByRole("tab", { name: "Plugins" })).not.toBeInTheDocument();
  expect(screen.queryByText(/插件 \d+\/\d+/)).not.toBeInTheDocument();
});

test("shows managed MCP state for Antigravity", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "工具" }));
  const antigravityToolCard = screen.getByText("Antigravity").closest("article");
  expect(antigravityToolCard).not.toBeNull();
  await userEvent.click(within(antigravityToolCard as HTMLElement).getByRole("button", { name: "管理" }));

  await userEvent.click(screen.getByRole("tab", { name: "MCP" }));

  expect(await screen.findByText("context7")).toBeInTheDocument();
  expect(screen.getByText(/MCP \d+\/\d+/)).toBeInTheDocument();
});

test("keeps skill rows in a stable order when toggling", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "工具" }));
  const claudeToolCard = screen.getByText("Claude Code").closest("article");
  expect(claudeToolCard).not.toBeNull();
  await userEvent.click(within(claudeToolCard as HTMLElement).getByRole("button", { name: "管理" }));

  const beforeRows = screen
    .getAllByLabelText(/^(关闭|启用) /)
    .filter((button) => button.getAttribute("aria-label")?.includes("MCP") !== true)
    .slice(0, 4)
    .map((button) => button.getAttribute("aria-label"));
  expect(beforeRows).toEqual([
    "启用 drawio-diagram",
    "关闭 excalidraw-diagram",
    "关闭 multi-search-engine",
    "关闭 skill-publisher",
  ]);

  await userEvent.click(screen.getByRole("button", { name: "启用 drawio-diagram" }));

  const afterRows = screen
    .getAllByLabelText(/^(关闭|启用) /)
    .filter((button) => button.getAttribute("aria-label")?.includes("MCP") !== true)
    .slice(0, 4)
    .map((button) => button.getAttribute("aria-label"));
  expect(afterRows).toEqual([
    "关闭 drawio-diagram",
    "关闭 excalidraw-diagram",
    "关闭 multi-search-engine",
    "关闭 skill-publisher",
  ]);
});
