import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AppSelect } from "@/app/components/AppSelect";
import {
  BatchActionBar,
  BatchModeButton,
  BatchSelectionMark,
} from "@/app/components/BatchActions";
import { SearchFieldIcon } from "@/app/components/SearchFieldIcon";
import { useBatchSelection } from "@/app/hooks/useBatchSelection";
import { useStableListOrder } from "@/app/hooks/useStableListOrder";
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
import { formatSkillSourceLabel } from "@/features/skills/utils/skill-source";
import { formatSkillUpdatedAt, parseSkillTimestamp } from "@/features/skills/utils/skill-time";

type PublishStatusFilter = "all" | PublishStatus;

type PublishingWorkbenchProps = {
  adapter: PublishingPlatformAdapter;
  renderAuthentication?: (refreshAuth: () => Promise<void>) => ReactNode;
};

type BatchConfirmState = {
  skills: PublishableSkill[];
};

type PublishSkillTab = "managed" | "unmanaged";

type UnmanagedSkillGroup = {
  name: string;
  description: string;
  candidates: PublishingUnmanagedSkill[];
};

const STATUS_OPTIONS: Array<{ value: PublishStatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "update-available", label: "可更新" },
  { value: "unpublished", label: "未发布" },
  { value: "published", label: "已发布" },
];

const STATUS_LABELS: Record<PublishStatus, string> = {
  unpublished: "未发布",
  "update-available": "可更新",
  published: "已发布",
  publishing: "发布中",
  reviewing: "审核中",
  failed: "发布失败",
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

function matchesStatusFilter(status: PublishStatus, filter: PublishStatusFilter) {
  if (filter === "all") {
    return true;
  }
  if (filter === "published") {
    return status === "published" || status === "update-available";
  }
  return status === filter;
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

function retainCachedUpdateStatus(
  previousSkills: PublishableSkill[],
  refreshedSkills: PublishableSkill[],
) {
  const previousByPath = new Map(previousSkills.map((skill) => [skill.localPath, skill]));
  return refreshedSkills.map((skill) => {
    const previous = previousByPath.get(skill.localPath);
    const canRetainUpdateStatus = previous?.publishStatus === "update-available"
      && (previous.updateFileCount ?? 0) > 0
      && previous.localContentHash === skill.localContentHash
      && previous.remoteSkillId === skill.remoteSkillId
      && previous.remoteVersion === skill.remoteVersion;
    if (!canRetainUpdateStatus) {
      return skill;
    }
    return {
      ...skill,
      publishStatus: previous.publishStatus,
      updateFileCount: previous.updateFileCount,
      targetVersion: previous.targetVersion,
    };
  });
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

function formatUnmanagedSource(candidate: PublishingUnmanagedSkill) {
  const normalized = candidate.detectedFrom.replace(/\\\\/g, "/").toLowerCase();
  if (normalized.includes("/.cursor/")) return "Cursor";
  if (normalized.includes("/.claude/")) return "Claude Code";
  if (normalized.includes("/.codex/")) return "Codex";
  if (normalized.includes("/.codeium/windsurf/")) return "Windsurf";
  if (normalized.includes("/.gemini/")) return "Gemini";
  const parts = candidate.detectedFrom.replace(/\\\\/g, "/").split("/").filter(Boolean);
  return parts.at(-2) ?? parts.at(-1) ?? "本地工具";
}

function formatUnmanagedFileType(candidate: PublishingUnmanagedSkill) {
  return candidate.sourceHint === "符号链接" || candidate.sourceHint === "Symlink"
    ? "符号链接"
    : "真实文件";
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
  const hasUpdates = (props.skill.updateFileCount ?? 0) > 0;
  const label = hasUpdates ? "预览变更" : "预览文件";
  const className = props.showLabel
    ? "secondary-button secondary-button--compact skill-card-detail-modal__action publish-skill-row__preview-button"
    : "skill-card__icon-button publish-skill-row__preview-button";
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
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const options: Array<{ key: PublishSkillTab; label: string; count: number }> = [
    { key: "managed", label: "已托管", count: props.managedCount },
    { key: "unmanaged", label: "未托管", count: props.unmanagedCount },
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
      <div className="skills-source-tabs" role="tablist" aria-label="发布 Skill 分类">
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
  return (
    <div className="skills-header-bar__tools">
      <label className="search-field search-field--header skill-search-field">
        <span className="sr-only">搜索 Skill</span>
        <SearchFieldIcon />
        <input
          type="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={props.activeTab === "managed" ? "搜索 Skill 名称或简介..." : "搜索未托管 Skill..."}
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
      </label>
      <ListGridViewToggle value={props.viewMode} onChange={props.onViewModeChange} />
      {props.activeTab === "managed" ? (
        <div className="skill-status-filter publish-toolbar__filter">
          <span className="skill-status-filter__icon" aria-hidden="true"><FilterIcon /></span>
          <AppSelect
            ariaLabel="按发布状态筛选"
            value={props.statusFilter}
            options={STATUS_OPTIONS.map((option) => ({
              value: option.value,
              label: `${option.label} (${props.counts[option.value]})`,
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
          label={props.isBatchSelecting ? "退出批量选择" : "进入批量选择"}
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
        <span>刷新</span>
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
  const [changelog, setChangelog] = useState("");
  const isUpdate = Boolean(props.skill.remoteSkillId);
  const summaryClassName = `dialog-summary-grid publish-confirm-dialog__summary${isUpdate ? " is-update" : ""}`;

  return (
    <div className="dialog-backdrop" role="presentation" onClick={props.onClose}>
      <div className="dialog-card publish-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-dialog-title" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-card__header">
          <div>
            <h3 id="publish-dialog-title">{isUpdate ? "发布更新" : "发布 Skill"}</h3>
            <p>发布信息将由当前发布平台处理</p>
          </div>
          <button className="skill-detail-modal__close" type="button" aria-label="关闭" onClick={props.onClose}>×</button>
        </header>
        <div className="dialog-card__body">
          <div className="dialog-info-row publish-confirm-dialog__info-row">
            <span className="dialog-info-label">名称</span><strong>{props.skill.name}</strong>
          </div>
          <div className="dialog-info-row publish-confirm-dialog__info-row">
            <span className="dialog-info-label">简介</span>
            <span className="publish-confirm-dialog__description">{props.skill.description || "暂无简介"}</span>
          </div>
          <div className={summaryClassName}>
            {isUpdate ? <div><span>当前版本</span><strong>{props.skill.remoteVersion || "未获取"}</strong></div> : null}
            <div><span>目标版本</span><strong>{props.skill.targetVersion}</strong></div>
            <div><span>文件</span><strong>{props.skill.fileCount} 个</strong></div>
            <div><span>大小</span><strong>{formatBytes(props.skill.packageSize)}</strong></div>
          </div>
          <label className="dialog-section publish-confirm-dialog__changelog">
            <h4>更新说明（可选）</h4>
            <textarea
              value={changelog}
              placeholder={isUpdate ? "未填写时使用“内容更新”" : "未填写时使用“首次发布”"}
              onChange={(event) => setChangelog(event.target.value)}
            />
          </label>
          {props.skill.failureReason ? <p className="dialog-error">{props.skill.failureReason}</p> : null}
        </div>
        <footer className="dialog-card__footer">
          <button className="secondary-button secondary-button--compact" type="button" disabled={props.isPublishing} onClick={props.onClose}>取消</button>
          <button
            className="primary-button primary-button--compact publish-confirm-dialog__primary-button"
            type="button"
            disabled={props.isPublishing}
            onClick={() => props.onConfirm(changelog)}
          >
            {props.isPublishing ? "正在发布..." : isUpdate ? "发布更新" : "发布"}
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
  const updateCount = props.skills.filter((skill) => Boolean(skill.remoteSkillId)).length;
  return (
    <div className="dialog-backdrop" role="presentation" onClick={props.onClose}>
      <div className="dialog-card publish-confirm-dialog publish-batch-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-batch-dialog-title" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-card__header">
          <div><h3 id="publish-batch-dialog-title">批量发布</h3><p>将按顺序发布已选择的 Skill</p></div>
          <button className="skill-detail-modal__close" type="button" aria-label="关闭" onClick={props.onClose}>×</button>
        </header>
        <div className="dialog-card__body">
          <div className="dialog-summary-grid publish-batch-dialog__summary">
            <div><span>合计</span><strong>{props.skills.length}</strong></div>
            <div><span>首次发布</span><strong>{props.skills.length - updateCount}</strong></div>
            <div><span>发布更新</span><strong>{updateCount}</strong></div>
          </div>
          <p className="publish-batch-dialog__names">{props.skills.map((skill) => skill.name).join("、")}</p>
        </div>
        <footer className="dialog-card__footer">
          <button className="secondary-button secondary-button--compact" type="button" disabled={props.isPublishing} onClick={props.onClose}>取消</button>
          <button className="primary-button primary-button--compact publish-confirm-dialog__primary-button" type="button" disabled={props.isPublishing} onClick={props.onConfirm}>
            {props.isPublishing ? "正在发布..." : `发布 ${props.skills.length} 个`}
          </button>
        </footer>
      </div>
    </div>
  );
}

function PublishMarketLink(props: { skillName: string; onOpen: () => void }) {
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    props.onOpen();
  }
  return (
    <button className="publish-skill-row__market-title-link" type="button" onClick={handleClick} aria-label={`查看市场 ${props.skillName}`} title="查看市场">
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
  const { skill } = props;
  const rowRef = useRef<HTMLElement | null>(null);
  const isGridLayout = props.layout === "grid";
  const canPublish = BATCH_PUBLISHABLE_STATUSES.has(skill.publishStatus);
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
  const buttonLabel = getPublishButtonLabel(skill.publishStatus);
  const tone = getPublishStatusTone(skill.publishStatus);
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
                  <span className={`status-badge tone-${tone}${isGridLayout ? " skill-card__grid-status" : ""}`}>
                    {STATUS_LABELS[skill.publishStatus]}
                  </span>
                </div>
                <p className="skill-card__summary-description">{skill.description || "暂无简介"}</p>
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
            <button className="skill-card__icon-button" type="button" onClick={props.onOpenDirectory} aria-label={`打开目录 ${skill.name}`} data-tooltip="打开目录">
              <OpenFolderIcon />
            </button>
            <button className="skill-card__chevron-button" type="button" onClick={() => void handleExpandedChange(!props.expanded)} aria-expanded={props.expanded} aria-label={`${props.expanded ? "收起" : "展开"} ${skill.name}`}>
              <span className="skill-card__chevron" aria-hidden="true">{props.expanded ? "⌄" : "›"}</span>
            </button>
          </div>
        </div>
        {props.expanded && !isGridLayout ? <PublishSkillDetails skill={skill} onPreview={props.onPreview} /> : null}
      </article>
      {props.expanded && isGridLayout ? createPortal(
        <PublishSkillDetailModal
          skill={skill}
          statusLabel={STATUS_LABELS[skill.publishStatus]}
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
  const isPrimaryDisabled = !props.canPublish && !props.canOpenMarket;

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
      <section className="skill-card-detail-modal publish-skill-detail-modal" role="dialog" aria-modal="true" aria-label={`${props.skill.name} 发布详情`} onClick={(event) => event.stopPropagation()}>
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
            <button className={`secondary-button secondary-button--compact skill-card-detail-modal__action${props.canPublish ? " is-primary" : ""}`} type="button" onClick={handlePrimaryAction} disabled={isPrimaryDisabled}>
              {props.isPublishing ? <RefreshIcon isSpinning /> : props.canPublish ? <PublishActionIcon /> : <OpenMarketIcon />}
              <span>{props.buttonLabel}</span>
            </button>
            <PublishFilePreviewButton skill={props.skill} onClick={handlePreview} showLabel />
            <button className="skill-card__icon-button skill-card-detail-modal__icon-action" type="button" onClick={props.onOpenDirectory} aria-label={`打开目录 ${props.skill.name}`} data-tooltip="打开目录">
              <OpenFolderIcon />
            </button>
            <button className="skill-card-detail-modal__close" type="button" onClick={props.onClose} aria-label={`关闭 ${props.skill.name} 发布详情`}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>
        <PublishSkillDetails skill={props.skill} isModal />
      </section>
    </div>
  );
}

function PublishSkillDetails({
  skill,
  isModal = false,
  onPreview,
}: {
  skill: PublishableSkill;
  isModal?: boolean;
  onPreview?: () => void;
}) {
  const sourceValue = skill.sourceUrl || skill.localPath;
  const sourceLabel = formatSkillSourceLabel(skill.sourceLabel || skill.sourceType || "本地", {
    sourceType: skill.sourceType,
    sourceUrl: sourceValue,
  });
  const showGitBadge = Boolean(skill.gitLinked) && skill.sourceType !== "marketplace";
  const description = formatSkillDescription(skill.description) || "暂无简介";
  const localUpdatedAt = formatSkillUpdatedAt(skill.localUpdatedAt) || "未获取";
  const hasStoreRecord = Boolean(skill.remoteSkillId);
  const lastPublishedAt = formatPublishedAt(skill.lastPublishedAt) || "未获取";
  const storeVersion = skill.remoteVersion ? `v${skill.remoteVersion}` : "未获取";
  const hasPublishUpdates = Boolean(skill.remoteSkillId) && (skill.updateFileCount ?? 0) > 0;

  return (
    <div className={`skill-card__details publish-skill-row__details${isModal ? " skill-card-detail-modal__body" : ""}`}>
      <section>
        <div className="skill-card__section-header">
          <h4>基本信息</h4>
          {!isModal && hasPublishUpdates && onPreview ? (
            <PublishFilePreviewButton skill={skill} onClick={onPreview} showLabel />
          ) : null}
        </div>
        <dl className="detail-grid detail-grid--single"><div><dt>简介</dt><dd>{description}</dd></div></dl>
        <dl className="detail-grid detail-grid--source">
          <div><dt>来源类型</dt><dd>{sourceLabel}</dd></div>
          <div>
            <dt>来源</dt>
            <dd className="detail-grid__source-value">
              {isHttpUrl(sourceValue) ? (
                <a className="detail-grid__source-link detail-grid__single-line" data-tooltip={sourceValue} href={sourceValue} onClick={(event) => {
                  event.preventDefault();
                  void openExternalLink(sourceValue);
                }}>
                  {sourceValue}
                </a>
              ) : <span className="detail-grid__single-line" data-tooltip={sourceValue}>{sourceValue}</span>}
              {showGitBadge ? <span className="detail-git-badge is-linked">git</span> : null}
            </dd>
          </div>
        </dl>
        <dl className="tool-list-row__detail-grid">
          {hasStoreRecord ? (
            <>
              <div><dt>商店版本</dt><dd>{storeVersion}</dd></div>
              <div><dt>最后发布时间</dt><dd>{lastPublishedAt}</dd></div>
              {skill.marketUrl ? (
                <div>
                  <dt>商店地址</dt>
                  <dd>
                    <a className="detail-grid__source-link publish-skill-row__market-link" href={skill.marketUrl} onClick={(event) => {
                      event.preventDefault();
                      void openExternalLink(skill.marketUrl);
                    }}>
                      查看商店详情<OpenMarketIcon />
                    </a>
                  </dd>
                </div>
              ) : null}
            </>
          ) : null}
          <div><dt>本地更新时间</dt><dd>{localUpdatedAt}</dd></div>
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
  onOpenDirectory: () => void;
}) {
  const isGridLayout = props.layout === "grid";
  const sources = Array.from(new Set(props.group.candidates.map(formatUnmanagedSource)));
  const fileTypes = Array.from(new Set(props.group.candidates.map(formatUnmanagedFileType)));
  const canPreview = Boolean(props.group.candidates[0]?.toolId);
  return (
    <article className={`skill-card skill-card--list publish-skill-row unmanaged-skill-row${isGridLayout ? " skill-card--grid publish-skill-row--grid" : ""}`}>
      <div className="skill-card__header publish-skill-row__header">
        <div className="skill-card__summary-button publish-skill-row__summary-button">
          <div className="skill-card__identity">
            <PublishSkillMonogram name={props.group.name} />
            <div className="skill-card__title-stack">
              <div className="skill-card__title-row">
                <h3>{props.group.name}</h3>
                <span className="unmanaged-skill-row__type-badges">
                  {fileTypes.map((fileType) => <span key={fileType} className="status-badge tone-info">{fileType}</span>)}
                </span>
              </div>
              <p className="skill-card__summary-description">{props.group.description || "暂无简介"}</p>
              <div className="unmanaged-skill-row__sources" title={sources.join("、")}>
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
            aria-label={`导入并发布 ${props.group.name}`}
            data-tooltip="导入并发布"
          >
            <PublishActionIcon />
          </button>
          <button
            className="skill-card__icon-button"
            type="button"
            onClick={props.onPreview}
            disabled={!canPreview}
            aria-label={`预览 ${props.group.name}`}
            data-tooltip={canPreview ? "预览文件" : "暂不支持预览"}
          >
            <ViewFileIcon />
          </button>
          <button className="skill-card__icon-button" type="button" onClick={props.onOpenDirectory} aria-label={`打开目录 ${props.group.name}`} data-tooltip="打开目录">
            <OpenFolderIcon />
          </button>
        </div>
      </div>
    </article>
  );
}

function UnmanagedImportDialog(props: {
  group: UnmanagedSkillGroup;
  isImporting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onClick={props.onClose}>
      <div className="dialog-card publish-confirm-dialog unmanaged-import-dialog" role="dialog" aria-modal="true" aria-labelledby="unmanaged-import-dialog-title" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-card__header">
          <div>
            <h3 id="unmanaged-import-dialog-title">导入托管并发布 · {props.group.name}</h3>
            <p>导入后会纳入 SkillDock 管理，并发布到当前平台。</p>
          </div>
          <button className="skill-detail-modal__close" type="button" aria-label="关闭" onClick={props.onClose} disabled={props.isImporting}>×</button>
        </header>
        <div className="dialog-card__body">
          <div className="dialog-info-row publish-confirm-dialog__info-row"><span className="dialog-info-label">简介</span><span>{props.group.description || "暂无简介"}</span></div>
          <div className="dialog-info-row publish-confirm-dialog__info-row"><span className="dialog-info-label">发现来源</span><span>{Array.from(new Set(props.group.candidates.map(formatUnmanagedSource))).join("、")}</span></div>
        </div>
        <footer className="dialog-card__footer">
          <button className="secondary-button secondary-button--compact" type="button" onClick={props.onClose} disabled={props.isImporting}>取消</button>
          <button className="primary-button primary-button--compact publish-confirm-dialog__primary-button" type="button" onClick={props.onConfirm} disabled={props.isImporting}>
            {props.isImporting ? "正在导入并发布..." : "确认导入并发布"}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function PublishingWorkbench({ adapter, renderAuthentication }: PublishingWorkbenchProps) {
  const capabilities = useMemo(() => getPublishingAdapterCapabilities(adapter), [adapter]);
  const startupSnapshot = useMemo(() => adapter.readCachedSnapshot?.() ?? null, [adapter]);
  const [authState, setAuthState] = useState<PublishingAuthState | null>(null);
  const [skills, setSkills] = useState<PublishableSkill[]>(() => startupSnapshot?.skills ?? []);
  const [unmanagedSkills, setUnmanagedSkills] = useState<PublishingUnmanagedSkill[]>([]);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [activeTab, setActiveTab] = useState<PublishSkillTab>("managed");
  const [viewMode, setViewMode] = useState<ListGridViewMode>(readViewMode);
  const [statusFilter, setStatusFilter] = useState<PublishStatusFilter>("all");
  const [isRefreshing, setIsRefreshing] = useState(() => startupSnapshot === null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [statusSyncError, setStatusSyncError] = useState(() => startupSnapshot?.statusSyncError ?? "");
  const [selectedSkill, setSelectedSkill] = useState<PublishableSkill | null>(null);
  const [previewSkill, setPreviewSkill] = useState<PublishableSkill | null>(null);
  const [previewCandidate, setPreviewCandidate] = useState<PublishingUnmanagedSkill | null>(null);
  const [unmanagedImportGroup, setUnmanagedImportGroup] = useState<UnmanagedSkillGroup | null>(null);
  const [batchConfirm, setBatchConfirm] = useState<BatchConfirmState | null>(null);
  const [expandedSkillPath, setExpandedSkillPath] = useState("");
  const [toolbarContainer, setToolbarContainer] = useState<HTMLElement | null>(null);
  const [summaryContainer, setSummaryContainer] = useState<HTMLElement | null>(null);
  const [sourceContainer, setSourceContainer] = useState<HTMLElement | null>(null);
  const [orderRevision, setOrderRevision] = useState(0);

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
  const statusSortedSkills = useMemo(() => [...skills].sort(comparePublishableSkills), [skills]);
  const orderedSkills = useStableListOrder(statusSortedSkills, (skill) => skill.localPath, orderRevision);
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
      || group.candidates.some((candidate) => formatUnmanagedSource(candidate).toLowerCase().includes(deferredQuery))
  )), [deferredQuery, unmanagedGroups]);
  const visibleBatchIds = useMemo(() => filteredSkills
    .filter((skill) => BATCH_PUBLISHABLE_STATUSES.has(skill.publishStatus))
    .map((skill) => skill.localPath), [filteredSkills]);
  const batchSelection = useBatchSelection(visibleBatchIds);
  const selectedBatchSkills = useMemo(() => filteredSkills.filter((skill) => (
    batchSelection.selectedIds.has(skill.localPath)
  )), [batchSelection.selectedIds, filteredSkills]);
  const summary = activeTab === "managed"
    ? `${adapter.platform.label} · 可发布 ${counts.unpublished} · 已发布 ${counts.published} · 可更新 ${counts["update-available"]} · 发布中 ${counts.publishing}`
    : `${adapter.platform.label} · 待导入 ${unmanagedGroups.length}`;

  async function refreshAuth() {
    await refresh(true);
  }

  async function refresh(forceRefresh = false) {
    setIsRefreshing(true);
    setLoadError("");
    try {
      const nextAuthState = await adapter.getAuthState();
      setAuthState(nextAuthState);
      if (!nextAuthState.connected) {
        setSkills([]);
        setUnmanagedSkills([]);
        setStatusSyncError("");
        return;
      }
      const [snapshot, nextUnmanagedSkills] = await Promise.all([
        adapter.fetchSkills(forceRefresh),
        adapter.fetchUnmanagedSkills?.() ?? Promise.resolve([]),
      ]);
      if (snapshot.authorizationRequired) {
        setAuthState({
          connected: false,
          accountLabel: "",
          verifiedAt: "",
        });
        setSkills([]);
        setUnmanagedSkills([]);
        setStatusSyncError("");
        return;
      }
      const stableSkills = retainCachedUpdateStatus(skills, snapshot.skills);
      setSkills(stableSkills);
      setUnmanagedSkills(nextUnmanagedSkills);
      setStatusSyncError(snapshot.statusSyncError ?? "");
      adapter.writeCachedSnapshot?.({ ...snapshot, skills: stableSkills });
      setOrderRevision((current) => current + 1);
      if (adapter.reconcileSkills) {
        void adapter.reconcileSkills(forceRefresh).then((reconciledSnapshot) => {
          if (reconciledSnapshot.authorizationRequired) {
            return;
          }
          setSkills(reconciledSnapshot.skills);
          setStatusSyncError(reconciledSnapshot.statusSyncError ?? "");
          adapter.writeCachedSnapshot?.(reconciledSnapshot);
          setOrderRevision((current) => current + 1);
        }).catch((error) => {
          setStatusSyncError(formatError(error));
        });
      }
    } catch (error) {
      setLoadError(formatError(error));
    } finally {
      setIsRefreshing(false);
    }
  }

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
      await refresh(true);
    } catch (error) {
      setLoadError(formatError(error));
    } finally {
      setIsPublishing(false);
    }
  }

  async function publishSkill(skill: PublishableSkill, changelog?: string) {
    setSkills((current) => replaceSkill(current, { ...skill, publishStatus: "publishing", failureReason: "" }));
    try {
      const publishedSkill = await adapter.publishSkill({
        skillName: skill.name,
        remoteSkillId: skill.remoteSkillId,
        expectedRemoteVersion: skill.remoteVersion || undefined,
        changelog,
      });
      setSkills((current) => replaceSkill(current, publishedSkill));
    } catch (error) {
      const failedSkill = { ...skill, publishStatus: "failed" as const, failureReason: formatError(error) };
      setSkills((current) => replaceSkill(current, failedSkill));
      throw error;
    }
  }

  async function handlePublish(changelog: string) {
    if (!selectedSkill) {
      return;
    }
    setIsPublishing(true);
    setLoadError("");
    try {
      await publishSkill(selectedSkill, changelog);
      setSelectedSkill(null);
    } catch (error) {
      setLoadError(formatError(error));
    } finally {
      setIsPublishing(false);
    }
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
    setIsPublishing(false);
    setBatchConfirm(null);
    batchSelection.exitSelection();
  }

  useEffect(() => {
    setToolbarContainer(document.getElementById("publish-header-toolbar-slot"));
    setSummaryContainer(document.getElementById("publish-header-summary-slot"));
    setSourceContainer(document.getElementById("publish-source-header-slot"));
    void refresh();
  }, [adapter]);

  useEffect(() => {
    const hasPendingStatus = skills.some((skill) => (
      skill.publishStatus === "publishing" || skill.publishStatus === "reviewing"
    ));
    if (!hasPendingStatus) {
      return;
    }
    const timer = window.setInterval(() => void refresh(), PUBLISH_STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [skills]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    let refreshTimer: number | null = null;
    void subscribeSkillLibraryChanges(({ skillName }) => {
      if (!active || !skills.some((skill) => skill.name === skillName)) {
        return;
      }
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refresh(true);
      }, SKILL_LIBRARY_CHANGE_DEBOUNCE_MS);
    }).then((stop) => {
      if (active) {
        unlisten = stop;
      } else {
        stop();
      }
    });
    return () => {
      active = false;
      unlisten?.();
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
    };
  }, [adapter, skills]);

  const toolbar = (
    <PublishToolbar
      query={query}
      viewMode={viewMode}
      activeTab={activeTab}
      statusFilter={statusFilter}
      counts={counts}
      isRefreshing={isRefreshing}
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
      onRefresh={() => void refresh(true)}
    />
  );

  if (authState && !authState.connected) {
    return renderAuthentication ? (
      <>{renderAuthentication(refreshAuth)}</>
    ) : (
      <div className="panel-card empty-state">
        <h3>连接 {adapter.platform.label}</h3>
        <p>连接发布平台后即可查看和发布 Skill。</p>
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
            label: `发布 ${selectedBatchSkills.length} 个`,
            tone: "accent",
            onClick: () => setBatchConfirm({ skills: selectedBatchSkills }),
          }] : []}
          ariaLabel="批量操作"
          cancelLabel="取消"
          deselectAllLabel="取消全选"
          hint="选择要发布的 Skill"
          isAllVisibleSelected={batchSelection.isAllVisibleSelected}
          isBusy={isPublishing}
          selectedLabel={selectedBatchSkills.length > 0 ? `已选择 ${selectedBatchSkills.length} 个` : ""}
          selectAllDisabled={visibleBatchIds.length === 0}
          selectAllLabel="全选"
          onCancel={batchSelection.exitSelection}
          onToggleSelectAll={batchSelection.toggleSelectAll}
        />
      ) : null}
      {loadError ? (
        <div className="panel-card publish-page__error">
          <strong>发布状态加载失败</strong><p>{loadError}</p>
          <button className="secondary-button" type="button" onClick={() => void refresh(true)}>重试</button>
        </div>
      ) : null}
      {!loadError && statusSyncError ? (
        <div className="panel-card publish-page__error">
          <strong>远端发布状态暂未同步</strong><p>{statusSyncError}</p>
          <button className="secondary-button" type="button" onClick={() => void refresh(true)}>重试</button>
        </div>
      ) : null}
      {!loadError && !isRefreshing && activeTab === "managed" && filteredSkills.length === 0 ? (
        <div className="panel-card empty-state">
          <h3>{skills.length === 0 ? "还没有可发布的 Skill" : "没有符合条件的 Skill"}</h3>
          <p>{skills.length === 0 ? "请先在 Skills 页面创建或托管本地 Skill。" : "试试调整搜索内容或状态筛选。"}</p>
        </div>
      ) : null}
      {!loadError && !isRefreshing && activeTab === "unmanaged" && filteredUnmanagedGroups.length === 0 ? (
        <div className="panel-card empty-state">
          <h3>{unmanagedGroups.length === 0 ? "没有未托管的 Skill" : "没有符合条件的 Skill"}</h3>
          <p>{unmanagedGroups.length === 0 ? "当前支持的工具目录中没有发现新的本地 Skill。" : "试试调整搜索内容。"}</p>
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
              onOpenDirectory={() => {
                const path = group.candidates[0]?.resolvedPath || group.candidates[0]?.localPath;
                if (path) {
                  void openPathInFinder({ path });
                }
              }}
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
          onLocalChangesChanged={() => void refresh(true)}
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

function getPublishButtonLabel(status: PublishStatus) {
  if (status === "unpublished") {
    return "发布";
  }
  if (status === "update-available") {
    return "发布更新";
  }
  if (status === "failed") {
    return "重试";
  }
  if (status === "reviewing") {
    return "查看审核";
  }
  if (status === "published") {
    return "查看市场";
  }
  return "发布中";
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
