import { beforeEach, expect, test } from "vitest";
import {
  applyGlobalListGridViewPreference,
  readGlobalListGridViewPreference,
} from "@/features/skills/utils/list-grid-view-preference";
import { writeSkillViewModePreference } from "@/features/skills/utils/skill-view-preference";
import { writeToolViewPreference } from "@/features/skills/utils/tool-view-preference";

beforeEach(() => {
  window.localStorage.clear();
});

test("applies one layout preference to every supported page", () => {
  applyGlobalListGridViewPreference("grid");

  expect(readGlobalListGridViewPreference()).toBe("grid");
  expect(window.localStorage.getItem("skills:view-mode")).toBe("grid");
  expect(window.localStorage.getItem("mcp:view-mode")).toBe("grid");
  expect(window.localStorage.getItem("plugins:view-mode")).toBe("grid");
});

test("keeps later page switches independent from the shared preference", () => {
  applyGlobalListGridViewPreference("grid");
  writeSkillViewModePreference("list");
  writeToolViewPreference("mcp:view-mode", "list");

  expect(readGlobalListGridViewPreference()).toBe("grid");
  expect(window.localStorage.getItem("skills:view-mode")).toBe("list");
  expect(window.localStorage.getItem("mcp:view-mode")).toBe("list");
  expect(window.localStorage.getItem("plugins:view-mode")).toBe("grid");
});
