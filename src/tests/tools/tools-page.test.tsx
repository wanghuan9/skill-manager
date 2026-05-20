import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "@/app/App";
import * as skillClient from "@/features/skills/api/skill-client";
import { appSettingsFixture } from "@/features/skills/state/skill-fixtures";

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
  expect(screen.queryByText("Amp")).not.toBeInTheDocument();
  expect(screen.queryByText("Finder")).not.toBeInTheDocument();
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
    editorId: undefined,
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

  expect(await screen.findByText("Skills 3/4 · MCP 0/2")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "启用 context7" })).toBeInTheDocument();
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
