import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";
import { App } from "@/app/App";
import { alignExpandedRowIntoView } from "@/app/utils/align-expanded-row";
import * as appUpdateClient from "@/features/app-update/app-update-client";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock("@/app/utils/align-expanded-row", () => ({
  alignExpandedRowIntoView: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.clearAllMocks();
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

test("switches between the two Skill source bar styles", async () => {
  const user = userEvent.setup();
  window.localStorage.clear();
  render(<App />);

  expect(screen.getByRole("tablist", { name: "Skill 来源" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /设置/ }));
  const styleSelect = screen.getByLabelText("Skill 来源栏样式");
  expect(styleSelect).toHaveAttribute("data-value", "flat");
  expect(within(styleSelect).queryByRole("option", { name: "浅色工具栏" })).not.toBeInTheDocument();

  await user.click(styleSelect);
  await user.click(screen.getByRole("option", { name: "来源选择器" }));
  await user.click(screen.getByRole("button", { name: /Skills/ }));

  expect(screen.queryByRole("tablist", { name: "Skill 来源" })).not.toBeInTheDocument();
  const sourceTrigger = screen.getByRole("button", { name: /已托管 4/ });
  expect(sourceTrigger.closest(".skills-source-select-row")).toBeInTheDocument();

  await user.click(sourceTrigger);
  expect(screen.getByRole("menuitem", { name: /Codex 5/ })).toBeInTheDocument();
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

test("switches and persists the interface theme from settings", async () => {
  const user = userEvent.setup();
  window.localStorage.clear();
  render(<App />);

  await user.click(screen.getByRole("button", { name: /设置/ }));

  const lightThemeButton = screen.getByRole("button", { name: "浅色" });
  const darkThemeButton = screen.getByRole("button", { name: "深色" });
  expect(lightThemeButton).toHaveAttribute("aria-pressed", "true");
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
});
