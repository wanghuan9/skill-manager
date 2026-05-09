export function getMonogramLabel(value: string): string {
  const normalizedValue = value.trim();
  const firstReadableCharacter = Array.from(normalizedValue).find((character) =>
    /[\p{L}\p{N}]/u.test(character),
  );

  return (firstReadableCharacter ?? "?").toLocaleUpperCase();
}
