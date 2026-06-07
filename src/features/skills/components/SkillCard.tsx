import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { alignExpandedRowIntoView } from "@/app/utils/align-expanded-row";
import { useTranslate } from "@/app/i18n";
import { useNotifications } from "@/app/notifications";
import { useFailureReporter } from "@/app/failure-feedback";
import { SkillStatusBadge } from "@/features/skills/components/SkillStatusBadge";
import { SkillFileDialog } from "@/features/skills/components/SkillFileDialog";
import { ToolSyncPanel } from "@/features/skills/components/ToolSyncPanel";
import { openExternalLink } from "@/features/skills/api/skill-client";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type { SkillSummary } from "@/features/skills/state/skill-store";
import { formatSkillDescription } from "@/features/skills/utils/skill-description";
import { formatSkillLastEditor } from "@/features/skills/utils/skill-editor";
import { formatSkillSourceLabel } from "@/features/skills/utils/skill-source";
import { mergeSkillToolsWithInstalledTools } from "@/features/skills/utils/skill-tools";
import { formatSkillUpdatedAt } from "@/features/skills/utils/skill-time";
import { getToolDisplayRank, resolveToolLogoUrl } from "@/features/skills/utils/tool-logo";
import { isToolEnabledStatus } from "@/features/skills/utils/tool-status";
import { getMonogramLabel } from "@/features/skills/utils/monogram";

type SkillCardProps = {
  skill: SkillSummary;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean, rowElement?: HTMLElement | null) => void;
};

const SUMMARY_DESCRIPTION_LIMIT = 76;

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
  if (!normalizedDescription) {
    return emptyDescriptionLabel;
  }
  if (normalizedDescription.length <= SUMMARY_DESCRIPTION_LIMIT) {
    return normalizedDescription;
  }

  return `${normalizedDescription.slice(0, SUMMARY_DESCRIPTION_LIMIT).trimEnd()}...`;
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

export function SkillCard({ skill, expanded: expandedProp, onExpandedChange }: SkillCardProps) {
  const { t } = useTranslate();
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const { deleteSkill, openSkillWithDefaultTool, toolConfigs, updateSkill } = useSkillWorkspace();
  const [expandedState, setExpandedState] = useState(false);
  const [showFileDialog, setShowFileDialog] = useState(false);
  const [isDeleteConfirming, setIsDeleteConfirming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showEnabledTools, setShowEnabledTools] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const deleteActionRef = useRef<HTMLButtonElement | null>(null);
  const skillTools = mergeSkillToolsWithInstalledTools(skill.tools, toolConfigs);
  const sourceLabel = formatSkillSourceLabel(skill.sourceLabel, {
    sourceType: skill.sourceType,
    sourceUrl: skill.sourceUrl,
  });
  const skillDescription = formatSkillDescription(skill.description) || t("skills.description.empty");
  const summaryDescription = formatSummaryDescription(skill.description, t("skills.description.empty"));
  const remoteUpdatedAt = formatSkillUpdatedAt(skill.remoteUpdatedAt);
  const localUpdatedAt = formatSkillUpdatedAt(skill.localUpdatedAt);
  const remoteUpdater = formatSkillLastEditor(skill.lastEditor) || t("skill.card.remoteUpdaterUnknown");
  const enabledTools = skillTools
    .filter((tool) => isToolEnabledStatus(tool.statusLabel))
    .sort(compareToolsByDisplayOrder);
  const summaryToolsLabel = enabledTools.length > 0
    ? t("skill.card.enabledTools", { tools: enabledTools.map((tool) => tool.name).join("、") })
    : t("skill.card.enabledToolsNone");
  const showDetailAction = skill.collabStatus === "update-available";
  const displaySourceLabel =
    sourceLabel === "本地" || sourceLabel === "Local"
      ? t("skills.source.local")
      : sourceLabel;
  const showRemoteMetadata = skill.gitLinked && skill.sourceType !== "local";
  const expanded = expandedProp ?? expandedState;

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
        await updateSkill(skill.name);
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
      await deleteSkill(skill.name);
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
      await openSkillWithDefaultTool(skill.name);
    } catch (error) {
      reportFailure(error, {
        operation: "open_skill_with_default_tool",
        fallbackMessage: t("skill.card.error.openFolder"),
        context: { skillName: skill.name },
      });
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
    const shouldAlignExpandedCard = nextExpanded && !expanded;
    if (expandedProp === undefined) {
      setExpandedState(nextExpanded);
    }
    onExpandedChange?.(nextExpanded, cardRef.current);
    if (shouldAlignExpandedCard) {
      await alignExpandedRowIntoView(cardRef.current);
    }
  }

  const updateTooltipLabel = isUpdating ? t("skill.card.tooltip.updating") : t("skill.card.tooltip.update");
  const deleteConfirmTooltipLabel = isDeleting ? t("skill.card.tooltip.deleting") : t("skill.card.tooltip.deleteConfirm");

  return (
    <>
      <article
        ref={cardRef}
        className={`skill-card skill-card--list${expanded ? " is-expanded" : ""}`}
      >
        <div className="skill-card__header">
          <div
            className="skill-card__summary-button"
            onClick={() => handleExpandedChange(!expanded)}
          >
            <div className="skill-card__summary-content">
              <div className="skill-card__summary-top">
                <div className="skill-card__identity">
                  <SkillMonogram name={skill.name} />
                  <div className="skill-card__title-stack">
                    <div className="skill-card__title-row">
                      <h3>{skill.name}</h3>
                      <button
                        className={`status-badge tone-info skill-card__enabled-toggle${enabledTools.length > 0 ? "" : " is-empty"}`}
                        type="button"
                        onClick={handleEnabledToolsToggle}
                        aria-expanded={showEnabledTools}
                        aria-label={summaryToolsLabel}
                        disabled={enabledTools.length === 0}
                      >
                        {enabledTools.length > 0 ? t("skill.card.enabledCount", { count: enabledTools.length }) : t("skill.card.disabled")}
                      </button>
                      {showEnabledTools && enabledTools.length > 0 ? (
                        <div className="skill-card__summary-tools" aria-label={summaryToolsLabel}>
                          {enabledTools.map((tool) => (
                            <SummaryToolIcon key={tool.name} toolName={tool.name} />
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <p className="skill-card__summary-description">{summaryDescription}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="skill-card__list-actions">
            <SkillStatusBadge status={skill.collabStatus} />
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
              className="skill-card__icon-button"
              type="button"
              onClick={() => setShowFileDialog(true)}
              aria-label={t("skill.card.aria.viewFiles", { name: skill.name })}
              data-tooltip={t("skill.card.tooltip.viewFiles")}
            >
              <ViewFileIcon />
            </button>
            <button
              className="skill-card__icon-button"
              type="button"
              onClick={() => void handleOpenSkill()}
              aria-label={t("skill.card.aria.openFolder", { name: skill.name })}
              data-tooltip={t("skill.card.tooltip.openFolder")}
            >
              <OpenFolderIcon />
            </button>
            {isDeleteConfirming || isDeleting ? (
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
            )}
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
          </div>
        </div>
        {expanded ? (
          <div className="skill-card__details">
            <section>
              <div className="skill-card__section-header">
                <h4>{t("skill.card.basicInfo")}</h4>
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
                  <dd>{displaySourceLabel}</dd>
                </div>
                <div>
                  <dt>{t("skill.card.source")}</dt>
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
                    <span className={`detail-git-badge${skill.gitLinked ? " is-linked" : " is-unlinked"}`}>
                      git
                    </span>
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
            <ToolSyncPanel skillName={skill.name} tools={skillTools} />
          </div>
        ) : null}
      </article>
      {showFileDialog ? (
        <SkillFileDialog skill={skill} isOpen={showFileDialog} onClose={() => setShowFileDialog(false)} />
      ) : null}
    </>
  );
}
