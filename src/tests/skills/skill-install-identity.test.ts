import { expect, test } from "vitest";
import type { MarketplaceSkill } from "@/features/skills/state/skill-store";
import {
  installedSkillFixtures,
  marketplaceSkillFixtures,
} from "@/features/skills/state/skill-fixtures";
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

test("matches ClawHub Git entries by their repository identity", () => {
  const marketplaceSkill = marketplaceSkillFixtures.find((skill) => skill.installDriver === "git");
  if (!marketplaceSkill) {
    throw new Error("missing ClawHub Git fixture");
  }
  const installedSkill = {
    ...installedSkillFixtures[0],
    name: marketplaceSkill.name,
    sourceUrl: marketplaceSkill.sourceUrl,
    updateDriver: "git" as const,
  };

  const installedIds = buildInstalledMarketplaceSkillIds([marketplaceSkill], [installedSkill]);

  expect(installedIds).toEqual(new Set([marketplaceSkill.id]));
});

test("matches ClawHub hosted entries by owner and slug", () => {
  const marketplaceSkill = marketplaceSkillFixtures.find((skill) => skill.installDriver === "clawhub");
  if (!marketplaceSkill) {
    throw new Error("missing ClawHub hosted fixture");
  }
  const installedSkill = {
    ...installedSkillFixtures[0],
    name: marketplaceSkill.name,
    sourceUrl: marketplaceSkill.marketplaceUrl ?? marketplaceSkill.sourceUrl,
    updateDriver: "clawhub" as const,
    marketplaceOwner: marketplaceSkill.owner,
    marketplaceSlug: marketplaceSkill.slug,
  };

  const installedIds = buildInstalledMarketplaceSkillIds([marketplaceSkill], [installedSkill]);

  expect(installedIds).toEqual(new Set([marketplaceSkill.id]));
});
