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
  await userEvent.click(within(agentCliCard!).getByRole("button", { name: "展开 brainstorming" }));
  const dialog = await screen.findByRole("dialog", { name: "brainstorming 详情" });
  expect(within(dialog).getByText(/Agent CLI · 仅下发/)).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "更新项目" })).toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "同步回托管" })).not.toBeInTheDocument();
});

test("imports an existing project Skill into the managed library", async () => {
  render(<App />);
  await openDemoProject();

  const projectSkillCard = (await screen.findByText("project-helper")).closest("article");
  expect(projectSkillCard).not.toBeNull();
  await userEvent.click(within(projectSkillCard!).getByRole("button", { name: "展开 project-helper" }));
  const dialog = await screen.findByRole("dialog", { name: "project-helper 详情" });
  await userEvent.click(within(dialog).getByRole("button", { name: "上传托管" }));

  expect(await screen.findByText("项目 Skill 已上传到托管")).toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "上传托管" })).not.toBeInTheDocument();
});

test("previews project Skill differences before synchronizing", async () => {
  render(<App />);
  await openDemoProject();

  const agentCliCard = (await screen.findByText("brainstorming")).closest("article");
  await userEvent.click(within(agentCliCard!).getByRole("button", { name: "展开 brainstorming" }));
  const detailDialog = await screen.findByRole("dialog", { name: "brainstorming 详情" });
  await userEvent.click(within(detailDialog).getByRole("button", { name: "更新项目" }));

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
  expect(workspaceToggle.querySelector(".project-folder-icon")).toHaveClass("is-open");
  expect(await screen.findByRole("button", { name: "demo-workspace" })).toBeInTheDocument();

  await userEvent.click(workspaceToggle);
  expect(workspaceToggle).toHaveAttribute("aria-expanded", "false");
  expect(workspaceToggle.querySelector(".project-folder-icon")).not.toHaveClass("is-open");
  expect(screen.queryByRole("button", { name: "demo-workspace" })).not.toBeInTheDocument();

  await userEvent.click(workspaceToggle);
  await openDemoProject();
  expect(screen.getByRole("button", { name: "demo-workspace" }).querySelector(".project-folder-icon")).toHaveClass(
    "is-open",
  );
  await userEvent.click(screen.getByRole("button", { name: "列表视图" }));
  expect(screen.getByText("brainstorming").closest("article")).toHaveClass("skill-card--list");
  await userEvent.click(screen.getByRole("button", { name: "卡片视图" }));
  expect(screen.getByText("brainstorming").closest("article")).toHaveClass("skill-card--grid");
});

test("groups the same project Skill across tools and exposes tool toggles in details", async () => {
  render(<App />);
  await openDemoProject();

  const skillHeadings = screen.getAllByRole("heading", { name: "skill-publisher", level: 3 });
  expect(skillHeadings).toHaveLength(1);
  expect(screen.getByText(/3 个 Skills/)).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "同步状态筛选" })).toHaveTextContent("全部状态 (3)");
  const skillCard = skillHeadings[0].closest("article");
  expect(skillCard).not.toBeNull();
  expect(within(skillCard!).getByText("多版本冲突")).toBeInTheDocument();

  await userEvent.click(within(skillCard!).getByRole("button", { name: "展开 skill-publisher" }));

  const dialog = await screen.findByRole("dialog", { name: "skill-publisher 详情" });
  expect(within(dialog).getAllByText("Claude Code")).not.toHaveLength(0);
  expect(within(dialog).getAllByText("Cursor")).not.toHaveLength(0);
  expect(within(dialog).getByRole("button", { name: "关闭 Claude Code" })).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "启用 Cursor" })).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "添加到 Codex" })).toHaveTextContent("未下发");

  await userEvent.click(within(dialog).getByRole("button", { name: "关闭 skill-publisher 详情" }));
  await userEvent.click(within(skillCard!).getByRole("button", { name: "启用 skill-publisher" }));
  expect(await screen.findByText("skill-publisher 已启用")).toBeInTheDocument();
  expect(within(skillCard!).getByRole("button", { name: "关闭 skill-publisher" })).toBeInTheDocument();
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

test("defaults to detected targets and supports selecting multiple Skills and tools", async () => {
  render(<App />);
  await openDemoProject();

  await userEvent.click(screen.getByRole("button", { name: /添加 Skill/ }));

  const dialog = screen.getByRole("dialog", { name: "下发 Skill" });
  expect(within(dialog).getByRole("button", { name: "Claude Code" })).toHaveAttribute("aria-pressed", "true");
  expect(within(dialog).getByRole("button", { name: "Codex" })).toHaveAttribute("aria-pressed", "true");
  expect(within(dialog).getByRole("button", { name: "Cursor" })).toHaveAttribute("aria-pressed", "true");
  expect(within(dialog).getByRole("button", { name: "Antigravity" })).toHaveAttribute("aria-pressed", "false");

  await userEvent.click(within(dialog).getByRole("checkbox", { name: /brainstorming/ }));
  await userEvent.click(within(dialog).getByRole("checkbox", { name: /skill-publisher/ }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Antigravity" }));

  expect(within(dialog).getByText("已选 2 个 Skill、4 个工具")).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "下发 2 个 Skill 到 4 个工具" })).toBeEnabled();
  expect(within(dialog).getByRole("button", { name: "关闭下发 Skill" })).toBeInTheDocument();
});

test("does not render a secondary project tool filter", async () => {
  render(<App />);
  await openDemoProject();

  expect(screen.queryByRole("button", { name: "全部工具" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Claude Code" })).not.toBeInTheDocument();
});
