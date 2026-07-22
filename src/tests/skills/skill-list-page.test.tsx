import { beforeEach, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";
import * as skillClient from "@/features/skills/api/skill-client";
import {
  installedSkillFixtures,
  workspaceSnapshotFixture,
} from "@/features/skills/state/skill-fixtures";

beforeEach(() => {
  window.localStorage.clear();
});

test("preserves the current Skill header layout and opens Skill install", async () => {
  const { container } = render(<App />);
  const header = container.querySelector(".page-header--split");
  expect(screen.getByRole("button", { name: /Skills/ })).toBeInTheDocument();
  expect(header).not.toHaveClass("management-page-header--compact");
  expect(screen.getByRole("heading", { name: "Skills", level: 1 })).toBeInTheDocument();
  expect(screen.getByText("~/.skilldock/skills · 已启用 4 · 可更新 1 · 待处理 2")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "更新 (1)" })).toBeInTheDocument();
  const searchInput = screen.getByPlaceholderText("搜索技能、描述或来源");
  expect(searchInput).toBeInTheDocument();
  expect(searchInput.closest("label")?.querySelector(".search-field__icon")).toBeInTheDocument();
  expect(screen.getByLabelText("按状态筛选技能")).toBeInTheDocument();
  const installButton = screen.getByRole("button", { name: "去安装" });
  expect(installButton).toHaveClass("skills-toolbar-button--go-install");
  expect(installButton).toHaveClass("secondary-button");
  expect(installButton.closest(".skills-header-bar__tools")).toBeInTheDocument();
  const titleRow = header?.querySelector(".page-header__row");
  const description = titleRow?.nextElementSibling;
  const sourceRow = description?.nextElementSibling;
  expect(titleRow?.querySelector("h1")).toHaveTextContent("Skills");
  expect(titleRow?.querySelector(".skills-header-bar__tools")).toBeInTheDocument();
  expect(description).toHaveTextContent("~/.skilldock/skills");
  expect(sourceRow?.querySelector("[role='tablist']")).toBeInTheDocument();
  expect(container.querySelector(".page-header-divider")).toHaveClass("page-header-divider--skills");

  await userEvent.click(installButton);
  expect(screen.getByRole("heading", { name: "安装", level: 1 })).toBeInTheDocument();
});

test("switches from the managed library to a tool's real Skill directory", async () => {
  const user = userEvent.setup();
  render(<App />);

  expect(screen.getByRole("tab", { name: "已托管 4" })).toHaveAttribute("aria-selected", "true");
  const codexSourceTab = screen.getByRole("tab", { name: "Codex 5" });
  expect(codexSourceTab).toHaveAttribute("title", "Codex");
  await user.click(codexSourceTab);

  expect(screen.getByRole("heading", { name: "Codex", level: 1 })).toBeInTheDocument();
  expect(screen.getByText("~/.codex/skills · 已托管 3 · 未托管 1 · 冲突 1")).toBeInTheDocument();
  const managementFilter = screen.getByLabelText("按托管状态筛选 Skill");
  expect(managementFilter).toHaveAttribute("data-value", "all");
  await user.click(managementFilter);
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
  expect(within(unmanagedCard).getByRole("button", { name: "导入 SkillDock" })).toBeInTheDocument();
  expect(screen.getByText("根据产品文档和需求输入整理技术设计骨架。")).toHaveClass("skill-card__summary-description");
  expect(screen.queryByText("/Users/demo/.codex/skills/technical-design")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "查看 technical-design 文件" })).toHaveClass("skill-card__icon-button");
  expect(screen.getByRole("button", { name: "删除 technical-design" })).toHaveClass("skill-card__icon-button");
  expect(screen.getByRole("button", { name: "导入 SkillDock" })).toHaveClass("skill-card__icon-button");
  expect(screen.getByPlaceholderText("搜索技能、描述或路径")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "更新 (1)" })).not.toBeInTheDocument();
});

test("shows a tool source as three-column cards with modal details", async () => {
  const user = userEvent.setup();
  const { container } = render(<App />);

  await user.click(screen.getByRole("button", { name: "分组" }));
  await user.click(screen.getByRole("tab", { name: "Codex 5" }));

  expect(screen.getByRole("button", { name: "列表" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: "分组" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "卡片" }));

  const cardGrid = container.querySelector(".card-list.skill-source-card-grid");
  const cards = Array.from(container.querySelectorAll(".skill-source-card--grid"));
  const initialSkillNames = cards.map((card) => card.getAttribute("aria-label"));
  expect(cardGrid).toBeInTheDocument();
  expect(cards).toHaveLength(5);
  expect(screen.getByRole("button", { name: "卡片" })).toHaveAttribute("aria-pressed", "true");

  const technicalDesignCard = screen.getByRole("article", { name: "technical-design" });
  expect(within(technicalDesignCard).getByText("未托管")).toHaveClass("tone-neutral");
  const entryKindBadge = within(technicalDesignCard).getByText("符号链接");
  expect(entryKindBadge).toHaveClass("skill-source-card__entry-kind");
  expect(entryKindBadge.parentElement).toHaveClass("skill-card__list-actions");
  expect(within(technicalDesignCard).getByRole("button", { name: "导入 SkillDock" })).toBeInTheDocument();
  expect(within(technicalDesignCard).getByRole("button", { name: "查看 technical-design 文件" })).toBeInTheDocument();
  expect(within(technicalDesignCard).getByRole("button", { name: "删除 technical-design" })).toBeInTheDocument();
  expect(technicalDesignCard.querySelector(".skill-card__chevron-button")).not.toBeInTheDocument();

  await user.click(within(technicalDesignCard).getByRole("button", { name: "technical-design" }));

  const detailDialog = screen.getByRole("dialog", { name: "technical-design 详情" });
  expect(detailDialog).toHaveClass("skill-card-detail-modal--source");
  const toolDescriptions = within(detailDialog).getAllByText("根据产品文档和需求输入整理技术设计骨架。");
  expect(toolDescriptions).toHaveLength(1);
  expect(toolDescriptions[0].closest("dd")).toBeInTheDocument();
  expect(within(detailDialog).getByRole("button", { name: "导入 SkillDock" })).toBeInTheDocument();
  expect(within(detailDialog).getByRole("button", { name: "查看 technical-design 文件" })).toBeInTheDocument();
  expect(within(detailDialog).getByRole("button", { name: "打开目录" })).toBeInTheDocument();
  expect(within(detailDialog).getByRole("button", { name: "关闭 technical-design 详情" })).toBeInTheDocument();
  expect(Array.from(container.querySelectorAll(".skill-source-card--grid")).map(
    (card) => card.getAttribute("aria-label"),
  )).toEqual(initialSkillNames);

  await user.click(within(detailDialog).getByRole("button", { name: "关闭 technical-design 详情" }));
  expect(screen.queryByRole("dialog", { name: "technical-design 详情" })).not.toBeInTheDocument();
});

test("expands one tool Skill detail at a time with actual local metadata", async () => {
  const user = userEvent.setup();
  const openFinderSpy = vi.spyOn(skillClient, "openPathInFinder").mockResolvedValue(undefined);
  render(<App />);

  await user.click(screen.getByRole("tab", { name: "Codex 5" }));

  const unmanagedCard = screen.getByRole("article", { name: "technical-design" });
  expect(within(unmanagedCard).getByRole("button", { name: "展开 technical-design" })).toBeInTheDocument();
  await user.click(within(unmanagedCard).getByRole("button", { name: "technical-design" }));

  const unmanagedDetails = within(unmanagedCard).getByRole("region", { name: "基本信息" });
  expect(within(unmanagedDetails).getByText("根据产品文档和需求输入整理技术设计骨架。")).toBeInTheDocument();
  expect(within(unmanagedDetails).getByText("Codex")).toBeInTheDocument();
  expect(within(unmanagedDetails).getByText("/Users/demo/shared-skills/technical-design")).toBeInTheDocument();
  expect(within(unmanagedDetails).getByText("符号链接")).toBeInTheDocument();
  expect(within(unmanagedDetails).getByText("未托管")).toBeInTheDocument();
  expect(within(unmanagedDetails).queryByText("/Users/demo/.codex/skills/technical-design")).not.toBeInTheDocument();
  const unmanagedFolderButton = within(unmanagedDetails).getByRole("button", {
    name: "打开目录 /Users/demo/shared-skills/technical-design",
  });
  expect(unmanagedFolderButton).toHaveClass("skill-card__icon-button");
  await user.click(unmanagedFolderButton);
  expect(openFinderSpy).toHaveBeenLastCalledWith({ path: "/Users/demo/shared-skills/technical-design" });

  const managedCard = screen.getByRole("article", { name: "skill-publisher" });
  await user.click(within(managedCard).getByRole("button", { name: "skill-publisher" }));

  expect(within(unmanagedCard).queryByRole("region", { name: "基本信息" })).not.toBeInTheDocument();
  const managedDetails = within(managedCard).getByRole("region", { name: "基本信息" });
  expect(within(managedDetails).getByText("/Users/demo/.skilldock/skills/skill-publisher")).toBeInTheDocument();
  expect(within(managedDetails).queryByText("文件类型")).not.toBeInTheDocument();
  expect(within(managedDetails).queryByText("真实目录")).not.toBeInTheDocument();
  const managedVersionButton = within(managedDetails).getByRole("button", { name: "查看托管版本" });
  expect(managedVersionButton.closest(".skill-card__section-header")).toBeInTheDocument();
  await user.click(within(managedDetails).getByRole("button", {
    name: "打开目录 /Users/demo/.skilldock/skills/skill-publisher",
  }));
  expect(openFinderSpy).toHaveBeenLastCalledWith({ path: "/Users/demo/.skilldock/skills/skill-publisher" });
  openFinderSpy.mockRestore();
});

test("opens and focuses the corresponding managed Skill from a tool directory", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: "分组" }));
  await user.click(screen.getByLabelText("按状态筛选技能"));
  await user.click(screen.getByRole("option", { name: "可更新 (1)" }));
  await user.click(screen.getByRole("tab", { name: "Codex 5" }));
  await user.type(screen.getByPlaceholderText("搜索技能、描述或路径"), "skill-publisher");

  const sourceCard = screen.getByRole("article", { name: "skill-publisher" });
  await user.click(within(sourceCard).getByRole("button", { name: "skill-publisher" }));
  await user.click(within(sourceCard).getByRole("button", { name: "查看托管版本" }));

  expect(screen.getByRole("tab", { name: "已托管 4" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByLabelText("按状态筛选技能")).toHaveAttribute("data-value", "all");
  expect(screen.getByPlaceholderText("搜索技能、描述或来源")).toHaveValue("");
  expect(screen.getByRole("button", { name: "收起来源分组 team-skills" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "收起 skill-publisher" })).toHaveAttribute("aria-expanded", "true");
});

test("closes the managed Skill detail opened from a tool card", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: "分组" }));
  await user.click(screen.getByRole("tab", { name: "Codex 5" }));
  await user.click(screen.getByRole("button", { name: "卡片" }));

  const sourceCard = screen.getByRole("article", { name: "skill-publisher" });
  await user.click(within(sourceCard).getByRole("button", { name: "skill-publisher" }));

  const sourceDialog = screen.getByRole("dialog", { name: "skill-publisher 详情" });
  await user.click(within(sourceDialog).getByRole("button", { name: "查看托管版本" }));

  const managedDialog = screen.getByRole("dialog", { name: "skill-publisher 详情" });
  await user.click(within(managedDialog).getByRole("button", { name: "关闭 skill-publisher 详情" }));

  expect(screen.queryByRole("dialog", { name: "skill-publisher 详情" })).not.toBeInTheDocument();
});

test("does not reopen a managed Skill detail after leaving and returning to Skills", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: "分组" }));
  await user.click(screen.getByRole("tab", { name: "Codex 5" }));
  await user.click(screen.getByRole("button", { name: "卡片" }));

  const sourceCard = screen.getByRole("article", { name: "skill-publisher" });
  await user.click(within(sourceCard).getByRole("button", { name: "skill-publisher" }));
  const sourceDialog = screen.getByRole("dialog", { name: "skill-publisher 详情" });
  await user.click(within(sourceDialog).getByRole("button", { name: "查看托管版本" }));

  const managedDialog = screen.getByRole("dialog", { name: "skill-publisher 详情" });
  await user.click(within(managedDialog).getByRole("button", { name: "关闭 skill-publisher 详情" }));
  expect(screen.queryByRole("dialog", { name: "skill-publisher 详情" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Plugins" }));
  expect(await screen.findByRole("heading", { name: "Plugins", level: 1 })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /Skills/ }));
  expect(await screen.findByRole("heading", { name: "Skills", level: 1 })).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "skill-publisher 详情" })).not.toBeInTheDocument();
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
  await user.click(screen.getByLabelText("按托管状态筛选 Skill"));
  await user.click(screen.getByRole("option", { name: "未托管 (1)" }));
  await user.click(screen.getByRole("button", { name: "导入 SkillDock" }));

  await waitFor(() => {
    expect(importSpy).toHaveBeenCalledWith("/Users/demo/.codex/skills/technical-design");
  });
  expect(await screen.findByText("technical-design 已导入 SkillDock")).toBeInTheDocument();
  importSpy.mockRestore();
});

test("uses list view by default when installed skill count is at or below threshold", () => {
  render(<App />);

  expect(screen.getByRole("button", { name: "列表" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("heading", { name: "skill-publisher" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "drawio-diagram" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "excalidraw-diagram" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /来源分组/ })).not.toBeInTheDocument();
});

test("places disabled skills after enabled skills in list and card views", async () => {
  const user = userEvent.setup();
  const disabledSkill = {
    ...installedSkillFixtures[0],
    name: "disabled-newer-skill",
    localUpdatedAt: "2026/7/18 12:00:00",
    tools: [{ name: "Codex", statusLabel: "未启用" }],
  };
  const enabledSkill = {
    ...installedSkillFixtures[1],
    name: "enabled-older-skill",
    localUpdatedAt: "2026/7/17 12:00:00",
    tools: [{ name: "Codex", statusLabel: "已同步" }],
  };
  workspaceSnapshotFixture.installedSkills = [disabledSkill, enabledSkill];
  const startupSkillsSpy = vi.spyOn(skillClient, "fetchStartupInstalledSkills").mockResolvedValue([
    disabledSkill,
    enabledSkill,
  ]);

  render(<App />);

  expect(screen.getAllByRole("article").map((article) => article.getAttribute("aria-label"))).toEqual([
    "enabled-older-skill",
    "disabled-newer-skill",
  ]);

  await user.click(screen.getByRole("button", { name: "卡片" }));

  expect(screen.getAllByRole("article").map((article) => article.getAttribute("aria-label"))).toEqual([
    "enabled-older-skill",
    "disabled-newer-skill",
  ]);
  startupSkillsSpy.mockRestore();
});

test("keeps the current skill order after toggling its enabled state", async () => {
  const enabledSkill = {
    ...installedSkillFixtures[0],
    name: "enabled-older-skill",
    localUpdatedAt: "2026/7/17 12:00:00",
    tools: [{ name: "Codex", statusLabel: "已同步" }],
  };
  const disabledSkill = {
    ...installedSkillFixtures[1],
    name: "disabled-newer-skill",
    localUpdatedAt: "2026/7/18 12:00:00",
    tools: [{ name: "Codex", statusLabel: "未启用" }],
  };
  const toggledSkill = {
    ...disabledSkill,
    tools: [{ name: "Codex", statusLabel: "已同步" }],
  };
  workspaceSnapshotFixture.installedSkills = [disabledSkill, enabledSkill];
  const startupSkillsSpy = vi.spyOn(skillClient, "fetchStartupInstalledSkills")
    .mockResolvedValue([disabledSkill, enabledSkill]);
  const toggleSkillSpy = vi.spyOn(skillClient, "setSkillAllToolStatuses").mockResolvedValue(toggledSkill);

  render(<App />);

  const getSkillOrder = () => screen.getAllByRole("article")
    .map((article) => article.getAttribute("aria-label"));
  expect(getSkillOrder()).toEqual(["enabled-older-skill", "disabled-newer-skill"]);

  await userEvent.click(screen.getByRole("button", { name: "启用 disabled-newer-skill 到全部工具" }));

  await waitFor(() => {
    expect(getSkillOrder()).toEqual(["enabled-older-skill", "disabled-newer-skill"]);
  });
  startupSkillsSpy.mockRestore();
  toggleSkillSpy.mockRestore();
});

test("opens card details in a modal without changing the card grid order", async () => {
  const user = userEvent.setup();
  const { container } = render(<App />);

  await user.click(screen.getByRole("button", { name: "卡片" }));

  expect(screen.getByRole("button", { name: "卡片" })).toHaveAttribute("aria-pressed", "true");
  expect(container.querySelector(".card-list.skill-card-grid")).toBeInTheDocument();
  expect(container.querySelectorAll(".skill-card-grid__row")).toHaveLength(2);
  expect(container.querySelectorAll(".skill-card--grid")).toHaveLength(4);

  const firstRow = container.querySelector(".skill-card-grid__row");
  const initialSkillNames = Array.from(firstRow?.children ?? []).map((element) => element.getAttribute("aria-label"));
  const excalidrawCard = screen.getByRole("article", { name: "excalidraw-diagram" });
  const excalidrawSummary = excalidrawCard.querySelector<HTMLElement>(".skill-card__summary-button");
  expect(excalidrawCard.querySelector(".skill-card__chevron-button")).not.toBeInTheDocument();
  expect(excalidrawSummary).toBeInTheDocument();

  await user.click(excalidrawSummary as HTMLElement);

  const expandedCard = screen.getByRole("article", { name: "excalidraw-diagram" });
  expect(expandedCard).toHaveClass("skill-card--grid", "is-expanded");
  expect(within(expandedCard).queryByText("本地更新时间")).not.toBeInTheDocument();

  const detailDialog = screen.getByRole("dialog", { name: "excalidraw-diagram 详情" });
  const managedDescriptions = within(detailDialog).getAllByText("用于生成 Excalidraw 风格的图表和草图。");
  expect(managedDescriptions).toHaveLength(1);
  expect(managedDescriptions[0].closest("dd")).toBeInTheDocument();
  expect(within(detailDialog).getByText("本地更新时间")).toBeInTheDocument();
  expect(within(detailDialog).getByRole("button", { name: "更新 excalidraw-diagram" })).toBeInTheDocument();
  expect(within(detailDialog).getByRole("button", { name: "查看 excalidraw-diagram 文件" })).toBeInTheDocument();
  expect(within(detailDialog).getByRole("button", { name: "打开 excalidraw-diagram 目录" })).toBeInTheDocument();
  expect(within(detailDialog).getByRole("button", { name: "关闭 excalidraw-diagram 详情" })).toBeInTheDocument();

  const currentSkillNames = Array.from(firstRow?.children ?? []).map((element) => element.getAttribute("aria-label"));
  expect(currentSkillNames).toEqual(initialSkillNames);

  await user.click(within(detailDialog).getByRole("button", { name: "查看 excalidraw-diagram 文件" }));
  expect(screen.queryByRole("dialog", { name: "excalidraw-diagram 详情" })).not.toBeInTheDocument();
  const fileDialog = await screen.findByRole("dialog", { name: "excalidraw-diagram" });
  await user.click(within(fileDialog).getByRole("button", { name: "关闭" }));
  expect(screen.getByRole("dialog", { name: "excalidraw-diagram 详情" })).toBeInTheDocument();

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "excalidraw-diagram 详情" })).not.toBeInTheDocument();
  expect(expandedCard).not.toHaveClass("is-expanded");
});

test("shows delete directly in card view", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "卡片" }));

  expect(screen.getByRole("button", { name: "删除 drawio-diagram" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "drawio-diagram 更多操作" })).not.toBeInTheDocument();
});

test("shows the grouped skill count beside the group title", async () => {
  const user = userEvent.setup();

  render(<App />);

  await user.click(screen.getByRole("button", { name: "分组" }));

  const teamGroupHeader = screen.getByRole("button", { name: "展开来源分组 team-skills" });
  const count = within(teamGroupHeader).getByText("2 个技能");

  expect(count.closest(".skill-group-section__name-row")).toBeTruthy();
});

test("filters grouped skills by selected status", async () => {
  const user = userEvent.setup();

  render(<App />);

  await user.click(screen.getByRole("button", { name: "分组" }));
  await user.click(screen.getByLabelText("按状态筛选技能"));
  await user.click(screen.getByRole("option", { name: "可更新 (1)" }));

  expect(screen.getByRole("button", { name: "展开来源分组 best-skills" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "展开来源分组 team-skills" })).not.toBeInTheDocument();
});

test("remembers expanded groups across app reopen", async () => {
  const user = userEvent.setup();
  const firstRender = render(<App />);

  await user.click(screen.getByRole("button", { name: "分组" }));
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

  await user.click(screen.getByRole("button", { name: "分组" }));

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
