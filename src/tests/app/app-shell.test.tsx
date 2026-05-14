import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

test("renders primary navigation entries", () => {
  render(<App />);
  expect(screen.getByRole("button", { name: /Skills/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "工具" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /安装/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /设置/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /关于/ })).toBeInTheDocument();
});

test("renders about page project links", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: /关于/ }));

  expect(screen.getByRole("heading", { name: "SkillDock" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /GitHub 仓库/ })).toHaveAttribute(
    "href",
    "https://github.com/wanghuan9/skill-manager",
  );
  expect(screen.getByRole("link", { name: /意见反馈/ })).toHaveAttribute(
    "href",
    "https://github.com/wanghuan9/skill-manager/issues/new/choose",
  );
});
