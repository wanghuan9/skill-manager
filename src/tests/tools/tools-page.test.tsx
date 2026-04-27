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
