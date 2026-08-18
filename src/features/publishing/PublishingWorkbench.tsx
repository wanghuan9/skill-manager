import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslate, type TranslationKey } from "@/app/i18n";
import { AppSelect } from "@/app/components/AppSelect";
import {
  BatchActionBar,
  BatchModeButton,
  BatchSelectionMark,
} from "@/app/components/BatchActions";
import { SearchFieldIcon } from "@/app/components/SearchFieldIcon";
import { useBatchSelection } from "@/app/hooks/useBatchSelection";
import { alignExpandedRowIntoView } from "@/app/utils/align-expanded-row";
import { getPublishingAdapterCapabilities, type PublishingPlatformAdapter } from "./publishing-adapter";
import type {
  PublishStatus,
  PublishableSkill,
  PublishingAuthState,
  PublishingUnmanagedSkill,
} from "./types";
import {
  openExternalLink,
  openPathInFinder,
  subscribeSkillLibraryChanges,
} from "@/features/skills/api/skill-client";
import {
  ListGridViewToggle,
  type ListGridViewMode,
} from "@/features/skills/components/ListGridViewToggle";
import { SkillFileDialog } from "@/features/skills/components/SkillFileDialog";
import { formatSkillDescription } from "@/features/skills/utils/skill-description";
import { getMonogramLabel } from "@/features/skills/utils/monogram";
import { formatSkillUpdatedAt, parseSkillTimestamp } from "@/features/skills/utils/skill-time";

type PublishStatusFilter = "all" | PublishStatus;

type PublishingWorkbenchProps = {
  adapter: PublishingPlatformAdapter;
  externalAuthState?: PublishingAuthState | null;
  isVisible?: boolean;
  renderAuthentication?: (refreshAuth: () => Promise<void>) => ReactNode;
  onAuthStateChange?: (authState: PublishingAuthState) => void;
};

type BatchConfirmState = {
  skills: PublishableSkill[];
};

type PublishSkillTab = "managed" | "unmanaged";
type Translate = ReturnType<typeof useTranslate>["t"];

type UnmanagedSkillGroup = {
  name: string;
  description: string;
  candidates: PublishingUnmanagedSkill[];
};

const STATUS_OPTIONS: Array<{ value: PublishStatusFilter; labelKey: TranslationKey }> = [
  { value: "all", labelKey: "publishing.status.all" },
  { value: "update-available", labelKey: "publishing.status.updateAvailable" },
  { value: "unpublished", labelKey: "publishing.status.unpublished" },
  { value: "published", labelKey: "publishing.status.published" },
];

const STATUS_LABEL_KEYS: Record<PublishStatus, TranslationKey> = {
  unpublished: "publishing.status.unpublished",
  "update-available": "publishing.status.updateAvailable",
  published: "publishing.status.published",
  publishing: "publishing.status.publishing",
  reviewing: "publishing.status.reviewing",
  failed: "publishing.status.failed",
};

const STATUS_PRIORITY: Record<PublishStatus, number> = {
  failed: 0,
  "update-available": 1,
  publishing: 2,
  reviewing: 2,
  published: 3,
  unpublished: 4,
};

const BATCH_PUBLISHABLE_STATUSES = new Set<PublishStatus>([
  "unpublished",
  "update-available",
  "failed",
]);
const VIEW_MODE_STORAGE_KEY = "skilldock.publish:view-mode";
const PUBLISH_STATUS_POLL_INTERVAL_MS = 5_000;
const SKILL_LIBRARY_CHANGE_DEBOUNCE_MS = 500;
const PUBLISH_ORDER_ANIMATION_DURATION_MS = 180;
const PUBLISH_ORDER_ANIMATION_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const REDUCED_MOTION_MEDIA_QUERY = "(prefers-reduced-motion: reduce)";

type RefreshOptions = {
  forceRefresh?: boolean;
  background?: boolean;
};

function readViewMode(): ListGridViewMode {
  if (typeof window === "undefined") {
    return "list";
  }
  try {
    return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

function writeViewMode(viewMode: ListGridViewMode) {
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Keep the in-memory preference when storage is unavailable.
  }
}

function comparePublishVersions(left: string, right: string): number | null {
  const parse = (version: string) => {
    const normalized = version.trim().replace(/^v/i, "");
    if (!normalized) {
      return null;
    }
    const parts = normalized.split(".").map(Number);
    return parts.every(Number.isInteger) ? parts : null;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) {
    return null;
  }
  const partCount = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < partCount; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function releaseEventListener(unlisten: (() => void) | null) {
  if (!unlisten) {
    return;
  }

  try {
    void Promise.resolve(unlisten()).catch((error) => {
      console.warn("Failed to release publishing event listener:", error);
    });
  } catch (error) {
    console.warn("Failed to release publishing event listener:", error);
  }
}

function matchesStatusFilter(status: PublishStatus, filter: PublishStatusFilter) {
  if (filter === "all") {
    return true;
  }
  if (filter === "published") {
    return status === "published" || status === "update-available";
  }
  return status === filter;
}

function getPublishManagementOwnerLabel(managementOwner: string | undefined, t: Translate) {
  if (managementOwner === "agent-skills-cli") {
    return t("skill.card.owner.agentSkillsCli");
  }
  if (managementOwner === "external") {
    return t("skill.card.owner.external");
  }
  return t("skill.card.owner.skilldock");
}

function getPublishSourceMethodLabel(skill: PublishableSkill, t: Translate) {
  if (skill.sourceType === "well-known" || skill.sourceType === "marketplace") {
    return t(skill.sourceType === "marketplace"
      ? "skill.card.sourceMethod.marketplace"
      : "skill.card.sourceMethod.standard");
  }
  if (skill.gitLinked || (skill.sourceType && skill.sourceType !== "local")) {
    return t("skill.card.sourceMethod.git");
  }
  return t("skill.card.sourceMethod.local");
}

function getPublishSortTimestamp(skill: PublishableSkill) {
  const usesPublishedTime = skill.publishStatus === "published"
    || skill.publishStatus === "update-available";
  const primaryTime = usesPublishedTime ? skill.lastPublishedAt : skill.localUpdatedAt;
  const fallbackTime = usesPublishedTime ? skill.localUpdatedAt : skill.lastPublishedAt;
  const primaryTimestamp = parseSkillTimestamp(primaryTime);
  return Number.isFinite(primaryTimestamp) ? primaryTimestamp : parseSkillTimestamp(fallbackTime);
}

function comparePublishableSkills(left: PublishableSkill, right: PublishableSkill) {
  const priorityDifference = STATUS_PRIORITY[left.publishStatus] - STATUS_PRIORITY[right.publishStatus];
  if (priorityDifference !== 0) {
    return priorityDifference;
  }
  const leftTimestamp = getPublishSortTimestamp(left);
  const rightTimestamp = getPublishSortTimestamp(right);
  if (leftTimestamp !== rightTimestamp) {
    return rightTimestamp - leftTimestamp;
  }
  return left.name.localeCompare(right.name);
}

function replaceSkill(skills: PublishableSkill[], updatedSkill: PublishableSkill) {
  return skills.map((skill) => (
    skill.localPath === updatedSkill.localPath ? updatedSkill : skill
  ));
}

function retainCachedPublishStatus(
  previousSkills: PublishableSkill[],
  refreshedSkills: PublishableSkill[],
  isFileDiffReconciled = false,
): PublishableSkill[] {
  const previousByPath = new Map(previousSkills.map((skill) => [skill.localPath, skill]));
  return refreshedSkills.map((skill) => {
    const previous = previousByPath.get(skill.localPath);
    if (skill.publishBlocked) {
      // 平台的终态限制必须立即覆盖缓存，避免继续显示可发布或可更新操作。
      return skill;
    }
    const isSameRemoteSkill = Boolean(previous?.remoteSkillId)
      && previous?.remoteSkillId === skill.remoteSkillId;
    const isSamePublishedSkill = previous?.localContentHash === skill.localContentHash
      && isSameRemoteSkill
      && previous.remoteVersion === skill.remoteVersion;
    const isSkillFileDiffReconciled = skill.fileDiffReconciled === true
      || (isFileDiffReconciled && skill.fileDiffReconciled !== false);
    const canRetainUpdateStatus = !isSkillFileDiffReconciled
      && previous?.publishStatus === "update-available"
      && (previous.updateFileCount ?? 0) > 0
      && previous.localContentHash === skill.localContentHash
      && isSameRemoteSkill;
    if (canRetainUpdateStatus) {
      // 轻量快照不会计算远端文件 diff；完整对齐后的结果必须覆盖缓存状态。
      return {
        ...skill,
        publishStatus: previous.publishStatus,
        updateFileCount: previous.updateFileCount,
        targetVersion: previous.targetVersion,
      };
    }
    const canRetainLocalPublishResult = Boolean(previous?.remoteSkillId)
      && !skill.remoteSkillId
      && previous?.localContentHash === skill.localContentHash
      && (previous.publishStatus === "publishing"
        || previous.publishStatus === "published"
        || previous.publishStatus === "failed");
    if (canRetainLocalPublishResult) {
      // 发布请求返回的结果比进入页面前已发出的轻量扫描新，不能被后者倒灌为未发布。
      return previous;
    }
    const canRetainCompletedPublish = previous?.publishStatus === "published"
      && skill.publishStatus === "update-available"
      && previous.localContentHash === skill.localContentHash
      && isSameRemoteSkill
      && (comparePublishVersions(previous.remoteVersion, skill.remoteVersion) ?? 0) > 0;
    if (canRetainCompletedPublish) {
      // 发布接口已确认新版本，商店列表尚未索引完成时继续展示该结果，避免又倒回“可更新”。
      return previous;
    }
    const canRetainFailure = previous?.publishStatus === "failed"
      && skill.publishStatus === "publishing"
      && previous.localContentHash === skill.localContentHash
      && (!previous.remoteSkillId || previous.remoteSkillId === skill.remoteSkillId);
    return canRetainFailure
      ? { ...skill, publishStatus: "failed", failureReason: previous.failureReason }
      : skill;
  });
}

function hasSamePublishableSkills(
  currentSkills: PublishableSkill[],
  nextSkills: PublishableSkill[],
) {
  if (currentSkills.length !== nextSkills.length) {
    return false;
  }
  const currentByPath = new Map(currentSkills.map((skill) => [skill.localPath, JSON.stringify(skill)]));
  return nextSkills.every((skill) => currentByPath.get(skill.localPath) === JSON.stringify(skill));
}

function buildPublishableSkillDisplayOrder(skills: PublishableSkill[]) {
  return [...skills].sort(comparePublishableSkills).map((skill) => skill.localPath);
}

function hasSameDisplayOrder(currentOrder: string[], nextOrder: string[]) {
  return currentOrder.length === nextOrder.length
    && currentOrder.every((skillPath, index) => skillPath === nextOrder[index]);
}

function orderPublishableSkills(
  skills: PublishableSkill[],
  displayOrder: string[],
) {
  const skillByPath = new Map(skills.map((skill) => [skill.localPath, skill]));
  const orderedSkills = displayOrder
    .map((skillPath) => skillByPath.get(skillPath))
    .filter((skill): skill is PublishableSkill => Boolean(skill));
  const orderedPaths = new Set(orderedSkills.map((skill) => skill.localPath));
  const newlyAddedSkills = skills
    .filter((skill) => !orderedPaths.has(skill.localPath))
    .sort(comparePublishableSkills);
  return [...orderedSkills, ...newlyAddedSkills];
}

function buildUnmanagedSkillGroups(candidates: PublishingUnmanagedSkill[]): UnmanagedSkillGroup[] {
  const groups = new Map<string, PublishingUnmanagedSkill[]>();
  for (const candidate of candidates) {
    const current = groups.get(candidate.name) ?? [];
    current.push(candidate);
    groups.set(candidate.name, current);
  }
  return Array.from(groups.entries())
    .map(([name, groupCandidates]) => ({
      name,
      description: groupCandidates[0]?.description ?? "",
      candidates: groupCandidates,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function formatUnmanagedSource(candidate: PublishingUnmanagedSkill, t: Translate) {
  const normalized = candidate.detectedFrom.replace(/\\\\/g, "/").toLowerCase();
  if (normalized.includes("/.cursor/")) return "Cursor";
  if (normalized.includes("/.claude/")) return "Claude Code";
  if (normalized.includes("/.codex/")) return "Codex";
  if (normalized.includes("/.codeium/windsurf/")) return "Windsurf";
  if (normalized.includes("/.gemini/")) return "Gemini";
  const parts = candidate.detectedFrom.replace(/\\\\/g, "/").split("/").filter(Boolean);
  return parts.at(-2) ?? parts.at(-1) ?? t("publishing.unmanaged.localTool");
}

function formatUnmanagedFileType(candidate: PublishingUnmanagedSkill, t: Translate) {
  return candidate.sourceHint === "符号链接" || candidate.sourceHint === "Symlink"
    ? t("publishing.unmanaged.symlink")
    : t("publishing.unmanaged.realFile");
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 5.5h12l-4.7 5.1v3.9l-2.6 1v-4.9L4 5.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon({ isSpinning }: { isSpinning: boolean }) {
  return (
    <svg
      className={isSpinning ? "skills-toolbar-button__svg is-spinning" : "skills-toolbar-button__svg"}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path d="M16.2 9.1a6.2 6.2 0 0 0-10.7-3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M3.7 3.9v3.7h3.7M3.8 10.9a6.2 6.2 0 0 0 10.7 3.6M16.3 16.1v-3.7h-3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PublishActionIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 13.75V4.25m0 0L6.5 7.75M10 4.25l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 12.25v2.5c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25v-2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function OpenMarketIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M11.25 4.5h4.25v4.25M15.25 4.75l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.25 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5v-2.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function OpenFolderIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3.5 6.6c0-.97.78-1.75 1.75-1.75h3.18c.52 0 1.01.23 1.34.63l.67.8h4.31c.97 0 1.75.78 1.75 1.75v5.37c0 .97-.78 1.75-1.75 1.75h-9.5c-.97 0-1.75-.78-1.75-1.75V6.6Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
      <path d="M3.75 8.1h12.5" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}

function ViewFileIcon() {
  return (
    <svg className="publish-skill-row__file-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M6 2.75h5.25L15.5 7v10.25H6A1.25 1.25 0 0 1 4.75 16V4A1.25 1.25 0 0 1 6 2.75Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11.25 2.75V7H15.5M7.75 10h4.5M7.75 13h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UpdatePreviewIcon() {
  return (
    <svg className="publish-skill-row__file-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5 2.75h5.75L15.25 7v10.25H5A1.25 1.25 0 0 1 3.75 16V4A1.25 1.25 0 0 1 5 2.75Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M10.75 2.75V7h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path
        d="M6.75 13.25c1.55-2.1 4.95-2.1 6.5 0-1.55 2.1-4.95 2.1-6.5 0Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="13.25" r="1.05" fill="currentColor" />
    </svg>
  );
}

function PublishManagedIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="m10 2.7 1.25 4.05L15.3 8l-4.05 1.25L10 13.3 8.75 9.25 4.7 8l4.05-1.25L10 2.7Z" fill="currentColor" />
      <path d="m15.2 12.2.65 2.05 2.05.65-2.05.65-.65 2.05-.65-2.05-2.05-.65 2.05-.65.65-2.05Z" fill="currentColor" />
    </svg>
  );
}

function PublishUnmanagedIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3.5 6.6c0-.97.78-1.75 1.75-1.75h3.18c.52 0 1.01.23 1.34.63l.67.8h4.31c.97 0 1.75.78 1.75 1.75v5.37c0 .97-.78 1.75-1.75 1.75h-9.5c-.97 0-1.75-.78-1.75-1.75V6.6Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
      <path d="M3.75 8.1h12.5" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}

function PublishSkillMonogram({ name }: { name: string }) {
  return (
    <div className="link-badge link-badge--monogram" aria-hidden="true">
      <span className="link-badge__type-mark link-badge__type-mark--skill">
        <svg viewBox="0 0 12 12" fill="none">
          <path d="M6 1.5 7.1 4.9 10.5 6 7.1 7.1 6 10.5 4.9 7.1 1.5 6 4.9 4.9 6 1.5Z" fill="currentColor" />
        </svg>
      </span>
      <span className="link-badge__label">{getMonogramLabel(name)}</span>
    </div>
  );
}

function PublishFilePreviewButton(props: {
  skill: PublishableSkill;
  onClick: () => void;
  showLabel?: boolean;
}) {
  const { t } = useTranslate();
  const updateFileCount = props.skill.publishStatus === "update-available"
    ? props.skill.updateFileCount ?? 0
    : 0;
  const hasUpdates = updateFileCount > 0;
  const label = hasUpdates
    ? t("publishing.action.previewChanges")
    : t("publishing.action.previewFiles");
  const className = props.showLabel
    ? "secondary-button secondary-button--compact skill-card-detail-modal__action publish-skill-row__preview-button"
    : "skill-card__icon-button skill-card__file-preview-button publish-skill-row__preview-button";
  return (
    <button
      className={className}
      type="button"
      onClick={props.onClick}
      aria-label={`${label} ${props.skill.name}`}
      data-tooltip={label}
    >
      {hasUpdates && props.showLabel ? <UpdatePreviewIcon /> : <ViewFileIcon />}
      {props.showLabel ? <span>{label}</span> : null}
      {hasUpdates && !props.showLabel ? (
        <span className="skill-card__change-count" aria-hidden="true">{updateFileCount}</span>
      ) : null}
    </button>
  );
}

function PublishSkillSwitcher(props: {
  activeTab: PublishSkillTab;
  managedCount: number;
  unmanagedCount: number;
  isCompact: boolean;
  onChange: (tab: PublishSkillTab) => void;
}) {
  const { t } = useTranslate();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const options: Array<{ key: PublishSkillTab; label: string; count: number }> = [
    { key: "managed", label: t("publishing.tabs.managed"), count: props.managedCount },
    { key: "unmanaged", label: t("publishing.tabs.unmanaged"), count: props.unmanagedCount },
  ];
  const activeOption = options.find((option) => option.key === props.activeTab) ?? options[0];

  useEffect(() => {
    setIsMenuOpen(false);
  }, [props.activeTab, props.isCompact]);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMenuOpen]);

  function renderIcon(tab: PublishSkillTab) {
    return (
      <span className="skills-source-tab__logo skills-source-tab__logo--managed" aria-hidden="true">
        {tab === "managed" ? <PublishManagedIcon /> : <PublishUnmanagedIcon />}
      </span>
    );
  }

  if (props.isCompact) {
    return (
      <div className="skills-source-select-row publish-source-switcher">
        <div className="skills-source-menu" ref={menuRef}>
          <button
            className="skills-source-select-trigger"
            type="button"
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            onClick={() => setIsMenuOpen((current) => !current)}
          >
            {renderIcon(activeOption.key)}
            <span>{activeOption.label}</span>
            <span className="skills-source-tab__count">{activeOption.count}</span>
            <span className="skills-source-select-trigger__chevron" aria-hidden="true">⌄</span>
          </button>
          {isMenuOpen ? (
            <div className="skills-source-menu__popover" role="menu">
              {options.map((option) => (
                <button
                  key={option.key}
                  className={`skills-source-menu-item${option.key === props.activeTab ? " is-selected" : ""}`}
                  type="button"
                  role="menuitem"
                  onClick={() => props.onChange(option.key)}
                >
                  {renderIcon(option.key)}
                  <span>{option.label}</span>
                  <span className="skills-source-tab__count">{option.count}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="skills-source-tabs-row publish-source-switcher">
      <div className="skills-source-tabs" role="tablist" aria-label={t("publishing.tabs.aria")}>
        {options.map((option) => {
          const isSelected = option.key === props.activeTab;
          return (
            <button
              key={option.key}
              className={`skills-source-tab${isSelected ? " is-selected" : ""}`}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => props.onChange(option.key)}
            >
              {renderIcon(option.key)}
              <span>{option.label}</span>
              <span className="skills-source-tab__count">{option.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PublishToolbar(props: {
  query: string;
  viewMode: ListGridViewMode;
  activeTab: PublishSkillTab;
  statusFilter: PublishStatusFilter;
  counts: Record<PublishStatusFilter, number>;
  isRefreshing: boolean;
  isBatchSelecting: boolean;
  batchPublishing: boolean;
  onQueryChange: (value: string) => void;
  onViewModeChange: (value: ListGridViewMode) => void;
  onStatusFilterChange: (value: PublishStatusFilter) => void;
  onBatchSelectingChange: (selecting: boolean) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslate();
  return (
    <div className="skills-header-bar__tools">
      <label className="search-field search-field--header skill-search-field">
        <span className="sr-only">{t("publishing.search.aria")}</span>
        <SearchFieldIcon />
        <input
          type="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={props.activeTab === "managed"
            ? t("publishing.search.managedPlaceholder")
            : t("publishing.search.unmanagedPlaceholder")}
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
      </label>
      <ListGridViewToggle value={props.viewMode} onChange={props.onViewModeChange} />
      {props.activeTab === "managed" ? (
        <div className="skill-status-filter publish-toolbar__filter">
          <span className="skill-status-filter__icon" aria-hidden="true"><FilterIcon /></span>
          <AppSelect
            ariaLabel={t("publishing.filter.aria")}
            value={props.statusFilter}
            options={STATUS_OPTIONS.map((option) => ({
              value: option.value,
              label: `${t(option.labelKey)} (${props.counts[option.value]})`,
            }))}
            onChange={props.onStatusFilterChange}
            className="skill-status-filter__select"
            menuClassName="skill-status-filter__popover"
            minMenuWidth={96}
          />
        </div>
      ) : null}
      {props.batchPublishing ? (
        <BatchModeButton
          isSelecting={props.isBatchSelecting}
          label={props.isBatchSelecting ? t("publishing.batch.exit") : t("publishing.batch.enter")}
          onClick={() => props.onBatchSelectingChange(!props.isBatchSelecting)}
        />
      ) : null}
      <button
        className={`secondary-button secondary-button--compact skills-toolbar-button skills-toolbar-button--refresh${props.isRefreshing ? " is-loading" : ""}`}
        type="button"
        onClick={props.onRefresh}
        disabled={props.isRefreshing || props.isBatchSelecting}
      >
        <span aria-hidden="true" className="skills-toolbar-button__icon">
          <RefreshIcon isSpinning={props.isRefreshing} />
        </span>
        <span>{t("publishing.action.refresh")}</span>
      </button>
    </div>
  );
}

function PublishConfirmDialog(props: {
  skill: PublishableSkill;
  isPublishing: boolean;
  onClose: () => void;
  onConfirm: (changelog: string) => void;
}) {
  const { t } = useTranslate();
  const [changelog, setChangelog] = useState("");
  const isUpdate = Boolean(props.skill.remoteSkillId);
  const summaryClassName = `dialog-summary-grid publish-confirm-dialog__summary${isUpdate ? " is-update" : ""}`;

  return (
    <div className="dialog-backdrop" role="presentation" onClick={props.onClose}>
      <div className="dialog-card publish-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-dialog-title" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-card__header">
          <div>
            <h3 id="publish-dialog-title">{isUpdate ? t("publishing.action.publishUpdate") : t("publishing.action.publishSkill")}</h3>
            <p>{t("publishing.dialog.subtitle")}</p>
          </div>
          <button className="skill-detail-modal__close" type="button" aria-label={t("app.window.close")} onClick={props.onClose}>×</button>
        </header>
        <div className="dialog-card__body">
          <div className="dialog-info-row publish-confirm-dialog__info-row">
            <span className="dialog-info-label">{t("publishing.dialog.name")}</span><strong>{props.skill.name}</strong>
          </div>
          <div className="dialog-info-row publish-confirm-dialog__info-row">
            <span className="dialog-info-label">{t("skill.card.description")}</span>
            <span className="publish-confirm-dialog__description">{props.skill.description || t("publishing.empty.description")}</span>
          </div>
          <div className={summaryClassName}>
            {isUpdate ? <div><span>{t("publishing.dialog.currentVersion")}</span><strong>{props.skill.remoteVersion || t("skill.card.notFetched")}</strong></div> : null}
            <div><span>{t("publishing.dialog.targetVersion")}</span><strong>{props.skill.targetVersion}</strong></div>
            <div><span>{t("publishing.dialog.files")}</span><strong>{t("publishing.dialog.fileCount", { count: props.skill.fileCount })}</strong></div>
            <div><span>{t("publishing.dialog.size")}</span><strong>{formatBytes(props.skill.packageSize)}</strong></div>
          </div>
          <label className="dialog-section publish-confirm-dialog__changelog">
            <h4>{t("publishing.dialog.changelog")}</h4>
            <textarea
              value={changelog}
              placeholder={isUpdate
                ? t("publishing.dialog.changelogUpdatePlaceholder")
                : t("publishing.dialog.changelogFirstPlaceholder")}
              onChange={(event) => setChangelog(event.target.value)}
            />
          </label>
          {props.skill.failureReason ? <p className="dialog-error">{props.skill.failureReason}</p> : null}
        </div>
        <footer className="dialog-card__footer">
          <button className="secondary-button secondary-button--compact" type="button" disabled={props.isPublishing} onClick={props.onClose}>{t("publishing.dialog.cancel")}</button>
          <button
            className="primary-button primary-button--compact publish-confirm-dialog__primary-button"
            type="button"
            disabled={props.isPublishing}
            onClick={() => props.onConfirm(changelog)}
          >
            {props.isPublishing
              ? t("publishing.action.publishing")
              : isUpdate
                ? t("publishing.action.publishUpdate")
                : t("publishing.action.publish")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function BatchPublishConfirmDialog(props: {
  skills: PublishableSkill[];
  isPublishing: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { language, t } = useTranslate();
  const updateCount = props.skills.filter((skill) => Boolean(skill.remoteSkillId)).length;
  return (
    <div className="dialog-backdrop" role="presentation" onClick={props.onClose}>
      <div className="dialog-card publish-confirm-dialog publish-batch-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-batch-dialog-title" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-card__header">
          <div><h3 id="publish-batch-dialog-title">{t("publishing.batch.title")}</h3><p>{t("publishing.batch.description")}</p></div>
          <button className="skill-detail-modal__close" type="button" aria-label={t("app.window.close")} onClick={props.onClose}>×</button>
        </header>
        <div className="dialog-card__body">
          <div className="dialog-summary-grid publish-batch-dialog__summary">
            <div><span>{t("publishing.batch.total")}</span><strong>{props.skills.length}</strong></div>
            <div><span>{t("publishing.batch.firstPublish")}</span><strong>{props.skills.length - updateCount}</strong></div>
            <div><span>{t("publishing.batch.updates")}</span><strong>{updateCount}</strong></div>
          </div>
          <p className="publish-batch-dialog__names">
            {props.skills.map((skill) => skill.name).join(language === "en" ? ", " : "、")}
          </p>
        </div>
        <footer className="dialog-card__footer">
          <button className="secondary-button secondary-button--compact" type="button" disabled={props.isPublishing} onClick={props.onClose}>{t("publishing.dialog.cancel")}</button>
          <button className="primary-button primary-button--compact publish-confirm-dialog__primary-button" type="button" disabled={props.isPublishing} onClick={props.onConfirm}>
            {props.isPublishing
              ? t("publishing.action.publishing")
              : t("publishing.batch.publishCount", { count: props.skills.length })}
          </button>
        </footer>
      </div>
    </div>
  );
}

function PublishMarketLink(props: { skillName: string; onOpen: () => void }) {
  const { t } = useTranslate();
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    props.onOpen();
  }
  return (
    <button className="publish-skill-row__market-title-link" type="button" onClick={handleClick} aria-label={`${t("publishing.action.viewMarket")} ${props.skillName}`} title={t("publishing.action.viewMarket")}>
      <OpenMarketIcon />
    </button>
  );
}

function PublishSkillRow(props: {
  skill: PublishableSkill;
  layout: ListGridViewMode;
  onPublish: () => void;
  onOpenMarket: () => void;
  onPreview: () => void;
  onOpenDirectory: () => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  selectionMode: boolean;
  selected: boolean;
  onSelectionToggle: () => void;
}) {
  const { t } = useTranslate();
  const { skill } = props;
  const rowRef = useRef<HTMLElement | null>(null);
  const isGridLayout = props.layout === "grid";
  const isPublishBlocked = skill.publishBlocked === true;
  const canPublish = !isPublishBlocked && BATCH_PUBLISHABLE_STATUSES.has(skill.publishStatus);
  const isUpdatePublish = skill.publishStatus === "update-available";
  const isPublishingStatus = skill.publishStatus === "publishing";
  const hasMarketLink = Boolean(skill.marketUrl);
  const canOpenMarket = hasMarketLink
    && (skill.publishStatus === "published" || skill.publishStatus === "reviewing");
  const publishedVersion = skill.remoteSkillId && skill.remoteVersion
    ? skill.publishStatus === "update-available" && skill.targetVersion
      ? `v${skill.remoteVersion} → v${skill.targetVersion}`
      : `v${skill.remoteVersion}`
    : "";
  const buttonLabel = getPublishButtonLabel(skill.publishStatus, t);
  const tone = isPublishBlocked ? "danger" : getPublishStatusTone(skill.publishStatus);
  const statusLabel = isPublishBlocked
    ? t("publishing.status.blocked")
    : t(STATUS_LABEL_KEYS[skill.publishStatus]);
  const actionClassName = [
    "skill-card__icon-button",
    "publish-skill-row__action",
    canPublish ? "skill-card__icon-button--update" : "",
    isUpdatePublish ? "publish-skill-row__action--update-publish" : "",
    isPublishingStatus ? "is-loading" : "",
  ].filter(Boolean).join(" ");

  useEffect(() => {
    if (!props.expanded || !isGridLayout) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onExpandedChange(false);
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isGridLayout, props.expanded, props.onExpandedChange]);

  async function handleExpandedChange(nextExpanded: boolean) {
    const shouldAlignExpandedCard = nextExpanded && !props.expanded && !isGridLayout;
    props.onExpandedChange(nextExpanded);
    if (shouldAlignExpandedCard) {
      await alignExpandedRowIntoView(rowRef.current);
    }
  }

  function handleSummaryClick() {
    if (props.selectionMode) {
      props.onSelectionToggle();
      return;
    }
    void handleExpandedChange(!props.expanded);
  }

  return (
    <>
      <article
        ref={rowRef}
        data-publish-skill-path={skill.localPath}
        className={`skill-card skill-card--list publish-skill-row${isGridLayout ? " skill-card--grid publish-skill-row--grid" : ""}${props.expanded ? " is-expanded" : ""}${props.selectionMode ? " is-selecting" : ""}${props.selected ? " is-selected" : ""}`}
      >
        <div className="skill-card__header publish-skill-row__header">
          <div className="skill-card__summary-button publish-skill-row__summary-button" onClick={handleSummaryClick}>
            <div className="skill-card__identity">
              {props.selectionMode ? <BatchSelectionMark checked={props.selected} /> : null}
              <PublishSkillMonogram name={skill.name} />
              <div className="skill-card__title-stack">
                <div className="skill-card__title-row">
                  <h3>{skill.name}</h3>
                  {hasMarketLink ? <PublishMarketLink skillName={skill.name} onOpen={props.onOpenMarket} /> : null}
                  {!isGridLayout ? (
                    <span className="status-badge tone-neutral skill-card__owner-badge">
                      {getPublishManagementOwnerLabel(skill.managementOwner, t)}
                    </span>
                  ) : null}
                  <span className={`status-badge tone-${tone}${isGridLayout ? " skill-card__grid-status" : ""}`}>
                    {statusLabel}
                  </span>
                </div>
                <p className="skill-card__summary-description">{skill.description || t("publishing.empty.description")}</p>
                {isGridLayout ? (
                  <span className="skill-card__grid-source-label publish-skill-row__grid-source-label">
                    <span className="skill-card__grid-source-text">
                      {getPublishSourceMethodLabel(skill, t)} · {getPublishManagementOwnerLabel(skill.managementOwner, t)}
                    </span>
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="skill-card__list-actions publish-skill-row__actions">
            {publishedVersion ? <span className="publish-skill-row__version">{publishedVersion}</span> : null}
            {canPublish || isPublishingStatus ? (
              <button className={actionClassName} type="button" onClick={props.onPublish} disabled={isPublishingStatus} aria-label={buttonLabel} data-tooltip={buttonLabel}>
                {isPublishingStatus ? <RefreshIcon isSpinning /> : <PublishActionIcon />}
              </button>
            ) : null}
            <PublishFilePreviewButton skill={skill} onClick={props.onPreview} />
            <button className="skill-card__icon-button" type="button" onClick={props.onOpenDirectory} aria-label={`${t("publishing.action.openDirectory")} ${skill.name}`} data-tooltip={t("publishing.action.openDirectory")}>
              <OpenFolderIcon />
            </button>
            <button className="skill-card__chevron-button" type="button" onClick={() => void handleExpandedChange(!props.expanded)} aria-expanded={props.expanded} aria-label={`${props.expanded ? t("publishing.action.collapse") : t("publishing.action.expand")} ${skill.name}`}>
              <span className="skill-card__chevron" aria-hidden="true">{props.expanded ? "⌄" : "›"}</span>
            </button>
          </div>
        </div>
        {props.expanded && !isGridLayout ? (
          <PublishSkillDetails
            skill={skill}
            onPreview={props.onPreview}
            onOpenDirectory={props.onOpenDirectory}
          />
        ) : null}
      </article>
      {props.expanded && isGridLayout ? createPortal(
        <PublishSkillDetailModal
          skill={skill}
          statusLabel={statusLabel}
          statusTone={tone}
          buttonLabel={buttonLabel}
          canPublish={canPublish}
          canOpenMarket={canOpenMarket}
          isPublishing={isPublishingStatus}
          onPublish={props.onPublish}
          onOpenMarket={props.onOpenMarket}
          onPreview={props.onPreview}
          onOpenDirectory={props.onOpenDirectory}
          onClose={() => props.onExpandedChange(false)}
        />,
        document.body,
      ) : null}
    </>
  );
}

function PublishSkillDetailModal(props: {
  skill: PublishableSkill;
  statusLabel: string;
  statusTone: string;
  buttonLabel: string;
  canPublish: boolean;
  canOpenMarket: boolean;
  isPublishing: boolean;
  onPublish: () => void;
  onOpenMarket: () => void;
  onPreview: () => void;
  onOpenDirectory: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslate();
  const hasPrimaryAction = props.canPublish || props.canOpenMarket;

  function handlePrimaryAction() {
    props.onClose();
    if (props.canPublish) {
      props.onPublish();
      return;
    }
    props.onOpenMarket();
  }

  function handlePreview() {
    props.onClose();
    props.onPreview();
  }

  return (
    <div className="skill-card-detail-modal__backdrop" role="presentation" onClick={props.onClose}>
      <section className="skill-card-detail-modal publish-skill-detail-modal" role="dialog" aria-modal="true" aria-label={t("publishing.details.aria", { name: props.skill.name })} onClick={(event) => event.stopPropagation()}>
        <header className="skill-card-detail-modal__header">
          <div className="skill-card-detail-modal__identity">
            <PublishSkillMonogram name={props.skill.name} />
            <div className="skill-card-detail-modal__copy">
              <div className="skill-card-detail-modal__title">
                <h3>{props.skill.name}</h3>
                <span className={`status-badge tone-${props.statusTone}`}>{props.statusLabel}</span>
              </div>
            </div>
          </div>
          <div className="skill-card-detail-modal__actions">
            {hasPrimaryAction ? (
              <button className={`secondary-button secondary-button--compact skill-card-detail-modal__action${props.canPublish ? " is-primary" : ""}`} type="button" onClick={handlePrimaryAction} disabled={props.isPublishing}>
                {props.isPublishing ? <RefreshIcon isSpinning /> : props.canPublish ? <PublishActionIcon /> : <OpenMarketIcon />}
                <span>{props.buttonLabel}</span>
              </button>
            ) : null}
            <PublishFilePreviewButton skill={props.skill} onClick={handlePreview} showLabel />
            <button className="skill-card__icon-button skill-card-detail-modal__icon-action" type="button" onClick={props.onOpenDirectory} aria-label={`${t("publishing.action.openDirectory")} ${props.skill.name}`} data-tooltip={t("publishing.action.openDirectory")}>
              <OpenFolderIcon />
            </button>
            <button className="skill-card-detail-modal__close" type="button" onClick={props.onClose} aria-label={t("publishing.details.closeAria", { name: props.skill.name })}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>
        <PublishSkillDetails
          skill={props.skill}
          isModal
          onOpenDirectory={props.onOpenDirectory}
        />
      </section>
    </div>
  );
}

function PublishSkillDetails({
  skill,
  isModal = false,
  onPreview,
  onOpenDirectory,
}: {
  skill: PublishableSkill;
  isModal?: boolean;
  onPreview?: () => void;
  onOpenDirectory?: () => void;
}) {
  const { t } = useTranslate();
  const sourceValue = skill.sourceUrl;
  const sourceLabel = getPublishSourceMethodLabel(skill, t);
  const description = formatSkillDescription(skill.description) || t("publishing.empty.description");
  const localUpdatedAt = formatSkillUpdatedAt(skill.localUpdatedAt) || t("skill.card.notFetched");
  const hasStoreRecord = Boolean(skill.remoteSkillId);
  const lastPublishedAt = formatPublishedAt(skill.lastPublishedAt) || t("skill.card.notFetched");
  const storeVersion = skill.remoteVersion ? `v${skill.remoteVersion}` : t("skill.card.notFetched");
  const hasPublishUpdates = Boolean(skill.remoteSkillId) && (skill.updateFileCount ?? 0) > 0;

  return (
    <div className={`skill-card__details publish-skill-row__details${isModal ? " skill-card-detail-modal__body" : ""}`}>
      <section>
        <div className="skill-card__section-header">
          <h4>{t("skill.card.basicInfo")}</h4>
          {!isModal && hasPublishUpdates && onPreview ? (
            <PublishFilePreviewButton skill={skill} onClick={onPreview} showLabel />
          ) : null}
        </div>
        <dl className="detail-grid detail-grid--single"><div><dt>{t("skill.card.description")}</dt><dd>{description}</dd></div></dl>
        {skill.publishBlocked && skill.failureReason ? (
          <dl className="detail-grid detail-grid--single"><div><dt>{t("publishing.details.publishRestriction")}</dt><dd>{skill.failureReason}</dd></div></dl>
        ) : null}
        <dl className="detail-grid detail-grid--source">
          <div><dt>{t("skill.card.sourceType")}</dt><dd>{sourceLabel}</dd></div>
          {sourceValue ? (
            <div>
              <dt>{t("skill.card.sourceAddress")}</dt>
              <dd className="detail-grid__source-value">
                {isHttpUrl(sourceValue) ? (
                  <a className="detail-grid__source-link detail-grid__single-line" data-tooltip={sourceValue} href={sourceValue} onClick={(event) => {
                    event.preventDefault();
                    void openExternalLink(sourceValue);
                  }}>
                    {sourceValue}
                  </a>
                ) : <span className="detail-grid__single-line" data-tooltip={sourceValue}>{sourceValue}</span>}
              </dd>
            </div>
          ) : null}
          <div className={sourceValue ? undefined : "detail-grid__new-row"}>
            <dt>{t("skill.card.owner")}</dt>
            <dd>{getPublishManagementOwnerLabel(skill.managementOwner, t)}</dd>
          </div>
          <div>
            <dt>{t("skill.card.managedPath")}</dt>
            <dd className="skill-source-card__directory-value">
              <span className="skill-source-card__directory-path detail-grid__single-line" data-tooltip={skill.localPath}>{skill.localPath}</span>
              {onOpenDirectory ? (
                <button className="skill-card__icon-button skill-source-card__directory-open-button" type="button" onClick={onOpenDirectory} aria-label={`${t("publishing.action.openDirectory")} ${skill.name}`} data-tooltip={t("publishing.action.openDirectory")}>
                  <OpenFolderIcon />
                </button>
              ) : null}
            </dd>
          </div>
        </dl>
        <dl className="tool-list-row__detail-grid">
          {hasStoreRecord ? (
            <>
              <div><dt>{t("publishing.details.storeVersion")}</dt><dd>{storeVersion}</dd></div>
              <div><dt>{t("publishing.details.lastPublishedAt")}</dt><dd>{lastPublishedAt}</dd></div>
              {skill.marketUrl ? (
                <div>
                  <dt>{t("publishing.details.storeAddress")}</dt>
                  <dd>
                    <a className="detail-grid__source-link publish-skill-row__market-link" href={skill.marketUrl} onClick={(event) => {
                      event.preventDefault();
                      void openExternalLink(skill.marketUrl);
                    }}>
                      {t("publishing.details.viewStore")}<OpenMarketIcon />
                    </a>
                  </dd>
                </div>
              ) : null}
            </>
          ) : null}
          <div><dt>{t("skill.card.localUpdatedAt")}</dt><dd>{localUpdatedAt}</dd></div>
        </dl>
      </section>
    </div>
  );
}

function UnmanagedSkillRow(props: {
  group: UnmanagedSkillGroup;
  layout: ListGridViewMode;
  onImportAndPublish: () => void;
  onPreview: () => void;
  onOpenPath: (path: string) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const { t } = useTranslate();
  const rowRef = useRef<HTMLElement | null>(null);
  const isGridLayout = props.layout === "grid";
  const sources = Array.from(new Set(props.group.candidates.map((candidate) => formatUnmanagedSource(candidate, t))));
  const fileTypes = Array.from(new Set(props.group.candidates.map((candidate) => formatUnmanagedFileType(candidate, t))));
  const canPreview = Boolean(props.group.candidates[0]?.toolId);
  const defaultPath = props.group.candidates[0]?.resolvedPath || props.group.candidates[0]?.localPath || "";

  useEffect(() => {
    if (!props.expanded || !isGridLayout) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onExpandedChange(false);
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isGridLayout, props.expanded, props.onExpandedChange]);

  async function handleExpandedChange(nextExpanded: boolean) {
    const shouldAlignExpandedCard = nextExpanded && !props.expanded && !isGridLayout;
    props.onExpandedChange(nextExpanded);
    if (shouldAlignExpandedCard) {
      await alignExpandedRowIntoView(rowRef.current);
    }
  }

  return (
    <>
      <article
        ref={rowRef}
        className={`skill-card skill-card--list publish-skill-row unmanaged-skill-row${isGridLayout ? " skill-card--grid publish-skill-row--grid" : ""}${props.expanded ? " is-expanded" : ""}`}
      >
        <div className="skill-card__header publish-skill-row__header">
          <div className="skill-card__summary-button publish-skill-row__summary-button" onClick={() => void handleExpandedChange(!props.expanded)}>
            <div className="skill-card__identity">
              <PublishSkillMonogram name={props.group.name} />
              <div className="skill-card__title-stack">
                <div className="skill-card__title-row">
                  <h3>{props.group.name}</h3>
                  <span className="unmanaged-skill-row__type-badges">
                    {fileTypes.map((fileType) => <span key={fileType} className="status-badge tone-info">{fileType}</span>)}
                  </span>
                </div>
                <p className="skill-card__summary-description">{props.group.description || t("publishing.empty.description")}</p>
                <div className="unmanaged-skill-row__sources" title={sources.join(", ")}>
                  {sources.slice(0, 3).map((source) => <span key={source}>{source}</span>)}
                  {sources.length > 3 ? <span>+{sources.length - 3}</span> : null}
                </div>
              </div>
            </div>
          </div>
          <div className="skill-card__list-actions publish-skill-row__actions unmanaged-skill-row__actions">
            <button
              className="skill-card__icon-button skill-card__icon-button--update unmanaged-skill-row__publish-button"
              type="button"
              onClick={props.onImportAndPublish}
              aria-label={`${t("publishing.unmanaged.importAndPublish")} ${props.group.name}`}
              data-tooltip={t("publishing.unmanaged.importAndPublish")}
            >
              <PublishActionIcon />
            </button>
            <button
              className="skill-card__icon-button"
              type="button"
              onClick={props.onPreview}
              disabled={!canPreview}
              aria-label={`${t("publishing.action.previewFiles")} ${props.group.name}`}
              data-tooltip={canPreview ? t("publishing.action.previewFiles") : t("publishing.action.previewUnavailable")}
            >
              <ViewFileIcon />
            </button>
            <button className="skill-card__icon-button" type="button" onClick={() => props.onOpenPath(defaultPath)} aria-label={`${t("publishing.action.openDirectory")} ${props.group.name}`} data-tooltip={t("publishing.action.openDirectory")}>
              <OpenFolderIcon />
            </button>
            <button className="skill-card__chevron-button" type="button" onClick={() => void handleExpandedChange(!props.expanded)} aria-expanded={props.expanded} aria-label={`${props.expanded ? t("publishing.action.collapse") : t("publishing.action.expand")} ${props.group.name}`}>
              <span className="skill-card__chevron" aria-hidden="true">{props.expanded && !isGridLayout ? "⌄" : "›"}</span>
            </button>
          </div>
        </div>
        {props.expanded && !isGridLayout ? (
          <UnmanagedSkillDetails group={props.group} onOpenPath={props.onOpenPath} />
        ) : null}
      </article>
      {props.expanded && isGridLayout ? createPortal(
        <UnmanagedSkillDetailModal
          group={props.group}
          onImportAndPublish={props.onImportAndPublish}
          onPreview={props.onPreview}
          onOpenPath={props.onOpenPath}
          onClose={() => props.onExpandedChange(false)}
        />,
        document.body,
      ) : null}
    </>
  );
}

function UnmanagedSkillDetails(props: {
  group: UnmanagedSkillGroup;
  onOpenPath: (path: string) => void;
  isModal?: boolean;
}) {
  const { t } = useTranslate();
  const fileTypes = Array.from(new Set(props.group.candidates.map((candidate) => formatUnmanagedFileType(candidate, t))));
  const sources = Array.from(new Set(props.group.candidates.map((candidate) => formatUnmanagedSource(candidate, t))));
  const resolvedPaths = Array.from(new Set(props.group.candidates.map((candidate) => (
    candidate.resolvedPath || candidate.localPath
  ))));

  return (
    <div className={`skill-card__details unmanaged-skill-details${props.isModal ? " skill-card-detail-modal__body" : ""}`}>
      <section>
        <div className="skill-card__section-header"><h4>{t("skill.card.basicInfo")}</h4></div>
        <dl className="detail-grid detail-grid--single">
          <div><dt>{t("skill.card.description")}</dt><dd>{props.group.description || t("publishing.empty.description")}</dd></div>
        </dl>
        <dl className="detail-grid unmanaged-skill-details__metadata unmanaged-skill-details__metadata-grid unmanaged-skill-details__paths">
          <div>
            <dt>{t("publishing.unmanaged.fileType")}</dt>
            <dd className="unmanaged-skill-details__tags">
              {fileTypes.map((fileType) => <span key={fileType} className="status-badge tone-info">{fileType}</span>)}
            </dd>
          </div>
          <div>
            <dt>{t("publishing.unmanaged.realDirectory")}</dt>
            <dd className="unmanaged-skill-details__path-list">
              {resolvedPaths.map((path) => (
                <div key={path} className="detail-grid__source-value">
                  <span className="detail-grid__single-line" title={path}>{path}</span>
                  <button className="skill-card__icon-button" type="button" onClick={() => props.onOpenPath(path)} aria-label={`${t("publishing.unmanaged.realDirectory")} ${props.group.name}`} data-tooltip={t("publishing.unmanaged.realDirectory")}>
                    <OpenFolderIcon />
                  </button>
                </div>
              ))}
            </dd>
          </div>
          <div className="unmanaged-skill-details__source">
            <dt>{t("publishing.unmanaged.detectedFrom")}</dt>
            <dd className="unmanaged-skill-details__tags">
              {sources.map((source) => <span key={source} className="status-badge tone-neutral">{source}</span>)}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function UnmanagedSkillDetailModal(props: {
  group: UnmanagedSkillGroup;
  onImportAndPublish: () => void;
  onPreview: () => void;
  onOpenPath: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslate();
  const fileTypes = Array.from(new Set(props.group.candidates.map((candidate) => formatUnmanagedFileType(candidate, t))));
  const canPreview = Boolean(props.group.candidates[0]?.toolId);
  const defaultPath = props.group.candidates[0]?.resolvedPath || props.group.candidates[0]?.localPath || "";

  function handleImportAndPublish() {
    props.onClose();
    props.onImportAndPublish();
  }

  function handlePreview() {
    props.onClose();
    props.onPreview();
  }

  return (
    <div className="skill-card-detail-modal__backdrop" role="presentation" onClick={props.onClose}>
      <section className="skill-card-detail-modal publish-skill-detail-modal unmanaged-skill-detail-modal" role="dialog" aria-modal="true" aria-label={t("publishing.unmanaged.detailsAria", { name: props.group.name })} onClick={(event) => event.stopPropagation()}>
        <header className="skill-card-detail-modal__header">
          <div className="skill-card-detail-modal__identity">
            <PublishSkillMonogram name={props.group.name} />
            <div className="skill-card-detail-modal__copy">
              <div className="skill-card-detail-modal__title">
                <h3>{props.group.name}</h3>
                {fileTypes.map((fileType) => <span key={fileType} className="status-badge tone-info">{fileType}</span>)}
              </div>
            </div>
          </div>
          <div className="skill-card-detail-modal__actions">
            <button className="secondary-button secondary-button--compact skill-card-detail-modal__action is-primary" type="button" onClick={handleImportAndPublish}>
              <PublishActionIcon />
              <span>{t("publishing.unmanaged.importAndPublish")}</span>
            </button>
            <button className="secondary-button secondary-button--compact skill-card-detail-modal__action" type="button" onClick={handlePreview} disabled={!canPreview}>
              <ViewFileIcon />
              <span>{t("publishing.action.previewFiles")}</span>
            </button>
            <button className="secondary-button secondary-button--compact skill-card-detail-modal__action" type="button" onClick={() => props.onOpenPath(defaultPath)}>
              <OpenFolderIcon />
              <span>{t("publishing.action.openDirectory")}</span>
            </button>
            <button className="skill-card-detail-modal__close" type="button" onClick={props.onClose} aria-label={t("publishing.unmanaged.closeDetailsAria", { name: props.group.name })}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>
        <UnmanagedSkillDetails group={props.group} isModal onOpenPath={props.onOpenPath} />
      </section>
    </div>
  );
}

function UnmanagedImportDialog(props: {
  group: UnmanagedSkillGroup;
  isImporting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslate();
  const sources = Array.from(new Set(props.group.candidates.map((candidate) => (
    formatUnmanagedSource(candidate, t)
  )))).join(", ");
  return (
    <div className="dialog-backdrop" role="presentation" onClick={props.onClose}>
      <div className="dialog-card publish-confirm-dialog unmanaged-import-dialog" role="dialog" aria-modal="true" aria-labelledby="unmanaged-import-dialog-title" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-card__header">
          <div>
            <h3 id="unmanaged-import-dialog-title">{t("publishing.unmanaged.importTitle", { name: props.group.name })}</h3>
            <p>{t("publishing.unmanaged.importDescription")}</p>
          </div>
          <button className="skill-detail-modal__close" type="button" aria-label={t("app.window.close")} onClick={props.onClose} disabled={props.isImporting}>×</button>
        </header>
        <div className="dialog-card__body">
          <div className="dialog-info-row publish-confirm-dialog__info-row"><span className="dialog-info-label">{t("skill.card.description")}</span><span>{props.group.description || t("publishing.empty.description")}</span></div>
          <div className="dialog-info-row publish-confirm-dialog__info-row"><span className="dialog-info-label">{t("publishing.unmanaged.detectedFrom")}</span><span>{sources}</span></div>
        </div>
        <footer className="dialog-card__footer">
          <button className="secondary-button secondary-button--compact" type="button" onClick={props.onClose} disabled={props.isImporting}>{t("publishing.dialog.cancel")}</button>
          <button className="primary-button primary-button--compact publish-confirm-dialog__primary-button" type="button" onClick={props.onConfirm} disabled={props.isImporting}>
            {props.isImporting ? t("publishing.unmanaged.importing") : t("publishing.unmanaged.confirmImport")}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function PublishingWorkbench({
  adapter,
  externalAuthState,
  isVisible = true,
  renderAuthentication,
  onAuthStateChange,
}: PublishingWorkbenchProps) {
  const { t } = useTranslate();
  const capabilities = useMemo(() => getPublishingAdapterCapabilities(adapter), [adapter]);
  const startupSnapshot = useMemo(() => adapter.readCachedSnapshot?.() ?? null, [adapter]);
  const [authState, setAuthState] = useState<PublishingAuthState | null>(null);
  const [skills, setSkills] = useState<PublishableSkill[]>(() => startupSnapshot?.skills ?? []);
  const [displayOrder, setDisplayOrder] = useState<string[]>(() => startupSnapshot?.displayOrder ?? []);
  const [unmanagedSkills, setUnmanagedSkills] = useState<PublishingUnmanagedSkill[]>([]);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [activeTab, setActiveTab] = useState<PublishSkillTab>("managed");
  const [viewMode, setViewMode] = useState<ListGridViewMode>(readViewMode);
  const [statusFilter, setStatusFilter] = useState<PublishStatusFilter>("all");
  const [isRefreshing, setIsRefreshing] = useState(() => startupSnapshot === null);
  const [isRefreshingUnmanagedSkills, setIsRefreshingUnmanagedSkills] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [statusSyncError, setStatusSyncError] = useState(() => startupSnapshot?.statusSyncError ?? "");
  const [selectedSkill, setSelectedSkill] = useState<PublishableSkill | null>(null);
  const [previewSkill, setPreviewSkill] = useState<PublishableSkill | null>(null);
  const [previewCandidate, setPreviewCandidate] = useState<PublishingUnmanagedSkill | null>(null);
  const [unmanagedImportGroup, setUnmanagedImportGroup] = useState<UnmanagedSkillGroup | null>(null);
  const [batchConfirm, setBatchConfirm] = useState<BatchConfirmState | null>(null);
  const [expandedSkillPath, setExpandedSkillPath] = useState("");
  const [expandedUnmanagedName, setExpandedUnmanagedName] = useState("");
  const [toolbarContainer, setToolbarContainer] = useState<HTMLElement | null>(null);
  const [summaryContainer, setSummaryContainer] = useState<HTMLElement | null>(null);
  const [sourceContainer, setSourceContainer] = useState<HTMLElement | null>(null);
  const refreshRequestRef = useRef(0);
  const skillsRef = useRef<PublishableSkill[]>(startupSnapshot?.skills ?? []);
  const displayOrderRef = useRef<string[]>(startupSnapshot?.displayOrder ?? []);
  const refreshRef = useRef<(options?: RefreshOptions) => Promise<void>>(() => Promise.resolve());
  const fetchUnmanagedSkillsRef = useRef(adapter.fetchUnmanagedSkills);
  const previousSkillCardRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const shouldPersistLocalPublishStatusRef = useRef(false);
  const wasVisibleRef = useRef(isVisible);

  const counts = useMemo(() => {
    const nextCounts: Record<PublishStatusFilter, number> = {
      all: skills.length,
      unpublished: 0,
      "update-available": 0,
      published: 0,
      publishing: 0,
      reviewing: 0,
      failed: 0,
    };
    for (const skill of skills) {
      nextCounts[skill.publishStatus] += 1;
      if (skill.publishStatus === "update-available") {
        nextCounts.published += 1;
      }
    }
    return nextCounts;
  }, [skills]);
  const orderedSkills = useMemo(
    () => orderPublishableSkills(skills, displayOrder),
    [displayOrder, skills],
  );
  const filteredSkills = useMemo(() => orderedSkills.filter((skill) => (
    matchesStatusFilter(skill.publishStatus, statusFilter)
      && (!deferredQuery
        || skill.name.toLowerCase().includes(deferredQuery)
        || skill.description.toLowerCase().includes(deferredQuery))
  )), [deferredQuery, orderedSkills, statusFilter]);
  const unmanagedGroups = useMemo(
    () => buildUnmanagedSkillGroups(unmanagedSkills),
    [unmanagedSkills],
  );
  const filteredUnmanagedGroups = useMemo(() => unmanagedGroups.filter((group) => (
    !deferredQuery
      || group.name.toLowerCase().includes(deferredQuery)
      || group.description.toLowerCase().includes(deferredQuery)
      || group.candidates.some((candidate) => formatUnmanagedSource(candidate, t).toLowerCase().includes(deferredQuery))
  )), [deferredQuery, unmanagedGroups, t]);
  const visibleBatchIds = useMemo(() => filteredSkills
    .filter((skill) => !skill.publishBlocked && BATCH_PUBLISHABLE_STATUSES.has(skill.publishStatus))
    .map((skill) => skill.localPath), [filteredSkills]);
  const batchSelection = useBatchSelection(visibleBatchIds);
  const selectedBatchSkills = useMemo(() => filteredSkills.filter((skill) => (
    batchSelection.selectedIds.has(skill.localPath)
  )), [batchSelection.selectedIds, filteredSkills]);
  const summary = activeTab === "managed"
    ? t("publishing.summary.managed", {
      platform: adapter.platform.label,
      unpublished: counts.unpublished,
      published: counts.published,
      updatable: counts["update-available"],
      publishing: counts.publishing,
    })
    : t("publishing.summary.unmanaged", {
      platform: adapter.platform.label,
      count: unmanagedGroups.length,
    });

  useLayoutEffect(() => {
    const previousSkillCardRects = previousSkillCardRectsRef.current;
    if (previousSkillCardRects.size === 0) {
      return;
    }
    previousSkillCardRectsRef.current = new Map();
    if (window.matchMedia?.(REDUCED_MOTION_MEDIA_QUERY).matches) {
      return;
    }
    for (const element of document.querySelectorAll<HTMLElement>("[data-publish-skill-path]")) {
      const skillPath = element.dataset.publishSkillPath;
      const previousRect = skillPath ? previousSkillCardRects.get(skillPath) : undefined;
      if (!previousRect) {
        continue;
      }
      const nextRect = element.getBoundingClientRect();
      const offsetX = previousRect.left - nextRect.left;
      const offsetY = previousRect.top - nextRect.top;
      if ((offsetX !== 0 || offsetY !== 0) && typeof element.animate === "function") {
        element.animate(
          [
            { transform: `translate(${offsetX}px, ${offsetY}px)` },
            { transform: "translate(0, 0)" },
          ],
          {
            duration: PUBLISH_ORDER_ANIMATION_DURATION_MS,
            easing: PUBLISH_ORDER_ANIMATION_EASING,
          },
        );
      }
    }
  }, [orderedSkills]);

  function captureSkillCardPositions() {
    const positions = new Map<string, DOMRect>();
    for (const element of document.querySelectorAll<HTMLElement>("[data-publish-skill-path]")) {
      const skillPath = element.dataset.publishSkillPath;
      if (skillPath) {
        positions.set(skillPath, element.getBoundingClientRect());
      }
    }
    previousSkillCardRectsRef.current = positions;
  }

  function applySkillSnapshot(nextSkills: PublishableSkill[], nextDisplayOrder: string[]) {
    const orderChanged = !hasSameDisplayOrder(displayOrderRef.current, nextDisplayOrder);
    if (orderChanged) {
      captureSkillCardPositions();
    }
    skillsRef.current = nextSkills;
    displayOrderRef.current = nextDisplayOrder;
    setSkills(nextSkills);
    setDisplayOrder(nextDisplayOrder);
  }

  async function refreshAuth() {
    await refresh({ forceRefresh: true });
  }

  const refreshUnmanagedSkills = useCallback(async () => {
    const fetchUnmanagedSkills = fetchUnmanagedSkillsRef.current;
    if (!fetchUnmanagedSkills) {
      return;
    }
    setIsRefreshingUnmanagedSkills(true);
    try {
      setUnmanagedSkills(await fetchUnmanagedSkills());
    } catch {
      // 保留上一轮扫描结果，避免本地目录临时不可读时清空未托管列表。
    } finally {
      setIsRefreshingUnmanagedSkills(false);
    }
  }, []);

  async function refresh(options: RefreshOptions = {}) {
    const forceRefresh = options.forceRefresh ?? false;
    const isBackground = options.background ?? false;
    const hasExternalAuthOwner = externalAuthState !== undefined;
    const shouldNotifyAuthState = onAuthStateChange !== undefined;
    if (hasExternalAuthOwner && !externalAuthState?.connected) {
      return;
    }
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    if (!isBackground) {
      setIsRefreshing(true);
      setLoadError("");
    }
    try {
      const nextAuthState = hasExternalAuthOwner
        ? externalAuthState
        : await adapter.getAuthState();
      if (requestId !== refreshRequestRef.current) {
        return;
      }
      setAuthState(nextAuthState);
      if (shouldNotifyAuthState) {
        onAuthStateChange?.(nextAuthState);
      } else {
        adapter.writeCachedAuthState?.(nextAuthState);
      }
      if (!nextAuthState.connected) {
        skillsRef.current = [];
        displayOrderRef.current = [];
        setSkills([]);
        setDisplayOrder([]);
        setStatusSyncError("");
        return;
      }
      const snapshot = await adapter.fetchSkills(forceRefresh);
      if (requestId !== refreshRequestRef.current) {
        return;
      }
      if (snapshot.authorizationRequired) {
        const disconnectedAuthState: PublishingAuthState = {
          connected: false,
          accountLabel: "",
          verifiedAt: "",
        };
        setAuthState(disconnectedAuthState);
        if (shouldNotifyAuthState) {
          onAuthStateChange?.(disconnectedAuthState);
        } else {
          adapter.writeCachedAuthState?.(disconnectedAuthState);
        }
        skillsRef.current = [];
        displayOrderRef.current = [];
        setSkills([]);
        setDisplayOrder([]);
        setStatusSyncError("");
        return;
      }
      const currentSkills = skillsRef.current;
      const currentDisplayOrder = displayOrderRef.current;
      const stableSkills = retainCachedPublishStatus(
        currentSkills,
        snapshot.skills,
        adapter.fetchSkillsIncludesFileDiff === true,
      );
      const skillsChanged = !hasSamePublishableSkills(currentSkills, stableSkills);
      const shouldReorder = !isBackground || currentDisplayOrder.length === 0;
      const nextDisplayOrder = shouldReorder
        ? buildPublishableSkillDisplayOrder(stableSkills)
        : currentDisplayOrder;
      if (skillsChanged || !hasSameDisplayOrder(currentDisplayOrder, nextDisplayOrder)) {
        applySkillSnapshot(stableSkills, nextDisplayOrder);
      }
      setStatusSyncError(snapshot.statusSyncError ?? "");
      adapter.writeCachedSnapshot?.({ ...snapshot, skills: stableSkills, displayOrder: nextDisplayOrder });
      if (adapter.reconcileSkills) {
        const reconciledBaseSkills = stableSkills;
        const reconciledBaseDisplayOrder = nextDisplayOrder;
        void adapter.reconcileSkills(forceRefresh).then((reconciledSnapshot) => {
          if (requestId !== refreshRequestRef.current) {
            return;
          }
          if (reconciledSnapshot.authorizationRequired) {
            const disconnectedAuthState: PublishingAuthState = {
              connected: false,
              accountLabel: "",
              verifiedAt: "",
            };
            setAuthState(disconnectedAuthState);
            if (shouldNotifyAuthState) {
              onAuthStateChange?.(disconnectedAuthState);
            } else {
              adapter.writeCachedAuthState?.(disconnectedAuthState);
            }
            skillsRef.current = [];
            displayOrderRef.current = [];
            setSkills([]);
            setDisplayOrder([]);
            setStatusSyncError("");
            return;
          }
          const stableReconciledSkills = retainCachedPublishStatus(
            reconciledBaseSkills,
            reconciledSnapshot.skills,
            !reconciledSnapshot.statusSyncError,
          );
          const skillsChanged = !hasSamePublishableSkills(reconciledBaseSkills, stableReconciledSkills);
          const shouldReorder = !isBackground || reconciledBaseDisplayOrder.length === 0;
          const nextDisplayOrder = shouldReorder
            ? buildPublishableSkillDisplayOrder(stableReconciledSkills)
            : reconciledBaseDisplayOrder;
          if (skillsChanged || !hasSameDisplayOrder(reconciledBaseDisplayOrder, nextDisplayOrder)) {
            applySkillSnapshot(stableReconciledSkills, nextDisplayOrder);
          }
          setStatusSyncError(reconciledSnapshot.statusSyncError ?? "");
          adapter.writeCachedSnapshot?.({ ...reconciledSnapshot, skills: stableReconciledSkills, displayOrder: nextDisplayOrder });
        }).catch((error) => {
          if (requestId !== refreshRequestRef.current) {
            return;
          }
          setStatusSyncError(formatError(error));
        });
      }
    } catch (error) {
      if (requestId !== refreshRequestRef.current) {
        return;
      }
      if (!isBackground) {
        setLoadError(formatError(error));
      }
    } finally {
      if (!isBackground && requestId === refreshRequestRef.current) {
        setIsRefreshing(false);
      }
    }
  }

  refreshRef.current = refresh;

  useEffect(() => {
    const becameVisible = isVisible && !wasVisibleRef.current;
    wasVisibleRef.current = isVisible;
    if (becameVisible) {
      void refreshRef.current({ forceRefresh: true });
    }
  }, [isVisible]);

  async function importAndPublishUnmanagedSkill(group: UnmanagedSkillGroup) {
    const candidate = group.candidates[0];
    if (!candidate || !adapter.importAndPublishUnmanagedSkill) {
      return;
    }
    setIsPublishing(true);
    setLoadError("");
    try {
      await adapter.importAndPublishUnmanagedSkill(candidate);
      setUnmanagedImportGroup(null);
      setActiveTab("managed");
      await Promise.all([
        refresh({ forceRefresh: true }),
        refreshUnmanagedSkills(),
      ]);
    } catch (error) {
      setLoadError(formatError(error));
    } finally {
      setIsPublishing(false);
    }
  }

  async function publishSkill(skill: PublishableSkill, changelog?: string) {
    shouldPersistLocalPublishStatusRef.current = true;
    setSkills((current) => {
      const nextSkills = replaceSkill(current, { ...skill, publishStatus: "publishing", failureReason: "" });
      skillsRef.current = nextSkills;
      return nextSkills;
    });
    try {
      const publishedSkill = await adapter.publishSkill({
        skillName: skill.name,
        localPath: skill.localPath,
        remoteSkillId: skill.remoteSkillId,
        expectedRemoteVersion: skill.remoteVersion || undefined,
        changelog,
      });
      setSkills((current) => {
        const nextSkills = replaceSkill(current, publishedSkill);
        skillsRef.current = nextSkills;
        return nextSkills;
      });
    } catch (error) {
      const isPublishResultUnknown = adapter.isPublishResultUnknown?.(error) === true;
      const failedSkill = isPublishResultUnknown
        ? { ...skill, publishStatus: "publishing" as const, failureReason: "" }
        : { ...skill, publishStatus: "failed" as const, failureReason: formatError(error) };
      shouldPersistLocalPublishStatusRef.current = true;
      setSkills((current) => {
        const nextSkills = replaceSkill(current, failedSkill);
        skillsRef.current = nextSkills;
        return nextSkills;
      });
      throw error;
    }
  }

  async function refreshSkillAfterLocalChanges(localPath: string) {
    const currentSkill = skillsRef.current.find((skill) => skill.localPath === localPath);
    if (!currentSkill) {
      return;
    }
    try {
      const refreshedSkill = await adapter.refreshSkill(currentSkill);
      shouldPersistLocalPublishStatusRef.current = true;
      setSkills((current) => {
        const nextSkills = replaceSkill(current, refreshedSkill);
        skillsRef.current = nextSkills;
        return nextSkills;
      });
      setPreviewSkill((current) => (
        current?.localPath === refreshedSkill.localPath ? refreshedSkill : current
      ));
    } catch (error) {
      setStatusSyncError(formatError(error));
    }
  }

  function handlePublish(changelog: string) {
    const skill = selectedSkill;
    if (!skill) {
      return;
    }
    // 保持旧共享发布的反馈：确认后立即收起窗口，卡片在后台请求期间显示“发布中”。
    setSelectedSkill(null);
    setLoadError("");
    void publishSkill(skill, changelog).catch((error) => {
      setLoadError(formatError(error));
    });
  }

  async function handleBatchPublish() {
    if (!batchConfirm) {
      return;
    }
    setIsPublishing(true);
    setLoadError("");
    for (const skill of batchConfirm.skills) {
      try {
        await publishSkill(skill);
      } catch (error) {
        setLoadError(formatError(error));
      }
    }
    await refresh({ forceRefresh: true });
    setIsPublishing(false);
    setBatchConfirm(null);
    batchSelection.exitSelection();
  }

  useLayoutEffect(() => {
    refreshRequestRef.current += 1;
    fetchUnmanagedSkillsRef.current = adapter.fetchUnmanagedSkills;
    const cachedSnapshot = adapter.readCachedSnapshot?.() ?? null;
    skillsRef.current = cachedSnapshot?.skills ?? [];
    const cachedSkills = cachedSnapshot?.skills ?? [];
    const initialDisplayOrder = buildPublishableSkillDisplayOrder(cachedSkills);
    displayOrderRef.current = initialDisplayOrder;
    setAuthState(null);
    setSkills(cachedSkills);
    setDisplayOrder(initialDisplayOrder);
    setIsRefreshing(cachedSnapshot === null);
    setLoadError("");
    setStatusSyncError(cachedSnapshot?.statusSyncError ?? "");
    setSelectedSkill(null);
    setPreviewSkill(null);
    setPreviewCandidate(null);
    setUnmanagedImportGroup(null);
    setBatchConfirm(null);
    setExpandedSkillPath("");
    setExpandedUnmanagedName("");
    previousSkillCardRectsRef.current = new Map();
    shouldPersistLocalPublishStatusRef.current = false;
  }, [adapter]);

  useEffect(() => {
    if (!shouldPersistLocalPublishStatusRef.current) {
      return;
    }
    shouldPersistLocalPublishStatusRef.current = false;
    adapter.writeCachedSnapshot?.({
      skills,
      displayOrder,
      authorizationRequired: false,
      statusSyncError,
    });
  }, [adapter, displayOrder, skills, statusSyncError]);

  useEffect(() => {
    setToolbarContainer(document.getElementById("publish-header-toolbar-slot"));
    setSummaryContainer(document.getElementById("publish-header-summary-slot"));
    setSourceContainer(document.getElementById("publish-source-header-slot"));
    if (!isVisible) {
      return;
    }
    if (!startupSnapshot || !adapter.cachedSnapshotRefreshDelayMs) {
      void refresh();
      return;
    }
    const timer = window.setTimeout(() => {
      if (wasVisibleRef.current) {
        void refreshRef.current({ background: true });
      }
    }, adapter.cachedSnapshotRefreshDelayMs);
    return () => window.clearTimeout(timer);
  }, [adapter, startupSnapshot]);

  useEffect(() => {
    void refreshUnmanagedSkills();
  }, [refreshUnmanagedSkills]);

  useEffect(() => {
    const hasPendingStatus = skills.some((skill) => (
      skill.publishStatus === "publishing" || skill.publishStatus === "reviewing"
    ));
    if (!isVisible || !hasPendingStatus) {
      return;
    }
    const timer = window.setInterval(
      () => void refresh({ background: true }),
      PUBLISH_STATUS_POLL_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [isVisible, skills]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    let refreshTimer: number | null = null;
    void subscribeSkillLibraryChanges(({ skillName }) => {
      const isManagedSkill = skillsRef.current.some((skill) => skill.name === skillName);
      if (!active || !isManagedSkill) {
        return;
      }
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        if (wasVisibleRef.current) {
          void refreshRef.current({ forceRefresh: true, background: true });
        }
      }, SKILL_LIBRARY_CHANGE_DEBOUNCE_MS);
    }).then((stop) => {
      if (active) {
        unlisten = stop;
      } else {
        releaseEventListener(stop);
      }
    }).catch((error) => {
      console.warn("Failed to subscribe to publishing skill library changes:", error);
    });
    return () => {
      active = false;
      releaseEventListener(unlisten);
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
    };
  }, []);

  const toolbar = (
    <PublishToolbar
      query={query}
      viewMode={viewMode}
      activeTab={activeTab}
      statusFilter={statusFilter}
      counts={counts}
      isRefreshing={isRefreshing || isRefreshingUnmanagedSkills}
      isBatchSelecting={batchSelection.isSelecting}
      batchPublishing={capabilities.batchPublishing}
      onQueryChange={setQuery}
      onViewModeChange={(nextViewMode) => {
        setViewMode(nextViewMode);
        writeViewMode(nextViewMode);
      }}
      onStatusFilterChange={setStatusFilter}
      onBatchSelectingChange={(selecting) => (
        selecting ? batchSelection.enterSelection() : batchSelection.exitSelection()
      )}
      onRefresh={() => void Promise.all([
        refresh({ forceRefresh: true }),
        refreshUnmanagedSkills(),
      ])}
    />
  );

  if (!isVisible) {
    return null;
  }

  if (authState && !authState.connected) {
    return renderAuthentication ? (
      <>{renderAuthentication(refreshAuth)}</>
    ) : (
      <div className="panel-card empty-state">
        <h3>{t("publishing.auth.connect", { platform: adapter.platform.label })}</h3>
        <p>{t("publishing.auth.connectDescription")}</p>
      </div>
    );
  }

  return (
    <div className="skills-page publish-page">
      {summaryContainer ? createPortal(summary, summaryContainer) : <p className="publish-page__summary">{summary}</p>}
      {sourceContainer && adapter.fetchUnmanagedSkills ? createPortal(
        <PublishSkillSwitcher
          activeTab={activeTab}
          managedCount={skills.length}
          unmanagedCount={unmanagedGroups.length}
          isCompact={Boolean(sourceContainer.closest(".management-page-header--compact"))}
          onChange={(tab) => {
            batchSelection.exitSelection();
            setActiveTab(tab);
          }}
        />,
        sourceContainer,
      ) : null}
      {toolbarContainer ? createPortal(toolbar, toolbarContainer) : toolbar}
      {batchSelection.isSelecting ? (
        <BatchActionBar
          actions={selectedBatchSkills.length > 0 ? [{
            key: "publish",
            label: t("publishing.batch.publishCount", { count: selectedBatchSkills.length }),
            tone: "accent",
            onClick: () => setBatchConfirm({ skills: selectedBatchSkills }),
          }] : []}
          ariaLabel={t("publishing.batch.actionsAria")}
          cancelLabel={t("publishing.batch.cancel")}
          deselectAllLabel={t("publishing.batch.deselectAll")}
          hint={t("publishing.batch.hint")}
          isAllVisibleSelected={batchSelection.isAllVisibleSelected}
          isBusy={isPublishing}
          selectedLabel={selectedBatchSkills.length > 0
            ? t("publishing.batch.selected", { count: selectedBatchSkills.length })
            : ""}
          selectAllDisabled={visibleBatchIds.length === 0}
          selectAllLabel={t("publishing.batch.selectAll")}
          onCancel={batchSelection.exitSelection}
          onToggleSelectAll={batchSelection.toggleSelectAll}
        />
      ) : null}
      {loadError ? (
        <div className="panel-card publish-page__error">
          <strong>{t("publishing.error.loadTitle")}</strong><p>{loadError}</p>
          <button className="secondary-button" type="button" onClick={() => void refresh({ forceRefresh: true })}>{t("publishing.action.retry")}</button>
        </div>
      ) : null}
      {!loadError && statusSyncError ? (
        <div className="panel-card publish-page__error">
          <strong>{t("publishing.error.syncTitle")}</strong><p>{statusSyncError}</p>
          <button className="secondary-button" type="button" onClick={() => void refresh({ forceRefresh: true })}>{t("publishing.action.retry")}</button>
        </div>
      ) : null}
      {!loadError && !isRefreshing && activeTab === "managed" && filteredSkills.length === 0 ? (
        <div className="panel-card empty-state">
          <h3>{skills.length === 0 ? t("publishing.empty.noPublishableTitle") : t("publishing.empty.noMatchTitle")}</h3>
          <p>{skills.length === 0 ? t("publishing.empty.noPublishableDescription") : t("publishing.empty.noMatchDescription")}</p>
        </div>
      ) : null}
      {!loadError && !isRefreshingUnmanagedSkills && activeTab === "unmanaged" && filteredUnmanagedGroups.length === 0 ? (
        <div className="panel-card empty-state">
          <h3>{unmanagedGroups.length === 0 ? t("publishing.empty.noUnmanagedTitle") : t("publishing.empty.noMatchTitle")}</h3>
          <p>{unmanagedGroups.length === 0 ? t("publishing.empty.noUnmanagedDescription") : t("publishing.empty.noUnmanagedMatchDescription")}</p>
        </div>
      ) : null}
      {activeTab === "managed" ? (
        <div className={`publish-skill-list${viewMode === "grid" ? " is-grid" : ""}`}>
          {filteredSkills.map((skill) => (
          <PublishSkillRow
            key={skill.localPath}
            skill={skill}
            layout={viewMode}
            onPublish={() => setSelectedSkill(skill)}
            onOpenMarket={() => void openExternalLink(skill.marketUrl)}
            onPreview={() => setPreviewSkill(skill)}
            onOpenDirectory={() => void openPathInFinder({ path: skill.localPath })}
            expanded={expandedSkillPath === skill.localPath}
            onExpandedChange={(expanded) => setExpandedSkillPath(expanded ? skill.localPath : "")}
            selectionMode={batchSelection.isSelecting}
            selected={batchSelection.selectedIds.has(skill.localPath)}
            onSelectionToggle={() => batchSelection.toggleSelection(skill.localPath)}
          />
          ))}
        </div>
      ) : (
        <div className={`publish-skill-list${viewMode === "grid" ? " is-grid" : ""}`}>
          {filteredUnmanagedGroups.map((group) => (
            <UnmanagedSkillRow
              key={group.name}
              group={group}
              layout={viewMode}
              onImportAndPublish={() => setUnmanagedImportGroup(group)}
              onPreview={() => setPreviewCandidate(group.candidates[0] ?? null)}
              onOpenPath={(path) => void openPathInFinder({ path })}
              expanded={expandedUnmanagedName === group.name}
              onExpandedChange={(expanded) => setExpandedUnmanagedName(expanded ? group.name : "")}
            />
          ))}
        </div>
      )}
      {selectedSkill ? (
        <PublishConfirmDialog
          skill={selectedSkill}
          isPublishing={isPublishing}
          onClose={() => !isPublishing && setSelectedSkill(null)}
          onConfirm={(changelog) => void handlePublish(changelog)}
        />
      ) : null}
      {batchConfirm ? (
        <BatchPublishConfirmDialog
          skills={batchConfirm.skills}
          isPublishing={isPublishing}
          onClose={() => !isPublishing && setBatchConfirm(null)}
          onConfirm={() => void handleBatchPublish()}
        />
      ) : null}
      {previewSkill ? (
        <SkillFileDialog
          skill={{
            name: previewSkill.name,
            localPath: previewSkill.localPath,
            gitLinked: false,
            localChangeCount: 0,
            collabStatus: previewSkill.publishStatus === "update-available" ? "update-available" : "clean",
          }}
          isOpen
          initialMode={(previewSkill.updateFileCount ?? 0) > 0 ? "updates" : "files"}
          loadUpdatePreview={(
            (previewSkill.updateFileCount ?? 0) > 0
            && previewSkill.remoteSkillId
            && adapter.getUpdatePreview
          ) ? () => adapter.getUpdatePreview!({
            skillName: previewSkill.name,
            localPath: previewSkill.localPath,
            remoteSkillId: previewSkill.remoteSkillId!,
            remoteVersion: previewSkill.remoteVersion,
          }) : undefined}
          revertUpdateFile={(
            (previewSkill.updateFileCount ?? 0) > 0
            && previewSkill.remoteSkillId
            && adapter.revertUpdateFile
          ) ? (relativePath) => adapter.revertUpdateFile!({
            skillName: previewSkill.name,
            localPath: previewSkill.localPath,
            remoteSkillId: previewSkill.remoteSkillId!,
            remoteVersion: previewSkill.remoteVersion,
            relativePath,
          }) : undefined}
          revertUpdateHunk={(
            (previewSkill.updateFileCount ?? 0) > 0
            && previewSkill.remoteSkillId
            && adapter.revertUpdateHunk
          ) ? (relativePath, expectedContent, content) => adapter.revertUpdateHunk!({
            skillName: previewSkill.name,
            localPath: previewSkill.localPath,
            remoteSkillId: previewSkill.remoteSkillId!,
            remoteVersion: previewSkill.remoteVersion,
            relativePath,
            expectedContent,
            content,
          }) : undefined}
          onLocalChangesChanged={() => void refreshSkillAfterLocalChanges(previewSkill.localPath)}
          onClose={() => setPreviewSkill(null)}
        />
      ) : null}
      {previewCandidate?.toolId ? (
        <SkillFileDialog
          skill={previewCandidate}
          toolId={previewCandidate.toolId}
          readOnly
          isOpen
          onClose={() => setPreviewCandidate(null)}
        />
      ) : null}
      {unmanagedImportGroup ? (
        <UnmanagedImportDialog
          group={unmanagedImportGroup}
          isImporting={isPublishing}
          onClose={() => !isPublishing && setUnmanagedImportGroup(null)}
          onConfirm={() => void importAndPublishUnmanagedSkill(unmanagedImportGroup)}
        />
      ) : null}
    </div>
  );
}

function getPublishButtonLabel(status: PublishStatus, t: Translate) {
  if (status === "unpublished") {
    return t("publishing.action.publish");
  }
  if (status === "update-available") {
    return t("publishing.action.publishUpdate");
  }
  if (status === "failed") {
    return t("publishing.action.retry");
  }
  if (status === "reviewing") {
    return t("publishing.action.viewReview");
  }
  if (status === "published") {
    return t("publishing.action.viewMarket");
  }
  return t("publishing.status.publishing");
}

function getPublishStatusTone(status: PublishStatus) {
  if (status === "published") {
    return "positive";
  }
  if (status === "update-available") {
    return "info";
  }
  if (status === "reviewing") {
    return "warning";
  }
  if (status === "failed") {
    return "danger";
  }
  if (status === "publishing") {
    return "processing";
  }
  return "neutral";
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function formatPublishedAt(value: string | undefined) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(timestamp) ? formatSkillUpdatedAt(value) : formatSkillUpdatedAt(String(timestamp));
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
