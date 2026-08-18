import type {
  SkillManagementOwner,
  SkillSummary,
} from "@/features/skills/state/skill-store";

export type SkillSourceMethod = "local" | "git" | "standard" | "marketplace";

export type SkillTagFilter =
  | { kind: "source"; value: SkillSourceMethod }
  | { kind: "owner"; value: SkillManagementOwner }
  | { kind: "custom"; value: string }
  | { kind: "untagged"; value: "" };

export type SkillTagFilterValueCount<T extends string> = {
  value: T;
  count: number;
};

export type SkillTagFilterGroups = {
  sources: Array<SkillTagFilterValueCount<SkillSourceMethod>>;
  owners: Array<SkillTagFilterValueCount<SkillManagementOwner>>;
  customTags: Array<SkillTagFilterValueCount<string>>;
  untaggedCount: number;
};

const SOURCE_METHOD_ORDER: SkillSourceMethod[] = [
  "local",
  "git",
  "marketplace",
  "standard",
];
const MANAGEMENT_OWNER_ORDER: SkillManagementOwner[] = [
  "skilldock",
  "agent-skills-cli",
  "external",
];
function resolveManagementOwner(skill: SkillSummary): SkillManagementOwner {
  return skill.managementOwner ?? "skilldock";
}

function incrementCount<T extends string>(counts: Map<T, number>, value: T) {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

export function resolveSkillSourceMethod(skill: SkillSummary): SkillSourceMethod {
  if (skill.marketplaceSource?.trim() || skill.sourceType === "marketplace") {
    return "marketplace";
  }
  if (skill.sourceType === "well-known") {
    return "standard";
  }
  if (skill.gitLinked || skill.sourceType !== "local") {
    return "git";
  }
  return "local";
}

export function matchesSkillTagFilter(skill: SkillSummary, filter?: SkillTagFilter) {
  if (!filter) {
    return true;
  }

  if (filter.kind === "source") {
    return resolveSkillSourceMethod(skill) === filter.value;
  }
  if (filter.kind === "owner") {
    return resolveManagementOwner(skill) === filter.value;
  }

  const customTag = skill.tag?.trim() ?? "";
  if (filter.kind === "untagged") {
    return customTag.length === 0;
  }
  return customTag.toLocaleLowerCase() === filter.value.trim().toLocaleLowerCase();
}

export function isSameSkillTagFilter(left?: SkillTagFilter, right?: SkillTagFilter) {
  if (!left || !right || left.kind !== right.kind) {
    return left === right;
  }

  return left.value.toLocaleLowerCase() === right.value.toLocaleLowerCase();
}

export function collectSkillTagFilterGroups(skills: SkillSummary[]): SkillTagFilterGroups {
  const sourceCounts = new Map<SkillSourceMethod, number>();
  const ownerCounts = new Map<SkillManagementOwner, number>();
  const customTagCounts = new Map<string, SkillTagFilterValueCount<string>>();
  let untaggedCount = 0;

  skills.forEach((skill) => {
    incrementCount(sourceCounts, resolveSkillSourceMethod(skill));
    incrementCount(ownerCounts, resolveManagementOwner(skill));

    const customTag = skill.tag?.trim() ?? "";
    if (!customTag) {
      untaggedCount += 1;
      return;
    }

    const normalizedTag = customTag.toLocaleLowerCase();
    const existing = customTagCounts.get(normalizedTag);
    customTagCounts.set(normalizedTag, {
      value: existing?.value ?? customTag,
      count: (existing?.count ?? 0) + 1,
    });
  });

  return {
    sources: SOURCE_METHOD_ORDER
      .filter((value) => sourceCounts.has(value))
      .map((value) => ({ value, count: sourceCounts.get(value) ?? 0 })),
    owners: MANAGEMENT_OWNER_ORDER
      .filter((value) => ownerCounts.has(value))
      .map((value) => ({ value, count: ownerCounts.get(value) ?? 0 })),
    customTags: [...customTagCounts.values()]
      .sort((left, right) => left.value.localeCompare(right.value)),
    untaggedCount,
  };
}

export function isSkillTagFilterAvailable(
  groups: SkillTagFilterGroups,
  filter?: SkillTagFilter,
) {
  if (!filter) {
    return true;
  }
  if (filter.kind === "source") {
    return groups.sources.some((item) => item.value === filter.value);
  }
  if (filter.kind === "owner") {
    return groups.owners.some((item) => item.value === filter.value);
  }
  if (filter.kind === "untagged") {
    return groups.untaggedCount > 0;
  }

  return groups.customTags.some(
    (item) => item.value.toLocaleLowerCase() === filter.value.toLocaleLowerCase(),
  );
}
