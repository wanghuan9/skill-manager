type SkillSourceDisplayOptions = {
  sourceType?: string;
  sourceUrl?: string;
};

function resolveSourceLabelFromType(sourceType?: string) {
  if (sourceType === "github") {
    return "GitHub";
  }

  if (sourceType === "gitlab") {
    return "GitLab";
  }

  if (sourceType === "gitee") {
    return "Gitee";
  }

  if (sourceType === "well-known") {
    return "远程";
  }

  if (sourceType === "marketplace") {
    return "市场";
  }

  if (sourceType === "local") {
    return "本地";
  }

  return null;
}

function resolveSourceTypeFromUrl(sourceUrl?: string) {
  if (!sourceUrl) {
    return null;
  }

  const normalizedUrl = sourceUrl.trim().toLowerCase();
  if (!normalizedUrl) {
    return null;
  }

  if (normalizedUrl.includes("github.com") || normalizedUrl.startsWith("git@github.com:")) {
    return "github";
  }

  if (normalizedUrl.includes("gitlab.com") || normalizedUrl.startsWith("git@gitlab.com:")) {
    return "gitlab";
  }

  if (normalizedUrl.includes("gitee.com") || normalizedUrl.startsWith("git@gitee.com:")) {
    return "gitee";
  }

  if (
    normalizedUrl.startsWith("file://")
    || normalizedUrl.startsWith("/")
    || normalizedUrl.startsWith("~/")
    || normalizedUrl.startsWith("/users/")
    || normalizedUrl.includes(":\\")
  ) {
    return "local";
  }

  return null;
}

export function formatSkillSourceLabel(value: string, options: SkillSourceDisplayOptions = {}) {
  if (value === "本地导入" || value === "本地安装" || value === "Local Import" || value === "Local Install" || value === "Local") {
    return "本地";
  }

  if (value === "自定义仓库" || value === "Custom Repository") {
    return (
      resolveSourceLabelFromType(options.sourceType)
      || resolveSourceLabelFromType(resolveSourceTypeFromUrl(options.sourceUrl) ?? undefined)
      || value
    );
  }

  return (
    resolveSourceLabelFromType(options.sourceType)
    || resolveSourceLabelFromType(resolveSourceTypeFromUrl(options.sourceUrl) ?? undefined)
    || value
  );
}
