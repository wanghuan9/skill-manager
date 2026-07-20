import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

test("renders primary navigation entries with plugins before tools and cli hidden", () => {
  render(<App />);

  const navLabels = within(screen.getByRole("navigation", { name: "Primary" }))
    .getAllByRole("button")
    .map((button) => button.textContent?.trim());

  expect(screen.getByRole("button", { name: /Skills/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "工具" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Plugins" })).toBeInTheDocument();
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
    "设置",
    "关于",
  ]);
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
    "https://github.com/wanghuan9/skill-manager",
  );
  expect(screen.getByRole("link", { name: /意见反馈/ })).toHaveAttribute(
    "href",
    "https://github.com/wanghuan9/skill-manager/issues/new/choose",
  );
});
