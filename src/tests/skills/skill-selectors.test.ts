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
    remoteUpdatedAt: "",
    localUpdatedAt: "",
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
  it("sorts by local updated time in descending order", () => {
    const skills = filterSkills(
      [
        createSkill({
          name: "older-skill",
          localUpdatedAt: "2026/5/9 09:00:00",
        }),
        createSkill({
          name: "newer-skill",
          localUpdatedAt: "2026/5/9 10:00:00",
        }),
      ],
      { query: "", status: "all" },
    );

    expect(skills.map((skill) => skill.name)).toEqual(["newer-skill", "older-skill"]);
  });

  it("keeps enabled-tool and status priority when local updated time is the same", () => {
    const skills = filterSkills(
      [
        createSkill({
          name: "enabled-clean-skill",
          collabStatus: "clean",
          localUpdatedAt: "2026/5/9 10:00:00",
          tools: [{ name: "Codex", statusLabel: "已同步" }],
        }),
        createSkill({
          name: "disabled-clean-skill",
          collabStatus: "clean",
          localUpdatedAt: "2026/5/9 10:00:00",
          tools: [{ name: "Codex", statusLabel: "未启用" }],
        }),
        createSkill({
          name: "update-skill",
          collabStatus: "update-available",
          localUpdatedAt: "2026/5/9 10:00:00",
        }),
        createSkill({
          name: "pending-push-skill",
          collabStatus: "pending-push",
          localUpdatedAt: "2026/5/9 10:00:00",
        }),
        createSkill({
          name: "pending-commit-skill",
          collabStatus: "pending-commit",
          localUpdatedAt: "2026/5/9 10:00:00",
        }),
      ],
      { query: "", status: "all" },
    );

    expect(skills.map((skill) => skill.name)).toEqual([
      "pending-commit-skill",
      "pending-push-skill",
      "update-skill",
      "disabled-clean-skill",
      "enabled-clean-skill",
    ]);
  });

  it("matches query against skill descriptions", () => {
    const skills = filterSkills(
      [
        createSkill({
          name: "diagram-helper",
          description: "Builds editable architecture diagrams.",
        }),
        createSkill({
          name: "release-helper",
          description: "Prepares release notes.",
        }),
      ],
      { query: "architecture", status: "all" },
    );

    expect(skills.map((skill) => skill.name)).toEqual(["diagram-helper"]);
  });

  it("combines management owner, query, and status filters", () => {
    const skills = filterSkills(
      [
        createSkill({
          name: "skilldock-agent-update",
          collabStatus: "update-available",
          managementOwner: "skilldock",
        }),
        createSkill({
          name: "agent-update",
          collabStatus: "update-available",
          managementOwner: "agent-skills-cli",
        }),
        createSkill({
          name: "agent-clean",
          collabStatus: "clean",
          managementOwner: "agent-skills-cli",
        }),
      ],
      {
        query: "agent",
        status: "update-available",
        owner: "agent-skills-cli",
      },
    );

    expect(skills.map((skill) => skill.name)).toEqual(["agent-update"]);
  });

  it("filters skills that are not enabled in any tool", () => {
    const skills = filterSkills(
      [
        createSkill({
          name: "enabled-skill",
          tools: [{ name: "Codex", statusLabel: "已同步" }],
        }),
        createSkill({
          name: "resync-skill",
          tools: [{ name: "Codex", statusLabel: "需要重同步" }],
        }),
        createSkill({
          name: "disabled-skill",
          tools: [{ name: "Codex", statusLabel: "未启用" }],
        }),
        createSkill({
          name: "empty-tool-skill",
          tools: [],
        }),
      ],
      { query: "", status: "disabled" },
    );

    expect(skills.map((skill) => skill.name)).toEqual(["disabled-skill", "empty-tool-skill"]);
  });
});
