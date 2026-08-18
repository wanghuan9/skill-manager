export type SkillViewMode = "list" | "grid" | "grouped";
export type SkillGroupMode = "source" | "tag";
export type SkillGroupCollapsedState = Record<string, boolean>;

export const SKILL_GROUPED_DEFAULT_THRESHOLD = 12;

const SKILL_VIEW_MODE_STORAGE_KEY = "skills:view-mode";
const SKILL_GROUP_MODE_STORAGE_KEY = "skills:group-mode";
const SKILL_GROUP_COLLAPSED_STATE_STORAGE_KEY = "skills:group-collapsed-state";
const SKILL_TAG_FILTER_VISIBLE_STORAGE_KEY = "skills:tag-filter-visible";

function normalizeSkillViewMode(value: string | null): SkillViewMode | null {
  if (value === "flat") {
    return "list";
  }
  if (value === "list" || value === "grid" || value === "grouped") {
    return value;
  }

  return null;
}

function isCollapsedStateRecord(value: unknown): value is SkillGroupCollapsedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((item) => typeof item === "boolean");
}

export function resolveSkillViewModePreference(savedMode: string | null, skillCount: number): SkillViewMode {
  const normalizedMode = normalizeSkillViewMode(savedMode);
  if (normalizedMode) {
    return normalizedMode;
  }

  return skillCount > SKILL_GROUPED_DEFAULT_THRESHOLD ? "grouped" : "list";
}

export function readSkillViewModePreference(): SkillViewMode | null {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.getItem !== "function"
  ) {
    return null;
  }

  const savedMode = window.localStorage.getItem(SKILL_VIEW_MODE_STORAGE_KEY);
  return normalizeSkillViewMode(savedMode);
}

export function writeSkillViewModePreference(mode: SkillViewMode) {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.setItem !== "function"
  ) {
    return;
  }

  window.localStorage.setItem(SKILL_VIEW_MODE_STORAGE_KEY, mode);
}

export function readSkillGroupModePreference(): SkillGroupMode {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.getItem !== "function"
  ) {
    return "source";
  }

  return window.localStorage.getItem(SKILL_GROUP_MODE_STORAGE_KEY) === "tag" ? "tag" : "source";
}

export function writeSkillGroupModePreference(mode: SkillGroupMode) {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.setItem !== "function"
  ) {
    return;
  }

  window.localStorage.setItem(SKILL_GROUP_MODE_STORAGE_KEY, mode);
}

export function readSkillTagFilterVisiblePreference() {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.getItem !== "function"
  ) {
    return true;
  }

  return window.localStorage.getItem(SKILL_TAG_FILTER_VISIBLE_STORAGE_KEY) !== "false";
}

export function writeSkillTagFilterVisiblePreference(isVisible: boolean) {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.setItem !== "function"
  ) {
    return;
  }

  window.localStorage.setItem(SKILL_TAG_FILTER_VISIBLE_STORAGE_KEY, String(isVisible));
}

export function readSkillGroupCollapsedState(): SkillGroupCollapsedState {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.getItem !== "function"
  ) {
    return {};
  }

  const savedState = window.localStorage.getItem(SKILL_GROUP_COLLAPSED_STATE_STORAGE_KEY);
  if (!savedState) {
    return {};
  }

  try {
    const parsedState: unknown = JSON.parse(savedState);
    return isCollapsedStateRecord(parsedState) ? parsedState : {};
  } catch {
    return {};
  }
}

export function writeSkillGroupCollapsedState(state: SkillGroupCollapsedState) {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.setItem !== "function"
  ) {
    return;
  }

  window.localStorage.setItem(SKILL_GROUP_COLLAPSED_STATE_STORAGE_KEY, JSON.stringify(state));
}
