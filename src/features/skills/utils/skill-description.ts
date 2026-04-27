const EMPTY_DESCRIPTION_VALUES = new Set(["", "---", "..."]);

export function formatSkillDescription(description: string) {
  const trimmed = description.trim();
  if (EMPTY_DESCRIPTION_VALUES.has(trimmed)) {
    return "未提供简介";
  }

  return trimmed;
}
