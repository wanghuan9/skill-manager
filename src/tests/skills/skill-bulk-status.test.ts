import { vi } from "vitest";
import { setSkillAllToolsEnabled } from "@/features/skills/utils/skill-bulk-status";

test("preserves the backend error when the bulk command exists but fails", async () => {
  const backendError = new Error("Goose Skill 目录不可写");
  const setSkillAllToolStatuses = vi.fn().mockRejectedValue(backendError);
  const setToolSkillStatuses = vi.fn();

  await expect(setSkillAllToolsEnabled({
    skillName: "planning-with-files-zh",
    enabled: true,
    toolNames: ["Goose", "Codex"],
    setSkillAllToolStatuses,
    setToolSkillStatuses,
  })).rejects.toBe(backendError);
  expect(setToolSkillStatuses).not.toHaveBeenCalled();
});

test("falls back to individual tools only when the bulk command is unavailable", async () => {
  const setSkillAllToolStatuses = vi.fn().mockRejectedValue(
    new Error("unknown command set_skill_all_tool_statuses"),
  );
  const setToolSkillStatuses = vi.fn().mockResolvedValue(undefined);

  await expect(setSkillAllToolsEnabled({
    skillName: "planning-with-files-zh",
    enabled: true,
    toolNames: ["Goose", "Codex"],
    setSkillAllToolStatuses,
    setToolSkillStatuses,
  })).resolves.toEqual([]);
  expect(setToolSkillStatuses).toHaveBeenCalledTimes(2);
});
