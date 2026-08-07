export function getDirectoryPath(filePath: string) {
  const normalizedPath = filePath.trim();
  if (!normalizedPath) {
    return "";
  }

  const lastSeparatorIndex = Math.max(
    normalizedPath.lastIndexOf("/"),
    normalizedPath.lastIndexOf("\\"),
  );
  if (lastSeparatorIndex <= 0) {
    return normalizedPath;
  }

  return normalizedPath.slice(0, lastSeparatorIndex);
}

export function getWorkspaceDirectoryPath(settingsFilePath: string) {
  const settingsDirectoryPath = getDirectoryPath(settingsFilePath);
  if (!/(^|[\\/])config$/iu.test(settingsDirectoryPath)) {
    return settingsDirectoryPath;
  }

  return getDirectoryPath(settingsDirectoryPath);
}

export function formatPathForDisplay(filePath: string) {
  return filePath.trim()
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\//, "");
}

export function formatHomePathForDisplay(filePath: string) {
  const normalizedPath = formatPathForDisplay(filePath).replace(/\\/g, "/");

  return normalizedPath
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^[A-Z]:\/Users\/[^/]+(?=\/|$)/i, "~");
}
