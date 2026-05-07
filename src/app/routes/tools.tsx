import { useMemo, useState } from "react";
import { ToolManageDialog } from "@/features/skills/components/ToolManageDialog";
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

export function ToolsRoute() {
  const { defaultOpenToolId, toolConfigs } = useSkillWorkspace();
  const installedTools = useMemo(
    () => sortToolCards(buildInstalledToolCards(toolConfigs), defaultOpenToolId),
    [defaultOpenToolId, toolConfigs],
  );
  const [managingToolId, setManagingToolId] = useState("");
  const managingTool = installedTools.find((tool) => tool.id === managingToolId) ?? null;

  return (
    <div className="tools-route">
      <section className="tools-section">
        <div className="tool-card-grid">
          {installedTools.map((tool) => {
            const isDefault = tool.id === defaultOpenToolId;

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
                  <span className="tool-card__meta tool-card__meta--path" title={tool.skillsPath}>
                    Skills 路径：{tool.skillsPath}
                  </span>
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
