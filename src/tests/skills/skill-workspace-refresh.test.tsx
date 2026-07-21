import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
const mockedListen = vi.mocked(listen);
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
  const { installedSkills, isLoading, isWorkspaceRefreshing, refreshWorkspace } = useSkillWorkspace();
  const [refreshState, setRefreshState] = useState("idle");

  async function handleRefresh() {
    setRefreshState("pending");
    await refreshWorkspace({ showRefreshing: true });
    setRefreshState("done");
  }

  return (
    <div>
      <button type="button" onClick={() => void handleRefresh()}>
        刷新工作区
      </button>
      <span data-testid="refresh-state">{refreshState}</span>
      <span data-testid="loading-state">{isLoading ? "loading" : "ready"}</span>
      <span data-testid="workspace-refreshing">{isWorkspaceRefreshing ? "refreshing" : "idle"}</span>
      <span data-testid="skill-name">{installedSkills[0]?.name ?? "none"}</span>
      <span data-testid="remote-updated-at">{installedSkills[0]?.remoteUpdatedAt ?? "none"}</span>
    </div>
  );
}

function RouteSwitchRefreshProbe() {
  const [showsSkillsPage, setShowsSkillsPage] = useState(true);

  return (
    <div>
      <button type="button" onClick={() => setShowsSkillsPage((current) => !current)}>
        切换页面
      </button>
      {showsSkillsPage ? <RefreshProbe /> : <span data-testid="other-page">其他页面</span>}
    </div>
  );
}

function UpdateAllProbe() {
  const { installedSkills, isLoading, isUpdatingAllSkills, updateAllSkills } = useSkillWorkspace();

  return (
    <div>
      <button type="button" onClick={() => void updateAllSkills()}>
        全部更新
      </button>
      <span data-testid="loading-state">{isLoading ? "loading" : "ready"}</span>
      <span data-testid="update-all-state">{isUpdatingAllSkills ? "updating" : "idle"}</span>
      <span data-testid="skill-name">{installedSkills[0]?.name ?? "none"}</span>
      <span data-testid="skill-status-text">{installedSkills[0]?.statusText ?? "none"}</span>
    </div>
  );
}

function SingleUpdateProbe() {
  const {
    installedSkills,
    isWorkspaceRefreshing,
    refreshWorkspace,
    updateSkill,
  } = useSkillWorkspace();

  return (
    <div>
      <button type="button" onClick={() => void refreshWorkspace({ showRefreshing: true })}>
        刷新工作区
      </button>
      <button type="button" onClick={() => void updateSkill(installedSkills[0]?.name ?? "")}>
        更新 Skill
      </button>
      <span data-testid="workspace-refreshing">{isWorkspaceRefreshing ? "refreshing" : "idle"}</span>
      <span data-testid="skill-status">{installedSkills[0]?.collabStatus ?? "none"}</span>
    </div>
  );
}

function RouteSwitchUpdateAllProbe() {
  const [showsSkillsPage, setShowsSkillsPage] = useState(true);

  return (
    <div>
      <button type="button" onClick={() => setShowsSkillsPage((current) => !current)}>
        切换页面
      </button>
      {showsSkillsPage ? <UpdateAllProbe /> : <span data-testid="other-page">其他页面</span>}
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

function SkillSourceViewStyleProbe() {
  const { appSettings } = useSkillWorkspace();

  return <span data-testid="skill-source-view-style">{appSettings.skillSourceViewStyle}</span>;
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

function emitSkillLibraryChange(skillName: string) {
  const subscription = mockedListen.mock.calls.find(
    ([eventName]) => eventName === "skill-library-changed",
  );
  if (!subscription) {
    throw new Error("skill-library-changed subscription was not registered");
  }

  const [, handler] = subscription;
  return handler({ payload: { skillName } } as never);
}

beforeEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  resetMcpImportSessionForTests();
  mockedInvoke.mockReset();
  mockedListen.mockReset();
  mockedListen.mockImplementation(() => Promise.resolve(() => undefined));
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("uses the stored source layout before native settings finish loading", async () => {
  const settingsDeferred = createDeferred<AppSettings>();
  window.localStorage.setItem("skilldock.settings.skillSourceViewStyle", "flat");

  mockedInvoke.mockImplementation(async (command) => {
    switch (command) {
      case "list_startup_installed_skills":
        return installedSkillFixtures;
      case "list_local_skill_candidates":
        return localSkillFixtures;
      case "list_tool_configs":
        return toolConfigFixtures;
      case "list_tool_skill_entries":
        return [];
      case "get_git_account_summary":
        return gitAccountFixture;
      case "get_app_settings":
        return settingsDeferred.promise;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });

  render(
    <SkillWorkspaceProvider>
      <SkillSourceViewStyleProbe />
    </SkillWorkspaceProvider>,
  );

  expect(screen.getByTestId("skill-source-view-style")).toHaveTextContent("flat");

  await act(async () => {
    settingsDeferred.resolve({ ...appSettingsFixture, skillSourceViewStyle: "flat" });
  });
});

test("refresh resolves after git state refresh during local alignment cooldown", async () => {
  const initialSkills: SkillSummary[] = [installedSkillFixtures[0]];
  const refreshedSkills: SkillSummary[] = [installedSkillFixtures[1]];
  let startupCallCount = 0;
  let gitStateCallCount = 0;

  mockedInvoke.mockImplementation(async (command, args) => {
    switch (command) {
      case "list_startup_installed_skills":
        startupCallCount += 1;
        return initialSkills;
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
  expect(startupCallCount).toBe(1);
  expect(gitStateCallCount).toBeGreaterThanOrEqual(2);
});

test("refresh keeps the fetched remote updated time instead of reverting to the startup snapshot", async () => {
  const startupSkill: SkillSummary = {
    ...installedSkillFixtures[0],
    name: "technical-design-test",
    remoteUpdatedAt: "2026/5/7 19:27:55",
  };
  const refreshedSkill: SkillSummary = {
    ...startupSkill,
    remoteUpdatedAt: "2026/5/26 19:07:25",
  };

  let startupCallCount = 0;
  let gitStateCallCount = 0;

  mockedInvoke.mockImplementation(async (command, args) => {
    switch (command) {
      case "list_startup_installed_skills":
        startupCallCount += 1;
        return [startupSkill];
      case "refresh_git_states":
        gitStateCallCount += 1;
        return [refreshedSkill];
      case "list_local_skill_candidates":
        return localSkillFixtures;
      case "list_tool_configs":
        return toolConfigFixtures;
      case "get_git_account_summary":
        return gitAccountFixture;
      case "get_app_settings":
      case "update_app_settings":
        return args && "settings" in (args as Record<string, unknown>)
          ? (args as { settings: AppSettings }).settings
          : appSettingsFixture;
      case "refresh_local_git_state":
        return refreshedSkill;
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
    expect(screen.getByTestId("remote-updated-at").textContent).toBe("2026/5/26 19:07:25");
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "刷新工作区" }));
  });

  await waitFor(() => {
    expect(screen.getByTestId("refresh-state").textContent).toBe("done");
    expect(screen.getByTestId("remote-updated-at").textContent).toBe("2026/5/26 19:07:25");
  });

  expect(startupCallCount).toBe(1);
  expect(gitStateCallCount).toBeGreaterThanOrEqual(2);
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
  expect(screen.getByTestId("workspace-refreshing").textContent).toBe("idle");
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
  expect(screen.getByTestId("workspace-refreshing").textContent).toBe("idle");

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
  expect(screen.getByTestId("workspace-refreshing").textContent).toBe("idle");
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
  expect(screen.getByTestId("workspace-refreshing").textContent).toBe("idle");
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

test("keeps manual refresh active across route switches", async () => {
  const initialSkills: SkillSummary[] = [installedSkillFixtures[0]];
  const refreshedSkills: SkillSummary[] = [{ ...installedSkillFixtures[0], name: "route-refresh-done" }];
  const pendingManualRefresh = createDeferred<SkillSummary[]>();
  let gitStateCallCount = 0;

  mockedInvoke.mockImplementation(async (command, args) => {
    switch (command) {
      case "list_startup_installed_skills":
        return initialSkills;
      case "refresh_git_states":
        gitStateCallCount += 1;
        return gitStateCallCount === 1 ? initialSkills : pendingManualRefresh.promise;
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
      <RouteSwitchRefreshProbe />
    </SkillWorkspaceProvider>,
  );

  await waitFor(() => {
    expect(screen.getByTestId("loading-state").textContent).toBe("ready");
    expect(screen.getByTestId("skill-name").textContent).toBe(initialSkills[0].name);
  });
  await waitFor(() => {
    expect(screen.getByTestId("workspace-refreshing").textContent).toBe("idle");
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "刷新工作区" }));
  });

  await waitFor(() => {
    expect(screen.getByTestId("workspace-refreshing").textContent).toBe("refreshing");
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "切换页面" }));
  });
  expect(screen.getByTestId("other-page").textContent).toBe("其他页面");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "切换页面" }));
  });
  expect(screen.getByTestId("workspace-refreshing").textContent).toBe("refreshing");
  expect(screen.getByTestId("skill-name").textContent).toBe(initialSkills[0].name);

  await act(async () => {
    pendingManualRefresh.resolve(refreshedSkills);
    await Promise.resolve();
  });

  await waitFor(() => {
    expect(screen.getByTestId("workspace-refreshing").textContent).toBe("idle");
    expect(screen.getByTestId("skill-name").textContent).toBe(refreshedSkills[0].name);
  });
});

test("keeps update-all active across route switches", async () => {
  const updateAvailableSkill: SkillSummary = {
    ...installedSkillFixtures[0],
    collabStatus: "update-available",
  };
  const updatedSkill: SkillSummary = {
    ...updateAvailableSkill,
    collabStatus: "clean",
    statusText: "已更新完成",
  };
  const pendingUpdate = createDeferred<SkillSummary>();

  mockedInvoke.mockImplementation(async (command, args) => {
    switch (command) {
      case "list_startup_installed_skills":
      case "refresh_git_states":
        return [updateAvailableSkill];
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
      case "update_skill":
        return pendingUpdate.promise;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });

  render(
    <SkillWorkspaceProvider>
      <RouteSwitchUpdateAllProbe />
    </SkillWorkspaceProvider>,
  );

  await waitFor(() => {
    expect(screen.getByTestId("loading-state").textContent).toBe("ready");
    expect(screen.getByTestId("skill-name").textContent).toBe(updateAvailableSkill.name);
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "全部更新" }));
  });

  await waitFor(() => {
    expect(screen.getByTestId("update-all-state").textContent).toBe("updating");
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "切换页面" }));
  });
  expect(screen.getByTestId("other-page").textContent).toBe("其他页面");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "切换页面" }));
  });
  expect(screen.getByTestId("update-all-state").textContent).toBe("updating");
  expect(screen.getByTestId("skill-name").textContent).toBe(updateAvailableSkill.name);

  await act(async () => {
    pendingUpdate.resolve(updatedSkill);
    await Promise.resolve();
  });

  await waitFor(() => {
    expect(screen.getByTestId("update-all-state").textContent).toBe("idle");
    expect(screen.getByTestId("skill-name").textContent).toBe(updateAvailableSkill.name);
    expect(screen.getByTestId("skill-status-text").textContent).toBe(updatedSkill.statusText);
  });
});

test("refreshes a startup skill once after debounced library change events", async () => {
  vi.useFakeTimers();
  try {
    const watchedSkill = installedSkillFixtures[0];
    const refreshedSkill: SkillSummary = {
      ...watchedSkill,
      collabStatus: "pending-push",
      statusText: "本地存在待推送内容，建议提交并推送。",
    };

    mockedInvoke.mockImplementation(async (command, args) => {
      switch (command) {
        case "list_startup_installed_skills":
        case "refresh_git_states":
          return [watchedSkill];
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
        case "refresh_local_git_state":
          if ((args as { skillName: string }).skillName !== watchedSkill.name) {
            throw new Error(`Unexpected refresh target: ${(args as { skillName: string }).skillName}`);
          }
          return refreshedSkill;
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
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(screen.getByTestId("loading-state").textContent).toBe("ready");

    await act(async () => {
      emitSkillLibraryChange(watchedSkill.name);
      emitSkillLibraryChange(watchedSkill.name);
    });

    await act(async () => {
      vi.advanceTimersByTime(499);
      await Promise.resolve();
    });

    expect(
      mockedInvoke.mock.calls.filter(([command]) => command === "refresh_local_git_state"),
    ).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    const refreshCalls = mockedInvoke.mock.calls.filter(
      ([command]) => command === "refresh_local_git_state",
    );
    expect(refreshCalls).toHaveLength(1);
    expect((refreshCalls[0][1] as { skillName: string }).skillName).toBe(watchedSkill.name);
  } finally {
    vi.useRealTimers();
  }
});

test("ignores library change events for skills that appear only after startup", async () => {
  vi.useFakeTimers();
  try {
    const startupSkill: SkillSummary = {
      ...installedSkillFixtures[0],
      name: "startup-skill",
    };
    const newlyInstalledSkill: SkillSummary = {
      ...installedSkillFixtures[1],
      name: "imported-after-startup",
    };

    mockedInvoke.mockImplementation(async (command, args) => {
      switch (command) {
        case "list_startup_installed_skills":
          return [startupSkill];
        case "refresh_git_states":
          return [startupSkill, newlyInstalledSkill];
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
        case "refresh_local_git_state":
          throw new Error(`Unexpected refresh target: ${(args as { skillName: string }).skillName}`);
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
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(screen.getByTestId("loading-state").textContent).toBe("ready");

    await act(async () => {
      emitSkillLibraryChange(newlyInstalledSkill.name);
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(
      mockedInvoke.mock.calls.filter(([command]) => command === "refresh_local_git_state"),
    ).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test("does not let an older refresh overwrite a completed skill update", async () => {
  const updateAvailableSkill: SkillSummary = {
    ...installedSkillFixtures[0],
    collabStatus: "update-available",
  };
  const updatedSkill: SkillSummary = {
    ...updateAvailableSkill,
    collabStatus: "clean",
    statusText: "已更新完成",
  };
  const pendingRefresh = createDeferred<SkillSummary[]>();
  const pendingUpdate = createDeferred<SkillSummary>();
  let refreshCallCount = 0;

  mockedInvoke.mockImplementation(async (command, args) => {
    switch (command) {
      case "list_startup_installed_skills":
        return [updateAvailableSkill];
      case "refresh_git_states":
        refreshCallCount += 1;
        return refreshCallCount === 1 ? [updateAvailableSkill] : pendingRefresh.promise;
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
      case "update_skill":
        return pendingUpdate.promise;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });

  render(
    <SkillWorkspaceProvider>
      <SingleUpdateProbe />
    </SkillWorkspaceProvider>,
  );

  await waitFor(() => {
    expect(screen.getByTestId("skill-status").textContent).toBe("update-available");
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "刷新工作区" }));
  });
  await waitFor(() => {
    expect(screen.getByTestId("workspace-refreshing").textContent).toBe("refreshing");
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "更新 Skill" }));
    pendingUpdate.resolve(updatedSkill);
    await Promise.resolve();
  });

  await waitFor(() => {
    expect(screen.getByTestId("skill-status").textContent).toBe("clean");
  });

  await act(async () => {
    pendingRefresh.resolve([updateAvailableSkill]);
    await Promise.resolve();
  });

  expect(screen.getByTestId("skill-status").textContent).toBe("clean");
});
