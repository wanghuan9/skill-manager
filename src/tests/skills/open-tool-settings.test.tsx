import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";
import { App } from "@/app/App";
import * as appUpdateClient from "@/features/app-update/app-update-client";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

test("allows selecting default open tool in settings", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /设置/ }));

  expect(screen.getByText("/Users/demo/.skilldock")).toBeInTheDocument();
  expect(screen.getByLabelText("界面语言")).toHaveTextContent("简体中文");
  const select = screen.getByLabelText("默认编辑器");
  expect(select).toBeInTheDocument();
  expect(screen.getByLabelText("新增 Skill 默认启用")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByLabelText("新增 MCP 默认启用")).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByText("工具状态")).toBeInTheDocument();

  expect(screen.getByRole("option", { name: "Cursor" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "IntelliJ IDEA" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "访达" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Claude Code" })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Codex" })).not.toBeInTheDocument();

  await userEvent.selectOptions(select, "cursor");

  expect(screen.getByDisplayValue("Cursor")).toBeInTheDocument();

  await userEvent.selectOptions(select, "finder");

  expect(screen.getByDisplayValue("访达")).toBeInTheDocument();

  await userEvent.click(screen.getByLabelText("新增 Skill 默认启用"));
  expect(screen.getByLabelText("新增 Skill 默认启用")).toHaveAttribute("aria-pressed", "false");

  await userEvent.click(screen.getByLabelText("新增 MCP 默认启用"));
  expect(screen.getByLabelText("新增 MCP 默认启用")).toHaveAttribute("aria-pressed", "true");

  await userEvent.click(screen.getByRole("button", { name: "工具状态" }));
  const toolStatusPanel = screen.getByText("展示当前支持的软件列表以及各软件的安装状态。").closest("section");
  if (!toolStatusPanel) {
    throw new Error("missing tool status panel");
  }

  expect(screen.getByText("CodeBuddy")).toBeInTheDocument();
  expect(within(toolStatusPanel).queryByText("IntelliJ IDEA")).not.toBeInTheDocument();
  expect(screen.getAllByText("未安装").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0);
  expect(screen.getAllByText("已安装").length).toBeGreaterThan(0);
  expect(screen.getAllByText("编辑器").length).toBeGreaterThan(0);

  await userEvent.click(screen.getByRole("button", { name: "工具状态" }));
  expect(screen.queryByText("CodeBuddy")).not.toBeInTheDocument();
});

test("expands tool status when clicking the hint copy", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /设置/ }));

  const toolStatusPanel = screen.getByText("展示当前支持的软件列表以及各软件的安装状态。").closest("section");
  if (!toolStatusPanel) {
    throw new Error("missing tool status panel");
  }

  await userEvent.click(toolStatusPanel);

  expect(screen.getByText("CodeBuddy")).toBeInTheDocument();
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
    install,
  });

  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /设置/ }));
  await userEvent.click(screen.getByRole("button", { name: "检查更新" }));

  expect(await screen.findByText("发现新版本 0.2.0")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "检查更新" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "下载并重启" }));

  expect(install).toHaveBeenCalled();
  expect(screen.getByText("正在下载并安装更新...")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "安装中..." })).toBeDisabled();
});

test("opens storage path in Finder from settings", async () => {
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
  expect(screen.getByLabelText("Interface Language")).toHaveTextContent("English");
});
