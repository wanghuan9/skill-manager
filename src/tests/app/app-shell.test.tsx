import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { App } from "@/app/App";

let isWindowMaximized = false;
let windowResizeListener: (() => void) | null = null;
const minimizeWindowMock = vi.fn().mockResolvedValue(undefined);
const isMaximizedWindowMock = vi.fn(async () => isWindowMaximized);
const toggleMaximizeWindowMock = vi.fn(async () => {
  isWindowMaximized = !isWindowMaximized;
  windowResizeListener?.();
});
const onResizedWindowMock = vi.fn(async (listener: () => void) => {
  windowResizeListener = listener;
  return () => {
    if (windowResizeListener === listener) {
      windowResizeListener = null;
    }
  };
});
const closeWindowMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: minimizeWindowMock,
    isMaximized: isMaximizedWindowMock,
    toggleMaximize: toggleMaximizeWindowMock,
    onResized: onResizedWindowMock,
    close: closeWindowMock,
  }),
}));

beforeEach(() => {
  isWindowMaximized = false;
  windowResizeListener = null;
  vi.clearAllMocks();
});

test("renders primary navigation entries and embeds projects in a workspace menu", async () => {
  render(<App />);

  const projectButton = await screen.findByRole("button", { name: "demo-workspace" });
  expect(projectButton).toHaveAttribute("data-tooltip", "demo-workspace");

  const navLabels = within(screen.getByRole("navigation", { name: "Primary" }))
    .getAllByRole("button")
    .map((button) => button.textContent?.trim());

  expect(screen.getByRole("button", { name: /Skills/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "工具" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Plugins" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "项目" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "添加项目" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "CLI" })).not.toBeInTheDocument();
  expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: /安装/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /设置/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /关于/ })).toBeInTheDocument();
  expect(navLabels).toEqual([
    "Skills",
    "MCP",
    "Plugins",
    "工具",
    "安装",
    "项目",
    "demo-workspace",
    "＋添加项目",
    "设置",
    "关于",
  ]);
});

test("notifies about startup Skill updates and opens the update filter", async () => {
  render(<App />);

  expect(await screen.findByText("1 个 Skill 有可用更新")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "查看" }));

  const statusFilter = screen.getByRole("combobox", { name: "筛选 Skill" });
  expect(statusFilter).toHaveTextContent("可更新 (1)");

  await userEvent.click(statusFilter);
  expect(screen.getByRole("option", { name: "可更新 (1)" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("marks empty macOS page header surfaces as window drag regions", () => {
  const originalPlatform = window.navigator.platform;
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });

  try {
    const { container } = render(<App />);
    const headerLayout = container.querySelector(".page-header--split");
    const headerIdentity = container.querySelector(".page-header__row");
    const searchInput = headerLayout?.querySelector("input");

    expect(headerLayout).toHaveAttribute("data-tauri-drag-region");
    expect(headerIdentity).toHaveAttribute("data-tauri-drag-region");
    expect(searchInput).not.toBeNull();
    expect(searchInput).not.toHaveAttribute("data-tauri-drag-region");
  } finally {
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  }
});

test("switches to plugins route", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "Plugins" }));
  await screen.findByRole("tab", { name: /Claude Code/ });
  expect(screen.getByRole("heading", { name: "Plugins", level: 1 })).toBeInTheDocument();
  expect(await screen.findByText("ecc")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  expect(screen.getByRole("heading", { name: "Codex", level: 1 })).toBeInTheDocument();
  expect(screen.getByText("查看已纳入管理的插件及其归属组件")).toBeInTheDocument();
  expect(await screen.findByText("Repo Scout")).toBeInTheDocument();
});

test("resets the skills list scroll position when switching source", async () => {
  const { container } = render(<App />);
  const pageContent = container.querySelector<HTMLElement>(".page-content");
  expect(pageContent).not.toBeNull();

  if (!pageContent) {
    return;
  }

  pageContent.scrollTop = 160;
  await userEvent.click(await screen.findByRole("tab", { name: /Claude Code/ }));

  expect(pageContent.scrollTop).toBe(0);
});

test("renders about page project links", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /关于/ }));

  expect(
    screen.getByRole("heading", { name: "SkillDock" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /GitHub 仓库/ })).toHaveAttribute(
    "href",
    "https://github.com/wanghuan9/skilldock",
  );
  expect(screen.getByRole("link", { name: /意见反馈/ })).toHaveAttribute(
    "href",
    "https://github.com/wanghuan9/skilldock/issues/new/choose",
  );
});

test("renders frameless Windows controls and keeps the sidebar toggle outside the brand block", async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "platform");
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: "Win32",
  });

  try {
    render(<App />);

    const shell = document.querySelector(".app-shell");
    const edgeToggle = document.querySelector(".sidebar-toggle--edge");
    expect(shell).toHaveClass("is-windows-window");
    expect(edgeToggle).not.toBeNull();
    expect(document.querySelector(".brand-block .sidebar-toggle")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "最小化" }));
    const maximizeButton = screen.getByRole("button", { name: "最大化" });
    expect(maximizeButton.querySelector("path")).not.toBeInTheDocument();

    act(() => {
      isWindowMaximized = true;
      windowResizeListener?.();
    });
    const restoreButton = await screen.findByRole("button", { name: "还原" });
    expect(restoreButton.querySelector("path")).toBeInTheDocument();

    await userEvent.click(restoreButton);
    expect(screen.getByRole("button", { name: "最大化" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(minimizeWindowMock).toHaveBeenCalledTimes(1);
    expect(toggleMaximizeWindowMock).toHaveBeenCalledTimes(1);
    expect(closeWindowMock).toHaveBeenCalledTimes(1);
  } finally {
    if (platformDescriptor) {
      Object.defineProperty(window.navigator, "platform", platformDescriptor);
    } else {
      Reflect.deleteProperty(window.navigator, "platform");
    }
  }
});
