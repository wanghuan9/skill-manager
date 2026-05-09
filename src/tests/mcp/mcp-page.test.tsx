import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

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
});

test("shows only installed MCP-ready apps in enable-to-tool controls", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  expect(await screen.findByText("context7")).toBeInTheDocument();

  const expandContext7Button = screen.getByRole("button", { name: "展开 context7" });
  expect(expandContext7Button).toHaveAttribute("aria-expanded", "false");
  expect(expandContext7Button.querySelector(".link-badge")).not.toBeNull();
  expect(screen.queryByText("简介")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Claude Code" })).not.toBeInTheDocument();

  await userEvent.click(expandContext7Button);

  expect(screen.getByRole("button", { name: "收起 context7" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("基本信息")).toBeInTheDocument();
  expect(screen.getByText("简介")).toBeInTheDocument();
  expect(screen.getByText("Up-to-date code documentation for LLMs and AI code editors")).toBeInTheDocument();
  expect(screen.getByText("来源类型")).toBeInTheDocument();
  expect(screen.getByText("GitHub")).toBeInTheDocument();
  expect(screen.getByText("https://github.com/upstash/context7")).toBeInTheDocument();
  expect(screen.getByText("启用到工具")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Claude Code" })[0]).toHaveClass("tool-pill");
  expect(screen.getAllByRole("button", { name: "Codex" })[0]).toHaveClass("tool-pill");
  expect(screen.queryByText("Antigravity")).not.toBeInTheDocument();
  expect(screen.queryByText("CodeBuddy")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "新增 MCP" }));

  await waitFor(() => {
    expect(screen.getByRole("dialog", { name: "新增 MCP" })).toBeInTheDocument();
  });
  expect(screen.queryByText("Antigravity")).not.toBeInTheDocument();
  expect(screen.queryByText("CodeBuddy")).not.toBeInTheDocument();
});
