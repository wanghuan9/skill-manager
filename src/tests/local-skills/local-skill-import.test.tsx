import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

test("renders local skill import list", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: /安装/ }));
  await userEvent.click(screen.getByRole("tab", { name: "本地安装" }));
  expect(screen.getByRole("heading", { name: "安装", level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "本地安装" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "本地导入" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "本地 skill 路径" })).toBeInTheDocument();
  expect(screen.getByText("发现本地 skill")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /excalidraw-diagram/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "查看可导入" }));
  expect(screen.getByRole("button", { name: /excalidraw-diagram/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /excalidraw-diagram/ }));
  expect(screen.getAllByRole("button", { name: "导入" })).toHaveLength(3);
});
