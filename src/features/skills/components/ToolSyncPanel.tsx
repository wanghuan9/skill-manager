import { useEffect, useRef, useState } from "react";
import { waitForNextPaint } from "@/app/utils/wait-for-next-paint";
import { useFailureReporter } from "@/app/failure-feedback";
import type { SkillToolSyncStatus } from "@/features/skills/state/skill-store";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { resolveToolLogoUrl } from "@/features/skills/utils/tool-logo";
import { isToolEnabledStatus } from "@/features/skills/utils/tool-status";

type ToolSyncPanelProps = {
  skillName: string;
  tools: SkillToolSyncStatus[];
};

function patchToolStatuses(
  tools: SkillToolSyncStatus[],
  targetToolNames: Set<string>,
  enabled: boolean,
) {
  return tools.map((tool) => (
    targetToolNames.has(tool.name)
      ? { ...tool, statusLabel: enabled ? "已启用" : "未启用" }
      : tool
  ));
}

function patchAllToolStatuses(tools: SkillToolSyncStatus[], enabled: boolean) {
  return tools.map((tool) => ({
    ...tool,
    statusLabel: enabled ? "已启用" : "未启用",
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
    setDisplayTools((current) => patchToolStatuses(current, new Set([toolName]), nextEnabled));
    setPendingToolNames((current) => [...current, toolName]);

    try {
      await toggleSkillTool({
        skillName,
        toolName,
        toolNames: displayTools.map((tool) => tool.name),
      });
    } catch (error) {
      setDisplayTools((current) => patchToolStatuses(current, new Set([toolName]), previousEnabled));
      reportFailure(error, {
        operation: "toggle_skill_tool",
        fallbackMessage: "切换 Tool 启用状态失败",
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
      reportFailure(new Error(`已${enabled ? "开启" : "关闭"} ${toolNames.length - failedToolNames.length} 个工具，${failedToolNames.length} 个失败：${failedToolNames.join("、")}`), {
        operation: "sync_all_skill_tools",
        fallbackMessage: "批量更新 Tool 启用状态失败",
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
    setDisplayTools((current) => patchAllToolStatuses(current, enabled));
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
        <h4>启用到工具</h4>
        <div className="tool-sync-panel__actions">
          <button
            className="secondary-button secondary-button--compact"
            type="button"
            onClick={() => void handleToggleAllTools(true)}
            disabled={isBulkUpdating || pendingToolNames.length > 0 || disabledTools.length === 0}
          >
            {bulkAction === "enable" ? "开启中..." : "全部开启"}
          </button>
          <button
            className="secondary-button secondary-button--compact"
            type="button"
            onClick={() => void handleToggleAllTools(false)}
            disabled={isBulkUpdating || pendingToolNames.length > 0 || enabledTools.length === 0}
          >
            {bulkAction === "disable" ? "关闭中..." : "全部关闭"}
          </button>
        </div>
      </div>
      <div className="tool-pill-grid">
        {displayTools.map((tool) => {
          const enabled = isToolEnabledStatus(tool.statusLabel);
          const logoUrl = resolveToolLogoUrl(tool.name);
          const tooltipLabel = enabled ? "已启用，点击关闭" : "未启用，点击启用";

          return (
            <button
              key={tool.name}
              className={`tool-pill${enabled ? " is-enabled" : ""}`}
              type="button"
              onClick={() => void handleToggleTool(tool.name)}
              aria-pressed={enabled}
              aria-label={`${enabled ? "取消启用" : "启用"} ${tool.name}`}
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
              <span className="sr-only">{enabled ? "已启用" : "未启用"}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
