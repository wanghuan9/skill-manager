import { useMemo, useState } from "react";
import { ToolManageDialog } from "@/features/skills/components/ToolManageDialog";
import { openToolSkillsFolder } from "@/features/skills/api/skill-client";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";
import {
  buildInstalledToolCards,
  PRIMARY_TOOL_TYPE_LABELS,
  sortToolCards,
  TOOL_SURFACE_LABELS,
} from "@/features/skills/utils/open-tools";

type ToolLogoProps = {
  toolId: string;
  toolName: string;
};

function ToolLogo({ toolId, toolName }: ToolLogoProps) {
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const logoUrl = getToolLogoUrl(toolId);
  const fallbackLabel = toolName.slice(0, 1).toUpperCase();

  if (!logoUrl || logoLoadFailed) {
    return (
      <span className="tool-card__logo" aria-hidden="true">
        {fallbackLabel}
      </span>
    );
  }

  return (
    <span className="tool-card__logo">
      <img
        className="tool-card__logo-image"
        src={logoUrl}
        alt={`${toolName} logo`}
        loading="lazy"
        onError={() => setLogoLoadFailed(true)}
      />
    </span>
  );
}

function FolderOpenIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M2.75 5.25A1.5 1.5 0 0 1 4.25 3.75h3.1l1.2 1.35h4.95A1.5 1.5 0 0 1 15 6.6v1.15"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <path
        d="M3.15 7.75h11.7l-.7 4.7a1.5 1.5 0 0 1-1.48 1.28H4.98a1.5 1.5 0 0 1-1.48-1.28l-.35-2.35"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ToolsRoute() {
  const { defaultOpenToolId, toolConfigs } = useSkillWorkspace();
  const installedTools = useMemo(
    () => sortToolCards(buildInstalledToolCards(toolConfigs), defaultOpenToolId),
    [defaultOpenToolId, toolConfigs],
  );
  const [managingToolId, setManagingToolId] = useState("");
  const [openingToolId, setOpeningToolId] = useState("");
  const managingTool = installedTools.find((tool) => tool.id === managingToolId) ?? null;

  async function handleOpenSkillsFolder(toolId: string) {
    if (openingToolId) {
      return;
    }

    setOpeningToolId(toolId);
    try {
      await openToolSkillsFolder({ toolId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "打开 Skills 文件夹失败";
      window.alert(message);
    } finally {
      setOpeningToolId("");
    }
  }

  return (
    <div className="tools-route">
      <section className="tools-section">
        <div className="tool-card-grid">
          {installedTools.map((tool) => {
            const isDefault = tool.id === defaultOpenToolId;
            const isOpeningFolder = openingToolId === tool.id;

            return (
              <article key={tool.id} className="tool-card tool-card--simple">
                <div className="tool-card__header">
                  <div className="tool-card__header-copy">
                    <div className="tool-card__title-row">
                      <ToolLogo toolId={tool.id} toolName={tool.name} />
                      <strong>{tool.name}</strong>
                      <div className="tool-card__status-badges">
                        <span className="status-badge tone-neutral">
                          {PRIMARY_TOOL_TYPE_LABELS[tool.primaryType]}
                        </span>
                        {isDefault ? <span className="status-badge tone-info">默认打开</span> : null}
                      </div>
                    </div>
                  </div>
                  <button
                    className="primary-button primary-button--compact tool-card__manage-button"
                    type="button"
                    onClick={() => setManagingToolId(tool.id)}
                  >
                    管理
                  </button>
                </div>
                <div className="tool-card__simple-copy">
                  <span>形态：{tool.surfaceTypes.map((surface) => TOOL_SURFACE_LABELS[surface]).join(" / ")}</span>
                  <div className="tool-card__path-row">
                    <span className="tool-card__path-label">Skills 路径：</span>
                    <span className="tool-card__path-value" title={tool.skillsPath}>
                      {tool.skillsPath}
                    </span>
                    <button
                      className="tool-card__path-button"
                      type="button"
                      onClick={() => void handleOpenSkillsFolder(tool.id)}
                      aria-label={`打开 ${tool.name} Skills 文件夹`}
                      data-tooltip="在访达中打开"
                      disabled={Boolean(openingToolId)}
                    >
                      <FolderOpenIcon />
                      <span className="sr-only">{isOpeningFolder ? "正在打开" : "打开文件夹"}</span>
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      {managingTool ? (
        <ToolManageDialog
          isOpen
          tool={managingTool}
          onClose={() => setManagingToolId("")}
        />
      ) : null}
    </div>
  );
}
