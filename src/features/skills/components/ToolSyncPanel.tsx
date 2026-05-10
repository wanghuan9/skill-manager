import type { SkillToolSyncStatus } from "@/features/skills/state/skill-store";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { getToolLogoUrl } from "@/features/skills/utils/tool-logo";
import { isToolEnabledStatus } from "@/features/skills/utils/tool-status";

type ToolSyncPanelProps = {
  skillName: string;
  tools: SkillToolSyncStatus[];
};

const TOOL_NAME_IDS: Record<string, string> = {
  "Claude Code": "claude-code",
  "Gemini CLI": "gemini",
  "GitHub Copilot": "github-copilot",
  "IntelliJ IDEA": "intellij",
  "Kilo Code": "kilo-code",
  OpenCode: "opencode",
  OpenClaw: "openclaw",
  "Qwen Code": "qwen-code",
  "Roo Code": "roo-code",
  "Trae CN": "trae-cn",
};

function resolveToolLogoUrl(toolName: string) {
  const toolId = TOOL_NAME_IDS[toolName] ?? toolName.toLowerCase().replace(/\s+/g, "-");

  return getToolLogoUrl(toolId);
}

export function ToolSyncPanel({ skillName, tools }: ToolSyncPanelProps) {
  const { toggleSkillTool } = useSkillWorkspace();

  return (
    <section>
      <h4>启用到工具</h4>
      <div className="tool-pill-grid">
        {tools.map((tool) => {
          const enabled = isToolEnabledStatus(tool.statusLabel);
          const logoUrl = resolveToolLogoUrl(tool.name);
          const tooltipLabel = enabled ? "已启用，点击关闭" : "未启用，点击启用";

          return (
            <button
              key={tool.name}
              className={`tool-pill${enabled ? " is-enabled" : ""}`}
              type="button"
              onClick={() => void toggleSkillTool({ skillName, toolName: tool.name })}
              aria-pressed={enabled}
              aria-label={`${enabled ? "取消启用" : "启用"} ${tool.name}`}
              data-tooltip={tooltipLabel}
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
