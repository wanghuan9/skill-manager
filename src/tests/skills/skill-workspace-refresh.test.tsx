import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetMcpImportSessionForTests } from "@/features/skills/api/skill-client";
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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("@/app/utils/wait-for-next-paint", () => ({
  waitForNextPaint: vi.fn(() => Promise.resolve()),
}));

const mockedInvoke = vi.mocked(invoke);
const AUTO_GIT_STATE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_GIT_STATE_REFRESH_COOLDOWN_MS = 60 * 1000;

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

function LanguageProbe() {
  const { language, setLanguage } = useSkillWorkspace();

  return (
    <div>
      <span data-testid="language-value">{language}</span>
      <button type="button" onClick={() => void setLanguage("en")}>
        切换语言
      </button>
    </div>
  );
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
  vi.useRealTimers();
  window.localStorage.clear();
  resetMcpImportSessionForTests();
  mockedInvoke.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("refresh resolves after startup skills without waiting for ancillary requests", async () => {
  const initialSkills: SkillSummary[] = [installedSkillFixtures[0]];
  const refreshedSkills: SkillSummary[] = [installedSkillFixtures[1]];
  const pendingCandidates = createDeferred<LocalSkillCandidate[]>();
  const pendingTools = createDeferred<ToolConfig[]>();
  const pendingAccount = createDeferred<GitAccountSummary>();
  const pendingSettings = createDeferred<AppSettings>();
  let startupCallCount = 0;
  let gitStateCallCount = 0;
  let candidateCallCount = 0;
  let toolCallCount = 0;
  let accountCallCount = 0;
  let settingsCallCount = 0;

  mockedInvoke.mockImplementation(async (command, args) => {
    switch (command) {
      case "list_startup_installed_skills":
        startupCallCount += 1;
        return startupCallCount === 1 ? initialSkills : refreshedSkills;
      case "list_local_skill_candidates":
        candidateCallCount += 1;
        return candidateCallCount === 1 ? localSkillFixtures : pendingCandidates.promise;
      case "list_tool_configs":
        toolCallCount += 1;
        return toolCallCount === 1 ? toolConfigFixtures : pendingTools.promise;
      case "get_git_account_summary":
        accountCallCount += 1;
        return accountCallCount === 1 ? gitAccountFixture : pendingAccount.promise;
      case "get_app_settings":
        settingsCallCount += 1;
        return settingsCallCount === 1 ? appSettingsFixture : pendingSettings.promise;
      case "update_app_settings":
        return (args as { settings: AppSettings }).settings;
      case "refresh_git_states":
        gitStateCallCount += 1;
        return gitStateCallCount === 1 ? initialSkills : refreshedSkills;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });

  render(
    <SkillWorkspaceProvider>
      <RefreshProbe />
    </SkillWorkspaceProvider>,
  );

  await waitFor(() => {
    expect(screen.getByTestId("loading-state").textContent).toBe("ready");
    expect(screen.getByTestId("skill-name").textContent).toBe(initialSkills[0].name);
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "刷新工作区" }));
  });

  await waitFor(() => {
    expect(screen.getByTestId("refresh-state").textContent).toBe("done");
    expect(screen.getByTestId("loading-state").textContent).toBe("ready");
    expect(screen.getByTestId("skill-name").textContent).toBe(refreshedSkills[0].name);
  });

  pendingCandidates.resolve(localSkillFixtures);
  pendingTools.resolve(toolConfigFixtures);
  pendingAccount.resolve(gitAccountFixture);
  pendingSettings.resolve(appSettingsFixture);

  await act(async () => undefined);
});

test("does not overwrite saved default open tool while settings are still loading", async () => {
  const savedSettings: AppSettings = {
    ...appSettingsFixture,
    defaultOpenToolId: "windsurf",
  };
  const pendingSettings = createDeferred<AppSettings>();

  mockedInvoke.mockImplementation(async (command, args) => {
    switch (command) {
      case "list_startup_installed_skills":
      case "refresh_git_states":
        return installedSkillFixtures;
      case "list_local_skill_candidates":
        return localSkillFixtures;
      case "list_tool_configs":
        return toolConfigFixtures;
      case "get_git_account_summary":
        return gitAccountFixture;
      case "get_app_settings":
        return pendingSettings.promise;
      case "update_app_settings":
        return (args as { settings: AppSettings }).settings;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
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

  await waitFor(() => {
    expect(mockedInvoke).not.toHaveBeenCalledWith("update_app_settings", expect.anything(), expect.anything());
  });

  await act(async () => {
    pendingSettings.resolve(savedSettings);
  });

  await waitFor(() => {
    expect(screen.getByTestId("default-open-tool-id").textContent).toBe("windsurf");
    expect(mockedInvoke).not.toHaveBeenCalledWith("update_app_settings", expect.anything(), expect.anything());
  });
});

test("persists preferred default open tool after startup refresh when settings are empty", async () => {
  const pendingSettings = createDeferred<AppSettings>();
  let updateAppSettingsPayload: AppSettings | null = null;

  mockedInvoke.mockImplementation(async (command, args) => {
    switch (command) {
      case "list_startup_installed_skills":
      case "refresh_git_states":
        return installedSkillFixtures;
      case "list_local_skill_candidates":
        return localSkillFixtures;
      case "list_tool_configs":
        return toolConfigFixtures;
      case "get_git_account_summary":
        return gitAccountFixture;
      case "get_app_settings":
        return pendingSettings.promise;
      case "update_app_settings":
        updateAppSettingsPayload = (args as { settings: AppSettings }).settings;
        return updateAppSettingsPayload;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
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
    pendingSettings.resolve({
      ...appSettingsFixture,
      defaultOpenToolId: "",
    });
  });

  await waitFor(() => {
    expect(screen.getByTestId("default-open-tool-id").textContent).toBe("cursor");
    expect(updateAppSettingsPayload?.defaultOpenToolId).toBe("cursor");
  });
});

test("refreshes skillsmp marketplace after serving the initial cached page", async () => {
  const marketplaceCalls: Array<Record<string, unknown> | undefined> = [];
  mockedInvoke.mockImplementation(async (command, args) => {
    switch (command) {
      case "list_startup_installed_skills":
      case "refresh_git_states":
        return installedSkillFixtures;
      case "list_local_skill_candidates":
        return localSkillFixtures;
      case "list_tool_configs":
        return toolConfigFixtures;
      case "get_git_account_summary":
        return gitAccountFixture;
      case "get_app_settings":
        return appSettingsFixture;
      case "update_app_settings":
        return (args as { settings: AppSettings }).settings;
      case "list_marketplace_skills":
        marketplaceCalls.push(args as Record<string, unknown> | undefined);
        return marketplaceCalls.length === 1
          ? [createMarketplaceSkill("cached-skill")]
          : [createMarketplaceSkill("fresh-skill")];
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });

  render(
    <SkillWorkspaceProvider>
      <MarketplaceProbe />
    </SkillWorkspaceProvider>,
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "加载 skillsmp" }));
  });

  await waitFor(() => {
    expect(screen.getByTestId("marketplace-load-state").textContent).toBe("done");
    expect(marketplaceCalls).toHaveLength(2);
    expect(marketplaceCalls[0]).toEqual({
      sourceSite: "skillsmp",
      page: 1,
      limit: 18,
      refresh: undefined,
    });
    expect(marketplaceCalls[1]).toEqual({
      sourceSite: "skillsmp",
      page: 1,
      limit: 18,
      refresh: true,
    });
    expect(screen.getByTestId("marketplace-skill-names").textContent).toBe("fresh-skill");
  });
});

test("persists selected language into local storage", async () => {
  mockedInvoke.mockImplementation(async (command, args) => {
    switch (command) {
      case "list_startup_installed_skills":
      case "refresh_git_states":
        return installedSkillFixtures;
      case "list_local_skill_candidates":
        return localSkillFixtures;
      case "list_tool_configs":
        return toolConfigFixtures;
      case "get_git_account_summary":
        return gitAccountFixture;
      case "get_app_settings":
        return appSettingsFixture;
      case "update_app_settings":
        return (args as { settings: AppSettings }).settings;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });

  render(
    <SkillWorkspaceProvider>
      <LanguageProbe />
    </SkillWorkspaceProvider>,
  );

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "切换语言" })).toBeInTheDocument();
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "切换语言" }));
  });

  expect(screen.getByTestId("language-value").textContent).toBe("en");
  expect(window.localStorage.getItem("skilldock.settings.language")).toBe("en");
});

test("auto refreshes git state on interval and throttles rapid focus refreshes", async () => {
  vi.useFakeTimers();
  const initialSkills: SkillSummary[] = [installedSkillFixtures[0]];
  const intervalSkills: SkillSummary[] = [{ ...installedSkillFixtures[0], name: "interval-refresh" }];
  const focusSkills: SkillSummary[] = [{ ...installedSkillFixtures[0], name: "focus-refresh" }];
  let gitStateCallCount = 0;

  mockedInvoke.mockImplementation(async (command, args) => {
    switch (command) {
      case "list_startup_installed_skills":
        return initialSkills;
      case "refresh_git_states":
        gitStateCallCount += 1;
        if (gitStateCallCount === 1) {
          return initialSkills;
        }
        if (gitStateCallCount === 2) {
          return intervalSkills;
        }
        return focusSkills;
      case "list_local_skill_candidates":
        return localSkillFixtures;
      case "list_tool_configs":
        return toolConfigFixtures;
      case "get_git_account_summary":
        return gitAccountFixture;
      case "get_app_settings":
        return appSettingsFixture;
      case "update_app_settings":
        return (args as { settings: AppSettings }).settings;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });

  render(
    <SkillWorkspaceProvider>
      <RefreshProbe />
    </SkillWorkspaceProvider>,
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
  });

  expect(screen.getByTestId("loading-state").textContent).toBe("ready");
  expect(screen.getByTestId("skill-name").textContent).toBe(initialSkills[0].name);
  expect(gitStateCallCount).toBe(1);

  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(gitStateCallCount).toBe(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(AUTO_GIT_STATE_REFRESH_INTERVAL_MS);
  });
  expect(gitStateCallCount).toBe(2);
  expect(screen.getByTestId("skill-name").textContent).toBe("interval-refresh");

  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(gitStateCallCount).toBe(2);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(AUTO_GIT_STATE_REFRESH_COOLDOWN_MS + 1000);
    window.dispatchEvent(new Event("focus"));
  });
  expect(gitStateCallCount).toBe(3);
  expect(screen.getByTestId("skill-name").textContent).toBe("focus-refresh");
});

test("does not start another focus refresh while a git refresh is already in flight", async () => {
  vi.useFakeTimers();
  const initialSkills: SkillSummary[] = [installedSkillFixtures[0]];
  const pendingGitRefresh = createDeferred<SkillSummary[]>();
  let gitStateCallCount = 0;

  mockedInvoke.mockImplementation(async (command, args) => {
    switch (command) {
      case "list_startup_installed_skills":
        return initialSkills;
      case "refresh_git_states":
        gitStateCallCount += 1;
        return pendingGitRefresh.promise;
      case "list_local_skill_candidates":
        return localSkillFixtures;
      case "list_tool_configs":
        return toolConfigFixtures;
      case "get_git_account_summary":
        return gitAccountFixture;
      case "get_app_settings":
        return appSettingsFixture;
      case "update_app_settings":
        return (args as { settings: AppSettings }).settings;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });

  render(
    <SkillWorkspaceProvider>
      <RefreshProbe />
    </SkillWorkspaceProvider>,
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
  });

  expect(screen.getByTestId("loading-state").textContent).toBe("ready");
  expect(screen.getByTestId("skill-name").textContent).toBe(initialSkills[0].name);
  expect(gitStateCallCount).toBe(1);

  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(gitStateCallCount).toBe(1);

  await act(async () => {
    pendingGitRefresh.resolve([{ ...installedSkillFixtures[0], name: "resolved-refresh" }]);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByTestId("skill-name").textContent).toBe("resolved-refresh");
});
