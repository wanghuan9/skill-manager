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
  intellij: 6,
  gemini: 7,
  kiro: 8,
  opencode: 9,
  antigravity: 10,
  continue: 11,
  cline: 12,
  augment: 13,
  trae: 14,
  junie: 15,
  "qwen-code": 16,
  "roo-code": 17,
  "kilo-code": 18,
  zencoder: 19,
  qoder: 20,
  goose: 21,
  crush: 22,
  codebuddy: 23,
  "trae-cn": 24,
  openclaw: 25,
  droid: 26,
  iflow: 27,
  commandcode: 28,
  hermes: 29,
};

export const OPEN_ONLY_TOOL_IDS = new Set(["intellij"]);

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
  return toolConfigs
    .filter((tool) => !OPEN_ONLY_TOOL_IDS.has(tool.id))
    .map(toOpenToolCard);
}

export function buildInstalledToolCards(toolConfigs: ToolConfig[]): OpenToolCard[] {
  return buildSupportedAiToolCards(toolConfigs).filter((tool) => tool.isInstalled);
}

export function buildOpenToolOptions(toolConfigs: ToolConfig[]): OpenToolOption[] {
  const installedEditorOptions = toolConfigs
    .map(toOpenToolCard)
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
