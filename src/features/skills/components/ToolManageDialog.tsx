import { useId, useMemo, useState } from "react";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type { OpenToolCard } from "@/features/skills/utils/open-tools";
import { isToolEnabledStatus } from "@/features/skills/utils/tool-status";

type ToolManageDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  tool: OpenToolCard;
};

export function ToolManageDialog({ isOpen, onClose, tool }: ToolManageDialogProps) {
  const dialogTitleId = useId();
  const { installedSkills, toggleSkillTool } = useSkillWorkspace();
  const [query, setQuery] = useState("");
  const [showEnabledOnly, setShowEnabledOnly] = useState(false);
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);

  const skillRows = useMemo(() => {
    return installedSkills
      .map((skill) => {
        const matchedTool = skill.tools.find((item) => item.name === tool.name);
        const isEnabled = matchedTool ? isToolEnabledStatus(matchedTool.statusLabel) : false;

        return {
          skillName: skill.name,
          isEnabled,
        };
      })
      .filter((item) => item.skillName.toLowerCase().includes(query.trim().toLowerCase()))
      .filter((item) => (showEnabledOnly ? item.isEnabled : true))
      .sort((left, right) => {
        if (left.isEnabled !== right.isEnabled) {
          return left.isEnabled ? -1 : 1;
        }

        return left.skillName.localeCompare(right.skillName);
      });
  }, [installedSkills, query, showEnabledOnly, tool.name]);

  const enabledCount = useMemo(
    () => installedSkills.filter((skill) => {
      const matchedTool = skill.tools.find((item) => item.name === tool.name);
      return matchedTool ? isToolEnabledStatus(matchedTool.statusLabel) : false;
    }).length,
    [installedSkills, tool.name],
  );

  const disabledVisibleCount = skillRows.filter((item) => !item.isEnabled).length;
  const enabledVisibleCount = skillRows.filter((item) => item.isEnabled).length;

  async function handleToggleAllOn() {
    const disabledSkillNames = skillRows
      .filter((item) => !item.isEnabled)
      .map((item) => item.skillName);
    if (disabledSkillNames.length === 0) {
      return;
    }

    setIsUpdatingAll(true);
    try {
      await Promise.all(
        disabledSkillNames.map((skillName) => toggleSkillTool({ skillName, toolName: tool.name })),
      );
    } finally {
      setIsUpdatingAll(false);
    }
  }

  async function handleToggleAllOff() {
    const enabledSkillNames = skillRows
      .filter((item) => item.isEnabled)
      .map((item) => item.skillName);
    if (enabledSkillNames.length === 0) {
      return;
    }

    setIsUpdatingAll(true);
    try {
      await Promise.all(
        enabledSkillNames.map((skillName) => toggleSkillTool({ skillName, toolName: tool.name })),
      );
    } finally {
      setIsUpdatingAll(false);
    }
  }

  if (!isOpen) {
    return null;
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="tool-manage-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="tool-manage-dialog__header">
          <div className="tool-manage-dialog__title">
            <h3 id={dialogTitleId}>配置启用 Skills</h3>
            <p>
              {tool.name} 已启用 {enabledCount}/{installedSkills.length} 个 Skills
            </p>
          </div>
          <button
            className="tool-manage-dialog__close"
            type="button"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <div className="tool-manage-dialog__toolbar">
          <input
            className="tool-manage-dialog__search"
            type="search"
            placeholder="搜索 Skills"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="tool-manage-dialog__toggle">
            <button
              className={`switch-button${showEnabledOnly ? " is-enabled" : ""}`}
              type="button"
              onClick={() => setShowEnabledOnly((current) => !current)}
              aria-pressed={showEnabledOnly}
              aria-label="只看已启用"
            >
              <span className="switch-button__thumb" />
            </button>
            <span>只看已启用</span>
          </label>
          <div className="tool-manage-dialog__bulk-actions">
            <button
              className="secondary-button secondary-button--compact"
              type="button"
              onClick={() => void handleToggleAllOn()}
              disabled={isUpdatingAll || disabledVisibleCount === 0}
            >
              {isUpdatingAll ? "处理中..." : "全部开启"}
            </button>
            <button
              className="secondary-button secondary-button--compact"
              type="button"
              onClick={() => void handleToggleAllOff()}
              disabled={isUpdatingAll || enabledVisibleCount === 0}
            >
              {isUpdatingAll ? "处理中..." : "全部关闭"}
            </button>
          </div>
        </div>
        <div className="tool-manage-dialog__list">
          {skillRows.map((item) => (
            <div
              key={item.skillName}
              className={`tool-manage-dialog__item${item.isEnabled ? " is-enabled" : ""}`}
            >
              <span>{item.skillName}</span>
              <button
                className={`switch-button${item.isEnabled ? " is-enabled" : ""}`}
                type="button"
                onClick={() => void toggleSkillTool({ skillName: item.skillName, toolName: tool.name })}
                aria-pressed={item.isEnabled}
                aria-label={`${item.isEnabled ? "关闭" : "启用"} ${item.skillName}`}
              >
                <span className="switch-button__thumb" />
              </button>
            </div>
          ))}
          {skillRows.length === 0 ? (
            <div className="tool-manage-dialog__empty">没有匹配的 skill。</div>
          ) : null}
        </div>
        <div className="tool-manage-dialog__actions">
          <button
            className="primary-button primary-button--compact"
            type="button"
            onClick={onClose}
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
