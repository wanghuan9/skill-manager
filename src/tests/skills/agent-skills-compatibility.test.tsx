import { render, screen } from "@testing-library/react";
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
      localPath: "/Users/demo/.cursor/skills/duplicate-skill",
      canonicalPath: "/Users/demo/.cursor/skills/duplicate-skill",
      entryPath: "/Users/demo/.agents/skills/duplicate-skill",
      managementOwner: "external",
      updateDriver: "none",
      skillEntries: ["/Users/demo/.agents/skills/duplicate-skill"],
    },
  );

  render(<App />);
  await user.click(screen.getByRole("button", { name: "卡片" }));

  expect(screen.getAllByRole("article", { name: "duplicate-skill" })).toHaveLength(2);
  expect(screen.getAllByText("SkillDock 托管").length).toBeGreaterThan(0);
  expect(screen.getByText("外部目录")).toBeInTheDocument();
});
