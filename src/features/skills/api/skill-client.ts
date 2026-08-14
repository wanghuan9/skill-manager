import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { tx } from "@/app/i18n";
import { isTauriRuntime } from "@/app/is-tauri-runtime";
import {
  appSettingsFixture,
  cliToolFixtures,
  gitAccountFixture,
  githubConnectionFixture,
  installedSkillFixtures,
  localSkillFixtures,
  localInstallSkillCandidateFixtures,
  marketplaceSkillFixtures,
  mcpMarketplaceServerFixtures,
  mcpWorkspaceFixture,
  pluginFixtures,
  pluginProbeFixture,
  pushPreviewFixtures,
  pushTargetFixtures,
  repoSkillCandidateFixtures,
  skillFileBrowserFixtures,
  skillFileDocumentFixtures,
  toolConfigFixtures,
  toolSkillEntryFixtures,
  workspaceSnapshotFixture,
} from "@/features/skills/state/skill-fixtures";
import type {
  AppLanguage,
  AgentSkillsCliStatus,
  AppSettings,
  BackupConflict,
  BackupStatus,
  BackupSyncResult,
  CloudBackupNode,
  CliToolSummary,
  FailureFeedbackInput,
  FeedbackIssueDraft,
  GitAccountSummary,
  GitBranchOption,
  GitChangeFile,
  GithubConnection,
  GithubDeviceFlowStart,
  GithubDevicePollResult,
  LocalSkillCandidate,
  LocalInstallSkillCandidate,
  MarketplaceSkill,
  MarketplaceSkillsPage,
  MarketplaceSourceSite,
  McpMarketplaceServer,
  McpMarketplaceInstallResult,
  McpMarketplaceSourceSite,
  McpImportProgress,
  McpServerRecord,
  McpWorkspaceSnapshot,
  PluginComponentSummary,
  PluginComponentPreview,
  PluginEnabledState,
  PluginHostTool,
  PluginInstallState,
  PluginKind,
  PluginProbeResult,
  PluginScopeSummary,
  PluginSummary,
  PluginStatus,
  PluginUpdateMode,
  PluginUpdateStrategy,
  PushPreviewSnapshot,
  PushTargetSnapshot,
  RepoSkillCandidate,
  SkillFileBrowserSnapshot,
  SkillFileDocument,
  SkillFileEntry,
  SkillSummary,
  ToolConfig,
  ToolSkillEntry,
  UpdatePreviewSnapshot,
  WorkspaceRestorePreview,
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
  isToolInstalledStatus,
  localizeToolStatusLabel,
} from "@/features/skills/utils/tool-status";
import { formatSkillDescription } from "@/features/skills/utils/skill-description";

type InstallFromRepoInput = {
  repoUrl: string;
  gitRef?: string;
};

type ProbePluginRepoInput = {
  path: string;
  hintHostTool?: PluginHostTool;
};

type ProbePluginSourceInput = {
  source: string;
  gitRef?: string;
  sparsePath?: string;
  hintHostTool?: PluginHostTool;
};

type InstallSelectedPluginProbesInput = {
  probes: PluginProbeResult[];
  hostTools: PluginHostTool[];
};

type PluginComponentPreviewInput = {
  pluginRoot: string;
  componentId: string;
  assetType: PluginComponentSummary["assetType"];
};

type SavePluginComponentPreviewInput = PluginComponentPreviewInput & {
  content: string;
};

type PluginPreviewTargetInput = {
  hostTool: PluginHostTool;
  rootPath: string;
  repoRootPath: string;
  pluginRelativePath: string;
};

type SetPluginEnabledInput = {
  pluginId: string;
  hostTool: PluginHostTool;
  rootPath: string;
  enabled: boolean;
};

type DeletePluginInput = {
  pluginId: string;
  hostTool: PluginHostTool;
  rootPath: string;
};

type UpdatePluginInput = {
  pluginId: string;
  hostTool: PluginHostTool;
  rootPath: string;
};

type InstallSelectedRepoSkillsInput = {
  repoUrl: string;
  selectedPaths: string[];
  gitRef?: string;
};

type ListGitRepoBranchesInput = {
  repoUrl: string;
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
  skillPath?: string;
  targetBranch: string;
  createBranchName?: string;
};

type OpenSkillInEditorInput = {
  skillName: string;
  skillPath?: string;
  editorId: string;
};

type OpenPluginInEditorInput = {
  rootPath: string;
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
  skillPath?: string;
};

type SkillFileInput = {
  skillName: string;
  skillPath?: string;
  relativePath: string;
};

type ToolSkillInput = {
  toolId: string;
  skillName: string;
};

type ToolSkillFileInput = ToolSkillInput & {
  relativePath: string;
};

type SaveSkillFileInput = SkillFileInput & {
  content: string;
};

type MarketplaceSkillFileInput = {
  sourceSite?: MarketplaceSourceSite;
  sourceUrl: string;
  skillPath: string;
  skillName: string;
  skillId?: string;
  owner?: string;
  slug?: string;
  version?: string;
};

type MarketplaceSkillFileContentInput = Omit<MarketplaceSkillFileInput, "skillName"> & {
  relativePath: string;
};

type ToggleSkillToolInput = {
  skillName: string;
  skillPath?: string;
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
  skillPath?: string;
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

type SkillLibraryChangeEvent = {
  skillName: string;
};

type SkillLibraryRefreshedEvent = {
  installedSkills: LegacySkillSummary[];
  localCandidates: LocalSkillCandidate[];
  toolSkillEntries: ToolSkillEntry[];
};

type LegacySkillSummary = Partial<SkillSummary> & {
  lastSyncedAt?: string;
};

type LegacyPluginSummary = Partial<PluginSummary> & {
  components?: PluginComponentSummary[];
};

type LegacyPluginProbeResult = Partial<PluginProbeResult> & {
  components?: PluginComponentSummary[];
};

type LegacyPluginComponentPreview = Partial<PluginComponentPreview>;

type LegacyCliToolSummary = Partial<CliToolSummary>;

function pluginSourceCandidateFixtures(input: ProbePluginSourceInput): LegacyPluginProbeResult[] {
  const source = input.source.trim();
  const sparsePath = input.sparsePath?.trim() ?? "";
  const agenticEngineeringProbe: LegacyPluginProbeResult = {
    tool: "codex",
    compatibleHostTools: ["codex", "claude-code", "cursor", "opencode"],
    kind: "plugin-repo",
    description: "基于 Skill 的模块化 Example Plugin 框架",
    pluginRoot: "/tmp/example-repo/example-plugin",
    manifestPath: "/tmp/example-repo/example-plugin/.codex-plugin/plugin.json",
    marketplaceManifestPath: "",
    components: [
      {
        id: "skills/workflow-code-generation",
        name: "workflow-code-generation",
        description: "",
        assetType: "skill",
        ownerPluginId: "",
        packageItemId: "skills/workflow-code-generation",
      },
      {
        id: "agents/codebase-researcher.md",
        name: "codebase-researcher.md",
        description: "",
        assetType: "subagent",
        ownerPluginId: "",
        packageItemId: "agents/codebase-researcher.md",
      },
    ],
    sourceType: "git",
    sourceUrl: source,
    isGitRepo: true,
    gitRoot: "/tmp/example-repo",
    confidence: "high",
    installStrategy: "codex-marketplace",
    warnings: [],
  };
  const workflowPluginProbe: LegacyPluginProbeResult = {
    tool: "claude-code",
    compatibleHostTools: ["claude-code"],
    kind: "plugin-repo",
    description: "面向工作流编排与项目初始化的插件集合",
    pluginRoot: "/tmp/example-repo/plugins/example-plugin",
    manifestPath: "/tmp/example-repo/plugins/example-plugin/.claude-plugin/plugin.json",
    marketplaceManifestPath: "",
    components: [
      {
        id: "commands/init-project.md",
        name: "init-project.md",
        description: "",
        assetType: "command",
        ownerPluginId: "",
        packageItemId: "commands/init-project.md",
      },
    ],
    sourceType: "git",
    sourceUrl: source,
    isGitRepo: true,
    gitRoot: "/tmp/example-repo",
    confidence: "high",
    installStrategy: "claude-plugin-dir",
    warnings: [],
  };

  if (!source.includes("example-repo")) {
    return [pluginProbeFixture];
  }
  if (sparsePath === "example-plugin") {
    return [agenticEngineeringProbe];
  }
  if (sparsePath === "plugins/example-plugin") {
    return [workflowPluginProbe];
  }

  return [agenticEngineeringProbe, workflowPluginProbe];
}

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
    storageInitialized: workspace.storageInitialized ?? true,
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
  const lifecycleSource = skill.lifecycleSource === "plugin" ? "plugin" : skill.lifecycleSource === "direct" ? "direct" : undefined;
  const ownerPluginId = skill.ownerPluginId?.trim() || undefined;
  const ownerPluginName = skill.ownerPluginName?.trim() || undefined;

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
    localChangeCount: skill.localChangeCount ?? 0,
    lifecycleSource,
    ownerPluginId,
    ownerPluginName,
    backupId: skill.backupId ?? "",
    entryPath: skill.entryPath ?? skill.localPath ?? "",
    canonicalPath: skill.canonicalPath ?? skill.localPath ?? "",
    managementOwner: skill.managementOwner ?? "skilldock",
    updateDriver: skill.updateDriver ?? (skill.gitLinked ? "git" : "none"),
    skillEntries: skill.skillEntries ?? [skill.entryPath ?? skill.localPath ?? ""].filter(Boolean),
    pathError: skill.pathError ?? "",
    contentHash: skill.contentHash ?? "",
    marketplaceOwner: skill.marketplaceOwner ?? "",
    marketplaceSlug: skill.marketplaceSlug ?? "",
    marketplaceVersion: skill.marketplaceVersion ?? "",
    marketplaceContentHash: skill.marketplaceContentHash ?? "",
    tools: (skill.tools ?? []).map((tool) => ({
      ...tool,
      statusLabel: localizeToolStatusLabel(tool.statusLabel, language),
    })),
  };
}

function normalizeSkillSummaryList(skills: LegacySkillSummary[]): SkillSummary[] {
  return skills.map((skill) => normalizeSkillSummary(skill));
}

function isPluginHostTool(tool: string | undefined): tool is PluginHostTool {
  return tool === "claude-code" || tool === "cursor" || tool === "codex" || tool === "opencode";
}

function normalizePluginHostTool(tool: string | undefined): PluginHostTool {
  if (isPluginHostTool(tool)) {
    return tool;
  }

  return "codex";
}

function normalizePluginKind(kind: string | undefined): PluginKind {
  if (kind === "plugin-repo" || kind === "marketplace-root" || kind === "standalone-assets" || kind === "unknown") {
    return kind;
  }

  return "unknown";
}

function normalizePluginUpdateMode(updateMode: string | undefined): PluginUpdateMode {
  return updateMode === "auto" ? "auto" : "unsupported";
}

function normalizePluginUpdateStrategy(
  updateStrategy: string | undefined,
): PluginUpdateStrategy {
  if (updateStrategy === "git" || updateStrategy === "hash" || updateStrategy === "none") {
    return updateStrategy;
  }

  return "none";
}

function normalizePluginInstallState(installState: string | undefined): PluginInstallState {
  if (installState === "installed" || installState === "broken" || installState === "detected") {
    return installState;
  }

  return "installed";
}

function normalizePluginInstallSource(installSource: string | undefined): PluginSummary["installSource"] {
  return installSource === "skilldock" ? "skilldock" : "host";
}

function normalizePluginEnabledState(enabledState: string | undefined): PluginEnabledState {
  if (enabledState === "enabled" || enabledState === "disabled" || enabledState === "unknown") {
    return enabledState;
  }

  return "unknown";
}

function normalizePluginStatus(status: string | undefined): PluginStatus {
  if (
    status === "ready"
    || status === "update-available"
    || status === "invalid"
    || status === "scan-error"
    || status === "unsupported"
  ) {
    return status;
  }

  return "invalid";
}

function normalizePluginComponents(components: PluginComponentSummary[] | undefined): PluginComponentSummary[] {
  if (!Array.isArray(components)) {
    return [];
  }

  return components.map((component) => ({
    id: component.id ?? "",
    name: component.name ?? "",
    description: component.description ?? "",
    assetType:
      component.assetType === "skill"
      || component.assetType === "subagent"
      || component.assetType === "mcp"
      || component.assetType === "command"
      || component.assetType === "rule"
      || component.assetType === "hook"
        ? component.assetType
        : "command",
    ownerPluginId: component.ownerPluginId ?? "",
    packageItemId: component.packageItemId ?? "",
  }));
}

function normalizePluginScopes(scopes: PluginScopeSummary[] | undefined): PluginScopeSummary[] {
  if (!Array.isArray(scopes)) {
    return [];
  }

  return scopes.map((scope) => ({
    scopeId:
      scope.scopeId === "user" || scope.scopeId === "project" || scope.scopeId === "local-project"
        ? scope.scopeId
        : "user",
    scopeLabel: scope.scopeLabel ?? "",
    enabledState: normalizePluginEnabledState(scope.enabledState),
    location: scope.location ?? "",
  }));
}

function currentTimestampLabel() {
  return `${Date.now()}`;
}

function normalizePluginSummary(plugin: LegacyPluginSummary): PluginSummary {
  const fallbackUpdatedAt = plugin.updatedAt ?? currentTimestampLabel();
  const remoteUpdatedAt = plugin.remoteUpdatedAt ?? fallbackUpdatedAt;
  const localUpdatedAt = plugin.localUpdatedAt ?? fallbackUpdatedAt;

  return {
    id: plugin.id ?? "",
    packageId: plugin.packageId ?? "",
    manifestName: plugin.manifestName ?? "",
    name: plugin.name ?? "",
    description: plugin.description ?? "",
    hostTool: normalizePluginHostTool(plugin.hostTool),
    relatedHostTools: Array.isArray(plugin.relatedHostTools)
      ? plugin.relatedHostTools.filter(isPluginHostTool)
      : [],
    kind: normalizePluginKind(plugin.kind),
    rootPath: plugin.rootPath ?? "",
    displayRootPath: plugin.displayRootPath ?? plugin.rootPath ?? "",
    repoRootPath: plugin.repoRootPath ?? plugin.rootPath ?? "",
    pluginRelativePath: plugin.pluginRelativePath ?? "",
    manifestPath: plugin.manifestPath ?? "",
    sourceType: plugin.sourceType === "git" || plugin.sourceType === "local" || plugin.sourceType === "marketplace"
      ? plugin.sourceType
      : "local",
    sourceLabel: plugin.sourceLabel ?? "",
    sourceUrl: plugin.sourceUrl ?? "",
    sourceRef: plugin.sourceRef ?? "",
    sourceRevision: plugin.sourceRevision ?? "",
    currentVersion: plugin.currentVersion ?? "",
    currentBranch: plugin.currentBranch ?? "",
    currentCommit: plugin.currentCommit ?? "",
    collabStatus:
      plugin.collabStatus === "update-available"
      || plugin.collabStatus === "pending-commit"
      || plugin.collabStatus === "pending-push"
      || plugin.collabStatus === "diverged"
        ? plugin.collabStatus
        : "clean",
    statusText: plugin.statusText ?? "",
    isGitRepo: plugin.isGitRepo ?? false,
    updateMode: normalizePluginUpdateMode(plugin.updateMode),
    updateStrategy: normalizePluginUpdateStrategy(plugin.updateStrategy),
    updateAvailable: plugin.updateAvailable ?? false,
    baselineHash: plugin.baselineHash ?? "",
    localModified: Boolean(plugin.localModified),
    localChangeCount: plugin.localChangeCount ?? 0,
    installedAt: plugin.installedAt ?? "",
    updatedAt: fallbackUpdatedAt,
    remoteUpdatedAt,
    localUpdatedAt,
    lastEditor: plugin.lastEditor ?? "",
    lastScannedAt: plugin.lastScannedAt ?? "",
    status: normalizePluginStatus(plugin.status),
    installState: normalizePluginInstallState(plugin.installState),
    installSource: normalizePluginInstallSource(plugin.installSource),
    enabledState: normalizePluginEnabledState(plugin.enabledState),
    scopes: normalizePluginScopes(plugin.scopes),
    components: normalizePluginComponents(plugin.components),
  };
}

function normalizePluginSummaryList(plugins: LegacyPluginSummary[]): PluginSummary[] {
  return plugins.map((plugin) => normalizePluginSummary(plugin));
}

function normalizePluginProbeResult(probe: LegacyPluginProbeResult): PluginProbeResult {
  const compatibleHostTools = Array.isArray(probe.compatibleHostTools)
    ? probe.compatibleHostTools.filter(isPluginHostTool)
    : [];
  const tool = isPluginHostTool(probe.tool) ? probe.tool : "unknown";

  return {
    tool,
    compatibleHostTools: compatibleHostTools.length > 0 ? compatibleHostTools : tool === "unknown" ? [] : [tool],
    kind: normalizePluginKind(probe.kind),
    manifestName: probe.manifestName?.trim() || "",
    name: probe.name?.trim() || probe.pluginRoot?.split("/").filter(Boolean).at(-1) || "Plugin",
    description: formatSkillDescription(probe.description ?? ""),
    pluginRoot: probe.pluginRoot ?? "",
    repoRoot: probe.repoRoot ?? probe.gitRoot ?? "",
    pluginRelativePath: probe.pluginRelativePath ?? "",
    manifestPath: probe.manifestPath ?? "",
    marketplaceManifestPath: probe.marketplaceManifestPath ?? "",
    components: normalizePluginComponents(probe.components),
    sourceType: probe.sourceType === "git" || probe.sourceType === "local" || probe.sourceType === "marketplace"
      ? probe.sourceType
      : "local",
    sourceUrl: probe.sourceUrl ?? "",
    sourceRef: probe.sourceRef ?? "",
    isGitRepo: probe.isGitRepo ?? false,
    gitRoot: probe.gitRoot ?? "",
    confidence: probe.confidence === "high" || probe.confidence === "medium" || probe.confidence === "low"
      ? probe.confidence
      : "low",
    installStrategy:
      probe.installStrategy === "codex-marketplace"
      || probe.installStrategy === "claude-plugin-dir"
      || probe.installStrategy === "cursor-registration"
      || probe.installStrategy === "opencode-plugin-link"
      || probe.installStrategy === "unsupported"
        ? probe.installStrategy
        : "unsupported",
    warnings: Array.isArray(probe.warnings) ? probe.warnings : [],
  };
}

function normalizeCliToolSummary(cliTool: LegacyCliToolSummary): CliToolSummary {
  return {
    id: cliTool.id ?? "",
    name: cliTool.name ?? "",
    ownerPluginId: cliTool.ownerPluginId?.trim() || undefined,
    ownerPluginName: cliTool.ownerPluginName?.trim() || undefined,
    lifecycleSource: cliTool.lifecycleSource === "plugin" ? "plugin" : "direct",
    command: cliTool.command ?? "",
    executablePath: cliTool.executablePath?.trim() || undefined,
    statusLabel: cliTool.statusLabel?.trim() || undefined,
    updateCommand: cliTool.updateCommand?.trim() || undefined,
    updateStrategy: cliTool.updateStrategy === "self-only" ? "self-only" : "linked-skills",
    bundledSkills: Array.isArray(cliTool.bundledSkills) ? cliTool.bundledSkills.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
    description: cliTool.description ?? "",
  };
}

function normalizeCliToolSummaryList(cliTools: LegacyCliToolSummary[]): CliToolSummary[] {
  return cliTools.map((cliTool) => normalizeCliToolSummary(cliTool));
}

function normalizePluginComponentPreview(preview: LegacyPluginComponentPreview): PluginComponentPreview {
  const fallbackPath = preview.path ?? "";
  const fallbackName = fallbackPath.split("/").pop() || fallbackPath || preview.title || "";
  const entries = Array.isArray(preview.entries)
    ? preview.entries
        .filter((entry): entry is SkillFileEntry => (
          typeof entry?.path === "string"
          && typeof entry.name === "string"
          && (entry.entryType === "file" || entry.entryType === "directory")
          && typeof entry.depth === "number"
        ))
    : [];
  const normalizedEntries: SkillFileEntry[] = entries.length > 0
    ? entries
    : fallbackPath
      ? [{ path: fallbackPath, name: fallbackName, entryType: "file" as const, depth: 0 }]
      : [];

  return {
    path: fallbackPath,
    title: preview.title ?? "",
    assetType:
      preview.assetType === "skill"
      || preview.assetType === "subagent"
      || preview.assetType === "mcp"
      || preview.assetType === "command"
      || preview.assetType === "rule"
      || preview.assetType === "hook"
        ? preview.assetType
        : "command",
    content: preview.content ?? "",
    rootName: preview.rootName ?? fallbackName,
    entries: normalizedEntries,
    initialFilePath: preview.initialFilePath ?? (fallbackPath || null),
  };
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

export async function fetchInstalledPlugins(): Promise<PluginSummary[]> {
  const plugins = await invokeOrFallback<LegacyPluginSummary[]>("list_installed_plugins", {}, pluginFixtures);
  return normalizePluginSummaryList(plugins);
}

export async function fetchStartupInstalledPlugins(): Promise<PluginSummary[]> {
  const plugins = await invokeOrFallback<LegacyPluginSummary[]>(
    "list_startup_installed_plugins",
    {},
    pluginFixtures,
  );
  return normalizePluginSummaryList(plugins);
}

export async function refreshPluginStates(): Promise<PluginSummary[]> {
  const plugins = await invokeOrFallback<LegacyPluginSummary[]>(
    "refresh_plugin_states",
    {},
    pluginFixtures,
  );
  return normalizePluginSummaryList(plugins);
}

export async function fetchLocalPluginStates(): Promise<PluginSummary[]> {
  const plugins = await invokeOrFallback<LegacyPluginSummary[]>(
    "refresh_local_plugin_states",
    {},
    pluginFixtures,
  );
  return normalizePluginSummaryList(plugins);
}

export async function setPluginEnabled(input: SetPluginEnabledInput): Promise<PluginSummary> {
  if (shouldUseFixtureData()) {
    const plugin = pluginFixtures.find((candidate) =>
      candidate.id === input.pluginId
      || (candidate.hostTool === input.hostTool && candidate.rootPath === input.rootPath)
    );
    if (!plugin) {
      throw new Error("Plugin fixture not found");
    }

    plugin.enabledState = input.enabled ? "enabled" : "disabled";
    plugin.scopes = plugin.scopes.map((scope) => ({
      ...scope,
      enabledState: input.enabled ? "enabled" : "disabled",
    }));
    return normalizePluginSummary(plugin);
  }

  const plugin = await invokeOrFallback<LegacyPluginSummary>(
    "set_plugin_enabled",
    {
      hostTool: input.hostTool,
      rootPath: input.rootPath,
      enabled: input.enabled,
    },
    pluginFixtures[0],
  );
  return normalizePluginSummary(plugin);
}

export async function updatePlugin(input: UpdatePluginInput): Promise<PluginSummary> {
  if (shouldUseFixtureData()) {
    const plugin = pluginFixtures.find((candidate) =>
      candidate.id === input.pluginId
      || (candidate.hostTool === input.hostTool && candidate.rootPath === input.rootPath)
    );
    if (!plugin) {
      throw new Error("Plugin fixture not found");
    }

    plugin.collabStatus = "clean";
    plugin.statusText = "插件目录已是最新。";
    plugin.updateAvailable = false;
    plugin.localModified = false;
    return normalizePluginSummary(plugin);
  }

  const plugin = await invokeOrFallback<LegacyPluginSummary>(
    "update_plugin",
    {
      hostTool: input.hostTool,
      rootPath: input.rootPath,
    },
    pluginFixtures[0],
  );
  return normalizePluginSummary(plugin);
}

export async function fetchPluginLocalChanges(
  input: PluginPreviewTargetInput,
): Promise<GitChangeFile[]> {
  return invokeOrFallback("get_plugin_local_changes", input, []);
}

export async function fetchPluginFileBrowser(
  input: PluginPreviewTargetInput,
): Promise<SkillFileBrowserSnapshot> {
  const pluginName = input.rootPath.split("/").filter(Boolean).pop() || "plugin";
  const fallback: SkillFileBrowserSnapshot = {
    skillName: pluginName,
    rootName: pluginName,
    entries: [{ path: "", name: pluginName, entryType: "directory", depth: 0 }],
    initialFilePath: null,
    previewMode: "full",
  };
  return invokeOrFallback("get_plugin_file_browser", input, fallback);
}

export async function fetchPluginFileContent(
  input: PluginPreviewTargetInput & { relativePath: string },
): Promise<SkillFileDocument> {
  const fallback: SkillFileDocument = { path: input.relativePath, content: "" };
  return invokeOrFallback("get_plugin_file_content", input, fallback);
}

export async function savePluginFileContent(
  input: PluginPreviewTargetInput & { relativePath: string; content: string },
): Promise<SkillFileDocument> {
  const fallback: SkillFileDocument = { path: input.relativePath, content: input.content };
  return invokeOrFallback("save_plugin_file_content", input, fallback);
}

export async function revertPluginChange(
  input: PluginPreviewTargetInput & {
    relativePath: string;
    hunkIndex?: number;
    expectedPatch?: string;
    staged?: boolean;
  },
): Promise<void> {
  return invokeOrFallback("revert_plugin_change", {
    ...input,
    hunkIndex: input.hunkIndex ?? null,
    expectedPatch: input.expectedPatch ?? null,
    staged: input.staged ?? false,
  }, undefined);
}

export async function fetchPluginUpdatePreview(
  input: PluginPreviewTargetInput,
): Promise<UpdatePreviewSnapshot> {
  const fallback: UpdatePreviewSnapshot = {
    currentBranch: "main",
    remoteBranch: "origin/main",
    commitsToPull: 0,
    changedFiles: [],
    hasLocalChanges: false,
  };
  return invokeOrFallback("get_plugin_update_preview", input, fallback);
}

export async function deletePlugin(input: DeletePluginInput): Promise<void> {
  if (shouldUseFixtureData()) {
    const pluginIndex = pluginFixtures.findIndex((candidate) =>
      candidate.id === input.pluginId
      || (candidate.hostTool === input.hostTool && candidate.rootPath === input.rootPath)
    );
    if (pluginIndex < 0) {
      throw new Error("Plugin fixture not found");
    }

    pluginFixtures.splice(pluginIndex, 1);
    return undefined;
  }

  return invokeOrFallback(
    "delete_plugin",
    {
      hostTool: input.hostTool,
      rootPath: input.rootPath,
    },
    undefined,
  );
}

export async function fetchCliTools(): Promise<CliToolSummary[]> {
  const cliTools = await invokeOrFallback<LegacyCliToolSummary[]>("list_cli_tools", {}, cliToolFixtures);
  return normalizeCliToolSummaryList(cliTools);
}

export async function probePluginRepo(input: ProbePluginRepoInput): Promise<PluginProbeResult> {
  const probe = await invokeOrFallback<LegacyPluginProbeResult>("probe_plugin_repo", input, pluginProbeFixture);
  return normalizePluginProbeResult(probe);
}

export async function probePluginSource(input: ProbePluginSourceInput): Promise<PluginProbeResult> {
  const probe = await invokeOrFallback<LegacyPluginProbeResult>("probe_plugin_source", input, pluginProbeFixture);
  return normalizePluginProbeResult(probe);
}

export async function probePluginSourceCandidates(input: ProbePluginSourceInput): Promise<PluginProbeResult[]> {
  if (shouldUseFixtureData()) {
    return pluginSourceCandidateFixtures(input).map(normalizePluginProbeResult);
  }

  const probes = await invokeOrFallback<LegacyPluginProbeResult[]>(
    "probe_plugin_source_candidates",
    input,
    pluginSourceCandidateFixtures(input),
  );
  return probes.map(normalizePluginProbeResult);
}

export async function installSelectedPluginProbes(
  input: InstallSelectedPluginProbesInput,
): Promise<PluginSummary[]> {
  if (shouldUseFixtureData()) {
    return input.probes.flatMap((probe) =>
      input.hostTools
        .filter((hostTool) => probe.compatibleHostTools.includes(hostTool))
        .map((hostTool, index) =>
          normalizePluginSummary({
            ...pluginFixtures[0],
            id: `${hostTool}:${probe.pluginRoot.split("/").filter(Boolean).pop() ?? "plugin"}`,
            name: probe.pluginRoot.split("/").filter(Boolean).pop() ?? "Plugin",
            hostTool,
            relatedHostTools: probe.compatibleHostTools.filter((tool) => tool !== hostTool),
            kind: "plugin-repo",
            rootPath: probe.pluginRoot,
            manifestPath: probe.manifestPath,
            sourceType: probe.sourceType,
            sourceLabel: "skilldock",
            sourceUrl: probe.sourceUrl,
            installedAt: `${Date.now() + index}`,
            updatedAt: `${Date.now() + index}`,
            installState: "installed",
            enabledState: "enabled",
            components: probe.components,
          }),
        )
    );
  }

  const plugins = await invokeOrFallback<LegacyPluginSummary[]>(
    "install_selected_plugin_probes",
    input,
    [],
  );
  return normalizePluginSummaryList(plugins);
}

export async function fetchPluginComponentPreview(
  input: PluginComponentPreviewInput,
): Promise<PluginComponentPreview> {
  const fallbackPath =
    input.assetType === "skill"
      ? `${input.componentId.replace(/\/+$/, "")}/SKILL.md`
      : input.componentId;
  const fallback = {
    path: fallbackPath,
    title: fallbackPath.split("/").at(-2) || fallbackPath.split("/").pop() || fallbackPath,
    assetType: input.assetType,
    content: `# ${input.componentId}\n\n本地开发预览内容。`,
  };
  const preview = await invokeOrFallback<LegacyPluginComponentPreview>(
    "get_plugin_component_preview",
    input,
    fallback,
  );
  return normalizePluginComponentPreview(preview);
}

export async function savePluginComponentPreview(
  input: SavePluginComponentPreviewInput,
): Promise<PluginComponentPreview> {
  const fallbackPath =
    input.assetType === "skill"
      ? `${input.componentId.replace(/\/+$/, "")}/SKILL.md`
      : input.componentId;
  const fallback = {
    path: fallbackPath,
    title: fallbackPath.split("/").at(-2) || fallbackPath.split("/").pop() || fallbackPath,
    assetType: input.assetType,
    content: input.content,
  };
  const preview = await invokeOrFallback<LegacyPluginComponentPreview>(
    "save_plugin_component_preview",
    input,
    fallback,
  );
  return normalizePluginComponentPreview(preview);
}

export async function fetchStartupInstalledSkills(): Promise<SkillSummary[]> {
  const skills = await invokeOrFallback<LegacySkillSummary[]>(
    "list_startup_installed_skills",
    {},
    installedSkillFixtures,
  );
  return normalizeSkillSummaryList(skills);
}

type GitStateRefreshResult = {
  skills: LegacySkillSummary[];
  githubRateLimited: boolean;
};

export async function fetchGitStates(): Promise<{
  skills: SkillSummary[];
  githubRateLimited: boolean;
}> {
  const result = await invokeOrFallback<LegacySkillSummary[] | GitStateRefreshResult>(
    "refresh_git_states",
    {},
    installedSkillFixtures,
  );
  if (Array.isArray(result)) {
    return {
      skills: normalizeSkillSummaryList(result),
      githubRateLimited: false,
    };
  }
  return {
    skills: normalizeSkillSummaryList(result.skills),
    githubRateLimited: result.githubRateLimited,
  };
}

export async function refreshLocalGitState(skillName: string, skillPath?: string): Promise<SkillSummary> {
  const fallbackSource =
    installedSkillFixtures.find((skill) => skill.name === skillName) ??
    installedSkillFixtures[0];
  const updatedSkill = await invokeOrFallback<LegacySkillSummary>(
    "refresh_local_git_state",
    { skillName, skillPath },
    fallbackSource,
  );
  return normalizeSkillSummary(updatedSkill);
}

export async function fetchLocalGitStates(): Promise<SkillSummary[]> {
  const skills = await invokeOrFallback<LegacySkillSummary[]>(
    "refresh_local_git_states",
    {},
    installedSkillFixtures,
  );
  return normalizeSkillSummaryList(skills);
}

export async function subscribeSkillLibraryChanges(
  handler: (payload: SkillLibraryChangeEvent) => void,
): Promise<UnlistenFn> {
  if (shouldUseFixtureData()) {
    return () => undefined;
  }

  return listen<SkillLibraryChangeEvent>("skill-library-changed", (event) => {
    handler(event.payload);
  });
}

export async function subscribeSkillLibraryRefreshes(
  handler: (payload: {
    installedSkills: SkillSummary[];
    localCandidates: LocalSkillCandidate[];
    toolSkillEntries: ToolSkillEntry[];
  }) => void,
): Promise<UnlistenFn> {
  if (shouldUseFixtureData()) {
    return () => undefined;
  }

  return listen<SkillLibraryRefreshedEvent>("skill-library-refreshed", (event) => {
    handler({
      ...event.payload,
      installedSkills: normalizeSkillSummaryList(event.payload.installedSkills),
    });
  });
}

type PluginLibraryChangeEvent = {
  changedPaths: string[];
};

export async function subscribePluginLibraryChanges(
  handler: (payload: PluginLibraryChangeEvent) => void,
): Promise<UnlistenFn> {
  if (shouldUseFixtureData()) {
    return () => undefined;
  }

  return listen<PluginLibraryChangeEvent>("plugin-library-changed", (event) => {
    handler(event.payload);
  });
}

export async function refreshLocalPluginState(input: {
  hostTool: PluginHostTool;
  rootPath: string;
}): Promise<PluginSummary> {
  const fallbackSource =
    pluginFixtures.find((plugin) =>
      plugin.hostTool === input.hostTool && plugin.rootPath === input.rootPath,
    ) ?? pluginFixtures[0];
  const updatedPlugin = await invokeOrFallback<LegacyPluginSummary>(
    "refresh_local_plugin_state",
    input,
    fallbackSource,
  );
  return normalizePluginSummary(updatedPlugin);
}

export async function fetchMarketplaceSkillsByPage(input: {
  sourceSite?: MarketplaceSourceSite;
  page: number;
  limit: number;
  query?: string;
  refresh?: boolean;
}): Promise<MarketplaceSkillsPage> {
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
  const fallbackSkills = filtered.slice(start, start + limit);
  return invokeOrFallback<MarketplaceSkillsPage>(
    "list_marketplace_skills_page",
    { sourceSite, page, limit, query, refresh },
    {
      skills: fallbackSkills,
      hasMore: start + limit < filtered.length,
    },
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

export async function fetchMarketplaceSkillFileBrowser(
  input: MarketplaceSkillFileInput,
): Promise<SkillFileBrowserSnapshot> {
  return invokeOrFallback(
    "get_marketplace_skill_file_browser",
    input,
    {
      skillName: input.skillName,
      rootName: input.skillName,
      entries: [],
      initialFilePath: null,
      previewMode: "full",
    },
  );
}

export async function fetchMarketplaceSkillDetail(skill: MarketplaceSkill): Promise<MarketplaceSkill> {
  return invokeOrFallback("get_marketplace_skill_detail", { skill }, skill);
}

export async function fetchMarketplaceSkillFileContent(
  input: MarketplaceSkillFileContentInput,
): Promise<SkillFileDocument> {
  return invokeOrFallback(
    "get_marketplace_skill_file_content",
    input,
    {
      path: input.relativePath,
      content: "",
    },
  );
}

export async function fetchLocalSkillCandidates(): Promise<LocalSkillCandidate[]> {
  return invokeOrFallback("list_local_skill_candidates", {}, localSkillFixtures);
}

export async function fetchToolSkillEntries(toolId?: string): Promise<ToolSkillEntry[]> {
  const args = toolId ? { toolId } : {};
  const fallback = toolId
    ? toolSkillEntryFixtures.filter((entry) => entry.toolId === toolId)
    : toolSkillEntryFixtures;
  return invokeOrFallback("list_tool_skill_entries", args, fallback);
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
  const settings = await invokeOrFallback("get_app_settings", {}, appSettingsFixture);
  return {
    ...settings,
    agentSkillsCompatibilityEnabled:
      settings.agentSkillsCompatibilityEnabled ?? settings.skillLibraryProvider === "agent-skills",
    agentSkillsCompatibilityConfigured: settings.agentSkillsCompatibilityConfigured ?? true,
  };
}

export async function fetchGithubConnection(): Promise<GithubConnection> {
  const connection = await invokeOrFallback<GithubConnection | null>(
    "get_github_connection",
    {},
    githubConnectionFixture,
  );
  return {
    ...githubConnectionFixture,
    ...(connection ?? {}),
  };
}

export async function startGithubDeviceFlow(backupScope = false): Promise<GithubDeviceFlowStart> {
  return invoke("start_github_device_flow", { backupScope });
}

export async function pollGithubDeviceFlow(deviceCode: string): Promise<GithubDevicePollResult> {
  return invoke("poll_github_device_flow", { deviceCode });
}

export async function connectGithubToken(token: string): Promise<GithubConnection> {
  if (shouldUseFixtureData()) {
    Object.assign(githubConnectionFixture, {
      connected: token.trim().length > 0,
      authMethod: "pat",
      userId: 1,
      username: "octocat",
      avatarUrl: "",
      credentialPersisted: true,
      warning: "",
    });
    return { ...githubConnectionFixture };
  }
  return invoke("connect_github_token", { token });
}

export async function disconnectGithub(): Promise<GithubConnection> {
  if (shouldUseFixtureData()) {
    Object.assign(githubConnectionFixture, {
      connected: false,
      authMethod: "",
      userId: null,
      username: "",
      avatarUrl: "",
      credentialPersisted: false,
      warning: "",
    });
    return { ...githubConnectionFixture };
  }
  return invoke("disconnect_github", {});
}

const backupStatusFixture: BackupStatus = {
  enabled: false,
  repositoryOwner: "",
  repositoryName: "",
  repositoryUrl: "",
  lastSyncAt: "",
  lastOperation: "",
  lastError: "",
  phase: "disabled",
  syncing: false,
  pendingConflicts: 0,
  progressStage: "",
  progressPercent: 0,
};

export async function fetchBackupStatus(): Promise<BackupStatus> {
  return invokeOrFallback("get_backup_status", {}, backupStatusFixture);
}

export async function enableGithubBackup(): Promise<BackupStatus> {
  return invoke("enable_github_backup", {});
}

export async function disconnectGithubBackup(): Promise<BackupStatus> {
  if (shouldUseFixtureData()) {
    return { ...backupStatusFixture };
  }
  return invoke("disconnect_github_backup", {});
}

export async function runBackupSync(): Promise<BackupStatus> {
  return invoke("run_backup_sync", {});
}

export async function syncBackupToLocal(): Promise<BackupStatus> {
  return invoke("sync_backup_to_local", {});
}

export async function listCloudBackupNodes(): Promise<CloudBackupNode[]> {
  return invokeOrFallback("list_cloud_backup_nodes", {}, []);
}

export async function deleteCloudBackupNode(commitId: string): Promise<void> {
  return invoke("delete_cloud_backup_node", { commitId });
}

export async function restoreCloudBackupNode(commitId: string): Promise<BackupStatus> {
  return invoke("restore_cloud_backup_node", { commitId });
}

export async function previewCloudBackupNode(
  commitId: string,
): Promise<WorkspaceRestorePreview> {
  return invoke("preview_cloud_backup_node", { commitId });
}

export async function subscribeBackupStatusChanges(
  handler: (status: BackupStatus) => void,
): Promise<UnlistenFn> {
  if (shouldUseFixtureData()) {
    return () => undefined;
  }
  return listen<BackupStatus>("backup-status-changed", (event) => {
    handler(event.payload);
  });
}

export async function fetchBackupConflicts(): Promise<BackupConflict[]> {
  return invokeOrFallback("list_backup_conflicts", {}, []);
}

export async function resolveBackupConflict(
  conflictId: string,
  resolution: "keepLocal" | "useRemote" | "keepBoth",
): Promise<BackupSyncResult> {
  return invoke("resolve_backup_conflict", { conflictId, resolution });
}

export async function subscribeGithubConnectionChanges(
  handler: (connection: GithubConnection) => void,
): Promise<UnlistenFn> {
  if (shouldUseFixtureData()) {
    return () => undefined;
  }

  return listen<GithubConnection>("github-connection-changed", (event) => {
    handler(event.payload);
  });
}

export async function fetchAgentSkillsCliStatus(): Promise<AgentSkillsCliStatus> {
  return invokeOrFallback<AgentSkillsCliStatus>(
    "get_agent_skills_cli_status",
    {},
    {
      available: false,
      globalPath: "",
      entries: [],
      error: "",
    },
  );
}

export async function updateAppSettings(input: UpdateAppSettingsInput): Promise<AppSettings> {
  if (shouldUseFixtureData()) {
    Object.assign(appSettingsFixture, input.settings);
    appSettingsFixture.agentSkillsCompatibilityEnabled =
      appSettingsFixture.skillLibraryProvider === "agent-skills";
    appSettingsFixture.skillLibraryPath = "/Users/demo/.skilldock/skills";
    return { ...appSettingsFixture };
  }

  return invoke("update_app_settings", input);
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

  return invokeOrFallback(
    "discover_repo_skills",
    { repoUrl: input.repoUrl, gitRef: input.gitRef },
    fallback,
  );
}

export async function fetchGitRepoBranches(
  input: ListGitRepoBranchesInput,
): Promise<GitBranchOption[]> {
  return invokeOrFallback(
    "list_git_repo_branches",
    { repoUrl: input.repoUrl },
    [
      { name: "main", isDefault: true, isSelected: true },
      { name: "master", isDefault: false, isSelected: false },
      { name: "develop", isDefault: false, isSelected: false },
    ],
  );
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

export async function fetchPushTargetSnapshot(
  skillName: string,
  skillPath?: string,
): Promise<PushTargetSnapshot> {
  const fallback =
    pushTargetFixtures[skillName] ?? {
      currentBranch: "main",
      branches: [{ name: "main", isCurrent: true }],
    };

  return invokeOrFallback("get_push_target_snapshot", { skillName, skillPath }, fallback);
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

export async function fetchSkillLocalChanges(skillName: string, skillPath?: string): Promise<GitChangeFile[]> {
  return invokeOrFallback("get_skill_local_changes", { skillName, skillPath }, []);
}

export async function fetchSkillUpdatePreview(skillName: string, localPath = ""): Promise<UpdatePreviewSnapshot> {
  const fallback: UpdatePreviewSnapshot = {
    currentBranch: "main",
    remoteBranch: "origin/main",
    commitsToPull: 0,
    changedFiles: [],
    hasLocalChanges: false,
  };
  return invokeOrFallback("get_update_preview_snapshot", { skillName, localPath }, fallback);
}

export async function revertSkillChange(input: {
  skillName: string;
  skillPath?: string;
  relativePath: string;
  hunkIndex?: number;
  expectedPatch?: string;
  staged?: boolean;
}): Promise<SkillSummary> {
  const fallback = installedSkillFixtures.find((skill) => skill.name === input.skillName)
    ?? installedSkillFixtures[0];
  return invokeOrFallback("revert_skill_change", {
    skillName: input.skillName,
    skillPath: input.skillPath,
    relativePath: input.relativePath,
    hunkIndex: input.hunkIndex ?? null,
    expectedPatch: input.expectedPatch ?? null,
    staged: input.staged ?? false,
  }, fallback);
}

export async function openSkillRepository(skillName: string, skillPath?: string): Promise<void> {
  return invokeOrFallback("open_skill_repository", { skillName, skillPath }, undefined);
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
    const issueUrl = `https://github.com/wanghuan9/skilldock/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(nextBody)}`;
    if (issueUrl.length <= 6000) {
      return issueUrl;
    }
    nextBody = `${nextBody.slice(0, Math.max(400, nextBody.length - 200))}\n\n${inCurrentLanguage("...自动诊断摘要过长，已截断。", "...Auto-diagnosis summary too long, truncated.")}`;
  }

  return `https://github.com/wanghuan9/skilldock/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(nextBody)}`;
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

export async function openPluginInEditor(input: OpenPluginInEditorInput): Promise<void> {
  return invokeOrFallback("open_plugin_in_editor", input, undefined);
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

export async function fetchSkillFileBrowser(
  skillName: string,
  skillPath?: string,
): Promise<SkillFileBrowserSnapshot> {
  const fallback =
    skillFileBrowserFixtures[skillName] ?? {
      skillName,
      rootName: skillName,
      entries: [
        { path: "", name: skillName, entryType: "directory", depth: 0 },
        { path: "SKILL.md", name: "SKILL.md", entryType: "file", depth: 1 },
      ],
      initialFilePath: "SKILL.md",
      previewMode: "full",
    };

  return invokeOrFallback("get_skill_file_browser", { skillName, skillPath }, fallback);
}

export async function fetchSkillFileContent(input: SkillFileInput): Promise<SkillFileDocument> {
  const fallback =
    skillFileDocumentFixtures[input.skillName]?.[input.relativePath] ?? {
      path: input.relativePath,
      content: "",
    };

  return invokeOrFallback("get_skill_file_content", input, fallback);
}

export async function fetchToolSkillFileBrowser(input: ToolSkillInput): Promise<SkillFileBrowserSnapshot> {
  const fallback =
    skillFileBrowserFixtures[input.skillName] ?? {
      skillName: input.skillName,
      rootName: input.skillName,
      entries: [
        { path: "", name: input.skillName, entryType: "directory" as const, depth: 0 },
        { path: "SKILL.md", name: "SKILL.md", entryType: "file" as const, depth: 1 },
      ],
      initialFilePath: "SKILL.md",
      previewMode: "full",
    };

  return invokeOrFallback("get_tool_skill_file_browser", input, fallback);
}

export async function fetchToolSkillFileContent(input: ToolSkillFileInput): Promise<SkillFileDocument> {
  const fallback =
    skillFileDocumentFixtures[input.skillName]?.[input.relativePath] ?? {
      path: input.relativePath,
      content: "",
    };

  return invokeOrFallback("get_tool_skill_file_content", input, fallback);
}

export async function saveSkillFileContent(input: SaveSkillFileInput): Promise<SkillFileDocument> {
  const fallback = {
    path: input.relativePath,
    content: input.content,
  };

  return invokeOrFallback("save_skill_file_content", input, fallback);
}

export async function deleteSkill(skillName: string, skillPath?: string): Promise<void> {
  return invokeOrFallback("delete_skill", { skillName, skillPath }, undefined);
}

export async function deleteToolSkill(input: ToolSkillInput): Promise<void> {
  return invokeOrFallback("delete_tool_skill", input, undefined);
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
): Promise<McpMarketplaceInstallResult> {
  const installedServerConfig = input.server.server
    ?? mcpMarketplaceServerFixtures.find((server) => server.id === input.server.id)?.server
    ?? {};
  const normalizedName = input.server.name.trim().toLowerCase();
  const shouldEnableAllApps = appSettingsFixture.mcpInstallActivation === "apply-all-tools";
  const installedMcpToolIds = new Set(
    toolConfigFixtures
      .filter((tool) => isToolInstalledStatus(tool.statusLabel) && tool.supportsMcp)
      .map((tool) => tool.id),
  );
  const enabledAppIds = new Set(
    shouldEnableAllApps
      ? mcpWorkspaceFixture.apps
        .filter((app) => installedMcpToolIds.has(app.id))
        .map((app) => app.id)
      : [],
  );
  const installedServer = {
    id: normalizeMcpServerId(input.server.name),
    name: normalizedName,
    serverType: String(installedServerConfig.type ?? "stdio"),
    commandLabel: buildMcpCommandLabel(installedServerConfig),
    description: input.server.description,
    sourceUrl: input.server.sourceUrl,
    serverJson: JSON.stringify(installedServerConfig, null, 2),
    enabledAppCount: enabledAppIds.size,
    apps: mcpWorkspaceFixture.apps.map((app) => ({
      appId: app.id,
      appName: app.name,
      configPath: app.configPath,
      statusLabel: app.statusLabel,
      isEnabled: enabledAppIds.has(app.id),
    })),
    tools: [],
    toolsDiscoveredAt: "",
    toolsDiscoveryError: "",
    installedAt: getCurrentTimestampLabel(),
    hasPendingSync: false,
  };
  const fallback: McpMarketplaceInstallResult = {
    workspace: {
      ...mcpWorkspaceFixture,
      servers: [installedServer, ...mcpWorkspaceFixture.servers.filter((item) => item.id !== installedServer.id)],
    },
    syncFailures: [],
  };

  const result = await invokeOrFallback("install_mcp_server_from_marketplace", input, fallback);
  return {
    ...result,
    workspace: normalizeMcpWorkspaceSnapshot(result.workspace),
    syncFailures: result.syncFailures ?? [],
  };
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
        progress: null,
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

export async function getRepoCacheSize(): Promise<number> {
  if (!isTauriRuntime()) return 0;
  return invoke<number>("get_repo_cache_size");
}

export async function clearRepoCache(): Promise<void> {
  if (!isTauriRuntime()) return;
  return invoke<void>("clear_repo_cache");
}
