import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { AppI18nProvider } from "@/app/i18n";
import { NotificationProvider } from "@/app/notifications";
import { SkillCard } from "@/features/skills/components/SkillCard";
import { installedSkillFixtures } from "@/features/skills/state/skill-fixtures";
import { SkillWorkspaceProvider } from "@/features/skills/state/skill-workspace";

function renderSkillCardWithProviders(
  skill: (typeof installedSkillFixtures)[number],
  layout: "list" | "grid" = "list",
) {
  return render(
    <SkillWorkspaceProvider>
      <AppI18nProvider>
        <NotificationProvider>
          <SkillCard skill={skill} layout={layout} />
        </NotificationProvider>
      </AppI18nProvider>
    </SkillWorkspaceProvider>,
  );
}

test("uses the neutral list color for disabled card status", () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }
  const disabledSkill = {
    ...skill,
    tools: skill.tools.map((tool) => ({ ...tool, statusLabel: "未启用" })),
  };

  renderSkillCardWithProviders(disabledSkill, "grid");

  expect(screen.getByText("未启用")).toHaveClass("tone-neutral");
  expect(screen.getByText("GitLab")).toBeInTheDocument();
  expect(screen.queryByText("GitLab · 已托管")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "删除 drawio-diagram" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "drawio-diagram 更多操作" })).not.toBeInTheDocument();
});

test("updates directly from list action when skill has remote update", async () => {
  const updateSkill = installedSkillFixtures.find((skill) => skill.name === "excalidraw-diagram");
  if (!updateSkill) {
    throw new Error("missing excalidraw-diagram fixture");
  }

  renderSkillCardWithProviders(updateSkill);
  expect(screen.getByText("excalidraw-diagram")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "更新" })).not.toBeInTheDocument();
  const updateButton = screen.getByRole("button", { name: /更新 excalidraw-diagram/ });
  expect(updateButton).toBeInTheDocument();
  await userEvent.click(updateButton);
  expect(screen.queryByRole("dialog", { name: "更新 skill" })).not.toBeInTheDocument();
  expect(screen.queryByText("将拉取提交")).not.toBeInTheDocument();
});

test("shows description in the list summary and keeps update metadata in details", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }

  renderSkillCardWithProviders(skill);

  expect(screen.getByText("将结构描述转成可编辑的 Draw.io 图表。")).toBeInTheDocument();
  expect(screen.queryByText("更新时间：")).not.toBeInTheDocument();
  expect(screen.queryByText("远端更新时间：")).not.toBeInTheDocument();
  expect(screen.queryByText("更新人：")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /展开 drawio-diagram/ }));

  expect(screen.getByText(/远端更新时间/)).toBeInTheDocument();
  expect(screen.getByText(/本地更新时间/)).toBeInTheDocument();
  expect(screen.getByText(/更新人/)).toBeInTheDocument();
});

test("hides remote update metadata for non-git skill details", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }
  const marketplaceLikeSkill = {
    ...skill,
    sourceType: "github" as const,
    sourceUrl: "https://skills.sh/skills/drawio-diagram",
    gitLinked: false,
    remoteUpdatedAt: "2026/5/12 11:38:11",
    localUpdatedAt: "2026/5/12 09:20:00",
    lastEditor: "Someone",
  };

  renderSkillCardWithProviders(marketplaceLikeSkill);

  await userEvent.click(screen.getByRole("button", { name: /展开 drawio-diagram/ }));

  expect(screen.queryByText(/远端更新时间/)).not.toBeInTheDocument();
  expect(screen.queryByText(/更新人/)).not.toBeInTheDocument();
  expect(screen.getByText("本地更新时间")).toBeInTheDocument();
  expect(screen.getByText("2026/5/12 09:20:00")).toBeInTheDocument();
});

test("truncates long descriptions in the list summary", () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }
  const longDescription = "You MUST use this before any Java/Kotlin/XML/JS/TS code edit. Read company-standards.md and personal-standards.md first. Trigger: 优化, 重构, 修改, 改进, 实现, 调整, 类, 方法, 接口, optimize, refactor, modify, improve, method, class, function";
  const expectedSummary = `${longDescription.slice(0, 76).trimEnd()}...`;

  renderSkillCardWithProviders({ ...skill, description: longDescription });

  expect(screen.getByText(expectedSummary)).toBeInTheDocument();
  expect(screen.queryByText(longDescription)).not.toBeInTheDocument();
});

test("hides remote updated time for local skill details", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }
  const localSkill = {
    ...skill,
    sourceLabel: "本地安装",
    sourceType: "local" as const,
    sourceUrl: "/Users/demo/.cursor/skills/drawio-diagram",
    remoteUpdatedAt: "2026/5/12 11:38:11",
    localUpdatedAt: "2026/5/12 09:20:00",
    lastEditor: "",
  };

  renderSkillCardWithProviders(localSkill);

  await userEvent.click(screen.getByRole("button", { name: /展开 drawio-diagram/ }));

  expect(screen.queryByText("远端更新时间")).not.toBeInTheDocument();
  expect(screen.queryByText("更新人")).not.toBeInTheDocument();
  expect(screen.getByText("本地更新时间")).toBeInTheDocument();
  expect(screen.getByText("2026/5/12 09:20:00")).toBeInTheDocument();
});

test("sanitizes trailing emoticon in remote updater", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "excalidraw-diagram");
  if (!skill) {
    throw new Error("missing excalidraw-diagram fixture");
  }

  renderSkillCardWithProviders({ ...skill, lastEditor: "Agent Fitz ;-)" });

  await userEvent.click(screen.getByRole("button", { name: /展开 excalidraw-diagram/ }));

  expect(screen.getByText("更新人")).toBeInTheDocument();
  expect(screen.getByText("Agent Fitz")).toBeInTheDocument();
  expect(screen.queryByText("Agent Fitz ;-)")).not.toBeInTheDocument();
});

test("opens skill file dialog from fixed action button", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }

  renderSkillCardWithProviders(skill);

  await userEvent.click(screen.getByRole("button", { name: /查看 drawio-diagram 文件/ }));

  expect(screen.getByRole("dialog", { name: "drawio-diagram" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
});

test("shows fixed open action button on skill card", () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }

  renderSkillCardWithProviders(skill);

  expect(screen.getByRole("button", { name: /打开 drawio-diagram 目录/ })).toBeInTheDocument();
});

test("renders enabled tools as a compact summary pill", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "multi-search-engine");
  if (!skill) {
    throw new Error("missing multi-search-engine fixture");
  }

  const { container } = renderSkillCardWithProviders(skill);
  const enabledToolsButton = screen.getByRole("button", {
    name: "已启用工具：Claude Code、Codex、Cursor、Devin",
  });

  expect(enabledToolsButton).toHaveTextContent("已启用 4");
  expect(container.querySelectorAll(".skill-card__tool-icon")).toHaveLength(0);

  await userEvent.click(enabledToolsButton);

  expect(container.querySelectorAll(".skill-card__tool-icon")).toHaveLength(4);
  expect(container.querySelector(".skill-card__title-row .skill-card__summary-tools")).toBeInTheDocument();
});

test("keeps expanded enabled tools in a stable shared order", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "multi-search-engine");
  if (!skill) {
    throw new Error("missing multi-search-engine fixture");
  }
  const skillWithManyTools = {
    ...skill,
    tools: [
      { name: "Devin", statusLabel: "已同步" },
      { name: "Continue", statusLabel: "已同步" },
      { name: "Cursor", statusLabel: "已同步" },
      { name: "Antigravity", statusLabel: "已同步" },
      { name: "Gemini CLI", statusLabel: "已同步" },
      { name: "OpenCode", statusLabel: "已同步" },
      { name: "Codex", statusLabel: "已同步" },
      { name: "Claude Code", statusLabel: "已同步" },
    ],
  };

  const { container } = renderSkillCardWithProviders(skillWithManyTools);
  const enabledToolsButton = screen.getByRole("button", {
    name: "已启用工具：Claude Code、Codex、OpenCode、Cursor、Gemini CLI、Antigravity、Devin、Continue",
  });

  expect(enabledToolsButton).toHaveTextContent("已启用 8");

  await userEvent.click(enabledToolsButton);

  expect(container.querySelectorAll(".skill-card__tool-icon")).toHaveLength(8);
  expect(container.querySelector(".skill-card__title-row .skill-card__summary-tools")).toBeInTheDocument();
});

test("shows up to six enabled tools in the card summary", () => {
  const skill = installedSkillFixtures.find((item) => item.name === "multi-search-engine");
  if (!skill) {
    throw new Error("missing multi-search-engine fixture");
  }
  const skillWithManyTools = {
    ...skill,
    tools: [
      { name: "Devin", statusLabel: "已同步" },
      { name: "Continue", statusLabel: "已同步" },
      { name: "Cursor", statusLabel: "已同步" },
      { name: "Antigravity", statusLabel: "已同步" },
      { name: "Gemini CLI", statusLabel: "已同步" },
      { name: "OpenCode", statusLabel: "已同步" },
      { name: "Codex", statusLabel: "已同步" },
      { name: "Claude Code", statusLabel: "已同步" },
    ],
  };

  const { container } = renderSkillCardWithProviders(skillWithManyTools, "grid");

  expect(container.querySelectorAll(".skill-card__grid-meta .skill-card__tool-icon")).toHaveLength(6);
  expect(container.querySelector(".skill-card__grid-meta .skill-card__tool-tag--extra")).toHaveTextContent("+2");
});

test("uses inline confirmation before deleting a skill", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }

  renderSkillCardWithProviders(skill);

  await userEvent.click(screen.getByRole("button", { name: /删除 drawio-diagram/ }));

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /确认 drawio-diagram/ })).toHaveTextContent("确认");
  expect(screen.getByText("drawio-diagram")).toBeInTheDocument();
});

test("renders enabled tool with checkmark in tool sync panel", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }

  renderSkillCardWithProviders(skill);

  await userEvent.click(screen.getByRole("button", { name: /展开 drawio-diagram/ }));

  expect(screen.getAllByRole("button", { name: /取消启用/ }).length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: /IntelliJ IDEA/ })).not.toBeInTheDocument();
});

test("opens GitHub source url from skill card details", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "excalidraw-diagram");
  if (!skill) {
    throw new Error("missing excalidraw-diagram fixture");
  }
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

  renderSkillCardWithProviders(skill);

  await userEvent.click(screen.getByRole("button", { name: /展开 excalidraw-diagram/ }));
  await userEvent.click(screen.getByRole("link", { name: "https://github.com/xstongxue/best-skills/tree/main" }));

  expect(openSpy).toHaveBeenCalledWith(
    "https://github.com/xstongxue/best-skills/tree/main",
    "_blank",
    "noopener,noreferrer",
  );
});
