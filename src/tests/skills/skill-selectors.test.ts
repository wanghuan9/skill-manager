import { describe, expect, it } from "vitest";
import type { SkillSummary } from "@/features/skills/state/skill-store";
import { filterSkills } from "@/features/skills/state/skill-selectors";

function createSkill(overrides: Partial<SkillSummary>): SkillSummary {
  return {
    name: "demo-skill",
    sourceLabel: "GitHub",
    sourceType: "github",
    sourceUrl: "https://github.com/demo/repo",
    description: "",
    localPath: "/tmp/demo-skill",
    branch: "main",
    collabStatus: "clean",
    statusText: "",
    lastSyncedAt: "",
    lastCheckedAt: "",
    syncedToolCount: 0,
    lastEditor: "",
    commitLabel: "",
    gitLinked: true,
    tools: [],
    ...overrides,
  };
}

describe("filterSkills", () => {
  it("sorts skills not enabled in any tool first", () => {
    const skills = filterSkills(
      [
        createSkill({
          name: "enabled-skill",
          collabStatus: "pending-push",
          tools: [{ name: "Codex", statusLabel: "已同步" }],
        }),
        createSkill({
          name: "disabled-skill",
          collabStatus: "clean",
          tools: [{ name: "Codex", statusLabel: "未启用" }],
        }),
      ],
      { query: "", status: "all" },
    );

    expect(skills.map((skill) => skill.name)).toEqual(["disabled-skill", "enabled-skill"]);
  });

  it("keeps status priority and name sorting after enabled tool priority", () => {
    const skills = filterSkills(
      [
        createSkill({ name: "clean-skill", collabStatus: "clean" }),
        createSkill({ name: "update-skill", collabStatus: "update-available" }),
        createSkill({ name: "alpha-clean-skill", collabStatus: "clean" }),
      ],
      { query: "", status: "all" },
    );

    expect(skills.map((skill) => skill.name)).toEqual([
      "update-skill",
      "alpha-clean-skill",
      "clean-skill",
    ]);
  });
});
