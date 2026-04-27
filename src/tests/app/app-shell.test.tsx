import { render, screen } from "@testing-library/react";
import { App } from "@/app/App";

test("renders primary navigation entries", () => {
  render(<App />);
  expect(screen.getByRole("button", { name: /Skills/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /工具/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /安装/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /设置/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /反馈/ })).toBeInTheDocument();
});
