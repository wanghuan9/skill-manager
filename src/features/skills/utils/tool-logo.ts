const TOOL_LOGO_URLS: Record<string, string> = {
  cursor: "/tool-logos/cursor.svg",
  "claude-code": "/tool-logos/claude-code.png",
  "github-copilot": "/tool-logos/github-copilot.svg",
  codex: "/tool-logos/codex.png",
  gemini: "/tool-logos/gemini.svg",
  windsurf: "/tool-logos/windsurf.ico",
  intellij: "/tool-logos/intellij.svg",
  droid: "/tool-logos/droid.svg",
  goose: "/tool-logos/goose.svg",
  junie: "/tool-logos/junie.svg",
  qoder: "/tool-logos/qoder.svg",
  "qwen-code": "/tool-logos/qwen-code.svg",
  continue: "/tool-logos/continue.ico",
  kiro: "/tool-logos/kiro.ico",
  cline: "/tool-logos/cline.ico",
  augment: "/tool-logos/augment.ico",
  trae: "/tool-logos/trae.ico",
  "trae-cn": "/tool-logos/trae-cn.ico",
  codebuddy: "/tool-logos/codebuddy.ico",
  "kilo-code": "/tool-logos/kilo-code.ico",
  "roo-code": "/tool-logos/roo-code.ico",
  zencoder: "/tool-logos/zencoder.ico",
  antigravity: "/tool-logos/antigravity.svg",
  opencode: "/tool-logos/opencode.ico",
  iflow: "/tool-logos/iflow.png",
  commandcode: "/tool-logos/commandcode.ico",
  crush: "/tool-logos/crush.ico",
  openclaw: "/tool-logos/openclaw.ico",
  hermes: "/tool-logos/hermes.ico",
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
