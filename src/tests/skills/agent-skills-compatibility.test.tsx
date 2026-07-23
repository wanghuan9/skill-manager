import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { App } from "@/app/App";
import * as skillClient from "@/features/skills/api/skill-client";
import {
  appSettingsFixture,
  workspaceSnapshotFixture,
} from "@/features/skills/state/skill-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

test("prompts existing users up to three times when Agent Skills CLI is detected", async () => {
  const user = userEvent.setup();
  appSettingsFixture.agentSkillsCompatibilityEnabled = false;
  window.localStorage.setItem("skilldock.agentSkillsCompatibilityPromptCount", "2");
  const statusSpy = vi.spyOn(skillClient, "fetchAgentSkillsCliStatus").mockResolvedValue({
    available: true,
    globalPath: "/Users/demo/.agents/skills",
    entries: [],
    error: "",
  });

  const firstRender = render(<App />);

  expect(await screen.findByText("检测到 Agent Skills CLI，可在设置中开启兼容识别")).toBeInTheDocument();
  expect(window.localStorage.getItem("skilldock.agentSkillsCompatibilityPromptCount")).toBe("3");

  await user.click(screen.getByRole("button", { name: "前往设置" }));
  expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument();

  firstRender.unmount();
  render(<App />);

  expect(screen.queryByText("检测到 Agent Skills CLI，可在设置中开启兼容识别")).not.toBeInTheDocument();
  expect(statusSpy).toHaveBeenCalledTimes(1);
});

test("shows same-name Skill instances with their directory owners", async () => {
  const user = userEvent.setup();
  const baseSkill = workspaceSnapshotFixture.installedSkills[0];
  workspaceSnapshotFixture.installedSkills.unshift(
    {
      ...baseSkill,
      name: "duplicate-skill",
      localPath: "/Users/demo/.skilldock/skills/duplicate-skill",
      canonicalPath: "/Users/demo/.skilldock/skills/duplicate-skill",
      entryPath: "/Users/demo/.skilldock/skills/duplicate-skill",
      managementOwner: "skilldock",
      skillEntries: ["/Users/demo/.skilldock/skills/duplicate-skill"],
    },
    {
      ...baseSkill,
      name: "duplicate-skill",
      sourceLabel: "Agent Skills CLI",
      sourceType: "local",
      sourceUrl: "",
      localPath: "/Users/demo/.agents/skills/duplicate-skill",
      canonicalPath: "/Users/demo/.agents/skills/duplicate-skill",
      entryPath: "/Users/demo/.agents/skills/duplicate-skill",
      managementOwner: "agent-skills-cli",
      updateDriver: "agent-skills-cli",
      skillEntries: ["/Users/demo/.agents/skills/duplicate-skill"],
    },
  );

  render(<App />);
  await user.click(screen.getByRole("button", { name: "卡片" }));

  expect(screen.getAllByRole("article", { name: "duplicate-skill" })).toHaveLength(2);
  expect(screen.getAllByText("SkillDock").length).toBeGreaterThan(0);
  expect(screen.getByText(/Agent CLI/)).toBeInTheDocument();
  expect(screen.queryByText("外部目录")).not.toBeInTheDocument();

  await user.click(screen.getByRole("combobox", { name: "筛选 Skill" }));
  await user.click(screen.getByRole("option", { name: "Agent CLI (1)" }));

  expect(screen.getAllByRole("article", { name: "duplicate-skill" })).toHaveLength(1);
});

test("shows only the owner in tool Skill list and card layouts", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("tab", { name: "Codex 5" }));
  await user.click(screen.getByRole("button", { name: "列表" }));

  let sourceCard = screen.getByRole("article", { name: "skill-publisher" });
  const listOwner = within(sourceCard).getByText("SkillDock");
  const listStatus = within(sourceCard).getByText("已托管");
  expect(listOwner).toHaveClass("status-badge", "tone-neutral", "skill-card__owner-badge");
  expect(listOwner.compareDocumentPosition(listStatus)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

  await user.click(screen.getByRole("button", { name: "卡片" }));

  sourceCard = screen.getByRole("article", { name: "skill-publisher" });
  expect(within(sourceCard).getByText("已托管")).toBeInTheDocument();
  const ownerLabel = within(sourceCard).getByText("SkillDock");
  expect(ownerLabel).toHaveClass("skill-card__grid-source-text");
  expect(ownerLabel).not.toHaveClass(
    "status-badge",
  );
  expect(within(sourceCard).queryByText("Git · SkillDock")).not.toBeInTheDocument();
});
