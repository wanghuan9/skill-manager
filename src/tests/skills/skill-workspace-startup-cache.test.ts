import { expect, test } from "vitest";
import { installedSkillFixtures } from "@/features/skills/state/skill-fixtures";
import { mergeStartupSkillStatusCache } from "@/features/skills/state/skill-workspace";
import type { SkillSummary } from "@/features/skills/state/skill-store";

test("keeps cached remote update markers during startup refresh", () => {
  const cachedSkill = installedSkillFixtures[1];
  const startupSkill: SkillSummary = {
    ...cachedSkill,
    collabStatus: "clean",
    statusText: "本地与远端一致，可直接使用。",
    lastCheckedAt: "未检查",
  };

  const [mergedSkill] = mergeStartupSkillStatusCache([startupSkill], [cachedSkill]);

  expect(mergedSkill.collabStatus).toBe("update-available");
  expect(mergedSkill.statusText).toBe(cachedSkill.statusText);
  expect(mergedSkill.lastCheckedAt).toBe(cachedSkill.lastCheckedAt);
});

test("does not restore stale cached pending push markers over a clean startup skill", () => {
  const cachedSkill = installedSkillFixtures[0];
  const startupSkill: SkillSummary = {
    ...cachedSkill,
    collabStatus: "clean",
    statusText: "本地与远端一致，可直接使用。",
    lastCheckedAt: "未检查",
  };

  const [mergedSkill] = mergeStartupSkillStatusCache([startupSkill], [cachedSkill]);

  expect(mergedSkill.collabStatus).toBe("clean");
  expect(mergedSkill.statusText).toBe("本地与远端一致，可直接使用。");
  expect(mergedSkill.lastCheckedAt).toBe("未检查");
});

test("does not apply cached markers to a different local path", () => {
  const cachedSkill = installedSkillFixtures[1];
  const movedSkill: SkillSummary = {
    ...cachedSkill,
    localPath: `${cachedSkill.localPath}-new`,
    collabStatus: "clean",
    statusText: "本地与远端一致，可直接使用。",
  };

  const [mergedSkill] = mergeStartupSkillStatusCache([movedSkill], [cachedSkill]);

  expect(mergedSkill.collabStatus).toBe("clean");
});
