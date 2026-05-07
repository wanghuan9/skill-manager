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
  importLocalSkill,
  installSkillFromMarket,
  installSkillFromRepo,
  installSelectedRepoSkills,
  openSkillInEditor,
  openSkillRepository,
  saveSkillFileContent,
  shouldUseFixtureData,
  toggleSkillTool,
  updateSkill,
} from "@/features/skills/api/skill-client";
import { workspaceSnapshotFixture } from "@/features/skills/state/skill-fixtures";
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
} from "@/features/skills/state/skill-store";
import { buildOpenToolOptions } from "@/features/skills/utils/open-tools";

const DEFAULT_OPEN_TOOL_STORAGE_KEY = "skillm.defaultOpenToolId";
const FALLBACK_OPEN_TOOL_ID = "finder";
const MARKETPLACE_PAGE_SIZE = 18;

type SkillWorkspaceContextValue = {
  installedSkills: SkillSummary[];
  marketplaceSkills: MarketplaceSkill[];
  localCandidates: LocalSkillCandidate[];
  toolConfigs: ToolConfig[];
  gitAccount: GitAccountSummary | null;
  isLoading: boolean;
  isMarketplaceLoading: boolean;
  isSearchLoading: boolean;
  installingMarketplaceSkillIds: Set<string>;
  hasMoreMarketplaceSkills: boolean;
  installFromMarket: (skill: MarketplaceSkill) => Promise<void>;
  loadInitialMarketplaceSkills: (sourceSite: MarketplaceSourceSite) => Promise<void>;
  loadMoreMarketplaceSkills: (sourceSite: MarketplaceSourceSite) => Promise<void>;
  searchMarketplaceSkills: (query: string) => Promise<MarketplaceSkill[]>;
  discoverRepoSkills: (repoUrl: string) => Promise<RepoSkillCandidate[]>;
  installFromRepo: (repoUrl: string, selectedPaths: string[]) => Promise<void>;
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
  loadPushPreview: (input: {
    skillName: string;
    targetBranch: string;
    createBranchName?: string;
  }) => Promise<PushPreviewSnapshot>;
  loadPushTargets: (skillName: string) => Promise<PushTargetSnapshot>;
  openSkillRepository: (skillName: string) => Promise<void>;
  openSkillInEditor: (input: { skillName: string; editorId: string }) => Promise<void>;
  defaultOpenToolId: string;
  setDefaultOpenToolId: (toolId: string) => void;
  openSkillWithDefaultTool: (skillName: string) => Promise<void>;
};

const SkillWorkspaceContext = createContext<SkillWorkspaceContextValue | null>(null);

type SkillWorkspaceProviderProps = {
  children: ReactNode;
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

function getInitialDefaultOpenToolId() {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.getItem !== "function"
  ) {
    return FALLBACK_OPEN_TOOL_ID;
  }

  return window.localStorage.getItem(DEFAULT_OPEN_TOOL_STORAGE_KEY) ?? FALLBACK_OPEN_TOOL_ID;
}

export function SkillWorkspaceProvider({ children }: SkillWorkspaceProviderProps) {
  const usesFixtureData = shouldUseFixtureData();
  const [installedSkills, setInstalledSkills] = useState<SkillSummary[]>(
    usesFixtureData ? workspaceSnapshotFixture.installedSkills : [],
  );
  const [marketplaceSkills, setMarketplaceSkills] = useState<MarketplaceSkill[]>(
    usesFixtureData ? workspaceSnapshotFixture.marketplaceSkills : [],
  );
  const [localCandidates, setLocalCandidates] = useState<LocalSkillCandidate[]>(
    usesFixtureData ? workspaceSnapshotFixture.localCandidates : [],
  );
  const [toolConfigs, setToolConfigs] = useState<ToolConfig[]>(
    usesFixtureData ? workspaceSnapshotFixture.toolConfigs : [],
  );
  const [gitAccount, setGitAccount] = useState<GitAccountSummary | null>(
    usesFixtureData ? workspaceSnapshotFixture.gitAccount : null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isMarketplaceLoading, setIsMarketplaceLoading] = useState(false);
  const [isSearchLoading, setIsSearchLoading] = useState(false);
  const [installingMarketplaceSkillIds, setInstallingMarketplaceSkillIds] = useState<Set<string>>(new Set());
  const installingMarketplaceSkillIdsRef = useRef(new Set<string>());
  const [marketplacePageBySource, setMarketplacePageBySource] = useState<
    Record<MarketplaceSourceSite, number>
  >({
    "skills.sh": 0,
    skillsmp: 0,
  });
  const [hasMoreMarketplaceSkills, setHasMoreMarketplaceSkills] = useState(true);
  const [defaultOpenToolId, setDefaultOpenToolIdState] = useState(getInitialDefaultOpenToolId);

  useEffect(() => {
    const availableTools = buildOpenToolOptions(toolConfigs);
    const availableToolIds = new Set(availableTools.map((tool) => tool.id));
    if (availableToolIds.size === 0 || availableToolIds.has(defaultOpenToolId)) {
      return;
    }

    handleSetDefaultOpenToolId(availableTools[0]?.id ?? FALLBACK_OPEN_TOOL_ID);
  }, [defaultOpenToolId, toolConfigs]);

  function handleSetDefaultOpenToolId(toolId: string) {
    setDefaultOpenToolIdState(toolId);
    if (typeof window !== "undefined" && typeof window.localStorage?.setItem === "function") {
      window.localStorage.setItem(DEFAULT_OPEN_TOOL_STORAGE_KEY, toolId);
    }
  }

  async function loadWorkspaceCore() {
    const [skills, candidates, tools, account] = await Promise.all([
      fetchInstalledSkills(),
      fetchLocalSkillCandidates(),
      fetchToolConfigs(),
      fetchGitAccount(),
    ]);

    return {
      skills,
      candidates,
      tools,
      account,
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

    async function loadWorkspace() {
      const workspace = await loadWorkspaceCore();
      if (!active) {
        return;
      }

      setInstalledSkills(workspace.skills);
      setLocalCandidates(workspace.candidates);
      setToolConfigs(workspace.tools);
      setGitAccount(workspace.account);
      void refreshGitStatesInBackground(() => active);
    }

    void loadWorkspace();

    return () => {
      active = false;
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

  async function loadMarketplacePage(sourceSite: MarketplaceSourceSite, page: number, append: boolean) {
    if (isMarketplaceLoading) {
      return;
    }

    setIsMarketplaceLoading(true);
    try {
      const pageSkills = await fetchMarketplaceSkillsByPage({
        sourceSite,
        page,
        limit: MARKETPLACE_PAGE_SIZE,
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
      setHasMoreMarketplaceSkills(pageSkills.length > 0);
    } finally {
      setIsMarketplaceLoading(false);
    }
  }

  async function handleLoadInitialMarketplaceSkills(sourceSite: MarketplaceSourceSite) {
    await loadMarketplacePage(sourceSite, 1, false);
  }

  async function handleLoadMoreMarketplaceSkills(sourceSite: MarketplaceSourceSite) {
    if (!hasMoreMarketplaceSkills) {
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
      return await fetchMarketplaceSkillsByPage({
        page: 1,
        limit: MARKETPLACE_PAGE_SIZE * 6,
        query: normalizedQuery,
      });
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

  async function handleOpenSkillWithDefaultTool(skillName: string) {
    await openSkillInEditor({
      skillName,
      editorId: defaultOpenToolId || FALLBACK_OPEN_TOOL_ID,
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
      isMarketplaceLoading,
      isSearchLoading,
      installingMarketplaceSkillIds,
      hasMoreMarketplaceSkills,
      installFromMarket: handleInstallFromMarket,
      loadInitialMarketplaceSkills: handleLoadInitialMarketplaceSkills,
      loadMoreMarketplaceSkills: handleLoadMoreMarketplaceSkills,
      searchMarketplaceSkills: handleSearchMarketplaceSkills,
      discoverRepoSkills: handleDiscoverRepoSkills,
      installFromRepo: handleInstallFromRepo,
      importCandidate: handleImportCandidate,
      refreshWorkspace: loadWorkspaceSnapshot,
      updateSkill: handleUpdateSkill,
      updateAllSkills: handleUpdateAllSkills,
      deleteSkill: handleDeleteSkill,
      loadSkillFileBrowser: fetchSkillFileBrowser,
      loadSkillFileContent: fetchSkillFileContent,
      saveSkillFileContent,
      toggleSkillTool: handleToggleSkillTool,
      loadPushPreview: fetchPushPreviewSnapshot,
      loadPushTargets: fetchPushTargetSnapshot,
      openSkillRepository,
      openSkillInEditor,
      defaultOpenToolId,
      setDefaultOpenToolId: handleSetDefaultOpenToolId,
      openSkillWithDefaultTool: handleOpenSkillWithDefaultTool,
    }),
    [
      defaultOpenToolId,
      gitAccount,
      hasMoreMarketplaceSkills,
      installedSkills,
      installingMarketplaceSkillIds,
      isLoading,
      isMarketplaceLoading,
      isSearchLoading,
      localCandidates,
      marketplacePageBySource,
      marketplaceSkills,
      toolConfigs,
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
