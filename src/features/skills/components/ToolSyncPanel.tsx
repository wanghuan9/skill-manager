import type { SkillToolSyncStatus } from "@/features/skills/state/skill-store";
import { useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import { isToolEnabledStatus } from "@/features/skills/utils/tool-status";

type ToolSyncPanelProps = {
  skillName: string;
  tools: SkillToolSyncStatus[];
};

export function ToolSyncPanel({ skillName, tools }: ToolSyncPanelProps) {
  const { toggleSkillTool } = useSkillWorkspace();

  return (
    <section>
      <h4>启用到应用</h4>
      <div className="tool-pill-grid">
        {tools.map((tool) => {
          const enabled = isToolEnabledStatus(tool.statusLabel);

          return (
            <div key={tool.name} className="tool-pill">
              <span className="tool-pill__name">{tool.name}</span>
              <button
                className={`sync-button sync-button--compact sync-switch${enabled ? " is-enabled" : ""}`}
                type="button"
                onClick={() => void toggleSkillTool({ skillName, toolName: tool.name })}
                aria-label={`${enabled ? "取消启用" : "启用"} ${tool.name}`}
                title={enabled ? "已启用" : "启用到该工具"}
              >
                <span className="sr-only">{enabled ? "已启用" : "未启用"}</span>
                <span className="sync-switch__thumb" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
