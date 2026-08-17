import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { alignExpandedRowIntoView } from "@/app/utils/align-expanded-row";
import { useTranslate } from "@/app/i18n";
import { useNotifications } from "@/app/notifications";
import { useFailureReporter } from "@/app/failure-feedback";
import { formatPathForDisplay } from "@/app/path-utils";
import { waitForNextPaint } from "@/app/utils/wait-for-next-paint";
import { BatchSelectionMark } from "@/app/components/BatchActions";
import { PowerToggleIcon } from "@/features/skills/components/PowerToggleIcon";
import {
  LocalChangesIcon,
  UpdatePreviewDetailIcon,
} from "@/features/skills/components/GitPreviewIcons";
import { SkillStatusBadge } from "@/features/skills/components/SkillStatusBadge";
import { SkillFileDialog, type SkillFilePanelMode } from "@/features/skills/components/SkillFileDialog";
import { ToolSyncPanel } from "@/features/skills/components/ToolSyncPanel";
import { openExternalLink } from "@/features/skills/api/skill-client";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type { SkillSummary } from "@/features/skills/state/skill-store";
import { formatSkillDescription } from "@/features/skills/utils/skill-description";
import { resolveSkillTagTone } from "@/features/skills/utils/skill-tag-color";
import { formatSkillLastEditor } from "@/features/skills/utils/skill-editor";
import { setSkillAllToolsEnabled } from "@/features/skills/utils/skill-bulk-status";
import { mergeSkillToolsWithInstalledTools } from "@/features/skills/utils/skill-tools";
import { formatSkillUpdatedAt } from "@/features/skills/utils/skill-time";
import { getToolDisplayRank, resolveToolLogoUrl } from "@/features/skills/utils/tool-logo";
import { isToolEnabledStatus } from "@/features/skills/utils/tool-status";
import { getMonogramLabel } from "@/features/skills/utils/monogram";

type SkillCardProps = {
  skill: SkillSummary;
  layout?: "list" | "grid";
  expanded?: boolean;
  autoAlignWhenExpanded?: boolean;
  onExpandedChange?: (expanded: boolean, rowElement?: HTMLElement | null) => void;
  selectionMode?: boolean;
  selected?: boolean;
  onSelectionToggle?: () => void;
};

const GRID_SUMMARY_TOOL_LIMIT = 6;
const MAX_SKILL_TAG_LENGTH = 20;
const TAG_EDITOR_FALLBACK_WIDTH = 248;
const TAG_EDITOR_FALLBACK_HEIGHT = 48;
const TAG_EDITOR_VIEWPORT_PADDING = 8;
const TAG_EDITOR_GAP = 6;

function SkillMonogram({ name }: { name: string }) {
  return (
    <div className="link-badge link-badge--monogram" aria-hidden="true">
      <span className="link-badge__type-mark link-badge__type-mark--skill">
        <svg viewBox="0 0 12 12" fill="none">
          <path
            d="M6 1.5 7.1 4.9 10.5 6 7.1 7.1 6 10.5 4.9 7.1 1.5 6 4.9 4.9 6 1.5Z"
            fill="currentColor"
          />
        </svg>
      </span>
      <span className="link-badge__label">{getMonogramLabel(name)}</span>
    </div>
  );
}

function SummaryToolIcon({ toolName }: { toolName: string }) {
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const logoUrl = resolveToolLogoUrl(toolName);
  const fallbackLabel = getMonogramLabel(toolName);

  return (
    <span className="skill-card__tool-icon" title={toolName} aria-hidden="true">
      {logoUrl && !logoLoadFailed ? (
        <img
          src={logoUrl}
          alt=""
          loading="lazy"
          onError={() => setLogoLoadFailed(true)}
        />
      ) : (
        <span>{fallbackLabel}</span>
      )}
    </span>
  );
}

function compareToolsByDisplayOrder(left: { name: string }, right: { name: string }) {
  const rankDelta = getToolDisplayRank(left.name) - getToolDisplayRank(right.name);
  if (rankDelta !== 0) {
    return rankDelta;
  }

  return left.name.localeCompare(right.name);
}

function formatSummaryDescription(description: string, emptyDescriptionLabel: string) {
  const normalizedDescription = formatSkillDescription(description).replace(/\s+/g, " ");
  return normalizedDescription || emptyDescriptionLabel;
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function ViewFileIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M6 2.75h5.25L15.5 7v10.25H6A1.25 1.25 0 0 1 4.75 16V4A1.25 1.25 0 0 1 6 2.75Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M11.25 2.75V7H15.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M7.75 10h4.5M7.75 13h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function OpenFolderIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3.75 6.5A1.75 1.75 0 0 1 5.5 4.75h3l1.25 1.5h4.75a1.75 1.75 0 0 1 1.75 1.75v5.5a1.75 1.75 0 0 1-1.75 1.75h-9A1.75 1.75 0 0 1 3.75 13.5v-7Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="m8.25 11.75 3.5-3.5M9.25 8.25h2.5v2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3.5 6.6c0-.97.78-1.75 1.75-1.75h3.18c.52 0 1.01.23 1.34.63l.67.8h4.31c.97 0 1.75.78 1.75 1.75v5.37c0 .97-.78 1.75-1.75 1.75h-9.5c-.97 0-1.75-.78-1.75-1.75V6.6Z"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinejoin="round"
      />
      <path d="M3.75 8.1h12.5" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}

function SkillFilePreviewButton(props: {
  skill: SkillSummary;
  mode: SkillFilePanelMode;
  onClick: () => void;
  showLabel?: boolean;
}) {
  const { t } = useTranslate();
  const localChangeCount = props.skill.localChangeCount ?? 0;
  const showsLocalChanges = props.mode === "changes";
  const showsUpdateContents = props.mode === "updates";
  const ariaLabelKey = showsLocalChanges
    ? "skill.card.aria.viewFilesWithChanges"
    : showsUpdateContents
      ? "skill.card.aria.viewUpdateContents"
      : "skill.card.aria.viewFiles";
  const tooltipKey = showsLocalChanges
    ? "skill.card.tooltip.viewFilesWithChanges"
    : showsUpdateContents
      ? "skill.card.tooltip.viewUpdateContents"
      : "skill.card.tooltip.viewFiles";
  const actionLabelKey = showsLocalChanges
    ? "skill.card.action.viewChanges"
    : showsUpdateContents
      ? "skill.card.action.viewUpdateContents"
      : "skill.card.action.viewFiles";
  const className = [
    props.showLabel
      ? "secondary-button secondary-button--compact skill-card-detail-modal__action"
      : "skill-card__icon-button",
    "skill-card__file-preview-button",
  ].filter(Boolean).join(" ");

  return (
    <button
      className={className}
      type="button"
      onClick={props.onClick}
      aria-label={t(ariaLabelKey, { name: props.skill.name })}
      data-tooltip={t(tooltipKey)}
    >
      {showsUpdateContents && props.showLabel
        ? <UpdatePreviewDetailIcon />
        : showsLocalChanges && props.showLabel
          ? <LocalChangesIcon />
          : <ViewFileIcon />}
      {props.showLabel ? (
        <span>{t(actionLabelKey)}</span>
      ) : null}
      {showsLocalChanges ? (
        <span className="skill-card__change-count" aria-hidden="true">{localChangeCount}</span>
      ) : null}
    </button>
  );
}

function RefreshIcon({ isSpinning = false }: { isSpinning?: boolean }) {
  return (
    <svg className={isSpinning ? "skill-card__refresh-icon is-spinning" : "skill-card__refresh-icon"} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M15.2 6.6A6.25 6.25 0 1 0 16 10"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15.3 4.2v2.8h-2.8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M4.75 5.75h10.5M7.25 5.75V4.5c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1v1.25m-6.25 0 .45 8.25c.03.61.54 1.08 1.15 1.08h3.8c.61 0 1.12-.47 1.15-1.08l.45-8.25M8.5 8.75v4.25m3 0V8.75"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SkillCard({
  skill,
  layout = "list",
  expanded: expandedProp,
  autoAlignWhenExpanded = false,
  onExpandedChange,
  selectionMode = false,
  selected = false,
  onSelectionToggle = () => undefined,
}: SkillCardProps) {
  const { language, t } = useTranslate();
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const {
    appSettings,
    deleteSkill,
    installedSkills,
    openPathInFinder,
    openSkillWithDefaultTool,
    setSkillAllToolStatuses,
    setSkillTag,
    setToolSkillStatuses,
    toolConfigs,
    updateSkill,
  } = useSkillWorkspace();
  const [expandedState, setExpandedState] = useState(false);
  const [showFileDialog, setShowFileDialog] = useState(false);
  const [fileDialogInitialMode, setFileDialogInitialMode] = useState<SkillFilePanelMode>("files");
  const [isDeleteConfirming, setIsDeleteConfirming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [isSavingTag, setIsSavingTag] = useState(false);
  const [showTagEditor, setShowTagEditor] = useState(false);
  const [tagDraft, setTagDraft] = useState(skill.tag ?? "");
  const [tagEditorPosition, setTagEditorPosition] = useState({ top: 0, left: 0 });
  const [showEnabledTools, setShowEnabledTools] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const deleteActionRef = useRef<HTMLButtonElement | null>(null);
  const tagActionRef = useRef<HTMLButtonElement | null>(null);
  const detailTagActionRef = useRef<HTMLButtonElement | null>(null);
  const activeTagActionRef = useRef<HTMLButtonElement | null>(null);
  const tagEditorRef = useRef<HTMLDivElement | null>(null);
  const existingTags = useMemo(() => {
    const tagsByNormalizedValue = new Map<string, string>();
    (installedSkills ?? []).forEach((installedSkill) => {
      const tag = installedSkill.tag?.trim();
      if (tag) {
        tagsByNormalizedValue.set(tag.toLocaleLowerCase(), tag);
      }
    });
    return [...tagsByNormalizedValue.values()].sort((left, right) => left.localeCompare(right));
  }, [installedSkills]);
  const normalizedTagDraft = tagDraft.trim().toLocaleLowerCase();
  const matchingExistingTags = existingTags.filter((tag) => (
    !normalizedTagDraft || tag.toLocaleLowerCase().includes(normalizedTagDraft)
  ));
  const exactExistingTag = existingTags.find((tag) => tag.toLocaleLowerCase() === normalizedTagDraft);
  const skillTools = mergeSkillToolsWithInstalledTools(skill.tools, toolConfigs)
    .sort(compareToolsByDisplayOrder);
  const skillDescription = formatSkillDescription(skill.description) || t("skills.description.empty");
  const summaryDescription = formatSummaryDescription(skill.description, t("skills.description.empty"));
  const remoteUpdatedAt = formatSkillUpdatedAt(skill.remoteUpdatedAt);
  const localUpdatedAt = formatSkillUpdatedAt(skill.localUpdatedAt);
  const remoteUpdater = formatSkillLastEditor(skill.lastEditor) || t("skill.card.remoteUpdaterUnknown");
  const enabledTools = skillTools
    .filter((tool) => isToolEnabledStatus(tool.statusLabel));
  const totalToolCount = skillTools.length;
  const allToolsEnabled = totalToolCount > 0 && enabledTools.length === totalToolCount;
  const hasPartiallyEnabledTools = enabledTools.length > 0 && !allToolsEnabled;
  const gridSummaryTools = enabledTools.slice(0, GRID_SUMMARY_TOOL_LIMIT);
  const gridSummaryToolExtraCount = enabledTools.length - gridSummaryTools.length;
  const summaryToolsLabel = enabledTools.length > 0
    ? t("skill.card.enabledTools", { tools: enabledTools.map((tool) => tool.name).join("、") })
    : t("skill.card.enabledToolsNone");
  const enabledToolsCountLabel = enabledTools.length > 0
    ? t("skill.card.enabledCount", { count: enabledTools.length })
    : t("skill.card.disabled");
  const managementOwnerLabel = skill.managementOwner === "agent-skills-cli"
    ? t("skill.card.owner.agentSkillsCli")
    : skill.managementOwner === "external"
      ? t("skill.card.owner.external")
      : t("skill.card.owner.skilldock");
  const sourceMethodLabel = skill.sourceType === "well-known"
    ? t("skill.card.sourceMethod.remote")
    : skill.sourceType === "marketplace"
      ? t("skill.card.sourceMethod.remote")
    : skill.gitLinked || skill.sourceType !== "local"
      ? t("skill.card.sourceMethod.git")
      : t("skill.card.sourceMethod.local");
  const managedPath = skill.canonicalPath ?? skill.localPath;
  const managedPathLabel = formatPathForDisplay(managedPath);
  const gridSourceSummary = `${sourceMethodLabel} · ${managementOwnerLabel}`;
  const showDetailAction = skill.collabStatus === "update-available";
  const canPreviewUpdates = showDetailAction
    && (skill.gitLinked
      || skill.updateDriver === "agent-skills-cli"
      || skill.updateDriver === "clawhub"
      || skill.sourceType === "marketplace");
  const previewMode: SkillFilePanelMode = (skill.localChangeCount ?? 0) > 0
    ? "changes"
    : canPreviewUpdates
      ? "updates"
      : "files";
  const showRemoteMetadata = skill.sourceType === "marketplace"
    || (skill.gitLinked && skill.sourceType !== "local");
  const expanded = expandedProp ?? expandedState;
  const isGridLayout = layout === "grid";

  function updateTagEditorPosition() {
    const trigger = activeTagActionRef.current ?? tagActionRef.current;
    if (!trigger) {
      return;
    }

    const editorWidth = tagEditorRef.current?.offsetWidth ?? TAG_EDITOR_FALLBACK_WIDTH;
    const editorHeight = tagEditorRef.current?.offsetHeight ?? TAG_EDITOR_FALLBACK_HEIGHT;
    const rect = trigger.getBoundingClientRect();
    const left = Math.min(
      Math.max(rect.left, TAG_EDITOR_VIEWPORT_PADDING),
      window.innerWidth - editorWidth - TAG_EDITOR_VIEWPORT_PADDING,
    );
    const top = rect.bottom + TAG_EDITOR_GAP + editorHeight <= window.innerHeight - TAG_EDITOR_VIEWPORT_PADDING
      ? rect.bottom + TAG_EDITOR_GAP
      : Math.max(TAG_EDITOR_VIEWPORT_PADDING, rect.top - editorHeight - TAG_EDITOR_GAP);
    setTagEditorPosition({ top, left });
  }

  function handleTagActionClick(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    activeTagActionRef.current = event.currentTarget;
    setTagDraft(skill.tag ?? "");
    updateTagEditorPosition();
    setShowTagEditor(true);
  }

  async function saveTag(nextTag: string) {
    if (isSavingTag) {
      return;
    }

    setIsSavingTag(true);
    try {
      await setSkillTag({
        skillName: skill.name,
        skillPath: skill.canonicalPath ?? skill.localPath,
        tag: nextTag,
      });
      setShowTagEditor(false);
    } catch (error) {
      reportFailure(error, {
        operation: "set_skill_tag",
        fallbackMessage: t("skill.card.tag.error"),
      });
    } finally {
      setIsSavingTag(false);
    }
  }

  function handleTagSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTag = tagDraft.trim();
    if (normalizedTag) {
      void saveTag(exactExistingTag ?? normalizedTag);
    }
  }

  function handleSummaryClick() {
    if (selectionMode) {
      onSelectionToggle();
      return;
    }
    void handleExpandedChange(!expanded);
  }

  function handleSummaryKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!selectionMode || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    event.preventDefault();
    onSelectionToggle();
  }

  useLayoutEffect(() => {
    if (!showTagEditor) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !activeTagActionRef.current?.contains(target)
        && !tagEditorRef.current?.contains(target)
      ) {
        setShowTagEditor(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowTagEditor(false);
        activeTagActionRef.current?.focus();
      }
    }

    updateTagEditorPosition();
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updateTagEditorPosition);
    window.addEventListener("scroll", updateTagEditorPosition, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updateTagEditorPosition);
      window.removeEventListener("scroll", updateTagEditorPosition, true);
    };
  }, [showTagEditor]);

  useEffect(() => {
    if (autoAlignWhenExpanded && expanded) {
      void alignExpandedRowIntoView(cardRef.current);
    }
  }, [autoAlignWhenExpanded, expanded]);

  useEffect(() => {
    if (!isDeleteConfirming) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (deleteActionRef.current?.contains(event.target as Node)) {
        return;
      }
      setIsDeleteConfirming(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsDeleteConfirming(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDeleteConfirming]);

  async function handlePrimaryAction() {
    if (isUpdating) {
      return;
    }

    if (skill.collabStatus === "pending-push") {
      await handleOpenSkill();
      return;
    }

    if (skill.collabStatus === "update-available") {
      setIsUpdating(true);
      try {
        await updateSkill(skill.name, skill.canonicalPath ?? skill.localPath);
      } catch (error) {
        reportFailure(error, {
          operation: "update_skill",
          fallbackMessage: t("skill.card.error.update"),
          context: { skillName: skill.name },
        });
      } finally {
        setIsUpdating(false);
      }
    }
  }

  async function handleDeleteAction() {
    if (isDeleting) {
      return;
    }

    if (!isDeleteConfirming) {
      setIsDeleteConfirming(true);
      return;
    }

    setIsDeleteConfirming(false);
    setIsDeleting(true);
    try {
      await deleteSkill(skill.name, skill.canonicalPath ?? skill.localPath);
      notify({ tone: "success", message: t("skill.card.success.deleted", { name: skill.name }) });
    } catch (error) {
      reportFailure(error, {
        operation: "delete_skill",
        fallbackMessage: t("skill.card.error.delete"),
        context: { skillName: skill.name },
      });
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleOpenSkill() {
    try {
      await openSkillWithDefaultTool(skill.name, skill.canonicalPath ?? skill.localPath);
    } catch (error) {
      reportFailure(error, {
        operation: "open_skill_with_default_tool",
        fallbackMessage: t("skill.card.error.openFolder"),
        context: { skillName: skill.name },
      });
    }
  }

  async function handleOpenManagedFolder() {
    try {
      await openPathInFinder(managedPath);
    } catch (error) {
      reportFailure(error, {
        operation: "open_managed_skill_folder",
        fallbackMessage: t("skills.source.error.openFolder"),
        context: { skillName: skill.name, managedPath },
      });
    }
  }

  function handleOpenFileDialog(mode: SkillFilePanelMode) {
    setFileDialogInitialMode(mode);
    setShowFileDialog(true);
  }

  function handleOpenFiles() {
    handleOpenFileDialog(previewMode);
  }

  async function handleToggleAllSkillTools() {
    if (isBulkUpdating || totalToolCount === 0) {
      return;
    }

    const enabled = !allToolsEnabled;
    const toolNames = skillTools.map((tool) => tool.name);
    setIsBulkUpdating(true);
    try {
      await waitForNextPaint();
      const failedToolNames = await setSkillAllToolsEnabled({
        skillName: skill.name,
        skillPath: skill.canonicalPath ?? skill.localPath,
        enabled,
        toolNames,
        setSkillAllToolStatuses,
        setToolSkillStatuses,
      });
      if (failedToolNames.length > 0) {
        reportFailure(new Error(t("skill.tools.bulkResult", {
          action: t(enabled ? "skill.tools.action.enable" : "skill.tools.action.disable"),
          success: toolNames.length - failedToolNames.length,
          failed: failedToolNames.length,
          names: failedToolNames.join("、"),
        })), {
          operation: "toggle_all_skill_tools_from_card",
          fallbackMessage: t("skill.tools.error.toggle"),
          context: { skillName: skill.name, enabled, failedToolNames },
        });
      }
    } catch (error) {
      reportFailure(error, {
        operation: "toggle_all_skill_tools_from_card",
        fallbackMessage: t("skill.tools.error.toggle"),
        context: { skillName: skill.name, enabled },
      });
    } finally {
      setIsBulkUpdating(false);
    }
  }

  function handleEnabledToolsToggle(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (enabledTools.length === 0) {
      return;
    }

    setShowEnabledTools((value) => !value);
  }

  async function handleExpandedChange(nextExpanded: boolean) {
    const shouldAlignExpandedCard = nextExpanded && !expanded && !isGridLayout;
    if (expandedProp === undefined) {
      setExpandedState(nextExpanded);
    }
    onExpandedChange?.(nextExpanded, cardRef.current);
    if (shouldAlignExpandedCard && !autoAlignWhenExpanded) {
      await alignExpandedRowIntoView(cardRef.current);
    }
  }

  useEffect(() => {
    if (!isGridLayout || !expanded) {
      return;
    }

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !showFileDialog) {
        void handleExpandedChange(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [expanded, isGridLayout, showFileDialog]);

  const updateTooltipLabel = isUpdating ? t("skill.card.tooltip.updating") : t("skill.card.tooltip.update");
  const bulkToggleTooltipLabel = isBulkUpdating
    ? t("skill.card.bulkToggle.updating", { name: skill.name })
    : allToolsEnabled
      ? t("skill.card.bulkToggle.disable", { name: skill.name })
      : hasPartiallyEnabledTools
        ? t("skill.card.bulkToggle.partial", { enabled: enabledTools.length, total: totalToolCount })
        : t("skill.card.bulkToggle.enable", { name: skill.name });
  const bulkToggleStateClassName = allToolsEnabled
    ? "is-enabled"
    : hasPartiallyEnabledTools
      ? "is-partial"
      : "is-disabled";
  const deleteConfirmTooltipLabel = isDeleting ? t("skill.card.tooltip.deleting") : t("skill.card.tooltip.deleteConfirm");
  const deleteAction = isDeleteConfirming || isDeleting ? (
    <button
      ref={deleteActionRef}
      className="skill-card__delete-confirm-button"
      type="button"
      onClick={() => void handleDeleteAction()}
      aria-label={t("skill.card.aria.deleteConfirm", {
        state: isDeleting ? t("skill.card.deleteLoading") : t("skill.card.deleteConfirm"),
        name: skill.name,
      })}
      data-tooltip={deleteConfirmTooltipLabel}
      disabled={isDeleting}
    >
      {isDeleting ? t("skill.card.deleteLoading") : t("skill.card.deleteConfirm")}
    </button>
  ) : (
    <button
      ref={deleteActionRef}
      className="skill-card__icon-button skill-card__icon-button--delete"
      type="button"
      onClick={() => void handleDeleteAction()}
      aria-label={t("skill.card.aria.delete", { name: skill.name })}
      data-tooltip={t("skill.card.tooltip.delete")}
    >
      <DeleteIcon />
    </button>
  );

  const skillDetailSections = (
    <>
      <section>
        <div className="skill-card__section-header">
          <h4>{t("skill.card.basicInfo")}</h4>
          {!isGridLayout && previewMode !== "files" ? (
            <SkillFilePreviewButton skill={skill} mode={previewMode} onClick={handleOpenFiles} showLabel />
          ) : null}
        </div>
        <dl className="detail-grid detail-grid--single">
          <div>
            <dt>{t("skill.card.description")}</dt>
            <dd>{skillDescription}</dd>
          </div>
        </dl>
        <dl className="detail-grid detail-grid--source">
          <div>
            <dt>{t("skill.card.sourceType")}</dt>
            <dd>{sourceMethodLabel}</dd>
          </div>
          {skill.sourceUrl ? (
            <div>
              <dt>{t("skill.card.sourceAddress")}</dt>
              <dd className="detail-grid__source-value">
                {isHttpUrl(skill.sourceUrl) ? (
                  <a
                    className="detail-grid__source-link detail-grid__single-line"
                    data-tooltip={skill.sourceUrl}
                    href={skill.sourceUrl}
                    onClick={(event) => {
                      event.preventDefault();
                      void openExternalLink(skill.sourceUrl);
                    }}
                  >
                    {skill.sourceUrl}
                  </a>
                ) : (
                  <span className="detail-grid__single-line" data-tooltip={skill.sourceUrl}>
                    {skill.sourceUrl}
                  </span>
                )}
              </dd>
            </div>
          ) : null}
          <div className={skill.sourceUrl ? undefined : "detail-grid__new-row"}>
            <dt>{t("skill.card.owner")}</dt>
            <dd>{managementOwnerLabel}</dd>
          </div>
          <div>
            <dt>{t("skill.card.managedPath")}</dt>
            <dd className="skill-source-card__directory-value">
              <span
                className="skill-source-card__directory-path detail-grid__single-line"
                data-tooltip={managedPathLabel}
              >
                {managedPathLabel}
              </span>
              <button
                className="skill-card__icon-button skill-source-card__directory-open-button"
                type="button"
                onClick={() => void handleOpenManagedFolder()}
                aria-label={t("skills.source.openPath", { path: managedPathLabel })}
                data-tooltip={t("skills.source.openFolder")}
              >
                <FolderIcon />
              </button>
            </dd>
          </div>
        </dl>
        <dl className="tool-list-row__detail-grid">
          {showRemoteMetadata ? (
            <>
              <div>
                <dt>{t("skill.card.remoteUpdatedAt")}</dt>
                <dd>{remoteUpdatedAt || t("skill.card.notFetched")}</dd>
              </div>
              <div>
                <dt>{t("skill.card.lastEditor")}</dt>
                <dd>{remoteUpdater}</dd>
              </div>
            </>
          ) : null}
          <div>
            <dt>{t("skill.card.localUpdatedAt")}</dt>
            <dd>{localUpdatedAt || t("skill.card.notFetched")}</dd>
          </div>
        </dl>
      </section>
      <ToolSyncPanel
        skillName={skill.name}
        skillPath={skill.canonicalPath ?? skill.localPath}
        tools={skillTools}
        isBulkUpdatingExternally={isBulkUpdating}
        onBulkUpdatingChange={setIsBulkUpdating}
      />
    </>
  );
  function renderTagAction(
    buttonRef: { current: HTMLButtonElement | null },
    className = "",
  ) {
    const normalizedTag = skill.tag?.trim() ?? "";
    const tagToneClass = normalizedTag
      ? ` tag-tone-${resolveSkillTagTone(normalizedTag)}`
      : "";
    return !selectionMode ? (
      <button
        ref={buttonRef}
        className={`skill-card__tag${normalizedTag ? " has-tag" : ""}${tagToneClass}${showTagEditor ? " is-editor-open" : ""}${className ? ` ${className}` : ""}`}
        type="button"
        aria-label={t(
          skill.tag?.trim() ? "skill.card.tag.edit" : "skill.card.tag.add",
          { tag: skill.tag ?? "" },
        )}
        aria-expanded={showTagEditor}
        onClick={handleTagActionClick}
      >
        {normalizedTag || t("skill.card.tag.addShort")}
      </button>
    ) : null;
  }

  const tagAction = renderTagAction(tagActionRef);

  return (
    <>
      <article
        ref={cardRef}
        className={`skill-card skill-card--${layout}${expanded ? " is-expanded" : ""}${selectionMode ? " is-selecting" : ""}${selected ? " is-selected" : ""}`}
        aria-label={skill.name}
      >
        <div className="skill-card__header">
          <div
            className="skill-card__summary-button"
            role={selectionMode ? "checkbox" : undefined}
            tabIndex={selectionMode ? 0 : undefined}
            aria-checked={selectionMode ? selected : undefined}
            aria-label={selectionMode ? t("batch.item.skill", { name: skill.name }) : undefined}
            onClick={handleSummaryClick}
            onKeyDown={handleSummaryKeyDown}
          >
            <div className="skill-card__summary-content">
              <div className="skill-card__summary-top">
                {isGridLayout ? (
                  <div className="skill-card__grid-status">
                    <SkillStatusBadge status={skill.collabStatus} />
                  </div>
                ) : null}
                <div className="skill-card__identity">
                  {selectionMode ? <BatchSelectionMark checked={selected} /> : null}
                  <SkillMonogram name={skill.name} />
                  <div className="skill-card__title-stack">
                    <div className="skill-card__title-row">
                      <h3>{skill.name}</h3>
                      {!isGridLayout ? (
                        <>
                          <span className="status-badge tone-neutral skill-card__owner-badge">
                            {managementOwnerLabel}
                          </span>
                          <button
                            className={`status-badge tone-info skill-card__enabled-toggle${enabledTools.length > 0 ? "" : " is-empty"}`}
                            type="button"
                            onClick={handleEnabledToolsToggle}
                            aria-expanded={showEnabledTools}
                            aria-label={summaryToolsLabel}
                            disabled={enabledTools.length === 0}
                          >
                            {enabledToolsCountLabel}
                          </button>
                          {tagAction}
                          {showEnabledTools && enabledTools.length > 0 ? (
                            <div className="skill-card__summary-tools" aria-label={summaryToolsLabel}>
                              {enabledTools.map((tool) => (
                                <SummaryToolIcon key={tool.name} toolName={tool.name} />
                              ))}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                    <p className="skill-card__summary-description">{summaryDescription}</p>
                    {isGridLayout && !selectionMode ? (
                      <div className="skill-card__tag-slot">{tagAction}</div>
                    ) : null}
                    {isGridLayout ? (
                      <div className="skill-card__grid-meta">
                        <span className={`status-badge skill-card__grid-enabled-badge ${enabledTools.length > 0 ? "tone-info" : "tone-neutral"}`}>
                          {enabledToolsCountLabel}
                        </span>
                        <div className="skill-card__summary-tools" aria-label={summaryToolsLabel}>
                          {gridSummaryTools.map((tool) => (
                            <SummaryToolIcon key={tool.name} toolName={tool.name} />
                          ))}
                          {gridSummaryToolExtraCount > 0 ? (
                            <span className="skill-card__tool-tag skill-card__tool-tag--extra">
                              +{gridSummaryToolExtraCount}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="skill-card__list-actions">
            {!selectionMode ? (
              <>
            {isGridLayout ? (
              <span className="skill-card__grid-source-label">
                <span className="skill-card__grid-source-text">{gridSourceSummary}</span>
              </span>
            ) : null}
            {!isGridLayout ? <SkillStatusBadge status={skill.collabStatus} /> : null}
            {showDetailAction ? (
              <button
                className="skill-card__icon-button skill-card__icon-button--update"
                type="button"
                onClick={() => void handlePrimaryAction()}
                aria-label={t("skill.card.aria.update", { name: skill.name })}
                data-tooltip={updateTooltipLabel}
                disabled={isUpdating}
              >
                <RefreshIcon isSpinning={isUpdating} />
              </button>
            ) : null}
            <button
              className={`skill-card__icon-button plugins-page__toggle-icon-button ${bulkToggleStateClassName}`}
              type="button"
              onClick={() => void handleToggleAllSkillTools()}
              aria-label={bulkToggleTooltipLabel}
              data-tooltip={bulkToggleTooltipLabel}
              disabled={isBulkUpdating || totalToolCount === 0 || isDeleting}
            >
              <PowerToggleIcon isSpinning={isBulkUpdating} />
            </button>
            <SkillFilePreviewButton skill={skill} mode={previewMode} onClick={handleOpenFiles} />
            <button
              className="skill-card__icon-button"
              type="button"
              onClick={() => void handleOpenSkill()}
              aria-label={t("skill.card.aria.openFolder", { name: skill.name })}
              data-tooltip={t("skill.card.tooltip.openFolder")}
            >
              <OpenFolderIcon />
            </button>
            {deleteAction}
            {!isGridLayout ? (
              <button
                className="skill-card__chevron-button"
                type="button"
                onClick={() => handleExpandedChange(!expanded)}
                aria-expanded={expanded}
                aria-label={t("skill.card.aria.expand", {
                  state: expanded ? t("skill.card.collapse") : t("skill.card.expand"),
                  name: skill.name,
                })}
              >
                <span className="skill-card__chevron" aria-hidden="true">
                  {expanded ? "⌄" : "›"}
                </span>
              </button>
            ) : null}
              </>
            ) : null}
          </div>
        </div>
        {expanded && !isGridLayout ? (
          <div className="skill-card__details">
            {skillDetailSections}
          </div>
        ) : null}
      </article>
      {showTagEditor ? createPortal(
        <div
          ref={tagEditorRef}
          className="skill-tag-editor"
          role="dialog"
          aria-label={t("skill.card.tag.dialog", { name: skill.name })}
          style={tagEditorPosition}
        >
          <form className="skill-tag-editor__form" onSubmit={handleTagSubmit}>
            <input
              autoFocus
              type="text"
              maxLength={MAX_SKILL_TAG_LENGTH}
              value={tagDraft}
              placeholder={t("skill.card.tag.placeholder")}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setTagDraft(event.target.value)}
            />
          </form>
          {tagDraft.trim() && !exactExistingTag ? (
            <button
              className="skill-tag-editor__create"
              type="button"
              disabled={isSavingTag}
              onClick={() => void saveTag(tagDraft.trim())}
            >
              <span aria-hidden="true">+</span>
              <span>{t("skill.card.tag.create", { tag: tagDraft.trim() })}</span>
            </button>
          ) : null}
          {matchingExistingTags.length > 0 ? (
            <div className="skill-tag-editor__suggestions">
              <div className="skill-tag-editor__options">
                {matchingExistingTags.map((tag) => (
                  <button
                    key={tag.toLocaleLowerCase()}
                    className={`tag-tone-${resolveSkillTagTone(tag)}${tag.toLocaleLowerCase() === skill.tag?.trim().toLocaleLowerCase() ? " is-selected" : ""}`}
                    type="button"
                    disabled={isSavingTag}
                    onClick={() => void saveTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {skill.tag?.trim() ? (
            <button
              className="skill-tag-editor__clear"
              type="button"
              disabled={isSavingTag}
              onClick={() => void saveTag("")}
            >
              {t("skill.card.tag.clear")}
            </button>
          ) : null}
        </div>,
        document.body,
      ) : null}
      {expanded && isGridLayout && !showFileDialog ? createPortal(
        <div
          className="skill-card-detail-modal__backdrop"
          role="presentation"
          onClick={() => void handleExpandedChange(false)}
        >
          <section
            className="skill-card-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("skill.card.modal.aria", { name: skill.name })}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="skill-card-detail-modal__header">
              <div className="skill-card-detail-modal__identity">
                <SkillMonogram name={skill.name} />
                <div className="skill-card-detail-modal__copy">
                  <div className="skill-card-detail-modal__title">
                    <h3>{skill.name}</h3>
                    <SkillStatusBadge status={skill.collabStatus} />
                    {renderTagAction(detailTagActionRef, "skill-card-detail-modal__tag")}
                  </div>
                </div>
              </div>
              <div className="skill-card-detail-modal__actions">
                {showDetailAction ? (
                  <button
                    className="secondary-button secondary-button--compact skill-card-detail-modal__action is-primary"
                    type="button"
                    onClick={() => void handlePrimaryAction()}
                    aria-label={t("skill.card.aria.update", { name: skill.name })}
                    disabled={isUpdating}
                  >
                    <RefreshIcon isSpinning={isUpdating} />
                    <span>{isUpdating ? t("skill.card.tooltip.updating") : t("skill.card.action.update")}</span>
                  </button>
                ) : null}
                <SkillFilePreviewButton
                  skill={skill}
                  mode={previewMode}
                  onClick={handleOpenFiles}
                  showLabel
                />
                <button
                  className="secondary-button secondary-button--compact skill-card-detail-modal__action"
                  type="button"
                  onClick={() => void handleOpenSkill()}
                  aria-label={t("skill.card.aria.openFolder", { name: skill.name })}
                >
                  <OpenFolderIcon />
                  <span>{t("skill.card.action.openFolder")}</span>
                </button>
                <button
                  className="skill-card-detail-modal__close"
                  type="button"
                  onClick={() => void handleExpandedChange(false)}
                  aria-label={t("skill.card.modal.close", { name: skill.name })}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            </header>
            <div className="skill-card__details skill-card-detail-modal__body">
              {skillDetailSections}
            </div>
          </section>
        </div>,
        document.body,
      ) : null}
      {showFileDialog ? (
        <SkillFileDialog
          skill={skill}
          isOpen={showFileDialog}
          initialMode={fileDialogInitialMode}
          onClose={() => setShowFileDialog(false)}
        />
      ) : null}
    </>
  );
}
