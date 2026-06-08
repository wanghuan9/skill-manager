import toolLogoManifest from "./tool-logo-manifest.json";

const TOOL_LOGO_URLS: Record<string, string> = toolLogoManifest;

const TOOL_NAME_IDS: Record<string, string> = {
  "Claude Code": "claude-code",
  Devin: "windsurf",
  "Gemini CLI": "gemini",
  "GitHub Copilot": "github-copilot",
  "IntelliJ IDEA": "intellij",
  "Kilo Code": "kilo-code",
  OpenCode: "opencode",
  OpenClaw: "openclaw",
  "Qwen Code": "qwen-code",
  "Roo Code": "roo-code",
  "Trae CN": "trae-cn",
  Windsurf: "windsurf",
};

const TOOL_DISPLAY_ORDER = [
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "gemini",
  "antigravity",
  "windsurf",
  "intellij",
  "openclaw",
  "continue",
  "iflow",
  "kiro",
  "github-copilot",
  "qwen-code",
  "kilo-code",
  "roo-code",
  "cline",
  "augment",
  "trae",
  "trae-cn",
  "codebuddy",
  "qoder",
  "droid",
  "goose",
  "junie",
  "zencoder",
  "commandcode",
  "crush",
  "hermes",
];

const TOOL_DISPLAY_RANKS = new Map(TOOL_DISPLAY_ORDER.map((toolId, index) => [toolId, index]));

export function resolveToolId(toolName: string): string {
  return TOOL_NAME_IDS[toolName] ?? toolName.toLowerCase().replace(/\s+/g, "-");
}

export function getToolLogoUrl(toolId: string): string | null {
  return TOOL_LOGO_URLS[toolId] ?? null;
}

export function resolveToolLogoUrl(toolName: string): string | null {
  const toolId = resolveToolId(toolName);

  return getToolLogoUrl(toolId);
}

export function getToolDisplayRank(toolName: string): number {
  return TOOL_DISPLAY_RANKS.get(resolveToolId(toolName)) ?? Number.MAX_SAFE_INTEGER;
}
