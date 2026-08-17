import { describe, expect, it } from "vitest";
import type { SkillSummary } from "@/features/skills/state/skill-store";
import { groupSkillsBySource, groupSkillsByTag } from "@/features/skills/utils/skill-groups";

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

describe("groupSkillsBySource", () => {
  it("prefers repo name when repo is meaningful", () => {
    const groups = groupSkillsBySource([
      createSkill({
        name: "architecture-review",
        sourceUrl: "https://github.com/obra/superpowers",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("superpowers");
  });

  it("falls back to owner when repo name is generic", () => {
    const groups = groupSkillsBySource([
      createSkill({
        name: "anthropic-style",
        sourceUrl: "https://github.com/anthropics/skills",
      }),
      createSkill({
        name: "lark-release",
        sourceUrl: "https://github.com/larksuite/cli",
      }),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["anthropics", "larksuite"]);
  });

  it("sorts groups by label", () => {
    const groups = groupSkillsBySource([
      createSkill({
        name: "zeta-skill",
        sourceUrl: "https://github.com/team/zeta-skills",
      }),
      createSkill({
        name: "alpha-skill",
        sourceUrl: "https://github.com/team/alpha-skills",
      }),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["alpha-skills", "zeta-skills"]);
  });

  it("falls back to owner-repo when preferred labels collide", () => {
    const groups = groupSkillsBySource([
      createSkill({
        name: "team-a-review",
        sourceUrl: "https://github.com/team-a/superpowers",
      }),
      createSkill({
        name: "team-b-review",
        sourceUrl: "https://github.com/team-b/superpowers",
      }),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["team-a-superpowers", "team-b-superpowers"]);
  });

  it("treats local filesystem sources as local", () => {
    const groups = groupSkillsBySource([
      createSkill({
        name: "local-skill",
        sourceType: "github",
        sourceUrl: "file:///Users/wanghuan/.skilldock/skills/local-skill",
        sourceLabel: "Users/wanghuan",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("本地");
  });

  it("groups well-known Agent CLI sources by host", () => {
    const groups = groupSkillsBySource([
      createSkill({
        name: "lark-okr",
        sourceType: "well-known",
        sourceUrl: "https://open.feishu.cn/.well-known/skills/lark-okr/SKILL.md",
        sourceLabel: "Agent Skills CLI",
        gitLinked: false,
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("open.feishu.cn");
  });
});

describe("groupSkillsByTag", () => {
  it("groups each skill once and places untagged skills last", () => {
    const groups = groupSkillsByTag([
      createSkill({ name: "untagged" }),
      createSkill({ name: "writing", tag: "写作" }),
      createSkill({ name: "coding", tag: "研发" }),
    ], "未打标签");

    expect(groups.map((group) => group.label)).toEqual(["写作", "研发", "未打标签"]);
    expect(groups.map((group) => group.id)).toEqual(["tag:写作", "tag:研发", "tag:untagged"]);
    expect(groups.flatMap((group) => group.skills).map((skill) => skill.name)).toHaveLength(3);
  });

  it("treats tags as case-insensitive while preserving the display label", () => {
    const groups = groupSkillsByTag([
      createSkill({ name: "first", tag: "Code" }),
      createSkill({ name: "second", tag: "code" }),
    ], "Untagged");

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("Code");
    expect(groups[0]?.skills.map((skill) => skill.name)).toEqual(["first", "second"]);
  });
});
