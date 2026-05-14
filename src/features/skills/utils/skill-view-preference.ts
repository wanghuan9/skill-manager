export type SkillViewMode = "grouped" | "flat";
export type SkillGroupCollapsedState = Record<string, boolean>;

export const SKILL_GROUPED_DEFAULT_THRESHOLD = 12;

const SKILL_VIEW_MODE_STORAGE_KEY = "skills:view-mode";
const SKILL_GROUP_COLLAPSED_STATE_STORAGE_KEY = "skills:group-collapsed-state";

function isSkillViewMode(value: string | null): value is SkillViewMode {
  return value === "grouped" || value === "flat";
}

function isCollapsedStateRecord(value: unknown): value is SkillGroupCollapsedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((item) => typeof item === "boolean");
}

export function resolveSkillViewModePreference(savedMode: string | null, skillCount: number): SkillViewMode {
  if (isSkillViewMode(savedMode)) {
    return savedMode;
  }

  return skillCount > SKILL_GROUPED_DEFAULT_THRESHOLD ? "grouped" : "flat";
}

export function readSkillViewModePreference(): SkillViewMode | null {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.getItem !== "function"
  ) {
    return null;
  }

  const savedMode = window.localStorage.getItem(SKILL_VIEW_MODE_STORAGE_KEY);
  return isSkillViewMode(savedMode) ? savedMode : null;
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
