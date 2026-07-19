import type { ListGridViewMode } from "@/features/skills/components/ListGridViewToggle";

const GLOBAL_LIST_GRID_VIEW_STORAGE_KEY = "layout:list-grid-view";
const LIST_GRID_VIEW_STORAGE_KEYS = [
  "skills:view-mode",
  "mcp:view-mode",
  "plugins:view-mode",
] as const;

export function readGlobalListGridViewPreference(): ListGridViewMode {
  if (typeof window === "undefined") {
    return "list";
  }

  try {
    return window.localStorage.getItem(GLOBAL_LIST_GRID_VIEW_STORAGE_KEY) === "grid"
      ? "grid"
      : "list";
  } catch {
    return "list";
  }
}

export function applyGlobalListGridViewPreference(value: ListGridViewMode) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(GLOBAL_LIST_GRID_VIEW_STORAGE_KEY, value);
    for (const key of LIST_GRID_VIEW_STORAGE_KEYS) {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Keep the current page state when storage is unavailable.
  }
}
