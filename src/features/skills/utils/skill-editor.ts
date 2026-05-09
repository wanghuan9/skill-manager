const TRAILING_EMOTICON_PATTERN = /(?:\s+[;；:：][-^~']?[\)）]+)+$/u;

export function formatSkillLastEditor(value: string) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }

  return trimmed.replace(TRAILING_EMOTICON_PATTERN, "").trim();
}
