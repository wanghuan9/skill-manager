import type { ToolConfig, ToolSurfaceType, ToolType } from "@/features/skills/state/skill-store";

export type OpenToolOption = {
  id: string;
  name: string;
  primaryType: ToolType;
};

export type OpenToolCard = OpenToolOption & {
  statusLabel: string;
  isInstalled: boolean;
  skillsPath: string;
  mcpConfigPath: string;
  surfaceTypes: ToolSurfaceType[];
  supportsDirectOpen: boolean;
};

export const FINDER_OPEN_TOOL_OPTION: OpenToolOption = {
  id: "finder",
  name: "访达",
  primaryType: "desktop",
};

const TOOL_POPULARITY_RANK: Record<string, number> = {
  cursor: 1,
  "claude-code": 2,
  "github-copilot": 3,
  windsurf: 4,
  codex: 5,
  gemini: 6,
  kiro: 7,
  opencode: 8,
  antigravity: 9,
  continue: 10,
  cline: 11,
  augment: 12,
  trae: 13,
  junie: 14,
  "qwen-code": 15,
  "roo-code": 16,
  "kilo-code": 17,
  zencoder: 18,
  qoder: 19,
  goose: 20,
  crush: 21,
  codebuddy: 22,
  "trae-cn": 23,
  openclaw: 24,
  droid: 25,
  iflow: 26,
  commandcode: 27,
  hermes: 28,
};

export const PRIMARY_TOOL_TYPE_LABELS: Record<ToolType, string> = {
  editor: "编辑器",
  cli: "CLI",
  desktop: "桌面应用",
};

export const TOOL_SURFACE_LABELS: Record<ToolSurfaceType, string> = {
  editor: "编辑器",
  cli: "CLI",
  desktop: "桌面应用",
  "ide-plugin": "IDE 集成",
};

function toOpenToolCard(tool: ToolConfig): OpenToolCard {
  return {
    id: tool.id,
    name: tool.name,
    primaryType: tool.primaryType,
    statusLabel: tool.statusLabel,
    isInstalled: tool.statusLabel === "已安装",
    skillsPath: tool.skillsPath,
    mcpConfigPath: tool.mcpConfigPath,
    surfaceTypes: tool.surfaceTypes,
    supportsDirectOpen: tool.supportsDirectOpen,
  };
}

export function buildSupportedAiToolCards(toolConfigs: ToolConfig[]): OpenToolCard[] {
  return toolConfigs.map(toOpenToolCard);
}

export function buildInstalledToolCards(toolConfigs: ToolConfig[]): OpenToolCard[] {
  return buildSupportedAiToolCards(toolConfigs).filter((tool) => tool.isInstalled);
}

export function buildOpenToolOptions(toolConfigs: ToolConfig[]): OpenToolOption[] {
  const installedEditorOptions = buildSupportedAiToolCards(toolConfigs)
    .filter(
      (tool) =>
        tool.id !== FINDER_OPEN_TOOL_OPTION.id &&
        tool.isInstalled &&
        tool.primaryType === "editor" &&
        tool.supportsDirectOpen,
    )
    .map(({ id, name, primaryType }) => ({ id, name, primaryType }));

  return [...installedEditorOptions, FINDER_OPEN_TOOL_OPTION];
}

export function sortToolCards<T extends OpenToolCard>(toolCards: T[], defaultOpenToolId?: string) {
  return [...toolCards].sort((left, right) => {
    const leftDefaultRank = left.id === defaultOpenToolId ? 0 : 1;
    const rightDefaultRank = right.id === defaultOpenToolId ? 0 : 1;
    if (leftDefaultRank !== rightDefaultRank) {
      return leftDefaultRank - rightDefaultRank;
    }

    const leftPopularityRank = TOOL_POPULARITY_RANK[left.id] ?? Number.MAX_SAFE_INTEGER;
    const rightPopularityRank = TOOL_POPULARITY_RANK[right.id] ?? Number.MAX_SAFE_INTEGER;
    if (leftPopularityRank !== rightPopularityRank) {
      return leftPopularityRank - rightPopularityRank;
    }

    return left.name.localeCompare(right.name);
  });
}
