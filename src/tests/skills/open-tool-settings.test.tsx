import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

test("allows selecting default open tool in settings", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /设置/ }));

  const select = screen.getByLabelText("默认打开工具");
  expect(select).toBeInTheDocument();
  expect(screen.getByText("当前默认")).toBeInTheDocument();
  expect(screen.getByText("工具状态")).toBeInTheDocument();
  expect(screen.getByText("CodeBuddy")).toBeInTheDocument();
  expect(screen.getAllByText("未安装").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0);
  expect(screen.getAllByText("已安装").length).toBeGreaterThan(0);
  expect(screen.getAllByText("编辑器").length).toBeGreaterThan(0);

  expect(screen.getByRole("option", { name: "Cursor" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Claude Code" })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Codex" })).not.toBeInTheDocument();

  await userEvent.selectOptions(select, "cursor");

  expect(screen.getByDisplayValue("Cursor")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "工具状态" }));
  expect(screen.queryByText("CodeBuddy")).not.toBeInTheDocument();
});
