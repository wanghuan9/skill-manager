import { useEffect, useRef, useState } from "react";
import { useTranslate } from "@/app/i18n";
import { waitForNextPaint } from "@/app/utils/wait-for-next-paint";
import { useFailureReporter } from "@/app/failure-feedback";
import type { SkillToolSyncStatus } from "@/features/skills/state/skill-store";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { resolveToolLogoUrl } from "@/features/skills/utils/tool-logo";
import { getToolStatusLabel, isToolEnabledStatus } from "@/features/skills/utils/tool-status";

type ToolSyncPanelProps = {
  skillName: string;
  tools: SkillToolSyncStatus[];
};

function patchToolStatuses(
  tools: SkillToolSyncStatus[],
  targetToolNames: Set<string>,
  nextStatusLabel: string,
) {
  return tools.map((tool) => (
    targetToolNames.has(tool.name)
      ? { ...tool, statusLabel: nextStatusLabel }
      : tool
  ));
}

function patchAllToolStatuses(tools: SkillToolSyncStatus[], nextStatusLabel: string) {
  return tools.map((tool) => ({
    ...tool,
    statusLabel: nextStatusLabel,
  }));
}

function isMissingBulkCommandError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("set_skill_all_tool_statuses")
    || message.includes("unknown command")
    || message.includes("not found");
}

export function ToolSyncPanel({ skillName, tools }: ToolSyncPanelProps) {
  const { language, t } = useTranslate();
  const { setSkillAllToolStatuses, setToolSkillStatuses, toggleSkillTool } = useSkillWorkspace();
  const reportFailure = useFailureReporter();
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [bulkAction, setBulkAction] = useState<"enable" | "disable" | null>(null);
  const [displayTools, setDisplayTools] = useState(tools);
  const [pendingToolNames, setPendingToolNames] = useState<string[]>([]);
  const latestToolsRef = useRef(tools);
  const enabledTools = displayTools.filter((tool) => isToolEnabledStatus(tool.statusLabel));
  const disabledTools = displayTools.filter((tool) => !isToolEnabledStatus(tool.statusLabel));

  useEffect(() => {
    latestToolsRef.current = tools;
    setDisplayTools(tools);
  }, [tools]);

  async function handleToggleTool(toolName: string) {
    if (isBulkUpdating || pendingToolNames.includes(toolName)) {
      return;
    }

    const targetTool = displayTools.find((tool) => tool.name === toolName);
    const previousEnabled = targetTool ? isToolEnabledStatus(targetTool.statusLabel) : false;
    const nextEnabled = !previousEnabled;
    setDisplayTools((current) =>
      patchToolStatuses(
        current,
        new Set([toolName]),
        getToolStatusLabel(nextEnabled ? "enabled" : "disabled", language),
      )
    );
    setPendingToolNames((current) => [...current, toolName]);

    try {
      await toggleSkillTool({
        skillName,
        toolName,
        toolNames: displayTools.map((tool) => tool.name),
      });
    } catch (error) {
      setDisplayTools((current) =>
        patchToolStatuses(
          current,
          new Set([toolName]),
          getToolStatusLabel(previousEnabled ? "enabled" : "disabled", language),
        )
      );
        reportFailure(error, {
        operation: "toggle_skill_tool",
        fallbackMessage: t("skill.tools.error.toggle"),
        context: { skillName, toolName },
      });
    } finally {
      setPendingToolNames((current) => current.filter((name) => name !== toolName));
    }
  }

  async function syncAllToolsInBackground(enabled: boolean) {
    const toolNames = latestToolsRef.current.map((tool) => tool.name);
    const failedToolNames: string[] = [];

    try {
      await setSkillAllToolStatuses({
        skillName,
        enabled,
        toolNames: toolNames,
      });
    } catch (error) {
      if (isMissingBulkCommandError(error)) {
        for (const toolName of toolNames) {
          try {
            await setToolSkillStatuses({
              toolName,
              skillNames: [skillName],
              enabled,
              toolNames,
            });
          } catch {
            failedToolNames.push(toolName);
          }
        }
      } else {
        failedToolNames.push(...toolNames);
      }
    }

    if (failedToolNames.length > 0) {
      setDisplayTools(latestToolsRef.current);
      reportFailure(new Error(t("skill.tools.bulkResult", {
        action: t(enabled ? "skill.tools.action.enable" : "skill.tools.action.disable"),
        success: toolNames.length - failedToolNames.length,
        failed: failedToolNames.length,
        names: failedToolNames.join("、"),
      })), {
        operation: "sync_all_skill_tools",
        fallbackMessage: t("skill.tools.error.toggle"),
        context: { skillName, enabled, failedToolNames },
      });
    }
  }

  async function handleToggleAllTools(enabled: boolean) {
    const hasTargetTools = enabled ? disabledTools.length > 0 : enabledTools.length > 0;
    if (!hasTargetTools || isBulkUpdating || pendingToolNames.length > 0) {
      return;
    }

    const previousTools = displayTools;
    setDisplayTools((current) =>
      patchAllToolStatuses(current, getToolStatusLabel(enabled ? "enabled" : "disabled", language))
    );
    setIsBulkUpdating(true);
    setBulkAction(enabled ? "enable" : "disable");

    try {
      await waitForNextPaint();
      await syncAllToolsInBackground(enabled);
    } catch {
      setDisplayTools(previousTools);
    } finally {
      setIsBulkUpdating(false);
      setBulkAction(null);
    }
  }

  return (
    <section>
      <div className="skill-card__section-header">
        <h4>{t("skill.tools.title")}</h4>
        <div className="tool-sync-panel__actions">
          <button
            className="secondary-button secondary-button--compact"
            type="button"
            onClick={() => void handleToggleAllTools(true)}
            disabled={isBulkUpdating || pendingToolNames.length > 0 || disabledTools.length === 0}
          >
            {bulkAction === "enable" ? t("skill.tools.enableAllLoading") : t("skill.tools.enableAll")}
          </button>
          <button
            className="secondary-button secondary-button--compact"
            type="button"
            onClick={() => void handleToggleAllTools(false)}
            disabled={isBulkUpdating || pendingToolNames.length > 0 || enabledTools.length === 0}
          >
            {bulkAction === "disable" ? t("skill.tools.disableAllLoading") : t("skill.tools.disableAll")}
          </button>
        </div>
      </div>
      <div className="tool-pill-grid">
        {displayTools.map((tool) => {
          const enabled = isToolEnabledStatus(tool.statusLabel);
          const logoUrl = resolveToolLogoUrl(tool.name);
          const tooltipLabel = enabled ? t("skill.tools.tooltip.enabled") : t("skill.tools.tooltip.disabled");

          return (
            <button
              key={tool.name}
              className={`tool-pill${enabled ? " is-enabled" : ""}`}
              type="button"
              onClick={() => void handleToggleTool(tool.name)}
              aria-pressed={enabled}
              aria-label={enabled ? t("skill.tools.aria.disable", { name: tool.name }) : t("skill.tools.aria.enable", { name: tool.name })}
              data-tooltip={tooltipLabel}
              disabled={isBulkUpdating || pendingToolNames.includes(tool.name)}
            >
              <span className="tool-pill__logo" aria-hidden="true">
                {logoUrl ? (
                  <img src={logoUrl} alt="" />
                ) : (
                  <span>{tool.name.slice(0, 1)}</span>
                )}
              </span>
              <span className="tool-pill__name">{tool.name}</span>
              <span className="sr-only">{enabled ? t("settings.toggle.on") : t("settings.toggle.off")}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
