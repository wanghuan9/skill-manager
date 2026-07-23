import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BusinessError } from "@/app/errors";
import {
  detectPreferredAppLanguage,
  fetchAppSettings,
  deleteSkill,
  deleteToolSkill,
  discoverLocalInstallSkills,
  fetchGitAccount,
  fetchGitStates,
  fetchLocalSkillCandidates,
  fetchMarketplaceSkillsByPage,
  fetchSkillFileBrowser,
  fetchSkillFileContent,
  fetchToolSkillFileBrowser,
  fetchToolSkillFileContent,
  fetchPushPreviewSnapshot,
  fetchPushTargetSnapshot,
  fetchSkillLocalChanges,
  fetchSkillUpdatePreview,
  fetchToolConfigs,
  fetchToolSkillEntries,
  fetchStartupInstalledSkills,
  importLocalSkill,
  installLocalSkill,
  installSelectedLocalSkills,
  installSkillFromMarket,
  installSkillFromRepo,
  installSelectedRepoSkills,
  openSkillInEditor,
  openPathInFinder,
  openSkillRepository,
  refreshLocalGitState,
  revertSkillChange as revertSkillChangeRequest,
  saveSkillFileContent,
  setSkillAllToolStatuses,
  setToolSkillStatuses,
  shouldUseFixtureData,
  subscribeSkillLibraryChanges,
  toggleSkillTool,
  updateAppSettings,
  updateSkill,
} from "@/features/skills/api/skill-client";
import { waitForNextPaint } from "@/app/utils/wait-for-next-paint";
import { appSettingsFixture, workspaceSnapshotFixture } from "@/features/skills/state/skill-fixtures";
import {
  dedupeMarketplaceSkills,
  sortMarketplaceSkillsByPopularity,
} from "@/features/skills/utils/marketplace-skills";
import type {
  AppLanguage,
  AppLanguageSource,
  AppSettings,
  AppTheme,
  GitAccountSummary,
  GitChangeFile,
  InstallActivationMode,
  LocalSkillCandidate,
  LocalInstallSkillCandidate,
  MarketplaceSkill,
  MarketplaceSourceSite,
  PushPreviewSnapshot,
  PushTargetSnapshot,
  RepoSkillCandidate,
  SkillFileBrowserSnapshot,
  SkillFileDocument,
  SkillSummary,
  SkillSourceViewStyle,
  ToolConfig,
  ToolSkillEntry,
  UpdatePreviewSnapshot,
} from "@/features/skills/state/skill-store";
import { getSkillIdentity } from "@/features/skills/state/skill-selectors";
import { buildOpenToolOptions, resolveDefaultOpenToolId } from "@/features/skills/utils/open-tools";
import {
  localizeGitAccountSummary,
  localizeSkillSummaries,
  localizeToolConfigs,
} from "@/features/skills/utils/skill-localization";
import { getToolStatusLabel, isToolEnabledStatus } from "@/features/skills/utils/tool-status";

const STARTUP_WORKSPACE_CACHE_KEY = "skilldock.startupWorkspaceCache";
const APP_LANGUAGE_STORAGE_KEY = "skilldock.settings.language";
const APP_THEME_STORAGE_KEY = "skilldock.settings.theme";
const APP_SKILL_SOURCE_VIEW_STYLE_STORAGE_KEY = "skilldock.settings.skillSourceViewStyle";
const FALLBACK_OPEN_TOOL_ID = "finder";
const MARKETPLACE_PAGE_SIZE = 18;
const MARKETPLACE_SOURCE_SITES: MarketplaceSourceSite[] = ["skills.sh", "skillsmp"];
const STARTUP_LOAD_DELAY_MS = 0;
const AUTO_GIT_STATE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_GIT_STATE_REFRESH_COOLDOWN_MS = 60 * 1000;
const LOCAL_WORKSPACE_ALIGN_COOLDOWN_MS = 2_000;
const SKILL_LIBRARY_CHANGE_DEBOUNCE_MS = 500;
const STARTUP_CACHED_REMOTE_COLLAB_STATUSES = new Set<SkillSummary["collabStatus"]>([
  "update-available",
  "diverged",
]);

type RefreshWorkspaceOptions = {
  showRefreshing?: boolean;
};

type SkillWorkspaceContextValue = {
  installedSkills: SkillSummary[];
  marketplaceSkills: MarketplaceSkill[];
  localCandidates: LocalSkillCandidate[];
  toolConfigs: ToolConfig[];
  toolSkillEntries: ToolSkillEntry[];
  gitAccount: GitAccountSummary | null;
  isLoading: boolean;
  isWorkspaceRefreshing: boolean;
  isUpdatingAllSkills: boolean;
  isMarketplaceLoadingBySource: Record<MarketplaceSourceSite, boolean>;
  isSearchLoading: boolean;
  installingMarketplaceSkillIds: Set<string>;
  hasMoreMarketplaceSkillsBySource: Record<MarketplaceSourceSite, boolean>;
  installFromMarket: (skill: MarketplaceSkill) => Promise<void>;
  loadInitialMarketplaceSkills: (sourceSite: MarketplaceSourceSite) => Promise<void>;
  loadMoreMarketplaceSkills: (sourceSite: MarketplaceSourceSite) => Promise<void>;
  searchMarketplaceSkills: (query: string) => Promise<MarketplaceSkill[]>;
  discoverRepoSkills: (repoUrl: string, gitRef?: string) => Promise<RepoSkillCandidate[]>;
  installFromRepo: (repoUrl: string, selectedPaths: string[], gitRef?: string) => Promise<void>;
  discoverLocalInstallSkills: (localPath: string) => Promise<LocalInstallSkillCandidate[]>;
  installFromLocalPath: (localPath: string, skillName?: string) => Promise<void>;
  installSelectedLocalSkills: (localPath: string, selectedPaths: string[]) => Promise<void>;
  importCandidate: (localPath: string) => Promise<void>;
  refreshLocalCandidates: () => Promise<void>;
  alignLocalWorkspaceState: () => Promise<void>;
  refreshWorkspace: (options?: RefreshWorkspaceOptions) => Promise<void>;
  refreshToolSkillEntries: (toolId: string) => Promise<void>;
  updateSkill: (skillName: string) => Promise<void>;
  updateAllSkills: () => Promise<void>;
  deleteSkill: (skillName: string) => Promise<void>;
  deleteToolSkill: (input: { toolId: string; skillName: string }) => Promise<void>;
  markSkillAsActive: (skillName: string) => void;
  loadSkillFileBrowser: (skillName: string) => Promise<SkillFileBrowserSnapshot>;
  loadSkillFileContent: (input: {
    skillName: string;
    relativePath: string;
  }) => Promise<SkillFileDocument>;
  loadToolSkillFileBrowser: (input: {
    toolId: string;
    skillName: string;
  }) => Promise<SkillFileBrowserSnapshot>;
  loadToolSkillFileContent: (input: {
    toolId: string;
    skillName: string;
    relativePath: string;
  }) => Promise<SkillFileDocument>;
  saveSkillFileContent: (input: {
    skillName: string;
    relativePath: string;
    content: string;
  }) => Promise<SkillFileDocument>;
  refreshSkillLocalGitState: (skillName: string) => Promise<void>;
  toggleSkillTool: (input: { skillName: string; toolName: string; toolNames: string[] }) => Promise<void>;
  setToolSkillStatuses: (input: {
    toolName: string;
    skillNames: string[];
    enabled: boolean;
    toolNames: string[];
  }) => Promise<void>;
  setSkillAllToolStatuses: (input: {
    skillName: string;
    enabled: boolean;
    toolNames: string[];
  }) => Promise<void>;
  loadPushPreview: (input: {
    skillName: string;
    targetBranch: string;
    createBranchName?: string;
  }) => Promise<PushPreviewSnapshot>;
  loadSkillLocalChanges: (skillName: string) => Promise<GitChangeFile[]>;
  loadSkillUpdatePreview: (skillName: string, localPath?: string) => Promise<UpdatePreviewSnapshot>;
  revertSkillChange: (input: {
    skillName: string;
    relativePath: string;
    hunkIndex?: number;
    expectedPatch?: string;
    staged?: boolean;
  }) => Promise<SkillSummary>;
  loadPushTargets: (skillName: string) => Promise<PushTargetSnapshot>;
  openSkillRepository: (skillName: string) => Promise<void>;
  openSkillInEditor: (input: { skillName: string; editorId: string }) => Promise<void>;
  defaultOpenToolId: string;
  setDefaultOpenToolId: (toolId: string) => Promise<void>;
  appSettings: AppSettings;
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => Promise<void>;
  setTheme: (theme: AppTheme) => Promise<void>;
  setSkillInstallActivation: (mode: InstallActivationMode) => Promise<void>;
  setMcpInstallActivation: (mode: InstallActivationMode) => Promise<void>;
  setSkillSourceViewStyle: (style: SkillSourceViewStyle) => Promise<void>;
  openSkillWithDefaultTool: (skillName: string) => Promise<void>;
  openPathInFinder: (path: string) => Promise<void>;
};

const SkillWorkspaceContext = createContext<SkillWorkspaceContextValue | null>(null);

function readStoredAppTheme(): AppTheme {
  if (typeof window === "undefined") {
    return "system";
  }

  const storedTheme = window.localStorage.getItem(APP_THEME_STORAGE_KEY);
  return storedTheme === "light" || storedTheme === "dark" ? storedTheme : "system";
}

function readStoredSkillSourceViewStyle(): SkillSourceViewStyle {
  if (typeof window === "undefined") {
    return "select";
  }

  return window.localStorage.getItem(APP_SKILL_SOURCE_VIEW_STYLE_STORAGE_KEY) === "flat"
    ? "flat"
    : "select";
}

function resolveAppTheme(theme: AppTheme): "light" | "dark" {
  if (theme !== "system") {
    return theme;
  }

  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

type SkillWorkspaceProviderProps = {
  children: ReactNode;
};

type StartupWorkspaceCache = {
  installedSkills: SkillSummary[];
  localCandidates: LocalSkillCandidate[];
  toolConfigs: ToolConfig[];
  gitAccount: GitAccountSummary;
};

type CachedSkillSummary = Partial<SkillSummary> & {
  lastSyncedAt?: string;
};

function removeInstalledMarketplaceSkill(
  skills: MarketplaceSkill[],
  installedSkill: SkillSummary,
) {
  return skills.filter((skill) => skill.name !== installedSkill.name);
}

function patchSkillToolStatus(skill: SkillSummary, toolName: string, nextStatusLabel: string) {
  let matchedTool = false;
  const tools = skill.tools.map((tool) => {
    if (tool.name !== toolName) {
      return tool;
    }

    matchedTool = true;
    return {
      ...tool,
      statusLabel: nextStatusLabel,
    };
  });

  if (!matchedTool) {
    return skill;
  }

  return {
    ...skill,
    syncedToolCount: tools.filter((tool) => isToolEnabledStatus(tool.statusLabel)).length,
    tools,
  };
}

function patchAllSkillToolStatuses(skill: SkillSummary, nextStatusLabel: string) {
  const tools = skill.tools.map((tool) => ({
    ...tool,
    statusLabel: nextStatusLabel,
  }));

  return {
    ...skill,
    syncedToolCount: tools.filter((tool) => isToolEnabledStatus(tool.statusLabel)).length,
    tools,
  };
}

function mergeUpdatedSkillsPreservingOrder(
  currentSkills: SkillSummary[],
  updatedSkills: SkillSummary[],
) {
  const updatedByIdentity = new Map(updatedSkills.map((skill) => [getSkillIdentity(skill), skill]));
  const mergedSkills = currentSkills.map((skill) => updatedByIdentity.get(getSkillIdentity(skill)) ?? skill);
  const currentSkillIdentities = new Set(currentSkills.map(getSkillIdentity));
  const newSkills = updatedSkills.filter((skill) => !currentSkillIdentities.has(getSkillIdentity(skill)));

  return [...newSkills, ...mergedSkills];
}

function getMarketplaceSearchFailedMessage(language: AppLanguage) {
  return language === "en" ? "Failed to search sources" : "搜索安装源失败";
}

function getPartialSkillUpdateFailedMessage(input: {
  language: AppLanguage;
  updated: number;
  failed: number;
  names: string;
}) {
  if (input.language === "en") {
    return `Updated ${input.updated} skills, but ${input.failed} failed: ${input.names}`;
  }

  return `已更新 ${input.updated} 个 skill，${input.failed} 个更新失败：${input.names}`;
}

function removeImportedCandidate(
  candidates: LocalSkillCandidate[],
  importedSkill: SkillSummary,
) {
  return candidates.filter((candidate) =>
    candidate.localPath !== importedSkill.localPath
      && candidate.localPath !== importedSkill.sourceUrl
      && candidate.name !== importedSkill.name
  );
}

function normalizeCachedSkillSummary(skill: CachedSkillSummary): SkillSummary {
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
    statusText: skill.statusText ?? "",
    remoteUpdatedAt: skill.remoteUpdatedAt ?? skill.lastSyncedAt ?? normalizedUpdatedAt,
    localUpdatedAt: skill.localUpdatedAt ?? skill.lastSyncedAt ?? normalizedUpdatedAt,
    lastCheckedAt: skill.lastCheckedAt ?? "",
    syncedToolCount: skill.syncedToolCount ?? 0,
    lastEditor: skill.lastEditor ?? "",
    commitLabel: skill.commitLabel ?? "",
    gitLinked: skill.gitLinked ?? false,
    localChangeCount: skill.localChangeCount ?? 0,
    tools: skill.tools ?? [],
  };
}

function readStartupWorkspaceCache(): StartupWorkspaceCache | null {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.getItem !== "function"
  ) {
    return null;
  }

  const payload = window.localStorage.getItem(STARTUP_WORKSPACE_CACHE_KEY);
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as Partial<StartupWorkspaceCache>;
    if (
      !Array.isArray(parsed.installedSkills) ||
      !Array.isArray(parsed.localCandidates) ||
      !Array.isArray(parsed.toolConfigs) ||
      !parsed.gitAccount
    ) {
      return null;
    }

    return {
      installedSkills: parsed.installedSkills.map((skill) =>
        normalizeCachedSkillSummary(skill as CachedSkillSummary),
      ),
      localCandidates: parsed.localCandidates,
      toolConfigs: parsed.toolConfigs,
      gitAccount: parsed.gitAccount,
    };
  } catch {
    return null;
  }
}

function writeStartupWorkspaceCache(cache: StartupWorkspaceCache) {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.setItem !== "function"
  ) {
    return;
  }

  window.localStorage.setItem(STARTUP_WORKSPACE_CACHE_KEY, JSON.stringify(cache));
}

export function mergeStartupSkillStatusCache(
  skills: SkillSummary[],
  cachedSkills: SkillSummary[],
) {
  if (cachedSkills.length === 0) {
    return skills;
  }

  const cachedByLocalPath = new Map(
    cachedSkills
      .filter((skill) => skill.localPath.trim().length > 0)
      .map((skill) => [skill.localPath, skill]),
  );
  const cachedByName = new Map(cachedSkills.map((skill) => [skill.name, skill]));

  return skills.map((skill) => {
    const cachedSkill =
      cachedByLocalPath.get(skill.localPath) ??
      (skill.localPath.trim().length === 0 ? cachedByName.get(skill.name) : undefined);
    if (
      !cachedSkill ||
      skill.collabStatus !== "clean" ||
      !STARTUP_CACHED_REMOTE_COLLAB_STATUSES.has(cachedSkill.collabStatus)
    ) {
      return skill;
    }

    return {
      ...skill,
      branch: cachedSkill.branch,
      collabStatus: cachedSkill.collabStatus,
      statusText: cachedSkill.statusText,
      remoteUpdatedAt: cachedSkill.remoteUpdatedAt,
      localUpdatedAt: cachedSkill.localUpdatedAt,
      lastCheckedAt: cachedSkill.lastCheckedAt,
      lastEditor: cachedSkill.lastEditor,
      commitLabel: cachedSkill.commitLabel,
      gitLinked: cachedSkill.gitLinked,
      localChangeCount: cachedSkill.localChangeCount ?? 0,
    };
  });
}

export function SkillWorkspaceProvider({ children }: SkillWorkspaceProviderProps) {
  const usesFixtureData = shouldUseFixtureData();
  const startupCache = useMemo(
    () => (usesFixtureData ? null : readStartupWorkspaceCache()),
    [usesFixtureData],
  );
  const [installedSkills, setInstalledSkills] = useState<SkillSummary[]>(
    usesFixtureData
      ? workspaceSnapshotFixture.installedSkills
      : startupCache?.installedSkills ?? [],
  );
  const [marketplaceSkills, setMarketplaceSkills] = useState<MarketplaceSkill[]>(
    usesFixtureData ? workspaceSnapshotFixture.marketplaceSkills : [],
  );
  const [localCandidates, setLocalCandidates] = useState<LocalSkillCandidate[]>(
    usesFixtureData
      ? workspaceSnapshotFixture.localCandidates
      : startupCache?.localCandidates ?? [],
  );
  const [toolConfigs, setToolConfigs] = useState<ToolConfig[]>(
    usesFixtureData
      ? workspaceSnapshotFixture.toolConfigs
      : startupCache?.toolConfigs ?? [],
  );
  const [toolSkillEntries, setToolSkillEntries] = useState<ToolSkillEntry[]>(
    usesFixtureData ? workspaceSnapshotFixture.toolSkillEntries : [],
  );
  const [gitAccount, setGitAccount] = useState<GitAccountSummary | null>(
    usesFixtureData
      ? workspaceSnapshotFixture.gitAccount
      : startupCache?.gitAccount ?? null,
  );
  const [appSettings, setAppSettings] = useState<AppSettings>(
    usesFixtureData
      ? appSettingsFixture
      : {
          storagePath: "",
          defaultOpenToolId: "",
          skillInstallActivation: "apply-all-tools",
          mcpInstallActivation: "apply-all-tools",
          skillSourceViewStyle: readStoredSkillSourceViewStyle(),
          language: "zh-CN",
          languageSource: "auto",
          theme: readStoredAppTheme(),
        },
  );
  const [isLoading, setIsLoading] = useState(!usesFixtureData && startupCache === null);
  const [isMarketplaceLoadingBySource, setIsMarketplaceLoadingBySource] = useState<
    Record<MarketplaceSourceSite, boolean>
  >({
    "skills.sh": false,
    skillsmp: false,
  });
  const [isSearchLoading, setIsSearchLoading] = useState(false);
  const [installingMarketplaceSkillIds, setInstallingMarketplaceSkillIds] = useState<Set<string>>(new Set());
  const installingMarketplaceSkillIdsRef = useRef(new Set<string>());
  const marketplaceLoadingBySourceRef = useRef<Record<MarketplaceSourceSite, boolean>>({
    "skills.sh": false,
    skillsmp: false,
  });
  const [marketplacePageBySource, setMarketplacePageBySource] = useState<
    Record<MarketplaceSourceSite, number>
  >({
    "skills.sh": 0,
    skillsmp: 0,
  });
  const [hasMoreMarketplaceSkillsBySource, setHasMoreMarketplaceSkillsBySource] = useState<
    Record<MarketplaceSourceSite, boolean>
  >({
    "skills.sh": true,
    skillsmp: true,
  });
  const marketplaceHasMoreBySourceRef = useRef<Record<MarketplaceSourceSite, boolean>>({
    "skills.sh": true,
    skillsmp: true,
  });
  const gitStateRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const workspaceMutationVersionRef = useRef(0);
  const lastGitStateRefreshAtRef = useRef(0);
  const lastLocalWorkspaceAlignAtRef = useRef(0);
  const [isWorkspaceRefreshing, setIsWorkspaceRefreshing] = useState(false);
  const [isUpdatingAllSkills, setIsUpdatingAllSkills] = useState(false);
  const updateAllSkillsInFlightRef = useRef<Promise<void> | null>(null);
  const visibleGitStateRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const localWorkspaceAlignInFlightRef = useRef<Promise<void> | null>(null);
  const localGitRefreshInFlightRef = useRef(new Set<string>());
  const localGitRefreshDebounceTimersRef = useRef(new Map<string, number>());
  const installedSkillsRef = useRef(installedSkills);
  const startupWatchedSkillNamesRef = useRef(new Set<string>());
  const defaultOpenToolId = appSettings.defaultOpenToolId;
  const language = appSettings.language;
  const skillSourceViewStyle = appSettings.skillSourceViewStyle ?? "select";

  useEffect(() => {
    installedSkillsRef.current = installedSkills;
  }, [installedSkills]);

  useEffect(() => {
    if (usesFixtureData || !gitAccount) {
      return;
    }

    writeStartupWorkspaceCache({
      installedSkills,
      localCandidates,
      toolConfigs,
      gitAccount,
    });
  }, [gitAccount, installedSkills, localCandidates, toolConfigs, usesFixtureData]);

  async function persistAppSettings(nextSettings: AppSettings) {
    const savedSettings = await updateAppSettings({ settings: nextSettings });
    if (typeof window !== "undefined") {
      window.localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, savedSettings.language);
      window.localStorage.setItem(APP_THEME_STORAGE_KEY, savedSettings.theme);
    }
    setAppSettings(savedSettings);
    return savedSettings;
  }

  function isValidDefaultOpenToolId(toolId: string, nextToolConfigs: ToolConfig[]) {
    if (toolId === FALLBACK_OPEN_TOOL_ID) {
      return true;
    }

    return buildOpenToolOptions(nextToolConfigs, appSettings.language)
      .some((tool) => tool.id === toolId);
  }

  async function ensureDefaultOpenToolId(nextToolConfigs: ToolConfig[], nextSettings: AppSettings) {
    if (
      nextSettings.defaultOpenToolId.trim().length > 0
      && isValidDefaultOpenToolId(nextSettings.defaultOpenToolId, nextToolConfigs)
    ) {
      return nextSettings;
    }

    const resolvedDefaultOpenToolId = resolveDefaultOpenToolId(nextToolConfigs);
    if (nextSettings.defaultOpenToolId === resolvedDefaultOpenToolId) {
      return nextSettings;
    }

    return persistAppSettings({
      ...nextSettings,
      defaultOpenToolId: resolvedDefaultOpenToolId,
    });
  }

  async function handleSetDefaultOpenToolId(toolId: string) {
    const nextSettings = {
      ...appSettings,
      defaultOpenToolId: toolId,
    };
    await persistAppSettings(nextSettings);
  }

  async function handleSetLanguage(nextLanguage: AppLanguage) {
    await persistAppSettings({
      ...appSettings,
      language: nextLanguage,
      languageSource: "user",
    });
  }

  async function handleSetTheme(theme: AppTheme) {
    await persistAppSettings({
      ...appSettings,
      theme,
    });
  }

  useLayoutEffect(() => {
    const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      document.documentElement.dataset.theme = resolveAppTheme(appSettings.theme);
    };

    applyTheme();
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, appSettings.theme);

    if (appSettings.theme !== "system" || !mediaQuery) {
      return;
    }

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", applyTheme);
      return () => mediaQuery.removeEventListener("change", applyTheme);
    }

    mediaQuery.addListener(applyTheme);
    return () => mediaQuery.removeListener(applyTheme);
  }, [appSettings.theme]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, language);
    }
    setInstalledSkills((current) => localizeSkillSummaries(current, language));
    setToolConfigs((current) => localizeToolConfigs(current, language));
    setGitAccount((current) => localizeGitAccountSummary(current, language));
  }, [language]);

  useEffect(() => {
    window.localStorage.setItem(APP_SKILL_SOURCE_VIEW_STYLE_STORAGE_KEY, skillSourceViewStyle);
  }, [skillSourceViewStyle]);

  useEffect(() => {
    if (usesFixtureData || appSettings.languageSource !== "auto" || appSettings.storagePath.trim().length === 0) {
      return;
    }

    let active = true;

    void detectPreferredAppLanguage()
      .then(async (detectedLanguage) => {
        if (!active || detectedLanguage === appSettings.language) {
          return;
        }

        await persistAppSettings({
          ...appSettings,
          language: detectedLanguage,
          languageSource: "auto",
        });
      })
      .catch((error) => {
        console.error("Failed to detect preferred app language:", error);
      });

    return () => {
      active = false;
    };
  }, [appSettings.language, appSettings.languageSource, appSettings.storagePath, usesFixtureData]);

  function applyWorkspaceAncillaryData(input: {
    candidates?: LocalSkillCandidate[];
    tools?: ToolConfig[];
    toolSkills?: ToolSkillEntry[];
    account?: GitAccountSummary | null;
    settings?: AppSettings;
  }) {
    if (input.candidates) {
      setLocalCandidates(input.candidates);
    }
    if (input.tools) {
      setToolConfigs(input.tools);
    }
    if (input.toolSkills) {
      setToolSkillEntries(input.toolSkills);
    }
    if (input.account) {
      setGitAccount(input.account);
    }
    if (input.settings) {
      setAppSettings(input.settings);
    }
  }

  async function loadWorkspaceCore() {
    const [skills, candidates, tools, toolSkills, account, settings] = await Promise.all([
      fetchStartupInstalledSkills(),
      fetchLocalSkillCandidates(),
      fetchToolConfigs(),
      fetchToolSkillEntries().catch(() => []),
      fetchGitAccount(),
      fetchAppSettings(),
    ]);

    return {
      skills,
      candidates,
      tools,
      toolSkills,
      account,
      settings,
    };
  }

  const refreshToolSkillEntries = useCallback(async (toolId: string) => {
    const refreshedEntries = await fetchToolSkillEntries(toolId);
    setToolSkillEntries((currentEntries) => [
      ...currentEntries.filter((entry) => entry.toolId !== toolId),
      ...refreshedEntries,
    ]);
  }, []);

  async function alignLocalWorkspaceState(
    shouldApply: () => boolean = () => true,
  ) {
    if (localWorkspaceAlignInFlightRef.current) {
      return localWorkspaceAlignInFlightRef.current;
    }
    if (Date.now() - lastLocalWorkspaceAlignAtRef.current < LOCAL_WORKSPACE_ALIGN_COOLDOWN_MS) {
      return Promise.resolve();
    }

    const alignPromise = (async () => {
      try {
        const workspace = await loadWorkspaceCore();
        if (!shouldApply()) {
          return;
        }

        lastLocalWorkspaceAlignAtRef.current = Date.now();
        startupWatchedSkillNamesRef.current = new Set(
          workspace.skills.map((skill) => skill.name),
        );
        setInstalledSkills(workspace.skills);
        const resolvedSettings = await ensureDefaultOpenToolId(
          workspace.tools,
          workspace.settings,
        );
        applyWorkspaceAncillaryData({
          candidates: workspace.candidates,
          tools: workspace.tools,
          toolSkills: workspace.toolSkills,
          account: workspace.account,
          settings: resolvedSettings,
        });
      } finally {
        localWorkspaceAlignInFlightRef.current = null;
      }
    })();

    localWorkspaceAlignInFlightRef.current = alignPromise;
    return alignPromise;
  }

  async function loadWorkspaceSnapshot(options: RefreshWorkspaceOptions = {}): Promise<void> {
    if (options.showRefreshing) {
      const refreshPromise: Promise<void> = loadWorkspaceSnapshot({
        ...options,
        showRefreshing: false,
      });
      showRefreshIndicatorUntil(refreshPromise);
      return refreshPromise;
    }

    const shouldBlockSkillList = installedSkills.length === 0;
    if (!shouldBlockSkillList) {
      await alignLocalWorkspaceState();
      await refreshGitStatesInBackground(undefined, {
        showRefreshing: false,
      });
      return;
    }

    if (shouldBlockSkillList) {
      setIsLoading(true);
    }
    try {
      await alignLocalWorkspaceState();
      if (shouldBlockSkillList) {
        setIsLoading(false);
      }
      void refreshGitStatesInBackground(undefined, {
        showRefreshing: false,
      });
      return;
    } catch (startupError) {
      console.error("Failed to refresh startup skills snapshot:", startupError);

      const workspace = await loadWorkspaceCore();
      setInstalledSkills(workspace.skills);
      const resolvedSettings = await ensureDefaultOpenToolId(workspace.tools, workspace.settings);
      applyWorkspaceAncillaryData({
        candidates: workspace.candidates,
        tools: workspace.tools,
        toolSkills: workspace.toolSkills,
        account: workspace.account,
        settings: resolvedSettings,
      });
      void refreshGitStatesInBackground(undefined, {
        showRefreshing: false,
      });
    } finally {
      if (shouldBlockSkillList) {
        setIsLoading(false);
      }
    }
  }

  async function refreshGitStatesInBackground(
    shouldApply: () => boolean = () => true,
    options: { minimumIntervalMs?: number; showRefreshing?: boolean } = {},
  ) {
    const minimumIntervalMs = options.minimumIntervalMs ?? 0;
    const now = Date.now();
    if (
      minimumIntervalMs > 0
      && now - lastGitStateRefreshAtRef.current < minimumIntervalMs
    ) {
      const pendingRefresh = gitStateRefreshInFlightRef.current ?? Promise.resolve();
      if (options.showRefreshing && gitStateRefreshInFlightRef.current) {
        showRefreshIndicatorUntil(pendingRefresh);
      }
      return pendingRefresh;
    }
    if (gitStateRefreshInFlightRef.current) {
      if (options.showRefreshing) {
        showRefreshIndicatorUntil(gitStateRefreshInFlightRef.current);
      }
      return gitStateRefreshInFlightRef.current;
    }

    lastGitStateRefreshAtRef.current = now;
    const refreshMutationVersion = workspaceMutationVersionRef.current;
    let nextRefreshPromise: Promise<void> | null = null;
    nextRefreshPromise = (async () => {
      try {
        const skillsWithGitState = await fetchGitStates();
        if (!shouldApply() || refreshMutationVersion !== workspaceMutationVersionRef.current) {
          return;
        }
        setInstalledSkills(skillsWithGitState);
      } catch (error) {
        console.error("Failed to refresh git states:", error);
      } finally {
        lastGitStateRefreshAtRef.current = Date.now();
        if (gitStateRefreshInFlightRef.current === nextRefreshPromise) {
          gitStateRefreshInFlightRef.current = null;
        }
      }
    })();
    gitStateRefreshInFlightRef.current = nextRefreshPromise;
    if (options.showRefreshing) {
      showRefreshIndicatorUntil(nextRefreshPromise);
    }
    return nextRefreshPromise;
  }

  function showRefreshIndicatorUntil(refreshPromise: Promise<void>) {
    visibleGitStateRefreshInFlightRef.current = refreshPromise;
    setIsWorkspaceRefreshing(true);
    void refreshPromise.finally(() => {
      if (visibleGitStateRefreshInFlightRef.current !== refreshPromise) {
        return;
      }
      visibleGitStateRefreshInFlightRef.current = null;
      setIsWorkspaceRefreshing(false);
    });
  }

  const markSkillAsActive = useCallback((_skillName: string) => undefined, []);

  async function refreshSkillLocalGitStateInBackground(
    skillName: string,
    shouldApply: () => boolean = () => true,
  ) {
    if (localGitRefreshInFlightRef.current.has(skillName)) {
      return;
    }

    localGitRefreshInFlightRef.current.add(skillName);
    try {
      const updatedSkill = await refreshLocalGitState(skillName);
      if (!shouldApply()) {
        return;
      }
      setInstalledSkills((current) => mergeUpdatedSkillsPreservingOrder(current, [updatedSkill]));
    } catch (error) {
      console.error(`Failed to refresh local git state for skill ${skillName}:`, error);
    } finally {
      localGitRefreshInFlightRef.current.delete(skillName);
    }
  }

  useEffect(() => {
    if (usesFixtureData) {
      return;
    }

    let active = true;
    const hasStartupCache = startupCache !== null;

    async function loadStartupWorkspace() {
      if (!hasStartupCache) {
        setIsLoading(true);
      }

      await waitForNextPaint();

      try {
        await alignLocalWorkspaceState(() => active);
        if (!active) {
          return;
        }

        setIsLoading(false);
        void refreshGitStatesInBackground(() => active);
      } catch (error) {
        console.error("Failed to load startup workspace:", error);
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }

    const timer = window.setTimeout(() => {
      void loadStartupWorkspace();
    }, STARTUP_LOAD_DELAY_MS);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [startupCache, usesFixtureData]);

  useEffect(() => {
    if (usesFixtureData) {
      return;
    }

    let active = true;
    const refreshGitStatesIfNeeded = () => {
      void refreshGitStatesInBackground(
        () => active,
        { minimumIntervalMs: AUTO_GIT_STATE_REFRESH_COOLDOWN_MS },
      );
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      refreshGitStatesIfNeeded();
    };
    const intervalId = window.setInterval(
      refreshGitStatesIfNeeded,
      AUTO_GIT_STATE_REFRESH_INTERVAL_MS,
    );
    window.addEventListener("focus", refreshGitStatesIfNeeded);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshGitStatesIfNeeded);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [usesFixtureData]);

  useEffect(() => {
    if (usesFixtureData) {
      return;
    }

    let active = true;
    let unlisten: (() => void) | null = null;

    void subscribeSkillLibraryChanges(({ skillName }) => {
      if (!active) {
        return;
      }

      if (!startupWatchedSkillNamesRef.current.has(skillName)) {
        return;
      }

      const installedSkillExists = installedSkillsRef.current.some((skill) => skill.name === skillName);
      if (!installedSkillExists) {
        return;
      }

      const existingTimer = localGitRefreshDebounceTimersRef.current.get(skillName);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }

      const timer = window.setTimeout(() => {
        localGitRefreshDebounceTimersRef.current.delete(skillName);
        void refreshSkillLocalGitStateInBackground(skillName, () => active);
      }, SKILL_LIBRARY_CHANGE_DEBOUNCE_MS);
      localGitRefreshDebounceTimersRef.current.set(skillName, timer);
    }).then((cleanup) => {
      if (!active) {
        cleanup();
        return;
      }
      unlisten = cleanup;
    }).catch((error) => {
      console.error("Failed to subscribe to skill library changes:", error);
    });

    return () => {
      active = false;
      if (unlisten) {
        unlisten();
      }
      for (const timer of localGitRefreshDebounceTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      localGitRefreshDebounceTimersRef.current.clear();
    };
  }, [usesFixtureData]);

  async function handleInstallFromMarket(skill: MarketplaceSkill) {
    if (installingMarketplaceSkillIdsRef.current.has(skill.id)) {
      return;
    }

    installingMarketplaceSkillIdsRef.current.add(skill.id);
    setInstallingMarketplaceSkillIds(new Set(installingMarketplaceSkillIdsRef.current));
    try {
      const installedSkill = await installSkillFromMarket(skill);
      setInstalledSkills((current) => [installedSkill, ...current.filter((item) => item.name !== installedSkill.name)]);
    } finally {
      installingMarketplaceSkillIdsRef.current.delete(skill.id);
      setInstallingMarketplaceSkillIds(new Set(installingMarketplaceSkillIdsRef.current));
    }
  }

  async function loadMarketplacePage(
    sourceSite: MarketplaceSourceSite,
    page: number,
    append: boolean,
    options?: { refresh?: boolean },
  ) {
    if (marketplaceLoadingBySourceRef.current[sourceSite]) {
      return;
    }

    marketplaceLoadingBySourceRef.current = {
      ...marketplaceLoadingBySourceRef.current,
      [sourceSite]: true,
    };
    setIsMarketplaceLoadingBySource(marketplaceLoadingBySourceRef.current);
    try {
      const pageSkills = await fetchMarketplaceSkillsByPage({
        sourceSite,
        page,
        limit: MARKETPLACE_PAGE_SIZE,
        refresh: options?.refresh,
      });
      setMarketplaceSkills((current) => {
        const base = current.filter((item) => item.sourceSite !== sourceSite);
        const currentSourceSkills = current.filter((item) => item.sourceSite === sourceSite);
        const merged = append ? [...base, ...currentSourceSkills, ...pageSkills] : [...base, ...pageSkills];
        const deduped = new Map(merged.map((item) => [item.id, item]));
        return Array.from(deduped.values());
      });
      setMarketplacePageBySource((current) => ({
        ...current,
        [sourceSite]: page,
      }));
      const nextHasMoreBySource = {
        ...marketplaceHasMoreBySourceRef.current,
        [sourceSite]: pageSkills.length >= MARKETPLACE_PAGE_SIZE,
      };
      marketplaceHasMoreBySourceRef.current = nextHasMoreBySource;
      setHasMoreMarketplaceSkillsBySource(nextHasMoreBySource);
    } finally {
      marketplaceLoadingBySourceRef.current = {
        ...marketplaceLoadingBySourceRef.current,
        [sourceSite]: false,
      };
      setIsMarketplaceLoadingBySource(marketplaceLoadingBySourceRef.current);
    }
  }

  async function handleLoadInitialMarketplaceSkills(sourceSite: MarketplaceSourceSite) {
    await loadMarketplacePage(sourceSite, 1, false);

    // 安装源先用缓存兜底首屏，再后台刷新并写回缓存，避免空白页和长期陈旧数据。
    void loadMarketplacePage(sourceSite, 1, false, { refresh: true }).catch((error) => {
      console.error(`Failed to refresh ${sourceSite} marketplace skills:`, error);
    });
  }

  async function handleLoadMoreMarketplaceSkills(sourceSite: MarketplaceSourceSite) {
    if (!marketplaceHasMoreBySourceRef.current[sourceSite]) {
      return;
    }

    const nextPage = (marketplacePageBySource[sourceSite] ?? 0) + 1;
    await loadMarketplacePage(sourceSite, nextPage <= 1 ? 1 : nextPage, nextPage > 1);
  }

  async function handleSearchMarketplaceSkills(query: string) {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    setIsSearchLoading(true);
    try {
      const searchResults = await Promise.allSettled(
        MARKETPLACE_SOURCE_SITES.map((sourceSite) =>
          fetchMarketplaceSkillsByPage({
            sourceSite,
            page: 1,
            limit: MARKETPLACE_PAGE_SIZE * 3,
            query: normalizedQuery,
          })
        ),
      );
      const fulfilledResults = searchResults.flatMap((result) =>
        result.status === "fulfilled" ? result.value : []
      );
      if (fulfilledResults.length === 0 && searchResults.some((result) => result.status === "rejected")) {
        throw new BusinessError(getMarketplaceSearchFailedMessage(language));
      }

      const mergedSkills = dedupeMarketplaceSkills(fulfilledResults);
      return sortMarketplaceSkillsByPopularity(mergedSkills);
    } finally {
      setIsSearchLoading(false);
    }
  }

  async function handleDiscoverRepoSkills(repoUrl: string, gitRef?: string) {
    return installSkillFromRepo({ repoUrl, gitRef });
  }

  async function handleInstallFromRepo(repoUrl: string, selectedPaths: string[], gitRef?: string) {
    const installed = await installSelectedRepoSkills({ repoUrl, selectedPaths, gitRef });
    setInstalledSkills((current) => {
      const merged = [...current];
      for (const installedSkill of installed.reverse()) {
        const next = [installedSkill, ...merged.filter((item) => item.name !== installedSkill.name)];
        merged.splice(0, merged.length, ...next);
      }
      return merged;
    });
  }

  async function handleInstallFromLocalPath(localPath: string, skillName?: string) {
    const installedSkill = await installLocalSkill({ localPath, skillName });
    setInstalledSkills((current) => [installedSkill, ...current.filter((item) => item.name !== installedSkill.name)]);
    setLocalCandidates((current) =>
      current.filter((candidate) => candidate.localPath !== localPath && candidate.localPath !== installedSkill.localPath),
    );
  }

  async function handleInstallSelectedLocalSkills(localPath: string, selectedPaths: string[]) {
    const installed = await installSelectedLocalSkills({ localPath, selectedPaths });
    setInstalledSkills((current) => {
      const merged = [...current];
      for (const installedSkill of installed.reverse()) {
        const next = [installedSkill, ...merged.filter((item) => item.name !== installedSkill.name)];
        merged.splice(0, merged.length, ...next);
      }
      return merged;
    });
    setLocalCandidates((current) =>
      current.filter(
        (candidate) =>
          !installed.some(
            (installedSkill) =>
              candidate.localPath === installedSkill.localPath || candidate.name === installedSkill.name,
          ),
      ),
    );
  }

  async function handleImportCandidate(localPath: string) {
    const importedSkill = await importLocalSkill(localPath);
    setInstalledSkills((current) => [importedSkill, ...current.filter((item) => item.name !== importedSkill.name)]);
    setLocalCandidates((current) => removeImportedCandidate(current, importedSkill));
    setToolSkillEntries((current) => current.map((entry) => (
      entry.localPath === localPath
        ? {
            ...entry,
            name: importedSkill.name,
            description: importedSkill.description,
            resolvedPath: importedSkill.localPath,
            managementStatus: "managed",
          }
        : entry
    )));
  }

  async function handleRefreshLocalCandidates() {
    const candidates = await fetchLocalSkillCandidates();
    setLocalCandidates(candidates);
  }

  async function handleUpdateSkill(skillName: string) {
    workspaceMutationVersionRef.current += 1;
    try {
      const updatedSkill = await updateSkill({ skillName });
      markSkillAsActive(skillName);
      setInstalledSkills((current) => [updatedSkill, ...current.filter((item) => item.name !== updatedSkill.name)]);
    } finally {
      workspaceMutationVersionRef.current += 1;
    }
  }

  async function handleRefreshSkillLocalGitState(skillName: string) {
    markSkillAsActive(skillName);
    const updatedSkill = await refreshLocalGitState(skillName);
    setInstalledSkills((current) => mergeUpdatedSkillsPreservingOrder(current, [updatedSkill]));
  }

  async function handleRevertSkillChange(input: {
    skillName: string;
    relativePath: string;
    hunkIndex?: number;
    expectedPatch?: string;
    staged?: boolean;
  }) {
    const updatedSkill = await revertSkillChangeRequest(input);
    setInstalledSkills((current) => mergeUpdatedSkillsPreservingOrder(current, [updatedSkill]));
    return updatedSkill;
  }

  async function handleUpdateAllSkills() {
    if (updateAllSkillsInFlightRef.current) {
      return updateAllSkillsInFlightRef.current;
    }

    const updatableSkills = installedSkills.filter((skill) => skill.collabStatus === "update-available");
    let updatePromise: Promise<void> | null = null;
    workspaceMutationVersionRef.current += 1;
    updatePromise = (async () => {
      setIsUpdatingAllSkills(true);
      try {
        if (updatableSkills.length === 0) {
          await loadWorkspaceSnapshot();
          return;
        }

        const updateResults = await Promise.allSettled(
          updatableSkills.map((skill) => updateSkill({ skillName: skill.name })),
        );
        const updatedSkills = updateResults.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
        const updatedSkillMap = new Map(updatedSkills.map((skill) => [skill.name, skill]));
        setInstalledSkills((current) =>
          current.map((skill) => updatedSkillMap.get(skill.name) ?? skill),
        );

        const failedUpdates = updateResults
          .map((result, index) => ({
            result,
            skillName: updatableSkills[index].name,
          }))
          .filter((item) => item.result.status === "rejected");
        if (failedUpdates.length > 0) {
          const failedSkillNames = failedUpdates.map((item) => item.skillName).join("、");
          throw new BusinessError(getPartialSkillUpdateFailedMessage({
            language,
            updated: updatedSkills.length,
            failed: failedUpdates.length,
            names: failedSkillNames,
          }));
        }
      } finally {
        workspaceMutationVersionRef.current += 1;
        if (updateAllSkillsInFlightRef.current === updatePromise) {
          updateAllSkillsInFlightRef.current = null;
          setIsUpdatingAllSkills(false);
        }
      }
    })();
    updateAllSkillsInFlightRef.current = updatePromise;
    return updatePromise;
  }

  async function handleDeleteSkill(skillName: string) {
    await deleteSkill(skillName);
    setInstalledSkills((current) => current.filter((skill) => skill.name !== skillName));
  }

  async function handleDeleteToolSkill(input: { toolId: string; skillName: string }) {
    await deleteToolSkill(input);
    setToolSkillEntries((current) => current.filter((entry) => (
      entry.toolId !== input.toolId || entry.name !== input.skillName
    )));
  }

  async function handleToggleSkillTool(input: { skillName: string; toolName: string; toolNames: string[] }) {
    let previousSkill: SkillSummary | null = null;
    setInstalledSkills((current) => current.map((skill) => {
      if (skill.name !== input.skillName) {
        return skill;
      }

      previousSkill = skill;
      const matchedTool = skill.tools.find((tool) => tool.name === input.toolName);
      const nextEnabled = matchedTool ? !isToolEnabledStatus(matchedTool.statusLabel) : true;
      return patchSkillToolStatus(
        skill,
        input.toolName,
        getToolStatusLabel(nextEnabled ? "enabled" : "disabled", appSettings.language),
      );
    }));

    try {
      const updatedSkill = await toggleSkillTool(input);
      setInstalledSkills((current) => mergeUpdatedSkillsPreservingOrder(current, [updatedSkill]));
    } catch (error) {
      if (previousSkill) {
        const rollbackSkill = previousSkill;
        setInstalledSkills((current) => mergeUpdatedSkillsPreservingOrder(current, [rollbackSkill]));
      }
      throw error;
    }
  }

  async function handleSetToolSkillStatuses(input: {
    toolName: string;
    skillNames: string[];
    enabled: boolean;
    toolNames: string[];
  }) {
    const targetSkillNames = new Set(input.skillNames);
    let previousSkills: SkillSummary[] = [];
    setInstalledSkills((current) => {
      previousSkills = current.filter((skill) => targetSkillNames.has(skill.name));
      return current.map((skill) => (
        targetSkillNames.has(skill.name)
          ? patchSkillToolStatus(
              skill,
              input.toolName,
              getToolStatusLabel(input.enabled ? "enabled" : "disabled", appSettings.language),
            )
          : skill
      ));
    });

    try {
      const updatedSkills = await setToolSkillStatuses(input);
      if (updatedSkills.length === 0) {
        return;
      }

      setInstalledSkills((current) => mergeUpdatedSkillsPreservingOrder(current, updatedSkills));
    } catch (error) {
      setInstalledSkills((current) => mergeUpdatedSkillsPreservingOrder(current, previousSkills));
      throw error;
    }
  }

  async function handleSetSkillAllToolStatuses(input: {
    skillName: string;
    enabled: boolean;
    toolNames: string[];
  }) {
    let previousSkill: SkillSummary | null = null;
    setInstalledSkills((current) => current.map((skill) => {
      if (skill.name !== input.skillName) {
        return skill;
      }

      previousSkill = skill;
      return patchAllSkillToolStatuses(
        skill,
        getToolStatusLabel(input.enabled ? "enabled" : "disabled", appSettings.language),
      );
    }));

    try {
      const updatedSkill = await setSkillAllToolStatuses(input);
      setInstalledSkills((current) => mergeUpdatedSkillsPreservingOrder(current, [updatedSkill]));
    } catch (error) {
      if (previousSkill) {
        const rollbackSkill = previousSkill;
        setInstalledSkills((current) => mergeUpdatedSkillsPreservingOrder(current, [rollbackSkill]));
      }
      throw error;
    }
  }

  async function handleOpenSkillWithDefaultTool(skillName: string) {
    markSkillAsActive(skillName);
    const availableTools = buildOpenToolOptions(toolConfigs, appSettings.language);
    const availableToolIds = new Set(availableTools.map((tool) => tool.id));
    const resolvedOpenToolId = availableToolIds.has(defaultOpenToolId)
      ? defaultOpenToolId
      : availableTools[0]?.id ?? FALLBACK_OPEN_TOOL_ID;

    await openSkillInEditor({
      skillName,
      editorId: resolvedOpenToolId,
    });
  }

  async function handleSetSkillInstallActivation(mode: InstallActivationMode) {
    await persistAppSettings({
      ...appSettings,
      skillInstallActivation: mode,
    });
  }

  async function handleSetMcpInstallActivation(mode: InstallActivationMode) {
    await persistAppSettings({
      ...appSettings,
      mcpInstallActivation: mode,
    });
  }

  async function handleSetSkillSourceViewStyle(style: SkillSourceViewStyle) {
    await persistAppSettings({
      ...appSettings,
      skillSourceViewStyle: style,
    });
  }

  async function handleOpenPathInFinder(path: string) {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return;
    }

    await openPathInFinder({ path: normalizedPath });
  }

  const handleAlignLocalWorkspaceState = useCallback(
    () => alignLocalWorkspaceState(),
    [],
  );

  const value = useMemo<SkillWorkspaceContextValue>(
    () => ({
      installedSkills,
      marketplaceSkills,
      localCandidates,
      toolConfigs,
      toolSkillEntries,
      gitAccount,
      isLoading,
      isWorkspaceRefreshing,
      isUpdatingAllSkills,
      isMarketplaceLoadingBySource,
      isSearchLoading,
      installingMarketplaceSkillIds,
      hasMoreMarketplaceSkillsBySource,
      installFromMarket: handleInstallFromMarket,
      loadInitialMarketplaceSkills: handleLoadInitialMarketplaceSkills,
      loadMoreMarketplaceSkills: handleLoadMoreMarketplaceSkills,
      searchMarketplaceSkills: handleSearchMarketplaceSkills,
      discoverRepoSkills: handleDiscoverRepoSkills,
      installFromRepo: handleInstallFromRepo,
      discoverLocalInstallSkills,
      installFromLocalPath: handleInstallFromLocalPath,
      installSelectedLocalSkills: handleInstallSelectedLocalSkills,
      importCandidate: handleImportCandidate,
      refreshLocalCandidates: handleRefreshLocalCandidates,
      alignLocalWorkspaceState: handleAlignLocalWorkspaceState,
      refreshWorkspace: loadWorkspaceSnapshot,
      refreshToolSkillEntries,
      updateSkill: handleUpdateSkill,
      updateAllSkills: handleUpdateAllSkills,
      deleteSkill: handleDeleteSkill,
      deleteToolSkill: handleDeleteToolSkill,
      markSkillAsActive,
      loadSkillFileBrowser: fetchSkillFileBrowser,
      loadSkillFileContent: fetchSkillFileContent,
      loadToolSkillFileBrowser: fetchToolSkillFileBrowser,
      loadToolSkillFileContent: fetchToolSkillFileContent,
      saveSkillFileContent,
      refreshSkillLocalGitState: handleRefreshSkillLocalGitState,
      toggleSkillTool: handleToggleSkillTool,
      setToolSkillStatuses: handleSetToolSkillStatuses,
      setSkillAllToolStatuses: handleSetSkillAllToolStatuses,
      loadPushPreview: fetchPushPreviewSnapshot,
      loadSkillLocalChanges: fetchSkillLocalChanges,
      loadSkillUpdatePreview: fetchSkillUpdatePreview,
      revertSkillChange: handleRevertSkillChange,
      loadPushTargets: fetchPushTargetSnapshot,
      openSkillRepository,
      openSkillInEditor,
      defaultOpenToolId,
      setDefaultOpenToolId: handleSetDefaultOpenToolId,
      appSettings,
      language,
      setLanguage: handleSetLanguage,
      setTheme: handleSetTheme,
      setSkillInstallActivation: handleSetSkillInstallActivation,
      setMcpInstallActivation: handleSetMcpInstallActivation,
      setSkillSourceViewStyle: handleSetSkillSourceViewStyle,
      openSkillWithDefaultTool: handleOpenSkillWithDefaultTool,
      openPathInFinder: handleOpenPathInFinder,
    }),
    [
      appSettings,
      language,
      defaultOpenToolId,
      gitAccount,
      hasMoreMarketplaceSkillsBySource,
      handleAlignLocalWorkspaceState,
      installedSkills,
      installingMarketplaceSkillIds,
      isLoading,
      isWorkspaceRefreshing,
      isUpdatingAllSkills,
      isMarketplaceLoadingBySource,
      isSearchLoading,
      localCandidates,
      marketplacePageBySource,
      marketplaceSkills,
      refreshToolSkillEntries,
      toolConfigs,
      toolSkillEntries,
      handleSetSkillAllToolStatuses,
      handleSetToolSkillStatuses,
    ],
  );

  return <SkillWorkspaceContext.Provider value={value}>{children}</SkillWorkspaceContext.Provider>;
}

export function useSkillWorkspace() {
  const context = useContext(SkillWorkspaceContext);
  if (!context) {
    throw new Error("useSkillWorkspace must be used inside SkillWorkspaceProvider");
  }

  return context;
}
