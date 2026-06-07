import { describe, expect, test } from "vitest";
import { formatSkillLastEditor } from "@/features/skills/utils/skill-editor";

describe("formatSkillLastEditor", () => {
  test("returns empty string for missing values", () => {
    expect(formatSkillLastEditor(undefined)).toBe("");
    expect(formatSkillLastEditor(null)).toBe("");
  });

  test("trims the value and removes trailing emoticons", () => {
    expect(formatSkillLastEditor(" Agent Fitz ;-) ")).toBe("Agent Fitz");
  });
});
