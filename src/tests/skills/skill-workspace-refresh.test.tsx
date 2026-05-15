import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as skillClient from "@/features/skills/api/skill-client";
import {
  appSettingsFixture,
  gitAccountFixture,
  installedSkillFixtures,
  localSkillFixtures,
  toolConfigFixtures,
} from "@/features/skills/state/skill-fixtures";
import { SkillWorkspaceProvider, useSkillWorkspace } from "@/features/skills/state/skill-workspace";
import type {
  AppSettings,
  GitAccountSummary,
  LocalSkillCandidate,
  MarketplaceSkill,
  SkillSummary,
  ToolConfig,
} from "@/features/skills/state/skill-store";

vi.mock("@/app/utils/wait-for-next-paint", () => ({
  waitForNextPaint: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/features/skills/api/skill-client", async () => {
  const actual = await vi.importActual<typeof import("@/features/skills/api/skill-client")>(
    "@/features/skills/api/skill-client",
  );
  return {
    ...actual,
    shouldUseFixtureData: vi.fn(() => false),
    fetchStartupInstalledSkills: vi.fn(),
    fetchLocalSkillCandidates: vi.fn(),
    fetchToolConfigs: vi.fn(),
    fetchGitAccount: vi.fn(),
    fetchAppSettings: vi.fn(),
    fetchGitStates: vi.fn(),
    fetchMarketplaceSkillsByPage: vi.fn(),
    detectPreferredAppLanguage: vi.fn(),
    updateAppSettings: vi.fn(),
  };
});

const mockedFetchStartupInstalledSkills = vi.mocked(skillClient.fetchStartupInstalledSkills);
const mockedFetchLocalSkillCandidates = vi.mocked(skillClient.fetchLocalSkillCandidates);
const mockedFetchToolConfigs = vi.mocked(skillClient.fetchToolConfigs);
const mockedFetchGitAccount = vi.mocked(skillClient.fetchGitAccount);
const mockedFetchAppSettings = vi.mocked(skillClient.fetchAppSettings);
const mockedFetchGitStates = vi.mocked(skillClient.fetchGitStates);
const mockedFetchMarketplaceSkillsByPage = vi.mocked(skillClient.fetchMarketplaceSkillsByPage);
const mockedDetectPreferredAppLanguage = vi.mocked(skillClient.detectPreferredAppLanguage);
const mockedUpdateAppSettings = vi.mocked(skillClient.updateAppSettings);

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function RefreshProbe() {
  const { installedSkills, isLoading, refreshWorkspace } = useSkillWorkspace();
  const [refreshState, setRefreshState] = useState("idle");

  async function handleRefresh() {
    setRefreshState("pending");
    await refreshWorkspace();
    setRefreshState("done");
  }

  return (
    <div>
      <button type="button" onClick={() => void handleRefresh()}>
        刷新工作区
      </button>
      <span data-testid="refresh-state">{refreshState}</span>
      <span data-testid="loading-state">{isLoading ? "loading" : "ready"}</span>
      <span data-testid="skill-name">{installedSkills[0]?.name ?? "none"}</span>
    </div>
  );
}

function DefaultOpenToolProbe() {
  const { defaultOpenToolId } = useSkillWorkspace();

  return <span data-testid="default-open-tool-id">{defaultOpenToolId}</span>;
}

function MarketplaceProbe() {
  const { loadInitialMarketplaceSkills, marketplaceSkills } = useSkillWorkspace();
  const [loadState, setLoadState] = useState("idle");

  async function handleLoad() {
    await loadInitialMarketplaceSkills("skillsmp");
    setLoadState("done");
  }

  return (
    <div>
      <button type="button" onClick={() => void handleLoad()}>
        加载 skillsmp
      </button>
      <span data-testid="marketplace-load-state">{loadState}</span>
      <span data-testid="marketplace-skill-names">
        {marketplaceSkills.map((skill) => skill.name).join(",")}
      </span>
    </div>
  );
}

function createMarketplaceSkill(name: string): MarketplaceSkill {
  return {
    id: `skillsmp-${name}`,
    name,
    sourceType: "github",
    sourceSite: "skillsmp",
    description: name,
    maintainer: "skillsmp",
    updatedAt: "",
    installLabel: "默认按热度排序",
    sourceUrl: `https://github.com/team/repo/tree/main/skills/${name}`,
    popularityLabel: "1.0K",
    avatarUrl: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  mockedDetectPreferredAppLanguage.mockResolvedValue("zh-CN");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("refresh resolves after startup skills without waiting for ancillary requests", async () => {
  const initialSkills: SkillSummary[] = [installedSkillFixtures[0]];
  const refreshedSkills: SkillSummary[] = [installedSkillFixtures[1]];
  const pendingCandidates = createDeferred<LocalSkillCandidate[]>();
  const pendingTools = createDeferred<ToolConfig[]>();
  const pendingAccount = createDeferred<GitAccountSummary>();
  const pendingSettings = createDeferred<AppSettings>();

  mockedFetchStartupInstalledSkills
    .mockResolvedValueOnce(initialSkills)
    .mockResolvedValueOnce(refreshedSkills);
  mockedFetchLocalSkillCandidates
    .mockResolvedValueOnce(localSkillFixtures)
    .mockReturnValueOnce(pendingCandidates.promise);
  mockedFetchToolConfigs
    .mockResolvedValueOnce(toolConfigFixtures)
    .mockReturnValueOnce(pendingTools.promise);
  mockedFetchGitAccount
    .mockResolvedValueOnce(gitAccountFixture)
    .mockReturnValueOnce(pendingAccount.promise);
  mockedFetchAppSettings
    .mockResolvedValueOnce(appSettingsFixture)
    .mockReturnValueOnce(pendingSettings.promise);
  mockedFetchGitStates
    .mockResolvedValueOnce(initialSkills)
    .mockResolvedValueOnce(refreshedSkills);

  render(
    <SkillWorkspaceProvider>
      <RefreshProbe />
    </SkillWorkspaceProvider>,
  );

  await act(async () => {
    vi.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByTestId("loading-state").textContent).toBe("ready");
  expect(screen.getByTestId("skill-name").textContent).toBe(initialSkills[0].name);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "刷新工作区" }));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByTestId("refresh-state").textContent).toBe("done");
  expect(screen.getByTestId("loading-state").textContent).toBe("ready");
  expect(screen.getByTestId("skill-name").textContent).toBe(refreshedSkills[0].name);

  pendingCandidates.resolve(localSkillFixtures);
  pendingTools.resolve(toolConfigFixtures);
  pendingAccount.resolve(gitAccountFixture);
  pendingSettings.resolve(appSettingsFixture);

  await act(async () => {
    await Promise.resolve();
  });
});

test("does not overwrite saved default open tool while settings are still loading", async () => {
  const savedSettings: AppSettings = {
    ...appSettingsFixture,
    defaultOpenToolId: "windsurf",
  };
  const pendingSettings = createDeferred<AppSettings>();

  mockedFetchStartupInstalledSkills.mockResolvedValue(installedSkillFixtures);
  mockedFetchLocalSkillCandidates.mockResolvedValue(localSkillFixtures);
  mockedFetchToolConfigs.mockResolvedValue(toolConfigFixtures);
  mockedFetchGitAccount.mockResolvedValue(gitAccountFixture);
  mockedFetchAppSettings.mockReturnValue(pendingSettings.promise);
  mockedFetchGitStates.mockResolvedValue(installedSkillFixtures);
  mockedUpdateAppSettings.mockImplementation(async ({ settings }) => settings);
  window.localStorage.setItem(
    "skilldock.startupWorkspaceCache",
    JSON.stringify({
      installedSkills: installedSkillFixtures,
      localCandidates: localSkillFixtures,
      toolConfigs: toolConfigFixtures,
      gitAccount: gitAccountFixture,
    }),
  );

  render(
    <SkillWorkspaceProvider>
      <DefaultOpenToolProbe />
    </SkillWorkspaceProvider>,
  );

  await act(async () => {
    vi.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockedUpdateAppSettings).not.toHaveBeenCalled();

  pendingSettings.resolve(savedSettings);

  await act(async () => {
    vi.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByTestId("default-open-tool-id").textContent).toBe("windsurf");
  expect(mockedUpdateAppSettings).not.toHaveBeenCalled();
});

test("refreshes skillsmp marketplace after serving the initial cached page", async () => {
  mockedFetchStartupInstalledSkills.mockResolvedValue(installedSkillFixtures);
  mockedFetchLocalSkillCandidates.mockResolvedValue(localSkillFixtures);
  mockedFetchToolConfigs.mockResolvedValue(toolConfigFixtures);
  mockedFetchGitAccount.mockResolvedValue(gitAccountFixture);
  mockedFetchAppSettings.mockResolvedValue(appSettingsFixture);
  mockedFetchGitStates.mockResolvedValue(installedSkillFixtures);
  mockedFetchMarketplaceSkillsByPage
    .mockResolvedValueOnce([createMarketplaceSkill("cached-skill")])
    .mockResolvedValueOnce([createMarketplaceSkill("fresh-skill")]);

  render(
    <SkillWorkspaceProvider>
      <MarketplaceProbe />
    </SkillWorkspaceProvider>,
  );

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "加载 skillsmp" }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByTestId("marketplace-load-state").textContent).toBe("done");
  expect(mockedFetchMarketplaceSkillsByPage).toHaveBeenCalledTimes(2);
  expect(mockedFetchMarketplaceSkillsByPage).toHaveBeenNthCalledWith(1, {
    sourceSite: "skillsmp",
    page: 1,
    limit: 18,
    refresh: undefined,
  });
  expect(mockedFetchMarketplaceSkillsByPage).toHaveBeenNthCalledWith(2, {
    sourceSite: "skillsmp",
    page: 1,
    limit: 18,
    refresh: true,
  });
  expect(screen.getByTestId("marketplace-skill-names").textContent).toBe("fresh-skill");
});
