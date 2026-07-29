import type { MarketplaceSkill, SkillSummary } from "@/features/skills/state/skill-store";

type RepoIdentity = {
  repoKey: string;
  pathVariants: string[];
  normalizedName: string;
};

type InstalledRepoIndex = {
  byRepo: Map<string, { pathVariants: Set<string>; names: Set<string>; count: number }>;
};

const installedIndexCache = new Map<string, InstalledRepoIndex>();
const marketplaceIdentityCache = new Map<string, RepoIdentity | null>();

function normalizeRepoSegment(segment: string) {
  return segment.trim().replace(/\.git$/i, "").toLowerCase();
}

function normalizePath(path: string) {
  return path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/")
    .toLowerCase();
}

function parseRepositoryParts(sourceUrl: string): { host: string; owner: string; repo: string } | null {
  const trimmed = sourceUrl.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) {
      return null;
    }
    return {
      host: parsed.hostname.toLowerCase(),
      owner: normalizeRepoSegment(segments[0]),
      repo: normalizeRepoSegment(segments[1]),
    };
  } catch {
    const sshMatched = trimmed.match(/^git@([^:]+):(.+)$/i);
    if (sshMatched) {
      const host = sshMatched[1].toLowerCase();
      const segments = sshMatched[2].split("/").filter(Boolean);
      if (!host || segments.length < 2) {
        return null;
      }
      return {
        host,
        owner: normalizeRepoSegment(segments[0]),
        repo: normalizeRepoSegment(segments[1]),
      };
    }

    const rawPath = trimmed.replace(/^[a-z]+:\/\//i, "");
    const segments = rawPath.split("/").filter(Boolean);
    if (segments.length < 3) {
      return null;
    }
    return {
      host: segments[0].toLowerCase(),
      owner: normalizeRepoSegment(segments[1]),
      repo: normalizeRepoSegment(segments[2]),
    };
  }
}

function extractTreeLikePath(sourceUrl: string) {
  try {
    const parsed = new URL(sourceUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 4) {
      return "";
    }
    const treeIndex = segments.findIndex((segment) => segment === "tree" || segment === "blob");
    if (treeIndex < 0 || treeIndex + 2 >= segments.length) {
      return "";
    }
    return normalizePath(segments.slice(treeIndex + 2).join("/"));
  } catch {
    return "";
  }
}

function buildPathVariants(path: string) {
  const normalized = normalizePath(path);
  if (!normalized) {
    return [];
  }
  const variants = new Set<string>([normalized]);
  if (normalized.startsWith("skills/")) {
    variants.add(normalized.slice("skills/".length));
  } else {
    variants.add(`skills/${normalized}`);
  }
  return [...variants].filter(Boolean);
}

function buildIdentity(sourceUrl: string, name: string): RepoIdentity | null {
  const repositoryParts = parseRepositoryParts(sourceUrl);
  if (!repositoryParts) {
    return null;
  }
  const repoKey = `${repositoryParts.host}/${repositoryParts.owner}/${repositoryParts.repo}`;
  const pathVariants = new Set<string>();
  const treePath = extractTreeLikePath(sourceUrl);
  for (const pathVariant of buildPathVariants(treePath)) {
    pathVariants.add(pathVariant);
  }
  return {
    repoKey,
    pathVariants: [...pathVariants],
    normalizedName: normalizePath(name),
  };
}

function buildInstalledSignature(installedSkills: SkillSummary[]) {
  return installedSkills
    .map((skill) => `${skill.sourceUrl}|${skill.name}`)
    .sort()
    .join("\n");
}

function buildInstalledIndex(installedSkills: SkillSummary[]): InstalledRepoIndex {
  const signature = buildInstalledSignature(installedSkills);
  const cached = installedIndexCache.get(signature);
  if (cached) {
    return cached;
  }
  const byRepo = new Map<string, { pathVariants: Set<string>; names: Set<string>; count: number }>();
  for (const skill of installedSkills) {
    const identity = buildIdentity(skill.sourceUrl, skill.name);
    if (!identity) {
      continue;
    }
    const entry = byRepo.get(identity.repoKey) ?? {
      pathVariants: new Set<string>(),
      names: new Set<string>(),
      count: 0,
    };
    for (const path of identity.pathVariants) {
      entry.pathVariants.add(path);
    }
    if (identity.normalizedName) {
      entry.names.add(identity.normalizedName);
    }
    entry.count += 1;
    byRepo.set(identity.repoKey, entry);
  }
  const index = { byRepo };
  installedIndexCache.clear();
  installedIndexCache.set(signature, index);
  return index;
}

function getMarketplaceIdentity(skill: MarketplaceSkill): RepoIdentity | null {
  if (marketplaceIdentityCache.has(skill.id)) {
    return marketplaceIdentityCache.get(skill.id) ?? null;
  }
  const identity = buildIdentity(skill.sourceUrl, skill.name);
  marketplaceIdentityCache.set(skill.id, identity);
  return identity;
}

export function buildInstalledMarketplaceSkillIds(
  marketplaceSkills: MarketplaceSkill[],
  installedSkills: SkillSummary[],
) {
  const installedIndex = buildInstalledIndex(installedSkills);
  const installedMarketplaceSkillIds = new Set<string>();
  const marketplaceRepoCount = new Map<string, number>();
  const installedClawhubSkills = installedSkills.filter((skill) => skill.updateDriver === "clawhub");

  for (const marketplaceSkill of marketplaceSkills) {
    if (marketplaceSkill.installed) {
      installedMarketplaceSkillIds.add(marketplaceSkill.id);
    }
    if (marketplaceSkill.installDriver === "clawhub") {
      const isInstalled = installedClawhubSkills.some((installedSkill) => {
        const slugMatches = Boolean(marketplaceSkill.slug)
          && installedSkill.marketplaceSlug === marketplaceSkill.slug;
        const ownerMatches = !marketplaceSkill.owner
          || installedSkill.marketplaceOwner === marketplaceSkill.owner;
        return slugMatches && ownerMatches;
      });
      if (isInstalled) {
        installedMarketplaceSkillIds.add(marketplaceSkill.id);
      }
      continue;
    }
    const identity = getMarketplaceIdentity(marketplaceSkill);
    if (!identity) {
      continue;
    }
    marketplaceRepoCount.set(
      identity.repoKey,
      (marketplaceRepoCount.get(identity.repoKey) ?? 0) + 1,
    );
  }

  for (const marketplaceSkill of marketplaceSkills) {
    if (installedMarketplaceSkillIds.has(marketplaceSkill.id)) {
      continue;
    }
    if (marketplaceSkill.installDriver === "clawhub") {
      continue;
    }
    const identity = getMarketplaceIdentity(marketplaceSkill);
    if (!identity) {
      continue;
    }
    const installedRepo = installedIndex.byRepo.get(identity.repoKey);
    if (!installedRepo) {
      continue;
    }

    const pathMatched =
      identity.pathVariants.length > 0
      && identity.pathVariants.some((path) => installedRepo.pathVariants.has(path));
    if (pathMatched) {
      installedMarketplaceSkillIds.add(marketplaceSkill.id);
      continue;
    }

    const nameMatched = identity.normalizedName && installedRepo.names.has(identity.normalizedName);
    if (nameMatched) {
      installedMarketplaceSkillIds.add(marketplaceSkill.id);
      continue;
    }

    const isUniqueRepoInInstalled = installedRepo.count === 1;
    const isUniqueRepoInMarketplace = (marketplaceRepoCount.get(identity.repoKey) ?? 0) === 1;
    if (isUniqueRepoInInstalled && isUniqueRepoInMarketplace) {
      installedMarketplaceSkillIds.add(marketplaceSkill.id);
    }
  }
  return installedMarketplaceSkillIds;
}
