import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

test("shows project Skills and keeps Agent CLI resources export-only", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "项目" }));

  expect(await screen.findByRole("heading", { name: "demo-workspace", level: 2 })).toBeInTheDocument();
  expect(screen.getByText("project-helper")).toBeInTheDocument();
  const agentCliCard = screen.getByText("brainstorming").closest("article");
  expect(agentCliCard).not.toBeNull();
  expect(within(agentCliCard!).getByText(/Agent CLI · 仅下发/)).toBeInTheDocument();
  expect(within(agentCliCard!).getByRole("button", { name: "更新项目" })).toBeInTheDocument();
  expect(within(agentCliCard!).queryByRole("button", { name: "同步回托管" })).not.toBeInTheDocument();
});

test("imports an existing project Skill into the managed library", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "项目" }));

  const projectSkillCard = (await screen.findByText("project-helper")).closest("article");
  expect(projectSkillCard).not.toBeNull();
  await userEvent.click(within(projectSkillCard!).getByRole("button", { name: "上传托管" }));

  expect(await screen.findByText("项目 Skill 已上传到托管")).toBeInTheDocument();
  expect(within(projectSkillCard!).queryByRole("button", { name: "上传托管" })).not.toBeInTheDocument();
});

test("previews project Skill differences before synchronizing", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "项目" }));

  const agentCliCard = (await screen.findByText("brainstorming")).closest("article");
  await userEvent.click(within(agentCliCard!).getByRole("button", { name: "更新项目" }));

  const dialog = await screen.findByRole("dialog", { name: "同步差异预览" });
  expect(within(dialog).getByText("托管 → 项目")).toBeInTheDocument();
  expect(within(dialog).getByText("SKILL.md")).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "确认同步" }));

  expect(await screen.findByText("同步完成")).toBeInTheDocument();
});

test("switches to project MCP and exposes project-only servers for import", async () => {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "项目" }));
  await userEvent.click(await screen.findByRole("tab", { name: /MCP/ }));

  const projectMcpCard = (await screen.findByText("project-notes")).closest("article");
  expect(projectMcpCard).not.toBeNull();
  expect(within(projectMcpCard!).getByRole("button", { name: "上传托管" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "下发 MCP" })).toBeInTheDocument();
});
