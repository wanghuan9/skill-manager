export type SkillCollabStatus = "clean" | "update-available" | "pending-push" | "diverged";
export type SkillStatusFilter = "all" | SkillCollabStatus | "disabled";

export type SourceType = "github" | "gitlab" | "gitee" | "local";
export type MarketplaceSourceSite = "skills.sh" | "skillsmp";
export type McpMarketplaceSourceSite = "MCP.Directory";
export type PluginHostTool = "claude-code" | "cursor" | "codex";
export type PluginKind = "plugin-repo" | "marketplace-root" | "standalone-assets" | "unknown";
export type PluginProbeKind = PluginKind;
export type PluginProbeConfidence = "high" | "medium" | "low";
export type PluginInstallStrategy =
  | "codex-marketplace"
  | "claude-plugin-dir"
  | "cursor-registration"
  | "unsupported";
export type PluginSourceType = "git" | "local" | "marketplace";
export type PluginUpdateMode = "auto" | "unsupported";
export type PluginStatus = "ready" | "update-available" | "invalid" | "unsupported" | "scan-error";
export type PluginInstallState = "installed" | "broken" | "detected";
export type PluginEnabledState = "enabled" | "disabled" | "unknown";
export type PluginScopeId = "user" | "project" | "local-project";
export type PluginAssetType =
  | "skill"
  | "subagent"
  | "mcp"
  | "command"
  | "rule"
  | "hook";
export type PluginLifecycleSource = "direct" | "plugin";

export type SkillToolSyncStatus = {
  name: string;
  statusLabel: string;
};

export type PluginComponentSummary = {
  id: string;
  name: string;
  description: string;
  assetType: PluginAssetType;
  ownerPluginId: string;
  packageItemId: string;
};

export type PluginComponentPreview = {
  path: string;
  title: string;
  assetType: PluginAssetType;
  content: string;
};

export type PluginScopeSummary = {
  scopeId: PluginScopeId;
  scopeLabel: string;
  enabledState: PluginEnabledState;
  location: string;
};

export type PluginSummary = {
  id: string;
  name: string;
  description: string;
  hostTool: PluginHostTool;
  relatedHostTools?: PluginHostTool[];
  kind: PluginKind;
  rootPath: string;
  manifestPath: string;
  sourceType: PluginSourceType;
  sourceLabel: string;
  sourceUrl: string;
  sourceRef: string;
  sourceRevision: string;
  currentVersion: string;
  currentBranch: string;
  currentCommit: string;
  isGitRepo: boolean;
  updateMode: PluginUpdateMode;
  updateAvailable: boolean;
  installedAt: string;
  updatedAt: string;
  lastScannedAt: string;
  status: PluginStatus;
  installState: PluginInstallState;
  enabledState: PluginEnabledState;
  scopes: PluginScopeSummary[];
  components: PluginComponentSummary[];
};

export type PluginProbeResult = {
  tool: PluginHostTool | "unknown";
  compatibleHostTools: PluginHostTool[];
  kind: PluginProbeKind;
  name: string;
  description: string;
  pluginRoot: string;
  manifestPath: string;
  marketplaceManifestPath: string;
  components: PluginComponentSummary[];
  sourceType: PluginSourceType;
  sourceUrl: string;
  isGitRepo: boolean;
  gitRoot: string;
  confidence: PluginProbeConfidence;
  installStrategy: PluginInstallStrategy;
  warnings: string[];
};

export type CliToolSummary = {
  id: string;
  name: string;
  ownerPluginId?: string;
  ownerPluginName?: string;
  lifecycleSource: "direct" | "plugin";
  command: string;
  executablePath?: string;
  statusLabel?: string;
  updateCommand?: string;
  updateStrategy?: "linked-skills" | "self-only";
  bundledSkills: string[];
  description: string;
};

export type SkillSummary = {
  name: string;
  sourceLabel: string;
  sourceType: SourceType;
  sourceUrl: string;
  description: string;
  localPath: string;
  branch: string;
  collabStatus: SkillCollabStatus;
  statusText: string;
  remoteUpdatedAt: string;
  localUpdatedAt: string;
  lastCheckedAt: string;
  syncedToolCount: number;
  lastEditor: string;
  commitLabel: string;
  gitLinked: boolean;
  lifecycleSource?: PluginLifecycleSource;
  ownerPluginId?: string;
  ownerPluginName?: string;
  tools: SkillToolSyncStatus[];
};

export type PushBranchOption = {
  name: string;
  isCurrent: boolean;
};

export type PushTargetSnapshot = {
  currentBranch: string;
  branches: PushBranchOption[];
};

export type GitChangeFile = {
  path: string;
  status: string;
  diff: string;
};

export type PushPreviewSnapshot = {
  targetBranch: string;
  willCreateBranch: boolean;
  repositoryPath: string;
  uncommittedFiles: GitChangeFile[];
  unpushedCommitCount: number;
};

export type SkillFileEntry = {
  path: string;
  name: string;
  entryType: "file" | "directory";
  depth: number;
};

export type SkillFileBrowserSnapshot = {
  skillName: string;
  rootName: string;
  entries: SkillFileEntry[];
  initialFilePath: string | null;
};

export type SkillFileDocument = {
  path: string;
  content: string;
};

export type MarketplaceSkill = {
  id: string;
  name: string;
  sourceType: Exclude<SourceType, "local">;
  sourceSite: MarketplaceSourceSite;
  description: string;
  maintainer: string;
  updatedAt: string;
  installLabel: string;
  sourceUrl: string;
  marketplaceUrl?: string | null;
  popularityLabel: string;
  avatarUrl?: string | null;
};

export type McpMarketplaceServer = {
  id: string;
  name: string;
  sourceSite: McpMarketplaceSourceSite;
  description: string;
  publisher: string;
  category: string;
  transportLabel: string;
  sourceUrl: string;
  marketplaceUrl?: string | null;
  popularityLabel: string;
  avatarUrl?: string | null;
  server: Record<string, unknown> | null;
};

export type LocalSkillCandidate = {
  name: string;
  description: string;
  localPath: string;
  detectedFrom: string;
  sourceHint: string;
};

export type RepoSkillCandidate = {
  id: string;
  name: string;
  description: string;
  relativePath: string;
};

export type GitBranchOption = {
  name: string;
  isDefault: boolean;
  isSelected: boolean;
};

export type LocalInstallSkillCandidate = {
  id: string;
  name: string;
  description: string;
  relativePath: string;
};

export type ToolType = "editor" | "cli" | "desktop";
export type ToolSurfaceType = ToolType | "ide-plugin";

export type ToolConfig = {
  id: string;
  name: string;
  skillsPath: string;
  mcpConfigPath: string;
  supportsMcp: boolean;
  mcpConfigPathRecognized: boolean;
  statusLabel: string;
  isEnabled: boolean;
  primaryType: ToolType;
  surfaceTypes: ToolSurfaceType[];
  supportsDirectOpen: boolean;
};

export type GitAccountSummary = {
  provider: string;
  accountName: string;
  statusLabel: string;
};

export type InstallActivationMode = "apply-all-tools" | "disable-all-tools";
export type AppLanguage = "zh-CN" | "en";
export type AppLanguageSource = "auto" | "user";

export type AppSettings = {
  storagePath: string;
  defaultOpenToolId: string;
  skillInstallActivation: InstallActivationMode;
  mcpInstallActivation: InstallActivationMode;
  language: AppLanguage;
  languageSource: AppLanguageSource;
};

export type WorkspaceSnapshot = {
  installedSkills: SkillSummary[];
  marketplaceSkills: MarketplaceSkill[];
  localCandidates: LocalSkillCandidate[];
  toolConfigs: ToolConfig[];
  gitAccount: GitAccountSummary;
};

export type McpTargetApp = {
  id: string;
  name: string;
  configPath: string;
  statusLabel: string;
};

export type McpAppStatus = {
  appId: string;
  appName: string;
  configPath: string;
  statusLabel: string;
  isEnabled: boolean;
};

export type McpServerToolStatus = {
  name: string;
  isEnabled: boolean;
};

export type McpServerSummary = {
  id: string;
  name: string;
  serverType: string;
  commandLabel: string;
  description: string;
  sourceUrl: string;
  serverJson: string;
  enabledAppCount: number;
  apps: McpAppStatus[];
  tools: McpServerToolStatus[];
  toolsDiscoveredAt: string;
  toolsDiscoveryError: string;
  installedAt: string;
  lifecycleSource?: PluginLifecycleSource;
  ownerPluginId?: string;
  ownerPluginName?: string;
};

export type McpServerRecord = {
  id: string;
  name: string;
  server: Record<string, unknown>;
  description: string;
  sourceUrl: string;
  enabledAppIds: string[];
  tools: McpServerToolStatus[];
  toolsDiscoveredAt: string;
  toolsDiscoveryError: string;
  installedAt: string;
  updatedAt: string;
  lifecycleSource?: PluginLifecycleSource;
  ownerPluginId?: string;
  ownerPluginName?: string;
};

export type McpWorkspaceSnapshot = {
  storagePath: string;
  apps: McpTargetApp[];
  servers: McpServerSummary[];
};

export type McpImportProgress = {
  appId: string;
  appName: string;
  serverId: string;
  serverName: string;
  importedCount: number;
  scannedCount: number;
  phase: "imported" | "hydrated";
  changed: boolean;
  workspace: McpWorkspaceSnapshot;
};

export type FailureFeedbackInput = {
  operation: string;
  message: string;
  kind?: "business" | "unknown";
  context?: Record<string, unknown>;
};

export type FeedbackIssueDraft = {
  title: string;
  body: string;
  issueUrl: string;
  logPath: string;
};
