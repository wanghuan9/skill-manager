import type {
  ManagedSkillOwnerFilter,
  SkillManagementOwner,
  SkillStatusFilter,
  SkillSummary,
} from "@/features/skills/state/skill-store";
import { parseSkillTimestamp } from "@/features/skills/utils/skill-time";
import { isToolEnabledStatus } from "@/features/skills/utils/tool-status";
import {
  matchesSkillTagFilter,
  type SkillTagFilter,
} from "@/features/skills/utils/skill-tag-filter";

type FilterOptions = {
  query: string;
  status: SkillStatusFilter;
  owner?: ManagedSkillOwnerFilter;
  tagFilter?: SkillTagFilter;
};

const statusPriority: Record<SkillSummary["collabStatus"], number> = {
  "pending-commit": 0,
  "pending-push": 1,
  "update-available": 2,
  diverged: 3,
  clean: 4,
};

const enablementPriority = {
  enabled: 0,
  disabled: 1,
} as const;

export function hasEnabledTool(skill: SkillSummary) {
  return skill.tools.some((tool) => isToolEnabledStatus(tool.statusLabel));
}

function resolveSkillEnablementPriority(skill: SkillSummary) {
  return hasEnabledTool(skill)
    ? enablementPriority.enabled
    : enablementPriority.disabled;
}

export function compareSkillsByEnablement(left: SkillSummary, right: SkillSummary) {
  return resolveSkillEnablementPriority(left) - resolveSkillEnablementPriority(right);
}

export function resolveSkillManagementOwner(skill: SkillSummary): SkillManagementOwner {
  return skill.managementOwner ?? "skilldock";
}

export function getSkillIdentity(skill: SkillSummary) {
  const localPath = skill.localPath.trim();
  return localPath || `${skill.sourceType}:${skill.sourceUrl}:${skill.name}`;
}

function matchesStatusFilter(skill: SkillSummary, status: SkillStatusFilter) {
  if (status === "all") {
    return true;
  }

  if (status === "disabled") {
    return !hasEnabledTool(skill);
  }

  if (status === "enabled") {
    return hasEnabledTool(skill);
  }

  return skill.collabStatus === status;
}

export function filterSkills(skills: SkillSummary[], options: FilterOptions) {
  const normalizedQuery = options.query.trim().toLowerCase();
  const ownerFilter = options.owner ?? "all";

  const filteredSkills = skills.filter((skill) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      skill.name.toLowerCase().includes(normalizedQuery) ||
      skill.sourceLabel.toLowerCase().includes(normalizedQuery) ||
      skill.description.toLowerCase().includes(normalizedQuery) ||
      skill.sourceType.toLowerCase().includes(normalizedQuery) ||
      skill.tag?.toLowerCase().includes(normalizedQuery);
    const matchesStatus = matchesStatusFilter(skill, options.status);
    const matchesOwner = ownerFilter === "all" || resolveSkillManagementOwner(skill) === ownerFilter;
    const matchesTag = matchesSkillTagFilter(skill, options.tagFilter);

    return matchesQuery && matchesStatus && matchesOwner && matchesTag;
  });

  return [...filteredSkills].sort((left, right) => {
    const enablementDiff = compareSkillsByEnablement(left, right);
    if (enablementDiff !== 0) {
      return enablementDiff;
    }

    const leftLocalUpdatedAt = parseSkillTimestamp(left.localUpdatedAt);
    const rightLocalUpdatedAt = parseSkillTimestamp(right.localUpdatedAt);
    if (leftLocalUpdatedAt !== rightLocalUpdatedAt) {
      return rightLocalUpdatedAt - leftLocalUpdatedAt;
    }

    const priorityDiff = statusPriority[left.collabStatus] - statusPriority[right.collabStatus];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return left.name.localeCompare(right.name);
  });
}
