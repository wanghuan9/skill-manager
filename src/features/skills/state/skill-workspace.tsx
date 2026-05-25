import {
  createContext,
  useContext,
  useEffect,
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
  discoverLocalInstallSkills,
  fetchGitAccount,
  fetchGitStates,
  fetchLocalSkillCandidates,
  fetchMarketplaceSkillsByPage,
  fetchSkillFileBrowser,
  fetchSkillFileContent,
  fetchPushPreviewSnapshot,
  fetchPushTargetSnapshot,
  fetchToolConfigs,
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
  pushSkillToCurrentBranch,
  saveSkillFileContent,
  setSkillAllToolStatuses,
  setToolSkillStatuses,
  shouldUseFixtureData,
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
  GitAccountSummary,
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
  ToolConfig,
} from "@/features/skills/state/skill-store";
import { buildOpenToolOptions, resolveDefaultOpenToolId } from "@/features/skills/utils/open-tools";
import {
  localizeGitAccountSummary,
  localizeSkillSummaries,
  localizeToolConfigs,
} from "@/features/skills/utils/skill-localization";
import { getToolStatusLabel, isToolEnabledStatus } from "@/features/skills/utils/tool-status";

const STARTUP_WORKSPACE_CACHE_KEY = "skilldock.startupWorkspaceCache";
const APP_LANGUAGE_STORAGE_KEY = "skilldock.settings.language";
const FALLBACK_OPEN_TOOL_ID = "finder";
const MARKETPLACE_PAGE_SIZE = 18;
const MARKETPLACE_SOURCE_SITES: MarketplaceSourceSite[] = ["skills.sh", "skillsmp"];
const STARTUP_LOAD_DELAY_MS = 0;
const STARTUP_CACHED_COLLAB_STATUSES = new Set<SkillSummary["collabStatus"]>([
  "update-available",
  "pending-push",
  "diverged",
]);

type SkillWorkspaceContextValue = {
  installedSkills: SkillSummary[];
  marketplaceSkills: MarketplaceSkill[];
  localCandidates: LocalSkillCandidate[];
  toolConfigs: ToolConfig[];
  gitAccount: GitAccountSummary | null;
  isLoading: boolean;
  isMarketplaceLoadingBySource: Record<MarketplaceSourceSite, boolean>;
  isSearchLoading: boolean;
  installingMarketplaceSkillIds: Set<string>;
  hasMoreMarketplaceSkillsBySource: Record<MarketplaceSourceSite, boolean>;
  installFromMarket: (skill: MarketplaceSkill) => Promise<void>;
  loadInitialMarketplaceSkills: (sourceSite: MarketplaceSourceSite) => Promise<void>;
  loadMoreMarketplaceSkills: (sourceSite: MarketplaceSourceSite) => Promise<void>;
  searchMarketplaceSkills: (query: string) => Promise<MarketplaceSkill[]>;
  discoverRepoSkills: (repoUrl: string) => Promise<RepoSkillCandidate[]>;
  installFromRepo: (repoUrl: string, selectedPaths: string[]) => Promise<void>;
  discoverLocalInstallSkills: (localPath: string) => Promise<LocalInstallSkillCandidate[]>;
  installFromLocalPath: (localPath: string, skillName?: string) => Promise<void>;
  installSelectedLocalSkills: (localPath: string, selectedPaths: string[]) => Promise<void>;
  importCandidate: (localPath: string) => Promise<void>;
  refreshLocalCandidates: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
  updateSkill: (skillName: string) => Promise<void>;
  updateAllSkills: () => Promise<void>;
  deleteSkill: (skillName: string) => Promise<void>;
  loadSkillFileBrowser: (skillName: string) => Promise<SkillFileBrowserSnapshot>;
  loadSkillFileContent: (input: {
    skillName: string;
    relativePath: string;
  }) => Promise<SkillFileDocument>;
  saveSkillFileContent: (input: {
    skillName: string;
    relativePath: string;
    content: string;
  }) => Promise<SkillFileDocument>;
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
  loadPushTargets: (skillName: string) => Promise<PushTargetSnapshot>;
  pushSkillToCurrentBranch: (skillName: string) => Promise<void>;
  openSkillRepository: (skillName: string) => Promise<void>;
  openSkillInEditor: (input: { skillName: string; editorId: string }) => Promise<void>;
  defaultOpenToolId: string;
  setDefaultOpenToolId: (toolId: string) => Promise<void>;
  appSettings: AppSettings;
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => Promise<void>;
  setSkillInstallActivation: (mode: InstallActivationMode) => Promise<void>;
  setMcpInstallActivation: (mode: InstallActivationMode) => Promise<void>;
  openSkillWithDefaultTool: (skillName: string) => Promise<void>;
  openPathInFinder: (path: string) => Promise<void>;
};

const SkillWorkspaceContext = createContext<SkillWorkspaceContextValue | null>(null);

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
  const updatedByName = new Map(updatedSkills.map((skill) => [skill.name, skill]));
  const mergedSkills = currentSkills.map((skill) => updatedByName.get(skill.name) ?? skill);
  const currentSkillNames = new Set(currentSkills.map((skill) => skill.name));
  const newSkills = updatedSkills.filter((skill) => !currentSkillNames.has(skill.name));

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
    candidate.localPath !== importedSkill.localPath && candidate.name !== importedSkill.name
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
      !STARTUP_CACHED_COLLAB_STATUSES.has(cachedSkill.collabStatus)
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
          mcpInstallActivation: "disable-all-tools",
          language: "zh-CN",
          languageSource: "auto",
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
  const defaultOpenToolId = appSettings.defaultOpenToolId;
  const language = appSettings.language;

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
    }
    setAppSettings(savedSettings);
    return savedSettings;
  }

  async function ensureDefaultOpenToolId(nextToolConfigs: ToolConfig[], nextSettings: AppSettings) {
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

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, language);
    }
    setInstalledSkills((current) => localizeSkillSummaries(current, language));
    setToolConfigs((current) => localizeToolConfigs(current, language));
    setGitAccount((current) => localizeGitAccountSummary(current, language));
  }, [language]);

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
    account?: GitAccountSummary | null;
    settings?: AppSettings;
  }) {
    if (input.candidates) {
      setLocalCandidates(input.candidates);
    }
    if (input.tools) {
      setToolConfigs(input.tools);
    }
    if (input.account) {
      setGitAccount(input.account);
    }
    if (input.settings) {
      setAppSettings(input.settings);
    }
  }

  async function refreshWorkspaceAncillaryData(shouldApply: () => boolean = () => true) {
    const [candidatesResult, toolsResult, accountResult, settingsResult] = await Promise.allSettled([
      fetchLocalSkillCandidates(),
      fetchToolConfigs(),
      fetchGitAccount(),
      fetchAppSettings(),
    ]);

    if (!shouldApply()) {
      return;
    }

    if (candidatesResult.status === "fulfilled") {
      setLocalCandidates(candidatesResult.value);
    } else {
      console.error("Failed to load local skill candidates:", candidatesResult.reason);
    }

    if (toolsResult.status === "fulfilled") {
      setToolConfigs(toolsResult.value);
    } else {
      console.error("Failed to load tool configs:", toolsResult.reason);
    }

    if (accountResult.status === "fulfilled") {
      setGitAccount(accountResult.value);
    } else {
      console.error("Failed to load git account:", accountResult.reason);
    }

    if (settingsResult.status === "fulfilled") {
      const nextSettings = settingsResult.value;
      if (nextSettings.defaultOpenToolId.trim().length === 0 && toolsResult.status === "fulfilled") {
        const resolvedSettings = await ensureDefaultOpenToolId(toolsResult.value, nextSettings);
        setAppSettings(resolvedSettings);
        return;
      }

      setAppSettings(nextSettings);
    } else {
      console.error("Failed to load app settings:", settingsResult.reason);
    }
  }

  async function loadWorkspaceCore() {
    const [skills, candidates, tools, account, settings] = await Promise.all([
      fetchStartupInstalledSkills(),
      fetchLocalSkillCandidates(),
      fetchToolConfigs(),
      fetchGitAccount(),
      fetchAppSettings(),
    ]);

    return {
      skills,
      candidates,
      tools,
      account,
      settings,
    };
  }

  async function loadWorkspaceSnapshot() {
    const shouldBlockSkillList = installedSkills.length === 0;
    if (shouldBlockSkillList) {
      setIsLoading(true);
    }
    try {
      const skills = await fetchStartupInstalledSkills();
      setInstalledSkills(skills);
      if (shouldBlockSkillList) {
        setIsLoading(false);
      }
      void refreshGitStatesInBackground();
      void refreshWorkspaceAncillaryData();
      return;
    } catch (startupError) {
      console.error("Failed to refresh startup skills snapshot:", startupError);

      const workspace = await loadWorkspaceCore();
      setInstalledSkills(workspace.skills);
      await ensureDefaultOpenToolId(workspace.tools, workspace.settings);
      applyWorkspaceAncillaryData({
        candidates: workspace.candidates,
        tools: workspace.tools,
        account: workspace.account,
        settings: workspace.settings,
      });
      void refreshGitStatesInBackground();
    } finally {
      if (shouldBlockSkillList) {
        setIsLoading(false);
      }
    }
  }

  async function refreshGitStatesInBackground(shouldApply: () => boolean = () => true) {
    try {
      const skillsWithGitState = await fetchGitStates();
      if (!shouldApply()) {
        return;
      }
      setInstalledSkills(skillsWithGitState);
    } catch (error) {
      console.error("Failed to refresh git states:", error);
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
        const skills = await fetchStartupInstalledSkills();
        if (!active) {
          return;
        }

        const cachedSkills = startupCache?.installedSkills ?? [];
        const skillsWithCachedStatus = mergeStartupSkillStatusCache(skills, cachedSkills);
        setInstalledSkills(skillsWithCachedStatus);
        setIsLoading(false);
        void refreshGitStatesInBackground(() => active);
        await refreshWorkspaceAncillaryData(() => active);
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

  async function handleDiscoverRepoSkills(repoUrl: string) {
    return installSkillFromRepo({ repoUrl });
  }

  async function handleInstallFromRepo(repoUrl: string, selectedPaths: string[]) {
    const installed = await installSelectedRepoSkills({ repoUrl, selectedPaths });
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
  }

  async function handleRefreshLocalCandidates() {
    const candidates = await fetchLocalSkillCandidates();
    setLocalCandidates(candidates);
  }

  async function handleUpdateSkill(skillName: string) {
    const updatedSkill = await updateSkill({ skillName });
    setInstalledSkills((current) => [updatedSkill, ...current.filter((item) => item.name !== updatedSkill.name)]);
  }

  async function handlePushSkillToCurrentBranch(skillName: string) {
    const updatedSkill = await pushSkillToCurrentBranch(skillName);
    setInstalledSkills((current) => mergeUpdatedSkillsPreservingOrder(current, [updatedSkill]));
  }

  async function handleUpdateAllSkills() {
    const updatableSkills = installedSkills.filter((skill) => skill.collabStatus === "update-available");
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
  }

  async function handleDeleteSkill(skillName: string) {
    await deleteSkill(skillName);
    setInstalledSkills((current) => current.filter((skill) => skill.name !== skillName));
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

  async function handleOpenPathInFinder(path: string) {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return;
    }

    await openPathInFinder({ path: normalizedPath });
  }

  const value = useMemo<SkillWorkspaceContextValue>(
    () => ({
      installedSkills,
      marketplaceSkills,
      localCandidates,
      toolConfigs,
      gitAccount,
      isLoading,
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
      refreshWorkspace: loadWorkspaceSnapshot,
      updateSkill: handleUpdateSkill,
      updateAllSkills: handleUpdateAllSkills,
      deleteSkill: handleDeleteSkill,
      loadSkillFileBrowser: fetchSkillFileBrowser,
      loadSkillFileContent: fetchSkillFileContent,
      saveSkillFileContent,
      toggleSkillTool: handleToggleSkillTool,
      setToolSkillStatuses: handleSetToolSkillStatuses,
      setSkillAllToolStatuses: handleSetSkillAllToolStatuses,
      loadPushPreview: fetchPushPreviewSnapshot,
      loadPushTargets: fetchPushTargetSnapshot,
      pushSkillToCurrentBranch: handlePushSkillToCurrentBranch,
      openSkillRepository,
      openSkillInEditor,
      defaultOpenToolId,
      setDefaultOpenToolId: handleSetDefaultOpenToolId,
      appSettings,
      language,
      setLanguage: handleSetLanguage,
      setSkillInstallActivation: handleSetSkillInstallActivation,
      setMcpInstallActivation: handleSetMcpInstallActivation,
      openSkillWithDefaultTool: handleOpenSkillWithDefaultTool,
      openPathInFinder: handleOpenPathInFinder,
    }),
    [
      appSettings,
      language,
      defaultOpenToolId,
      gitAccount,
      hasMoreMarketplaceSkillsBySource,
      installedSkills,
      installingMarketplaceSkillIds,
      isLoading,
      isMarketplaceLoadingBySource,
      isSearchLoading,
      localCandidates,
      marketplacePageBySource,
      marketplaceSkills,
      toolConfigs,
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
