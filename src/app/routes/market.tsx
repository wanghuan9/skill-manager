import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslate } from "@/app/i18n";
import { MarketplaceInstallPanel } from "@/features/install/components/MarketplaceInstallPanel";
import { McpMarketplacePanel } from "@/features/install/components/McpMarketplacePanel";
import { PluginInstallPanel } from "@/features/install/components/PluginInstallPanel";
import { RepoInstallPanel } from "@/features/install/components/RepoInstallPanel";
import { LocalSkillImportList } from "@/features/local-skills/components/LocalSkillImportList";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type { MarketplaceSkill, MarketplaceSourceSite } from "@/features/skills/state/skill-store";
import { buildInstalledMarketplaceSkillIds } from "@/features/skills/utils/skill-install-identity";
import { dedupeMarketplaceSkills } from "@/features/skills/utils/marketplace-skills";
import {
  createMarketplaceSourceRecord,
  MARKETPLACE_SOURCE_SITES,
} from "@/features/skills/utils/marketplace-sources";

export type InstallTab = "market" | "git" | "local";
export type InstallCategory = "skill" | "mcp" | "plugin";

export const installTabs: { key: InstallTab; labelKey: "install.tab.market" | "install.tab.git" | "install.tab.local" }[] = [
  { key: "market", labelKey: "install.tab.market" },
  { key: "git", labelKey: "install.tab.git" },
  { key: "local", labelKey: "install.tab.local" },
];

const installCategories: { key: InstallCategory; labelKey: "install.category.skill" | "install.category.mcp" | "install.category.plugin" }[] = [
  { key: "skill", labelKey: "install.category.skill" },
  { key: "mcp", labelKey: "install.category.mcp" },
  { key: "plugin", labelKey: "install.category.plugin" },
];

const MARKET_INSTALL_SCROLL_SELECTOR = ".market-install-scroll";

function getMarketInstallScrollContainer() {
  const scrollContainer = document.querySelector(MARKET_INSTALL_SCROLL_SELECTOR);
  return scrollContainer instanceof HTMLElement ? scrollContainer : null;
}

function InstallTabIcon(props: { tab: InstallTab }) {
  const { tab } = props;

  if (tab === "market") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18Zm6.8 8h-3.1a14.4 14.4 0 0 0-1.3-5a7.05 7.05 0 0 1 4.4 5ZM12 5c.9 1.1 1.8 3.2 2 6h-4c.2-2.8 1.1-4.9 2-6ZM9.6 6a14.4 14.4 0 0 0-1.3 5H5.2a7.05 7.05 0 0 1 4.4-5ZM5.2 13h3.1a14.4 14.4 0 0 0 1.3 5a7.05 7.05 0 0 1-4.4-5Zm6.8 6c-.9-1.1-1.8-3.2-2-6h4c-.2 2.8-1.1 4.9-2 6Zm2.4-1a14.4 14.4 0 0 0 1.3-5h3.1a7.05 7.05 0 0 1-4.4 5Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (tab === "local") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M4 7.5A2.5 2.5 0 0 1 6.5 5h3.3c.5 0 1 .2 1.4.6l1.3 1.3c.2.2.5.4.9.4H17.5A2.5 2.5 0 0 1 20 9.8v6.7A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-9Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M10 7.5h-2A3.5 3.5 0 1 0 8 14h2m4-6.5h2a3.5 3.5 0 1 1 0 7h-2m-5 0 6-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type MarketRouteProps = {
  activeInstallCategory?: InstallCategory;
  activeInstallTab?: InstallTab;
  onInstallCategoryChange?: (category: InstallCategory) => void;
  onInstallTabChange?: (tab: InstallTab) => void;
};

export function MarketRoute(props: MarketRouteProps) {
  const {
    activeInstallCategory: controlledInstallCategory,
    activeInstallTab: controlledInstallTab,
  } = props;
  const {
    marketplaceSkills,
    installedSkills,
    loadInitialMarketplaceSkills,
    loadMoreMarketplaceSkills,
    searchMarketplaceSkills,
    isMarketplaceLoadingBySource,
    isSearchLoading,
    hasMoreMarketplaceSkillsBySource,
  } = useSkillWorkspace();
  const [internalInstallTab, setInternalInstallTab] = useState<InstallTab>("market");
  const [internalInstallCategory, setInternalInstallCategory] = useState<InstallCategory>("skill");
  const activeInstallCategory = controlledInstallCategory ?? internalInstallCategory;
  const activeInstallTab = controlledInstallTab ?? internalInstallTab;
  const [activeSourceSite, setActiveSourceSite] = useState<MarketplaceSourceSite>("skills.sh");
  const [searchQuery, setSearchQuery] = useState("");
  const [mcpSearchQuery, setMcpSearchQuery] = useState("");
  const [categoryToolbarContainer, setCategoryToolbarContainer] = useState<HTMLElement | null>(null);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MarketplaceSkill[]>([]);
  const [searchDone, setSearchDone] = useState(false);
  const latestSourceRef = useRef(activeSourceSite);
  const loadingMoreRef = useRef(false);
  const loadInitialRef = useRef(loadInitialMarketplaceSkills);
  const searchMarketplaceRef = useRef(searchMarketplaceSkills);
  const lastTabSkillsRef = useRef<Record<MarketplaceSourceSite, MarketplaceSkill[]>>(
    createMarketplaceSourceRecord(() => []),
  );
  const normalizedSearchQuery = debouncedSearchQuery.trim();
  const isSearching = normalizedSearchQuery.length > 0;
  const tabSkills = useMemo(
    () => marketplaceSkills.filter((skill) => skill.sourceSite === activeSourceSite),
    [activeSourceSite, marketplaceSkills],
  );
  // 只在非搜索状态下更新当前来源的缓存，避免搜索结果污染，也避免切换来源时串用另一组列表。
  if (tabSkills.length > 0 && !isSearching) {
    lastTabSkillsRef.current[activeSourceSite] = tabSkills;
  }
  const stableTabSkills = tabSkills.length > 0 ? tabSkills : lastTabSkillsRef.current[activeSourceSite] ?? [];
  const displayedMarketplaceSkills = isSearching && searchDone ? searchResults : stableTabSkills;
  const installedMarketplaceSkillIds = useMemo(
    () => buildInstalledMarketplaceSkillIds(displayedMarketplaceSkills, installedSkills),
    [displayedMarketplaceSkills, installedSkills],
  );

  useEffect(() => {
    latestSourceRef.current = activeSourceSite;
  }, [activeSourceSite]);

  useEffect(() => {
    setCategoryToolbarContainer(document.getElementById("install-header-toolbar-slot"));
  }, []);

  useEffect(() => {
    loadInitialRef.current = loadInitialMarketplaceSkills;
    searchMarketplaceRef.current = searchMarketplaceSkills;
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [searchQuery]);

  useEffect(() => {
    if (activeInstallTab !== "market") {
      setSearchResults([]);
      setSearchDone(false);
      return;
    }
    if (!isSearching) {
      setSearchResults([]);
      setSearchDone(false);
      return;
    }
    let cancelled = false;
    void searchMarketplaceRef.current(normalizedSearchQuery)
      .then((skills) => {
        if (cancelled) return;
        // 按 id 去重，避免重复结果
        const dedupedSkills = dedupeMarketplaceSkills(skills);
        setSearchResults(dedupedSkills);
        setSearchDone(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSearchResults([]);
        setSearchDone(true);
      });
    return () => {
      cancelled = true;
    };
  }, [activeInstallTab, isSearching, normalizedSearchQuery]);

  useEffect(() => {
    if (activeInstallTab !== "market" || isSearching) {
      return;
    }
    void loadInitialRef.current(activeSourceSite);
  }, [activeInstallTab, activeSourceSite, isSearching, loadInitialRef]);

  const isMarketplaceLoadingRef = useRef(isMarketplaceLoadingBySource);
  const hasMoreMarketplaceSkillsRef = useRef(hasMoreMarketplaceSkillsBySource);
  const loadMoreMarketplaceSkillsRef = useRef(loadMoreMarketplaceSkills);
  const isMarketplaceLoading = isMarketplaceLoadingBySource[activeSourceSite] ?? false;
  const hasMoreMarketplaceSkills = hasMoreMarketplaceSkillsBySource[activeSourceSite] ?? false;
  const isMarketplaceInitializing =
    !isSearching && stableTabSkills.length === 0 && (isMarketplaceLoading || hasMoreMarketplaceSkills);

  useEffect(() => {
    isMarketplaceLoadingRef.current = isMarketplaceLoadingBySource;
  }, [isMarketplaceLoadingBySource]);

  useEffect(() => {
    hasMoreMarketplaceSkillsRef.current = hasMoreMarketplaceSkillsBySource;
  }, [hasMoreMarketplaceSkillsBySource]);

  useEffect(() => {
    loadMoreMarketplaceSkillsRef.current = loadMoreMarketplaceSkills;
  }, [loadMoreMarketplaceSkills]);

  const handleScroll = useCallback(() => {
    const sourceSite = latestSourceRef.current;
    if (
      loadingMoreRef.current ||
      isMarketplaceLoadingRef.current[sourceSite] ||
      !hasMoreMarketplaceSkillsRef.current[sourceSite]
    ) {
      return;
    }
    const scrollContainer = getMarketInstallScrollContainer();
    if (!scrollContainer) {
      return;
    }
    if (scrollContainer.clientHeight <= 0) {
      return;
    }
    const remain = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    if (remain > 140) {
      return;
    }
    loadingMoreRef.current = true;
    void loadMoreMarketplaceSkillsRef.current?.(sourceSite).finally(() => {
      loadingMoreRef.current = false;
    });
  }, []);

  useEffect(() => {
    if (activeInstallTab !== "market" || isSearching || activeInstallCategory !== "skill") {
      return;
    }
    const scrollContainer = getMarketInstallScrollContainer();
    if (!scrollContainer) {
      return;
    }

    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
    };
  }, [activeInstallTab, isSearching, handleScroll, activeInstallCategory]);

  useEffect(() => {
    if (
      activeInstallTab !== "market" ||
      isSearching ||
      activeInstallCategory !== "skill" ||
      isMarketplaceLoading ||
      !hasMoreMarketplaceSkills
    ) {
      return;
    }

    handleScroll();
  }, [
    activeInstallCategory,
    activeInstallTab,
    handleScroll,
    hasMoreMarketplaceSkills,
    isMarketplaceLoading,
    isSearching,
    stableTabSkills.length,
  ]);

  const categorySwitcher = (
            <InstallCategorySwitcher
              activeCategory={activeInstallCategory}
              onCategoryChange={props.onInstallCategoryChange ?? setInternalInstallCategory}
            />
  );

  return (
    <div className="market-route">
      {categoryToolbarContainer ? createPortal(categorySwitcher, categoryToolbarContainer) : null}
      <section className="market-shell">
        {categoryToolbarContainer ? null : categorySwitcher}
        {activeInstallCategory === "skill" ? (
          <>
            <InstallTabSwitcher
              activeInstallTab={activeInstallTab}
              onInstallTabChange={props.onInstallTabChange ?? setInternalInstallTab}
            />
            {activeInstallTab === "market" ? (
              <MarketplaceInstallPanel
                activeSourceSite={activeSourceSite}
                sourceTabs={MARKETPLACE_SOURCE_SITES}
                marketplaceSkills={displayedMarketplaceSkills}
                onSourceChange={setActiveSourceSite}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                isSearching={isSearching}
                isSearchLoading={isSearchLoading}
                isInitialLoading={isMarketplaceInitializing}
                isLoadingMore={isSearching ? false : isMarketplaceLoading}
                hasMore={isSearching ? false : hasMoreMarketplaceSkills}
                installedMarketplaceSkillIds={installedMarketplaceSkillIds}
                onLoadMore={() => {
                  if (isSearching || isMarketplaceLoading || !hasMoreMarketplaceSkills) {
                    return;
                  }
                  void loadMoreMarketplaceSkills(activeSourceSite);
                }}
              />
            ) : null}
            {activeInstallTab === "git" ? <RepoInstallPanel /> : null}
            {activeInstallTab === "local" ? <LocalSkillImportList /> : null}
          </>
        ) : activeInstallCategory === "mcp" ? (
          <McpMarketplacePanel
            searchQuery={mcpSearchQuery}
            onSearchQueryChange={setMcpSearchQuery}
          />
        ) : (
          <PluginInstallPanel />
        )}
      </section>
    </div>
  );
}

type InstallCategorySwitcherProps = {
  activeCategory: InstallCategory;
  onCategoryChange: (category: InstallCategory) => void;
};

function InstallCategorySwitcher(props: InstallCategorySwitcherProps) {
  const { t } = useTranslate();
  const { activeCategory, onCategoryChange } = props;

  return (
    <div className="page-tabs-row page-tabs-center install-category-tabs-row">
      <div className="page-tabs filter-tabs install-category-row" role="tablist" aria-label={t("install.category.aria")}>
        {installCategories.map((category) => {
          const selected = category.key === activeCategory;

          return (
            <button
              key={category.key}
              className={`filter-tab install-category-tab${selected ? " active is-selected" : ""}`}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onCategoryChange(category.key)}
            >
              <span className="tab-icon install-category-tab__icon">
                <InstallCategoryIcon category={category.key} />
              </span>
              <span>{t(category.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function InstallCategoryIcon(props: { category: InstallCategory }) {
  const { category } = props;

  if (category === "skill") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 4.5 14 10l5.5 2-5.5 2L12 19.5l-2-5.5L4.5 12 10 10 12 4.5Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (category === "mcp") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M2.4 11.3 11.45 2.26a3.2 3.2 0 0 1 4.53 4.53l-6.84 6.83"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.6"
        />
        <path
          d="m9.24 13.53 6.74-6.74a3.2 3.2 0 0 1 4.52 0l.05.05a3.2 3.2 0 0 1 0 4.52l-8.19 8.19a1.07 1.07 0 0 0 0 1.51l1.68 1.68"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.6"
        />
        <path
          d="m13.71 4.53-6.69 6.69a3.2 3.2 0 0 0 4.53 4.53l6.69-6.7"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.6"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M9 3v5m6-5v5M6.5 8.5h11v4.3a5.5 5.5 0 0 1-11 0V8.5ZM12 18.3V21"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type InstallTabSwitcherProps = {
  activeInstallTab: InstallTab;
  onInstallTabChange: (tab: InstallTab) => void;
};

export function InstallTabSwitcher(props: InstallTabSwitcherProps) {
  const { t } = useTranslate();
  const { activeInstallTab, onInstallTabChange } = props;

  return (
    <div className="market-tab-row" role="tablist" aria-label={t("install.tabs.aria")}>
      {installTabs.map((tab) => {
        const selected = tab.key === activeInstallTab;

        return (
          <button
            key={tab.key}
            className={`market-tab${selected ? " is-selected" : ""}`}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onInstallTabChange(tab.key)}
          >
            <span className="market-tab__icon">
              <InstallTabIcon tab={tab.key} />
            </span>
            <span>{t(tab.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}
