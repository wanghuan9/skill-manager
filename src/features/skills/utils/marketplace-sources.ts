import type { MarketplaceSourceSite } from "@/features/skills/state/skill-store";

export const MARKETPLACE_SOURCE_SITES: MarketplaceSourceSite[] = [
  "skills.sh",
  "skillsmp",
  "skillhub",
  "clawhub",
];

const HIDDEN_MARKETPLACE_SOURCE_SITE: MarketplaceSourceSite = "clawhub";

export const VISIBLE_MARKETPLACE_SOURCE_SITES = MARKETPLACE_SOURCE_SITES.filter(
  (sourceSite) => sourceSite !== HIDDEN_MARKETPLACE_SOURCE_SITE,
);

export function createMarketplaceSourceRecord<Value>(
  createValue: (sourceSite: MarketplaceSourceSite) => Value,
) {
  return Object.fromEntries(
    MARKETPLACE_SOURCE_SITES.map((sourceSite) => [sourceSite, createValue(sourceSite)]),
  ) as Record<MarketplaceSourceSite, Value>;
}
