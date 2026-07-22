import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { AppI18nProvider } from "@/app/i18n";
import { NotificationProvider } from "@/app/notifications";
import { SkillCard } from "@/features/skills/components/SkillCard";
import * as skillClient from "@/features/skills/api/skill-client";
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

  const { container } = renderSkillCardWithProviders(disabledSkill, "grid");

  expect(screen.getByText("未启用")).toHaveClass("tone-neutral");
  expect(screen.getByText("Git · SkillDock")).toBeInTheDocument();
  expect(screen.queryByText("GitLab")).not.toBeInTheDocument();
  expect(container.querySelector(".skill-card__list-actions .skill-card__grid-source-label")).toHaveTextContent(
    "Git · SkillDock",
  );
  expect(screen.getByRole("button", { name: "删除 drawio-diagram" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "drawio-diagram 更多操作" })).not.toBeInTheDocument();
});

test.each(["list", "grid"] as const)("bulk enables a skill from the %s action", async (layout) => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }
  const disabledSkill = {
    ...skill,
    tools: skill.tools.map((tool) => ({ ...tool, statusLabel: "未启用" })),
  };
  const bulkToggleSpy = vi.spyOn(skillClient, "setSkillAllToolStatuses");

  renderSkillCardWithProviders(disabledSkill, layout);

  const bulkToggleButton = screen.getByRole("button", { name: "启用 drawio-diagram 到全部工具" });
  expect(bulkToggleButton).toHaveClass("plugins-page__toggle-icon-button", "is-disabled");
  await userEvent.click(bulkToggleButton);

  await waitFor(() => {
    expect(bulkToggleSpy).toHaveBeenCalledWith(expect.objectContaining({
      skillName: "drawio-diagram",
      enabled: true,
    }));
  });
  bulkToggleSpy.mockRestore();
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
  expect(updateButton.closest(".skill-card__list-actions")?.querySelector("button")).toBe(updateButton);
  await userEvent.click(updateButton);
  expect(screen.queryByRole("dialog", { name: "更新 skill" })).not.toBeInTheDocument();
  expect(screen.queryByText("将拉取提交")).not.toBeInTheDocument();
});

test("keeps ownership beside the name and collaboration status in the right actions", () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }

  const { container } = renderSkillCardWithProviders(skill);
  const titleRow = container.querySelector(".skill-card__title-row");
  const actions = container.querySelector(".skill-card__list-actions");

  expect(titleRow).toHaveTextContent("drawio-diagramSkillDock已启用 2");
  expect(titleRow).not.toHaveTextContent("待推送");
  expect(titleRow?.querySelector(".skill-card__owner-badge")).toHaveClass(
    "status-badge",
    "tone-neutral",
  );
  expect(titleRow?.querySelector(".skill-card__owner-badge")).toHaveTextContent("SkillDock");
  expect(actions).toHaveTextContent("待推送");
  expect(actions?.firstElementChild).toHaveTextContent("待推送");
  expect(actions?.firstElementChild?.tagName).toBe("SPAN");
});

test("shows Agent CLI update action only after an update is detected", () => {
  const baseSkill = installedSkillFixtures.find((item) => item.name === "excalidraw-diagram");
  if (!baseSkill) {
    throw new Error("missing excalidraw-diagram fixture");
  }
  const cleanAgentSkill = {
    ...baseSkill,
    name: "agent-clean-skill",
    localPath: "/Users/demo/.agents/skills/agent-clean-skill",
    managementOwner: "agent-skills-cli" as const,
    updateDriver: "agent-skills-cli" as const,
    collabStatus: "clean" as const,
  };

  const { rerender } = renderSkillCardWithProviders(cleanAgentSkill);
  expect(screen.queryByRole("button", { name: /更新 agent-clean-skill/ })).not.toBeInTheDocument();

  rerender(
    <SkillWorkspaceProvider>
      <AppI18nProvider>
        <NotificationProvider>
          <SkillCard
            skill={{ ...cleanAgentSkill, collabStatus: "update-available" }}
            layout="list"
          />
        </NotificationProvider>
      </AppI18nProvider>
    </SkillWorkspaceProvider>,
  );
  expect(screen.getByRole("button", { name: /更新 agent-clean-skill/ })).toBeInTheDocument();
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
  expect(screen.getByText("来源方式")).toBeInTheDocument();
  expect(screen.getByText("托管方")).toBeInTheDocument();
  expect(screen.getByText("真实目录")).toBeInTheDocument();
  expect(screen.getByText("Git 仓库")).toBeInTheDocument();
});

test("opens the shared file dialog in local changes mode from a pending-push file entry", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "skill-publisher");
  if (!skill) {
    throw new Error("missing skill-publisher fixture");
  }

  renderSkillCardWithProviders(skill);
  const filesButton = screen.getByRole("button", { name: "查看 skill-publisher 文件与本地变更" });
  expect(filesButton.querySelector(".skill-card__change-count")).toHaveTextContent("4");
  expect(filesButton.querySelector('path[d="M4.5 5.5h5M7 3v5"]')).not.toBeInTheDocument();
  await userEvent.click(filesButton);

  expect(await screen.findByRole("dialog", { name: "skill-publisher" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "本地变更 0" })).toHaveAttribute("aria-pressed", "true");
});

test("keeps the file entry expanded in the grid detail header", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "skill-publisher");
  if (!skill) {
    throw new Error("missing skill-publisher fixture");
  }

  renderSkillCardWithProviders(skill, "grid");
  await userEvent.click(screen.getByRole("button", { name: /展开 skill-publisher/ }));

  const detailDialog = screen.getByRole("dialog", { name: "skill-publisher 详情" });
  const filesButton = within(detailDialog).getByRole("button", {
    name: "查看 skill-publisher 文件与本地变更",
  });
  expect(filesButton).toHaveClass("secondary-button", "skill-card-detail-modal__action");
  expect(filesButton).toHaveTextContent("本地变更");
  expect(filesButton.querySelector(".skill-card__change-count")).toHaveTextContent("4");
  expect(filesButton.querySelector('path[d="M4.5 5.5h5M7 3v5"]')).toBeInTheDocument();
  expect(filesButton.closest(".skill-card-detail-modal__header")).toBeInTheDocument();
});

test("shows the local changes action in expanded list details", async () => {
  const skill = installedSkillFixtures.find((item) => item.name === "skill-publisher");
  if (!skill) {
    throw new Error("missing skill-publisher fixture");
  }

  const { container } = renderSkillCardWithProviders(skill);
  await userEvent.click(screen.getByRole("button", { name: /展开 skill-publisher/ }));

  const details = container.querySelector<HTMLElement>(".skill-card__details");
  if (!details) {
    throw new Error("missing expanded list details");
  }
  const filesButton = within(details).getByRole("button", {
    name: "查看 skill-publisher 文件与本地变更",
  });
  expect(filesButton).toHaveTextContent("本地变更");
  expect(filesButton.querySelector('path[d="M4.5 5.5h5M7 3v5"]')).toBeInTheDocument();
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

test("keeps long descriptions intact for CSS truncation", () => {
  const skill = installedSkillFixtures.find((item) => item.name === "drawio-diagram");
  if (!skill) {
    throw new Error("missing drawio-diagram fixture");
  }
  const longDescription = "You MUST use this before any Java/Kotlin/XML/JS/TS code edit. Read company-standards.md and personal-standards.md first. Trigger: 优化, 重构, 修改, 改进, 实现, 调整, 类, 方法, 接口, optimize, refactor, modify, improve, method, class, function";
  renderSkillCardWithProviders({ ...skill, description: longDescription });

  expect(screen.getByText(longDescription)).toHaveClass("skill-card__summary-description");
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

  expect(container.querySelector(".skill-card__grid-meta .skill-card__grid-enabled-badge")).toHaveTextContent("已启用 8");
  expect(container.querySelectorAll(".skill-card__grid-meta .skill-card__tool-icon")).toHaveLength(6);
  expect(container.querySelector(".skill-card__grid-meta .skill-card__tool-tag--extra")).toHaveTextContent("+2");
  expect(container.querySelector(".skill-card__git-source-badge")).toBeNull();
  expect(container.querySelector(".skill-card__list-actions .skill-card__grid-source-label")).toHaveTextContent("Git · SkillDock");
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
