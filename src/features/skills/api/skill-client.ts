import { invoke } from "@tauri-apps/api/core";
import {
  gitAccountFixture,
  installedSkillFixtures,
  localSkillFixtures,
  marketplaceSkillFixtures,
  pushPreviewFixtures,
  pushTargetFixtures,
  repoSkillCandidateFixtures,
  skillFileBrowserFixtures,
  skillFileDocumentFixtures,
  toolConfigFixtures,
  workspaceSnapshotFixture,
} from "@/features/skills/state/skill-fixtures";
import type {
  GitAccountSummary,
  LocalSkillCandidate,
  MarketplaceSkill,
  MarketplaceSourceSite,
  PushPreviewSnapshot,
  PushTargetSnapshot,
  RepoSkillCandidate,
  SkillFileBrowserSnapshot,
  SkillFileDocument,
  SkillSummary,
  ToolConfig,
  WorkspaceSnapshot,
} from "@/features/skills/state/skill-store";
import { mergeSkillToolsWithInstalledTools } from "@/features/skills/utils/skill-tools";

type InstallFromRepoInput = {
  repoUrl: string;
};

type InstallSelectedRepoSkillsInput = {
  repoUrl: string;
  selectedPaths: string[];
};

type InstallLocalSkillInput = {
  localPath: string;
  skillName?: string;
};

type PushPreviewInput = {
  skillName: string;
  targetBranch: string;
  createBranchName?: string;
};

type OpenSkillInEditorInput = {
  skillName: string;
  editorId: string;
};

type OpenToolSkillsFolderInput = {
  toolId: string;
};

type UpdateSkillInput = {
  skillName: string;
};

type SkillFileInput = {
  skillName: string;
  relativePath: string;
};

type SaveSkillFileInput = SkillFileInput & {
  content: string;
};

type ToggleSkillToolInput = {
  skillName: string;
  toolName: string;
};

export function shouldUseFixtureData() {
  return !(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

async function invokeOrFallback<T>(command: string, args: Record<string, unknown>, fallback: T) {
  if (shouldUseFixtureData()) {
    return fallback;
  }

  return invoke<T>(command, args);
}

export async function fetchWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  return invokeOrFallback("get_workspace_snapshot", {}, workspaceSnapshotFixture);
}

export async function fetchInstalledSkills(): Promise<SkillSummary[]> {
  return invokeOrFallback("list_installed_skills", {}, installedSkillFixtures);
}

export async function fetchStartupInstalledSkills(): Promise<SkillSummary[]> {
  return invokeOrFallback("list_startup_installed_skills", {}, installedSkillFixtures);
}

export async function fetchGitStates(): Promise<SkillSummary[]> {
  return invokeOrFallback("refresh_git_states", {}, installedSkillFixtures);
}

export async function fetchMarketplaceSkills(): Promise<MarketplaceSkill[]> {
  return invokeOrFallback("list_marketplace_skills", {}, marketplaceSkillFixtures);
}

export async function fetchMarketplaceSkillsByPage(input: {
  sourceSite?: MarketplaceSourceSite;
  page: number;
  limit: number;
  query?: string;
  refresh?: boolean;
}): Promise<MarketplaceSkill[]> {
  const { sourceSite, page, limit, query, refresh } = input;
  const normalizedQuery = query?.trim().toLowerCase() ?? "";
  const filteredBySource = sourceSite
    ? marketplaceSkillFixtures.filter((item) => item.sourceSite === sourceSite)
    : marketplaceSkillFixtures;
  const filtered = normalizedQuery
    ? filteredBySource.filter((item) => {
      const searchableText = `${item.name} ${item.description} ${item.maintainer} ${item.sourceSite}`.toLowerCase();
      return searchableText.includes(normalizedQuery);
    })
    : filteredBySource;
  const start = Math.max(0, (page - 1) * limit);
  const fallback = filtered.slice(start, start + limit);
  return invokeOrFallback(
    "list_marketplace_skills",
    { sourceSite, page, limit, query, refresh },
    fallback,
  );
}

export async function fetchMarketplaceSkillDescription(input: {
  sourceSite: MarketplaceSourceSite;
  sourceUrl: string;
  skillId: string;
  skillName: string;
  fallbackDescription?: string;
}): Promise<string> {
  const fallback = input.fallbackDescription?.trim() || `来自 ${input.sourceSite} 的公开 skill（${input.skillName}）`;
  return invokeOrFallback(
    "get_marketplace_skill_description",
    {
      sourceSite: input.sourceSite,
      sourceUrl: input.sourceUrl,
      skillId: input.skillId,
      skillName: input.skillName,
      fallbackDescription: input.fallbackDescription,
    },
    fallback,
  );
}

export async function fetchLocalSkillCandidates(): Promise<LocalSkillCandidate[]> {
  return invokeOrFallback("list_local_skill_candidates", {}, localSkillFixtures);
}

export async function fetchToolConfigs(): Promise<ToolConfig[]> {
  return invokeOrFallback("list_tool_configs", {}, toolConfigFixtures);
}

export async function fetchGitAccount(): Promise<GitAccountSummary> {
  return invokeOrFallback("get_git_account_summary", {}, gitAccountFixture);
}

export async function installSkillFromMarket(skill: MarketplaceSkill): Promise<SkillSummary> {
  const fallback = installedSkillFixtures[0];
  return invokeOrFallback("install_skill_from_market", { skill }, fallback);
}

export async function installSkillFromRepo(
  input: InstallFromRepoInput,
): Promise<RepoSkillCandidate[]> {
  const fallback = repoSkillCandidateFixtures[input.repoUrl] ?? repoSkillCandidateFixtures.default;

  return invokeOrFallback("discover_repo_skills", { repoUrl: input.repoUrl }, fallback);
}

export async function installSelectedRepoSkills(
  input: InstallSelectedRepoSkillsInput,
): Promise<SkillSummary[]> {
  const fallback = input.selectedPaths.map((selectedPath, index) => {
    const candidate =
      (repoSkillCandidateFixtures[input.repoUrl] ?? repoSkillCandidateFixtures.default).find(
        (item) => item.relativePath === selectedPath,
      ) ?? repoSkillCandidateFixtures.default[index] ?? repoSkillCandidateFixtures.default[0];
    const repoName = input.repoUrl.split("/").at(-1)?.replace(/\.git$/i, "") ?? "custom-skill";

    return {
      ...installedSkillFixtures[0],
      name: candidate.name,
      description: candidate.description,
      sourceLabel: "自定义仓库",
      sourceType: "github" as const,
      sourceUrl: input.repoUrl,
      localPath: `/Users/demo/.skillm/skills/${repoName}/${candidate.relativePath}`,
      collabStatus: "clean" as const,
      statusText: "仓库技能已导入，后续可继续同步到工具。",
    };
  });

  return invokeOrFallback("install_selected_repo_skills", input, fallback);
}

export async function installLocalSkill(input: InstallLocalSkillInput): Promise<SkillSummary> {
  const normalizedName = input.skillName?.trim();
  const fallbackName =
    normalizedName ||
    input.localPath.trim().split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.(zip|skill)$/i, "") ||
    "local-skill";
  const fallback = {
    ...installedSkillFixtures[0],
    name: fallbackName,
    description: "从本地路径安装的技能。",
    sourceLabel: "本地安装",
    sourceType: "local" as const,
    sourceUrl: input.localPath,
    localPath: `/Users/demo/.skillm/skills/${fallbackName}`,
    collabStatus: "clean" as const,
    statusText: "本地技能已安装，可继续同步到目标工具。",
    gitLinked: false,
  };

  return invokeOrFallback("install_local_skill", input, fallback);
}

export async function importLocalSkill(localPath: string): Promise<SkillSummary> {
  const match = localSkillFixtures.find((item) => item.localPath === localPath);
  const fallback = {
    ...installedSkillFixtures[0],
    name: match?.name ?? "imported-skill",
    description: match?.description ?? "从本地导入的技能。",
    sourceLabel: "本地导入",
    sourceType: "local" as const,
    sourceUrl: match?.detectedFrom ?? localPath,
    localPath,
    collabStatus: "clean" as const,
    statusText: "已纳入管理，建议同步到目标工具。",
  };

  return invokeOrFallback("import_local_skill", { localPath }, fallback);
}

export async function fetchPushTargetSnapshot(skillName: string): Promise<PushTargetSnapshot> {
  const fallback =
    pushTargetFixtures[skillName] ?? {
      currentBranch: "main",
      branches: [{ name: "main", isCurrent: true }],
    };

  return invokeOrFallback("get_push_target_snapshot", { skillName }, fallback);
}

export async function fetchPushPreviewSnapshot(input: PushPreviewInput): Promise<PushPreviewSnapshot> {
  const fallbackSource =
    pushPreviewFixtures[input.skillName] ?? {
      targetBranch: input.targetBranch,
      willCreateBranch: Boolean(input.createBranchName?.trim()),
      repositoryPath: `/Users/demo/.skillm/skills/${input.skillName}`,
      uncommittedFiles: [],
      unpushedCommitCount: 0,
    };
  const fallback = {
    ...fallbackSource,
    targetBranch: input.createBranchName?.trim() || input.targetBranch,
    willCreateBranch: Boolean(input.createBranchName?.trim()),
  };

  return invokeOrFallback("get_push_preview_snapshot", input, fallback);
}

export async function openSkillRepository(skillName: string): Promise<void> {
  return invokeOrFallback("open_skill_repository", { skillName }, undefined);
}

export async function openExternalLink(url: string): Promise<void> {
  return invokeOrFallback("open_external_link", { url }, undefined);
}

export async function openSkillInEditor(input: OpenSkillInEditorInput): Promise<void> {
  return invokeOrFallback("open_skill_in_editor", input, undefined);
}

export async function openToolSkillsFolder(input: OpenToolSkillsFolderInput): Promise<void> {
  return invokeOrFallback("open_tool_skills_folder", input, undefined);
}

export async function updateSkill(
  input: UpdateSkillInput,
): Promise<SkillSummary> {
  const fallbackSource =
    installedSkillFixtures.find((skill) => skill.name === input.skillName) ??
    installedSkillFixtures[0];
  const fallback = {
    ...fallbackSource,
    collabStatus: "clean" as const,
    statusText: "已拉取远端最新内容，可继续同步到工具。",
    lastCheckedAt: "刚刚检查",
  };

  return invokeOrFallback("update_skill", input, fallback);
}

export async function fetchSkillFileBrowser(skillName: string): Promise<SkillFileBrowserSnapshot> {
  const fallback =
    skillFileBrowserFixtures[skillName] ?? {
      skillName,
      rootName: skillName,
      entries: [
        { path: "", name: skillName, entryType: "directory", depth: 0 },
        { path: "SKILL.md", name: "SKILL.md", entryType: "file", depth: 1 },
      ],
      initialFilePath: "SKILL.md",
    };

  return invokeOrFallback("get_skill_file_browser", { skillName }, fallback);
}

export async function fetchSkillFileContent(input: SkillFileInput): Promise<SkillFileDocument> {
  const fallback =
    skillFileDocumentFixtures[input.skillName]?.[input.relativePath] ?? {
      path: input.relativePath,
      content: "",
    };

  return invokeOrFallback("get_skill_file_content", input, fallback);
}

export async function saveSkillFileContent(input: SaveSkillFileInput): Promise<SkillFileDocument> {
  const fallback = {
    path: input.relativePath,
    content: input.content,
  };

  return invokeOrFallback("save_skill_file_content", input, fallback);
}

export async function deleteSkill(skillName: string): Promise<void> {
  return invokeOrFallback("delete_skill", { skillName }, undefined);
}

export async function toggleSkillTool(input: ToggleSkillToolInput): Promise<SkillSummary> {
  const fallbackSource =
    installedSkillFixtures.find((skill) => skill.name === input.skillName) ??
    installedSkillFixtures[0];
  const mergedTools = mergeSkillToolsWithInstalledTools(fallbackSource.tools, toolConfigFixtures);
  const fallback = {
    ...fallbackSource,
    tools: mergedTools.map((tool) =>
      tool.name === input.toolName
        ? {
            ...tool,
            statusLabel: ["已同步", "已启用", "需要重同步"].includes(tool.statusLabel)
              ? "未启用"
              : "已启用",
          }
        : tool,
    ),
  };

  return invokeOrFallback("toggle_skill_tool_status", input, fallback);
}
