import type { SkillSummary } from "@/features/skills/state/skill-store";

export function normalizePackageRelativePath(relativePath: string): string {
  return relativePath.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
}

export function normalizePackageSource(source: string): string {
  const trimmed = source.trim().replace(/\/$/, "");
  const withoutGit = trimmed.replace(/\.git$/i, "");
  const treeIndex = withoutGit.toLowerCase().indexOf("/tree/");
  const base = treeIndex >= 0 ? withoutGit.slice(0, treeIndex) : withoutGit;
  return base.toLowerCase();
}

export function parseRepoSkillSourceIdentity(
  sourceUrl: string,
): { source: string; relativePath: string } | null {
  try {
    const url = new URL(sourceUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const treeIndex = parts.indexOf("tree");
    if (treeIndex < 2 || treeIndex + 2 >= parts.length) {
      return null;
    }

    const owner = parts[0];
    const repo = parts[1];
    const relativePath = parts.slice(treeIndex + 2).join("/");
    return {
      source: `https://${url.host}/${owner}/${repo}`.toLowerCase(),
      relativePath: normalizePackageRelativePath(relativePath),
    };
  } catch {
    return null;
  }
}

export function repoSkillInstallIdentity(repoUrl: string, relativePath: string): string {
  return `${normalizePackageSource(repoUrl)}#${normalizePackageRelativePath(relativePath)}`;
}

export function installedSkillRepoIdentity(skill: SkillSummary): string | null {
  const parsed = parseRepoSkillSourceIdentity(skill.sourceUrl);
  if (!parsed) {
    return null;
  }

  return `${parsed.source}#${parsed.relativePath}`;
}

export function isRepoSkillCandidateInstalled(
  relativePath: string,
  repoUrl: string,
  installedSkills: SkillSummary[],
): boolean {
  const identity = repoSkillInstallIdentity(repoUrl, relativePath);
  return installedSkills.some((skill) => installedSkillRepoIdentity(skill) === identity);
}
