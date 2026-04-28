import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

test("renders installed skill page header and search input", () => {
  render(<App />);
  expect(screen.getByRole("button", { name: /Skills/ })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Skills", level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "全部更新" })).toBeInTheDocument();
  expect(screen.getByPlaceholderText("搜索技能名称、来源...")).toBeInTheDocument();
});

test("collapses skill groups by default", async () => {
  const user = userEvent.setup();

  render(<App />);

  expect(screen.queryByRole("heading", { name: "skill-publisher" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "drawio-diagram" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "excalidraw-diagram" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "展开来源分组 team-skills" }));

  expect(screen.getByRole("heading", { name: "skill-publisher" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "drawio-diagram" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "展开来源分组 best-skills" }));

  expect(screen.getByRole("heading", { name: "excalidraw-diagram" })).toBeInTheDocument();
});
