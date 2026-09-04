import { act, render, screen, waitFor, within } from "@testing-library/react";
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
  appSettingsFixture.skillLibraryProvider = "skilldock";
  appSettingsFixture.agentSkillsCompatibilityEnabled = false;
  appSettingsFixture.agentSkillsCompatibilityConfigured = true;
  window.localStorage.removeItem("skilldock.agentSkillsCompatibilityPromptCount");
});

test("prompts unconfigured existing users without checking Agent Skills CLI", async () => {
  const user = userEvent.setup();
  appSettingsFixture.skillLibraryProvider = "skilldock";
  appSettingsFixture.agentSkillsCompatibilityEnabled = false;
  appSettingsFixture.agentSkillsCompatibilityConfigured = false;
  window.localStorage.setItem("skilldock.agentSkillsCompatibilityPromptCount", "3");
  const statusSpy = vi.spyOn(skillClient, "fetchAgentSkillsCliStatus");

  render(<App />);

  expect(await screen.findByText("检测到 Agent Skills CLI，可在设置中开启兼容识别")).toBeInTheDocument();
  expect(window.localStorage.getItem("skilldock.agentSkillsCompatibilityPromptCount")).toBe("4");
  expect(appSettingsFixture.agentSkillsCompatibilityConfigured).toBe(false);
  expect(statusSpy).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "前往设置" }));
  expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument();
});

test("writes compatibility disabled after the fifth prompt", async () => {
  appSettingsFixture.skillLibraryProvider = "skilldock";
  appSettingsFixture.agentSkillsCompatibilityEnabled = false;
  appSettingsFixture.agentSkillsCompatibilityConfigured = false;
  window.localStorage.setItem("skilldock.agentSkillsCompatibilityPromptCount", "4");

  let firstRender: ReturnType<typeof render>;
  await act(async () => {
    firstRender = render(<App />);
  });

  expect(await screen.findByText("检测到 Agent Skills CLI，可在设置中开启兼容识别")).toBeInTheDocument();
  expect(window.localStorage.getItem("skilldock.agentSkillsCompatibilityPromptCount")).toBe("5");
  await waitFor(() => {
    expect(appSettingsFixture.agentSkillsCompatibilityConfigured).toBe(true);
  });
  expect(appSettingsFixture.agentSkillsCompatibilityEnabled).toBe(false);

  firstRender!.unmount();
  await act(async () => {
    render(<App />);
  });

  expect(screen.queryByText("检测到 Agent Skills CLI，可在设置中开启兼容识别")).not.toBeInTheDocument();
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
  expect(screen.getAllByRole("article", { name: "duplicate-skill" })
    .some((article) => article.textContent?.includes("Agent CLI"))).toBe(true);
  expect(screen.queryByText("外部目录")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Agent CLI" }));
  expect(screen.getByRole("button", { name: "Agent CLI" }))
    .toHaveAttribute("aria-pressed", "true");

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
