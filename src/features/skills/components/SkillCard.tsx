import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
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
  onExpandedChange?: (expanded: boolean) => void;
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

function formatSummaryDescription(description: string) {
  const normalizedDescription = formatSkillDescription(description).replace(/\s+/g, " ");
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
  const { notify } = useNotifications();
  const reportFailure = useFailureReporter();
  const { deleteSkill, openSkillWithDefaultTool, toolConfigs, updateSkill } = useSkillWorkspace();
  const [expandedState, setExpandedState] = useState(false);
  const [showFileDialog, setShowFileDialog] = useState(false);
  const [isDeleteConfirming, setIsDeleteConfirming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showEnabledTools, setShowEnabledTools] = useState(false);
  const deleteActionRef = useRef<HTMLButtonElement | null>(null);
  const skillTools = mergeSkillToolsWithInstalledTools(skill.tools, toolConfigs);
  const sourceLabel = formatSkillSourceLabel(skill.sourceLabel, {
    sourceType: skill.sourceType,
    sourceUrl: skill.sourceUrl,
  });
  const skillDescription = formatSkillDescription(skill.description);
  const summaryDescription = formatSummaryDescription(skill.description);
  const remoteUpdatedAt = formatSkillUpdatedAt(skill.remoteUpdatedAt);
  const localUpdatedAt = formatSkillUpdatedAt(skill.localUpdatedAt);
  const remoteUpdater = formatSkillLastEditor(skill.lastEditor) || "未获取";
  const enabledTools = skillTools
    .filter((tool) => isToolEnabledStatus(tool.statusLabel))
    .sort(compareToolsByDisplayOrder);
  const summaryToolsLabel = enabledTools.length > 0
    ? `已启用工具：${enabledTools.map((tool) => tool.name).join("、")}`
    : "已启用工具：无";
  const showDetailAction = skill.collabStatus === "update-available";
  const showRemoteUpdateInfo = skill.sourceType !== "local";
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
          fallbackMessage: "更新失败，请稍后重试。",
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
      notify({ tone: "success", message: `已删除 ${skill.name}` });
    } catch (error) {
      reportFailure(error, {
        operation: "delete_skill",
        fallbackMessage: "删除 skill 失败",
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
        fallbackMessage: "打开 skill 目录失败，请检查默认打开工具。",
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

  function handleExpandedChange(nextExpanded: boolean) {
    if (expandedProp === undefined) {
      setExpandedState(nextExpanded);
    }
    onExpandedChange?.(nextExpanded);
  }

  const updateTooltipLabel = isUpdating ? "正在更新" : "更新 skill";
  const deleteConfirmTooltipLabel = isDeleting ? "正在删除" : "再次点击删除";

  return (
    <>
      <article className={`skill-card skill-card--list${expanded ? " is-expanded" : ""}`}>
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
                        {enabledTools.length > 0 ? `已启用 ${enabledTools.length}` : "未启用"}
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
                aria-label={`更新 ${skill.name}`}
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
              aria-label={`查看 ${skill.name} 文件`}
              data-tooltip="查看 skill 文件"
            >
              <ViewFileIcon />
            </button>
            <button
              className="skill-card__icon-button"
              type="button"
              onClick={() => void handleOpenSkill()}
              aria-label={`打开 ${skill.name} 目录`}
              data-tooltip="用默认工具打开 skill 目录"
            >
              <OpenFolderIcon />
            </button>
            {isDeleteConfirming || isDeleting ? (
              <button
                ref={deleteActionRef}
                className="skill-card__delete-confirm-button"
                type="button"
                onClick={() => void handleDeleteAction()}
                aria-label={`${isDeleting ? "正在删除" : "确认删除"} ${skill.name}`}
                data-tooltip={deleteConfirmTooltipLabel}
                disabled={isDeleting}
              >
                {isDeleting ? "删除中" : "确认"}
              </button>
            ) : (
              <button
                ref={deleteActionRef}
                className="skill-card__icon-button skill-card__icon-button--delete"
                type="button"
                onClick={() => void handleDeleteAction()}
                aria-label={`删除 ${skill.name}`}
                data-tooltip="删除 skill"
              >
                <DeleteIcon />
              </button>
            )}
            <button
              className="skill-card__chevron-button"
              type="button"
              onClick={() => handleExpandedChange(!expanded)}
              aria-expanded={expanded}
              aria-label={`${expanded ? "收起" : "展开"} ${skill.name}`}
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
                <h4>基本信息</h4>
              </div>
              <dl className="detail-grid detail-grid--single">
                <div>
                  <dt>简介</dt>
                  <dd>{skillDescription}</dd>
                </div>
              </dl>
              <dl className="detail-grid detail-grid--source">
                <div>
                  <dt>来源类型</dt>
                  <dd>{sourceLabel}</dd>
                </div>
                <div>
                  <dt>来源</dt>
                  <dd className="detail-grid__source-value">
                    {isHttpUrl(skill.sourceUrl) ? (
                      <a
                        className="detail-grid__source-link"
                        href={skill.sourceUrl}
                        onClick={(event) => {
                          event.preventDefault();
                          void openExternalLink(skill.sourceUrl);
                        }}
                      >
                        {skill.sourceUrl}
                      </a>
                    ) : (
                      <span>{skill.sourceUrl}</span>
                    )}
                    <span className={`detail-git-badge${skill.gitLinked ? " is-linked" : " is-unlinked"}`}>
                      git
                    </span>
                  </dd>
                </div>
                {showRemoteUpdateInfo ? (
                  <>
                    <div>
                      <dt>远端更新时间</dt>
                      <dd>{remoteUpdatedAt || "未获取"}</dd>
                    </div>
                    <div>
                      <dt>更新人</dt>
                      <dd>{remoteUpdater}</dd>
                    </div>
                  </>
                ) : null}
                <div>
                  <dt>本地更新时间</dt>
                  <dd>{localUpdatedAt || "未获取"}</dd>
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
