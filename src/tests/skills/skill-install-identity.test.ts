import { expect, test } from "vitest";
import type { MarketplaceSkill } from "@/features/skills/state/skill-store";
import { buildInstalledMarketplaceSkillIds } from "@/features/skills/utils/skill-install-identity";

test("uses marketplace install state for non-Git skills", () => {
  const skill: MarketplaceSkill = {
    id: "skillhub-web-tools-guide",
    name: "web-tools-guide",
    sourceType: "marketplace",
    sourceSite: "skillhub",
    description: "Web tools",
    maintainer: "SkillHub",
    updatedAt: "2026-07-29",
    installLabel: "v1.0.2",
    sourceUrl: "https://skillhub.cn/skills/web-tools-guide",
    skillPath: "web-tools-guide",
    popularityLabel: "196.7K",
    installed: true,
    currentVersion: "1.0.2",
  };

  const installedIds = buildInstalledMarketplaceSkillIds([skill], []);

  expect(installedIds).toEqual(new Set([skill.id]));
});
