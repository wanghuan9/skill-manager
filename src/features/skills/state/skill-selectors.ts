import type { SkillSummary } from "@/features/skills/state/skill-store";

type FilterOptions = {
  query: string;
  status: string;
};

const statusPriority: Record<SkillSummary["collabStatus"], number> = {
  "pending-push": 0,
  "update-available": 1,
  diverged: 2,
  clean: 3,
};

export function filterSkills(skills: SkillSummary[], options: FilterOptions) {
  const normalizedQuery = options.query.trim().toLowerCase();

  const filteredSkills = skills.filter((skill) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      skill.name.toLowerCase().includes(normalizedQuery) ||
      skill.sourceLabel.toLowerCase().includes(normalizedQuery) ||
      skill.description.toLowerCase().includes(normalizedQuery) ||
      skill.sourceType.toLowerCase().includes(normalizedQuery);
    const matchesStatus = options.status === "all" || skill.collabStatus === options.status;

    return matchesQuery && matchesStatus;
  });

  return [...filteredSkills].sort((left, right) => {
    const priorityDiff = statusPriority[left.collabStatus] - statusPriority[right.collabStatus];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return left.name.localeCompare(right.name);
  });
}
