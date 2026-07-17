export function normalizePluginAggregateIdentity(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  return normalized
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "");
}

export function normalizePluginSourceIdentity(value: string | undefined) {
  const normalized = normalizePluginAggregateIdentity(value);
  if (!normalized) {
    return "";
  }

  try {
    const parsedUrl = new URL(normalized);
    const segments = parsedUrl.pathname.split("/").filter(Boolean);
    const gitlabTreeIndex = segments.findIndex(
      (segment, index) => segment === "-" && segments[index + 1] === "tree",
    );
    const plainTreeIndex = segments.findIndex(
      (segment, index) => segment === "tree" && index >= 2 && index + 1 < segments.length,
    );
    const treeIndex = gitlabTreeIndex >= 0 ? gitlabTreeIndex : plainTreeIndex;
    if (treeIndex < 0) {
      return normalized;
    }

    return normalizePluginAggregateIdentity(
      `${parsedUrl.origin}/${segments.slice(0, treeIndex).join("/")}`,
    );
  } catch {
    return normalized;
  }
}
