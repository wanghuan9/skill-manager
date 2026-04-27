import { useState } from "react";
import { SkillStatusBadge } from "@/features/skills/components/SkillStatusBadge";
import { SkillActionButton } from "@/features/skills/components/SkillActionButton";
import { SkillFileDialog } from "@/features/skills/components/SkillFileDialog";
import { ToolSyncPanel } from "@/features/skills/components/ToolSyncPanel";
import { UpdateSkillDialog } from "@/features/skills/components/UpdateSkillDialog";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type { SkillSummary } from "@/features/skills/state/skill-store";
import { formatSkillDescription } from "@/features/skills/utils/skill-description";
import { formatSkillSourceLabel } from "@/features/skills/utils/skill-source";
import { mergeSkillToolsWithInstalledTools } from "@/features/skills/utils/skill-tools";
import { formatSkillUpdatedAt } from "@/features/skills/utils/skill-time";
import { isToolEnabledStatus } from "@/features/skills/utils/tool-status";

type SkillCardProps = {
  skill: SkillSummary;
};

type SourceIconKind = "github" | "gitlab" | "local" | "default";

function resolveSourceIconKind(sourceLabel: string, sourceType: SkillSummary["sourceType"]): SourceIconKind {
  if (sourceLabel === "本地") {
    return "local";
  }
  if (sourceLabel === "GitLab") {
    return "gitlab";
  }
  if (sourceLabel === "GitHub") {
    return "github";
  }
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

function SourceIcon({ iconKind }: { iconKind: SourceIconKind }) {
  switch (iconKind) {
    case "github":
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M4.75 5.5A1.75 1.75 0 0 1 6.5 3.75h7A1.75 1.75 0 0 1 15.25 5.5v9A1.75 1.75 0 0 1 13.5 16.25h-7a1.75 1.75 0 0 1-1.75-1.75v-9Z"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path d="M7 7.25h6M7 10h6M7 12.75h3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M4.75 6.5H3.5M4.75 13.5H3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "gitlab":
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M5.5 4.5h2.25l2.25 6 2.25-6h2.25l1.5 4.25L10 15.5 4 8.75 5.5 4.5Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M7.75 4.5 10 10.5 12.25 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      );
    case "local":
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M3.75 6.5A1.75 1.75 0 0 1 5.5 4.75h3l1.25 1.5h4.75a1.75 1.75 0 0 1 1.75 1.75v5.5a1.75 1.75 0 0 1-1.75 1.75h-9A1.75 1.75 0 0 1 3.75 13.5v-7Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M7 10.25h5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M5 4.75h10v10.5H5z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M7.5 8h5M7.5 11h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
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

export function SkillCard({ skill }: SkillCardProps) {
  const { deleteSkill, openSkillWithDefaultTool, toolConfigs } = useSkillWorkspace();
  const [expanded, setExpanded] = useState(false);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [showFileDialog, setShowFileDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const skillTools = mergeSkillToolsWithInstalledTools(skill.tools, toolConfigs);
  const sourceLabel = formatSkillSourceLabel(skill.sourceLabel);
  const skillDescription = formatSkillDescription(skill.description);
  const sourceIconKind = resolveSourceIconKind(sourceLabel, skill.sourceType);
  const updatedAt = formatSkillUpdatedAt(skill.lastSyncedAt);
  const enabledTools = skillTools.filter((tool) => isToolEnabledStatus(tool.statusLabel));
  const visibleTools = enabledTools.slice(0, 2);
  const hiddenToolCount = Math.max(enabledTools.length - visibleTools.length, 0);
  const showDetailAction = skill.collabStatus === "update-available";

  function handlePrimaryAction() {
    if (skill.collabStatus === "pending-push") {
      void handleOpenSkill();
      return;
    }

    if (skill.collabStatus === "update-available") {
      setShowUpdateDialog(true);
    }
  }

  async function handleConfirmDelete() {
    setShowDeleteDialog(false);
    try {
      await deleteSkill(skill.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除 skill 失败";
      window.alert(message);
    }
  }

  async function handleOpenSkill() {
    try {
      await openSkillWithDefaultTool(skill.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : "打开 skill 目录失败，请检查默认打开工具。";
      window.alert(message);
    }
  }

  const showQuickAction = skill.collabStatus === "update-available";
  const quickActionLabel = "更新";

  return (
    <>
      <article className={`skill-card skill-card--list${expanded ? " is-expanded" : ""}`}>
        <div className="skill-card__header">
          <button
            className="skill-card__summary-button"
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "收起" : "展开"} ${skill.name}`}
          >
            <div className="skill-card__identity">
              <div className={`link-badge link-badge--${sourceIconKind}`} aria-hidden="true">
                <SourceIcon iconKind={sourceIconKind} />
              </div>
              <div className="skill-card__summary-main">
                <div className="skill-card__title-row">
                  <h3>{skill.name}</h3>
                </div>
                <div className="skill-card__list-meta">
                  <span className="skill-card__meta-label-inline">来源：</span>
                  <span className="skill-card__meta-value">{sourceLabel}</span>
                  <span className="skill-card__meta-label-inline">更新时间：</span>
                  <span className="skill-card__meta-value">{updatedAt}</span>
                  <span className="skill-card__meta-label-inline">Git：</span>
                  <span className={`skill-card__meta-value skill-card__git-status${skill.gitLinked ? " is-linked" : " is-unlinked"}`}>
                    {skill.gitLinked ? "已关联" : "未关联"}
                  </span>
                </div>
              </div>
            </div>
            <div className="skill-card__summary-tools" aria-label="已启用工具">
              {visibleTools.length > 0 ? (
                <>
                  {visibleTools.map((tool) => (
                    <span key={tool.name} className="skill-card__tool-tag">
                      {tool.name}
                    </span>
                  ))}
                  {hiddenToolCount > 0 ? (
                    <span className="skill-card__tool-tag skill-card__tool-tag--extra">+{hiddenToolCount}</span>
                  ) : null}
                </>
              ) : (
                <span className="skill-card__tool-empty">未启用到工具</span>
              )}
            </div>
          </button>
          <div className="skill-card__list-actions">
            <SkillStatusBadge status={skill.collabStatus} />
            {showQuickAction ? (
              <button
                className="secondary-button skill-card__quick-action"
                type="button"
                onClick={() => void handlePrimaryAction()}
              >
                {quickActionLabel}
              </button>
            ) : null}
            <button
              className="skill-card__icon-button"
              type="button"
              onClick={() => setShowFileDialog(true)}
              aria-label={`查看 ${skill.name} 文件`}
              title="查看 skill 文件"
            >
              <ViewFileIcon />
            </button>
            <button
              className="skill-card__icon-button"
              type="button"
              onClick={() => void handleOpenSkill()}
              aria-label={`打开 ${skill.name} 目录`}
              title="用默认工具打开 skill 目录"
            >
              <OpenFolderIcon />
            </button>
            <button
              className="skill-card__icon-button skill-card__icon-button--delete"
              type="button"
              onClick={() => setShowDeleteDialog(true)}
              aria-label={`删除 ${skill.name}`}
              title="删除 skill"
            >
              <DeleteIcon />
            </button>
            <span className="skill-card__chevron" aria-hidden="true">
              {expanded ? "⌄" : "›"}
            </span>
          </div>
        </div>
        {expanded ? (
          <div className="skill-card__details">
            <section>
              <div className="skill-card__section-header">
                <h4>基本信息</h4>
                {showDetailAction ? (
                  <div className="skill-card__section-action">
                    <SkillActionButton status={skill.collabStatus} onClick={handlePrimaryAction} />
                  </div>
                ) : null}
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
                  <dd>{skill.sourceUrl}</dd>
                </div>
                <div>
                  <dt>更新时间</dt>
                  <dd>{updatedAt}</dd>
                </div>
                <div>
                  <dt>更新人</dt>
                  <dd>{skill.lastEditor || "未获取"}</dd>
                </div>
                <div>
                  <dt>Git 关联</dt>
                  <dd>{skill.gitLinked ? "已关联" : "未关联"}</dd>
                </div>
              </dl>
            </section>
            <ToolSyncPanel skillName={skill.name} tools={skillTools} />
          </div>
        ) : null}
      </article>
      {showUpdateDialog ? (
        <UpdateSkillDialog skill={skill} isOpen={showUpdateDialog} onClose={() => setShowUpdateDialog(false)} />
      ) : null}
      {showFileDialog ? (
        <SkillFileDialog skill={skill} isOpen={showFileDialog} onClose={() => setShowFileDialog(false)} />
      ) : null}
      {showDeleteDialog ? (
        <div className="dialog-backdrop" onClick={() => setShowDeleteDialog(false)}>
          <div className="dialog-card" onClick={(e) => e.stopPropagation()} style={{ width: "min(320px, 100%)", borderRadius: "14px" }}>
            <div style={{ padding: "20px 20px 16px", display: "grid", gap: "8px" }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: "0.95rem" }}>删除 {skill.name}？</p>
              <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.82rem", lineHeight: 1.5 }}>将同时移除所有工具中的符号链接，本地文件也将被删除。</p>
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", padding: "12px 20px", borderTop: "1px solid var(--line)" }}>
              <button className="secondary-button" type="button" style={{ padding: "5px 14px", fontSize: "0.85rem" }} onClick={() => setShowDeleteDialog(false)}>
                取消
              </button>
              <button className="solid-button" type="button" style={{ padding: "5px 14px", fontSize: "0.85rem", background: "#e53e3e", borderColor: "#e53e3e", color: "#fff" }} onClick={() => void handleConfirmDelete()}>
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
