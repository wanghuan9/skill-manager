import { expect, test } from "vitest";
import type { SkillSummary, ToolConfig, ToolSkillEntry } from "@/features/skills/state/skill-store";
import {
  buildToolSkillViewItems,
  countToolSkillStatuses,
  listSkillSourceTools,
} from "@/features/skills/utils/skill-source-view";

function skill(name: string, statusLabel: string): SkillSummary {
  return {
    name,
    sourceLabel: "本地",
    sourceType: "local",
    sourceUrl: "",
    description: `${name} description`,
    localPath: `/Users/demo/.skilldock/skills/${name}`,
    branch: "local",
    collabStatus: "clean",
    statusText: "",
    remoteUpdatedAt: "",
    localUpdatedAt: "",
    lastCheckedAt: "",
    syncedToolCount: 1,
    lastEditor: "",
    commitLabel: "",
    gitLinked: false,
    tools: [{ name: "Codex", statusLabel }],
  };
}

const codex: ToolConfig = {
  id: "codex",
  name: "Codex",
  skillsPath: "/Users/demo/.codex/skills",
  mcpConfigPath: "",
  supportsMcp: true,
  mcpConfigPathRecognized: true,
  statusLabel: "已安装",
  isEnabled: true,
  primaryType: "cli",
  surfaceTypes: ["cli"],
  supportsDirectOpen: false,
};

test("combines managed, out-of-sync, and unmanaged Skills for one tool", () => {
  const toolSkillEntries: ToolSkillEntry[] = [
    {
      toolId: "codex",
      toolName: "Codex",
      name: "managed-skill",
      description: "duplicate scan result",
      localPath: "/Users/demo/.codex/skills/managed-skill",
      resolvedPath: "/Users/demo/.skilldock/skills/managed-skill",
      managementStatus: "managed",
    },
    {
      toolId: "codex",
      toolName: "Codex",
      name: "changed-skill",
      description: "out of sync",
      localPath: "/Users/demo/.codex/skills/changed-skill",
      resolvedPath: "/Users/demo/.codex/skills/changed-skill",
      managementStatus: "mismatch",
    },
    {
      toolId: "codex",
      toolName: "Codex",
      name: "external-skill",
      description: "unmanaged",
      localPath: "/Users/demo/.codex/skills/external-skill",
      resolvedPath: "/Users/demo/.codex/skills/external-skill",
      managementStatus: "unmanaged",
      entryKind: "symlink",
    },
  ];

  const items = buildToolSkillViewItems({
    tool: codex,
    installedSkills: [skill("managed-skill", "已同步"), skill("changed-skill", "需要重同步")],
    toolSkillEntries,
  });

  expect(items.map((item) => [item.name, item.status])).toEqual([
    ["managed-skill", "managed"],
    ["changed-skill", "mismatch"],
    ["external-skill", "unmanaged"],
  ]);
  expect(items.find((item) => item.name === "managed-skill")?.entryKind).toBe("directory");
  expect(items.find((item) => item.name === "external-skill")?.entryKind).toBe("symlink");
  expect(countToolSkillStatuses(items)).toEqual({
    all: 3,
    managed: 1,
    unmanaged: 1,
    mismatch: 1,
  });
});

test("lists only installed tools that expose a real Skill directory", () => {
  const tools: ToolConfig[] = [
    codex,
    { ...codex, id: "claude-code", name: "Claude Code", skillsPath: "/Users/demo/.claude/skills" },
    { ...codex, id: "intellij", name: "IntelliJ IDEA", skillsPath: "/Users/demo/.junie/skills" },
    { ...codex, id: "junie", name: "Junie", skillsPath: "/Users/demo/.junie/skills" },
    { ...codex, id: "cursor", name: "Cursor", statusLabel: "未安装" },
    { ...codex, id: "vscode", name: "VS Code", skillsPath: "" },
  ];

  expect(listSkillSourceTools(tools).map((tool) => tool.id)).toEqual(["claude-code", "codex", "junie"]);
});
