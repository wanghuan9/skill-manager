import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { PublishingWorkbench } from "@/features/publishing/PublishingWorkbench";
import type { PublishingPlatformAdapter } from "@/features/publishing/publishing-adapter";
import type { PublishableSkill } from "@/features/publishing/types";

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
  expect(adapter.writeCachedSnapshot).toHaveBeenCalledWith(expect.objectContaining({
    skills: [expect.objectContaining({
      publishStatus: "update-available",
      updateFileCount: 1,
    })],
  }));
});
