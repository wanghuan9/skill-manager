import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";
import { workspaceSnapshotFixture } from "@/features/skills/state/skill-fixtures";

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
