import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

test("renders primary navigation entries including plugins and cli", () => {
  render(<App />);
  expect(screen.getByRole("button", { name: /Skills/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "工具" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Plugins" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "CLI" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /安装/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /设置/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /关于/ })).toBeInTheDocument();
});

test("switches to plugins and cli routes", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "Plugins" }));
  await screen.findByRole("tab", { name: /Claude Code/ });
  expect(await screen.findByText("ecc")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: /Codex/ }));
  expect(await screen.findByText("Repo Scout")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "CLI" }));
  expect(await screen.findByText("lark-cli")).toBeInTheDocument();
  expect(await screen.findByText(/绑定 4 个 skills/)).toBeInTheDocument();
  expect(
    screen.getByPlaceholderText("搜索 CLI 包名称、命令、skill..."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "扫描导入" })).toBeInTheDocument();
});

test("renders about page project links", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /关于/ }));

  expect(
    screen.getByRole("heading", { name: "SkillDock" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /GitHub 仓库/ })).toHaveAttribute(
    "href",
    "https://github.com/wanghuan9/skill-manager",
  );
  expect(screen.getByRole("link", { name: /意见反馈/ })).toHaveAttribute(
    "href",
    "https://github.com/wanghuan9/skill-manager/issues/new/choose",
  );
});
