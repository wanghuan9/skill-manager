import type {
  ManagedSkillOwnerFilter,
  SkillManagementOwner,
  SkillStatusFilter,
  SkillSummary,
} from "@/features/skills/state/skill-store";
import { parseSkillTimestamp } from "@/features/skills/utils/skill-time";
import { isToolEnabledStatus } from "@/features/skills/utils/tool-status";

type FilterOptions = {
  query: string;
  status: SkillStatusFilter;
  owner?: ManagedSkillOwnerFilter;
};

const statusPriority: Record<SkillSummary["collabStatus"], number> = {
  "pending-commit": 0,
  "pending-push": 1,
  "update-available": 2,
  diverged: 3,
  clean: 4,
};

const enablementPriority = {
  fullyEnabled: 0,
  partiallyEnabled: 1,
  disabled: 2,
} as const;

export function hasEnabledTool(skill: SkillSummary) {
  return skill.tools.some((tool) => isToolEnabledStatus(tool.statusLabel));
}

function resolveSkillEnablementPriority(skill: SkillSummary) {
  const enabledToolCount = skill.tools.filter((tool) => isToolEnabledStatus(tool.statusLabel)).length;
  if (skill.tools.length > 0 && enabledToolCount === skill.tools.length) {
    return enablementPriority.fullyEnabled;
  }
  if (enabledToolCount > 0) {
    return enablementPriority.partiallyEnabled;
  }
  return enablementPriority.disabled;
}

export function compareSkillsByEnablement(left: SkillSummary, right: SkillSummary) {
  return resolveSkillEnablementPriority(left) - resolveSkillEnablementPriority(right);
}

export function resolveSkillManagementOwner(skill: SkillSummary): SkillManagementOwner {
  return skill.managementOwner ?? "skilldock";
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
  const ownerFilter = options.owner ?? "all";

  const filteredSkills = skills.filter((skill) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      skill.name.toLowerCase().includes(normalizedQuery) ||
      skill.sourceLabel.toLowerCase().includes(normalizedQuery) ||
      skill.description.toLowerCase().includes(normalizedQuery) ||
      skill.sourceType.toLowerCase().includes(normalizedQuery);
    const matchesStatus = matchesStatusFilter(skill, options.status);
    const matchesOwner = ownerFilter === "all" || resolveSkillManagementOwner(skill) === ownerFilter;

    return matchesQuery && matchesStatus && matchesOwner;
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
