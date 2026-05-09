import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

test("renders installed tools only with manage action", async () => {
  window.localStorage.clear();
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /工具/ }));
  expect(screen.getByText("Claude Code")).toBeInTheDocument();
  expect(screen.queryByText("Amp")).not.toBeInTheDocument();
  expect(screen.queryByText("Finder")).not.toBeInTheDocument();
  const manageButtons = screen.getAllByRole("button", { name: "管理" });
  expect(manageButtons.length).toBeGreaterThan(0);
  expect(manageButtons[0]).toHaveClass("tool-card__manage-button");
  expect(screen.getByRole("button", { name: "打开 Claude Code Skills 文件夹" })).toBeInTheDocument();
  expect(screen.getAllByText("MCP 配置：").length).toBeGreaterThan(0);
  expect(screen.getByText("/Users/wanghuan/.claude.json")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "打开 Claude Code MCP 配置" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "打开 Antigravity MCP 配置" })).toBeDisabled();
});

test("can open a tool skills folder from the tools page", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /工具/ }));
  await userEvent.click(screen.getByRole("button", { name: "打开 Claude Code Skills 文件夹" }));

  expect(screen.getByRole("button", { name: "打开 Claude Code Skills 文件夹" })).toBeEnabled();
});

test("can open a tool MCP config from the tools page", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /工具/ }));
  await userEvent.click(screen.getByRole("button", { name: "打开 Claude Code MCP 配置" }));

  expect(screen.getByRole("button", { name: "打开 Claude Code MCP 配置" })).toBeEnabled();
});

test("can enable all visible skills from tool manage dialog", async () => {
  window.localStorage.clear();
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /工具/ }));
  await userEvent.click(screen.getAllByRole("button", { name: "管理" })[0]);

  expect(screen.getByRole("button", { name: "全部开启" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "全部关闭" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "全部开启" }));

  expect(await screen.findByText(/已启用 4\/4 个 Skills/)).toBeInTheDocument();
});
