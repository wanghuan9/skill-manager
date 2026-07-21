import type { SkillStatusFilter, SkillSummary } from "@/features/skills/state/skill-store";
import { parseSkillTimestamp } from "@/features/skills/utils/skill-time";
import { isToolEnabledStatus } from "@/features/skills/utils/tool-status";

type FilterOptions = {
  query: string;
  status: SkillStatusFilter;
};

const statusPriority: Record<SkillSummary["collabStatus"], number> = {
  "pending-commit": 0,
  "pending-push": 1,
  "update-available": 2,
  diverged: 3,
  clean: 4,
};

export function hasEnabledTool(skill: SkillSummary) {
  return skill.tools.some((tool) => isToolEnabledStatus(tool.statusLabel));
}

function matchesStatusFilter(skill: SkillSummary, status: SkillStatusFilter) {
  if (status === "all") {
    return true;
  }

  if (status === "disabled") {
    return !hasEnabledTool(skill);
  }

  return skill.collabStatus === status;
}

export function filterSkills(skills: SkillSummary[], options: FilterOptions) {
  const normalizedQuery = options.query.trim().toLowerCase();

  const filteredSkills = skills.filter((skill) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      skill.name.toLowerCase().includes(normalizedQuery) ||
      skill.sourceLabel.toLowerCase().includes(normalizedQuery) ||
      skill.description.toLowerCase().includes(normalizedQuery) ||
      skill.sourceType.toLowerCase().includes(normalizedQuery);
    const matchesStatus = matchesStatusFilter(skill, options.status);

    return matchesQuery && matchesStatus;
  });

  return [...filteredSkills].sort((left, right) => {
    const localUpdatedDiff = parseSkillTimestamp(right.localUpdatedAt) - parseSkillTimestamp(left.localUpdatedAt);
    if (localUpdatedDiff !== 0) {
      return localUpdatedDiff;
    }

    const enabledToolDiff = Number(hasEnabledTool(left)) - Number(hasEnabledTool(right));
    if (enabledToolDiff !== 0) {
      return enabledToolDiff;
    }

    const priorityDiff = statusPriority[left.collabStatus] - statusPriority[right.collabStatus];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return left.name.localeCompare(right.name);
  });
}
