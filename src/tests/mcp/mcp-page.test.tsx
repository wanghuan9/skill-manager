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
});

test("shows only installed MCP-ready apps in enable-to-tool controls", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "MCP" }));
  expect(await screen.findByText("context7")).toBeInTheDocument();
  expect(screen.getByText("2 tools")).toBeInTheDocument();
  expect(screen.queryByText("stdio")).not.toBeInTheDocument();
  expect(screen.queryByText("未获取 tools")).not.toBeInTheDocument();

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
  expect(screen.getByText("Tools")).toBeInTheDocument();
  expect(screen.getByText("2/2 已启用")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "全部开启" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "全部关闭" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "resolve-library-id" })).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(screen.getByRole("button", { name: "resolve-library-id" }));
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
  expect(screen.getByText("Playwright Tools")).toBeInTheDocument();
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
