import type { SkillSummary } from "@/features/skills/state/skill-store";

export type SkillSourceGroup = {
  id: string;
  label: string;
  skills: SkillSummary[];
};

type GroupLabelOptions = {
  localLabel?: string;
};

const GENERIC_REPOSITORY_NAMES = new Set([
  "skill",
  "skills",
  "cli",
  "agent",
  "agents",
  "app",
  "apps",
  "tool",
  "tools",
]);

type ParsedRepository = {
  owner: string;
  repo: string;
};

function isLocalSourceUrl(sourceUrl: string) {
  return (
    sourceUrl.startsWith("file://")
    || sourceUrl.startsWith("/")
    || sourceUrl.startsWith("~/")
    || sourceUrl.startsWith("/Users/")
    || sourceUrl.startsWith("C:\\")
  );
}

function formatOwnerRepoLabel(owner: string, repo: string) {
  return `${owner}-${repo}`.replace(/\//g, "-");
}

function isGenericRepositoryName(repo: string) {
  return GENERIC_REPOSITORY_NAMES.has(repo.toLowerCase());
}

function parseRepository(sourceUrl: string): ParsedRepository | null {
  try {
    const parsedUrl = new URL(sourceUrl);
    const segments = parsedUrl.pathname.split("/").filter(Boolean);
    if (segments.length >= 2) {
      return {
        owner: segments[0],
        repo: segments[1].replace(/\.git$/i, ""),
      };
    }
  } catch {
    const trimmedUrl = sourceUrl.replace(/^https?:\/\//, "").replace(/^git@[^:]+:/, "");
    const segments = trimmedUrl.split("/").filter(Boolean);
    if (segments.length >= 2) {
      return {
        owner: segments[0],
        repo: segments[1].replace(/\.git$/i, ""),
      };
    }
  }

  return null;
}

function resolveFallbackGroupLabel(skill: SkillSummary, options: GroupLabelOptions) {
  if (isLocalSourceUrl(skill.sourceUrl)) {
    return options.localLabel ?? "本地";
  }

  return skill.sourceLabel.replace(/\//g, "-");
}

function buildPreferredGroupLabel(parsedRepository: ParsedRepository) {
  if (isGenericRepositoryName(parsedRepository.repo)) {
    return parsedRepository.owner;
  }

  return parsedRepository.repo;
}

function resolveInitialGroupLabel(skill: SkillSummary, options: GroupLabelOptions) {
  if (skill.sourceType === "local") {
    return options.localLabel ?? "本地";
  }

  if (isLocalSourceUrl(skill.sourceUrl)) {
    return options.localLabel ?? "本地";
  }

  const parsedRepository = parseRepository(skill.sourceUrl);
  if (parsedRepository) {
    return buildPreferredGroupLabel(parsedRepository);
  }

  return resolveFallbackGroupLabel(skill, options);
}

export function groupSkillsBySource(skills: SkillSummary[], options: GroupLabelOptions = {}): SkillSourceGroup[] {
  const groupedItems = skills.map((skill) => {
    const parsedRepository = parseRepository(skill.sourceUrl);
    const preferredLabel = resolveInitialGroupLabel(skill, options);
    const fallbackLabel = parsedRepository
      ? formatOwnerRepoLabel(parsedRepository.owner, parsedRepository.repo)
      : resolveFallbackGroupLabel(skill, options);

    return {
      skill,
      preferredLabel,
      fallbackLabel,
    };
  });

  const labelUsageCount = new Map<string, number>();
  groupedItems.forEach((item) => {
    labelUsageCount.set(item.preferredLabel, (labelUsageCount.get(item.preferredLabel) ?? 0) + 1);
  });

  const groupMap = new Map<string, SkillSummary[]>();
  groupedItems.forEach((item) => {
    const groupLabel =
      (labelUsageCount.get(item.preferredLabel) ?? 0) > 1 ? item.fallbackLabel : item.preferredLabel;
    const currentSkills = groupMap.get(groupLabel) ?? [];
    currentSkills.push(item.skill);
    groupMap.set(groupLabel, currentSkills);
  });

  return [...groupMap.entries()]
    .sort(([leftLabel], [rightLabel]) => leftLabel.localeCompare(rightLabel))
    .map(([label, groupedSkills]) => ({
      id: label,
      label,
      skills: groupedSkills,
    }));
}
