import type {
  SkillSummary,
  ToolConfig,
  ToolSkillEntry,
  ToolSkillEntryKind,
} from "@/features/skills/state/skill-store";
import { getToolDisplayRank } from "@/features/skills/utils/tool-logo";
import { isToolInstalledStatus } from "@/features/skills/utils/tool-status";

export const MANAGED_SKILL_SOURCE_ID = "managed";

export type SkillSourceId = typeof MANAGED_SKILL_SOURCE_ID | string;
export type ToolSkillManagementStatus = "managed" | "unmanaged" | "mismatch";
export type ToolSkillManagementFilter = "all" | ToolSkillManagementStatus;

export type ToolSkillViewItem = {
  id: string;
  name: string;
  description: string;
  localPath: string;
  resolvedPath: string;
  status: ToolSkillManagementStatus;
  entryKind: ToolSkillEntryKind;
  managedSkill?: SkillSummary;
};

function normalizePath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
}

export function resolveManagedSkillRootPath(localPath: string) {
  const normalizedPath = normalizePath(localPath);
  const managedSkillsMarker = "/.skilldock/skills/";
  const markerIndex = normalizedPath.indexOf(managedSkillsMarker);
  if (markerIndex < 0) {
    return normalizedPath;
  }

  const managedSkillNameStart = markerIndex + managedSkillsMarker.length;
  const managedSkillNameEnd = normalizedPath.indexOf("/", managedSkillNameStart);
  return managedSkillNameEnd < 0 ? normalizedPath : normalizedPath.slice(0, managedSkillNameEnd);
}

export function listSkillSourceTools(toolConfigs: ToolConfig[]) {
  const seenSkillPaths = new Set<string>();

  return toolConfigs
    .filter((tool) => (
      tool.id !== "intellij"
      && tool.id !== "vscode"
      && isToolInstalledStatus(tool.statusLabel)
      && tool.skillsPath.trim().length > 0
    ))
    .sort((left, right) => (
      getToolDisplayRank(left.name) - getToolDisplayRank(right.name)
      || left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base", numeric: true })
    ))
    .filter((tool) => {
      const normalizedSkillsPath = normalizePath(tool.skillsPath);
      if (seenSkillPaths.has(normalizedSkillsPath)) {
        return false;
      }
      seenSkillPaths.add(normalizedSkillsPath);
      return true;
    });
}

export function buildToolSkillViewItems(input: {
  tool: ToolConfig;
  installedSkills: SkillSummary[];
  toolSkillEntries: ToolSkillEntry[];
}) {
  const { tool, installedSkills, toolSkillEntries } = input;
  const installedSkillsByName = new Map(installedSkills.map((skill) => [skill.name, skill]));
  const statusOrder: Record<ToolSkillManagementStatus, number> = {
    managed: 0,
    mismatch: 1,
    unmanaged: 2,
  };

  return toolSkillEntries
    .filter((entry) => entry.toolId === tool.id)
    .map<ToolSkillViewItem>((entry) => ({
      id: `${entry.toolId}:${normalizePath(entry.localPath)}`,
      name: entry.name,
      description: entry.description,
      localPath: entry.localPath,
      resolvedPath: entry.resolvedPath,
      status: entry.managementStatus,
      entryKind: entry.entryKind ?? "directory",
      managedSkill: installedSkillsByName.get(entry.name),
    }))
    .sort((left, right) => (
      statusOrder[left.status] - statusOrder[right.status]
      || left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base", numeric: true })
    ));
}

export function countToolSkillStatuses(items: ToolSkillViewItem[]) {
  return {
    all: items.length,
    managed: items.filter((item) => item.status === "managed").length,
    unmanaged: items.filter((item) => item.status === "unmanaged").length,
    mismatch: items.filter((item) => item.status === "mismatch").length,
  };
}
