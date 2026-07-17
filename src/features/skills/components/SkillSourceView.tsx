import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFailureReporter } from "@/app/failure-feedback";
import { useTranslate, type TranslationKey } from "@/app/i18n";
import { useNotifications } from "@/app/notifications";
import { SkillFileDialog } from "@/features/skills/components/SkillFileDialog";
import { SkillSourceSwitcher } from "@/features/skills/components/SkillSourceSwitcher";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { formatSkillDescription } from "@/features/skills/utils/skill-description";
import { getMonogramLabel } from "@/features/skills/utils/monogram";
import {
  buildToolSkillViewItems,
  listSkillSourceTools,
  MANAGED_SKILL_SOURCE_ID,
  type SkillSourceId,
  type ToolSkillManagementFilter,
  type ToolSkillManagementStatus,
  type ToolSkillViewItem,
} from "@/features/skills/utils/skill-source-view";

type SkillSourceViewProps = {
  activeSourceId: SkillSourceId;
  onActiveSourceIdChange: (sourceId: SkillSourceId) => void;
  managementFilter: ToolSkillManagementFilter;
  query: string;
};

const statusTranslationKeys: Record<ToolSkillManagementStatus, TranslationKey> = {
  managed: "skills.source.status.managed",
  unmanaged: "skills.source.status.unmanaged",
  mismatch: "skills.source.status.mismatch",
};

function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3.5 6.4c0-.9.7-1.6 1.6-1.6h3l1.35 1.55h5.45c.9 0 1.6.7 1.6 1.6v5.45c0 .9-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.7-1.6-1.6v-7Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M2 13h10M9 16l3-3-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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

function DeleteIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4.75 5.75h10.5M7.25 5.75V4.5c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1v1.25m-6.25 0 .45 8.25c.03.61.54 1.08 1.15 1.08h3.8c.61 0 1.12-.47 1.15-1.08l.45-8.25M8.5 8.75v4.25m3 0V8.75" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SkillSourceMonogram({ name }: { name: string }) {
  return (
    <span className="link-badge link-badge--monogram" aria-hidden="true">
      <span className="link-badge__type-mark link-badge__type-mark--skill">
        <svg viewBox="0 0 12 12" fill="none">
          <path d="M6 1.5 7.1 4.9 10.5 6 7.1 7.1 6 10.5 4.9 7.1 1.5 6 4.9 4.9 6 1.5Z" fill="currentColor" />
        </svg>
      </span>
      <span className="link-badge__label">{getMonogramLabel(name)}</span>
    </span>
  );
}

function statusTone(status: ToolSkillManagementStatus) {
  if (status === "managed") {
    return "tone-positive";
  }
  if (status === "mismatch") {
    return "tone-warning";
  }
  return "tone-neutral";
}

function SkillSourceRow(props: {
  item: ToolSkillViewItem;
  isImporting: boolean;
  onImport: (item: ToolSkillViewItem) => void;
  onOpenFolder: (item: ToolSkillViewItem) => void;
  onViewFiles: (item: ToolSkillViewItem) => void;
  onDelete: (item: ToolSkillViewItem) => Promise<void>;
  onShowManaged: () => void;
}) {
  const { t } = useTranslate();
  const { item, isImporting, onDelete, onImport, onOpenFolder, onShowManaged, onViewFiles } = props;
  const [isDeleteConfirming, setIsDeleteConfirming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const deleteActionRef = useRef<HTMLButtonElement | null>(null);
  const statusLabel = t(statusTranslationKeys[item.status]);
  const description = formatSkillDescription(item.description) || t("skills.description.empty");

  useEffect(() => {
    if (!isDeleteConfirming) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!deleteActionRef.current?.contains(event.target as Node)) {
        setIsDeleteConfirming(false);
      }
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
      await onDelete(item);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <article className="skill-card skill-source-card" aria-label={item.name}>
      <div className="skill-card__identity">
        <SkillSourceMonogram name={item.name} />
        <div className="skill-card__title-stack">
          <div className="skill-card__title-row">
            <h3>{item.name}</h3>
            <span className={`status-badge ${statusTone(item.status)}`}>{statusLabel}</span>
            {item.status === "unmanaged" ? (
              <span className="status-badge tone-info">
                {t(item.entryKind === "symlink"
                  ? "skills.source.entryKind.symlink"
                  : "skills.source.entryKind.directory")}
              </span>
            ) : null}
          </div>
          <p className="skill-card__summary-description">{description}</p>
        </div>
      </div>
      <div className="skill-card__list-actions">
        {item.status === "unmanaged" ? (
          <button
            className="skill-card__icon-button skill-card__icon-button--update"
            type="button"
            disabled={isImporting}
            onClick={() => onImport(item)}
            aria-label={isImporting ? t("skills.source.importing") : t("skills.source.import")}
            data-tooltip={isImporting ? t("skills.source.importing") : t("skills.source.import")}
          >
            <ImportIcon />
          </button>
        ) : null}
        <button
          className="skill-card__icon-button"
          type="button"
          onClick={() => onViewFiles(item)}
          aria-label={t("skill.card.aria.viewFiles", { name: item.name })}
          data-tooltip={t("skill.card.tooltip.viewFiles")}
        >
          <ViewFileIcon />
        </button>
        <button
          className="skill-card__icon-button"
          type="button"
          onClick={() => onOpenFolder(item)}
          aria-label={t("skills.source.openFolder")}
          data-tooltip={t("skills.source.openFolder")}
        >
          <FolderIcon />
        </button>
        {isDeleteConfirming || isDeleting ? (
          <button
            ref={deleteActionRef}
            className="skill-card__delete-confirm-button"
            type="button"
            onClick={() => void handleDeleteAction()}
            aria-label={t("skill.card.aria.deleteConfirm", {
              state: isDeleting ? t("skill.card.deleteLoading") : t("skill.card.deleteConfirm"),
              name: item.name,
            })}
            data-tooltip={isDeleting ? t("skill.card.tooltip.deleting") : t("skill.card.tooltip.deleteConfirm")}
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
            aria-label={t("skill.card.aria.delete", { name: item.name })}
            data-tooltip={t("skill.card.tooltip.delete")}
          >
            <DeleteIcon />
          </button>
        )}
        {item.status !== "unmanaged" ? (
          <button
            className="skill-card__chevron-button"
            type="button"
            onClick={onShowManaged}
            aria-label={t("skills.source.showManaged")}
            data-tooltip={t("skills.source.showManaged")}
          >
            <span className="skill-card__chevron" aria-hidden="true">›</span>
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function SkillSourceView(props: SkillSourceViewProps) {
  const { activeSourceId, managementFilter, onActiveSourceIdChange, query } = props;
  const { t } = useTranslate();
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const {
    importCandidate,
    appSettings,
    deleteToolSkill,
    installedSkills,
    toolSkillEntries = [],
    openPathInFinder,
    toolConfigs = [],
  } = useSkillWorkspace();
  const sourceTools = useMemo(() => listSkillSourceTools(toolConfigs), [toolConfigs]);
  const selectedTool = sourceTools.find((tool) => tool.id === activeSourceId) ?? null;
  const [sourceHeaderContainer, setSourceHeaderContainer] = useState<HTMLElement | null>(null);
  const [importingPaths, setImportingPaths] = useState<Set<string>>(new Set());
  const [viewingToolSkill, setViewingToolSkill] = useState<{ item: ToolSkillViewItem; toolId: string } | null>(null);
  const rowsByTool = useMemo(() => new Map(sourceTools.map((tool) => [
    tool.id,
    buildToolSkillViewItems({ tool, installedSkills, toolSkillEntries }),
  ])), [installedSkills, sourceTools, toolSkillEntries]);
  const toolCounts = useMemo(
    () => new Map(sourceTools.map((tool) => [tool.id, rowsByTool.get(tool.id)?.length ?? 0])),
    [rowsByTool, sourceTools],
  );
  const sourceStyle = appSettings?.skillSourceViewStyle ?? "flat";
  const selectedRows = selectedTool ? rowsByTool.get(selectedTool.id) ?? [] : [];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = selectedRows.filter((item) => {
    const matchesFilter = managementFilter === "all" || item.status === managementFilter;
    const matchesQuery = !normalizedQuery || [item.name, item.description, item.localPath]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
    return matchesFilter && matchesQuery;
  });

  useEffect(() => {
    setSourceHeaderContainer(document.getElementById("skills-source-header-slot"));
  }, []);

  useEffect(() => {
    if (activeSourceId !== MANAGED_SKILL_SOURCE_ID && !selectedTool) {
      onActiveSourceIdChange(MANAGED_SKILL_SOURCE_ID);
    }
  }, [activeSourceId, onActiveSourceIdChange, selectedTool]);

  async function handleOpenFolder(item: ToolSkillViewItem) {
    try {
      await openPathInFinder(item.localPath);
    } catch (error) {
      reportFailure(error, {
        operation: "open_tool_skill_folder",
        fallbackMessage: t("skills.source.error.openFolder"),
        context: { skillName: item.name, localPath: item.localPath },
      });
    }
  }

  async function handleImport(item: ToolSkillViewItem) {
    if (item.status !== "unmanaged" || importingPaths.has(item.localPath)) {
      return;
    }

    setImportingPaths((current) => new Set(current).add(item.localPath));
    try {
      await importCandidate(item.localPath);
      notify({ message: t("skills.source.success.imported", { name: item.name }), tone: "success" });
    } catch (error) {
      reportFailure(error, {
        operation: "import_tool_skill",
        fallbackMessage: t("skills.source.error.import", { name: item.name }),
        context: { skillName: item.name, localPath: item.localPath },
      });
    } finally {
      setImportingPaths((current) => {
        const next = new Set(current);
        next.delete(item.localPath);
        return next;
      });
    }
  }

  async function handleDelete(item: ToolSkillViewItem) {
    if (!selectedTool) {
      return;
    }

    try {
      await deleteToolSkill({ toolId: selectedTool.id, skillName: item.name });
      notify({
        message: t("skills.source.success.deleted", { name: item.name, tool: selectedTool.name }),
        tone: "success",
      });
    } catch (error) {
      reportFailure(error, {
        operation: "delete_tool_skill",
        fallbackMessage: t("skills.source.error.delete", { name: item.name }),
        context: { skillName: item.name, toolId: selectedTool.id, localPath: item.localPath },
      });
    }
  }

  const sourceHeader = (
    <div className="skills-source-header">
      <SkillSourceSwitcher
        activeSourceId={activeSourceId}
        managedCount={installedSkills.length}
        sourceStyle={sourceStyle}
        tools={sourceTools}
        toolCounts={toolCounts}
        onSourceChange={onActiveSourceIdChange}
      />
      <div className="skills-source-divider" aria-hidden="true" />
    </div>
  );

  return (
    <>
      {sourceHeaderContainer ? createPortal(sourceHeader, sourceHeaderContainer) : sourceHeader}

      {selectedTool ? (
        <>
          <div className="card-list">
            {visibleRows.length > 0 ? visibleRows.map((item) => (
              <SkillSourceRow
                key={item.id}
                item={item}
                isImporting={importingPaths.has(item.localPath)}
                onImport={(target) => void handleImport(target)}
                onDelete={handleDelete}
                onOpenFolder={(target) => void handleOpenFolder(target)}
                onViewFiles={(target) => setViewingToolSkill({ item: target, toolId: selectedTool.id })}
                onShowManaged={() => onActiveSourceIdChange(MANAGED_SKILL_SOURCE_ID)}
              />
            )) : (
              <div className="panel-card empty-state">
                <h3>{t("skills.source.empty.title")}</h3>
                <p>{t("skills.source.empty.description", { tool: selectedTool.name })}</p>
              </div>
            )}
          </div>
        </>
      ) : null}
      {viewingToolSkill ? (
        <SkillFileDialog
          skill={{ name: viewingToolSkill.item.name }}
          toolId={viewingToolSkill.toolId}
          readOnly
          isOpen
          onClose={() => setViewingToolSkill(null)}
        />
      ) : null}
    </>
  );
}
