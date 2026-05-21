import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { tx } from "@/app/i18n";
import { isTauriRuntime } from "@/app/is-tauri-runtime";
import {
  appSettingsFixture,
  gitAccountFixture,
  installedSkillFixtures,
  localSkillFixtures,
  localInstallSkillCandidateFixtures,
  marketplaceSkillFixtures,
  mcpMarketplaceServerFixtures,
  mcpWorkspaceFixture,
  pushPreviewFixtures,
  pushTargetFixtures,
  repoSkillCandidateFixtures,
  skillFileBrowserFixtures,
  skillFileDocumentFixtures,
  toolConfigFixtures,
  workspaceSnapshotFixture,
} from "@/features/skills/state/skill-fixtures";
import type {
  AppLanguage,
  AppSettings,
  FailureFeedbackInput,
  FeedbackIssueDraft,
  GitAccountSummary,
  LocalSkillCandidate,
  LocalInstallSkillCandidate,
  MarketplaceSkill,
  MarketplaceSourceSite,
  McpMarketplaceServer,
  McpMarketplaceSourceSite,
  McpImportProgress,
  McpServerRecord,
  McpWorkspaceSnapshot,
  PushPreviewSnapshot,
  PushTargetSnapshot,
  RepoSkillCandidate,
  SkillFileBrowserSnapshot,
  SkillFileDocument,
  SkillSummary,
  ToolConfig,
  WorkspaceSnapshot,
} from "@/features/skills/state/skill-store";
import {
  localizeGitAccountSummary,
  localizeSkillStatusText,
  localizeToolConfigs,
} from "@/features/skills/utils/skill-localization";
import { mergeSkillToolsWithInstalledTools } from "@/features/skills/utils/skill-tools";
import {
  getToolStatusLabel,
  isToolEnabledStatus,
  localizeToolStatusLabel,
} from "@/features/skills/utils/tool-status";

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

type InstallSelectedLocalSkillsInput = {
  localPath: string;
  selectedPaths: string[];
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

type OpenToolMcpConfigInput = {
  toolId: string;
  editorId?: string;
};

type OpenPathInFinderInput = {
  path: string;
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
  toolNames: string[];
};

type SetToolSkillStatusesInput = {
  toolName: string;
  skillNames: string[];
  enabled: boolean;
  toolNames: string[];
};

type SetSkillAllToolStatusesInput = {
  skillName: string;
  enabled: boolean;
  toolNames: string[];
};

type ToggleMcpAppInput = {
  serverId: string;
  appId: string;
  enabled: boolean;
};

type ToggleMcpToolInput = {
  serverId: string;
  toolName: string;
  enabled: boolean;
};

type InstallMcpMarketplaceServerInput = {
  server: McpMarketplaceServer;
};

type FetchMcpMarketplaceServerConfigInput = {
  server: McpMarketplaceServer;
};

type UpdateAppSettingsInput = {
  settings: AppSettings;
};

type DetectedAppLanguage = {
  language: AppLanguage;
};

type LegacySkillSummary = Partial<SkillSummary> & {
  lastSyncedAt?: string;
};

export type McpImportSessionSnapshot = {
  isImporting: boolean;
  progress: McpImportProgress | null;
};

type McpImportSessionListener = (snapshot: McpImportSessionSnapshot) => void;

let mcpImportSession: McpImportSessionSnapshot = {
  isImporting: false,
  progress: null,
};
let activeMcpImportPromise: Promise<number> | null = null;
let mcpImportProgressUnlisten: UnlistenFn | null = null;
let mcpImportProgressListenerPromise: Promise<void> | null = null;
const mcpImportSessionListeners = new Set<McpImportSessionListener>();

export function shouldUseFixtureData() {
  return !isTauriRuntime();
}

function emitMcpImportSessionChange() {
  const snapshot = getMcpImportSessionSnapshot();
  for (const listener of mcpImportSessionListeners) {
    listener(snapshot);
  }
}

function setMcpImportSession(nextSession: McpImportSessionSnapshot) {
  mcpImportSession = nextSession;
  emitMcpImportSessionChange();
}

function ensureMcpImportProgressListener() {
  if (shouldUseFixtureData() || mcpImportProgressUnlisten || mcpImportProgressListenerPromise) {
    return;
  }

  mcpImportProgressListenerPromise = listen<McpImportProgress>("mcp-import-progress", (event) => {
    setMcpImportSession({
      isImporting: mcpImportSession.isImporting,
      progress: event.payload,
    });
  })
    .then((unlisten) => {
      mcpImportProgressUnlisten = unlisten;
      mcpImportProgressListenerPromise = null;
    })
    .catch((error) => {
      mcpImportProgressListenerPromise = null;
      console.warn("Failed to listen for MCP import progress", error);
    });
}

export function getMcpImportSessionSnapshot(): McpImportSessionSnapshot {
  return { ...mcpImportSession };
}

export function resetMcpImportSessionForTests() {
  activeMcpImportPromise = null;
  mcpImportSession = {
    isImporting: false,
    progress: null,
  };
  mcpImportSessionListeners.clear();
}

export function subscribeMcpImportSessionChange(listener: McpImportSessionListener) {
  mcpImportSessionListeners.add(listener);
  listener(getMcpImportSessionSnapshot());

  return () => {
    mcpImportSessionListeners.delete(listener);
  };
}

async function invokeOrFallback<T>(command: string, args: Record<string, unknown>, fallback: T) {
  if (shouldUseFixtureData()) {
    return fallback;
  }

  return invoke<T>(command, args);
}

function getCurrentAppLanguage(): AppLanguage {
  if (typeof window !== "undefined") {
    const savedLanguage = window.localStorage.getItem("skilldock.settings.language");
    if (savedLanguage === "zh-CN" || savedLanguage === "en") {
      return savedLanguage;
    }

    const navigatorLanguages = [window.navigator.language, ...(window.navigator.languages ?? [])]
      .filter(Boolean)
      .map((language) => language.toLowerCase());
    if (navigatorLanguages.some((language) => language.startsWith("zh"))) {
      return "zh-CN";
    }

    return "en";
  }

  return "en";
}

function inCurrentLanguage(chinese: string, english: string) {
  return getCurrentAppLanguage() === "en" ? english : chinese;
}

function getCurrentTimestampLabel() {
  return String(Date.now());
}

function normalizeToolConfigs(toolConfigs: ToolConfig[]): ToolConfig[] {
  return localizeToolConfigs(toolConfigs, getCurrentAppLanguage());
}

function normalizeMcpWorkspaceSnapshot(workspace: McpWorkspaceSnapshot): McpWorkspaceSnapshot {
  const language = getCurrentAppLanguage();
  return {
    ...workspace,
    apps: workspace.apps.map((app) => ({
      ...app,
      statusLabel: localizeToolStatusLabel(app.statusLabel, language),
    })),
    servers: workspace.servers.map((server) => ({
      ...server,
      apps: server.apps.map((app) => ({
        ...app,
        statusLabel: localizeToolStatusLabel(app.statusLabel, language),
      })),
    })),
  };
}

function normalizeSkillSummary(skill: LegacySkillSummary): SkillSummary {
  const language = getCurrentAppLanguage();
  const normalizedUpdatedAt =
    skill.localUpdatedAt?.trim()
    || skill.remoteUpdatedAt?.trim()
    || skill.lastSyncedAt?.trim()
    || "";

  return {
    name: skill.name ?? "",
    sourceLabel: skill.sourceLabel ?? "",
    sourceType: skill.sourceType ?? "local",
    sourceUrl: skill.sourceUrl ?? "",
    description: skill.description ?? "",
    localPath: skill.localPath ?? "",
    branch: skill.branch ?? "",
    collabStatus: skill.collabStatus ?? "clean",
    statusText: localizeSkillStatusText(skill.statusText ?? "", language),
    remoteUpdatedAt: skill.remoteUpdatedAt ?? skill.lastSyncedAt ?? normalizedUpdatedAt,
    localUpdatedAt: skill.localUpdatedAt ?? skill.lastSyncedAt ?? normalizedUpdatedAt,
    lastCheckedAt: skill.lastCheckedAt ?? "",
    syncedToolCount: skill.syncedToolCount ?? 0,
    lastEditor: skill.lastEditor ?? "",
    commitLabel: skill.commitLabel ?? "",
    gitLinked: skill.gitLinked ?? false,
    tools: (skill.tools ?? []).map((tool) => ({
      ...tool,
      statusLabel: localizeToolStatusLabel(tool.statusLabel, language),
    })),
  };
}

function normalizeSkillSummaryList(skills: LegacySkillSummary[]): SkillSummary[] {
  return skills.map((skill) => normalizeSkillSummary(skill));
}

export async function fetchWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  const snapshot = await invokeOrFallback("get_workspace_snapshot", {}, workspaceSnapshotFixture);
  return {
    ...snapshot,
    installedSkills: normalizeSkillSummaryList(snapshot.installedSkills),
    toolConfigs: normalizeToolConfigs(snapshot.toolConfigs),
    gitAccount: localizeGitAccountSummary(snapshot.gitAccount, getCurrentAppLanguage()) ?? snapshot.gitAccount,
  };
}

export async function fetchInstalledSkills(): Promise<SkillSummary[]> {
  const skills = await invokeOrFallback<LegacySkillSummary[]>(
    "list_installed_skills",
    {},
    installedSkillFixtures,
  );
  return normalizeSkillSummaryList(skills);
}

export async function fetchStartupInstalledSkills(): Promise<SkillSummary[]> {
  const skills = await invokeOrFallback<LegacySkillSummary[]>(
    "list_startup_installed_skills",
    {},
    installedSkillFixtures,
  );
  return normalizeSkillSummaryList(skills);
}

export async function fetchGitStates(): Promise<SkillSummary[]> {
  const skills = await invokeOrFallback<LegacySkillSummary[]>(
    "refresh_git_states",
    {},
    installedSkillFixtures,
  );
  return normalizeSkillSummaryList(skills);
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
  const fallback = input.fallbackDescription?.trim() || tx(
    getCurrentAppLanguage(),
    "install.market.fallbackDescription",
    { repository: input.sourceSite, name: input.skillName },
  );
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
  const toolConfigs = await invokeOrFallback("list_tool_configs", {}, toolConfigFixtures);
  return normalizeToolConfigs(toolConfigs);
}

export async function fetchGitAccount(): Promise<GitAccountSummary> {
  const gitAccount = await invokeOrFallback("get_git_account_summary", {}, gitAccountFixture);
  return localizeGitAccountSummary(gitAccount, getCurrentAppLanguage()) ?? gitAccount;
}

export async function fetchAppSettings(): Promise<AppSettings> {
  return invokeOrFallback("get_app_settings", {}, appSettingsFixture);
}

export async function updateAppSettings(input: UpdateAppSettingsInput): Promise<AppSettings> {
  return invokeOrFallback("update_app_settings", input, input.settings);
}

export async function detectPreferredAppLanguage(): Promise<AppLanguage> {
  const result = await invokeOrFallback<DetectedAppLanguage>(
    "detect_preferred_app_language",
    {},
    { language: getCurrentAppLanguage() },
  );
  return result.language;
}

export async function installSkillFromMarket(skill: MarketplaceSkill): Promise<SkillSummary> {
  const fallback = normalizeSkillSummary({
    ...installedSkillFixtures[0],
    name: skill.name,
    description: skill.description,
    sourceLabel: skill.sourceSite,
    sourceType: skill.sourceType,
    sourceUrl: skill.sourceUrl,
    remoteUpdatedAt: skill.updatedAt,
    localUpdatedAt: getCurrentTimestampLabel(),
    collabStatus: "clean",
    statusText: inCurrentLanguage(
      "已安装到本地，可继续同步到工具。",
      "Installed locally. You can continue syncing it to tools.",
    ),
  });
  const installedSkill = await invokeOrFallback<LegacySkillSummary>("install_skill_from_market", { skill }, fallback);
  return normalizeSkillSummary(installedSkill);
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
      sourceLabel: input.repoUrl.includes("gitee.com")
        ? "Gitee"
        : input.repoUrl.includes("gitlab.com")
          ? "GitLab"
          : "GitHub",
      sourceType: input.repoUrl.includes("gitee.com")
        ? "gitee" as const
        : input.repoUrl.includes("gitlab.com")
          ? "gitlab" as const
          : "github" as const,
      sourceUrl: input.repoUrl,
      localPath: `/Users/demo/.skilldock/skills/${repoName}/${candidate.relativePath}`,
      collabStatus: "clean" as const,
      statusText: inCurrentLanguage(
        "仓库技能已导入，后续可继续同步到工具。",
        "Repository skills imported. You can continue syncing them to tools.",
      ),
    };
  });

  const installedSkills = await invokeOrFallback<LegacySkillSummary[]>("install_selected_repo_skills", input, fallback);
  return normalizeSkillSummaryList(installedSkills);
}

export async function discoverLocalInstallSkills(
  localPath: string,
): Promise<LocalInstallSkillCandidate[]> {
  const fallbackName =
    localPath.trim().split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.(zip|skill)$/i, "") ||
    "local-skill";
  const fallback = [
    {
      id: fallbackName,
      name: fallbackName,
      description: inCurrentLanguage("从本地路径识别的技能。", "Skill discovered from a local path."),
      relativePath: "",
    },
  ];

  const fixture = localInstallSkillCandidateFixtures[localPath] ?? fallback;

  return invokeOrFallback("discover_local_install_skills", { localPath }, fixture);
}

export async function installSelectedLocalSkills(
  input: InstallSelectedLocalSkillsInput,
): Promise<SkillSummary[]> {
  const fallback = input.selectedPaths.map((selectedPath) => {
    const candidate =
      (localInstallSkillCandidateFixtures[input.localPath] ?? []).find(
        (item) => item.relativePath === selectedPath,
      );
    const fallbackName =
      candidate?.name ||
      selectedPath.trim().split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.(zip|skill)$/i, "") ||
      input.localPath.trim().split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.(zip|skill)$/i, "") ||
      "local-skill";

    return {
      ...installedSkillFixtures[0],
      name: fallbackName,
      description: inCurrentLanguage("从本地路径安装的技能。", "Skill installed from a local path."),
      sourceLabel: inCurrentLanguage("本地安装", "Local Install"),
      sourceType: "local" as const,
      sourceUrl: input.localPath,
      localPath: `/Users/demo/.skilldock/skills/${fallbackName}`,
      collabStatus: "clean" as const,
      statusText: inCurrentLanguage(
        "本地技能已安装，可继续同步到目标工具。",
        "Local skill installed. You can continue syncing it to target tools.",
      ),
      gitLinked: false,
      remoteUpdatedAt: "",
      localUpdatedAt: getCurrentTimestampLabel(),
    };
  });

  const installedSkills = await invokeOrFallback<LegacySkillSummary[]>(
    "install_selected_local_skills",
    input,
    fallback,
  );
  return normalizeSkillSummaryList(installedSkills);
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
    description: inCurrentLanguage("从本地路径安装的技能。", "Skill installed from a local path."),
    sourceLabel: inCurrentLanguage("本地安装", "Local Install"),
    sourceType: "local" as const,
    sourceUrl: input.localPath,
    localPath: `/Users/demo/.skilldock/skills/${fallbackName}`,
    collabStatus: "clean" as const,
    statusText: inCurrentLanguage(
      "本地技能已安装，可继续同步到目标工具。",
      "Local skill installed. You can continue syncing it to target tools.",
    ),
    gitLinked: false,
  };

  const installedSkill = await invokeOrFallback<LegacySkillSummary>("install_local_skill", input, {
    ...fallback,
    remoteUpdatedAt: "",
    localUpdatedAt: getCurrentTimestampLabel(),
  });
  return normalizeSkillSummary(installedSkill);
}

export async function importLocalSkill(localPath: string): Promise<SkillSummary> {
  const match = localSkillFixtures.find((item) => item.localPath === localPath);
  const fallback = {
    ...installedSkillFixtures[0],
    name: match?.name ?? "imported-skill",
    description: match?.description ?? inCurrentLanguage("从本地导入的技能。", "Skill imported from local storage."),
    sourceLabel: inCurrentLanguage("本地导入", "Local Import"),
    sourceType: "local" as const,
    sourceUrl: match?.detectedFrom ?? localPath,
    localPath,
    collabStatus: "clean" as const,
    statusText: inCurrentLanguage(
      "已纳入管理，建议同步到目标工具。",
      "Now managed here. Sync it to target tools when you're ready.",
    ),
  };

  const importedSkill = await invokeOrFallback<LegacySkillSummary>("import_local_skill", { localPath }, {
    ...fallback,
    remoteUpdatedAt: "",
    localUpdatedAt: getCurrentTimestampLabel(),
  });
  return normalizeSkillSummary(importedSkill);
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
      repositoryPath: `/Users/demo/.skilldock/skills/${input.skillName}`,
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
  if (shouldUseFixtureData()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return undefined;
  }

  return invokeOrFallback("open_external_link", { url }, undefined);
}

export async function recordFailureFeedback(input: FailureFeedbackInput): Promise<FeedbackIssueDraft> {
  const failureKind = input.kind === "business"
    ? inCurrentLanguage("业务异常", "Business Error")
    : inCurrentLanguage("未知异常", "Unknown Error");
  const title = `[Bug] ${input.operation} ${failureKind}: ${input.message}`.slice(0, 120);
  const context = input.context ?? {};
  const errorDetails = typeof context.errorDetails === "object" && context.errorDetails !== null
    ? context.errorDetails as Record<string, unknown>
    : null;
  const causeChain = Array.isArray(errorDetails?.causeChain)
    ? errorDetails.causeChain.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const body = [
    inCurrentLanguage("## 问题描述", "## What Happened"),
    inCurrentLanguage(
      "请描述你刚才点击了什么、期望发生什么、实际发生了什么。",
      "Describe what you clicked, what you expected, and what actually happened.",
    ),
    "",
    inCurrentLanguage("## 本次失败日志（自动过滤）", "## Failure Log (Auto-filtered)"),
    "```text",
    `kind: ${input.kind ?? "unknown"}`,
    `operation: ${input.operation}`,
    `error: ${input.message}`,
    typeof errorDetails?.rootCause === "string" ? `rootCause: ${errorDetails.rootCause}` : "",
    causeChain.length > 0 ? `causeChain: ${causeChain.join(" -> ")}` : "",
    `time: ${new Date().toISOString()}`,
    "localLog: ~/.skilldock/logs/errors.jsonl",
    typeof context.route === "string" ? `route: ${context.route}` : "",
    typeof context.serverCount === "number" ? `knownMcpServers: ${context.serverCount}` : "",
    "```",
    "",
    inCurrentLanguage("## 补充信息", "## Extra Context"),
    inCurrentLanguage(
      "以上是 SkillDock 自动提取的关键错误信息；完整诊断仅保存在用户本机日志文件中。",
      "These are the key error details extracted by SkillDock. Full diagnostics are only stored in the local log file.",
    ),
  ].filter(Boolean).join("\n");
  const urlBody = body.length > 1400
    ? `${body.slice(0, 1400)}\n\n${inCurrentLanguage("...摘要过长，已截断。", "...Summary too long, truncated.")}`
    : body;
  const issueUrl = buildSafeIssueUrl(title, urlBody);
  const fallback: FeedbackIssueDraft = {
    title,
    body,
    issueUrl,
    logPath: "~/.skilldock/logs/errors.jsonl",
  };

  return invokeOrFallback("record_failure_feedback", { input }, fallback);
}

function buildSafeIssueUrl(title: string, body: string) {
  let nextBody = body;
  while (nextBody.length > 400) {
    const issueUrl = `https://github.com/wanghuan9/skill-manager/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(nextBody)}`;
    if (issueUrl.length <= 6000) {
      return issueUrl;
    }
    nextBody = `${nextBody.slice(0, Math.max(400, nextBody.length - 200))}\n\n${inCurrentLanguage("...自动诊断摘要过长，已截断。", "...Auto-diagnosis summary too long, truncated.")}`;
  }

  return `https://github.com/wanghuan9/skill-manager/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(nextBody)}`;
}

export async function resolveMcpMarketplaceSourceUrl(server: McpMarketplaceServer): Promise<string> {
  const fallbackSourceUrl = server.sourceUrl || server.marketplaceUrl || "";
  if (shouldUseFixtureData()) {
    return fallbackSourceUrl;
  }

  return invokeOrFallback(
    "resolve_mcp_marketplace_source_link",
    { server },
    fallbackSourceUrl,
  );
}

export async function openSkillInEditor(input: OpenSkillInEditorInput): Promise<void> {
  return invokeOrFallback("open_skill_in_editor", input, undefined);
}

export async function openToolSkillsFolder(input: OpenToolSkillsFolderInput): Promise<void> {
  return invokeOrFallback("open_tool_skills_folder", input, undefined);
}

export async function openToolMcpConfig(input: OpenToolMcpConfigInput): Promise<void> {
  return invokeOrFallback("open_tool_mcp_config", input, undefined);
}

export async function openPathInFinder(input: OpenPathInFinderInput): Promise<void> {
  return invokeOrFallback("open_path_in_finder", input, undefined);
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
    statusText: inCurrentLanguage(
      "已拉取远端最新内容，可继续同步到工具。",
      "Pulled the latest remote changes. You can continue syncing to tools.",
    ),
    lastCheckedAt: getCurrentTimestampLabel(),
  };

  const updatedSkill = await invokeOrFallback<LegacySkillSummary>("update_skill", input, {
    ...fallback,
    localUpdatedAt: getCurrentTimestampLabel(),
  });
  return normalizeSkillSummary(updatedSkill);
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
            statusLabel: isToolEnabledStatus(tool.statusLabel)
              ? getToolStatusLabel("disabled", getCurrentAppLanguage())
              : getToolStatusLabel("enabled", getCurrentAppLanguage()),
          }
        : tool,
    ),
  };

  const updatedSkill = await invokeOrFallback<LegacySkillSummary>("toggle_skill_tool_status", input, fallback);
  return normalizeSkillSummary(updatedSkill);
}

export async function setToolSkillStatuses(
  input: SetToolSkillStatusesInput,
): Promise<SkillSummary[]> {
  const fallback = input.skillNames.map((skillName) => {
    const fallbackSource =
      installedSkillFixtures.find((skill) => skill.name === skillName) ??
      installedSkillFixtures[0];
    const mergedTools = mergeSkillToolsWithInstalledTools(fallbackSource.tools, toolConfigFixtures);
    return {
      ...fallbackSource,
      name: skillName,
      tools: mergedTools.map((tool) =>
        tool.name === input.toolName
          ? {
              ...tool,
              statusLabel: getToolStatusLabel(input.enabled ? "enabled" : "disabled", getCurrentAppLanguage()),
            }
          : tool
      ),
    };
  });

  const updatedSkills = await invokeOrFallback<LegacySkillSummary[]>(
    "set_tool_skill_statuses",
    input,
    fallback,
  );
  return normalizeSkillSummaryList(updatedSkills);
}

export async function setSkillAllToolStatuses(
  input: SetSkillAllToolStatusesInput,
): Promise<SkillSummary> {
  const fallbackSource =
    installedSkillFixtures.find((skill) => skill.name === input.skillName) ??
    installedSkillFixtures[0];
  const mergedTools = mergeSkillToolsWithInstalledTools(fallbackSource.tools, toolConfigFixtures);
  const fallback = {
    ...fallbackSource,
    name: input.skillName,
    tools: mergedTools.map((tool) => ({
      ...tool,
      statusLabel: getToolStatusLabel(input.enabled ? "enabled" : "disabled", getCurrentAppLanguage()),
    })),
  };

  const updatedSkill = await invokeOrFallback<LegacySkillSummary>(
    "set_skill_all_tool_statuses",
    input,
    fallback,
  );
  return normalizeSkillSummary(updatedSkill);
}

export async function fetchMcpWorkspace(): Promise<McpWorkspaceSnapshot> {
  const workspace = await invokeOrFallback("list_mcp_workspace", {}, mcpWorkspaceFixture);
  return normalizeMcpWorkspaceSnapshot(workspace);
}

export async function fetchMcpMarketplaceServers(input: {
  sourceSite?: McpMarketplaceSourceSite;
  page: number;
  limit: number;
  query?: string;
  refresh?: boolean;
}): Promise<McpMarketplaceServer[]> {
  const normalizedQuery = input.query?.trim().toLowerCase() ?? "";
  const filtered = normalizedQuery
    ? mcpMarketplaceServerFixtures.filter((server) => {
        const searchableText = `${server.name} ${server.description} ${server.publisher} ${server.category}`.toLowerCase();
        return searchableText.includes(normalizedQuery);
      })
    : mcpMarketplaceServerFixtures;
  const start = Math.max(0, (input.page - 1) * input.limit);
  const fallback = filtered.slice(start, start + input.limit);

  return invokeOrFallback(
    "list_mcp_marketplace_servers",
    {
      sourceSite: input.sourceSite,
      page: input.page,
      limit: input.limit,
      query: input.query,
      refresh: input.refresh,
    },
    fallback,
  );
}

export async function fetchMcpMarketplaceServerConfig(
  input: FetchMcpMarketplaceServerConfigInput,
): Promise<Record<string, unknown> | null> {
  const fallbackServer = mcpMarketplaceServerFixtures.find((server) => server.id === input.server.id);
  const fallback = fallbackServer?.server ?? input.server.server ?? null;
  return invokeOrFallback("get_mcp_marketplace_server_config", input, fallback);
}

export async function installMcpServerFromMarketplace(
  input: InstallMcpMarketplaceServerInput,
): Promise<McpWorkspaceSnapshot> {
  const installedServerConfig = input.server.server
    ?? mcpMarketplaceServerFixtures.find((server) => server.id === input.server.id)?.server
    ?? {};
  const normalizedName = input.server.name.trim().toLowerCase();
  const installedServer = {
    id: normalizeMcpServerId(input.server.name),
    name: normalizedName,
    serverType: String(installedServerConfig.type ?? "stdio"),
    commandLabel: buildMcpCommandLabel(installedServerConfig),
    description: input.server.description,
    sourceUrl: input.server.sourceUrl,
    serverJson: JSON.stringify(installedServerConfig, null, 2),
    enabledAppCount: 0,
    apps: mcpWorkspaceFixture.apps.map((app) => ({
      appId: app.id,
      appName: app.name,
      configPath: app.configPath,
      statusLabel: app.statusLabel,
      isEnabled: false,
    })),
    tools: [],
    toolsDiscoveredAt: "",
    toolsDiscoveryError: "",
    installedAt: getCurrentTimestampLabel(),
  };
  const fallback = {
    ...mcpWorkspaceFixture,
    servers: [installedServer, ...mcpWorkspaceFixture.servers.filter((item) => item.id !== installedServer.id)],
  };

  const workspace = await invokeOrFallback("install_mcp_server_from_marketplace", input, fallback);
  return normalizeMcpWorkspaceSnapshot(workspace);
}

export async function importMcpServersFromApps(): Promise<number> {
  return invokeOrFallback("import_mcp_servers_from_apps", {}, 2);
}

export function startMcpServersImport(
  runner: () => Promise<number> = importMcpServersFromApps,
): Promise<number> {
  if (activeMcpImportPromise) {
    return activeMcpImportPromise;
  }

  ensureMcpImportProgressListener();
  setMcpImportSession({
    isImporting: true,
    progress: null,
  });
  activeMcpImportPromise = runner()
    .finally(() => {
      activeMcpImportPromise = null;
      setMcpImportSession({
        isImporting: false,
        progress: mcpImportSession.progress,
      });
    });

  return activeMcpImportPromise;
}

export async function listenMcpImportProgress(
  handler: (progress: McpImportProgress) => void,
): Promise<UnlistenFn> {
  if (shouldUseFixtureData()) {
    return () => undefined;
  }

  return listen<McpImportProgress>("mcp-import-progress", (event) => {
    handler(event.payload);
  });
}

export async function saveMcpServer(server: McpServerRecord): Promise<McpWorkspaceSnapshot> {
  const normalizedName = server.name.trim().toLowerCase() || server.id;
  const explicitDescription = typeof server.server.description === "string"
    ? server.server.description.trim()
    : "";
  const commandLabel =
    typeof server.server.command === "string"
      ? [server.server.command, ...(Array.isArray(server.server.args) ? server.server.args : [])].join(" ")
      : String(server.server.url ?? "");
  const serverType = String(server.server.type ?? "stdio");
  const displayServer = omitDefaultStdioType(server.server);
  const nextServer = {
    id: server.id,
    name: normalizedName,
    serverType,
    commandLabel,
    description: explicitDescription || tx(getCurrentAppLanguage(), "mcp.description.default", { name: normalizedName }),
    sourceUrl: server.sourceUrl,
    serverJson: JSON.stringify(displayServer, null, 2),
    enabledAppCount: server.enabledAppIds.length,
    apps: mcpWorkspaceFixture.apps.map((app) => ({
      appId: app.id,
      appName: app.name,
      configPath: app.configPath,
      statusLabel: app.statusLabel,
      isEnabled: server.enabledAppIds.includes(app.id),
    })),
    tools: server.tools,
    toolsDiscoveredAt: server.toolsDiscoveredAt,
    toolsDiscoveryError: server.toolsDiscoveryError,
    installedAt: server.installedAt,
  };
  const fallback = {
    ...mcpWorkspaceFixture,
    servers: [nextServer, ...mcpWorkspaceFixture.servers.filter((item) => item.id !== server.id)],
  };
  const workspace = await invokeOrFallback("upsert_mcp_server", { server }, fallback);
  return normalizeMcpWorkspaceSnapshot(workspace);
}

export async function deleteMcpServer(serverId: string): Promise<McpWorkspaceSnapshot> {
  const fallback = {
    ...mcpWorkspaceFixture,
    servers: mcpWorkspaceFixture.servers.filter((item) => item.id !== serverId),
  };
  const workspace = await invokeOrFallback("delete_mcp_server", { id: serverId }, fallback);
  return normalizeMcpWorkspaceSnapshot(workspace);
}

export async function toggleMcpServerApp(input: ToggleMcpAppInput): Promise<McpWorkspaceSnapshot> {
  const fallback = {
    ...mcpWorkspaceFixture,
    servers: mcpWorkspaceFixture.servers.map((server) => (
      server.id === input.serverId
        ? {
            ...server,
            enabledAppCount: server.apps.filter((app) =>
              app.appId === input.appId ? input.enabled : app.isEnabled,
            ).length,
            apps: server.apps.map((app) =>
              app.appId === input.appId ? { ...app, isEnabled: input.enabled } : app,
            ),
          }
        : server
    )),
  };
  const workspace = await invokeOrFallback("toggle_mcp_server_app", input, fallback);
  return normalizeMcpWorkspaceSnapshot(workspace);
}

export async function toggleMcpServerTool(input: ToggleMcpToolInput): Promise<McpWorkspaceSnapshot> {
  const fallback = {
    ...mcpWorkspaceFixture,
    servers: mcpWorkspaceFixture.servers.map((server) => (
      server.id === input.serverId
        ? {
            ...server,
            tools: server.tools.map((tool) =>
              tool.name === input.toolName ? { ...tool, isEnabled: input.enabled } : tool,
            ),
          }
        : server
    )),
  };
  const workspace = await invokeOrFallback("toggle_mcp_server_tool", input, fallback);
  return normalizeMcpWorkspaceSnapshot(workspace);
}

export async function refreshMcpServerTools(serverId: string): Promise<McpWorkspaceSnapshot> {
  const fallbackMarketplaceServer = mcpMarketplaceServerFixtures.find(
    (server) => normalizeMcpServerId(server.name) === serverId,
  );
  const fallbackServer = mcpWorkspaceFixture.servers.find((server) => server.id === serverId)
    ?? (fallbackMarketplaceServer
      ? {
          id: serverId,
          name: fallbackMarketplaceServer.name,
          serverType: String(fallbackMarketplaceServer.server?.type ?? "stdio"),
          commandLabel: buildMcpCommandLabel(fallbackMarketplaceServer.server),
          description: fallbackMarketplaceServer.description,
          sourceUrl: fallbackMarketplaceServer.sourceUrl,
          serverJson: JSON.stringify(fallbackMarketplaceServer.server ?? {}, null, 2),
          enabledAppCount: 0,
          apps: mcpWorkspaceFixture.apps.map((app) => ({
            appId: app.id,
            appName: app.name,
            configPath: app.configPath,
            statusLabel: app.statusLabel,
            isEnabled: false,
          })),
          tools: [],
          toolsDiscoveredAt: "2026/5/10 16:00:00",
          toolsDiscoveryError: "",
          installedAt: "2026/5/10 16:00:00",
        }
      : undefined);
  const fallback = fallbackServer
    ? {
        ...mcpWorkspaceFixture,
        servers: [fallbackServer, ...mcpWorkspaceFixture.servers.filter((server) => server.id !== serverId)],
      }
    : mcpWorkspaceFixture;
  const workspace = await invokeOrFallback("refresh_mcp_server_tools", { serverId }, fallback);
  return normalizeMcpWorkspaceSnapshot(workspace);
}

function normalizeMcpServerId(name: string) {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "mcp-server";
}

function buildMcpCommandLabel(server: Record<string, unknown> | null) {
  if (!server) {
    return "";
  }
  if (typeof server.command === "string") {
    const args = Array.isArray(server.args)
      ? server.args.filter((item): item is string => typeof item === "string")
      : [];
    return [server.command, ...args].join(" ");
  }
  return typeof server.url === "string" ? server.url : "";
}

function omitDefaultStdioType(server: Record<string, unknown>) {
  if (server.type !== "stdio") {
    return server;
  }

  const { type: _type, ...serverWithoutDefaultType } = server;
  return serverWithoutDefaultType;
}
