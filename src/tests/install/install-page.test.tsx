import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

test("renders install-source and repository install panels", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));
  expect(screen.getByRole("heading", { name: "安装", level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "市场安装" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "skills.sh" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "skillsmp" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));
  expect(screen.getByRole("textbox", { name: "Git 仓库地址" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "识别仓库技能" })).toBeInTheDocument();
});

test("discovers repo skills and allows multi-select install", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));

  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), "https://github.com/team/skill-repo");
  await userEvent.click(screen.getByRole("button", { name: "识别仓库技能" }));

  expect(screen.getByRole("button", { name: "检查中..." })).toBeDisabled();
  expect(await screen.findByText("发现 2 个技能，请选择要安装的技能")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "安装选中技能" })).toBeInTheDocument();
  expect(screen.getByText("service-observer")).toBeInTheDocument();
  expect(screen.getByText("release-scribe")).toBeInTheDocument();
});

test("shows install errors in the global notification stack", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));

  await userEvent.type(screen.getByRole("textbox", { name: "Git 仓库地址" }), "invalid-url");
  await userEvent.click(screen.getByRole("button", { name: "识别仓库技能" }));

  expect(screen.getByRole("alert")).toHaveTextContent("请输入有效的 Git 仓库地址。");
});

test("marks already installed repo skills as unavailable", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));
  await userEvent.click(screen.getByRole("tab", { name: "Git 安装" }));

  await userEvent.type(
    screen.getByRole("textbox", { name: "Git 仓库地址" }),
    "https://github.com/team/duplicate-skill-repo",
  );
  await userEvent.click(screen.getByRole("button", { name: "识别仓库技能" }));

  expect(await screen.findByText("发现 2 个技能，请选择要安装的技能")).toBeInTheDocument();
  expect(screen.getByText("已安装")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /drawio-diagram/i })).toBeDisabled();
  expect(screen.getByRole("button", { name: /service-observer/i })).not.toBeDisabled();
});

test("searches marketplace skills across all supported sources", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));

  const searchInput = screen.getByRole("searchbox", { name: "搜索 skill" });
  await userEvent.type(searchInput, "guardian");

  expect(await screen.findByText("release-guardian")).toBeInTheDocument();
  expect(screen.getByText("repo-guardian")).toBeInTheDocument();
});
