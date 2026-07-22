import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

test("toggles Agent Skills CLI compatibility without presenting a library provider", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: /设置/ }));

  const compatibilitySwitch = screen.getByRole("button", { name: "切换 Agent CLI 兼容模式" });
  expect(compatibilitySwitch).toHaveAttribute("aria-pressed", "false");
  expect(screen.queryByLabelText("Skill 托管方式")).not.toBeInTheDocument();
  expect(screen.getByText(/开启后识别并管理 ~\/\.agents\/skills/)).toBeInTheDocument();
  expect(screen.queryByText("/Users/demo/.skilldock/skills")).not.toBeInTheDocument();
  expect(screen.queryByText("/Users/demo/.agents/skills")).not.toBeInTheDocument();

  await user.click(compatibilitySwitch);

  await waitFor(() => {
    expect(compatibilitySwitch).toHaveAttribute("aria-pressed", "true");
  });
});
