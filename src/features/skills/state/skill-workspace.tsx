import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  fetchAppSettings,
  deleteSkill,
  fetchGitAccount,
  fetchGitStates,
  fetchInstalledSkills,
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
  installSkillFromMarket,
  installSkillFromRepo,
  installSelectedRepoSkills,
  openSkillInEditor,
  openSkillRepository,
  saveSkillFileContent,
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
  AppSettings,
  GitAccountSummary,
  InstallActivationMode,
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
} from "@/features/skills/state/skill-store";
import { buildOpenToolOptions } from "@/features/skills/utils/open-tools";

const STARTUP_WORKSPACE_CACHE_KEY = "skillm.startupWorkspaceCache";
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
  installFromLocalPath: (localPath: string, skillName?: string) => Promise<void>;
  importCandidate: (localPath: string) => Promise<void>;
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
  toggleSkillTool: (input: { skillName: string; toolName: string }) => Promise<void>;
  setToolSkillStatuses: (input: {
    toolName: string;
    skillNames: string[];
    enabled: boolean;
  }) => Promise<void>;
  loadPushPreview: (input: {
    skillName: string;
    targetBranch: string;
    createBranchName?: string;
  }) => Promise<PushPreviewSnapshot>;
  loadPushTargets: (skillName: string) => Promise<PushTargetSnapshot>;
  openSkillRepository: (skillName: string) => Promise<void>;
  openSkillInEditor: (input: { skillName: string; editorId: string }) => Promise<void>;
  defaultOpenToolId: string;
  setDefaultOpenToolId: (toolId: string) => Promise<void>;
  appSettings: AppSettings;
  setSkillInstallActivation: (mode: InstallActivationMode) => Promise<void>;
  setMcpInstallActivation: (mode: InstallActivationMode) => Promise<void>;
  openSkillWithDefaultTool: (skillName: string) => Promise<void>;
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

function removeImportedCandidate(
  candidates: LocalSkillCandidate[],
  importedSkill: SkillSummary,
) {
  return candidates.filter((candidate) => candidate.localPath !== importedSkill.localPath);
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

  useEffect(() => {
    if (toolConfigs.length === 0) {
      return;
    }

    const availableTools = buildOpenToolOptions(toolConfigs);
    const availableToolIds = new Set(availableTools.map((tool) => tool.id));
    if (availableToolIds.has(defaultOpenToolId)) {
      return;
    }

    void handleSetDefaultOpenToolId(availableTools[0]?.id ?? FALLBACK_OPEN_TOOL_ID);
  }, [defaultOpenToolId, toolConfigs]);

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
    setAppSettings(savedSettings);
    return savedSettings;
  }

  async function handleSetDefaultOpenToolId(toolId: string) {
    const nextSettings = {
      ...appSettings,
      defaultOpenToolId: toolId,
    };
    await persistAppSettings(nextSettings);
  }

  async function loadWorkspaceCore() {
    const [skills, candidates, tools, account, settings] = await Promise.all([
      fetchInstalledSkills(),
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
    setIsLoading(true);
    try {
      const workspace = await loadWorkspaceCore();
      setInstalledSkills(workspace.skills);
      setLocalCandidates(workspace.candidates);
      setToolConfigs(workspace.tools);
      setGitAccount(workspace.account);
      setAppSettings(workspace.settings);
      void refreshGitStatesInBackground();
    } finally {
      setIsLoading(false);
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

        const [candidatesResult, toolsResult, accountResult, settingsResult] = await Promise.allSettled([
          fetchLocalSkillCandidates(),
          fetchToolConfigs(),
          fetchGitAccount(),
          fetchAppSettings(),
        ]);
        if (!active) {
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
          setAppSettings(settingsResult.value);
        } else {
          console.error("Failed to load app settings:", settingsResult.reason);
        }
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
    if (sourceSite !== "skills.sh") {
      return;
    }

    // skills.sh 先用缓存兜底首屏，再后台刷新并写回缓存，避免空白页和长期陈旧数据。
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
        throw new Error("搜索安装源失败");
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

  async function handleImportCandidate(localPath: string) {
    const importedSkill = await importLocalSkill(localPath);
    setInstalledSkills((current) => [importedSkill, ...current.filter((item) => item.name !== importedSkill.name)]);
    setLocalCandidates((current) => removeImportedCandidate(current, importedSkill));
  }

  async function handleUpdateSkill(skillName: string) {
    const updatedSkill = await updateSkill({ skillName });
    setInstalledSkills((current) => [updatedSkill, ...current.filter((item) => item.name !== updatedSkill.name)]);
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
      throw new Error(`已更新 ${updatedSkills.length} 个 skill，${failedUpdates.length} 个更新失败：${failedSkillNames}`);
    }
  }

  async function handleDeleteSkill(skillName: string) {
    await deleteSkill(skillName);
    setInstalledSkills((current) => current.filter((skill) => skill.name !== skillName));
  }

  async function handleToggleSkillTool(input: { skillName: string; toolName: string }) {
    const updatedSkill = await toggleSkillTool(input);
    setInstalledSkills((current) => [updatedSkill, ...current.filter((item) => item.name !== updatedSkill.name)]);
  }

  async function handleSetToolSkillStatuses(input: {
    toolName: string;
    skillNames: string[];
    enabled: boolean;
  }) {
    const updatedSkills = await setToolSkillStatuses(input);
    if (updatedSkills.length === 0) {
      return;
    }

    const updatedNames = new Set(updatedSkills.map((skill) => skill.name));
    setInstalledSkills((current) => [
      ...updatedSkills,
      ...current.filter((skill) => !updatedNames.has(skill.name)),
    ]);
  }

  async function handleOpenSkillWithDefaultTool(skillName: string) {
    const availableTools = buildOpenToolOptions(toolConfigs);
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
      installFromLocalPath: handleInstallFromLocalPath,
      importCandidate: handleImportCandidate,
      refreshWorkspace: loadWorkspaceSnapshot,
      updateSkill: handleUpdateSkill,
      updateAllSkills: handleUpdateAllSkills,
      deleteSkill: handleDeleteSkill,
      loadSkillFileBrowser: fetchSkillFileBrowser,
      loadSkillFileContent: fetchSkillFileContent,
      saveSkillFileContent,
      toggleSkillTool: handleToggleSkillTool,
      setToolSkillStatuses: handleSetToolSkillStatuses,
      loadPushPreview: fetchPushPreviewSnapshot,
      loadPushTargets: fetchPushTargetSnapshot,
      openSkillRepository,
      openSkillInEditor,
      defaultOpenToolId,
      setDefaultOpenToolId: handleSetDefaultOpenToolId,
      appSettings,
      setSkillInstallActivation: handleSetSkillInstallActivation,
      setMcpInstallActivation: handleSetMcpInstallActivation,
      openSkillWithDefaultTool: handleOpenSkillWithDefaultTool,
    }),
    [
      appSettings,
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
