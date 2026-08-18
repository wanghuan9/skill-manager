import { describe, expect, it } from "vitest";
import type { SkillSummary } from "@/features/skills/state/skill-store";
import { compareSkillsByEnablement, filterSkills } from "@/features/skills/state/skill-selectors";

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

  it("places enabled skills before newer disabled skills", () => {
    const skills = filterSkills(
      [
        createSkill({
          name: "newer-disabled-skill",
          localUpdatedAt: "2026/5/9 10:00:00",
          tools: [{ name: "Codex", statusLabel: "未启用" }],
        }),
        createSkill({
          name: "older-enabled-skill",
          localUpdatedAt: "2026/5/9 09:00:00",
          tools: [{ name: "Codex", statusLabel: "已同步" }],
        }),
      ],
      { query: "", status: "all" },
    );

    expect(skills.map((skill) => skill.name)).toEqual(["older-enabled-skill", "newer-disabled-skill"]);
  });

  it("keeps enablement and status priority when local updated time is the same", () => {
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
      "enabled-clean-skill",
      "pending-commit-skill",
      "pending-push-skill",
      "update-skill",
      "disabled-clean-skill",
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

  it("matches query against skill tags", () => {
    const skills = filterSkills(
      [
        createSkill({ name: "diagram-helper", tag: "研发工具" }),
        createSkill({ name: "release-helper", tag: "发布" }),
      ],
      { query: "研发", status: "all" },
    );

    expect(skills.map((skill) => skill.name)).toEqual(["diagram-helper"]);
  });

  it("filters by an exact tag and supports untagged skills", () => {
    const skillFixtures = [
      createSkill({ name: "workflow-a", tag: "Workflow" }),
      createSkill({ name: "workflow-b", tag: "workflow" }),
      createSkill({ name: "release", tag: "发布" }),
      createSkill({ name: "untagged", tag: "" }),
    ];

    expect(filterSkills(skillFixtures, {
      query: "",
      status: "all",
      tagFilter: { kind: "custom", value: "workflow" },
    }).map((skill) => skill.name)).toEqual(["workflow-a", "workflow-b"]);
    expect(filterSkills(skillFixtures, {
      query: "",
      status: "all",
      tagFilter: { kind: "untagged", value: "" },
    }).map((skill) => skill.name)).toEqual(["untagged"]);
  });

  it("filters by fixed source and management owner tags", () => {
    const skillFixtures = [
      createSkill({ name: "local", sourceType: "local", sourceLabel: "本地安装" }),
      createSkill({ name: "import", sourceType: "local", sourceLabel: "本地导入" }),
      createSkill({
        name: "market",
        sourceType: "github",
        sourceLabel: "GitHub",
        marketplaceSource: "skills.sh",
      }),
      createSkill({
        name: "agent",
        managementOwner: "agent-skills-cli",
        sourceType: "well-known",
      }),
    ];

    expect(filterSkills(skillFixtures, {
      query: "",
      status: "all",
      tagFilter: { kind: "source", value: "local" },
    }).map((skill) => skill.name)).toEqual(["local", "import"]);
    expect(filterSkills(skillFixtures, {
      query: "",
      status: "all",
      tagFilter: { kind: "source", value: "marketplace" },
    }).map((skill) => skill.name)).toEqual(["market"]);
    expect(filterSkills(skillFixtures, {
      query: "",
      status: "all",
      tagFilter: { kind: "source", value: "standard" },
    }).map((skill) => skill.name)).toEqual(["agent"]);
    expect(filterSkills(skillFixtures, {
      query: "",
      status: "all",
      tagFilter: { kind: "owner", value: "agent-skills-cli" },
    }).map((skill) => skill.name)).toEqual(["agent"]);
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

describe("compareSkillsByEnablement", () => {
  it("treats fully and partially enabled skills as the same enabled state", () => {
    const fullyEnabled = createSkill({
      name: "fully-enabled",
      tools: [
        { name: "Codex", statusLabel: "已同步" },
        { name: "Cursor", statusLabel: "已启用" },
      ],
    });
    const partiallyEnabled = createSkill({
      name: "partially-enabled",
      tools: [
        { name: "Codex", statusLabel: "已同步" },
        { name: "Cursor", statusLabel: "未启用" },
      ],
    });
    const disabled = createSkill({
      name: "disabled",
      tools: [
        { name: "Codex", statusLabel: "未启用" },
        { name: "Cursor", statusLabel: "未启用" },
      ],
    });

    const sorted = [partiallyEnabled, disabled, fullyEnabled].sort(compareSkillsByEnablement);

    expect(sorted.map((skill) => skill.name)).toEqual(["partially-enabled", "fully-enabled", "disabled"]);
  });
});
