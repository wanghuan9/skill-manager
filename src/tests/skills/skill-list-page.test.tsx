import { beforeEach, test } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

beforeEach(() => {
  window.localStorage.clear();
});

test("renders installed skill page header and search input", () => {
  render(<App />);
  expect(screen.getByRole("button", { name: /Skills/ })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Skills", level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "全部更新 (1)" })).toBeInTheDocument();
  expect(screen.getByPlaceholderText("搜索技能名称、来源...")).toBeInTheDocument();
});

test("uses grouped view but keeps groups collapsed by default when installed skill count is below threshold", () => {
  render(<App />);

  expect(screen.getByRole("button", { name: "分组" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "skill-publisher" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "drawio-diagram" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "excalidraw-diagram" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开来源分组 team-skills" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开来源分组 best-skills" })).toBeInTheDocument();
});

test("remembers expanded groups across app reopen", async () => {
  const user = userEvent.setup();
  const firstRender = render(<App />);

  await user.click(screen.getByRole("button", { name: "展开来源分组 team-skills" }));

  expect(screen.getByRole("heading", { name: "skill-publisher" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "drawio-diagram" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "收起来源分组 team-skills" })).toBeInTheDocument();

  firstRender.unmount();
  render(<App />);

  expect(screen.getByRole("heading", { name: "skill-publisher" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "drawio-diagram" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "excalidraw-diagram" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "收起来源分组 team-skills" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开来源分组 best-skills" })).toBeInTheDocument();
});

test("remembers the user's last flat view selection", async () => {
  const user = userEvent.setup();
  const firstRender = render(<App />);

  await user.click(screen.getByRole("button", { name: "分组" }));

  expect(screen.getByRole("button", { name: "平铺" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /来源分组/ })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "skill-publisher" })).toBeInTheDocument();

  firstRender.unmount();
  render(<App />);

  expect(screen.getByRole("button", { name: "平铺" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /来源分组/ })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "skill-publisher" })).toBeInTheDocument();
});
