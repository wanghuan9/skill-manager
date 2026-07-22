import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { SearchFieldIcon } from "@/app/components/SearchFieldIcon";
import { useTranslate } from "@/app/i18n";
import { useFailureReporter } from "@/app/failure-feedback";
import { openExternalLink } from "@/features/skills/api/skill-client";
import { filterSkills, hasEnabledTool } from "@/features/skills/state/skill-selectors";
import { SkillCard } from "@/features/skills/components/SkillCard";
import { SkillSourceView } from "@/features/skills/components/SkillSourceView";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { groupSkillsBySource } from "@/features/skills/utils/skill-groups";
import {
  readSkillGroupCollapsedState,
  type SkillViewMode,
  writeSkillGroupCollapsedState,
} from "@/features/skills/utils/skill-view-preference";
import { getMonogramLabel } from "@/features/skills/utils/monogram";
import { ToolbarGoInstallButton } from "@/app/components/ToolbarGoInstallButton";
import { useStableListOrder } from "@/app/hooks/useStableListOrder";
import { AppSelect } from "@/app/components/AppSelect";
import type { SkillStatusFilter, SkillSummary } from "@/features/skills/state/skill-store";
import {
  MANAGED_SKILL_SOURCE_ID,
  type SkillSourceId,
  type ToolSkillManagementFilter,
} from "@/features/skills/utils/skill-source-view";

type SkillToolbarProps = {
  activeSourceId?: SkillSourceId;
  query: string;
  statusFilter: SkillStatusFilter;
  managementFilter?: ToolSkillManagementFilter;
  managementFilterCounts?: Record<ToolSkillManagementFilter, number>;
  onQueryChange: (value: string) => void;
  onStatusFilterChange: (value: SkillStatusFilter) => void;
  onManagementFilterChange?: (value: ToolSkillManagementFilter) => void;
  viewMode: SkillViewMode;
  onViewModeChange: (value: SkillViewMode) => void;
  onGoInstall?: () => void;
};

function ListIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="2.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 7h8M6 10h8M6 13h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 4.25h4.5v4.5H4v-4.5ZM11.5 4.25H16v4.5h-4.5v-4.5ZM4 11.25h4.5v4.5H4v-4.5ZM11.5 11.25H16v4.5h-4.5v-4.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function GroupIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 5.5h12M4 10h12M4 14.5h12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M4 5.5h2M4 10h2M4 14.5h2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function RefreshIcon({ isSpinning = false }: { isSpinning?: boolean }) {
  return (
    <svg className={isSpinning ? "skills-toolbar-button__svg is-spinning" : "skills-toolbar-button__svg"} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M16.2 9.1a6.2 6.2 0 0 0-10.7-3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.7 3.9v3.7h3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.8 10.9a6.2 6.2 0 0 0 10.7 3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.3 16.1v-3.7h-3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UpdateAllIcon({ isSpinning = false }: { isSpinning?: boolean }) {
  return (
    <svg className={isSpinning ? "skills-toolbar-button__svg is-spinning" : "skills-toolbar-button__svg"} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M15.2 6.6A6.25 6.25 0 1 0 16 10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15.3 4.2v2.8h-2.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 5.5h12l-4.7 5.1v3.9l-2.6 1v-4.9L4 5.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function resolveSkillGroupTone(sourceType?: SkillSummary["sourceType"]) {
  if (sourceType === "local") {
    return "local";
  }
  if (sourceType === "gitlab") {
    return "gitlab";
  }
  if (sourceType === "github" || sourceType === "gitee") {
    return "github";
  }

  return "default";
}

function formatGroupSourceUrl(sourceUrl: string) {
  try {
    const parsedUrl = new URL(sourceUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return sourceUrl;
    }

    const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
    const repositoryPathEndIndex = pathSegments.findIndex((segment, index) => (
      segment === "tree"
      || segment === "blob"
      || (segment === "-" && (pathSegments[index + 1] === "tree" || pathSegments[index + 1] === "blob"))
    ));
    const repositoryPathSegments = repositoryPathEndIndex >= 0
      ? pathSegments.slice(0, repositoryPathEndIndex)
      : pathSegments;
    const repositoryPath = repositoryPathSegments.join("/").replace(/\.git$/i, "");

    return repositoryPath ? `${parsedUrl.origin}/${repositoryPath}` : parsedUrl.origin;
  } catch {
    return sourceUrl;
  }
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function SkillGroupMonogram({ label }: { label: string }) {
  return (
    <div className="skill-group-section__icon" aria-hidden="true">
      {getMonogramLabel(label)}
    </div>
  );
}

export function SkillListToolbar(props: SkillToolbarProps) {
  const { t } = useTranslate();
  const {
    query,
    activeSourceId = MANAGED_SKILL_SOURCE_ID,
    statusFilter,
    managementFilter = "all",
    managementFilterCounts = { all: 0, managed: 0, unmanaged: 0, mismatch: 0 },
    onQueryChange,
    onStatusFilterChange,
    onManagementFilterChange = () => undefined,
    viewMode,
    onViewModeChange,
    onGoInstall,
  } = props;
  const {
    installedSkills,
    isLoading,
    isWorkspaceRefreshing,
    isUpdatingAllSkills,
    refreshToolSkillEntries,
    refreshWorkspace,
    updateAllSkills,
  } = useSkillWorkspace();
  const [isToolSourceRefreshing, setIsToolSourceRefreshing] = useState(false);
  const reportFailure = useFailureReporter();
  const statusFilterCounts = useMemo(
    () => ({
      all: installedSkills.length,
      clean: installedSkills.filter((skill) => skill.collabStatus === "clean").length,
      "update-available": installedSkills.filter((skill) => skill.collabStatus === "update-available").length,
      "pending-commit": installedSkills.filter((skill) => skill.collabStatus === "pending-commit").length,
      "pending-push": installedSkills.filter((skill) => skill.collabStatus === "pending-push").length,
      diverged: installedSkills.filter((skill) => skill.collabStatus === "diverged").length,
      disabled: installedSkills.filter((skill) => !hasEnabledTool(skill)).length,
    }),
    [installedSkills],
  );
  const updatableSkillCount = useMemo(
    () => installedSkills.filter((skill) => skill.collabStatus === "update-available").length,
    [installedSkills],
  );
  const skillStatusFilterOptions: Array<{ value: SkillStatusFilter; label: string }> = [
    { value: "all", label: t("skills.filter.all") },
    { value: "update-available", label: t("skills.filter.updateAvailable") },
    { value: "pending-commit", label: t("skills.filter.pendingCommit") },
    { value: "pending-push", label: t("skills.filter.pendingPush") },
    { value: "disabled", label: t("skills.filter.disabled") },
  ];
  const managementFilterOptions: Array<{ value: ToolSkillManagementFilter; label: string }> = [
    { value: "all", label: t("skills.source.filter.all") },
    { value: "managed", label: t("skills.source.filter.managed") },
    { value: "unmanaged", label: t("skills.source.filter.unmanaged") },
    { value: "mismatch", label: t("skills.source.filter.mismatch") },
  ];
  const isManagedSource = activeSourceId === MANAGED_SKILL_SOURCE_ID;
  const isRefreshLoading = isManagedSource ? isWorkspaceRefreshing : isToolSourceRefreshing;
  const updateAllButtonLabel = updatableSkillCount > 0
    ? t("skills.updateAllWithCount", { count: updatableSkillCount })
    : t("skills.updateAll");

  async function handleRefreshWorkspace() {
    if (isRefreshLoading) {
      return;
    }

    try {
      if (isManagedSource) {
        await refreshWorkspace({ showRefreshing: true });
        return;
      }

      setIsToolSourceRefreshing(true);
      await refreshToolSkillEntries(activeSourceId);
    } catch (error) {
      reportFailure(error, {
        operation: isManagedSource ? "refresh_workspace" : "refresh_tool_skill_entries",
        fallbackMessage: t("skills.error.refresh"),
      });
    } finally {
      setIsToolSourceRefreshing(false);
    }
  }

  async function handleUpdateAllSkills() {
    if (updatableSkillCount === 0 || isUpdatingAllSkills) {
      return;
    }

    try {
      await updateAllSkills();
    } catch (error) {
      reportFailure(error, {
        operation: "update_all_skills",
        fallbackMessage: t("skills.error.updateAll"),
      });
    }
  }

  return (
    <div className="skills-header-bar__tools">
      <label className="search-field search-field--header skill-search-field">
        <span className="sr-only">{t("skills.searchAria")}</span>
        <SearchFieldIcon />
        <input
          type="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={t(activeSourceId === MANAGED_SKILL_SOURCE_ID
            ? "skills.searchPlaceholder"
            : "skills.source.searchPlaceholder")}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </label>
      <div className="skills-view-toggle" role="group" aria-label={t("skills.view.aria")}>
        <button
          className={`skills-view-toggle__button${viewMode === "list" || (!isManagedSource && viewMode === "grouped") ? " is-active" : ""}`}
          type="button"
          aria-pressed={viewMode === "list" || (!isManagedSource && viewMode === "grouped")}
          aria-label={t("skills.view.list")}
          data-tooltip={t("skills.view.list")}
          onClick={() => onViewModeChange("list")}
        >
          <ListIcon />
        </button>
        <button
          className={`skills-view-toggle__button${viewMode === "grid" ? " is-active" : ""}`}
          type="button"
          aria-pressed={viewMode === "grid"}
          aria-label={t("skills.view.grid")}
          data-tooltip={t("skills.view.grid")}
          onClick={() => onViewModeChange("grid")}
        >
          <GridIcon />
        </button>
        {isManagedSource ? (
          <button
            className={`skills-view-toggle__button${viewMode === "grouped" ? " is-active" : ""}`}
            type="button"
            aria-pressed={viewMode === "grouped"}
            aria-label={t("skills.view.grouped")}
            data-tooltip={t("skills.view.grouped")}
            onClick={() => onViewModeChange("grouped")}
          >
            <GroupIcon />
          </button>
        ) : null}
      </div>
      <div className="skill-status-filter">
        <span className="sr-only">{t(isManagedSource ? "skills.filter.aria" : "skills.source.filter.aria")}</span>
        <span className="skill-status-filter__icon" aria-hidden="true">
          <FilterIcon />
        </span>
        {isManagedSource ? (
          <AppSelect
            value={statusFilter}
            options={skillStatusFilterOptions.map((option) => ({
              value: option.value,
              label: `${option.label} (${statusFilterCounts[option.value]})`,
            }))}
            onChange={onStatusFilterChange}
            ariaLabel={t("skills.filter.aria")}
            className="skill-status-filter__select"
            menuClassName="skill-status-filter__popover"
            minMenuWidth={96}
          />
        ) : (
          <AppSelect
            value={managementFilter}
            options={managementFilterOptions.map((option) => ({
              value: option.value,
              label: `${option.label} (${managementFilterCounts[option.value]})`,
            }))}
            onChange={onManagementFilterChange}
            ariaLabel={t("skills.source.filter.aria")}
            className="skill-status-filter__select"
            menuClassName="skill-status-filter__popover"
            minMenuWidth={96}
          />
        )}
      </div>
      <button
        className={`secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--refresh${isRefreshLoading ? " is-loading" : ""}`}
        type="button"
        onClick={() => void handleRefreshWorkspace()}
        disabled={isRefreshLoading}
      >
        <span aria-hidden="true" className="skills-toolbar-button__icon">
          <RefreshIcon isSpinning={isRefreshLoading} />
        </span>
        <span>{t("skills.refresh")}</span>
      </button>
      {activeSourceId === MANAGED_SKILL_SOURCE_ID ? (
        <button
          className={`secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--update-all${isUpdatingAllSkills ? " is-loading" : ""}`}
          type="button"
          onClick={() => void handleUpdateAllSkills()}
          disabled={isLoading || isUpdatingAllSkills || updatableSkillCount === 0}
        >
          <span aria-hidden="true" className="skills-toolbar-button__icon">
            <UpdateAllIcon isSpinning={isUpdatingAllSkills} />
          </span>
          <span>{isUpdatingAllSkills ? t("skills.updating") : updateAllButtonLabel}</span>
        </button>
      ) : null}
      {onGoInstall ? <ToolbarGoInstallButton onClick={onGoInstall} /> : null}
    </div>
  );
}

type SkillListPageProps = {
  activeSourceId?: SkillSourceId;
  onActiveSourceIdChange?: (sourceId: SkillSourceId) => void;
  focusedManagedSkillName?: string;
  onShowManagedSkill?: (skillName: string) => void;
  onImportFromLocal?: () => void;
  onInstallFromGit?: () => void;
  onInstallFromMarketplace?: () => void;
  query: string;
  statusFilter: SkillStatusFilter;
  managementFilter?: ToolSkillManagementFilter;
  viewMode: SkillViewMode;
};

const SKILL_GRID_COLUMN_COUNT = 3;

function getSkillOrderKey(skill: SkillSummary) {
  return skill.name;
}

export function SkillListPage(props: SkillListPageProps) {
  const { t } = useTranslate();
  const {
    onImportFromLocal,
    onInstallFromGit,
    onInstallFromMarketplace,
    query,
    statusFilter,
    managementFilter = "all",
    viewMode,
    activeSourceId = MANAGED_SKILL_SOURCE_ID,
    onActiveSourceIdChange = () => undefined,
    focusedManagedSkillName = "",
    onShowManagedSkill = () => undefined,
  } = props;
  const { installedSkills, isLoading, isWorkspaceRefreshing } = useSkillWorkspace();
  const deferredQuery = useDeferredValue(query);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(readSkillGroupCollapsedState);
  const [expandedSkillName, setExpandedSkillName] = useState("");
  const [skillOrderRevision, setSkillOrderRevision] = useState(0);
  const wasWorkspaceRefreshingRef = useRef(isWorkspaceRefreshing);
  const statusSortedSkills = useMemo(
    () => [...filterSkills(installedSkills, { query: "", status: "all" })]
      .sort((left, right) => Number(hasEnabledTool(right)) - Number(hasEnabledTool(left))),
    [installedSkills],
  );
  const orderedInstalledSkills = useStableListOrder(
    statusSortedSkills,
    getSkillOrderKey,
    skillOrderRevision,
  );
  const skills = useMemo(() => {
    const visibleSkillNames = new Set(
      filterSkills(installedSkills, { query: deferredQuery, status: statusFilter })
        .map((skill) => skill.name),
    );
    return orderedInstalledSkills.filter((skill) => visibleSkillNames.has(skill.name));
  }, [deferredQuery, installedSkills, orderedInstalledSkills, statusFilter]);
  const groupedSkills = useMemo(
    () => groupSkillsBySource(skills, { localLabel: t("skills.source.local") }),
    [skills, t],
  );
  const skillGridRows = useMemo(() => {
    const rows: SkillSummary[][] = [];
    for (let index = 0; index < skills.length; index += SKILL_GRID_COLUMN_COUNT) {
      rows.push(skills.slice(index, index + SKILL_GRID_COLUMN_COUNT));
    }
    return rows;
  }, [skills]);
  const allGroupedSkills = useMemo(
    () => groupSkillsBySource(orderedInstalledSkills, { localLabel: t("skills.source.local") }),
    [orderedInstalledSkills, t],
  );

  useEffect(() => {
    if (wasWorkspaceRefreshingRef.current && !isWorkspaceRefreshing) {
      setSkillOrderRevision((current) => current + 1);
    }
    wasWorkspaceRefreshingRef.current = isWorkspaceRefreshing;
  }, [isWorkspaceRefreshing]);

  useEffect(() => {
    if (activeSourceId !== MANAGED_SKILL_SOURCE_ID || !focusedManagedSkillName) {
      return;
    }

    setExpandedSkillName(focusedManagedSkillName);
  }, [activeSourceId, focusedManagedSkillName]);

  useEffect(() => {
    if (activeSourceId !== MANAGED_SKILL_SOURCE_ID || !focusedManagedSkillName || viewMode !== "grouped") {
      return;
    }

    const targetGroup = allGroupedSkills.find((group) => (
      group.skills.some((skill) => skill.name === focusedManagedSkillName)
    ));
    if (!targetGroup) {
      return;
    }

    setCollapsedGroups((current) => {
      if (!(current[targetGroup.id] ?? true)) {
        return current;
      }
      const nextState = { ...current, [targetGroup.id]: false };
      writeSkillGroupCollapsedState(nextState);
      return nextState;
    });
  }, [activeSourceId, allGroupedSkills, focusedManagedSkillName, viewMode]);

  function isGroupCollapsed(groupId: string) {
    return collapsedGroups[groupId] ?? true;
  }

  function toggleGroup(groupId: string) {
    setCollapsedGroups((current) => {
      const nextState = {
        ...current,
        [groupId]: !(current[groupId] ?? true),
      };
      writeSkillGroupCollapsedState(nextState);
      return nextState;
    });
  }

  function handleSkillExpandedChange(skillName: string, expanded: boolean) {
    setExpandedSkillName(expanded ? skillName : "");
  }

  return (
    <div className="skills-page">
      <SkillSourceView
        activeSourceId={activeSourceId}
        onActiveSourceIdChange={onActiveSourceIdChange}
        onShowManagedSkill={onShowManagedSkill}
        managementFilter={managementFilter}
        query={deferredQuery}
        viewMode={viewMode}
      />
      {activeSourceId === MANAGED_SKILL_SOURCE_ID ? (
        <div className={`card-list${viewMode === "grid" ? " skill-card-grid" : ""}`}>
        {isLoading ? (
          <div className="panel-card empty-state">
            <h3>{t("skills.loadingTitle")}</h3>
            <p>{t("skills.loadingDescription")}</p>
          </div>
        ) : groupedSkills.length > 0 ? (
          viewMode === "grouped" ? (
          groupedSkills.map((group) => {
            const updateCount = group.skills.filter((skill) => skill.collabStatus === "update-available").length;
            const pendingCommitCount = group.skills.filter((skill) => skill.collabStatus === "pending-commit").length;
            const pendingPushCount = group.skills.filter((skill) => skill.collabStatus === "pending-push").length;
            const isCollapsed = isGroupCollapsed(group.id);
            const groupTone = resolveSkillGroupTone(group.skills[0]?.sourceType);
            const groupSourceUrl = formatGroupSourceUrl(group.skills[0]?.sourceUrl ?? group.label);
            const isGroupSourceLinkable = isHttpUrl(groupSourceUrl);

            return (
              <section key={group.id} className={`skill-group-section skill-group-section--${groupTone}`}>
                <div
                  className="skill-group-section__header"
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleGroup(group.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleGroup(group.id);
                    }
                  }}
                  aria-expanded={!isCollapsed}
                  aria-label={t(isCollapsed ? "skills.group.expand" : "skills.group.collapse", { label: group.label })}
                >
                  <div className="skill-group-section__title">
                    <SkillGroupMonogram label={group.label} />
                    <div className="skill-group-section__copy">
                      <div className="skill-group-section__name-row">
                        <h3>{group.label}</h3>
                        <span className="skill-group-section__badge" aria-hidden="true">
                          {t("skills.group.badge")}
                        </span>
                        <span className="skill-group-section__count">{t("skills.group.count", { count: group.skills.length })}</span>
                      </div>
                      <p className="skill-group-section__source">
                        <span>
                          {t("skills.group.sourcePrefix")}
                          {isGroupSourceLinkable ? (
                            <a
                              href={groupSourceUrl}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void openExternalLink(groupSourceUrl);
                              }}
                            >
                              {groupSourceUrl}
                            </a>
                          ) : (
                            groupSourceUrl
                          )}
                        </span>
                      </p>
                    </div>
                  </div>
                  <div className="skill-group-section__meta">
                    {updateCount > 0 ? <span className="skill-group-section__state skill-group-section__state--update">{t("skills.group.updateCount", { count: updateCount })}</span> : null}
                    {pendingCommitCount > 0 ? (
                      <span className="skill-group-section__state skill-group-section__state--commit">
                        {t("skills.group.pendingCommitCount", { count: pendingCommitCount })}
                      </span>
                    ) : pendingPushCount > 0 ? (
                      <span className="skill-group-section__state skill-group-section__state--pending">
                        {t("skills.group.pendingCount", { count: pendingPushCount })}
                      </span>
                    ) : null}
                    <span
                      className="skill-group-section__toggle"
                      aria-hidden="true"
                    >
                      <span className={`skill-group-section__chevron${isCollapsed ? " is-collapsed" : ""}`}>
                        ⌄
                      </span>
                    </span>
                  </div>
                </div>
                {!isCollapsed ? (
                  <div className="skill-group-section__list">
                    {group.skills.map((skill) => (
                      <SkillCard
                        key={skill.name}
                        skill={skill}
                        expanded={expandedSkillName === skill.name}
                        autoAlignWhenExpanded={focusedManagedSkillName === skill.name}
                        onExpandedChange={(expanded) => handleSkillExpandedChange(skill.name, expanded)}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })
          ) : (
            viewMode === "grid" ? (
              skillGridRows.map((row) => {
                return (
                  <div key={row[0].name} className="skill-card-grid__row">
                    {row.map((skill) => (
                      <SkillCard
                        key={skill.name}
                        skill={skill}
                        layout="grid"
                        expanded={expandedSkillName === skill.name}
                        autoAlignWhenExpanded={focusedManagedSkillName === skill.name}
                        onExpandedChange={(expanded) => handleSkillExpandedChange(skill.name, expanded)}
                      />
                    ))}
                  </div>
                );
              })
            ) : (
              skills.map((skill) => (
                <SkillCard
                  key={skill.name}
                  skill={skill}
                  expanded={expandedSkillName === skill.name}
                  autoAlignWhenExpanded={focusedManagedSkillName === skill.name}
                  onExpandedChange={(expanded) => handleSkillExpandedChange(skill.name, expanded)}
                />
              ))
            )
          )
        ) : (
          <div className="panel-card empty-state">
            {installedSkills.length === 0 ? (
              <>
                <h3>{t("skills.empty.noneTitle")}</h3>
                <p>{t("skills.empty.noneDescription")}</p>
                <div className="empty-state__actions">
                  <button className="primary-button" type="button" onClick={onInstallFromMarketplace}>
                    {t("skills.empty.market")}
                  </button>
                  <button className="secondary-button" type="button" onClick={onInstallFromGit}>
                    {t("skills.empty.git")}
                  </button>
                  <button className="secondary-button" type="button" onClick={onImportFromLocal}>
                    {t("skills.empty.local")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>{t("skills.empty.noMatchTitle")}</h3>
                <p>{t("skills.empty.noMatchDescription")}</p>
              </>
            )}
          </div>
        )}
        </div>
      ) : null}
    </div>
  );
}
