import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

test("allows selecting default open tool in settings", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /设置/ }));

  const select = screen.getByLabelText("默认编辑器");
  expect(select).toBeInTheDocument();
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
