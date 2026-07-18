import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslate } from "@/app/i18n";
import { useFailureReporter } from "@/app/failure-feedback";
import { useNotifications } from "@/app/notifications";
import { MarketplaceSkillDetailPreview } from "@/features/install/components/MarketplaceSkillDetailPreview";
import { openExternalLink } from "@/features/skills/api/skill-client";
import type { MarketplaceSkill, MarketplaceSourceSite } from "@/features/skills/state/skill-store";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";

type MarketplaceInstallPanelProps = {
  activeSourceSite: MarketplaceSourceSite;
  sourceTabs: MarketplaceSourceSite[];
  marketplaceSkills: MarketplaceSkill[];
  onSourceChange: (sourceSite: MarketplaceSourceSite) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  isSearching: boolean;
  isSearchLoading: boolean;
  isInitialLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  installedMarketplaceSkillIds: Set<string>;
  onLoadMore: () => void;
};

export function MarketplaceInstallPanel(props: MarketplaceInstallPanelProps) {
  const { t } = useTranslate();
  const {
    activeSourceSite,
    marketplaceSkills,
    onSourceChange,
    sourceTabs,
    searchQuery,
    onSearchQueryChange,
    isSearching,
    isSearchLoading,
    isInitialLoading,
    isLoadingMore,
    hasMore,
    installedMarketplaceSkillIds,
    onLoadMore,
  } = props;
  const { installingMarketplaceSkillIds, installFromMarket } = useSkillWorkspace();
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const [selectedSkill, setSelectedSkill] = useState<MarketplaceSkill | null>(null);

  async function handleInstallSkill(skill: MarketplaceSkill) {
    try {
      await installFromMarket(skill);
      notify({ message: t("install.market.success.installed", { name: skill.name }), tone: "success" });
    } catch (error) {
      reportFailure(error, {
        operation: "install_marketplace_skill",
        fallbackMessage: t("install.market.error.installFailed"),
        context: { skillId: skill.id, skillName: skill.name, sourceSite: skill.sourceSite },
      });
    }
  }

  function handleSkillSurfaceKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, skill: MarketplaceSkill) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    setSelectedSkill(skill);
  }

  return (
    <section className="panel-card market-panel">
      <div className="market-source-bar">
        <div className="panel-header">
          <h2>{t("install.sources.title")}</h2>
        </div>
        <label className="market-search-field">
          <span className="sr-only">{t("install.sources.searchAria")}</span>
          <div className="market-search-input-wrap">
            <input
              className="market-search-input"
              type="search"
              value={searchQuery}
              placeholder={t("install.sources.searchPlaceholder")}
              onChange={(event) => onSearchQueryChange(event.target.value)}
            />
            {isSearchLoading ? (
              <span className="loading-spinner market-search-spinner" aria-label={t("install.sources.searching")} />
            ) : null}
          </div>
        </label>
        <div className="source-tab-row" role="tablist" aria-label={t("install.sources.tabsAria")}>
          {sourceTabs.map((sourceSite) => {
            const selected = sourceSite === activeSourceSite;

            return (
              <button
                key={sourceSite}
                className={`source-tab${selected ? " is-selected" : ""}`}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onSourceChange(sourceSite)}
              >
                {sourceSite}
              </button>
            );
          })}
        </div>
      </div>
      <div className="install-grid market-install-scroll">
        {isInitialLoading ? (
          <section className="placeholder-card">
            <h3 className="install-loading-title">
              <span>{isSearching ? t("install.market.loading.searchTitle") : t("install.market.loading.title")}</span>
              {!isSearching ? (
                <span className="loading-ellipsis" aria-hidden="true">
                  <span>.</span>
                  <span>.</span>
                  <span>.</span>
                </span>
              ) : null}
            </h3>
            <p>
              {isSearching
                ? t("install.market.loading.searchDescription", { query: searchQuery.trim() })
                : t("install.market.loading.sourceDescription", { source: activeSourceSite })}
            </p>
          </section>
        ) : marketplaceSkills.length > 0 ? (
          <>
            {marketplaceSkills.map((skill) => {
              const isInstalled = installedMarketplaceSkillIds.has(skill.id);
              const isInstalling = installingMarketplaceSkillIds.has(skill.id);
              return (
              <article key={skill.id} className="placeholder-card install-card">
                <div
                  className="install-card__surface"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedSkill(skill)}
                  onKeyDown={(event) => handleSkillSurfaceKeyDown(event, skill)}
                >
                  <div className="install-card__header">
                  <div className="install-card__lead">
                    <div className={`install-card__avatar install-card__avatar--${buildAvatarTone(skill)}`}>
                      {skill.avatarUrl ? (
                        <img src={skill.avatarUrl} alt="" loading="lazy" />
                      ) : (
                        <SparkleIcon />
                      )}
                    </div>
                    <div className="install-card__title-group">
                      <div className="install-card__title-row">
                        <h3 title={skill.name}>{skill.name}</h3>
                        <a
                          className="install-card__link"
                          href={buildOfficialRepositoryUrl(skill.sourceUrl)}
                          aria-label={t("install.market.aria.openRepo", { name: skill.name })}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void openExternalLink(buildOfficialRepositoryUrl(skill.sourceUrl));
                          }}
                        >
                          <ExternalLinkIcon />
                        </a>
                      </div>
                      <p>{buildListDescription(skill, t)}</p>
                    </div>
                  </div>
                  <button
                    className="primary-button install-card__install-button"
                    type="button"
                    disabled={isInstalled || isInstalling}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleInstallSkill(skill);
                    }}
                  >
                    {isInstalled ? t("install.market.installed") : isInstalling ? t("install.market.installing") : t("install.market.install")}
                  </button>
                </div>
                  <div className="install-card__chips">
                    <span className="install-card__chip">{t("install.market.source")}: {skill.sourceSite}</span>
                    <span className="install-card__chip">{t("install.market.author")}: {skill.maintainer}</span>
                    <span className="install-card__chip install-card__chip--metric">
                      <DownloadIcon />
                      {skill.popularityLabel}
                    </span>
                  </div>
                </div>
              </article>
              );
            })}
            {isLoadingMore ? (
              <p className="install-loading-text">{t("install.market.loading.more")}</p>
            ) : null}
            {!hasMore ? (
              <p className="install-loading-text">{t("install.market.loading.done")}</p>
            ) : null}
          </>
        ) : (
          <section className="placeholder-card">
            <h3>{t("install.market.emptyTitle")}</h3>
            <p>
              {isSearching
                ? t("install.market.emptySearch", { query: searchQuery.trim() })
                : t("install.market.emptySource", { source: activeSourceSite })}
            </p>
          </section>
        )}
      </div>
      {selectedSkill ? (
        <SkillDetailModal skill={selectedSkill} onClose={() => setSelectedSkill(null)} />
      ) : null}
    </section>
  );
}

type SkillDetailModalProps = {
  skill: MarketplaceSkill;
  onClose: () => void;
};

function SkillDetailModal(props: SkillDetailModalProps) {
  const { skill, onClose } = props;
  const { t } = useTranslate();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const officialRepositoryUrl = buildOfficialRepositoryUrl(skill.sourceUrl);
  const marketplaceUrl = resolveMarketplaceSkillUrl(skill);

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <section
        className="skill-file-dialog marketplace-skill-file-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("install.market.detail.aria", { name: skill.name })}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="skill-detail-modal__header marketplace-skill-file-dialog__header">
          <div className="skill-detail-modal__title-group">
            <h3>{skill.name}</h3>
            <p>
              {t("install.market.detail.meta", {
                source: skill.sourceSite,
                author: skill.maintainer,
                downloads: skill.popularityLabel,
              })}
            </p>
          </div>
          <div className="skill-detail-modal__actions">
            {marketplaceUrl ? (
              <a
                className="skill-detail-modal__action-link"
                href={marketplaceUrl}
                onClick={(event) => {
                  event.preventDefault();
                  void openExternalLink(marketplaceUrl);
                }}
              >
                <ExternalLinkIcon />
                {t("install.market.detail.viewStore")}
              </a>
            ) : null}
            <a
              className="skill-detail-modal__action-link skill-detail-modal__action-link--primary"
              href={officialRepositoryUrl}
              onClick={(event) => {
                event.preventDefault();
                void openExternalLink(officialRepositoryUrl);
              }}
            >
              <ExternalLinkIcon />
              {t("install.market.detail.openRepo")}
            </a>
            <button
              className="skill-detail-modal__close"
              type="button"
              onClick={onClose}
              aria-label={t("install.market.detail.close")}
            >
              ×
            </button>
          </div>
        </header>
        <MarketplaceSkillDetailPreview key={skill.id} skill={skill} />
      </section>
    </div>
  );
}

function buildListDescription(
  skill: MarketplaceSkill,
  t: (key: "install.market.fallbackDescription", values: Record<string, string | number>) => string,
) {
  if (skill.sourceSite === "skillsmp" && skill.description && skill.description.trim()) {
    return skill.description;
  }
  const repositoryLabel = extractRepositoryLabel(skill.sourceUrl);
  return skill.description.trim() || t("install.market.fallbackDescription", {
    repository: repositoryLabel || skill.maintainer,
    name: skill.name,
  });
}

function extractRepositoryLabel(sourceUrl: string) {
  const parsed = tryParseUrl(sourceUrl);
  if (!parsed) {
    return "";
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length >= 2) {
    return `${segments[0]}/${segments[1].replace(/\.git$/i, "")}`;
  }
  return parsed.host;
}

function extractSkillsShMarketplacePath(skillId: string) {
  const normalizedSkillId = skillId.trim().replace(/^skills\.sh-/, "");
  if (!normalizedSkillId) {
    return "";
  }

  const separatorIndex = normalizedSkillId.indexOf("::");
  if (separatorIndex >= 0) {
    return normalizedSkillId.slice(separatorIndex + 2).trim().toLowerCase();
  }

  return normalizedSkillId.trim().toLowerCase();
}

function tryParseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function resolveMarketplaceSkillUrl(skill: MarketplaceSkill) {
  const explicitMarketplaceUrl = skill.marketplaceUrl?.trim() ?? "";
  if (explicitMarketplaceUrl) {
    return explicitMarketplaceUrl;
  }

  if (skill.sourceSite === "skillsmp") {
    const marketplaceSlug = skill.id.trim().replace(/^skillsmp-/, "");
    return marketplaceSlug ? `https://skillsmp.com/skills/${marketplaceSlug}` : "https://skillsmp.com";
  }

  if (skill.sourceSite !== "skills.sh") {
    return "";
  }

  const parsedSourceUrl = tryParseUrl(skill.sourceUrl);
  if (!parsedSourceUrl) {
    return "https://skills.sh/";
  }

  const segments = parsedSourceUrl.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return "https://skills.sh/";
  }

  const owner = segments[0];
  const repository = segments[1].replace(/\.git$/i, "");
  const treeIndex = segments.indexOf("tree");
  const blobIndex = segments.indexOf("blob");
  const cutIndex = treeIndex >= 0 ? treeIndex : blobIndex;
  const sourcePath = cutIndex >= 0 ? segments.slice(cutIndex + 2).join("/") : "";
  const fallbackPath = extractSkillsShMarketplacePath(skill.id);
  const marketplacePath = sourcePath || fallbackPath;

  return marketplacePath
    ? `https://skills.sh/${owner}/${repository}/${marketplacePath}`
    : `https://skills.sh/${owner}/${repository}`;
}

function buildAvatarTone(skill: MarketplaceSkill) {
  const tones = ["pink", "gold", "sky", "mint", "violet"];
  let hash = 0;
  const seed = `${skill.sourceSite}:${skill.name}`;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) % tones.length;
  }
  return tones[hash];
}

function buildOfficialRepositoryUrl(sourceUrl: string) {
  try {
    const parsed = new URL(sourceUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const treeIndex = segments.indexOf("tree");
    const blobIndex = segments.indexOf("blob");
    const cutIndex = treeIndex >= 0 ? treeIndex : blobIndex;
    if (cutIndex > 0) {
      parsed.pathname = `/${segments.slice(0, cutIndex).join("/")}`;
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
  } catch {
    return sourceUrl;
  }

  return sourceUrl;
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.5l1.8 4.7L18.5 10l-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8L12 3.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M14 5h5v5m-1-4-7.5 7.5M10 6H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
