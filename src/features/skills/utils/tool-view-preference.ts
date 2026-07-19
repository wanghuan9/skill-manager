import type { ListGridViewMode } from "@/features/skills/components/ListGridViewToggle";

type ToolViewPreferenceKey = "mcp:view-mode" | "plugins:view-mode";

export function readToolViewPreference(key: ToolViewPreferenceKey): ListGridViewMode {
  if (typeof window === "undefined") {
    return "list";
  }

  try {
    return window.localStorage.getItem(key) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function writeToolViewPreference(key: ToolViewPreferenceKey, value: ListGridViewMode) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Keep the in-memory preference when storage is unavailable.
  }
}
