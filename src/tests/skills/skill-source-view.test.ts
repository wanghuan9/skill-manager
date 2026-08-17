import { expect, test } from "vitest";
import type { SkillSummary, ToolConfig, ToolSkillEntry } from "@/features/skills/state/skill-store";
import {
  buildToolSkillViewItems,
  countToolSkillStatuses,
  listSkillSourceTools,
  resolveManagedSkillRootPath,
} from "@/features/skills/utils/skill-source-view";

function skill(
  name: string,
  statusLabel: string,
  localPath = `/Users/demo/.skilldock/skills/${name}`,
): SkillSummary {
  return {
    name,
    sourceLabel: "本地",
    sourceType: "local",
    sourceUrl: "",
    description: `${name} description`,
    localPath,
    canonicalPath: localPath,
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
      managedRoot: "skilldock",
    },
    {
      toolId: "codex",
      toolName: "Codex",
      name: "changed-skill",
      description: "out of sync",
      localPath: "/Users/demo/.codex/skills/changed-skill",
      resolvedPath: "/Users/demo/.codex/skills/changed-skill",
      managementStatus: "mismatch",
      managedRoot: "",
    },
    {
      toolId: "codex",
      toolName: "Codex",
      name: "external-skill",
      description: "unmanaged",
      localPath: "/Users/demo/.codex/skills/external-skill",
      resolvedPath: "/Users/demo/shared-skills/external-skill",
      managementStatus: "unmanaged",
      managedRoot: "",
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
  expect(items.find((item) => item.name === "managed-skill")?.managedRoot).toBe("skilldock");
  expect(items.find((item) => item.name === "external-skill")?.entryKind).toBe("symlink");
  expect(items.find((item) => item.name === "external-skill")?.resolvedPath)
    .toBe("/Users/demo/shared-skills/external-skill");
  expect(countToolSkillStatuses(items)).toEqual({
    all: 3,
    managed: 1,
    unmanaged: 1,
    mismatch: 1,
  });
});

test("matches same-name managed Skills by canonical path and preserves the managed root", () => {
  const skilldockSkill = skill(
    "duplicate-skill",
    "已同步",
    "/Users/demo/.skilldock/skills/duplicate-skill",
  );
  const agentSkill = {
    ...skill("duplicate-skill", "已同步", "/Users/demo/.agents/skills/duplicate-skill"),
    managementOwner: "agent-skills-cli" as const,
  };
  const [item] = buildToolSkillViewItems({
    tool: codex,
    installedSkills: [skilldockSkill, agentSkill],
    toolSkillEntries: [{
      toolId: "codex",
      toolName: "Codex",
      name: "duplicate-skill",
      description: "Agent copy",
      localPath: "/Users/demo/.codex/skills/duplicate-skill",
      resolvedPath: "/Users/demo/.agents/skills/duplicate-skill",
      managementStatus: "managed",
      managedRoot: "agent-skills-cli",
      entryKind: "symlink",
    }],
  });

  expect(item.managedSkill?.localPath).toBe("/Users/demo/.agents/skills/duplicate-skill");
  expect(item.managedRoot).toBe("agent-skills-cli");
});

test("does not associate an external same-name entry with a managed copy", () => {
  const externalSkill = {
    ...skill("duplicate-skill", "已同步", "/Users/demo/shared-skills/duplicate-skill"),
    managementOwner: "external" as const,
  };
  const [item] = buildToolSkillViewItems({
    tool: codex,
    installedSkills: [skill("duplicate-skill", "已同步"), externalSkill],
    toolSkillEntries: [{
      toolId: "codex",
      toolName: "Codex",
      name: "duplicate-skill",
      description: "External copy",
      localPath: "/Users/demo/.codex/skills/duplicate-skill",
      resolvedPath: "/Users/demo/shared-skills/duplicate-skill",
      managementStatus: "unmanaged",
      managedRoot: "",
      entryKind: "symlink",
    }],
  });

  expect(item.managedSkill).toBeUndefined();
  expect(item.managedRoot).toBe("");
  expect(item.status).toBe("unmanaged");
});

test("keeps only the managed package root when a Skill is nested", () => {
  expect(resolveManagedSkillRootPath(
    "/Users/demo/.skilldock/skills/karpathy-guidelines/skills/karpathy-guidelines",
  )).toBe("/Users/demo/.skilldock/skills/karpathy-guidelines");
  expect(resolveManagedSkillRootPath(
    "/Users/demo/.skilldock/skills/skill-publisher",
  )).toBe("/Users/demo/.skilldock/skills/skill-publisher");
});

test("lists only installed tools that expose a real Skill directory", () => {
  const tools: ToolConfig[] = [
    codex,
    { ...codex, id: "claude-code", name: "Claude Code", skillsPath: "/Users/demo/.claude/skills" },
    { ...codex, id: "opencode", name: "OpenCode", skillsPath: "/Users/demo/.opencode/skills" },
    { ...codex, id: "intellij", name: "IntelliJ IDEA", skillsPath: "/Users/demo/.junie/skills" },
    { ...codex, id: "junie", name: "Junie", skillsPath: "/Users/demo/.junie/skills" },
    { ...codex, id: "cursor", name: "Cursor", skillsPath: "/Users/demo/.cursor/skills" },
    { ...codex, id: "vscode", name: "VS Code", skillsPath: "" },
  ];

  expect(listSkillSourceTools(tools).map((tool) => tool.id)).toEqual([
    "claude-code",
    "codex",
    "cursor",
    "opencode",
    "junie",
  ]);
});
