import { useEffect, useId, useState } from "react";
import { GitChangePreview } from "@/features/skills/components/GitChangePreview";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type { SkillSummary, UpdatePreviewSnapshot } from "@/features/skills/state/skill-store";

type UpdateSkillDialogProps = {
  skill: SkillSummary;
  isOpen: boolean;
  onClose: () => void;
};

const DEFAULT_UPDATE_ERROR = "加载更新预览失败，请稍后重试。";

export function UpdateSkillDialog({ skill, isOpen, onClose }: UpdateSkillDialogProps) {
  const { loadUpdatePreview, updateSkill } = useSkillWorkspace();
  const titleId = useId();
  const [preview, setPreview] = useState<UpdatePreviewSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let active = true;

    async function loadPreview() {
      setIsLoading(true);
      setErrorMessage("");
      try {
        const snapshot = await loadUpdatePreview(skill.name);
        if (active) {
          setPreview(snapshot);
        }
      } catch (error) {
        if (active) {
          setPreview(null);
          setErrorMessage(error instanceof Error ? error.message : DEFAULT_UPDATE_ERROR);
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }

    void loadPreview();

    return () => {
      active = false;
    };
  }, [isOpen, loadUpdatePreview, skill.name]);

  useEffect(() => {
    if (!isOpen) {
      setPreview(null);
      setErrorMessage("");
      setIsSubmitting(false);
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  async function handleConfirmUpdate() {
    setIsSubmitting(true);
    setErrorMessage("");
    try {
      await updateSkill(skill.name);
      onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "更新失败，请稍后重试。");
    } finally {
      setIsSubmitting(false);
    }
  }

  const blockedByLocalChanges = Boolean(preview?.hasLocalChanges);

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog-card dialog-card--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-card__header">
          <div>
            <h3 id={titleId}>更新 skill</h3>
            <p>更新前确认远端变更，避免覆盖当前工作区。</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭更新弹层">
            ×
          </button>
        </div>
        <div className="dialog-card__body">
          {isLoading ? <p className="dialog-note">正在读取远端更新...</p> : null}
          {preview ? (
            <>
              <div className="dialog-summary-grid">
                <div>
                  <span>当前分支</span>
                  <strong>{preview.currentBranch}</strong>
                </div>
                <div>
                  <span>远端分支</span>
                  <strong>{preview.remoteBranch}</strong>
                </div>
                <div>
                  <span>将拉取提交</span>
                  <strong>{preview.commitsToPull} 个</strong>
                </div>
              </div>
              {blockedByLocalChanges ? (
                <p className="dialog-warning">检测到本地未提交改动，请先在 canonical repo 中处理后再更新。</p>
              ) : null}
              <section className="dialog-section">
                <h4>变更摘要</h4>
                <GitChangePreview files={preview.changedFiles} emptyText="远端没有文件级变更。" />
              </section>
            </>
          ) : null}
          {errorMessage ? <p className="dialog-error">{errorMessage}</p> : null}
        </div>
        <div className="dialog-card__footer">
          <button className="secondary-button" type="button" onClick={onClose} disabled={isSubmitting}>
            取消
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={handleConfirmUpdate}
            disabled={!preview || blockedByLocalChanges || isSubmitting}
          >
            {isSubmitting ? "更新中..." : "确认更新"}
          </button>
        </div>
      </div>
    </div>
  );
}
