import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNotifications } from "@/app/notifications";
import { fetchMarketplaceSkillDescription, openExternalLink } from "@/features/skills/api/skill-client";
import type { MarketplaceSkill, MarketplaceSourceSite } from "@/features/skills/state/skill-store";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";

const marketplaceSkillDescriptionCache = new Map<string, string>();

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
  const { appSettings, installingMarketplaceSkillIds, installFromMarket } = useSkillWorkspace();
  const { notify } = useNotifications();
  const [selectedSkill, setSelectedSkill] = useState<MarketplaceSkill | null>(null);
  const installHint =
    appSettings.skillInstallActivation === "apply-all-tools"
      ? "安装后默认应用到所有已安装工具"
      : "安装后默认不启用，稍后可按工具单独开启";

  async function handleInstallSkill(skill: MarketplaceSkill) {
    try {
      await installFromMarket(skill);
      notify({ message: `技能 "${skill.name}" 已安装`, tone: "success" });
    } catch (error) {
      notify({
        message: error instanceof Error ? error.message : "安装失败，请稍后重试。",
        tone: "error",
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
          <h2>安装源</h2>
          <p>{installHint}</p>
        </div>
        <label className="market-search-field">
          <span className="sr-only">搜索 skill</span>
          <div className="market-search-input-wrap">
            <input
              className="market-search-input"
              type="search"
              value={searchQuery}
              placeholder="搜索 skill（支持全部安装源）"
              onChange={(event) => onSearchQueryChange(event.target.value)}
            />
            {isSearchLoading ? (
              <span className="loading-spinner market-search-spinner" aria-label="正在搜索" />
            ) : null}
          </div>
        </label>
        <div className="source-tab-row" role="tablist" aria-label="安装源">
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
      <div className="install-grid">
        {isInitialLoading ? (
          <section className="placeholder-card">
            <h3>正在搜索可安装技能</h3>
            <p>
              {isSearching
                ? `正在从所有安装源搜索 “${searchQuery.trim()}”...`
                : `正在搜索 ${activeSourceSite} 中的 skill，并按网站默认顺序展示。`}
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
                          aria-label={`打开 ${skill.name} 来源`}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void openExternalLink(buildOfficialRepositoryUrl(skill.sourceUrl));
                          }}
                        >
                          <ExternalLinkIcon />
                        </a>
                      </div>
                      <p>{buildListDescription(skill)}</p>
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
                    {isInstalled ? "已安装" : isInstalling ? "安装中..." : "安装"}
                  </button>
                </div>
                  <div className="install-card__chips">
                    <span className="install-card__chip">来源: {skill.sourceSite}</span>
                    <span className="install-card__chip">作者: {skill.maintainer}</span>
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
              <p className="install-loading-text">加载中...</p>
            ) : null}
            {!hasMore ? (
              <p className="install-loading-text">已加载全部技能</p>
            ) : null}
          </>
        ) : (
          <section className="placeholder-card">
            <h3>暂无可安装项</h3>
            <p>
              {isSearching
                ? `没有在支持的安装源中找到 “${searchQuery.trim()}” 相关 skill。`
                : `${activeSourceSite} 暂时还没有可展示的技能。`}
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
  const [description, setDescription] = useState(skill.description);
  const [isDescriptionLoading, setIsDescriptionLoading] = useState(false);
  const [descriptionNotice, setDescriptionNotice] = useState("");

  useEffect(() => {
    const cached = marketplaceSkillDescriptionCache.get(skill.id);
    if (cached) {
      setDescription(cached);
      setDescriptionNotice("");
      return;
    }

    let active = true;
    setDescription(skill.description);
    setDescriptionNotice("");
    setIsDescriptionLoading(true);
    void fetchMarketplaceSkillDescription({
      sourceSite: skill.sourceSite,
      sourceUrl: skill.sourceUrl,
      skillId: skill.id,
      skillName: skill.name,
      fallbackDescription: skill.description,
    })
      .then((value) => {
        if (!active) {
          return;
        }
        marketplaceSkillDescriptionCache.set(skill.id, value);
        setDescription(value);
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setDescription(skill.description);
        setDescriptionNotice("简介加载失败，已展示默认文案。");
      })
      .finally(() => {
        if (active) {
          setIsDescriptionLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [skill]);

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

  return (
    <div className="skill-detail-modal__backdrop" role="presentation" onClick={onClose}>
      <section
        className="skill-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${skill.name} 详情`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="skill-detail-modal__header">
          <div className="skill-detail-modal__title-group">
            <h3>{skill.name}</h3>
            <p>来源 {skill.sourceSite} · 作者 {skill.maintainer}</p>
          </div>
          <div className="skill-detail-modal__actions">
            <a
              className="skill-detail-modal__action-link"
              href={officialRepositoryUrl}
              onClick={(event) => {
                event.preventDefault();
                void openExternalLink(officialRepositoryUrl);
              }}
            >
              <ExternalLinkIcon />
              打开仓库
            </a>
            <button className="skill-detail-modal__close" type="button" onClick={onClose} aria-label="关闭详情">
              ×
            </button>
          </div>
        </header>
        <div className="skill-detail-modal__meta">
          <span className="install-card__chip">来源: {skill.sourceSite}</span>
          <span className="install-card__chip">作者: {skill.maintainer}</span>
          <span className="install-card__chip install-card__chip--metric">
            <DownloadIcon />
            {skill.popularityLabel}
          </span>
        </div>
        <article className="skill-detail-modal__content">
          <h4>Skill 介绍</h4>
          {isDescriptionLoading ? <p>正在加载技能简介...</p> : null}
          {descriptionNotice ? <p>{descriptionNotice}</p> : null}
          <p>{description}</p>
        </article>
      </section>
    </div>
  );
}

function buildListDescription(skill: MarketplaceSkill) {
  if (skill.sourceSite === "skillsmp" && skill.description && skill.description.trim()) {
    return skill.description;
  }
  const repositoryLabel = extractRepositoryLabel(skill.sourceUrl);
  return `来自 ${repositoryLabel || skill.maintainer} 的公开 skill（${skill.name}）`;
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

function tryParseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
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
