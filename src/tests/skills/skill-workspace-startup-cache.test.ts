import { expect, test } from "vitest";
import { installedSkillFixtures } from "@/features/skills/state/skill-fixtures";
import { mergeStartupSkillStatusCache } from "@/features/skills/state/skill-workspace";
import type { SkillSummary } from "@/features/skills/state/skill-store";

test("keeps cached update and push markers during startup refresh", () => {
  const cachedSkill = installedSkillFixtures[0];
  const startupSkill: SkillSummary = {
    ...cachedSkill,
    collabStatus: "clean",
    statusText: "本地与远端一致，可直接使用。",
    lastCheckedAt: "未检查",
  };

  const [mergedSkill] = mergeStartupSkillStatusCache([startupSkill], [cachedSkill]);

  expect(mergedSkill.collabStatus).toBe("pending-push");
  expect(mergedSkill.statusText).toBe(cachedSkill.statusText);
  expect(mergedSkill.lastCheckedAt).toBe(cachedSkill.lastCheckedAt);
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
