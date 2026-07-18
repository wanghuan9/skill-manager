import { beforeEach, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";
import * as skillClient from "@/features/skills/api/skill-client";

beforeEach(() => {
  window.localStorage.clear();
});

test("renders installed skill page header and search input", () => {
  render(<App />);
  expect(screen.getByRole("button", { name: /Skills/ })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Skills", level: 1 })).toBeInTheDocument();
  expect(screen.getByText("~/.skilldock/skills · 已启用 4 · 可更新 1 · 待推送 2")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "更新 (1)" })).toBeInTheDocument();
  expect(screen.getByPlaceholderText("搜索技能名称、描述、来源...")).toBeInTheDocument();
  expect(screen.getByLabelText("按状态筛选技能")).toBeInTheDocument();
});

test("switches from the managed library to a tool's real Skill directory", async () => {
  const user = userEvent.setup();
  render(<App />);

  expect(screen.getByRole("tab", { name: "已托管 4" })).toHaveAttribute("aria-selected", "true");
  await user.click(screen.getByRole("tab", { name: "Codex 5" }));

  expect(screen.getByRole("heading", { name: "Codex", level: 1 })).toBeInTheDocument();
  expect(screen.getByText("~/.codex/skills · 已托管 3 · 未托管 1 · 冲突 1")).toBeInTheDocument();
  const managementFilter = screen.getByLabelText("按托管状态筛选 Skill");
  expect(managementFilter).toHaveValue("all");
  expect(screen.getByRole("option", { name: "全部 (5)" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "已托管 (3)" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "未托管 (1)" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "冲突 (1)" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "未托管 1" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "technical-design" })).toBeInTheDocument();
  const managedCard = screen.getByRole("article", { name: "skill-publisher" });
  expect(within(managedCard).getByText("已托管")).toHaveClass("tone-positive");
  const unmanagedCard = screen.getByRole("article", { name: "technical-design" });
  expect(within(unmanagedCard).getByText("未托管")).toHaveClass("tone-neutral");
  expect(within(unmanagedCard).getByText("符号链接")).toHaveClass("tone-info");
  expect(within(unmanagedCard).getAllByRole("button")[0]).toHaveAccessibleName("导入 SkillDock");
  expect(screen.getByText("根据产品文档和需求输入整理技术设计骨架。")).toHaveClass("skill-card__summary-description");
  expect(screen.queryByText("/Users/demo/.codex/skills/technical-design")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "查看 technical-design 文件" })).toHaveClass("skill-card__icon-button");
  expect(screen.getByRole("button", { name: "删除 technical-design" })).toHaveClass("skill-card__icon-button");
  expect(screen.getByRole("button", { name: "导入 SkillDock" })).toHaveClass("skill-card__icon-button");
  expect(screen.getByPlaceholderText("搜索技能名称、描述、路径...")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "更新 (1)" })).not.toBeInTheDocument();
});

test("keeps a source selected from More visible in the flat source bar", async () => {
  const user = userEvent.setup();
  render(<App />);

  expect(screen.getByRole("button", { name: /更多/ })).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: /Antigravity/ })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /更多/ }));
  await user.click(screen.getByRole("menuitem", { name: /Antigravity/ }));

  expect(screen.getByRole("tab", { name: /Antigravity/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test("views a tool Skill's actual files in a read-only dialog", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("tab", { name: "Codex 5" }));
  await user.click(screen.getByRole("button", { name: "查看 technical-design 文件" }));

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("heading", { name: "technical-design" })).toBeInTheDocument();
  expect(within(dialog).getAllByText("SKILL.md")).toHaveLength(2);
  expect(within(dialog).queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
});

test("removes a Skill only from the selected tool after confirmation", async () => {
  const user = userEvent.setup();
  const deleteSpy = vi.spyOn(skillClient, "deleteToolSkill");
  render(<App />);

  await user.click(screen.getByRole("tab", { name: "Codex 5" }));
  await user.click(screen.getByRole("button", { name: "删除 technical-design" }));
  await user.click(screen.getByRole("button", { name: "确认 technical-design" }));

  await waitFor(() => {
    expect(deleteSpy).toHaveBeenCalledWith({ toolId: "codex", skillName: "technical-design" });
  });
  expect(screen.queryByRole("heading", { name: "technical-design" })).not.toBeInTheDocument();
  expect(await screen.findByText("已从 Codex 移除 technical-design")).toBeInTheDocument();
  deleteSpy.mockRestore();
});

test("imports an unmanaged tool Skill through the existing local import flow", async () => {
  const user = userEvent.setup();
  const importSpy = vi.spyOn(skillClient, "importLocalSkill");
  render(<App />);

  await user.click(screen.getByRole("tab", { name: "Codex 5" }));
  await user.selectOptions(screen.getByLabelText("按托管状态筛选 Skill"), "unmanaged");
  await user.click(screen.getByRole("button", { name: "导入 SkillDock" }));

  await waitFor(() => {
    expect(importSpy).toHaveBeenCalledWith("/Users/demo/.codex/skills/technical-design");
  });
  expect(await screen.findByText("technical-design 已导入 SkillDock")).toBeInTheDocument();
  importSpy.mockRestore();
});

test("uses flat view by default when installed skill count is at or below threshold", () => {
  render(<App />);

  expect(screen.getByRole("button", { name: "平铺" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "skill-publisher" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "drawio-diagram" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "excalidraw-diagram" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /来源分组/ })).not.toBeInTheDocument();
});

test("shows the grouped skill count beside the group title", async () => {
  const user = userEvent.setup();

  render(<App />);

  await user.click(screen.getByRole("button", { name: "平铺" }));

  const teamGroupHeader = screen.getByRole("button", { name: "展开来源分组 team-skills" });
  const count = within(teamGroupHeader).getByText("2 个技能");

  expect(count.closest(".skill-group-section__name-row")).toBeTruthy();
});

test("filters grouped skills by selected status", async () => {
  const user = userEvent.setup();

  render(<App />);

  await user.click(screen.getByRole("button", { name: "平铺" }));
  await user.selectOptions(screen.getByLabelText("按状态筛选技能"), "update-available");

  expect(screen.getByRole("button", { name: "展开来源分组 best-skills" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "展开来源分组 team-skills" })).not.toBeInTheDocument();
});

test("remembers expanded groups across app reopen", async () => {
  const user = userEvent.setup();
  const firstRender = render(<App />);

  await user.click(screen.getByRole("button", { name: "平铺" }));
  await user.click(screen.getByRole("button", { name: "展开来源分组 team-skills" }));

  expect(screen.getByRole("heading", { name: "skill-publisher" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "drawio-diagram" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "收起来源分组 team-skills" })).toBeInTheDocument();

  firstRender.unmount();
  render(<App />);

  expect(screen.getByRole("heading", { name: "skill-publisher" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "drawio-diagram" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "excalidraw-diagram" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "收起来源分组 team-skills" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开来源分组 best-skills" })).toBeInTheDocument();
});

test("remembers the user's last grouped view selection", async () => {
  const user = userEvent.setup();
  const firstRender = render(<App />);

  await user.click(screen.getByRole("button", { name: "平铺" }));

  expect(screen.getByRole("button", { name: "分组" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开来源分组 team-skills" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "skill-publisher" })).not.toBeInTheDocument();

  firstRender.unmount();
  render(<App />);

  expect(screen.getByRole("button", { name: "分组" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开来源分组 team-skills" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "skill-publisher" })).not.toBeInTheDocument();
});

test("expanding one skill collapses the previously opened skill in flat view", async () => {
  const user = userEvent.setup();

  render(<App />);

  await user.click(screen.getByRole("button", { name: "展开 drawio-diagram" }));
  expect(screen.getByRole("button", { name: "收起 drawio-diagram" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("本地更新时间")).toBeInTheDocument();
  expect(screen.getByText("https://gitlab.com/team/skills/drawio-diagram")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "展开 excalidraw-diagram" }));

  expect(screen.getByRole("button", { name: "展开 drawio-diagram" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: "收起 excalidraw-diagram" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByText("https://gitlab.com/team/skills/drawio-diagram")).not.toBeInTheDocument();
  expect(screen.getByText("https://github.com/xstongxue/best-skills/tree/main")).toBeInTheDocument();
  expect(screen.getByText("更新人")).toBeInTheDocument();
});
