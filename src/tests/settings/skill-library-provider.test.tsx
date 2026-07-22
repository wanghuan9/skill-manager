import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

test("switches to the Agent Skills CLI global library from settings", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: /设置/ }));

  const providerSelect = screen.getByLabelText("Skill 托管方式");
  expect(providerSelect).toHaveTextContent("SkillDock 默认目录");
  expect(screen.getByText("/Users/demo/.skilldock/skills")).toBeInTheDocument();

  await user.click(providerSelect);
  await user.click(screen.getByRole("option", { name: "Agent Skills CLI 兼容模式" }));

  expect(providerSelect).toHaveTextContent("Agent Skills CLI 兼容模式");
  expect(screen.getByText("/Users/demo/.agents/skills")).toBeInTheDocument();
});
