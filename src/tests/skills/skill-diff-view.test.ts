import { describe, expect, test } from "vitest";
import {
  normalizeSkillChangeStatus,
  parseSkillDiffHunks,
} from "@/features/skills/components/SkillDiffView";

describe("skill diff helpers", () => {
  test("parses independent hunks with line numbers and valid patch headers", () => {
    const diff = [
      "diff --git a/SKILL.md b/SKILL.md",
      "index 1111111..2222222 100644",
      "--- a/SKILL.md",
      "+++ b/SKILL.md",
      "@@ -1,2 +1,2 @@",
      "-old one",
      "+new one",
      " context",
      "@@ -10,2 +10,2 @@",
      "-old ten",
      "+new ten",
      " context",
    ].join("\n");

    const hunks = parseSkillDiffHunks(diff, false);

    expect(hunks).toHaveLength(2);
    expect(hunks[0].patch).toContain("diff --git a/SKILL.md b/SKILL.md");
    expect(hunks[0].patch).not.toContain("@@ -10,2 +10,2 @@");
    expect(hunks[1].patch).toContain("@@ -10,2 +10,2 @@");
    expect(hunks[0].lines[0]).toMatchObject({ oldLine: 1, newLine: null, kind: "deletion" });
    expect(hunks[0].lines[1]).toMatchObject({ oldLine: null, newLine: 1, kind: "addition" });
  });

  test("normalizes Git status values for changed-file badges", () => {
    expect(normalizeSkillChangeStatus("??")).toBe("A");
    expect(normalizeSkillChangeStatus("D ")).toBe("D");
    expect(normalizeSkillChangeStatus(" M")).toBe("M");
  });
});
