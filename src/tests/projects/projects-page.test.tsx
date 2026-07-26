import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";

async function openDemoProject() {
  await userEvent.click(await screen.findByRole("button", { name: "demo-workspace" }));
}

test("shows project Skills and keeps Agent CLI resources export-only", async () => {
  render(<App />);

  await openDemoProject();

  expect(await screen.findByRole("heading", { name: "demo-workspace", level: 1 })).toBeInTheDocument();
  expect(screen.getByText("project-helper")).toBeInTheDocument();
  const agentCliCard = screen.getByText("brainstorming").closest("article");
  expect(agentCliCard).not.toBeNull();
  expect(within(agentCliCard!).getByText(/Agent CLI · 仅下发/)).toBeInTheDocument();
  expect(within(agentCliCard!).getByRole("button", { name: "更新项目" })).toBeInTheDocument();
  expect(within(agentCliCard!).queryByRole("button", { name: "同步回托管" })).not.toBeInTheDocument();
});

test("imports an existing project Skill into the managed library", async () => {
  render(<App />);
  await openDemoProject();

  const projectSkillCard = (await screen.findByText("project-helper")).closest("article");
  expect(projectSkillCard).not.toBeNull();
  await userEvent.click(within(projectSkillCard!).getByRole("button", { name: "上传托管" }));

  expect(await screen.findByText("项目 Skill 已上传到托管")).toBeInTheDocument();
  expect(within(projectSkillCard!).queryByRole("button", { name: "上传托管" })).not.toBeInTheDocument();
});

test("previews project Skill differences before synchronizing", async () => {
  render(<App />);
  await openDemoProject();

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
  await openDemoProject();
  await userEvent.click(await screen.findByRole("tab", { name: /MCP/ }));

  const projectMcpCard = (await screen.findByText("project-notes")).closest("article");
  expect(projectMcpCard).not.toBeNull();
  expect(within(projectMcpCard!).getByRole("button", { name: "上传托管" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /添加 MCP/ })).toBeInTheDocument();
});

test("collapses project workspaces and supports project card and list views", async () => {
  render(<App />);

  const workspaceToggle = screen.getByRole("button", { name: "项目" });
  expect(workspaceToggle).toHaveAttribute("aria-expanded", "true");
  expect(await screen.findByRole("button", { name: "demo-workspace" })).toBeInTheDocument();

  await userEvent.click(workspaceToggle);
  expect(workspaceToggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "demo-workspace" })).not.toBeInTheDocument();

  await userEvent.click(workspaceToggle);
  await openDemoProject();
  await userEvent.click(screen.getByRole("button", { name: "列表视图" }));
  expect(screen.getByText("brainstorming").closest("article")).toHaveClass("skill-card--list");
  await userEvent.click(screen.getByRole("button", { name: "卡片视图" }));
  expect(screen.getByText("brainstorming").closest("article")).toHaveClass("skill-card--grid");
});

test("searches project Skills without affecting the managed Skill list", async () => {
  render(<App />);
  await openDemoProject();

  await userEvent.type(screen.getByRole("searchbox", { name: "搜索项目资源" }), "project-helper");

  expect(screen.getByText("project-helper")).toBeInTheDocument();
  expect(screen.queryByText("brainstorming")).not.toBeInTheDocument();
});

test("adds a project from the workspace footer and selects it", async () => {
  render(<App />);
  await screen.findByRole("button", { name: "demo-workspace" });

  await userEvent.click(screen.getByRole("button", { name: "添加项目" }));

  expect(await screen.findByRole("button", { name: "new-project" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "new-project", level: 1 })).toBeInTheDocument();
  expect(screen.getByText("项目已加入管理")).toBeInTheDocument();
});

test("prevents distributing a duplicate Skill to the same project tool", async () => {
  render(<App />);
  await openDemoProject();

  await userEvent.click(screen.getByRole("button", { name: /添加 Skill/ }));

  const dialog = screen.getByRole("dialog", { name: "下发 Skill" });
  expect(within(dialog).getByText("目标工具中已存在同名资源，请修改名称或选择其他工具。")).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "下发到项目" })).toBeDisabled();
});
