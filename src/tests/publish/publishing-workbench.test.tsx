import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { PublishingWorkbench } from "@/features/publishing/PublishingWorkbench";
import type { PublishingPlatformAdapter } from "@/features/publishing/publishing-adapter";
import type { PublishableSkill } from "@/features/publishing/types";
import { subscribeSkillLibraryChanges } from "@/features/skills/api/skill-client";

vi.mock("@/app/i18n", () => ({
  useTranslate: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/skills/api/skill-client", () => ({
  openExternalLink: vi.fn(),
  openPathInFinder: vi.fn(),
  subscribeSkillLibraryChanges: vi.fn().mockResolvedValue(() => undefined),
}));

const SKILL: PublishableSkill = {
  name: "shared-workbench",
  description: "Shared publishing workbench",
  localPath: "/tmp/shared-workbench",
  localContentHash: "local-hash",
  fileCount: 3,
  packageSize: 1024,
  remoteVersion: "",
  remoteContentHash: "",
  publishStatus: "unpublished",
  failureReason: "",
  marketUrl: "",
  targetVersion: "1.0.0",
};

function createAdapter(): PublishingPlatformAdapter {
  return {
    platform: { id: "skillhub", label: "SkillHub" },
    getAuthState: vi.fn().mockResolvedValue({
      connected: true,
      accountLabel: "@skilldock",
      verifiedAt: "2026-07-31T00:00:00Z",
    }),
    fetchSkills: vi.fn().mockResolvedValue({
      skills: [SKILL],
      authorizationRequired: false,
    }),
    refreshSkill: vi.fn().mockResolvedValue(SKILL),
    publishSkill: vi.fn().mockImplementation(async () => ({
      ...SKILL,
      remoteSkillId: "remote-1",
      remoteVersion: "1.0.0",
      publishStatus: "published",
    })),
    fetchUnmanagedSkills: vi.fn().mockResolvedValue([{
      name: "external-skill",
      description: "Skill found outside SkillDock",
      localPath: "/tmp/external-skill",
      detectedFrom: "/Users/test/.codex/skills",
      sourceHint: "目录",
      toolId: "codex",
      resolvedPath: "/tmp/external-skill",
    }]),
    importAndPublishUnmanagedSkill: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  document.getElementById("publish-source-header-slot")?.remove();
});

test("uses the shared internal workbench layout for first publish", async () => {
  const sourceHeader = document.createElement("div");
  sourceHeader.id = "publish-source-header-slot";
  document.body.append(sourceHeader);
  const adapter = createAdapter();
  render(<PublishingWorkbench adapter={adapter} />);

  expect(await screen.findByRole("heading", { name: "shared-workbench" })).toBeInTheDocument();
  expect(screen.getByText("未发布")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "发布" }));
  const dialog = screen.getByRole("dialog", { name: "发布 Skill" });
  expect(dialog).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "发布" }));

  await waitFor(() => expect(adapter.publishSkill).toHaveBeenCalledWith({
    skillName: "shared-workbench",
    localPath: "/tmp/shared-workbench",
    remoteSkillId: undefined,
    expectedRemoteVersion: undefined,
    changelog: "",
  }));
  expect(await screen.findByText("已发布")).toBeInTheDocument();
});

test("closes the publish dialog immediately while the request continues in the background", async () => {
  let resolvePublish: ((skill: PublishableSkill) => void) | undefined;
  const adapter = createAdapter();
  adapter.publishSkill = vi.fn().mockImplementation(() => new Promise<PublishableSkill>((resolve) => {
    resolvePublish = resolve;
  }));
  render(<PublishingWorkbench adapter={adapter} />);

  await userEvent.click(await screen.findByRole("button", { name: "发布" }));
  const dialog = screen.getByRole("dialog", { name: "发布 Skill" });
  await userEvent.click(within(dialog).getByRole("button", { name: "发布" }));

  expect(screen.queryByRole("dialog", { name: "发布 Skill" })).not.toBeInTheDocument();
  expect(await screen.findByText("发布中")).toBeInTheDocument();

  await act(async () => {
    resolvePublish?.({
      ...SKILL,
      remoteSkillId: "remote-1",
      remoteVersion: "1.0.0",
      publishStatus: "published",
    });
  });
  expect(await screen.findByText("已发布")).toBeInTheDocument();
});

test("keeps the skill library listener stable while refreshing publishing statuses", async () => {
  const adapter = createAdapter();
  const listenerCallCount = vi.mocked(subscribeSkillLibraryChanges).mock.calls.length;
  render(<PublishingWorkbench adapter={adapter} />);

  await screen.findByRole("heading", { name: "shared-workbench" });
  await waitFor(() => expect(subscribeSkillLibraryChanges).toHaveBeenCalledTimes(listenerCallCount + 1));

  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(adapter.fetchSkills).toHaveBeenCalledTimes(2));

  expect(subscribeSkillLibraryChanges).toHaveBeenCalledTimes(listenerCallCount + 1);
});

test("does not refresh authorization while a shell-controlled workbench is hidden", async () => {
  vi.useFakeTimers();
  const adapter = createAdapter();
  adapter.readCachedSnapshot = () => ({
    skills: [{ ...SKILL, publishStatus: "publishing" }],
    authorizationRequired: false,
  });

  render(
    <PublishingWorkbench
      adapter={adapter}
      externalAuthState={null}
      isVisible={false}
      onAuthStateChange={vi.fn()}
    />,
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });

  expect(adapter.getAuthState).not.toHaveBeenCalled();
  expect(adapter.fetchSkills).not.toHaveBeenCalled();
});

test("disconnects when background reconciliation reports expired authorization", async () => {
  const adapter = createAdapter();
  adapter.reconcileSkills = vi.fn().mockResolvedValue({
    skills: [],
    authorizationRequired: true,
  });
  const onAuthStateChange = vi.fn();
  const externalAuthState = {
    connected: true,
    accountLabel: "@skilldock",
    verifiedAt: "2026-07-31T00:00:00Z",
  };

  render(
    <PublishingWorkbench
      adapter={adapter}
      externalAuthState={externalAuthState}
      onAuthStateChange={onAuthStateChange}
    />,
  );

  await waitFor(() => expect(onAuthStateChange).toHaveBeenLastCalledWith({
    connected: false,
    accountLabel: "",
    verifiedAt: "",
  }));
  expect(screen.queryByRole("heading", { name: "shared-workbench" })).not.toBeInTheDocument();
});

test("shows the changed file count on an update preview button", async () => {
  const adapter = createAdapter();
  adapter.fetchSkills = vi.fn().mockResolvedValue({
    skills: [{
      ...SKILL,
      remoteSkillId: "remote-1",
      remoteVersion: "1.0.0",
      publishStatus: "update-available",
      targetVersion: "1.0.1",
      updateFileCount: 2,
    }],
    authorizationRequired: false,
  });

  render(<PublishingWorkbench adapter={adapter} />);

  const previewButton = await screen.findByRole("button", { name: "预览变更 shared-workbench" });
  expect(within(previewButton).getByText("2")).toHaveClass("skill-card__change-count");
});

test("keeps a platform-blocked skill visible without a publish action", async () => {
  const adapter = createAdapter();
  adapter.fetchSkills = vi.fn().mockResolvedValue({
    skills: [{
      ...SKILL,
      remoteSkillId: "xhs-wechat-plugin-promo",
      remoteVersion: "1.0.1",
      publishStatus: "failed",
      publishBlocked: true,
      failureReason: "SkillHub 已封禁，暂不能发布或比较版本文件；解除封禁后刷新即可恢复。",
    }],
    authorizationRequired: false,
  });

  render(<PublishingWorkbench adapter={adapter} />);

  expect(await screen.findByText("已封禁")).toHaveClass("tone-danger");
  expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
});

test("shows the Skill source and management owner like the Skills page", async () => {
  const adapter = createAdapter();
  adapter.fetchSkills = vi.fn().mockResolvedValue({
    skills: [{
      ...SKILL,
      sourceType: "github",
      gitLinked: true,
      managementOwner: "agent-skills-cli",
    }],
    authorizationRequired: false,
  });
  render(<PublishingWorkbench adapter={adapter} />);

  expect(await screen.findByText("Agent CLI")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "skills.view.grid" }));
  expect(await screen.findByText("Git · Agent CLI")).toBeInTheDocument();
});

test("reuses the internal managed switcher and preview-file action", async () => {
  const sourceHeader = document.createElement("div");
  sourceHeader.id = "publish-source-header-slot";
  document.body.append(sourceHeader);
  render(<PublishingWorkbench adapter={createAdapter()} />);

  expect(await screen.findByRole("tab", { name: /已托管 1/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "预览文件 shared-workbench" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: /未托管 1/ }));
  expect(await screen.findByRole("heading", { name: "external-skill" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "预览 external-skill" })).toBeInTheDocument();
});

test("restores unmanaged Skill details in list and grid layouts", async () => {
  const sourceHeader = document.createElement("div");
  sourceHeader.id = "publish-source-header-slot";
  document.body.append(sourceHeader);
  render(<PublishingWorkbench adapter={createAdapter()} />);

  await userEvent.click(await screen.findByRole("tab", { name: /未托管 1/ }));

  const unmanagedCard = screen.getByRole("heading", { name: "external-skill" }).closest("article");
  const summary = unmanagedCard?.querySelector<HTMLElement>(".publish-skill-row__summary-button");
  expect(unmanagedCard).not.toBeNull();
  expect(summary).not.toBeNull();

  await userEvent.click(summary!);

  expect(unmanagedCard).toHaveClass("is-expanded");
  expect(screen.queryByRole("dialog", { name: "external-skill 未托管详情" })).not.toBeInTheDocument();
  expect(within(unmanagedCard!).getByRole("heading", { name: "基本信息" })).toBeInTheDocument();
  const listDetails = unmanagedCard?.querySelector<HTMLElement>(".unmanaged-skill-details");
  expect(listDetails).not.toBeNull();
  expect(within(listDetails!).getByText("/tmp/external-skill")).toBeInTheDocument();
  expect(within(listDetails!).getByText("Codex")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "skills.view.grid" }));

  const detailDialog = screen.getByRole("dialog", { name: "external-skill 未托管详情" });
  expect(within(detailDialog).getByRole("heading", { name: "基本信息" })).toBeInTheDocument();
  expect(document.body).toHaveStyle({ overflow: "hidden" });

  fireEvent.keyDown(window, { key: "Escape" });

  expect(screen.queryByRole("dialog", { name: "external-skill 未托管详情" })).not.toBeInTheDocument();
  expect(document.body).not.toHaveStyle({ overflow: "hidden" });

  const gridCard = screen.getByRole("heading", { name: "external-skill" }).closest("article");
  const gridSummary = gridCard?.querySelector<HTMLElement>(".publish-skill-row__summary-button");
  await userEvent.click(gridSummary!);
  await userEvent.click(within(screen.getByRole("dialog", { name: "external-skill 未托管详情" }))
    .getByRole("button", { name: "导入并发布" }));

  expect(screen.getByRole("dialog", { name: /导入托管并发布 · external-skill/ })).toBeInTheDocument();
});

test("keeps unmanaged candidates while switching the publishing platform", async () => {
  const sourceHeader = document.createElement("div");
  sourceHeader.id = "publish-source-header-slot";
  document.body.append(sourceHeader);
  const firstAdapter = createAdapter();
  const secondAdapter = createAdapter();
  secondAdapter.platform = { id: "secondary-market", label: "legacy-marketplace" };
  const { rerender } = render(<PublishingWorkbench adapter={firstAdapter} />);

  await screen.findByRole("tab", { name: /未托管 1/ });
  await waitFor(() => expect(firstAdapter.fetchUnmanagedSkills).toHaveBeenCalledTimes(1));

  rerender(<PublishingWorkbench adapter={secondAdapter} />);

  expect(await screen.findByRole("tab", { name: /未托管 1/ })).toBeInTheDocument();
  expect(secondAdapter.fetchUnmanagedSkills).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("tab", { name: /未托管 1/ }));
  expect(await screen.findByRole("heading", { name: "external-skill" })).toBeInTheDocument();
  expect(firstAdapter.fetchUnmanagedSkills).toHaveBeenCalledTimes(1);
});

test("keeps the cached SkillHub update state while switching platforms", async () => {
  const firstAdapter = createAdapter();
  const cachedUpdate = {
    ...SKILL,
    remoteSkillId: "remote-1",
    remoteVersion: "1.0.0",
    publishStatus: "update-available" as const,
    updateFileCount: 1,
    targetVersion: "1.0.1",
  };
  const skillHubAdapter = createAdapter();
  skillHubAdapter.readCachedSnapshot = () => ({
    skills: [cachedUpdate],
    authorizationRequired: false,
  });
  skillHubAdapter.fetchSkills = vi.fn().mockResolvedValue({
    skills: [{
      ...cachedUpdate,
      publishStatus: "published" as const,
      updateFileCount: 0,
      fileDiffReconciled: false,
      targetVersion: "1.0.0",
    }],
    authorizationRequired: false,
  });
  skillHubAdapter.reconcileSkills = vi.fn().mockReturnValue(new Promise(() => undefined));
  const { rerender } = render(<PublishingWorkbench adapter={firstAdapter} />);

  expect(await screen.findByText("未发布")).toBeInTheDocument();
  rerender(<PublishingWorkbench adapter={skillHubAdapter} />);

  await waitFor(() => expect(skillHubAdapter.fetchSkills).toHaveBeenCalled());
  expect(screen.getByText("可更新")).toBeInTheDocument();
});

test("keeps cached update status while SkillHub refreshes remote file diffs", async () => {
  const cachedUpdate = {
    ...SKILL,
    remoteSkillId: "remote-1",
    remoteVersion: "1.0.0",
    publishStatus: "update-available" as const,
    updateFileCount: 1,
    targetVersion: "1.0.1",
  };
  const adapter = createAdapter();
  adapter.cachedSnapshotRefreshDelayMs = 60_000;
  adapter.readCachedSnapshot = () => ({
    skills: [cachedUpdate],
    authorizationRequired: false,
  });
  adapter.fetchSkills = vi.fn().mockResolvedValue({
    skills: [{
      ...cachedUpdate,
      publishStatus: "published",
      updateFileCount: 0,
      targetVersion: "1.0.0",
    }],
    authorizationRequired: false,
  });
  adapter.reconcileSkills = vi.fn().mockReturnValue(new Promise(() => undefined));
  adapter.writeCachedSnapshot = vi.fn();

  render(<PublishingWorkbench adapter={adapter} />);

  expect(await screen.findByText("可更新")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(adapter.fetchSkills).toHaveBeenCalledWith(true));
  expect(adapter.writeCachedSnapshot).toHaveBeenCalledWith(expect.objectContaining({
    skills: [expect.objectContaining({
      publishStatus: "update-available",
      updateFileCount: 1,
    })],
  }));
});

test("clears a cached update when the reconciled file diff contains no changes", async () => {
  const cachedUpdate = {
    ...SKILL,
    remoteSkillId: "remote-1",
    remoteVersion: "1.0.1",
    publishStatus: "update-available" as const,
    updateFileCount: 1,
    targetVersion: "1.0.2",
  };
  const reconciledPublishedSkill = {
    ...cachedUpdate,
    publishStatus: "published" as const,
    updateFileCount: 0,
    targetVersion: "1.0.1",
  };
  const adapter = createAdapter();
  adapter.cachedSnapshotRefreshDelayMs = 0;
  adapter.readCachedSnapshot = () => ({
    skills: [cachedUpdate],
    authorizationRequired: false,
  });
  adapter.fetchSkills = vi.fn().mockResolvedValue({
    skills: [cachedUpdate],
    authorizationRequired: false,
  });
  adapter.reconcileSkills = vi.fn().mockResolvedValue({
    skills: [reconciledPublishedSkill],
    authorizationRequired: false,
  });

  render(<PublishingWorkbench adapter={adapter} />);

  expect(await screen.findByText("已发布")).toBeInTheDocument();
  expect(screen.queryByText("可更新")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "预览变更 shared-workbench" })).not.toBeInTheDocument();
});

test("keeps a cached update when SkillHub reconciliation reports an incomplete diff", async () => {
  const cachedUpdate = {
    ...SKILL,
    remoteSkillId: "remote-1",
    remoteVersion: "1.0.1",
    publishStatus: "update-available" as const,
    updateFileCount: 1,
    targetVersion: "1.0.2",
  };
  const adapter = createAdapter();
  adapter.cachedSnapshotRefreshDelayMs = 0;
  adapter.readCachedSnapshot = () => ({
    skills: [cachedUpdate],
    authorizationRequired: false,
  });
  adapter.fetchSkills = vi.fn().mockResolvedValue({
    skills: [cachedUpdate],
    authorizationRequired: false,
  });
  adapter.reconcileSkills = vi.fn().mockResolvedValue({
    skills: [{
      ...cachedUpdate,
      publishStatus: "published" as const,
      updateFileCount: 0,
    }],
    authorizationRequired: false,
    statusSyncError: "SkillHub 文件对齐失败",
  });

  render(<PublishingWorkbench adapter={adapter} />);

  expect(await screen.findByText("远端发布状态暂未同步")).toBeInTheDocument();
  expect(screen.getByText("可更新")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "预览变更 shared-workbench" })).toBeInTheDocument();
});

test("clears a cached SkillHub update when that Skill diff succeeds despite another error", async () => {
  const cachedUpdate = {
    ...SKILL,
    remoteSkillId: "remote-1",
    remoteVersion: "1.0.1",
    publishStatus: "update-available" as const,
    updateFileCount: 1,
    targetVersion: "1.0.2",
  };
  const adapter = createAdapter();
  adapter.cachedSnapshotRefreshDelayMs = 0;
  adapter.readCachedSnapshot = () => ({ skills: [cachedUpdate], authorizationRequired: false });
  adapter.fetchSkills = vi.fn().mockResolvedValue({ skills: [cachedUpdate], authorizationRequired: false });
  adapter.reconcileSkills = vi.fn().mockResolvedValue({
    skills: [{
      ...cachedUpdate,
      publishStatus: "published" as const,
      updateFileCount: 0,
      fileDiffReconciled: true,
      targetVersion: "1.0.1",
    }],
    authorizationRequired: false,
    statusSyncError: "另一个 Skill 的文件下载失败",
  });

  render(<PublishingWorkbench adapter={adapter} />);

  expect(await screen.findByText("已发布")).toBeInTheDocument();
  expect(screen.queryByText("可更新")).not.toBeInTheDocument();
});

test("accepts an authoritative newer remote update over an older published cache", async () => {
  const cachedPublished = {
    ...SKILL,
    remoteSkillId: "remote-1",
    remoteVersion: "1.1.2",
    publishStatus: "published" as const,
    targetVersion: "1.1.2",
  };
  const adapter = createAdapter();
  adapter.cachedSnapshotRefreshDelayMs = 0;
  adapter.readCachedSnapshot = () => ({ skills: [cachedPublished], authorizationRequired: false });
  adapter.fetchSkills = vi.fn().mockResolvedValue({
    skills: [{
      ...cachedPublished,
      remoteVersion: "1.1.3",
      publishStatus: "update-available" as const,
      updateFileCount: 1,
      targetVersion: "1.1.4",
    }],
    authorizationRequired: false,
  });

  render(<PublishingWorkbench adapter={adapter} />);

  expect(await screen.findByText("可更新")).toBeInTheDocument();
  expect(screen.getByText("v1.1.3 → v1.1.4")).toBeInTheDocument();
});

test("clears a cached update when the primary fetch already includes the complete file diff", async () => {
  const cachedUpdate = {
    ...SKILL,
    remoteSkillId: "remote-1",
    remoteVersion: "1.1.2",
    publishStatus: "update-available" as const,
    updateFileCount: 1,
    targetVersion: "1.1.3",
  };
  const adapter = createAdapter();
  adapter.cachedSnapshotRefreshDelayMs = 0;
  adapter.fetchSkillsIncludesFileDiff = true;
  adapter.readCachedSnapshot = () => ({
    skills: [cachedUpdate],
    authorizationRequired: false,
  });
  adapter.fetchSkills = vi.fn().mockResolvedValue({
    skills: [{
      ...cachedUpdate,
      remoteVersion: "1.1.3",
      publishStatus: "published" as const,
      updateFileCount: 0,
      fileDiffReconciled: true,
      targetVersion: "1.1.3",
    }],
    authorizationRequired: false,
  });

  render(<PublishingWorkbench adapter={adapter} />);

  expect(await screen.findByText("已发布")).toBeInTheDocument();
  expect(screen.queryByText("可更新")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "预览变更 shared-workbench" })).not.toBeInTheDocument();
});

test("keeps the last successful diff when a complete-file fetch cannot reach the remote", async () => {
  const cachedUpdate = {
    ...SKILL,
    remoteSkillId: "remote-1",
    remoteVersion: "1.1.2",
    publishStatus: "update-available" as const,
    updateFileCount: 1,
    targetVersion: "1.1.3",
  };
  const adapter = createAdapter();
  adapter.cachedSnapshotRefreshDelayMs = 0;
  adapter.fetchSkillsIncludesFileDiff = true;
  adapter.readCachedSnapshot = () => ({
    skills: [cachedUpdate],
    authorizationRequired: false,
  });
  adapter.fetchSkills = vi.fn().mockResolvedValue({
    skills: [{
      ...cachedUpdate,
      publishStatus: "published" as const,
      updateFileCount: 0,
      fileDiffReconciled: false,
    }],
    authorizationRequired: false,
    statusSyncError: "error sending request for url",
  });

  render(<PublishingWorkbench adapter={adapter} />);

  expect(await screen.findByText("远端发布状态暂未同步")).toBeInTheDocument();
  expect(screen.getByText("可更新")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "预览变更 shared-workbench" })).toBeInTheDocument();
});

test("clears a cached update for each Skill whose complete diff succeeded", async () => {
  const cachedUpdate = {
    ...SKILL,
    remoteSkillId: "remote-1",
    remoteVersion: "1.1.2",
    publishStatus: "update-available" as const,
    updateFileCount: 1,
    targetVersion: "1.1.3",
  };
  const adapter = createAdapter();
  adapter.cachedSnapshotRefreshDelayMs = 0;
  adapter.fetchSkillsIncludesFileDiff = true;
  adapter.readCachedSnapshot = () => ({
    skills: [cachedUpdate],
    authorizationRequired: false,
  });
  adapter.fetchSkills = vi.fn().mockResolvedValue({
    skills: [{
      ...cachedUpdate,
      publishStatus: "published" as const,
      updateFileCount: 0,
      fileDiffReconciled: true,
      targetVersion: "1.1.2",
    }],
    authorizationRequired: false,
    statusSyncError: "另一个 Skill 的文件下载失败",
  });

  render(<PublishingWorkbench adapter={adapter} />);

  expect(await screen.findByText("已发布")).toBeInTheDocument();
  expect(screen.queryByText("可更新")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "预览变更 shared-workbench" })).not.toBeInTheDocument();
});

test("does not copy a cached update badge after the local content changes", async () => {
  const cachedUpdate = {
    ...SKILL,
    remoteSkillId: "remote-1",
    remoteVersion: "1.1.2",
    publishStatus: "update-available" as const,
    updateFileCount: 1,
    targetVersion: "1.1.3",
  };
  const adapter = createAdapter();
  adapter.cachedSnapshotRefreshDelayMs = 0;
  adapter.fetchSkillsIncludesFileDiff = true;
  adapter.readCachedSnapshot = () => ({ skills: [cachedUpdate], authorizationRequired: false });
  adapter.fetchSkills = vi.fn().mockResolvedValue({
    skills: [{
      ...cachedUpdate,
      localContentHash: "restored-local-hash",
      publishStatus: "published" as const,
      updateFileCount: 0,
      fileDiffReconciled: false,
      targetVersion: "1.1.2",
    }],
    authorizationRequired: false,
    statusSyncError: "远端文件暂未对齐",
  });

  render(<PublishingWorkbench adapter={adapter} />);

  expect(await screen.findByText("已发布")).toBeInTheDocument();
  expect(screen.queryByText("可更新")).not.toBeInTheDocument();
});

test("keeps cached SkillHub status stable before the background synchronization", async () => {
  vi.useFakeTimers();
  try {
    const cachedSkill = {
      ...SKILL,
      remoteSkillId: "remote-1",
      remoteVersion: "1.0.0",
      publishStatus: "published" as const,
      targetVersion: "1.0.0",
    };
    const adapter = createAdapter();
    adapter.cachedSnapshotRefreshDelayMs = 1_000;
    adapter.readCachedSnapshot = () => ({
      skills: [cachedSkill],
      authorizationRequired: false,
    });
    adapter.fetchSkills = vi.fn().mockResolvedValue({
      skills: [{
        ...cachedSkill,
        publishStatus: "update-available" as const,
        updateFileCount: 1,
        targetVersion: "1.0.1",
      }],
      authorizationRequired: false,
    });

    render(<PublishingWorkbench adapter={adapter} />);

    expect(screen.getByText("已发布")).toBeInTheDocument();
    expect(adapter.fetchSkills).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(adapter.fetchSkills).toHaveBeenCalledTimes(1);
    expect(screen.getByText("可更新")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});
test("keeps a cached publish failure while background synchronization still reports publishing", async () => {
  vi.useFakeTimers();
  try {
    const failedSkill = {
      ...SKILL,
      remoteSkillId: "remote-1",
      remoteVersion: "1.0.0",
      publishStatus: "failed" as const,
      failureReason: "发布接口返回 400",
      targetVersion: "1.0.1",
    };
    const adapter = createAdapter();
    adapter.cachedSnapshotRefreshDelayMs = 1_000;
    adapter.readCachedSnapshot = () => ({
      skills: [failedSkill],
      authorizationRequired: false,
    });
    adapter.fetchSkills = vi.fn().mockResolvedValue({
      skills: [{
        ...failedSkill,
        publishStatus: "publishing" as const,
        failureReason: "",
      }],
      authorizationRequired: false,
    });

    render(<PublishingWorkbench adapter={adapter} />);

    expect(screen.getByText("发布失败")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.getByText("发布失败")).toBeInTheDocument();
    expect(adapter.publishSkill).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await Promise.resolve();
    });
    expect(adapter.fetchSkills).toHaveBeenCalledWith(true);
    expect(screen.getByText("发布失败")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test("replaces a cached publish failure once the remote reports a published terminal state", async () => {
  const failedSkill = {
    ...SKILL,
    remoteSkillId: "remote-1",
    remoteVersion: "1.0.0",
    publishStatus: "failed" as const,
    failureReason: "旧的本地失败快照",
    targetVersion: "1.0.1",
  };
  const publishedSkill = {
    ...failedSkill,
    remoteVersion: "1.0.1",
    publishStatus: "published" as const,
    failureReason: "",
    targetVersion: "1.0.1",
  };
  const adapter = createAdapter();
  adapter.cachedSnapshotRefreshDelayMs = 0;
  adapter.readCachedSnapshot = () => ({
    skills: [failedSkill],
    authorizationRequired: false,
  });
  adapter.fetchSkills = vi.fn().mockResolvedValue({
    skills: [publishedSkill],
    authorizationRequired: false,
  });

  render(<PublishingWorkbench adapter={adapter} />);

  expect(await screen.findByText("已发布")).toBeInTheDocument();
  expect(screen.queryByText("发布失败")).not.toBeInTheDocument();
  expect(screen.getByText("v1.0.1")).toBeInTheDocument();
});

test("writes a failed publish status into the platform cache", async () => {
  const adapter = createAdapter();
  adapter.publishSkill = vi.fn().mockRejectedValue(new Error("发布接口返回 400"));
  adapter.writeCachedSnapshot = vi.fn();
  render(<PublishingWorkbench adapter={adapter} />);

  await userEvent.click(await screen.findByRole("button", { name: "发布" }));
  const dialog = screen.getByRole("dialog", { name: "发布 Skill" });
  await userEvent.click(within(dialog).getByRole("button", { name: "发布" }));

  await waitFor(() => expect(adapter.writeCachedSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
    skills: [expect.objectContaining({
      publishStatus: "failed",
      failureReason: "发布接口返回 400",
    })],
  })));
});

test("keeps a publish pending when the adapter cannot determine the remote result", async () => {
  const adapter = createAdapter();
  adapter.publishSkill = vi.fn().mockRejectedValue(new Error("error sending request for url"));
  adapter.isPublishResultUnknown = () => true;
  render(<PublishingWorkbench adapter={adapter} />);

  await userEvent.click(await screen.findByRole("button", { name: "发布" }));
  const dialog = screen.getByRole("dialog", { name: "发布 Skill" });
  await userEvent.click(within(dialog).getByRole("button", { name: "发布" }));

  expect(await screen.findByText("发布中")).toBeInTheDocument();
  expect(screen.queryByText("发布失败")).not.toBeInTheDocument();
});

test("restores cached display order before background synchronization", async () => {
  const publishedSkill = {
    ...SKILL,
    name: "published-first",
    localPath: "/tmp/published-first",
    remoteSkillId: "remote-published",
    remoteVersion: "1.0.0",
    publishStatus: "published" as const,
    targetVersion: "1.0.0",
  };
  const unpublishedSkill = {
    ...SKILL,
    name: "unpublished-second",
    localPath: "/tmp/unpublished-second",
    publishStatus: "unpublished" as const,
    targetVersion: "1.0.0",
  };
  const adapter = createAdapter();
  adapter.cachedSnapshotRefreshDelayMs = 60_000;
  adapter.readCachedSnapshot = () => ({
    skills: [unpublishedSkill, publishedSkill],
    displayOrder: [publishedSkill.localPath, unpublishedSkill.localPath],
    authorizationRequired: false,
  });

  render(<PublishingWorkbench adapter={adapter} />);
  await act(async () => {
    await Promise.resolve();
  });

  expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
    "published-first",
    "unpublished-second",
  ]);
  expect(adapter.fetchSkills).not.toHaveBeenCalled();
});

test("keeps card positions stable until the user manually refreshes", async () => {
  vi.useFakeTimers();
  try {
    const publishedSkill = {
      ...SKILL,
      name: "published-first",
      localPath: "/tmp/published-first",
      remoteSkillId: "remote-published",
      remoteVersion: "1.0.0",
      publishStatus: "published" as const,
      targetVersion: "1.0.0",
    };
    const unpublishedSkill = {
      ...SKILL,
      name: "unpublished-second",
      localPath: "/tmp/unpublished-second",
      publishStatus: "unpublished" as const,
      targetVersion: "1.0.0",
    };
    const adapter = createAdapter();
    adapter.cachedSnapshotRefreshDelayMs = 1_000;
    adapter.readCachedSnapshot = () => ({
      skills: [publishedSkill, unpublishedSkill],
      displayOrder: [publishedSkill.localPath, unpublishedSkill.localPath],
      authorizationRequired: false,
    });
    adapter.fetchSkills = vi.fn().mockResolvedValue({
      skills: [publishedSkill, {
        ...unpublishedSkill,
        remoteSkillId: "remote-unpublished",
        remoteVersion: "1.0.0",
        publishStatus: "update-available" as const,
        updateFileCount: 1,
        targetVersion: "1.0.1",
      }],
      authorizationRequired: false,
    });

    render(<PublishingWorkbench adapter={adapter} />);

    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "published-first",
      "unpublished-second",
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.getByText("可更新")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "published-first",
      "unpublished-second",
    ]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await Promise.resolve();
    });
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "unpublished-second",
      "published-first",
    ]);
  } finally {
    vi.useRealTimers();
  }
});
