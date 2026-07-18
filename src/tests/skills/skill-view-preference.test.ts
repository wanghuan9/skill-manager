import { expect, test } from "vitest";
import {
  readSkillGroupCollapsedState,
  resolveSkillViewModePreference,
  SKILL_GROUPED_DEFAULT_THRESHOLD,
  writeSkillGroupCollapsedState,
} from "@/features/skills/utils/skill-view-preference";

test("defaults to list view when installed skill count is at or below threshold", () => {
  expect(resolveSkillViewModePreference(null, SKILL_GROUPED_DEFAULT_THRESHOLD - 1)).toBe("list");
  expect(resolveSkillViewModePreference(null, SKILL_GROUPED_DEFAULT_THRESHOLD)).toBe("list");
});

test("defaults to grouped view when installed skill count is above threshold", () => {
  expect(resolveSkillViewModePreference(null, SKILL_GROUPED_DEFAULT_THRESHOLD + 1)).toBe("grouped");
});

test("prefers saved view mode over automatic threshold", () => {
  expect(resolveSkillViewModePreference("grouped", SKILL_GROUPED_DEFAULT_THRESHOLD + 5)).toBe("grouped");
  expect(resolveSkillViewModePreference("grid", 1)).toBe("grid");
  expect(resolveSkillViewModePreference("list", 1)).toBe("list");
});

test("migrates the legacy flat preference to list view", () => {
  expect(resolveSkillViewModePreference("flat", 1)).toBe("list");
});

test("reads and writes collapsed group state", () => {
  writeSkillGroupCollapsedState({ "team-skills": false, "best-skills": true });

  expect(readSkillGroupCollapsedState()).toEqual({
    "team-skills": false,
    "best-skills": true,
  });
});
