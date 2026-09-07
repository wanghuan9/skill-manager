import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { SearchFieldIcon } from "@/app/components/SearchFieldIcon";
import { useTranslate } from "@/app/i18n";
import { useFailureReporter } from "@/app/failure-feedback";
import { useNotifications } from "@/app/notifications";
import { openExternalLink } from "@/features/skills/api/skill-client";
import {
  filterSkills,
  getSkillIdentity,
  hasEnabledTool,
} from "@/features/skills/state/skill-selectors";
import { SkillCard } from "@/features/skills/components/SkillCard";
import { SkillSourceView } from "@/features/skills/components/SkillSourceView";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { groupSkillsBySource, groupSkillsByTag } from "@/features/skills/utils/skill-groups";
import {
  readSkillGroupCollapsedState,
  type SkillGroupMode,
  type SkillViewMode,
  writeSkillGroupCollapsedState,
} from "@/features/skills/utils/skill-view-preference";
import { getMonogramLabel } from "@/features/skills/utils/monogram";
import { ToolbarGoInstallButton } from "@/app/components/ToolbarGoInstallButton";
import { useStableListOrder } from "@/app/hooks/useStableListOrder";
import { AppSelect } from "@/app/components/AppSelect";
import {
  BatchActionBar,
  BatchDeleteDialog,
  BatchModeButton,
  BatchSelectionMark,
} from "@/app/components/BatchActions";
import { useBatchSelection } from "@/app/hooks/useBatchSelection";
import {
  DEFAULT_SKILL_TAG_FILTER_LAYOUT,
  type ManagedSkillOwnerFilter,
  type SkillManagementOwner,
  type SkillTagFilterLayout,
  type SkillStatusFilter,
  type SkillSummary,
} from "@/features/skills/state/skill-store";
import {
  MANAGED_SKILL_SOURCE_ID,
  type SkillSourceId,
  type ToolSkillManagementFilter,
} from "@/features/skills/utils/skill-source-view";
import { setSkillAllToolsEnabled } from "@/features/skills/utils/skill-bulk-status";
import { mergeSkillToolsWithInstalledTools } from "@/features/skills/utils/skill-tools";
import { isToolEnabledStatus } from "@/features/skills/utils/tool-status";
import { resolveSkillTagTone } from "@/features/skills/utils/skill-tag-color";
import {
  collectSkillTagFilterGroups,
  isSameSkillTagFilter,
  isSkillTagFilterAvailable,
  type SkillSourceMethod,
  type SkillTagFilter,
  type SkillTagFilterGroups,
} from "@/features/skills/utils/skill-tag-filter";

type SkillToolbarProps = {
  activeSourceId?: SkillSourceId;
  query: string;
  statusFilter: SkillStatusFilter;
  ownerFilter?: ManagedSkillOwnerFilter;
  managementFilter?: ToolSkillManagementFilter;
  managementFilterCounts?: Record<ToolSkillManagementFilter, number>;
  onQueryChange: (value: string) => void;
  onStatusFilterChange: (value: SkillStatusFilter) => void;
  onOwnerFilterChange?: (value: ManagedSkillOwnerFilter) => void;
  onManagementFilterChange?: (value: ToolSkillManagementFilter) => void;
  viewMode: SkillViewMode;
  onViewModeChange: (value: SkillViewMode) => void;
  groupMode?: SkillGroupMode;
  onGroupModeChange?: (value: SkillGroupMode) => void;
  tagFilter?: SkillTagFilter;
  tagFilterLayout?: SkillTagFilterLayout;
  isTagFilterVisible?: boolean;
  onTagFilterVisibleChange?: (isVisible: boolean) => void;
  onTagFilterChange?: (filter: SkillTagFilter | undefined) => void;
  onGoInstall?: () => void;
  isBatchSelecting?: boolean;
  onBatchSelectingChange?: (isSelecting: boolean) => void;
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

function TagFilterIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3.2 3.6h6l7.6 7.6-5.6 5.6-7.6-7.6V3.6Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="6.8" cy="6.8" r="1.1" fill="currentColor" />
    </svg>
  );
}

function TagFilterChevronIcon({ isExpanded }: { isExpanded: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={isExpanded ? "m4.5 9.5 3.5-3 3.5 3" : "m4.5 6.5 3.5 3 3.5-3"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TagFilterClearIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m5 5 6 6m0-6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const MANAGED_FILTER_STATUS_SECTION = "status-section";

type ManagedSkillCombinedFilter =
  | SkillStatusFilter
  | typeof MANAGED_FILTER_STATUS_SECTION;

type TagFilterOption = {
  filter: SkillTagFilter;
  label: string;
  count: number;
};

type TagFilterSection = {
  key: "source" | "owner" | "custom";
  label: string;
  options: TagFilterOption[];
};

type Translate = ReturnType<typeof useTranslate>["t"];

const SOURCE_TAG_TONE_CLASS: Record<SkillSourceMethod, string> = {
  local: "tag-tone-neutral",
  git: "tag-tone-source-git",
  marketplace: "tag-tone-source-marketplace",
  standard: "tag-tone-source-online",
};

function createTagFilterSections(groups: SkillTagFilterGroups, t: Translate): TagFilterSection[] {
  const sourceLabels: Record<SkillSourceMethod, string> = {
    local: t("skill.card.sourceMethod.local"),
    git: t("skill.card.sourceMethod.git"),
    standard: t("skill.card.sourceMethod.standard"),
    marketplace: t("skill.card.sourceMethod.marketplace"),
  };
  const ownerLabels: Record<SkillManagementOwner, string> = {
    skilldock: t("skill.card.owner.skilldock"),
    "agent-skills-cli": t("skill.card.owner.agentSkillsCli"),
    external: t("skill.card.owner.external"),
  };
  const customOptions: TagFilterOption[] = [
    ...(groups.untaggedCount > 0 ? [{
      filter: { kind: "untagged", value: "" } as const,
      label: t("skills.tagFilter.untagged"),
      count: groups.untaggedCount,
    }] : []),
    ...groups.customTags.map((item) => ({
      filter: { kind: "custom", value: item.value } as const,
      label: item.value,
      count: item.count,
    })),
  ];

  return [
    {
      key: "source",
      label: t("skills.tagFilter.sourceGroup"),
      options: groups.sources.map((item) => ({
        filter: { kind: "source", value: item.value },
        label: sourceLabels[item.value],
        count: item.count,
      })),
    },
    {
      key: "owner",
      label: t("skills.tagFilter.ownerGroup"),
      options: groups.owners.map((item) => ({
        filter: { kind: "owner", value: item.value },
        label: ownerLabels[item.value],
        count: item.count,
      })),
    },
    {
      key: "custom",
      label: t("skills.tagFilter.customGroup"),
      options: customOptions,
    },
  ].filter((section) => section.options.length > 0) as TagFilterSection[];
}

function getTagFilterToneClass(filter: SkillTagFilter) {
  if (filter.kind === "custom") {
    return `tag-tone-${resolveSkillTagTone(filter.value)}`;
  }
  if (filter.kind === "source") {
    return SOURCE_TAG_TONE_CLASS[filter.value];
  }
  return "tag-tone-neutral";
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
    onOwnerFilterChange = () => undefined,
    onManagementFilterChange = () => undefined,
    viewMode,
    onViewModeChange,
    groupMode = "source",
    onGroupModeChange = () => undefined,
    tagFilter,
    tagFilterLayout = DEFAULT_SKILL_TAG_FILTER_LAYOUT,
    isTagFilterVisible = true,
    onTagFilterVisibleChange = () => undefined,
    onTagFilterChange = () => undefined,
    onGoInstall,
    isBatchSelecting = false,
    onBatchSelectingChange = () => undefined,
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
  const [isTagFilterMenuOpen, setIsTagFilterMenuOpen] = useState(false);
  const tagFilterControlRef = useRef<HTMLDivElement | null>(null);
  const reportFailure = useFailureReporter();
  const statusFilterCounts = useMemo(
    () => ({
      all: installedSkills.length,
      clean: installedSkills.filter((skill) => skill.collabStatus === "clean").length,
      "update-available": installedSkills.filter((skill) => skill.collabStatus === "update-available").length,
      "pending-commit": installedSkills.filter((skill) => skill.collabStatus === "pending-commit").length,
      "pending-push": installedSkills.filter((skill) => skill.collabStatus === "pending-push").length,
      diverged: installedSkills.filter((skill) => skill.collabStatus === "diverged").length,
      enabled: installedSkills.filter(hasEnabledTool).length,
      disabled: installedSkills.filter((skill) => !hasEnabledTool(skill)).length,
    }),
    [installedSkills],
  );
  const updatableSkillCount = useMemo(
    () => installedSkills.filter((skill) => skill.collabStatus === "update-available").length,
    [installedSkills],
  );
  const tagFilterGroups = useMemo(
    () => collectSkillTagFilterGroups(installedSkills),
    [installedSkills],
  );
  const tagFilterSections = useMemo(
    () => createTagFilterSections(tagFilterGroups, t),
    [t, tagFilterGroups],
  );
  const selectedTagFilterOption = tagFilterSections
    .flatMap((section) => section.options)
    .find((option) => isSameSkillTagFilter(option.filter, tagFilter));
  const hasTagFilters = installedSkills.length > 0;
  const tagFilterLabel = selectedTagFilterOption?.label ?? t("skills.tagFilter.toggle");
  const isTagFilterControlExpanded = tagFilterLayout === "popover"
    ? isTagFilterMenuOpen
    : isTagFilterVisible;
  const tagFilterToggleLabel = tagFilterLayout === "popover"
    ? t(isTagFilterMenuOpen ? "skills.tagFilter.close" : "skills.tagFilter.open")
    : t(isTagFilterVisible ? "skills.tagFilter.collapse" : "skills.tagFilter.expand");
  const skillStatusFilterOptions: Array<{ value: SkillStatusFilter; label: string }> = [
    { value: "all", label: t("skills.filter.all") },
    { value: "update-available", label: t("skills.filter.updateAvailable") },
    { value: "pending-commit", label: t("skills.filter.pendingCommit") },
    { value: "pending-push", label: t("skills.filter.pendingPush") },
    { value: "enabled", label: t("tools.status.enabled") },
    { value: "disabled", label: t("skills.filter.disabled") },
  ];
  const managedFilterOptions: Array<{
    value: ManagedSkillCombinedFilter;
    label: string;
    disabled?: boolean;
  }> = [
    { value: MANAGED_FILTER_STATUS_SECTION, label: t("skills.filter.statusGroup"), disabled: true },
    ...skillStatusFilterOptions.map((option) => ({
      value: option.value,
      label: `${option.label} (${statusFilterCounts[option.value]})`,
    })),
  ];
  const managementFilterOptions: Array<{ value: ToolSkillManagementFilter; label: string }> = [
    { value: "all", label: t("skills.source.filter.all") },
    { value: "managed", label: t("skills.source.filter.managed") },
    { value: "unmanaged", label: t("skills.source.filter.unmanaged") },
    { value: "mismatch", label: t("skills.source.filter.mismatch") },
  ];
  const groupModeOptions: Array<{ value: SkillGroupMode; label: string }> = [
    { value: "source", label: t("skills.group.mode.source") },
    { value: "tag", label: t("skills.group.mode.tag") },
  ];
  const isManagedSource = activeSourceId === MANAGED_SKILL_SOURCE_ID;
  const managedFilterValue = statusFilter;
  const isRefreshLoading = isManagedSource ? isWorkspaceRefreshing : isToolSourceRefreshing;
  const updateAllButtonLabel = updatableSkillCount > 0
    ? t("skills.updateAllWithCount", { count: updatableSkillCount })
    : t("skills.updateAll");

  useEffect(() => {
    if (tagFilterLayout !== "popover" || !isTagFilterMenuOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!tagFilterControlRef.current?.contains(event.target as Node)) {
        setIsTagFilterMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsTagFilterMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isTagFilterMenuOpen, tagFilterLayout]);

  useEffect(() => {
    if (tagFilterLayout !== "popover" || !isManagedSource) {
      setIsTagFilterMenuOpen(false);
    }
  }, [isManagedSource, tagFilterLayout]);

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

  function handleManagedFilterChange(value: ManagedSkillCombinedFilter) {
    if (value === MANAGED_FILTER_STATUS_SECTION) {
      return;
    }
    onOwnerFilterChange("all");
    onStatusFilterChange(value);
  }

  function handleTagFilterControlToggle() {
    if (tagFilterLayout === "popover") {
      setIsTagFilterMenuOpen((current) => !current);
      return;
    }
    onTagFilterVisibleChange(!isTagFilterVisible);
  }

  function handleTagFilterOptionChange(option: TagFilterOption) {
    onTagFilterChange(isSameSkillTagFilter(option.filter, tagFilter) ? undefined : option.filter);
    if (tagFilterLayout === "popover") {
      setIsTagFilterMenuOpen(false);
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
          <div className={`skills-group-view-control${viewMode === "grouped" ? " is-active" : ""}`}>
            <button
              className={`skills-view-toggle__button skills-group-view-control__button${viewMode === "grouped" ? " is-active" : ""}`}
              type="button"
              aria-pressed={viewMode === "grouped"}
              aria-label={t(groupMode === "source" ? "skills.group.mode.source" : "skills.group.mode.tag")}
              data-tooltip={t(groupMode === "source" ? "skills.group.mode.source" : "skills.group.mode.tag")}
              onClick={() => onViewModeChange("grouped")}
            >
              <GroupIcon />
              {viewMode === "grouped" ? (
                <span>{t(groupMode === "source" ? "skills.group.mode.sourceShort" : "skills.group.mode.tagShort")}</span>
              ) : null}
            </button>
            <AppSelect
              value={groupMode}
              options={groupModeOptions}
              onChange={(nextGroupMode) => {
                onGroupModeChange(nextGroupMode);
                onViewModeChange("grouped");
              }}
              ariaLabel={t("skills.group.mode.choose")}
              className="skills-group-mode-select"
              menuClassName="skills-group-mode-select__popover"
              minMenuWidth={112}
              selectedLabel={<span className="sr-only">{t("skills.group.mode.choose")}</span>}
            />
          </div>
        ) : null}
      </div>
      <div className="skill-status-filter">
        <span className="sr-only">{t(isManagedSource ? "skills.filter.aria" : "skills.source.filter.aria")}</span>
        <span className="skill-status-filter__icon" aria-hidden="true">
          <FilterIcon />
        </span>
        {isManagedSource ? (
          <AppSelect
            value={managedFilterValue}
            options={managedFilterOptions}
            onChange={handleManagedFilterChange}
            ariaLabel={t("skills.filter.aria")}
            className="skill-status-filter__select"
            menuClassName="skill-status-filter__popover skill-status-filter__popover--grouped"
            minMenuWidth={112}
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
      {isManagedSource && hasTagFilters ? (
        <div
          ref={tagFilterControlRef}
          className={`skill-tag-filter-control${tagFilter ? " has-filter" : ""}${tagFilter ? ` ${getTagFilterToneClass(tagFilter)}` : ""}`}
        >
          <button
            className={`skill-tag-filter-toggle${isTagFilterControlExpanded ? " is-expanded" : ""}`}
            type="button"
            aria-expanded={isTagFilterControlExpanded}
            aria-haspopup={tagFilterLayout === "popover" ? "menu" : undefined}
            aria-label={tagFilterToggleLabel}
            data-tooltip={tagFilterToggleLabel}
            onClick={handleTagFilterControlToggle}
          >
            <span className="skill-tag-filter-toggle__icon" aria-hidden="true">
              <TagFilterIcon />
            </span>
            <span className="skill-tag-filter-toggle__label">{tagFilterLabel}</span>
            <span className="skill-tag-filter-toggle__chevron" aria-hidden="true">
              <TagFilterChevronIcon isExpanded={isTagFilterControlExpanded} />
            </span>
          </button>
          {tagFilter ? (
            <button
              className="skill-tag-filter-clear"
              type="button"
              aria-label={t("skills.tagFilter.clear")}
              data-tooltip={t("skills.tagFilter.clear")}
              onClick={() => onTagFilterChange(undefined)}
            >
              <TagFilterClearIcon />
            </button>
          ) : null}
          {tagFilterLayout === "popover" && isTagFilterMenuOpen ? (
            <div
              className="skill-tag-filter-menu"
              role="menu"
              aria-label={t("skills.tagFilter.aria")}
            >
              {tagFilterSections.map((section) => (
                <section
                  key={section.key}
                  className="skill-tag-filter-menu__section"
                  role="group"
                  aria-label={section.label}
                >
                  <div className="skill-tag-filter-menu__heading">{section.label}</div>
                  <div className="skill-tag-filter-menu__options">
                    {section.options.map((option) => {
                      const isActive = isSameSkillTagFilter(option.filter, tagFilter);
                      return (
                        <button
                          key={`${option.filter.kind}:${option.filter.value}`}
                          className={`skill-tag-filter-menu__option ${getTagFilterToneClass(option.filter)}${isActive ? " is-active" : ""}`}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isActive}
                          onClick={() => handleTagFilterOptionChange(option)}
                        >
                          <span>{option.label}</span>
                          <span className="skill-tag-filter-menu__count">{option.count}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <BatchModeButton
        isSelecting={isBatchSelecting}
        label={t(isBatchSelecting ? "batch.mode.exit" : "batch.mode.enter")}
        onClick={() => onBatchSelectingChange(!isBatchSelecting)}
      />
      <button
        className={`secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--refresh${isRefreshLoading ? " is-loading" : ""}`}
        type="button"
        onClick={() => void handleRefreshWorkspace()}
        disabled={isRefreshLoading || isBatchSelecting}
      >
        <span aria-hidden="true" className="skills-toolbar-button__icon">
          <RefreshIcon isSpinning={isRefreshLoading} />
        </span>
        <span>{t("skills.refresh")}</span>
      </button>
      {activeSourceId === MANAGED_SKILL_SOURCE_ID ? (
        <>
          <button
            className={`secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--update-all${isUpdatingAllSkills ? " is-loading" : ""}`}
            type="button"
            onClick={() => void handleUpdateAllSkills()}
            disabled={isLoading || isUpdatingAllSkills || updatableSkillCount === 0 || isBatchSelecting}
          >
            <span aria-hidden="true" className="skills-toolbar-button__icon">
              <UpdateAllIcon isSpinning={isUpdatingAllSkills} />
            </span>
            <span>{isUpdatingAllSkills ? t("skills.updating") : updateAllButtonLabel}</span>
          </button>
        </>
      ) : null}
      {!isBatchSelecting && onGoInstall ? <ToolbarGoInstallButton onClick={onGoInstall} /> : null}
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
  ownerFilter?: ManagedSkillOwnerFilter;
  managementFilter?: ToolSkillManagementFilter;
  viewMode: SkillViewMode;
  groupMode?: SkillGroupMode;
  tagFilter?: SkillTagFilter;
  onTagFilterChange?: (filter: SkillTagFilter | undefined) => void;
  isTagFilterVisible?: boolean;
  tagFilterLayout?: SkillTagFilterLayout;
  isBatchSelecting?: boolean;
  onBatchSelectingChange?: (isSelecting: boolean) => void;
};

const SKILL_GRID_COLUMN_COUNT = 3;

function getSkillOrderKey(skill: SkillSummary) {
  return getSkillIdentity(skill);
}

export function SkillListPage(props: SkillListPageProps) {
  const { t } = useTranslate();
  const { notify } = useNotifications();
  const {
    onImportFromLocal,
    onInstallFromGit,
    onInstallFromMarketplace,
    query,
    statusFilter,
    ownerFilter = "all",
    managementFilter = "all",
    viewMode,
    groupMode = "source",
    tagFilter,
    onTagFilterChange = () => undefined,
    isTagFilterVisible = true,
    tagFilterLayout = DEFAULT_SKILL_TAG_FILTER_LAYOUT,
    isBatchSelecting = false,
    onBatchSelectingChange = () => undefined,
    activeSourceId = MANAGED_SKILL_SOURCE_ID,
    onActiveSourceIdChange = () => undefined,
    focusedManagedSkillName = "",
    onShowManagedSkill = () => undefined,
  } = props;
  const {
    deleteSkill,
    installedSkills,
    isLoading,
    setSkillAllToolStatuses,
    setToolSkillStatuses,
    toolConfigs,
    updateSkill,
  } = useSkillWorkspace();
  const deferredQuery = useDeferredValue(query);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(readSkillGroupCollapsedState);
  const [expandedSkillIdentity, setExpandedSkillIdentity] = useState("");
  const [batchAction, setBatchAction] = useState<"update" | "delete" | "enable" | "disable" | "">("");
  const [isBatchDeleteConfirming, setIsBatchDeleteConfirming] = useState(false);
  const handledFocusedSkillRef = useRef("");
  const sortedSkills = useMemo(
    () => filterSkills(installedSkills, { query: "", status: "all" }),
    [installedSkills],
  );
  const orderedInstalledSkills = useStableListOrder(
    sortedSkills,
    getSkillOrderKey,
    "managed-skills",
    true,
  );
  const tagFilterGroups = useMemo(
    () => collectSkillTagFilterGroups(installedSkills),
    [installedSkills],
  );
  const tagFilterSections = useMemo(
    () => createTagFilterSections(tagFilterGroups, t),
    [t, tagFilterGroups],
  );
  const skills = useMemo(() => {
    const visibleSkillIdentities = new Set(
      filterSkills(installedSkills, {
        query: deferredQuery,
        status: statusFilter,
        owner: ownerFilter,
        tagFilter,
      })
        .map(getSkillIdentity),
    );
    return orderedInstalledSkills.filter((skill) => visibleSkillIdentities.has(getSkillIdentity(skill)));
  }, [deferredQuery, installedSkills, orderedInstalledSkills, ownerFilter, statusFilter, tagFilter]);
  const visibleSkillIds = useMemo(() => skills.map(getSkillIdentity), [skills]);
  const batchSelection = useBatchSelection(visibleSkillIds);
  const selectedSkills = useMemo(
    () => skills.filter((skill) => batchSelection.selectedIds.has(getSkillIdentity(skill))),
    [batchSelection.selectedIds, skills],
  );
  const selectedSkillToolStates = useMemo(() => selectedSkills.map((skill) => {
    const tools = mergeSkillToolsWithInstalledTools(skill.tools, toolConfigs);
    const hasEnabledTool = tools.some((tool) => isToolEnabledStatus(tool.statusLabel));
    const hasDisabledTool = tools.some((tool) => !isToolEnabledStatus(tool.statusLabel));
    return { skill, tools, hasDisabledTool, hasEnabledTool };
  }), [selectedSkills, toolConfigs]);
  const actionableSkillToolStates = selectedSkillToolStates.filter((item) => item.tools.length > 0);
  const enableSkillToolStates = actionableSkillToolStates.filter((item) => item.hasDisabledTool);
  const disableSkillToolStates = actionableSkillToolStates.filter((item) => item.hasEnabledTool);
  const updatableSelectedSkills = selectedSkills.filter((skill) => skill.collabStatus === "update-available");
  const isBatchBusy = batchAction !== "";
  const groupedSkills = useMemo(
    () => groupMode === "tag"
      ? groupSkillsByTag(skills, t("skills.group.untagged"))
      : groupSkillsBySource(skills, { localLabel: t("skills.source.local") }),
    [groupMode, skills, t],
  );
  const skillGridRows = useMemo(() => {
    const rows: SkillSummary[][] = [];
    for (let index = 0; index < skills.length; index += SKILL_GRID_COLUMN_COUNT) {
      rows.push(skills.slice(index, index + SKILL_GRID_COLUMN_COUNT));
    }
    return rows;
  }, [skills]);
  const allGroupedSkills = useMemo(
    () => groupMode === "tag"
      ? groupSkillsByTag(orderedInstalledSkills, t("skills.group.untagged"))
      : groupSkillsBySource(orderedInstalledSkills, { localLabel: t("skills.source.local") }),
    [groupMode, orderedInstalledSkills, t],
  );

  useEffect(() => {
    if (activeSourceId !== MANAGED_SKILL_SOURCE_ID) {
      onTagFilterChange(undefined);
      return;
    }
    if (tagFilter === undefined) {
      return;
    }

    if (!isSkillTagFilterAvailable(tagFilterGroups, tagFilter)) {
      onTagFilterChange(undefined);
    }
  }, [activeSourceId, onTagFilterChange, tagFilter, tagFilterGroups]);

  useEffect(() => {
    if (isBatchSelecting && activeSourceId === MANAGED_SKILL_SOURCE_ID) {
      batchSelection.enterSelection();
      setExpandedSkillIdentity("");
      return;
    }
    batchSelection.exitSelection();
    setIsBatchDeleteConfirming(false);
  }, [activeSourceId, batchSelection.enterSelection, batchSelection.exitSelection, isBatchSelecting]);

  useEffect(() => {
    if (activeSourceId !== MANAGED_SKILL_SOURCE_ID || !focusedManagedSkillName) {
      handledFocusedSkillRef.current = "";
      return;
    }

    const focusRequest = `${activeSourceId}:${focusedManagedSkillName}`;
    if (handledFocusedSkillRef.current === focusRequest) {
      return;
    }

    const focusedSkill = orderedInstalledSkills.find((skill) => skill.name === focusedManagedSkillName);
    handledFocusedSkillRef.current = focusRequest;
    setExpandedSkillIdentity(focusedSkill ? getSkillIdentity(focusedSkill) : "");
  }, [activeSourceId, focusedManagedSkillName, orderedInstalledSkills]);

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

  function handleSkillExpandedChange(skillIdentity: string, expanded: boolean) {
    setExpandedSkillIdentity(expanded ? skillIdentity : "");
  }

  function finishBatchAction(
    actionLabel: string,
    targetIds: string[],
    results: PromiseSettledResult<void>[],
    skippedCount = 0,
  ) {
    const failedIds = results.flatMap((result, index) => (
      result.status === "rejected" ? [targetIds[index]] : []
    ));
    const successCount = results.length - failedIds.length;
    batchSelection.keepSelected(failedIds);

    if (failedIds.length === 0) {
      notify({
        tone: "success",
        message: t("batch.result.success", { action: actionLabel, count: successCount, skipped: skippedCount }),
      });
      onBatchSelectingChange(false);
      return;
    }

    notify({
      tone: successCount > 0 ? "info" : "error",
      message: t("batch.result.partial", {
        action: actionLabel,
        success: successCount,
        failed: failedIds.length,
        skipped: skippedCount,
      }),
    });
  }

  async function runSkillBatch(
    action: "update" | "delete" | "enable" | "disable",
    actionLabel: string,
    targets: SkillSummary[],
    operation: (skill: SkillSummary) => Promise<void>,
    skippedCount = 0,
  ) {
    if (isBatchBusy || targets.length === 0) {
      return;
    }
    setBatchAction(action);
    try {
      const results = await Promise.allSettled(targets.map(operation));
      finishBatchAction(actionLabel, targets.map(getSkillIdentity), results, skippedCount);
    } finally {
      setBatchAction("");
    }
  }

  async function handleBatchUpdateSkills() {
    await runSkillBatch(
      "update",
      t("batch.action.update"),
      updatableSelectedSkills,
      (skill) => updateSkill(skill.name, skill.canonicalPath ?? skill.localPath),
      selectedSkills.length - updatableSelectedSkills.length,
    );
  }

  async function handleBatchSetSkillsEnabled(enabled: boolean) {
    const action = enabled ? "enable" : "disable";
    const targetStates = enabled ? enableSkillToolStates : disableSkillToolStates;
    const targets = targetStates.map((item) => item.skill);
    await runSkillBatch(
      action,
      t(enabled ? "batch.action.enable" : "batch.action.disable"),
      targets,
      async (skill) => {
        const state = targetStates.find((item) => getSkillIdentity(item.skill) === getSkillIdentity(skill));
        if (!state) {
          return;
        }
        const failedToolNames = await setSkillAllToolsEnabled({
          skillName: skill.name,
          skillPath: skill.canonicalPath ?? skill.localPath,
          enabled,
          toolNames: state.tools.map((tool) => tool.name),
          setSkillAllToolStatuses,
          setToolSkillStatuses,
        });
        if (failedToolNames.length > 0) {
          throw new Error(failedToolNames.join("、"));
        }
      },
      selectedSkills.length - targets.length,
    );
  }

  async function handleBatchDeleteSkills() {
    setIsBatchDeleteConfirming(false);
    await runSkillBatch(
      "delete",
      t("batch.action.delete"),
      selectedSkills,
      (skill) => deleteSkill(skill.name, skill.canonicalPath ?? skill.localPath),
    );
  }

  function renderSkillCard(skill: SkillSummary, layout: "list" | "grid" = "list") {
    const skillIdentity = getSkillIdentity(skill);
    return (
      <SkillCard
        key={skillIdentity}
        skill={skill}
        layout={layout}
        expanded={expandedSkillIdentity === skillIdentity}
        autoAlignWhenExpanded={focusedManagedSkillName === skill.name}
        selectionMode={batchSelection.isSelecting}
        selected={batchSelection.selectedIds.has(skillIdentity)}
        onSelectionToggle={() => batchSelection.toggleSelection(skillIdentity)}
        onExpandedChange={(expanded) => handleSkillExpandedChange(skillIdentity, expanded)}
      />
    );
  }

  return (
    <div className="skills-page">
      <SkillSourceView
        activeSourceId={activeSourceId}
        isBatchSelecting={isBatchSelecting}
        onActiveSourceIdChange={onActiveSourceIdChange}
        onBatchSelectingChange={onBatchSelectingChange}
        onShowManagedSkill={onShowManagedSkill}
        managementFilter={managementFilter}
        query={deferredQuery}
        viewMode={viewMode}
      />
      {activeSourceId === MANAGED_SKILL_SOURCE_ID
        && tagFilterLayout === "inline"
        && isTagFilterVisible
        && tagFilterSections.length > 0 ? (
        <div className="skill-tag-filter-bar" role="group" aria-label={t("skills.tagFilter.aria")}>
          {tagFilterSections.map((section) => (
            <div
              key={section.key}
              className={`skill-tag-filter-bar__section is-${section.key}`}
              role="group"
              aria-label={section.label}
            >
              {section.options.map((option) => {
                const isActive = isSameSkillTagFilter(option.filter, tagFilter);
                return (
                  <button
                    key={`${option.filter.kind}:${option.filter.value}`}
                    className={`skill-tag-filter-bar__item has-tag ${getTagFilterToneClass(option.filter)}${option.filter.kind === "untagged" ? " is-untagged" : ""}${isActive ? " is-active" : ""}`}
                    type="button"
                    data-tooltip={`${section.label} · ${option.label} (${option.count})`}
                    aria-pressed={isActive}
                    onClick={() => onTagFilterChange(isActive ? undefined : option.filter)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
      {activeSourceId === MANAGED_SKILL_SOURCE_ID ? (
        <>
        {batchSelection.isSelecting ? (
          <BatchActionBar
            actions={selectedSkills.length > 0 ? [
              ...(updatableSelectedSkills.length > 0 ? [{
                key: "update",
                label: t("batch.action.updateCount", { count: updatableSelectedSkills.length }),
                tone: "accent" as const,
                isBusy: batchAction === "update",
                onClick: () => void handleBatchUpdateSkills(),
              }] : []),
              {
                key: "delete",
                label: t("batch.action.deleteCount", { count: selectedSkills.length }),
                tone: "danger" as const,
                isBusy: batchAction === "delete",
                onClick: () => setIsBatchDeleteConfirming(true),
              },
              ...(enableSkillToolStates.length > 0 ? [{
                key: "enable",
                label: t("batch.action.enableCount", { count: enableSkillToolStates.length }),
                tone: "success" as const,
                isBusy: batchAction === "enable",
                onClick: () => void handleBatchSetSkillsEnabled(true),
              }] : []),
              ...(disableSkillToolStates.length > 0 ? [{
                key: "disable",
                label: t("batch.action.disableCount", { count: disableSkillToolStates.length }),
                tone: "warning" as const,
                isBusy: batchAction === "disable",
                onClick: () => void handleBatchSetSkillsEnabled(false),
              }] : []),
            ] : []}
            ariaLabel={t("batch.toolbar.aria")}
            cancelLabel={t("batch.cancel")}
            deselectAllLabel={t("batch.deselectAll")}
            hint={t("batch.hint")}
            isAllVisibleSelected={batchSelection.isAllVisibleSelected}
            isBusy={isBatchBusy}
            selectedLabel={selectedSkills.length > 0 ? t("batch.selected", { count: selectedSkills.length }) : ""}
            selectAllDisabled={skills.length === 0}
            selectAllLabel={t("batch.selectAll")}
            onCancel={() => onBatchSelectingChange(false)}
            onToggleSelectAll={batchSelection.toggleSelectAll}
          />
        ) : null}
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
            const groupTone = group.kind === "tag"
              ? group.isUntagged ? "local" : "default"
              : resolveSkillGroupTone(group.skills[0]?.sourceType);
            const groupSourceUrl = formatGroupSourceUrl(group.skills[0]?.sourceUrl ?? group.label);
            const isGroupSourceLinkable = group.kind === "source" && isHttpUrl(groupSourceUrl);
            const groupSkillIds = group.skills.map(getSkillIdentity);
            const selectedGroupSkillCount = groupSkillIds.filter((id) => batchSelection.selectedIds.has(id)).length;
            const isGroupSelected = groupSkillIds.length > 0 && selectedGroupSkillCount === groupSkillIds.length;
            const isGroupPartiallySelected = selectedGroupSkillCount > 0 && !isGroupSelected;

            return (
              <section key={group.id} className={`skill-group-section skill-group-section--${groupTone}`}>
                <div
                  className="skill-group-section__header"
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleGroup(group.id)}
                  onKeyDown={(event) => {
                    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      toggleGroup(group.id);
                    }
                  }}
                  aria-expanded={!isCollapsed}
                  aria-label={t(
                    group.kind === "tag"
                      ? isCollapsed ? "skills.group.tag.expand" : "skills.group.tag.collapse"
                      : isCollapsed ? "skills.group.source.expand" : "skills.group.source.collapse",
                    { label: group.label },
                  )}
                >
                  <div className="skill-group-section__title">
                    <SkillGroupMonogram label={group.label} />
                    <div className="skill-group-section__copy">
                      <div className="skill-group-section__name-row">
                        <h3>{group.label}</h3>
                        <span className="skill-group-section__badge" aria-hidden="true">
                          {t(group.kind === "tag" ? "skills.group.tagBadge" : "skills.group.badge")}
                        </span>
                        <span className="skill-group-section__count">{t("skills.group.count", { count: group.skills.length })}</span>
                      </div>
                      <p className="skill-group-section__source">
                        <span>
                          {group.kind === "tag" ? t("skills.group.tagDescription") : t("skills.group.sourcePrefix")}
                          {group.kind === "source" && isGroupSourceLinkable ? (
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
                          ) : group.kind === "source" ? (
                            groupSourceUrl
                          ) : null}
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
                    {batchSelection.isSelecting ? (
                      <button
                        className="skill-group-selection-action"
                        type="button"
                        disabled={isBatchBusy}
                        aria-label={t(
                          isGroupSelected ? "batch.group.deselectAllAria" : "batch.group.selectAllAria",
                          { name: group.label },
                        )}
                        aria-pressed={isGroupPartiallySelected ? "mixed" : isGroupSelected}
                        onClick={(event) => {
                          event.stopPropagation();
                          batchSelection.toggleSelections(groupSkillIds);
                        }}
                      >
                        <BatchSelectionMark
                          checked={isGroupSelected}
                          indeterminate={isGroupPartiallySelected}
                        />
                        <span>
                          {t(isGroupSelected ? "batch.group.deselectAll" : "batch.group.selectAll")}
                        </span>
                      </button>
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
                      renderSkillCard(skill)
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
                  <div key={getSkillIdentity(row[0])} className="skill-card-grid__row">
                    {row.map((skill) => (
                      renderSkillCard(skill, "grid")
                    ))}
                  </div>
                );
              })
            ) : (
              skills.map((skill) => (
                renderSkillCard(skill)
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
        <BatchDeleteDialog
          cancelLabel={t("batch.cancel")}
          confirmLabel={t("batch.delete.confirm")}
          description={t("batch.delete.description.skill", { count: selectedSkills.length })}
          isBusy={batchAction === "delete"}
          isOpen={isBatchDeleteConfirming}
          title={t("batch.delete.title.skill", { count: selectedSkills.length })}
          onCancel={() => setIsBatchDeleteConfirming(false)}
          onConfirm={() => void handleBatchDeleteSkills()}
        />
        </>
      ) : null}
    </div>
  );
}
