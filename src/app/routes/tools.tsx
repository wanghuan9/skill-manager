import { useMemo, useState } from "react";
import { useTranslate } from "@/app/i18n";
import { ToolManageDialog } from "@/features/skills/components/ToolManageDialog";
import { useFailureReporter } from "@/app/failure-feedback";
import { openToolMcpConfig, openToolSkillsFolder } from "@/features/skills/api/skill-client";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";
import {
  buildInstalledToolCards,
  getPrimaryToolTypeLabels,
  resolvePreferredEditorIdForTextFile,
  sortToolCards,
  getToolSurfaceLabels,
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

function EditorOpenIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M4 3.7h6.2l3.8 3.8v6.8H4V3.7Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M10.2 3.8v3.8H14M6.3 10.1h5.4M6.3 12.4h3.8"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ToolsRoute() {
  const { language, t } = useTranslate();
  const { defaultOpenToolId, toolConfigs } = useSkillWorkspace();
  const reportFailure = useFailureReporter();
  const installedTools = useMemo(
    () => sortToolCards(buildInstalledToolCards(toolConfigs), defaultOpenToolId),
    [defaultOpenToolId, toolConfigs],
  );
  const primaryToolTypeLabels = useMemo(() => getPrimaryToolTypeLabels(language), [language]);
  const toolSurfaceLabels = useMemo(() => getToolSurfaceLabels(language), [language]);
  const [managingToolId, setManagingToolId] = useState("");
  const [openingToolId, setOpeningToolId] = useState("");
  const [openingMcpToolId, setOpeningMcpToolId] = useState("");
  const managingTool = installedTools.find((tool) => tool.id === managingToolId) ?? null;

  async function handleOpenSkillsFolder(toolId: string) {
    if (openingToolId) {
      return;
    }

    setOpeningToolId(toolId);
    try {
      await openToolSkillsFolder({ toolId });
    } catch (error) {
      reportFailure(error, {
        operation: "open_tool_skills_folder",
        fallbackMessage: t("tools.error.openSkillsFolder"),
      });
    } finally {
      setOpeningToolId("");
    }
  }

  async function handleOpenMcpConfig(toolId: string) {
    if (openingMcpToolId) {
      return;
    }

    setOpeningMcpToolId(toolId);
    try {
      const preferredEditorId = resolvePreferredEditorIdForTextFile(toolConfigs, defaultOpenToolId);
      await openToolMcpConfig({ toolId, editorId: preferredEditorId });
    } catch (error) {
      reportFailure(error, {
        operation: "open_tool_mcp_config",
        fallbackMessage: t("tools.error.openMcpConfig"),
      });
    } finally {
      setOpeningMcpToolId("");
    }
  }

  return (
    <div className="tools-route">
      <section className="tools-section">
        <div className="tool-card-grid">
          {installedTools.map((tool) => {
            const isDefault = tool.id === defaultOpenToolId;
            const isOpeningFolder = openingToolId === tool.id;
            const isOpeningMcpConfig = openingMcpToolId === tool.id;
            const mcpConfigPath = !tool.supportsMcp
              ? t("tools.mcpUnsupported")
              : !tool.mcpConfigPathRecognized
                ? t("tools.mcpPathUnmodeled")
                : tool.mcpConfigPath || t("tools.pathUnknown");

            return (
              <article key={tool.id} className="tool-card tool-card--simple">
                <div className="tool-card__header">
                  <div className="tool-card__header-copy">
                    <div className="tool-card__title-row">
                      <ToolLogo toolId={tool.id} toolName={tool.name} />
                      <strong>{tool.name}</strong>
                      <div className="tool-card__status-badges">
                        <span className="status-badge tone-neutral">
                          {primaryToolTypeLabels[tool.primaryType]}
                        </span>
                        {isDefault ? <span className="status-badge tone-info">{t("tools.default")}</span> : null}
                      </div>
                    </div>
                  </div>
                  <button
                    className="primary-button primary-button--compact tool-card__manage-button"
                    type="button"
                    onClick={() => setManagingToolId(tool.id)}
                  >
                    {t("tools.manage")}
                  </button>
                </div>
                <div className="tool-card__simple-copy">
                  <span>{t("tools.surface", { value: tool.surfaceTypes.map((surface) => toolSurfaceLabels[surface]).join(" / ") })}</span>
                  <div className="tool-card__path-row">
                    <span className="tool-card__path-label">{t("tools.skillsPath")}</span>
                    <span className="tool-card__path-value" title={tool.skillsPath}>
                      {tool.skillsPath}
                    </span>
                    <button
                      className="tool-card__path-button"
                      type="button"
                      onClick={() => void handleOpenSkillsFolder(tool.id)}
                      aria-label={t("tools.openSkillsFolder", { name: tool.name })}
                      data-tooltip={t("tools.openInFinder")}
                      disabled={Boolean(openingToolId)}
                    >
                      <FolderOpenIcon />
                      <span className="sr-only">{isOpeningFolder ? t("tools.opening") : t("tools.openFolder")}</span>
                    </button>
                  </div>
                  <div className="tool-card__path-row">
                    <span className="tool-card__path-label">{t("tools.mcpConfig")}</span>
                    <span className="tool-card__path-value" title={tool.mcpConfigPath || undefined}>
                      {mcpConfigPath}
                    </span>
                    <button
                      className="tool-card__path-button"
                      type="button"
                      onClick={() => void handleOpenMcpConfig(tool.id)}
                      aria-label={t("tools.openMcpConfig", { name: tool.name })}
                      data-tooltip={t("tools.openInEditor")}
                      disabled={
                        Boolean(openingMcpToolId) ||
                        !tool.supportsMcp ||
                        !tool.mcpConfigPathRecognized ||
                        !tool.mcpConfigPath
                      }
                    >
                      <EditorOpenIcon />
                      <span className="sr-only">{isOpeningMcpConfig ? t("tools.opening") : t("tools.openConfig")}</span>
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
