import { tx } from "@/app/i18n";
import type { AppLanguage, ToolConfig, ToolSurfaceType, ToolType } from "@/features/skills/state/skill-store";
import { isToolInstalledStatus } from "@/features/skills/utils/tool-status";

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
  supportsMcp: boolean;
  mcpConfigPathRecognized: boolean;
  surfaceTypes: ToolSurfaceType[];
  supportsDirectOpen: boolean;
};

const DEFAULT_OPEN_TOOL_PRIORITY = [
  "cursor",
  "vscode",
  "windsurf",
  "antigravity",
  "trae",
  "trae-cn",
  "qoder",
] as const;

const TOOL_POPULARITY_RANK: Record<string, number> = {
  cursor: 1,
  "claude-code": 2,
  "github-copilot": 3,
  windsurf: 4,
  codex: 5,
  zcode: 6,
  intellij: 7,
  vscode: 8,
  gemini: 9,
  kiro: 10,
  opencode: 11,
  antigravity: 12,
  continue: 13,
  cline: 14,
  augment: 15,
  trae: 16,
  junie: 17,
  "qwen-code": 18,
  "roo-code": 19,
  "kilo-code": 20,
  zencoder: 21,
  qoder: 22,
  goose: 23,
  crush: 24,
  codebuddy: 25,
  "trae-cn": 26,
  openclaw: 27,
  droid: 28,
  iflow: 29,
  commandcode: 30,
  hermes: 31,
  pi: 32,
  omp: 33,
  grok: 34,
  "mimo-code": 35,
  workbuddy: 36,
};

export const OPEN_ONLY_TOOL_IDS = new Set(["intellij", "vscode"]);
export const FINDER_OPEN_TOOL_ID = "finder";

export function getFinderOpenToolOption(language: AppLanguage): OpenToolOption {
  return {
    id: FINDER_OPEN_TOOL_ID,
    name: tx(language, "tools.finder"),
    primaryType: "desktop",
  };
}

export function getPrimaryToolTypeLabels(language: AppLanguage): Record<ToolType, string> {
  return {
    editor: tx(language, "tools.type.editor"),
    cli: tx(language, "tools.type.cli"),
    desktop: tx(language, "tools.type.desktop"),
  };
}

export function getToolSurfaceLabels(language: AppLanguage): Record<ToolSurfaceType, string> {
  return {
    editor: tx(language, "tools.surface.editor"),
    cli: tx(language, "tools.surface.cli"),
    desktop: tx(language, "tools.surface.desktop"),
    "ide-plugin": tx(language, "tools.surface.ide-plugin"),
  };
}

function toOpenToolCard(tool: ToolConfig): OpenToolCard {
  return {
    id: tool.id,
    name: tool.name,
    primaryType: tool.primaryType,
    statusLabel: tool.statusLabel,
    isInstalled: isToolInstalledStatus(tool.statusLabel),
    skillsPath: tool.skillsPath,
    mcpConfigPath: tool.mcpConfigPath,
    supportsMcp: tool.supportsMcp,
    mcpConfigPathRecognized: tool.mcpConfigPathRecognized,
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

export function buildOpenToolOptions(toolConfigs: ToolConfig[], language: AppLanguage): OpenToolOption[] {
  const finderOption = getFinderOpenToolOption(language);
  const installedEditorOptions = toolConfigs
    .map(toOpenToolCard)
    .filter(isDirectOpenEditorTool)
    .map(({ id, name, primaryType }) => ({ id, name, primaryType }));

  return [...installedEditorOptions, finderOption];
}

export function isDirectOpenEditorTool(tool: Pick<OpenToolCard, "id" | "isInstalled" | "primaryType" | "supportsDirectOpen">) {
  return (
    tool.id !== FINDER_OPEN_TOOL_ID &&
    tool.isInstalled &&
    tool.primaryType === "editor" &&
    tool.supportsDirectOpen
  );
}

export function resolveDefaultOpenToolId(toolConfigs: ToolConfig[]): string {
  const installedDirectOpenTools = toolConfigs
    .map(toOpenToolCard)
    .filter(isDirectOpenEditorTool);

  for (const preferredToolId of DEFAULT_OPEN_TOOL_PRIORITY) {
    const preferredTool = installedDirectOpenTools.find((tool) => tool.id === preferredToolId);
    if (preferredTool) {
      return preferredTool.id;
    }
  }

  return installedDirectOpenTools[0]?.id ?? FINDER_OPEN_TOOL_ID;
}

export function resolvePreferredEditorIdForTextFile(
  toolConfigs: ToolConfig[],
  preferredToolId?: string,
): string | undefined {
  const preferredTool = toolConfigs
    .map(toOpenToolCard)
    .find((tool) => tool.id === preferredToolId);

  if (!preferredTool || !isDirectOpenEditorTool(preferredTool)) {
    return undefined;
  }

  return preferredTool.id;
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
