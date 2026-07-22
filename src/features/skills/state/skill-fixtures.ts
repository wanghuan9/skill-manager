import type {
  AppSettings,
  CliToolSummary,
  GitAccountSummary,
  LocalInstallSkillCandidate,
  LocalSkillCandidate,
  MarketplaceSkill,
  McpMarketplaceServer,
  PluginProbeResult,
  PluginSummary,
  PushPreviewSnapshot,
  PushTargetSnapshot,
  RepoSkillCandidate,
  SkillFileBrowserSnapshot,
  SkillFileDocument,
  ToolConfig,
  ToolSkillEntry,
  McpWorkspaceSnapshot,
  WorkspaceSnapshot,
} from "@/features/skills/state/skill-store";
import type { SkillSummary } from "@/features/skills/state/skill-store";

export const installedSkillFixtures: SkillSummary[] = [
  {
    name: "skill-publisher",
    sourceLabel: "GitLab",
    sourceType: "gitlab",
    sourceUrl: "https://gitlab.com/team/skills/skill-publisher",
    description: "用于维护技能发布说明、变更记录和发布前自检脚本。",
    localPath: "/Users/demo/.skilldock/skills/skill-publisher",
    branch: "feat/publish-copy",
    collabStatus: "pending-push",
    statusText: "本地已修改 4 个文件，建议打开 canonical repo 后提交 MR。",
    remoteUpdatedAt: "2026/5/8 19:10:00",
    localUpdatedAt: "今天 09:45",
    lastCheckedAt: "刚刚检查",
    syncedToolCount: 2,
    lastEditor: "Wanghuan",
    commitLabel: "9fd72ac",
    gitLinked: true,
    localChangeCount: 4,
    tools: [
      { name: "Codex", statusLabel: "已同步" },
      { name: "Claude Code", statusLabel: "已同步" },
    ],
  },
  {
    name: "excalidraw-diagram",
    sourceLabel: "GitHub",
    sourceType: "github",
    sourceUrl: "https://github.com/xstongxue/best-skills/tree/main",
    description: "用于生成 Excalidraw 风格的图表和草图。",
    localPath: "/Users/demo/.skilldock/skills/excalidraw-diagram",
    branch: "main",
    collabStatus: "update-available",
    statusText: "远端有新版本，建议更新后重新同步到工具。",
    remoteUpdatedAt: "今天 10:00",
    localUpdatedAt: "今天 08:30",
    lastCheckedAt: "今天 10:30",
    syncedToolCount: 3,
    lastEditor: "Jiwei",
    commitLabel: "a13f8d2",
    gitLinked: true,
    lifecycleSource: "plugin",
    ownerPluginId: "repo-scout",
    ownerPluginName: "Repo Scout",
    tools: [
      { name: "Cursor", statusLabel: "已同步" },
      { name: "Codex", statusLabel: "需要重同步" },
      { name: "Claude Code", statusLabel: "已同步" },
    ],
  },
  {
    name: "drawio-diagram",
    sourceLabel: "GitLab",
    sourceType: "gitlab",
    sourceUrl: "https://gitlab.com/team/skills/drawio-diagram",
    description: "将结构描述转成可编辑的 Draw.io 图表。",
    localPath: "/Users/demo/.skilldock/skills/drawio-diagram",
    branch: "main",
    collabStatus: "pending-push",
    statusText: "本地存在待处理改动，可在 canonical repo 中提交 MR。",
    remoteUpdatedAt: "昨天 18:20",
    localUpdatedAt: "今天 09:20",
    lastCheckedAt: "今天 10:30",
    syncedToolCount: 2,
    lastEditor: "Wanghuan",
    commitLabel: "cb91e21",
    gitLinked: true,
    tools: [
      { name: "Cursor", statusLabel: "已同步" },
      { name: "Codex", statusLabel: "已同步" },
    ],
  },
  {
    name: "multi-search-engine",
    sourceLabel: "GitHub",
    sourceType: "github",
    sourceUrl: "https://github.com/example-research/multi-search-engine",
    description: "聚合多搜索引擎能力，用于研究和信息检索。",
    localPath: "/Users/demo/.skilldock/skills/multi-search-engine",
    branch: "stable",
    collabStatus: "clean",
    statusText: "本地与远端一致，可直接使用。",
    remoteUpdatedAt: "今天 09:10",
    localUpdatedAt: "昨天 17:10",
    lastCheckedAt: "今天 10:30",
    syncedToolCount: 4,
    lastEditor: "skills.sh",
    commitLabel: "v1.2.0",
    gitLinked: true,
    tools: [
      { name: "Cursor", statusLabel: "已同步" },
      { name: "Codex", statusLabel: "已同步" },
      { name: "Claude Code", statusLabel: "已同步" },
      { name: "Devin", statusLabel: "已同步" },
    ],
  },
];

export const marketplaceSkillFixtures: MarketplaceSkill[] = [
  {
    id: "skill-market-001",
    name: "workflow-critic",
    sourceType: "github",
    sourceSite: "skills.sh",
    description: "帮团队审视 workflow 的关键风险、遗漏测试与回归点。",
    maintainer: "skills.sh",
    updatedAt: "今天 11:20",
    installLabel: "推荐安装",
    sourceUrl: "https://github.com/team-workflows/workflow-critic",
    marketplaceUrl: "https://skills.sh/team-workflows/workflow-critic",
    popularityLabel: "731.2K",
    avatarUrl: null,
  },
  {
    id: "skill-market-002",
    name: "design-system-reviewer",
    sourceType: "github",
    sourceSite: "skills.sh",
    description: "检查设计系统组件的一致性、状态覆盖和发布质量。",
    maintainer: "UI Guild",
    updatedAt: "昨天 21:45",
    installLabel: "团队常用",
    sourceUrl: "https://github.com/ui-guild/design-system-reviewer",
    marketplaceUrl: "https://skills.sh/ui-guild/design-system-reviewer",
    popularityLabel: "229.8K",
    avatarUrl: null,
  },
  {
    id: "skill-market-003",
    name: "release-guardian",
    sourceType: "gitlab",
    sourceSite: "skillsmp",
    description: "在发布前聚合变更、风险和回滚信息，生成一次性发布清单。",
    maintainer: "skillsmp",
    updatedAt: "昨天 16:10",
    installLabel: "适合团队使用",
    sourceUrl: "https://gitlab.com/release-team/release-guardian",
    marketplaceUrl: "https://skillsmp.com/skills/release-guardian",
    popularityLabel: "531.0K",
    avatarUrl: null,
  },
  {
    id: "skill-market-004",
    name: "repo-guardian",
    sourceType: "github",
    sourceSite: "skillsmp",
    description: "针对多仓库团队的变更同步、提交规范和发布前检查。",
    maintainer: "skillsmp",
    updatedAt: "今天 09:40",
    installLabel: "适合协作场景",
    sourceUrl: "https://github.com/collab-team/repo-guardian",
    marketplaceUrl: "https://skillsmp.com/skills/repo-guardian",
    popularityLabel: "155.0K",
    avatarUrl: null,
  },
];

export const mcpMarketplaceServerFixtures: McpMarketplaceServer[] = [
  {
    id: "mcp-directory-context7",
    name: "context7",
    sourceSite: "MCP.Directory",
    description: "Injects up-to-date documentation and code examples into AI coding prompts.",
    publisher: "upstash",
    category: "AI/ML",
    transportLabel: "HTTP / stdio",
    sourceUrl: "https://github.com/upstash/context7",
    marketplaceUrl: "https://mcp.directory/servers/context7",
    popularityLabel: "36.7K",
    avatarUrl: "https://github.com/upstash.png",
    server: {
      type: "http",
      url: "https://mcp.context7.com/mcp",
      description: "Injects up-to-date documentation and code examples into AI coding prompts.",
    },
  },
  {
    id: "mcp-directory-playwright",
    name: "playwright",
    sourceSite: "MCP.Directory",
    description: "Browser automation MCP server for testing, scraping, and visual inspection workflows.",
    publisher: "microsoft",
    category: "Browser Automation",
    transportLabel: "stdio",
    sourceUrl: "https://github.com/microsoft/playwright-mcp",
    marketplaceUrl: "https://mcp.directory/servers/playwright",
    popularityLabel: "12.4K",
    avatarUrl: "https://github.com/microsoft.png",
    server: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp"],
      description: "Browser automation MCP server for testing, scraping, and visual inspection workflows.",
    },
  },
];

export const localSkillFixtures: LocalSkillCandidate[] = [
  {
    name: "excalidraw-diagram",
    description: "生成可直接在 Excalidraw 打开的手绘风图表。",
    localPath: "/Users/demo/.cursor/skills/excalidraw-diagram",
    detectedFrom: "/Users/demo/.cursor/skills",
    sourceHint: "符号链接",
  },
  {
    name: "excalidraw-diagram",
    description: "生成可直接在 Excalidraw 打开的手绘风图表。",
    localPath: "/Users/demo/.claude/skills/excalidraw-diagram",
    detectedFrom: "/Users/demo/.claude/skills",
    sourceHint: "符号链接",
  },
  {
    name: "excalidraw-diagram",
    description: "生成可直接在 Excalidraw 打开的手绘风图表。",
    localPath: "/Users/demo/.codeium/windsurf/skills/excalidraw-diagram",
    detectedFrom: "/Users/demo/.codeium/windsurf/skills",
    sourceHint: "符号链接",
  },
  {
    name: "technical-design",
    description: "根据产品文档和需求输入整理技术设计骨架。",
    localPath: "/Users/demo/.codex/skills/technical-design",
    detectedFrom: "/Users/demo/.codex/skills",
    sourceHint: "符号链接",
  },
];

export const repoSkillCandidateFixtures: Record<string, RepoSkillCandidate[]> = {
  default: [
    {
      id: "repo-skill-001",
      name: "ahs-persistence",
      description: "初始化数据表、生成 DAO/Mapper 和 SQL 分析所需的团队技能。",
      relativePath: "skills/ahs-persistence",
    },
    {
      id: "repo-skill-002",
      name: "example-migration",
      description: "当需要将 BFF 服务 A 迁入合并到 BFF 服务 B 时使用。",
      relativePath: "skills/example-migration",
    },
    {
      id: "repo-skill-003",
      name: "code-review-excellence",
      description: "代码审查专家，提供完整的代码审查解决方案和 GitLab MR 集成。",
      relativePath: "skills/code-review-excellence",
    },
  ],
  "https://github.com/team/skill-repo": [
    {
      id: "repo-skill-team-001",
      name: "service-observer",
      description: "帮助团队巡检服务稳定性、日志信号和回归风险。",
      relativePath: "skills/service-observer",
    },
    {
      id: "repo-skill-team-002",
      name: "release-scribe",
      description: "用于整理版本变更说明、发布纪要和回滚策略。",
      relativePath: "skills/release-scribe",
    },
  ],
  "https://github.com/team/duplicate-skill-repo": [
    {
      id: "repo-skill-duplicate-001",
      name: "drawio-diagram",
      description: "将结构描述转成可编辑的 Draw.io 图表。",
      relativePath: "skills/drawio-diagram",
    },
    {
      id: "repo-skill-duplicate-002",
      name: "service-observer",
      description: "帮助团队巡检服务稳定性、日志信号和回归风险。",
      relativePath: "skills/service-observer",
    },
  ],
};

export const localInstallSkillCandidateFixtures: Record<string, LocalInstallSkillCandidate[]> = {
  default: [
    {
      id: "local-skill",
      name: "local-skill",
      description: "从本地路径识别的技能。",
      relativePath: "",
    },
  ],
  "/Users/demo/skills/local-helper": [
    {
      id: "local-helper",
      name: "local-helper",
      description: "从本地路径识别的技能。",
      relativePath: "",
    },
  ],
  "/Users/demo/projects/skill-pack": [
    {
      id: "skills-service-observer",
      name: "service-observer",
      description: "帮助团队巡检服务稳定性、日志信号和回归风险。",
      relativePath: "skills/service-observer",
    },
    {
      id: "skills-release-scribe",
      name: "release-scribe",
      description: "用于整理版本变更说明、发布纪要和回滚策略。",
      relativePath: "skills/release-scribe",
    },
  ],
};

export const toolConfigFixtures: ToolConfig[] = [
  // Browser-only mock data (`npm run dev` without Tauri). Production builds use
  // `list_tool_configs` from the Rust backend with real filesystem detection.
  { id: "claude-code", name: "Claude Code", skillsPath: "/Users/demo/.claude/skills", mcpConfigPath: "/Users/demo/.claude.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "已安装", isEnabled: true, primaryType: "cli", surfaceTypes: ["cli", "desktop", "ide-plugin"], supportsDirectOpen: false },
  { id: "codex", name: "Codex", skillsPath: "/Users/demo/.codex/skills", mcpConfigPath: "/Users/demo/.codex/config.toml", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "已安装", isEnabled: true, primaryType: "desktop", surfaceTypes: ["desktop", "cli"], supportsDirectOpen: false },
  { id: "opencode", name: "OpenCode", skillsPath: "/Users/demo/.config/opencode/skills", mcpConfigPath: "/Users/demo/.config/opencode/opencode.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "已安装", isEnabled: true, primaryType: "cli", surfaceTypes: ["cli", "desktop", "ide-plugin"], supportsDirectOpen: false },
  { id: "cursor", name: "Cursor", skillsPath: "/Users/demo/.cursor/skills", mcpConfigPath: "/Users/demo/.cursor/mcp.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "已安装", isEnabled: true, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: true },
  { id: "gemini", name: "Gemini CLI", skillsPath: "/Users/demo/.gemini/skills", mcpConfigPath: "/Users/demo/.gemini/settings.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "已安装", isEnabled: true, primaryType: "cli", surfaceTypes: ["cli"], supportsDirectOpen: false },
  { id: "antigravity", name: "Antigravity", skillsPath: "/Users/demo/.gemini/config/skills", mcpConfigPath: "/Users/demo/.gemini/config/mcp_config.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "已安装", isEnabled: true, primaryType: "desktop", surfaceTypes: ["desktop", "cli"], supportsDirectOpen: false },
  { id: "windsurf", name: "Devin", skillsPath: "/Users/demo/.codeium/windsurf/skills", mcpConfigPath: "/Users/demo/.codeium/windsurf/mcp_config.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "已安装", isEnabled: true, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: true },
  { id: "intellij", name: "IntelliJ IDEA", skillsPath: "/Users/demo/.junie/skills", mcpConfigPath: "", supportsMcp: false, mcpConfigPathRecognized: false, statusLabel: "已安装", isEnabled: true, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: true },
  { id: "vscode", name: "VS Code", skillsPath: "", mcpConfigPath: "", supportsMcp: false, mcpConfigPathRecognized: false, statusLabel: "已安装", isEnabled: true, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: true },
  { id: "openclaw", name: "OpenClaw", skillsPath: "/Users/demo/.openclaw/skills", mcpConfigPath: "/Users/demo/.openclaw/openclaw.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "已安装", isEnabled: true, primaryType: "desktop", surfaceTypes: ["desktop"], supportsDirectOpen: false },
  { id: "continue", name: "Continue", skillsPath: "/Users/demo/.continue/skills", mcpConfigPath: "/Users/demo/.continue/config.yaml", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "已安装", isEnabled: true, primaryType: "editor", surfaceTypes: ["editor", "ide-plugin"], supportsDirectOpen: false },
  { id: "iflow", name: "iFlow", skillsPath: "/Users/demo/.iflow/skills", mcpConfigPath: "/Users/demo/.iflow/settings.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "已安装", isEnabled: true, primaryType: "cli", surfaceTypes: ["cli"], supportsDirectOpen: false },
  { id: "codebuddy", name: "CodeBuddy", skillsPath: "/Users/demo/.codebuddy/skills", mcpConfigPath: "/Users/demo/.codebuddy/.mcp.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor", "ide-plugin"], supportsDirectOpen: false },
  { id: "trae", name: "Trae", skillsPath: "/Users/demo/.trae/skills", mcpConfigPath: "/Users/demo/Library/Application Support/Trae/User/mcp.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: true },
  { id: "droid", name: "Droid", skillsPath: "/Users/demo/.factory/skills", mcpConfigPath: "/Users/demo/.factory/mcp.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: false },
  { id: "augment", name: "Augment", skillsPath: "/Users/demo/.augment/skills", mcpConfigPath: "/Users/demo/.augment/settings.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor", "ide-plugin", "desktop"], supportsDirectOpen: false },
  { id: "cline", name: "Cline", skillsPath: "/Users/demo/.cline/skills", mcpConfigPath: "/Users/demo/.cline/data/settings/cline_mcp_settings.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor", "cli"], supportsDirectOpen: false },
  { id: "commandcode", name: "CommandCode", skillsPath: "/Users/demo/.commandcode/skills", mcpConfigPath: "/Users/demo/.commandcode/mcp.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: false },
  { id: "crush", name: "Crush", skillsPath: "/Users/demo/.config/crush/skills", mcpConfigPath: "/Users/demo/.config/crush/crush.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "cli", surfaceTypes: ["cli"], supportsDirectOpen: false },
  { id: "goose", name: "Goose", skillsPath: "/Users/demo/.agents/skills", mcpConfigPath: "/Users/demo/.config/goose/config.yaml", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "cli", surfaceTypes: ["cli"], supportsDirectOpen: false },
  { id: "junie", name: "Junie", skillsPath: "/Users/demo/.junie/skills", mcpConfigPath: "/Users/demo/.junie/mcp/mcp.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor", "ide-plugin"], supportsDirectOpen: false },
  { id: "kilo-code", name: "Kilo Code", skillsPath: "/Users/demo/.kilocode/skills", mcpConfigPath: "/Users/demo/Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/settings/mcp_settings.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: false },
  { id: "kiro", name: "Kiro", skillsPath: "/Users/demo/.kiro/skills", mcpConfigPath: "/Users/demo/.kiro/settings/mcp.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "已安装", isEnabled: true, primaryType: "editor", surfaceTypes: ["editor", "cli"], supportsDirectOpen: true },
  { id: "qoder", name: "Qoder", skillsPath: "/Users/demo/.qoder/skills", mcpConfigPath: "/Users/demo/.config/Qoder/SharedClientCache/mcp.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor", "ide-plugin"], supportsDirectOpen: false },
  { id: "qwen-code", name: "Qwen Code", skillsPath: "/Users/demo/.qwen/skills", mcpConfigPath: "/Users/demo/.qwen/settings.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "cli", surfaceTypes: ["cli"], supportsDirectOpen: false },
  { id: "roo-code", name: "Roo Code", skillsPath: "/Users/demo/.roo/skills", mcpConfigPath: "/Users/demo/Library/Application Support/Code/User/globalStorage/RooVeterinaryInc.roo-cline/settings/mcp_settings.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: false },
  { id: "zencoder", name: "Zencoder", skillsPath: "/Users/demo/.zencoder/skills", mcpConfigPath: "/Users/demo/.zencoder/settings.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor", "ide-plugin", "desktop"], supportsDirectOpen: false },
  { id: "trae-cn", name: "Trae CN", skillsPath: "/Users/demo/.trae-cn/skills", mcpConfigPath: "/Users/demo/Library/Application Support/Trae CN/User/mcp.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: false },
  { id: "hermes", name: "Hermes", skillsPath: "/Users/demo/.hermes/skills", mcpConfigPath: "/Users/demo/.hermes/config.yaml", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "cli", surfaceTypes: ["cli"], supportsDirectOpen: false },
  { id: "github-copilot", name: "GitHub Copilot", skillsPath: "/Users/demo/.copilot/skills", mcpConfigPath: "/Users/demo/.copilot/mcp-config.json", supportsMcp: true, mcpConfigPathRecognized: true, statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor", "ide-plugin"], supportsDirectOpen: false },
];

const managedToolSkillEntryFixtures: ToolSkillEntry[] = toolConfigFixtures.flatMap((tool) =>
  installedSkillFixtures.flatMap((skill) => {
    const toolStatus = skill.tools.find((entry) => entry.name === tool.name);
    if (!toolStatus || !["已同步", "已启用", "需要重同步"].includes(toolStatus.statusLabel)) {
      return [];
    }

    return [{
      toolId: tool.id,
      toolName: tool.name,
      name: skill.name,
      description: skill.description,
      localPath: `${tool.skillsPath.replace(/[\\/]+$/, "")}/${skill.name}`,
      resolvedPath: skill.localPath,
      managementStatus: toolStatus.statusLabel === "需要重同步" ? "mismatch" as const : "managed" as const,
      entryKind: "symlink" as const,
    }];
  }),
);

export const toolSkillEntryFixtures: ToolSkillEntry[] = [
  ...managedToolSkillEntryFixtures,
  ...localSkillFixtures.flatMap((candidate) => {
    const tool = toolConfigFixtures.find((entry) => (
      entry.skillsPath.replace(/[\\/]+$/, "") === candidate.detectedFrom.replace(/[\\/]+$/, "")
    ));
    if (!tool || managedToolSkillEntryFixtures.some((entry) => (
      entry.toolId === tool.id && entry.name === candidate.name
    ))) {
      return [];
    }

    return [{
      toolId: tool.id,
      toolName: tool.name,
      name: candidate.name,
      description: candidate.description,
      localPath: candidate.localPath,
      resolvedPath: candidate.sourceHint === "符号链接"
        ? `/Users/demo/shared-skills/${candidate.name}`
        : candidate.localPath,
      managementStatus: "unmanaged" as const,
      entryKind: candidate.sourceHint === "符号链接" ? "symlink" as const : "directory" as const,
    }];
  }),
];

export const pluginFixtures: PluginSummary[] = [
  {
    id: "repo-scout",
    packageId: "repo-scout",
    name: "Repo Scout",
    description: "扫描仓库中的插件组件，并帮助追踪插件资产来源。",
    hostTool: "codex",
    relatedHostTools: ["claude-code"],
    kind: "plugin-repo",
    rootPath: "/Users/demo/workspace/repo-scout",
    repoRootPath: "/Users/demo/workspace/repo-scout",
    pluginRelativePath: "",
    manifestPath: "/Users/demo/workspace/repo-scout/.codex-plugin/plugin.json",
    sourceType: "git",
    sourceLabel: "repo-scout",
    sourceUrl: "https://github.com/example/repo-scout",
    sourceRef: "main",
    sourceRevision: "4f2c1ab",
    currentVersion: "1.2.0",
    currentBranch: "main",
    currentCommit: "4f2c1ab",
    collabStatus: "update-available",
    statusText: "远端存在插件目录更新。",
    isGitRepo: true,
    updateMode: "auto",
    updateStrategy: "git",
    updateAvailable: true,
    baselineHash: "",
    localModified: false,
    installedAt: "1778401800000",
    updatedAt: "1778488200000",
    remoteUpdatedAt: "1778488200000",
    localUpdatedAt: "1778488200000",
    lastEditor: "Szymon Kocot",
    lastScannedAt: "1778491800000",
    status: "ready",
    installState: "installed",
    installSource: "skilldock",
    enabledState: "enabled",
    scopes: [
      {
        scopeId: "user",
        scopeLabel: "用户级",
        enabledState: "enabled",
        location: "~/.codex/config.toml",
      },
    ],
    components: [
      {
        id: "skills/repo-scout-skill",
        name: "repo-scout-skill",
        description: "扫描仓库并提取插件包中的 skill 组件。",
        assetType: "skill",
        ownerPluginId: "repo-scout",
        packageItemId: "skills/repo-scout-skill",
      },
      {
        id: "skills/repo-map",
        name: "repo-map",
        description: "生成仓库组件关系图的 skill 组件。",
        assetType: "skill",
        ownerPluginId: "repo-scout",
        packageItemId: "skills/repo-map",
      },
      {
        id: "skills/repo-diff",
        name: "repo-diff",
        description: "分析仓库变更影响面的 skill 组件。",
        assetType: "skill",
        ownerPluginId: "repo-scout",
        packageItemId: "skills/repo-diff",
      },
      {
        id: "skills/repo-summary",
        name: "repo-summary",
        description: "生成仓库结构摘要的 skill 组件。",
        assetType: "skill",
        ownerPluginId: "repo-scout",
        packageItemId: "skills/repo-summary",
      },
      {
        id: "skills/repo-health",
        name: "repo-health",
        description: "巡检仓库健康度的 skill 组件。",
        assetType: "skill",
        ownerPluginId: "repo-scout",
        packageItemId: "skills/repo-health",
      },
      {
        id: "skills/repo-release-notes",
        name: "repo-release-notes",
        description: "生成发布说明的 skill 组件。",
        assetType: "skill",
        ownerPluginId: "repo-scout",
        packageItemId: "skills/repo-release-notes",
      },
      {
        id: "skills/repo-owner-map",
        name: "repo-owner-map",
        description: "识别仓库 ownership 的 skill 组件。",
        assetType: "skill",
        ownerPluginId: "repo-scout",
        packageItemId: "skills/repo-owner-map",
      },
      {
        id: "agents/codebase-researcher.md",
        name: "codebase-researcher",
        description: "深度代码库研究员，负责追踪调用链和模块依赖。",
        assetType: "subagent",
        ownerPluginId: "repo-scout",
        packageItemId: "agents/codebase-researcher.md",
      },
      {
        id: "agents/quality-reviewer.md",
        name: "quality-reviewer",
        description: "代码质量专项 reviewer。",
        assetType: "subagent",
        ownerPluginId: "repo-scout",
        packageItemId: "agents/quality-reviewer.md",
      },
      {
        id: "agents/performance-reviewer.md",
        name: "performance-reviewer",
        description: "性能风险专项 reviewer。",
        assetType: "subagent",
        ownerPluginId: "repo-scout",
        packageItemId: "agents/performance-reviewer.md",
      },
      {
        id: "agents/correctness-reviewer.md",
        name: "correctness-reviewer",
        description: "正确性风险专项 reviewer。",
        assetType: "subagent",
        ownerPluginId: "repo-scout",
        packageItemId: "agents/correctness-reviewer.md",
      },
      {
        id: "agents/contract-reviewer.md",
        name: "contract-reviewer",
        description: "接口契约专项 reviewer。",
        assetType: "subagent",
        ownerPluginId: "repo-scout",
        packageItemId: "agents/contract-reviewer.md",
      },
      {
        id: "agents/review-critic.md",
        name: "review-critic",
        description: "争议问题对抗性复核 subagent。",
        assetType: "subagent",
        ownerPluginId: "repo-scout",
        packageItemId: "agents/review-critic.md",
      },
      {
        id: "agents/standards-reviewer.md",
        name: "standards-reviewer",
        description: "代码标准专项 reviewer。",
        assetType: "subagent",
        ownerPluginId: "repo-scout",
        packageItemId: "agents/standards-reviewer.md",
      },
      {
        id: "mcp.json/repo-index",
        name: "repo-index",
        description: "为 Repo Scout 暴露仓库索引 MCP 能力。",
        assetType: "mcp",
        ownerPluginId: "repo-scout",
        packageItemId: "mcp.json",
      },
      {
        id: "mcp.json/repo-search",
        name: "repo-search",
        description: "为 Repo Scout 暴露仓库搜索 MCP 能力。",
        assetType: "mcp",
        ownerPluginId: "repo-scout",
        packageItemId: "mcp.json",
      },
      {
        id: "mcp.json/repo-graph",
        name: "repo-graph",
        description: "为 Repo Scout 暴露仓库关系图 MCP 能力。",
        assetType: "mcp",
        ownerPluginId: "repo-scout",
        packageItemId: "mcp.json",
      },
      {
        id: "commands/repo-scout-inspect.md",
        name: "repo-scout-inspect.md",
        description: "检查插件仓库结构的命令。",
        assetType: "command",
        ownerPluginId: "repo-scout",
        packageItemId: "commands/repo-scout-inspect.md",
      },
      {
        id: "rules/repo-scout-review.md",
        name: "repo-scout-review.md",
        description: "Repo Scout 组件审查规则。",
        assetType: "rule",
        ownerPluginId: "repo-scout",
        packageItemId: "rules/repo-scout-review.md",
      },
      {
        id: "hooks/after-install.js",
        name: "after-install.js",
        description: "插件安装后的自动化 Hook。",
        assetType: "hook",
        ownerPluginId: "repo-scout",
        packageItemId: "hooks/after-install.js",
      },
    ],
  },
  {
    id: "ecc",
    packageId: "ecc",
    name: "ecc",
    description: "Claude Code 官方插件，用于管理和运行扩展命令。",
    hostTool: "claude-code",
    relatedHostTools: [],
    kind: "plugin-repo",
    rootPath: "/Users/demo/.claude/plugins/cache/ecc/ecc/1.10.0",
    repoRootPath: "/Users/demo/.claude/plugins/cache/ecc/ecc/1.10.0",
    pluginRelativePath: "",
    manifestPath: "/Users/demo/.claude/plugins/cache/ecc/ecc/1.10.0/.claude-plugin/plugin.json",
    sourceType: "marketplace",
    sourceLabel: "ecc",
    sourceUrl: "https://github.com/example/ecc",
    sourceRef: "",
    sourceRevision: "",
    currentVersion: "1.10.0",
    currentBranch: "",
    currentCommit: "7dfdbe0",
    collabStatus: "clean",
    statusText: "",
    isGitRepo: false,
    updateMode: "auto",
    updateStrategy: "none",
    updateAvailable: false,
    baselineHash: "",
    localModified: false,
    installedAt: "1778402800000",
    updatedAt: "1778489200000",
    remoteUpdatedAt: "1778489200000",
    localUpdatedAt: "1778489200000",
    lastEditor: "Szymon Kocot",
    lastScannedAt: "1778492800000",
    status: "ready",
    installState: "installed",
    installSource: "host",
    enabledState: "disabled",
    scopes: [
      {
        scopeId: "user",
        scopeLabel: "用户级",
        enabledState: "disabled",
        location: "~/.claude/settings.json",
      },
    ],
    components: [
      {
        id: "commands/ecc.md",
        name: "ecc.md",
        description: "运行 ecc 插件命令。",
        assetType: "command",
        ownerPluginId: "ecc",
        packageItemId: "commands/ecc.md",
      },
    ],
  },
];

export const pluginProbeFixture: PluginProbeResult = {
  tool: "codex",
  compatibleHostTools: ["codex"],
  kind: "plugin-repo",
  name: "repo-scout",
  description: "帮助团队巡检仓库结构、风险和协作约定。",
  pluginRoot: "/Users/demo/workspace/repo-scout",
  repoRoot: "/Users/demo/workspace/repo-scout",
  pluginRelativePath: "",
  manifestPath: "/Users/demo/workspace/repo-scout/.codex-plugin/plugin.json",
  marketplaceManifestPath: "",
  components: pluginFixtures[0]?.components ?? [],
  sourceType: "git",
  sourceUrl: "https://github.com/example/repo-scout",
  isGitRepo: true,
  gitRoot: "/Users/demo/workspace/repo-scout",
  confidence: "high",
  installStrategy: "codex-marketplace",
  warnings: [],
};

export const cliToolFixtures: CliToolSummary[] = [
  {
    id: "lark-cli",
    name: "lark-cli",
    lifecycleSource: "direct",
    command: "lark-cli",
    executablePath: "/Users/demo/.npm-global/bin/lark-cli",
    statusLabel: "已安装",
    updateCommand: "lark-cli update",
    updateStrategy: "linked-skills",
    bundledSkills: ["lark-base", "lark-doc", "lark-mail", "lark-calendar"],
    description: "飞书 CLI 包，更新时会同步更新官方 skills。",
  },
];

const mcpFixtureApps = toolConfigFixtures.map((tool) => ({
  id: tool.id,
  name: tool.name,
  configPath: tool.mcpConfigPath,
  statusLabel: tool.statusLabel,
}));

function buildMcpFixtureServerApps(enabledAppIds: string[]) {
  const enabledAppIdSet = new Set(enabledAppIds);

  return mcpFixtureApps.map((app) => ({
    appId: app.id,
    appName: app.name,
    configPath: app.configPath,
    statusLabel: app.statusLabel,
    isEnabled: enabledAppIdSet.has(app.id),
  }));
}

function buildMcpFixtureTools(toolNames: string[], disabledToolNames: string[] = []) {
  const disabledToolNameSet = new Set(disabledToolNames);

  return toolNames.map((name) => ({
    name,
    isEnabled: !disabledToolNameSet.has(name),
  }));
}

export const mcpWorkspaceFixture: McpWorkspaceSnapshot = {
  storagePath: "/Users/demo/.skilldock/mcp-servers.json",
  storageInitialized: true,
  apps: mcpFixtureApps,
  servers: [
    {
      id: "context7",
      name: "context7",
      serverType: "stdio",
      commandLabel: "npx -y @upstash/context7-mcp",
      description: "Up-to-date code documentation for LLMs and AI code editors",
      sourceUrl: "https://github.com/upstash/context7",
      serverJson: JSON.stringify(
        {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
        },
        null,
        2,
      ),
      enabledAppCount: 2,
      apps: buildMcpFixtureServerApps(["claude-code", "codex"]),
      tools: buildMcpFixtureTools(["resolve-library-id", "get-library-docs"]),
      toolsDiscoveredAt: "2026/5/10 16:00:00",
      toolsDiscoveryError: "",
      installedAt: "1778401800000",
      lifecycleSource: "plugin",
      ownerPluginId: "repo-scout",
      ownerPluginName: "Repo Scout",
    },
    {
      id: "linear",
      name: "linear",
      serverType: "sse",
      commandLabel: "https://mcp.linear.app/sse",
      description: "Linear's official MCP server for issue tracking workflows.",
      sourceUrl: "",
      serverJson: JSON.stringify(
        {
          type: "sse",
          url: "https://mcp.linear.app/sse",
          headers: {
            Authorization: "Bearer ${LINEAR_API_KEY}",
          },
        },
        null,
        2,
      ),
      enabledAppCount: 1,
      apps: buildMcpFixtureServerApps(["gemini"]),
      tools: buildMcpFixtureTools(["list_issues", "get_issue", "create_issue", "update_issue"], ["update_issue"]),
      toolsDiscoveredAt: "2026/5/10 16:00:00",
      toolsDiscoveryError: "",
      installedAt: "1778396400000",
    },
  ],
};

export const gitAccountFixture: GitAccountSummary = {
  provider: "GitHub",
  accountName: "wanghuan",
  statusLabel: "已连接，可发起 PR",
};

export const appSettingsFixture: AppSettings = {
  storagePath: "/Users/demo/.skilldock/settings.json",
  skillLibraryPath: "/Users/demo/.skilldock/skills",
  skillLibraryProvider: "skilldock",
  defaultOpenToolId: "",
  skillInstallActivation: "apply-all-tools",
  mcpInstallActivation: "apply-all-tools",
  skillSourceViewStyle: "flat",
  language: "zh-CN",
  languageSource: "user",
  theme: "system",
};

export const pushTargetFixtures: Record<string, PushTargetSnapshot> = {
  "skill-publisher": {
    currentBranch: "feat/publish-copy",
    branches: [
      { name: "feat/publish-copy", isCurrent: true },
      { name: "main", isCurrent: false },
      { name: "release/2026-q2", isCurrent: false },
      { name: "feat/release-notes", isCurrent: false },
    ],
  },
  "drawio-diagram": {
    currentBranch: "main",
    branches: [
      { name: "main", isCurrent: true },
      { name: "feat/diagram-tuning", isCurrent: false },
      { name: "release/skills-v1", isCurrent: false },
    ],
  },
  "excalidraw-diagram": {
    currentBranch: "main",
    branches: [{ name: "main", isCurrent: true }],
  },
  "multi-search-engine": {
    currentBranch: "stable",
    branches: [{ name: "stable", isCurrent: true }],
  },
};

export const pushPreviewFixtures: Record<string, PushPreviewSnapshot> = {
  "skill-publisher": {
    targetBranch: "feat/publish-copy",
    willCreateBranch: false,
    repositoryPath: "/Users/demo/.skilldock/skills/team-skills",
    unpushedCommitCount: 1,
    uncommittedFiles: [
      {
        path: "SKILL.md",
        status: "M",
        diff: "-旧的发布说明\n+新的发布说明\n",
      },
      {
        path: "scripts/preflight.sh",
        status: "A",
        diff: "+echo \"checking skill release\"\n",
      },
    ],
  },
  "drawio-diagram": {
    targetBranch: "main",
    willCreateBranch: false,
    repositoryPath: "/Users/demo/.skilldock/skills/drawio-diagram",
    unpushedCommitCount: 0,
    uncommittedFiles: [
      {
        path: "SKILL.md",
        status: "M",
        diff: "-生成图表\n+生成可编辑图表\n",
      },
    ],
  },
};

export const skillFileBrowserFixtures: Record<string, SkillFileBrowserSnapshot> = {
  "drawio-diagram": {
    skillName: "drawio-diagram",
    rootName: "drawio-diagram",
    initialFilePath: "SKILL.md",
    entries: [
      { path: "", name: "drawio-diagram", entryType: "directory", depth: 0 },
      { path: "reference", name: "reference", entryType: "directory", depth: 1 },
      { path: "reference/generation.md", name: "generation.md", entryType: "file", depth: 2 },
      { path: "SKILL.md", name: "SKILL.md", entryType: "file", depth: 1 },
    ],
  },
  "skill-publisher": {
    skillName: "skill-publisher",
    rootName: "skill-publisher",
    initialFilePath: "SKILL.md",
    entries: [
      { path: "", name: "skill-publisher", entryType: "directory", depth: 0 },
      { path: "reference", name: "reference", entryType: "directory", depth: 1 },
      { path: "reference/release-checklist.md", name: "release-checklist.md", entryType: "file", depth: 2 },
      { path: "SKILL.md", name: "SKILL.md", entryType: "file", depth: 1 },
    ],
  },
};

export const skillFileDocumentFixtures: Record<string, Record<string, SkillFileDocument>> = {
  "drawio-diagram": {
    "SKILL.md": {
      path: "SKILL.md",
      content: "# drawio-diagram\n\n用于根据项目上下文生成 Draw.io 图表。\n\n## 使用时机\n\n- 需要输出架构图\n- 需要输出流程图\n",
    },
    "reference/generation.md": {
      path: "reference/generation.md",
      content: "# generation\n\n生成时优先抽取实体、关系和流程节点。\n",
    },
  },
  "skill-publisher": {
    "SKILL.md": {
      path: "SKILL.md",
      content: "# skill-publisher\n\n用于维护技能发布说明、变更记录和发布前检查。\n\n## 工作流程\n\n1. 检查变更\n2. 整理说明\n3. 更新发布信息\n",
    },
    "reference/release-checklist.md": {
      path: "reference/release-checklist.md",
      content: "# release-checklist\n\n- 校对变更说明\n- 更新版本号\n- 确认同步路径\n",
    },
  },
};

export const workspaceSnapshotFixture: WorkspaceSnapshot = {
  installedSkills: installedSkillFixtures,
  marketplaceSkills: marketplaceSkillFixtures,
  localCandidates: localSkillFixtures,
  toolConfigs: toolConfigFixtures,
  toolSkillEntries: toolSkillEntryFixtures,
  gitAccount: gitAccountFixture,
};

const initialFixtureState = structuredClone({
  installedSkillFixtures,
  marketplaceSkillFixtures,
  mcpMarketplaceServerFixtures,
  localSkillFixtures,
  repoSkillCandidateFixtures,
  localInstallSkillCandidateFixtures,
  toolConfigFixtures,
  pluginFixtures,
  pluginProbeFixture,
  cliToolFixtures,
  mcpWorkspaceFixture,
  gitAccountFixture,
  appSettingsFixture,
  pushTargetFixtures,
  pushPreviewFixtures,
  skillFileBrowserFixtures,
  skillFileDocumentFixtures,
});

function resetArrayFixture<T>(target: T[], source: T[]) {
  target.splice(0, target.length, ...structuredClone(source));
}

function resetObjectFixture<T extends Record<string, unknown>>(target: T, source: T) {
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete target[key as keyof T];
    }
  }

  Object.assign(target, structuredClone(source));
}

function resetRecordFixture<T>(target: Record<string, T>, source: Record<string, T>) {
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete target[key];
    }
  }

  for (const [key, value] of Object.entries(source)) {
    target[key] = structuredClone(value);
  }
}

export function resetSkillFixtureState() {
  resetArrayFixture(installedSkillFixtures, initialFixtureState.installedSkillFixtures);
  resetArrayFixture(marketplaceSkillFixtures, initialFixtureState.marketplaceSkillFixtures);
  resetArrayFixture(mcpMarketplaceServerFixtures, initialFixtureState.mcpMarketplaceServerFixtures);
  resetArrayFixture(localSkillFixtures, initialFixtureState.localSkillFixtures);
  resetRecordFixture(repoSkillCandidateFixtures, initialFixtureState.repoSkillCandidateFixtures);
  resetRecordFixture(localInstallSkillCandidateFixtures, initialFixtureState.localInstallSkillCandidateFixtures);
  resetArrayFixture(toolConfigFixtures, initialFixtureState.toolConfigFixtures);
  resetArrayFixture(pluginFixtures, initialFixtureState.pluginFixtures);
  resetObjectFixture(pluginProbeFixture, initialFixtureState.pluginProbeFixture);
  resetArrayFixture(cliToolFixtures, initialFixtureState.cliToolFixtures);
  resetObjectFixture(mcpWorkspaceFixture, initialFixtureState.mcpWorkspaceFixture);
  resetObjectFixture(gitAccountFixture, initialFixtureState.gitAccountFixture);
  resetObjectFixture(appSettingsFixture, initialFixtureState.appSettingsFixture);
  resetRecordFixture(pushTargetFixtures, initialFixtureState.pushTargetFixtures);
  resetRecordFixture(pushPreviewFixtures, initialFixtureState.pushPreviewFixtures);
  resetRecordFixture(skillFileBrowserFixtures, initialFixtureState.skillFileBrowserFixtures);
  resetRecordFixture(skillFileDocumentFixtures, initialFixtureState.skillFileDocumentFixtures);

  workspaceSnapshotFixture.installedSkills = installedSkillFixtures;
  workspaceSnapshotFixture.marketplaceSkills = marketplaceSkillFixtures;
  workspaceSnapshotFixture.localCandidates = localSkillFixtures;
  workspaceSnapshotFixture.toolConfigs = toolConfigFixtures;
  workspaceSnapshotFixture.gitAccount = gitAccountFixture;
}
