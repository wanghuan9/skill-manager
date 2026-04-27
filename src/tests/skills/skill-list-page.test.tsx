import { render, screen } from "@testing-library/react";
import { App } from "@/app/App";

test("renders installed skill page header and search input", () => {
  render(<App />);
  expect(screen.getByRole("button", { name: /Skills/ })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Skills", level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "全部更新" })).toBeInTheDocument();
  expect(screen.getByPlaceholderText("搜索技能名称、来源...")).toBeInTheDocument();
});
