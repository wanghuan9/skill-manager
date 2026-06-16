import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

export async function clickNavInstall() {
  const nav = screen.getByRole("navigation", { name: "Primary" });
  await userEvent.click(within(nav).getByRole("button", { name: "安装" }));
}
