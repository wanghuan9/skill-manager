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
  expect(screen.getAllByRole("button", { name: "管理" }).length).toBeGreaterThan(0);
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
