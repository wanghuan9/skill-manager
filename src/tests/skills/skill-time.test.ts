import { describe, expect, test } from "vitest";
import { formatSkillUpdatedAt, parseSkillTimestamp } from "@/features/skills/utils/skill-time";

describe("skill-time", () => {
  test("returns empty string for undefined updated time", () => {
    expect(formatSkillUpdatedAt(undefined)).toBe("");
    expect(formatSkillUpdatedAt(null)).toBe("");
  });

  test("returns negative infinity for undefined timestamp", () => {
    expect(parseSkillTimestamp(undefined)).toBe(Number.NEGATIVE_INFINITY);
    expect(parseSkillTimestamp(null)).toBe(Number.NEGATIVE_INFINITY);
  });
});
