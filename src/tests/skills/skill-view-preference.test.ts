import { expect, test } from "vitest";
import {
  readSkillGroupCollapsedState,
  resolveSkillViewModePreference,
  SKILL_GROUPED_DEFAULT_THRESHOLD,
  writeSkillGroupCollapsedState,
} from "@/features/skills/utils/skill-view-preference";

test("defaults to grouped view when installed skill count is below threshold", () => {
  expect(resolveSkillViewModePreference(null, SKILL_GROUPED_DEFAULT_THRESHOLD - 1)).toBe("grouped");
});

test("defaults to flat view when installed skill count reaches threshold", () => {
  expect(resolveSkillViewModePreference(null, SKILL_GROUPED_DEFAULT_THRESHOLD)).toBe("flat");
});

test("prefers saved view mode over automatic threshold", () => {
  expect(resolveSkillViewModePreference("grouped", SKILL_GROUPED_DEFAULT_THRESHOLD + 5)).toBe("grouped");
  expect(resolveSkillViewModePreference("flat", 1)).toBe("flat");
});

test("reads and writes collapsed group state", () => {
  writeSkillGroupCollapsedState({ "team-skills": false, "best-skills": true });

  expect(readSkillGroupCollapsedState()).toEqual({
    "team-skills": false,
    "best-skills": true,
  });
});
