import type { MarketplaceSourceSite } from "@/features/skills/state/skill-store";

export const MARKETPLACE_SOURCE_SITES: MarketplaceSourceSite[] = [
  "skills.sh",
  "skillsmp",
  "skillhub",
];

export function createMarketplaceSourceRecord<Value>(
  createValue: (sourceSite: MarketplaceSourceSite) => Value,
) {
  return Object.fromEntries(
    MARKETPLACE_SOURCE_SITES.map((sourceSite) => [sourceSite, createValue(sourceSite)]),
  ) as Record<MarketplaceSourceSite, Value>;
}
