import type {
  AppSettings,
  GitAccountSummary,
  LocalInstallSkillCandidate,
  LocalSkillCandidate,
  MarketplaceSkill,
  McpMarketplaceServer,
  PushPreviewSnapshot,
  PushTargetSnapshot,
  RepoSkillCandidate,
  SkillFileBrowserSnapshot,
  SkillFileDocument,
  ToolConfig,
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
      { name: "Windsurf", statusLabel: "已同步" },
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
    localPath: "/Users/wanghuan/.cursor/skills/excalidraw-diagram",
    detectedFrom: "/Users/wanghuan/.cursor/skills",
    sourceHint: "符号链接",
  },
  {
    name: "excalidraw-diagram",
    description: "生成可直接在 Excalidraw 打开的手绘风图表。",
    localPath: "/Users/wanghuan/.claude/skills/excalidraw-diagram",
    detectedFrom: "/Users/wanghuan/.claude/skills",
    sourceHint: "符号链接",
  },
  {
    name: "excalidraw-diagram",
    description: "生成可直接在 Excalidraw 打开的手绘风图表。",
    localPath: "/Users/wanghuan/.codeium/windsurf/skills/excalidraw-diagram",
    detectedFrom: "/Users/wanghuan/.codeium/windsurf/skills",
    sourceHint: "符号链接",
  },
  {
    name: "technical-design",
    description: "根据产品文档和需求输入整理技术设计骨架。",
    localPath: "/Users/wanghuan/.codex/skills/technical-design",
    detectedFrom: "/Users/wanghuan/.codex/skills",
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
  { id: "claude-code", name: "Claude Code", skillsPath: "/Users/wanghuan/.claude/skills", mcpConfigPath: "/Users/wanghuan/.claude.json", statusLabel: "已安装", isEnabled: true, primaryType: "cli", surfaceTypes: ["cli", "desktop", "ide-plugin"], supportsDirectOpen: false },
  { id: "codex", name: "Codex", skillsPath: "/Users/wanghuan/.codex/skills", mcpConfigPath: "/Users/wanghuan/.codex/config.toml", statusLabel: "已安装", isEnabled: true, primaryType: "desktop", surfaceTypes: ["desktop", "cli"], supportsDirectOpen: false },
  { id: "opencode", name: "OpenCode", skillsPath: "/Users/wanghuan/.config/opencode/skills", mcpConfigPath: "/Users/wanghuan/.config/opencode/opencode.json", statusLabel: "已安装", isEnabled: true, primaryType: "cli", surfaceTypes: ["cli", "desktop", "ide-plugin"], supportsDirectOpen: false },
  { id: "cursor", name: "Cursor", skillsPath: "/Users/wanghuan/.cursor/skills", mcpConfigPath: "/Users/wanghuan/.cursor/mcp.json", statusLabel: "已安装", isEnabled: true, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: true },
  { id: "gemini", name: "Gemini CLI", skillsPath: "/Users/wanghuan/.gemini/skills", mcpConfigPath: "/Users/wanghuan/.gemini/settings.json", statusLabel: "已安装", isEnabled: true, primaryType: "cli", surfaceTypes: ["cli"], supportsDirectOpen: false },
  { id: "antigravity", name: "Antigravity", skillsPath: "/Users/wanghuan/.gemini/antigravity/skills", mcpConfigPath: "", statusLabel: "已安装", isEnabled: true, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: true },
  { id: "windsurf", name: "Windsurf", skillsPath: "/Users/wanghuan/.codeium/windsurf/skills", mcpConfigPath: "/Users/wanghuan/.codeium/windsurf/mcp_config.json", statusLabel: "已安装", isEnabled: true, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: true },
  { id: "intellij", name: "IntelliJ IDEA", skillsPath: "/Users/wanghuan/.intellij/skills", mcpConfigPath: "", statusLabel: "已安装", isEnabled: true, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: true },
  { id: "openclaw", name: "OpenClaw", skillsPath: "/Users/wanghuan/.openclaw/skills", mcpConfigPath: "/Users/wanghuan/.openclaw/openclaw.json", statusLabel: "已安装", isEnabled: true, primaryType: "desktop", surfaceTypes: ["desktop"], supportsDirectOpen: false },
  { id: "continue", name: "Continue", skillsPath: "/Users/wanghuan/.continue/skills", mcpConfigPath: "/Users/wanghuan/.continue/config.yaml", statusLabel: "已安装", isEnabled: true, primaryType: "editor", surfaceTypes: ["editor", "ide-plugin"], supportsDirectOpen: false },
  { id: "iflow", name: "iFlow", skillsPath: "/Users/wanghuan/.iflow/skills", mcpConfigPath: "", statusLabel: "已安装", isEnabled: true, primaryType: "cli", surfaceTypes: ["cli"], supportsDirectOpen: false },
  { id: "codebuddy", name: "CodeBuddy", skillsPath: "/Users/wanghuan/.codebuddy/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor", "ide-plugin"], supportsDirectOpen: false },
  { id: "trae", name: "Trae", skillsPath: "/Users/wanghuan/.trae/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: true },
  { id: "droid", name: "Droid", skillsPath: "/Users/wanghuan/.factory/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: false },
  { id: "augment", name: "Augment", skillsPath: "/Users/wanghuan/.augment/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor", "ide-plugin", "desktop"], supportsDirectOpen: false },
  { id: "cline", name: "Cline", skillsPath: "/Users/wanghuan/.cline/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor", "cli"], supportsDirectOpen: false },
  { id: "commandcode", name: "CommandCode", skillsPath: "/Users/wanghuan/.commandcode/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: false },
  { id: "crush", name: "Crush", skillsPath: "/Users/wanghuan/.config/crush/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "cli", surfaceTypes: ["cli"], supportsDirectOpen: false },
  { id: "goose", name: "Goose", skillsPath: "/Users/wanghuan/.config/goose/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "cli", surfaceTypes: ["cli"], supportsDirectOpen: false },
  { id: "junie", name: "Junie", skillsPath: "/Users/wanghuan/.junie/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor", "ide-plugin"], supportsDirectOpen: false },
  { id: "kilo-code", name: "Kilo Code", skillsPath: "/Users/wanghuan/.kilocode/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: false },
  { id: "kiro", name: "Kiro", skillsPath: "/Users/wanghuan/.kiro/skills", mcpConfigPath: "", statusLabel: "已安装", isEnabled: true, primaryType: "editor", surfaceTypes: ["editor", "cli"], supportsDirectOpen: true },
  { id: "qoder", name: "Qoder", skillsPath: "/Users/wanghuan/.qoder/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor", "ide-plugin"], supportsDirectOpen: false },
  { id: "qwen-code", name: "Qwen Code", skillsPath: "/Users/wanghuan/.qwen/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "cli", surfaceTypes: ["cli"], supportsDirectOpen: false },
  { id: "roo-code", name: "Roo Code", skillsPath: "/Users/wanghuan/.roo/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: false },
  { id: "zencoder", name: "Zencoder", skillsPath: "/Users/wanghuan/.zencoder/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor", "ide-plugin", "desktop"], supportsDirectOpen: false },
  { id: "trae-cn", name: "Trae CN", skillsPath: "/Users/wanghuan/.trae-cn/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor"], supportsDirectOpen: false },
  { id: "hermes", name: "Hermes", skillsPath: "/Users/wanghuan/.hermes/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "cli", surfaceTypes: ["cli"], supportsDirectOpen: false },
  { id: "github-copilot", name: "GitHub Copilot", skillsPath: "/Users/wanghuan/.copilot/skills", mcpConfigPath: "", statusLabel: "未安装", isEnabled: false, primaryType: "editor", surfaceTypes: ["editor", "ide-plugin"], supportsDirectOpen: false },
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
  defaultOpenToolId: "",
  skillInstallActivation: "apply-all-tools",
  mcpInstallActivation: "disable-all-tools",
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
