export type SkillCollabStatus = "clean" | "update-available" | "pending-push" | "diverged";
export type SkillStatusFilter = "all" | SkillCollabStatus;

export type SourceType = "github" | "gitlab" | "gitee" | "local";
export type MarketplaceSourceSite = "skills.sh" | "skillsmp";
export type McpMarketplaceSourceSite = "MCP.Directory";

export type SkillToolSyncStatus = {
  name: string;
  statusLabel: string;
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

export type AppSettings = {
  storagePath: string;
  defaultOpenToolId: string;
  skillInstallActivation: InstallActivationMode;
  mcpInstallActivation: InstallActivationMode;
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
};

export type McpWorkspaceSnapshot = {
  storagePath: string;
  apps: McpTargetApp[];
  servers: McpServerSummary[];
};
