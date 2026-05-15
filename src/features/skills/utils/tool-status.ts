import { tx } from "@/app/i18n";
import type { AppLanguage } from "@/features/skills/state/skill-store";

export type ToolStatusKind =
  | "installed"
  | "not-installed"
  | "enabled"
  | "disabled"
  | "synced"
  | "needs-resync";

const TOOL_STATUS_LABELS: Record<ToolStatusKind, string[]> = {
  installed: ["已安装", "Installed"],
  "not-installed": ["未安装", "Not Installed"],
  enabled: ["已启用", "Enabled"],
  disabled: ["未启用", "Disabled"],
  synced: ["已同步", "Synced"],
  "needs-resync": ["需要重同步", "Needs Resync"],
};

export function detectToolStatusKind(statusLabel: string): ToolStatusKind | null {
  const normalizedStatusLabel = statusLabel.trim();
  for (const [kind, labels] of Object.entries(TOOL_STATUS_LABELS) as Array<[ToolStatusKind, string[]]>) {
    if (labels.includes(normalizedStatusLabel)) {
      return kind;
    }
  }

  return null;
}

export function getToolStatusLabel(kind: ToolStatusKind, language: AppLanguage): string {
  switch (kind) {
    case "installed":
      return tx(language, "tools.status.installed");
    case "not-installed":
      return tx(language, "tools.status.notInstalled");
    case "enabled":
      return tx(language, "tools.status.enabled");
    case "disabled":
      return tx(language, "tools.status.disabled");
    case "synced":
      return tx(language, "tools.status.synced");
    case "needs-resync":
      return tx(language, "tools.status.needsResync");
  }
}

export function localizeToolStatusLabel(statusLabel: string, language: AppLanguage): string {
  const kind = detectToolStatusKind(statusLabel);
  return kind ? getToolStatusLabel(kind, language) : statusLabel;
}

export function isToolEnabledStatus(statusLabel: string) {
  const kind = detectToolStatusKind(statusLabel);
  return kind === "synced" || kind === "enabled" || kind === "needs-resync";
}

export function isToolInstalledStatus(statusLabel: string) {
  return detectToolStatusKind(statusLabel) === "installed";
}
