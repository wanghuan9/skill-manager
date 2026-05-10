import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";
import { App } from "@/app/App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

test("allows selecting default open tool in settings", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /设置/ }));

  expect(screen.getByText("/Users/demo/.skillm/settings.json")).toBeInTheDocument();
  const select = screen.getByLabelText("默认编辑器");
  expect(select).toBeInTheDocument();
  expect(screen.getByLabelText("新增 Skill 默认启用")).toHaveDisplayValue("应用到所有工具");
  expect(screen.getByLabelText("新增 MCP 默认启用")).toHaveDisplayValue("默认不启用");
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

  await userEvent.selectOptions(screen.getByLabelText("新增 Skill 默认启用"), "disable-all-tools");
  expect(screen.getByLabelText("新增 Skill 默认启用")).toHaveDisplayValue("默认不启用");

  await userEvent.selectOptions(screen.getByLabelText("新增 MCP 默认启用"), "apply-all-tools");
  expect(screen.getByLabelText("新增 MCP 默认启用")).toHaveDisplayValue("应用到所有工具");

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

test("opens storage path in Finder from settings", async () => {
  window.localStorage.clear();
  const invokeMock = vi.mocked(invoke);
  invokeMock.mockClear();

  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /设置/ }));
  expect(screen.getByText("/Users/demo/.skillm/settings.json")).toBeInTheDocument();

  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invokeMock.mockResolvedValue(undefined);
  await userEvent.click(screen.getByRole("button", { name: "打开" }));

  expect(invokeMock).toHaveBeenCalledWith("open_path_in_finder", {
    path: "/Users/demo/.skillm/settings.json",
  });

  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
