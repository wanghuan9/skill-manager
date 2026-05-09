import type { SkillToolSyncStatus, ToolConfig } from "@/features/skills/state/skill-store";
import { OPEN_ONLY_TOOL_IDS } from "@/features/skills/utils/open-tools";
import { isToolEnabledStatus } from "@/features/skills/utils/tool-status";

export function mergeSkillToolsWithInstalledTools(
  tools: SkillToolSyncStatus[],
  toolConfigs: ToolConfig[],
): SkillToolSyncStatus[] {
  const toolStatusMap = new Map(tools.map((tool) => [tool.name, tool.statusLabel]));

  return toolConfigs
    .filter((tool) => tool.statusLabel === "已安装" && !OPEN_ONLY_TOOL_IDS.has(tool.id))
    .map((tool) => ({
      name: tool.name,
      statusLabel: toolStatusMap.get(tool.name) ?? "未启用",
    }));
}

export function countEnabledSkillTools(tools: SkillToolSyncStatus[]) {
  return tools.filter((tool) => isToolEnabledStatus(tool.statusLabel)).length;
}
