const SKILL_TAG_TONE_COUNT = 8;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const AVALANCHE_MULTIPLIER_A = 0x7feb352d;
const AVALANCHE_MULTIPLIER_B = 0x846ca68b;

export function resolveSkillTagTone(tag: string) {
  let hash = FNV_OFFSET_BASIS;
  for (const character of tag.trim().toLocaleLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, FNV_PRIME);
  }

  hash ^= hash >>> 16;
  hash = Math.imul(hash, AVALANCHE_MULTIPLIER_A);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, AVALANCHE_MULTIPLIER_B);
  hash ^= hash >>> 16;
  return (hash >>> 0) % SKILL_TAG_TONE_COUNT;
}
