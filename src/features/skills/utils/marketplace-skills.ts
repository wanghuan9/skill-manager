import type { MarketplaceSkill } from "@/features/skills/state/skill-store";

const POPULARITY_UNIT_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
  "万": 10_000,
  "亿": 100_000_000,
};

export function parseMarketplacePopularity(popularityLabel: string) {
  const normalizedLabel = popularityLabel.trim().replace(/,/g, "");
  const matched = normalizedLabel.match(/^(\d+(?:\.\d+)?)\s*([kmb万亿])?/i);
  if (!matched) {
    return 0;
  }

  const value = Number.parseFloat(matched[1] ?? "0");
  if (Number.isNaN(value)) {
    return 0;
  }

  const unit = matched[2]?.toLowerCase() ?? "";
  return value * (POPULARITY_UNIT_MULTIPLIERS[unit] ?? 1);
}

export function dedupeMarketplaceSkills(skills: MarketplaceSkill[]) {
  return Array.from(new Map(skills.map((skill) => [skill.id, skill])).values());
}

export function sortMarketplaceSkillsByPopularity(skills: MarketplaceSkill[]) {
  return skills
    .map((skill, index) => ({
      skill,
      index,
      popularity: parseMarketplacePopularity(skill.popularityLabel),
    }))
    .sort((left, right) => {
      const popularityDiff = right.popularity - left.popularity;
      if (popularityDiff !== 0) {
        return popularityDiff;
      }

      return left.index - right.index;
    })
    .map((item) => item.skill);
}
